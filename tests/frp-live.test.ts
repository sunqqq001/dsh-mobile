import { createHash, randomBytes } from 'node:crypto'
import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { createServer, request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { connect, type AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { checkServerIdentity, type TLSSocket } from 'node:tls'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { parseGatewayConfig } from '../src/config.js'
import type { MobileAccessControlState, MobileAccessControlStore } from '../src/control.js'
import { FRP_COMPONENT_RELEASES, FrpComponentManager } from '../src/frp-component.js'
import { FrpConfigStore, frpEntryOrigin } from '../src/frp-config.js'
import { ensureFrpIngressCertificate, frpIngressPaths } from '../src/frp-ingress.js'
import { MobileAccessService } from '../src/extensions.js'
import { FrpController } from '../src/frp.js'
import { MobileAccessGateway } from '../src/gateway.js'
import { frpIngressGatewayConfig } from '../src/plugin.js'
import { MemoryDeviceStore } from '../src/storage.js'

const live = process.env.DSH_MOBILE_FRP_E2E === '1'
const localLive = process.env.DSH_MOBILE_FRP_LOCAL === '1'
const temporaryDirectories: string[] = []
let pinnedOfficialArchive: Promise<Uint8Array> | undefined

function officialArchive(): Promise<Uint8Array> {
  pinnedOfficialArchive ??= (async () => {
    const artifact = FRP_COMPONENT_RELEASES[`${process.platform}-${process.arch}`]
    if (artifact === undefined) throw new Error('current platform has no pinned FRP artifact')
    const response = await fetch(artifact.downloadUrl)
    if (!response.ok) throw new Error(`FRP download failed with HTTP ${String(response.status)}`)
    const bytes = new Uint8Array(await response.arrayBuffer())
    expect(bytes.byteLength).toBe(artifact.downloadBytes)
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(artifact.downloadSha256)
    return bytes
  })()
  return pinnedOfficialArchive
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
})

class MemoryControlStore implements MobileAccessControlStore {
  state: MobileAccessControlState = { version: 1, enabled: false }
  async load(): Promise<MobileAccessControlState> { return this.state }
  async save(state: MobileAccessControlState): Promise<void> { this.state = state }
}

async function run(file: string, args: readonly string[]): Promise<void> {
  await new Promise<void>((resolveRun, reject) => {
    execFile(file, [...args], { windowsHide: true, timeout: 120_000 }, error => {
      if (error === null) resolveRun()
      else reject(error)
    })
  })
}

async function freePort(): Promise<number> {
  const server = createServer()
  await new Promise<void>(resolve => { server.listen(0, '127.0.0.1', resolve) })
  const port = (server.address() as AddressInfo).port
  await new Promise<void>(resolve => { server.close(() => resolve()) })
  return port
}

/** Reserve distinct ephemeral ports together before an external frps binds them. */
async function distinctFrpPorts(): Promise<readonly [number, number]> {
  const servers = [createServer(), createServer()]
  try {
    for (const server of servers) await new Promise<void>(resolve => { server.listen(0, '127.0.0.1', resolve) })
    const control = (servers[0]!.address() as AddressInfo).port
    const entry = (servers[1]!.address() as AddressInfo).port
    return [control, entry]
  } finally {
    await Promise.all(servers.filter(server => server.listening).map(server =>
      new Promise<void>(resolve => { server.close(() => resolve()) })))
  }
}

/** Dial loopback frps while validating the gateway's public IPv4 SAN and pinned CA. */
function pinnedHttpsGet(port: number, path: string, publicIp: string, ca: string, signal?: AbortSignal): Promise<{
  readonly status: number
  readonly body: string
  readonly peer: ReturnType<TLSSocket['getPeerX509Certificate']>
  readonly authorized: boolean
}> {
  return new Promise((resolve, reject) => {
    let peer: ReturnType<TLSSocket['getPeerX509Certificate']>
    let authorized = false
    const request = httpsRequest({
      host: '127.0.0.1', port, path, ca, agent: false, signal,
      headers: { host: `${publicIp}:${String(port)}` },
      checkServerIdentity: (_host, certificate) => checkServerIdentity(publicIp, certificate),
    }, response => {
      const chunks: Buffer[] = []
      response.on('data', chunk => { chunks.push(Buffer.from(chunk)) })
      response.once('end', () => resolve({
        status: response.statusCode ?? 0,
        body: Buffer.concat(chunks).toString('utf8'),
        peer,
        authorized,
      }))
    })
    request.once('socket', socket => {
      socket.once('secureConnect', () => {
        const secure = socket as TLSSocket
        peer = secure.getPeerX509Certificate()
        authorized = secure.authorized
      })
    })
    request.once('error', reject)
    request.end()
  })
}

async function waitForPort(port: number, child: ChildProcess): Promise<void> {
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`frps exited with ${String(child.exitCode)}`)
    const connected = await new Promise<boolean>(resolve => {
      const socket = connect({ host: '127.0.0.1', port })
      socket.once('connect', () => { socket.destroy(); resolve(true) })
      socket.once('error', () => { resolve(false) })
    })
    if (connected) return
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  throw new Error('frps did not open its control port')
}

