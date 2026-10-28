import { EventEmitter } from 'node:events'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer as createHttpsServer, type Server as HttpsServer } from 'node:https'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { PassThrough } from 'node:stream'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import type { Socket } from 'node:net'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { MobileAccessControlState, MobileAccessControlStore } from '../src/control.js'
import { FrpConfigStore, parseFrpSettings } from '../src/frp-config.js'
import { ensureFrpIngressCertificate } from '../src/frp-ingress.js'
import {
  FrpController,
  defaultProbeDiscovery,
  type FrpControllerOptions,
  type FrpDiscoveryProbeTarget,
} from '../src/frp.js'
import type { MobileAccessGateway } from '../src/gateway.js'
import { readFrpIngressTrustAnchor } from '../src/plugin.js'
import { createTestTlsChain, type TestTlsChain } from './tls-fixtures.js'

/**
 * The self-signed FRP entry is a raw TCP passthrough whose TLS endpoint is our
 * own gateway, holding a leaf the ingress CA signed. Two facts follow, and the
 * start-up self-check used to ignore both of them:
 *
 * 1. the probe must anchor that CA — the system trust store can never verify it,
 *    so a default-chain request fails with `UNABLE_TO_VERIFY_LEAF_SIGNATURE` and
 *    the channel only ever ends in `frp_start_timeout`;
 * 2. the probe must dial `publicPort` (`resolveFrpPublicPort`, 33080 by default),
 *    not the 443 that `publicOrigin` implies and where nothing listens.
 *
 * Every case below talks to a real HTTPS server with real certificate material;
 * nothing here stubs the TLS layer.
 */

const CA_ADVERTISED_IDENTITY = 'f'.repeat(64)
const OTHER_IDENTITY = 'a'.repeat(64)
const TOKEN = '0123456789abcdef0123456789abcdef'

const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

class MemoryControlStore implements MobileAccessControlStore {
  state: MobileAccessControlState = { version: 1, enabled: false }

  async load(): Promise<MobileAccessControlState> { return this.state }
  async save(state: MobileAccessControlState): Promise<void> { this.state = state }
}

class FakeChild extends EventEmitter {
  readonly stdin = new PassThrough()
  readonly stdout = new PassThrough()
  readonly stderr = new PassThrough()
  exitCode: number | null = null

  kill(): boolean {
    if (this.exitCode !== null) return false
    this.exitCode = 0
    setImmediate(() => { this.emit('close', 0) })
    return true
  }
}

interface EntryServer {
  readonly port: number
  readonly origin: string
}

/**
 * Real HTTPS entry standing in for the frps TCP proxy: it terminates the same
 * TLS the gateway does, with the fixture chain as its certificate.
 */
async function startEntryServer(options: {
  readonly chain: TestTlsChain
  readonly host?: string
  readonly instanceId?: string
  readonly respond?: boolean
  /** Answer with this status instead of the discovery 200. */
  readonly status?: number
  /** Answer with this body instead of the discovery advertisement. */
  readonly body?: string
  /** Send a partial 200 response and keep its body open. */
  readonly stallAfterHeaders?: boolean
  readonly onPartialResponse?: () => void
}): Promise<EntryServer> {
  const host = options.host ?? '127.0.0.1'
  const sockets = new Set<Socket>()
  const server: HttpsServer = createHttpsServer({
    key: options.chain.leafKey,
    // The intermediate travels with the leaf, so only the root needs anchoring.
    cert: `${options.chain.leafCert}${options.chain.intermediateCert}`,
  }, (request, response) => {
    if (options.respond === false) return
    if (request.url !== '/mobile-access/discovery') {
      response.writeHead(404).end()
      return
    }
    const body = options.body ?? JSON.stringify({ instanceId: options.instanceId ?? CA_ADVERTISED_IDENTITY })
    response.writeHead(options.status ?? 200, {
      'content-type': 'application/json',
      'content-length': Buffer.byteLength(body),
    })
    if (options.stallAfterHeaders === true) {
      response.write(body.slice(0, 1))
      options.onPartialResponse?.()
      return
    }
    response.end(body)
  })
  server.on('connection', socket => {
    sockets.add(socket)
    socket.once('close', () => { sockets.delete(socket) })
  })
  // A client that rejects the fixture certificate is the case under test.
  server.on('tlsClientError', () => undefined)
  await new Promise<void>(resolve => { server.listen(0, host, resolve) })
  cleanups.push(async () => {
    for (const socket of sockets) socket.destroy()
    sockets.clear()
    await new Promise<void>(resolve => { server.close(() => resolve()) })
  })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('fixture entry has no TCP address')
  return { port: address.port, origin: `https://${host}:${String(address.port)}` }
}

