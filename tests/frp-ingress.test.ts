import { X509Certificate } from 'node:crypto'
import { execFile as execFileCallback } from 'node:child_process'
import { createServer, request as requestHttp } from 'node:http'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { request as httpsRequest } from 'node:https'
import type { AddressInfo } from 'node:net'
import type { TLSSocket } from 'node:tls'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it } from 'vitest'
import { parseGatewayConfig } from '../src/config.js'
import { parseFrpSettings } from '../src/frp-config.js'
import { ensureFrpIngressCertificate, frpIngressPaths, frpIngressSelfCheck } from '../src/frp-ingress.js'
import { MobileAccessService } from '../src/extensions.js'
import { MobileAccessGateway } from '../src/gateway.js'
import { parseCidr, RequestTrustPolicy } from '../src/network.js'
import { frpIngressGatewayConfig } from '../src/plugin.js'
import { MemoryDeviceStore } from '../src/storage.js'

const cleanups: Array<() => Promise<void>> = []
const execFile = promisify(execFileCallback)

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

const TOKEN = '0123456789abcdef0123456789abcdef'

function settings(overrides: Record<string, unknown> = {}) {
  return parseFrpSettings({
    serverAddress: '1.2.3.4',
    serverPort: 7000,
    token: TOKEN,
    publicOrigin: 'https://1.2.3.4',
    mode: 'attach',
    entryTls: 'self-signed',
    ...overrides,
  })
}

async function fixture(): Promise<{ readonly directory: string; readonly stateFile: string }> {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-mobile-ingress-'))
  cleanups.push(async () => { await rm(directory, { recursive: true, force: true }) })
  return { directory, stateFile: join(directory, 'devices.json') }
}

function template(stateFile: string) {
  return parseGatewayConfig({
    listenHost: '127.0.0.1',
    listenPort: 0,
    publicAuthorities: ['127.0.0.1'],
    allowedCidrs: ['127.0.0.0/8'],
    stateFile,
    tls: { mode: 'disabled' },
  })
}