async function findExecutable(directory: string, name: string): Promise<string> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const candidate = join(directory, entry.name)
    if (entry.isDirectory()) {
      try { return await findExecutable(candidate, name) } catch { /* Continue the bounded extracted tree. */ }
    } else if (entry.isFile() && entry.name === name) return candidate
  }
  throw new Error(`${name} was not found in the official archive`)
}

async function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return
  child.kill()
  await new Promise<void>(resolve => {
    const timer = setTimeout(() => { child.kill('SIGKILL'); resolve() }, 2_000)
    child.once('close', () => { clearTimeout(timer); resolve() })
  })
}

async function probeLocalDiscovery(port: number, host: string, expectedInstanceId: string, signal: AbortSignal): Promise<boolean> {
  return new Promise<boolean>((resolve, reject) => {
    const request = httpRequest({ host: '127.0.0.1', port, path: '/mobile-access/discovery', headers: { host } }, response => {
      const chunks: Buffer[] = []
      response.on('data', chunk => { chunks.push(Buffer.from(chunk)) })
      response.once('end', () => {
        try {
          const value = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>
          resolve(response.statusCode === 200 && value.instanceId === expectedInstanceId)
        } catch { resolve(false) }
      })
    })
    const abort = (): void => { request.destroy(new Error('aborted')) }
    signal.addEventListener('abort', abort, { once: true })
    request.once('error', error => {
      signal.removeEventListener('abort', abort)
      if (signal.aborted) resolve(false)
      else reject(error)
    })
    request.once('close', () => { signal.removeEventListener('abort', abort) })
    request.end()
  })
}