/** Materialize an ingress directory the production anchor reader can consume. */
async function writeIngressCa(directory: string, pem: string): Promise<{ readonly stateFile: string; readonly caFile: string }> {
  const stateFile = join(directory, 'devices.json')
  const caFile = join(dirname(stateFile), 'ingress', 'ca.pem')
  await mkdir(dirname(caFile), { recursive: true })
  await writeFile(caFile, pem)
  return { stateFile, caFile }
}

async function frpFixture(settings: Record<string, unknown>): Promise<{
  readonly executable: string
  readonly config: FrpConfigStore
  readonly directory: string
}> {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-mobile-frp-probe-'))
  cleanups.push(async () => { await rm(directory, { recursive: true, force: true }) })
  const executable = join(directory, 'component', 'frpc.exe')
  await mkdir(dirname(executable), { recursive: true })
  await writeFile(executable, 'fake-frpc')
  const config = new FrpConfigStore(join(directory, 'config'))
  await config.initialize()
  await config.configure({ serverAddress: 'frp.example.com', serverPort: 7000, token: TOKEN, ...settings })
  return { executable, config, directory }
}

/** Stand-in for a started gateway that carries the identity it advertises. */
function gateway(instanceId: string): MobileAccessGateway {
  return {
    address: () => ({ host: '127.0.0.1', port: 42123, origin: 'http://127.0.0.1:42123' }),
    config: { instanceId },
    close: vi.fn(async () => undefined),
  } as unknown as MobileAccessGateway
}

function controllerOptions(
  executable: string,
  config: FrpConfigStore,
  overrides: Partial<FrpControllerOptions> & Pick<FrpControllerOptions, 'createGateway'>,
): FrpControllerOptions {
  return {
    store: new MemoryControlStore(),
    executable,
    config,
    instanceId: OTHER_IDENTITY,
    probeVhostExposure: async () => false,
    verifyConfig: async () => undefined,
    launchClient: () => new FakeChild() as unknown as ChildProcessWithoutNullStreams,
    startTimeoutMs: 500,
    retryIntervalMs: 1,
    ...overrides,
  }
}