describe('self-signed FRP ingress certificate', () => {
  it('signs a leaf whose SAN carries the public IPv4 and reuses it while valid', async () => {
    const { stateFile } = await fixture()
    const ingress = await ensureFrpIngressCertificate(settings(), stateFile)
    expect(ingress.ca.ca).toBe(true)
    expect(ingress.ca.subject).toBe(ingress.ca.issuer)
    expect(ingress.leaf.subjectAltName).toContain('IP Address:1.2.3.4')
    expect(ingress.leaf.verify(ingress.ca.publicKey)).toBe(true)
    expect(ingress.leaf.ca).toBe(false)
    expect(ingress.caFingerprint).toBe(ingress.ca.fingerprint256.replaceAll(':', '').toLowerCase())
    expect(ingress.status.state).toBe('ok')
    // No renewal maintenance: the CA outlives five years and the leaf 397 days.
    const caDays = (Date.parse(ingress.ca.validTo) - Date.now()) / 86_400_000
    const leafDays = (Date.parse(ingress.leaf.validTo) - Date.now()) / 86_400_000
    expect(caDays).toBeGreaterThan(1_800)
    expect(leafDays).toBeGreaterThan(390)
    // Windows reports synthetic POSIX bits; inspect the actual ACL there instead.
    for (const keyFile of [ingress.paths.caKeyFile, ingress.paths.keyFile]) {
      if (process.platform === 'win32') {
        const { stdout } = await execFile('icacls.exe', [keyFile], { encoding: 'utf8', windowsHide: true })
        expect(stdout).not.toContain('(I)')
        expect(stdout).not.toMatch(/Everyone|Authenticated Users|BUILTIN\\Users|CodexSandboxUsers/iu)
      } else {
        expect((await stat(keyFile)).mode & 0o777).toBe(0o600)
      }
    }
    // A second start reuses the same leaf instead of re-signing on every boot.
    const again = await ensureFrpIngressCertificate(settings(), stateFile)
    expect(again.leaf.fingerprint256).toBe(ingress.leaf.fingerprint256)
    expect(again.caFingerprint).toBe(ingress.caFingerprint)
  })

  it('re-issues the leaf when the public address changes', async () => {
    const { stateFile } = await fixture()
    const first = await ensureFrpIngressCertificate(settings(), stateFile)
    const moved = await ensureFrpIngressCertificate(
      settings({ serverAddress: '8.8.8.8', publicOrigin: 'https://8.8.8.8' }),
      stateFile,
    )
    expect(moved.leaf.fingerprint256).not.toBe(first.leaf.fingerprint256)
    expect(moved.leaf.subjectAltName).toContain('IP Address:8.8.8.8')
    expect(moved.caFingerprint).toBe(first.caFingerprint)
  })

  it('refuses to build ingress material outside the self-signed attach mode', async () => {
    const { stateFile } = await fixture()
    await expect(ensureFrpIngressCertificate(parseFrpSettings({
      serverAddress: '1.2.3.4', serverPort: 7000, token: TOKEN, publicOrigin: 'https://1.2.3.4',
    }), stateFile)).rejects.toThrow('frp_entry_tls_invalid')
  })

  it('keeps the pairing CA pinned and the listener on loopback with the public authority', async () => {
    const { stateFile } = await fixture()
    const active = settings()
    const ingress = await ensureFrpIngressCertificate(active, stateFile)
    const config = frpIngressGatewayConfig(template(stateFile), active, stateFile, ingress)
    // Retaining pairingCaFile is what makes GET /mobile-access/ca.cer available,
    // which is the only trust anchor the Android app needs.
    expect(config.pairingCaFile).toBe(frpIngressPaths(stateFile).caCertFile)
    expect(config.instanceId).toBe(ingress.caFingerprint)
    expect(config.listenHost).toBe('127.0.0.1')
    expect(config.allowedCidrs.map(cidr => cidr.source)).toEqual(['127.0.0.0/8'])
    expect(config.tls).toEqual({
      mode: 'provided',
      certFile: frpIngressPaths(stateFile).certFile,
      keyFile: frpIngressPaths(stateFile).keyFile,
    })
    expect(config.publicTls).toBe(true)
    expect(config.authorities).toEqual([{ hostname: '1.2.3.4', port: 33_080 }])
    expect(config.discovery).toBe(false)
    const policy = new RequestTrustPolicy(config.authorities, 58_916, config.allowedCidrs, config.publicTls)
    expect([...policy.origins]).toEqual(['https://1.2.3.4:33080'])
    expect(policy.acceptsOrigin('https://1.2.3.4:33080')).toBe(true)
    expect(policy.acceptsOrigin('https://1.2.3.4')).toBe(false)
    expect(new RequestTrustPolicy(config.authorities, 58_916, [parseCidr('192.168.0.0/16')], true)
      .acceptsHost('1.2.3.4:33080')).toBe(true)
  })

  it('serves the pinned CA over TLS and reports its lifetime without leaking secrets', async () => {
    const { stateFile } = await fixture()
    const active = settings()
    const ingress = await ensureFrpIngressCertificate(active, stateFile)
    const context = new Context()
    cleanups.push(async () => { await context.fiber.dispose() })
    const gateway = new MobileAccessGateway(
      frpIngressGatewayConfig(template(stateFile), active, stateFile, ingress),
      new MemoryDeviceStore(),
      new MobileAccessService(context),
    )
    cleanups.push(async () => { await gateway.close() })
    await gateway.start()
    const port = gateway.address().port
    const fetchOverTls = async (path: string): Promise<{ status: number; body: Buffer; leaf?: X509Certificate }> =>
      new Promise((resolve, reject) => {
        let presented: X509Certificate | undefined
        // frps is a byte-level TCP proxy: the app's Host header arrives verbatim,
        // so the trust policy sees the public authority while the socket is local.
        const outgoing = httpsRequest({
          host: '127.0.0.1',
          port,
          path,
          rejectUnauthorized: false,
          agent: false,
          headers: { host: '1.2.3.4:33080' },
        }, response => {
          const chunks: Buffer[] = []
          response.on('data', chunk => chunks.push(Buffer.from(chunk)))
          response.once('end', () => resolve({
            status: response.statusCode ?? 0,
            body: Buffer.concat(chunks),
            ...(presented === undefined ? {} : { leaf: presented }),
          }))
        })
        outgoing.once('socket', socket => {
          socket.once('secureConnect', () => { presented = (socket as TLSSocket).getPeerX509Certificate() })
        })
        outgoing.once('error', reject)
        outgoing.end()
      })
    const ca = await fetchOverTls('/mobile-access/ca.cer')
    expect(ca.status).toBe(200)
    expect(new X509Certificate(ca.body).fingerprint256).toBe(ingress.ca.fingerprint256)
    // The listener really does present the CA-signed leaf, not a plaintext socket.
    expect(ca.leaf?.fingerprint256).toBe(ingress.leaf.fingerprint256)
    const discovery = await fetchOverTls('/mobile-access/discovery')
    expect(discovery.status).toBe(200)
    expect(JSON.parse(discovery.body.toString('utf8'))).toMatchObject({ instanceId: ingress.caFingerprint })

    const adminRoute = gateway.localAdminRoute()
    const adminServer = createServer((request, response) => { void adminRoute.handler(request, response) })
    await new Promise<void>(resolve => { adminServer.listen(0, '127.0.0.1', resolve) })
    cleanups.push(async () => { await new Promise<void>(resolve => { adminServer.close(() => resolve()) }) })
    const adminPort = (adminServer.address() as AddressInfo).port
    const authority = `127.0.0.1:${String(adminPort)}`
    const pairing = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      const body = '{}'
      const request = requestHttp({
        hostname: '127.0.0.1', port: adminPort, path: '/api/mobile-access/pairing/open', method: 'POST', agent: false,
        headers: { host: authority, origin: `http://${authority}`, 'sec-fetch-site': 'same-origin',
          'content-type': 'application/json', 'content-length': Buffer.byteLength(body) },
      }, response => {
        const chunks: Buffer[] = []
        response.on('data', chunk => { chunks.push(Buffer.from(chunk)) })
        response.once('end', () => { resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }) })
      })
      request.once('error', reject)
      request.end(body)
    })
    expect(pairing.status).toBe(201)
    const opened = JSON.parse(pairing.body) as { token: string; appKey: string; pairUrl: string; appPairUrl: string }
    expect(opened.appKey).toBe(`dsh2.${ingress.caFingerprint}.${opened.token}`)
    expect(opened.pairUrl).toBe(`https://1.2.3.4:33080/mobile-access/pair#key=${opened.appKey}`)
    expect(opened.appPairUrl).toBe(opened.pairUrl)
    expect(opened.pairUrl).not.toContain('#instance=')

    const check = await frpIngressSelfCheck(active, stateFile)
    expect(check).toMatchObject({
      mode: 'attach',
      entryTls: 'self-signed',
      publicPort: 33_080,
      vhostHttpPort: 7080,
      caFingerprint: ingress.caFingerprint,
      inbound: { listenHost: '127.0.0.1', allowedCidrs: ['127.0.0.0/8'] },
    })
    expect(check.certificate?.state).toBe('ok')
    // Only fingerprints and lifetimes: never the token or any key material.
    expect(JSON.stringify(check)).not.toContain(TOKEN)
  })
})