describe.skipIf(!localLive)('local official FRP data path', () => {
  it('downloads the pinned client and forwards discovery through real frps and frpc', async () => {
    const artifact = FRP_COMPONENT_RELEASES[`${process.platform}-${process.arch}`]
    if (artifact === undefined) throw new Error('current platform has no pinned FRP artifact')
    const archiveBytes = await officialArchive()

    const directory = await mkdtemp(join(tmpdir(), 'dsh-mobile-frp-local-'))
    temporaryDirectories.push(directory)
    const component = new FrpComponentManager({ stateDirectory: join(directory, 'state'), fetchArtifact: async () => archiveBytes })
    await component.initialize()
    const componentStatus = await component.install()
    expect(componentStatus.installed).toBe(true)

    const archive = join(directory, artifact.archiveName)
    const extracted = join(directory, 'official-release')
    await mkdir(extracted)
    await writeFile(archive, archiveBytes)
    await run(process.platform === 'win32' ? 'tar.exe' : 'tar', ['-xf', archive, '-C', extracted])
    const frps = await findExecutable(extracted, process.platform === 'win32' ? 'frps.exe' : 'frps')
    const controlPort = await freePort()
    const vhostPort = await freePort()
    const token = randomBytes(24).toString('hex')
    const serverConfig = join(directory, 'frps.toml')
    await writeFile(serverConfig, [
      'bindAddr = "127.0.0.1"',
      `bindPort = ${String(controlPort)}`,
      'proxyBindAddr = "127.0.0.1"',
      `vhostHTTPPort = ${String(vhostPort)}`,
      'auth.method = "token"',
      `auth.token = ${JSON.stringify(token)}`,
      '',
    ].join('\n'))
    const serverProcess = spawn(frps, ['-c', serverConfig], { windowsHide: true, stdio: 'ignore' })
    await waitForPort(controlPort, serverProcess)

    const instanceId = 'f'.repeat(64)
    const gatewayServer = createServer((request, response) => {
      if (request.url !== '/mobile-access/discovery') { response.writeHead(404).end(); return }
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ instanceId }))
    })
    await new Promise<void>(resolve => { gatewayServer.listen(0, '127.0.0.1', resolve) })
    const gatewayPort = (gatewayServer.address() as AddressInfo).port
    const gateway = {
      address: () => ({ host: '127.0.0.1', port: gatewayPort, origin: `http://127.0.0.1:${String(gatewayPort)}` }),
      // The self-check compares against the identity this gateway advertises.
      config: { instanceId },
      close: async () => new Promise<void>(resolve => { gatewayServer.close(() => resolve()) }),
    } as unknown as MobileAccessGateway
    const publicHost = 'dsh.local.example'
    const config = new FrpConfigStore(join(directory, 'config'))
    await config.initialize()
    await config.configure({ serverAddress: '127.0.0.1', serverPort: controlPort, token, publicOrigin: `https://${publicHost}` })
    const controller = new FrpController({
      store: new MemoryControlStore(),
      executable: component.executable,
      config,
      instanceId,
      createGateway: async () => gateway,
      probeVhostExposure: async () => false,
      probeDiscovery: async (_target, expected, signal) => probeLocalDiscovery(vhostPort, publicHost, expected, signal),
      startTimeoutMs: 30_000,
      retryIntervalMs: 200,
    })
    try {
      await controller.initialize()
      await controller.setEnabled(true)
      await vi.waitFor(() => { expect(controller.status().state).toBe('ready') }, { timeout: 30_000, interval: 200 })
    } finally {
      await controller.close()
      if (gatewayServer.listening) await new Promise<void>(resolve => { gatewayServer.close(() => resolve()) })
      await stopChild(serverProcess)
    }
  }, 180_000)

  it('forwards the self-signed HTTPS ingress through official frps/frpc with pinned CA and IPv4 identity', async () => {
    const artifact = FRP_COMPONENT_RELEASES[`${process.platform}-${process.arch}`]
    if (artifact === undefined) throw new Error('current platform has no pinned FRP artifact')
    const archiveBytes = await officialArchive()
    const directory = await mkdtemp(join(tmpdir(), 'dsh-mobile-frp-self-signed-'))
    temporaryDirectories.push(directory)
    const component = new FrpComponentManager({ stateDirectory: join(directory, 'state'), fetchArtifact: async () => archiveBytes })
    await component.initialize()
    expect((await component.install()).installed).toBe(true)
    const extracted = join(directory, 'official-release')
    await mkdir(extracted)
    const archive = join(directory, artifact.archiveName)
    await writeFile(archive, archiveBytes)
    await run(process.platform === 'win32' ? 'tar.exe' : 'tar', ['-xf', archive, '-C', extracted])
    const frps = await findExecutable(extracted, process.platform === 'win32' ? 'frps.exe' : 'frps')
    const [controlPort, publicPort] = await distinctFrpPorts()
    const token = randomBytes(24).toString('hex')
    const serverConfig = join(directory, 'frps.toml')
    await writeFile(serverConfig, [
      'bindAddr = "127.0.0.1"',
      `bindPort = ${String(controlPort)}`,
      'proxyBindAddr = "127.0.0.1"',
      'auth.method = "token"',
      `auth.token = ${JSON.stringify(token)}`,
      '',
    ].join('\n'))
    const serverProcess = spawn(frps, ['-c', serverConfig], { windowsHide: true, stdio: 'ignore' })
    const context = new Context()
    let gateway: MobileAccessGateway | undefined
    let controller: FrpController | undefined
    const publicIp = '1.2.3.4'
    const stateFile = join(directory, 'remote', 'devices.json')
    try {
      await waitForPort(controlPort, serverProcess)
      const config = new FrpConfigStore(join(directory, 'config'))
      await config.initialize()
      await config.configure({
        serverAddress: '127.0.0.1', serverPort: controlPort, token,
        publicOrigin: `https://${publicIp}`, mode: 'attach', entryTls: 'self-signed', publicPort,
      })
      const settings = config.settings()
      if (settings === undefined) throw new Error('FRP fixture settings missing')
      const template = parseGatewayConfig({
        listenHost: '127.0.0.1', listenPort: 0,
        publicAuthorities: ['127.0.0.1'], allowedCidrs: ['127.0.0.0/8'],
        stateFile, tls: { mode: 'disabled' },
      })
      const probeDiscovery = vi.fn(async (target: { origin: string; trustAnchorPem?: string }, expected: string, signal: AbortSignal) => {
        if (target.origin !== frpEntryOrigin(settings) || target.trustAnchorPem === undefined) {
          throw new Error('frp_discovery_invalid')
        }
        const response = await pinnedHttpsGet(publicPort, '/mobile-access/discovery', publicIp, target.trustAnchorPem, signal)
        if (response.status !== 200 || !response.authorized) return false
        const advertisement: unknown = JSON.parse(response.body)
        return typeof advertisement === 'object' && advertisement !== null && !Array.isArray(advertisement)
          && (advertisement as Record<string, unknown>).instanceId === expected
      })
      controller = new FrpController({
        store: new MemoryControlStore(), executable: component.executable, config,
        instanceId: 'a'.repeat(64),
        createGateway: async (_origin, selected) => {
          const ingress = await ensureFrpIngressCertificate(selected, stateFile)
          const candidate = new MobileAccessGateway(
            frpIngressGatewayConfig(template, selected, stateFile, ingress),
            new MemoryDeviceStore(), new MobileAccessService(context),
          )
          gateway = candidate
          try { await candidate.start() } catch (error) { await candidate.close(); throw error }
          return candidate
        },
        resolveDiscoveryTrustAnchor: async () =>
          readFile(frpIngressPaths(stateFile).caCertFile, 'utf8'),
        probeDiscovery,
        probeVhostExposure: async () => { throw new Error('TCP ingress must not probe an HTTP vhost') },
        startTimeoutMs: 30_000, retryIntervalMs: 200,
      })
      await controller.initialize()
      await controller.setEnabled(true)
      await vi.waitFor(() => { expect(controller?.status()).toMatchObject({ state: 'ready', origin: `https://${publicIp}:${String(publicPort)}` }) },
        { timeout: 30_000, interval: 200 })
      const ca = await readFile(frpIngressPaths(stateFile).caCertFile, 'utf8')
      const health = await pinnedHttpsGet(publicPort, '/mobile-access/health', publicIp, ca)
      expect(health.status).toBe(200)
      expect(health.authorized).toBe(true)
      expect(health.peer?.checkIP(publicIp)).toBe(publicIp)
      expect(probeDiscovery).toHaveBeenCalledWith(
        { origin: `https://${publicIp}:${String(publicPort)}`, trustAnchorPem: ca },
        gateway?.config.instanceId,
        expect.any(AbortSignal),
      )
    } finally {
      try { await controller?.close() } finally {
        try { await gateway?.close() } finally {
          try { await context.fiber.dispose() } finally { await stopChild(serverProcess) }
        }
      }
    }
  }, 180_000)
})