describe('FRP discovery probe against a real HTTPS entry', () => {
  it('fails on the system trust store, which is why the self-signed entry never became ready', async () => {
    // Locks defect 1 from the other side: on the default chain the ingress leaf is
    // unverifiable, so the pre-fix probe could only reject, get swallowed, and
    // retry until `frp_start_timeout`. Without an anchor this stays red forever.
    const chain = createTestTlsChain()
    const entry = await startEntryServer({ chain })
    await expect(defaultProbeDiscovery(
      { origin: entry.origin },
      CA_ADVERTISED_IDENTITY,
      new AbortController().signal,
    )).rejects.toMatchObject({
      code: expect.stringMatching(/UNABLE_TO_VERIFY_LEAF_SIGNATURE|SELF_SIGNED_CERT_IN_CHAIN|UNABLE_TO_GET_ISSUER_CERT_LOCALLY/u),
    })
  })

  it('succeeds when the ingress CA anchors the leaf and the host matches its SAN', async () => {
    const chain = createTestTlsChain()
    const entry = await startEntryServer({ chain })
    await expect(defaultProbeDiscovery(
      { origin: entry.origin, trustAnchorPem: `${chain.rootCert}${chain.intermediateCert}` },
      CA_ADVERTISED_IDENTITY,
      new AbortController().signal,
    )).resolves.toBe(true)
  })

  it('keeps verification on: an anchored chain for another name still fails', async () => {
    // Anchoring must never become "skip verification": the leaf names 127.0.0.1,
    // so dialling 127.0.0.2 with that very anchor must still be rejected.
    const chain = createTestTlsChain()
    const entry = await startEntryServer({ chain, host: '127.0.0.2' })
    await expect(defaultProbeDiscovery(
      { origin: entry.origin, trustAnchorPem: chain.rootCert },
      CA_ADVERTISED_IDENTITY,
      new AbortController().signal,
    )).rejects.toMatchObject({ code: 'ERR_TLS_CERT_ALTNAME_INVALID' })
  })

  it('reports frp_discovery_mismatch immediately instead of waiting for the deadline', async () => {
    const chain = createTestTlsChain()
    const entry = await startEntryServer({ chain, instanceId: OTHER_IDENTITY })
    const started = Date.now()
    await expect(defaultProbeDiscovery(
      { origin: entry.origin, trustAnchorPem: chain.rootCert },
      CA_ADVERTISED_IDENTITY,
      new AbortController().signal,
    )).rejects.toThrow('frp_discovery_mismatch')
    // The identity is checked on the first answer: there is no retry loop here.
    expect(Date.now() - started).toBeLessThan(2_000)
  })

  it('keeps the request timeout over the whole exchange', async () => {
    // The entry completes the handshake and never answers: the doubt must end with
    // the 5s request timeout rather than stalling the retry loop forever.
    const chain = createTestTlsChain()
    const entry = await startEntryServer({ chain, respond: false })
    const started = Date.now()
    await expect(defaultProbeDiscovery(
      { origin: entry.origin, trustAnchorPem: chain.rootCert },
      CA_ADVERTISED_IDENTITY,
      new AbortController().signal,
    )).rejects.toThrow('frp_discovery_timeout')
    const elapsed = Date.now() - started
    expect(elapsed).toBeGreaterThanOrEqual(4_000)
    expect(elapsed).toBeLessThan(8_000)
  }, 15_000)

  it('times out when a 200 response stalls after its headers and first body byte', async () => {
    const chain = createTestTlsChain()
    const entry = await startEntryServer({ chain, stallAfterHeaders: true })
    const started = Date.now()
    await expect(defaultProbeDiscovery(
      { origin: entry.origin, trustAnchorPem: chain.rootCert },
      CA_ADVERTISED_IDENTITY,
      new AbortController().signal,
    )).rejects.toThrow('frp_discovery_timeout')
    const elapsed = Date.now() - started
    expect(elapsed).toBeGreaterThanOrEqual(4_000)
    expect(elapsed).toBeLessThan(8_000)
  }, 15_000)

  it('aborts a partial discovery body without waiting for the request timeout', async () => {
    const chain = createTestTlsChain()
    let partialResponseReceived!: () => void
    const partialResponse = new Promise<void>(resolve => { partialResponseReceived = resolve })
    const entry = await startEntryServer({
      chain,
      stallAfterHeaders: true,
      onPartialResponse: partialResponseReceived,
    })
    const controller = new AbortController()
    const probe = defaultProbeDiscovery(
      { origin: entry.origin, trustAnchorPem: chain.rootCert },
      CA_ADVERTISED_IDENTITY,
      controller.signal,
    )
    await partialResponse
    controller.abort()
    await expect(probe).rejects.toThrow('frp_discovery_aborted')
  })

  it('treats a non-200 answer as "not ready yet" rather than a fault', async () => {
    // A redirect or an error page from the entry keeps the retry loop running
    // instead of ending the generation.
    const chain = createTestTlsChain()
    const entry = await startEntryServer({ chain, status: 302 })
    await expect(defaultProbeDiscovery(
      { origin: entry.origin, trustAnchorPem: chain.rootCert },
      CA_ADVERTISED_IDENTITY,
      new AbortController().signal,
    )).resolves.toBe(false)
  })

  it('treats a bodyless 204 as not ready instead of constructing an invalid Response', async () => {
    const chain = createTestTlsChain()
    const entry = await startEntryServer({ chain, status: 204 })
    await expect(defaultProbeDiscovery(
      { origin: entry.origin, trustAnchorPem: chain.rootCert },
      CA_ADVERTISED_IDENTITY,
      new AbortController().signal,
    )).resolves.toBe(false)
  })

  it('discards a stalled error response without holding the retry loop', async () => {
    const chain = createTestTlsChain()
    const entry = await startEntryServer({ chain, status: 503, stallAfterHeaders: true })
    const started = Date.now()
    await expect(defaultProbeDiscovery(
      { origin: entry.origin, trustAnchorPem: chain.rootCert },
      CA_ADVERTISED_IDENTITY,
      new AbortController().signal,
    )).resolves.toBe(false)
    expect(Date.now() - started).toBeLessThan(2_000)
  })

  it('keeps the 16 KiB response cap', async () => {
    // The cap is what stops a hostile entry from streaming an unbounded body into
    // the self-check; an oversized advertisement stays an immediate failure.
    const chain = createTestTlsChain()
    const entry = await startEntryServer({
      chain,
      body: JSON.stringify({ instanceId: CA_ADVERTISED_IDENTITY, padding: 'x'.repeat(32 * 1024) }),
    })
    await expect(defaultProbeDiscovery(
      { origin: entry.origin, trustAnchorPem: chain.rootCert },
      CA_ADVERTISED_IDENTITY,
      new AbortController().signal,
    )).rejects.toThrow('frp_discovery_invalid')
  })
})
describe('FRP discovery probe target derivation', () => {
  it('dials the public entry port and pins the ingress CA for the self-signed entry', async () => {
    const { executable, config, directory } = await frpFixture({
      publicOrigin: 'https://1.2.3.4',
      mode: 'attach',
      entryTls: 'self-signed',
      publicPort: 33_080,
    })
    const ingress = await writeIngressCa(directory, '-----BEGIN CERTIFICATE-----\nfixture\n-----END CERTIFICATE-----\n')
    const probeDiscovery = vi.fn(async (_target: FrpDiscoveryProbeTarget) => true)
    const controller = new FrpController(controllerOptions(executable, config, {
      createGateway: async () => gateway(CA_ADVERTISED_IDENTITY),
      probeDiscovery,
      resolveDiscoveryTrustAnchor: settings => readFrpIngressTrustAnchor(settings, ingress.stateFile),
    }))

    await controller.initialize()
    await controller.setEnabled(true)
    await vi.waitFor(() => { expect(controller.status().state).toBe('ready') })

    // Defect 2: the port comes from `resolveFrpPublicPort`, not from the origin.
    expect(probeDiscovery).toHaveBeenCalledWith(
      {
        origin: 'https://1.2.3.4:33080',
        trustAnchorPem: '-----BEGIN CERTIFICATE-----\nfixture\n-----END CERTIFICATE-----\n',
      },
      CA_ADVERTISED_IDENTITY,
      expect.any(AbortSignal),
    )
    // The panel reports the entry users can actually open, not the saved :443 base.
    expect(controller.status().origin).toBe('https://1.2.3.4:33080')
    await controller.close()
  })

  it('keeps a non-default public entry port', async () => {
    const { executable, config, directory } = await frpFixture({
      publicOrigin: 'https://1.2.3.4',
      mode: 'attach',
      entryTls: 'self-signed',
      publicPort: 44_443,
    })
    const ingress = await writeIngressCa(directory, 'ca')
    const probeDiscovery = vi.fn(async () => true)
    const controller = new FrpController(controllerOptions(executable, config, {
      createGateway: async () => gateway(CA_ADVERTISED_IDENTITY),
      probeDiscovery,
      resolveDiscoveryTrustAnchor: settings => readFrpIngressTrustAnchor(settings, ingress.stateFile),
    }))

    await controller.initialize()
    await controller.setEnabled(true)
    await vi.waitFor(() => { expect(controller.status().state).toBe('ready') })
    expect(probeDiscovery).toHaveBeenCalledWith(
      { origin: 'https://1.2.3.4:44443', trustAnchorPem: 'ca' },
      CA_ADVERTISED_IDENTITY,
      expect.any(AbortSignal),
    )
    expect(controller.status().origin).toBe('https://1.2.3.4:44443')
    await controller.close()
  })

  it('leaves the public-CA entry on its origin without any trust anchor', async () => {
    const { executable, config, directory } = await frpFixture({ publicOrigin: 'https://dsh.example.com' })
    const ingress = await writeIngressCa(directory, 'ca')
    const probeDiscovery = vi.fn(async () => true)
    const resolveDiscoveryTrustAnchor = vi.fn(settings => readFrpIngressTrustAnchor(settings, ingress.stateFile))
    const controller = new FrpController(controllerOptions(executable, config, {
      createGateway: async () => gateway(OTHER_IDENTITY),
      probeDiscovery,
      resolveDiscoveryTrustAnchor,
    }))

    await controller.initialize()
    await controller.setEnabled(true)
    await vi.waitFor(() => { expect(controller.status().state).toBe('ready') })

    // 443 behind Caddy with a publicly trusted chain: no key may be added.
    expect(probeDiscovery).toHaveBeenCalledWith(
      { origin: 'https://dsh.example.com' },
      OTHER_IDENTITY,
      expect.any(AbortSignal),
    )
    expect(resolveDiscoveryTrustAnchor).not.toHaveBeenCalled()
    await controller.close()
  })

  it('stops explicitly when the pinned ingress CA cannot be read', async () => {
    const { executable, config, directory } = await frpFixture({
      publicOrigin: 'https://1.2.3.4',
      mode: 'attach',
      entryTls: 'self-signed',
      publicPort: 33_080,
    })
    // The saved state directory has no ingress material at all.
    const probeDiscovery = vi.fn(async (_target: FrpDiscoveryProbeTarget) => {
      throw new Error('UNABLE_TO_VERIFY_LEAF_SIGNATURE')
    })
    const controller = new FrpController(controllerOptions(executable, config, {
      createGateway: async () => gateway(CA_ADVERTISED_IDENTITY),
      probeDiscovery,
      resolveDiscoveryTrustAnchor: settings => readFrpIngressTrustAnchor(settings, join(directory, 'empty', 'devices.json')),
      startTimeoutMs: 60,
    }))

    await controller.initialize()
    await controller.setEnabled(true)
    await vi.waitFor(() => {
      expect(controller.status()).toEqual({ enabled: true, state: 'error', errorCode: 'frp_ingress_ca_invalid' })
    })
    expect(probeDiscovery).not.toHaveBeenCalled()
    await controller.close()
  })

  it('reads the very CA the ingress gateway is pinned to', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-mobile-frp-anchor-'))
    cleanups.push(async () => { await rm(directory, { recursive: true, force: true }) })
    const stateFile = join(directory, 'devices.json')
    const selfSigned = parseFrpSettings({
      serverAddress: '1.2.3.4',
      serverPort: 7000,
      token: TOKEN,
      publicOrigin: 'https://1.2.3.4',
      mode: 'attach',
      entryTls: 'self-signed',
    })
    const ingress = await ensureFrpIngressCertificate(selfSigned, stateFile)
    const anchor = await readFrpIngressTrustAnchor(selfSigned, stateFile)
    expect(anchor).toBe(await readFile(ingress.paths.caCertFile, 'utf8'))
    expect(anchor).toContain('BEGIN CERTIFICATE')
    // The app pins this CA and the gateway advertises its fingerprint, so the
    // probe anchors one identity for all three.
    expect(ingress.caFingerprint).toBe(ingress.ca.fingerprint256.replaceAll(':', '').toLowerCase())
    expect(await readFrpIngressTrustAnchor(parseFrpSettings({
      serverAddress: '1.2.3.4',
      serverPort: 7000,
      token: TOKEN,
      publicOrigin: 'https://1.2.3.4',
    }), stateFile)).toBeUndefined()
  })
})