describe.skipIf(!live)('live FRP + frps + Caddy path', () => {
  it('becomes ready only after the public HTTPS origin reaches this gateway', async () => {
    const executable = process.env.DSH_MOBILE_FRP_E2E_FRPC
    const serverAddress = process.env.DSH_MOBILE_FRP_E2E_SERVER
    const serverPort = Number(process.env.DSH_MOBILE_FRP_E2E_PORT)
    const token = process.env.DSH_MOBILE_FRP_E2E_TOKEN
    const publicOrigin = process.env.DSH_MOBILE_FRP_E2E_ORIGIN
    if (executable === undefined || serverAddress === undefined || token === undefined || publicOrigin === undefined) {
      throw new Error('live FRP variables are incomplete')
    }

    const directory = await mkdtemp(join(tmpdir(), 'dsh-mobile-frp-live-'))
    temporaryDirectories.push(directory)
    const config = new FrpConfigStore(join(directory, 'config'))
    await config.initialize()
    await config.configure({ serverAddress, serverPort, token, publicOrigin })
    const instanceId = 'f'.repeat(64)
    const server = createServer((request, response) => {
      if (request.url !== '/mobile-access/discovery') {
        response.writeHead(404).end()
        return
      }
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ instanceId }))
    })
    await new Promise<void>(resolve => { server.listen(0, '127.0.0.1', resolve) })
    const port = (server.address() as AddressInfo).port
    const gateway = {
      address: () => ({ host: '127.0.0.1', port, origin: `http://127.0.0.1:${String(port)}` }),
      // The self-check compares against the identity this gateway advertises.
      config: { instanceId },
      close: async () => new Promise<void>(resolve => { server.close(() => resolve()) }),
    } as unknown as MobileAccessGateway
    const controller = new FrpController({
      store: new MemoryControlStore(),
      executable,
      config,
      instanceId,
      createGateway: async () => gateway,
      startTimeoutMs: 60_000,
    })
    try {
      await controller.initialize()
      await controller.setEnabled(true)
      await vi.waitFor(() => { expect(controller.status().state).toBe('ready') }, { timeout: 60_000, interval: 500 })
    } finally {
      await controller.close()
      if (server.listening) await new Promise<void>(resolve => { server.close(() => resolve()) })
    }
  }, 75_000)
})
