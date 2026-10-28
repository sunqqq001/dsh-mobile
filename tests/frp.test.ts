import { EventEmitter } from 'node:events'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { PassThrough } from 'node:stream'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { MobileAccessControlState, MobileAccessControlStore } from '../src/control.js'
import { FrpConfigStore } from '../src/frp-config.js'
import { FrpController, frpcDiagnosisCode } from '../src/frp.js'
import type { MobileAccessGateway } from '../src/gateway.js'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
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

async function fixture(): Promise<{
  directory: string
  executable: string
  config: FrpConfigStore
}> {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-mobile-frp-'))
  temporaryDirectories.push(directory)
  const executable = join(directory, 'component', 'frpc.exe')
  await mkdir(dirname(executable), { recursive: true })
  await writeFile(executable, 'fake-frpc')
  const config = new FrpConfigStore(join(directory, 'config'))
  await config.initialize()
  await config.configure({
    serverAddress: 'frp.example.com',
    serverPort: 7000,
    token: '0123456789abcdef0123456789abcdef',
    publicOrigin: 'https://dsh.example.com',
  })
  return { directory, executable, config }
}

/**
 * Stand-in for a started gateway. It carries the identity it advertises through
 * `/mobile-access/discovery`, which the controller's start-up self-check compares
 * against; on the public-CA path that identity equals the plugin's instance id.
 */
function gateway(instanceId = 'a'.repeat(64)): MobileAccessGateway {
  return {
    address: () => ({ host: '127.0.0.1', port: 42123, origin: 'http://127.0.0.1:42123' }),
    config: { instanceId },
    close: vi.fn(async () => undefined),
  } as unknown as MobileAccessGateway
}

describe('FRP provider lifecycle', () => {
  it('uses discovery identity rather than log text to become ready', async () => {
    const { executable, config } = await fixture()
    const child = new FakeChild()
    const activeGateway = gateway()
    const probeDiscovery = vi.fn(async () => true)
    const controller = new FrpController({
      store: new MemoryControlStore(),
      executable,
      config,
      instanceId: 'a'.repeat(64),
      createGateway: async () => activeGateway,
      probeVhostExposure: async () => false,
      verifyConfig: async () => undefined,
      launchClient: () => child as unknown as ChildProcessWithoutNullStreams,
      probeDiscovery,
      startTimeoutMs: 500,
      retryIntervalMs: 1,
    })
    await controller.initialize()
    await controller.setEnabled(true)
    await vi.waitFor(() => { expect(controller.status()).toEqual({ enabled: true, state: 'ready', origin: 'https://dsh.example.com' }) })
    // The public-CA entry keeps the saved origin and the system trust store: the
    // explicit target must therefore carry no trust anchor at all.
    expect(probeDiscovery).toHaveBeenCalledWith(
      { origin: 'https://dsh.example.com' },
      'a'.repeat(64),
      expect.any(AbortSignal),
    )
    await controller.setEnabled(false)
    expect(controller.status()).toEqual({ enabled: false, state: 'off' })
    expect(activeGateway.close).toHaveBeenCalledOnce()
  })

  it('rejects a publicly reachable plaintext vhost before starting the gateway', async () => {
    const { executable, config } = await fixture()
    const createGateway = vi.fn(async () => gateway())
    const controller = new FrpController({
      store: new MemoryControlStore(),
      executable,
      config,
      instanceId: 'b'.repeat(64),
      createGateway,
      probeVhostExposure: async () => true,
    })
    await controller.initialize()
    await controller.setEnabled(true)
    expect(controller.status()).toEqual({
      enabled: true,
      state: 'error',
      origin: 'https://dsh.example.com',
      errorCode: 'frp_vhost_publicly_reachable',
    })
    expect(createGateway).not.toHaveBeenCalled()
    await controller.close()
  })

  it('probes the vhost port the user configured, never a hard-coded 7080', async () => {
    // A probe against the wrong port silently passes a publicly reachable
    // plaintext vhost, which is exactly the cookie-theft path the gate exists for.
    const { executable, config } = await fixture()
    const probeVhostExposure = vi.fn(async () => false)
    const controller = new FrpController({
      store: new MemoryControlStore(),
      executable,
      config,
      instanceId: 'c'.repeat(64),
      createGateway: async () => gateway('c'.repeat(64)),
      probeVhostExposure,
      verifyConfig: async () => undefined,
      launchClient: () => new FakeChild() as unknown as ChildProcessWithoutNullStreams,
      probeDiscovery: vi.fn(async () => true),
      startTimeoutMs: 500,
      retryIntervalMs: 1,
    })
    await controller.initialize()
    await controller.setEnabled(true)
    expect(probeVhostExposure).toHaveBeenCalledWith('frp.example.com', 7080)
    await controller.setEnabled(false)

    await config.configure({
      serverAddress: 'frp.example.com',
      serverPort: 7000,
      token: '0123456789abcdef0123456789abcdef',
      publicOrigin: 'https://dsh.example.com',
      mode: 'attach',
      vhostHttpPort: 8080,
    })
    await controller.setEnabled(true)
    expect(probeVhostExposure).toHaveBeenLastCalledWith('frp.example.com', 8080)
    await controller.close()
  })

  it('skips the vhost probe for the self-signed TCP passthrough and writes a tcp proxy', async () => {
    const { executable, config } = await fixture()
    await config.configure({
      serverAddress: 'frp.example.com',
      serverPort: 7000,
      token: '0123456789abcdef0123456789abcdef',
      publicOrigin: 'https://1.2.3.4',
      mode: 'attach',
      entryTls: 'self-signed',
      publicPort: 33_080,
    })
    const probeVhostExposure = vi.fn(async () => true)
    const createGateway = vi.fn(async () => gateway('d'.repeat(64)))
    const controller = new FrpController({
      store: new MemoryControlStore(),
      executable,
      config,
      instanceId: 'd'.repeat(64),
      createGateway,
      probeVhostExposure,
      verifyConfig: async () => undefined,
      launchClient: () => new FakeChild() as unknown as ChildProcessWithoutNullStreams,
      probeDiscovery: vi.fn(async () => true),
      startTimeoutMs: 500,
      retryIntervalMs: 1,
    })
    await controller.initialize()
    await controller.setEnabled(true)
    // There is no plaintext vhost at all in this mode, so nothing may be probed:
    // the injected probe would otherwise have failed the start.
    expect(probeVhostExposure).not.toHaveBeenCalled()
    await vi.waitFor(() => { expect(controller.status().state).toBe('ready') })
    expect(createGateway).toHaveBeenCalledWith('https://1.2.3.4', expect.objectContaining({
      mode: 'attach', entryTls: 'self-signed',
    }))
    const written = await readFile(config.runtimeConfigFile, 'utf8')
    expect(written).toContain('type = "tcp"')
    expect(written).toContain('remotePort = 33080')
    expect(written).toContain('localIP = "127.0.0.1"')
    expect(written).not.toContain('customDomains')
    await controller.close()
  })

  it('surfaces an ingress certificate failure with its own stable code', async () => {
    const { executable, config } = await fixture()
    await config.configure({
      serverAddress: 'frp.example.com',
      serverPort: 7000,
      token: '0123456789abcdef0123456789abcdef',
      publicOrigin: 'https://1.2.3.4',
      mode: 'attach',
      entryTls: 'self-signed',
    })
    const controller = new FrpController({
      store: new MemoryControlStore(),
      executable,
      config,
      instanceId: 'e'.repeat(64),
      createGateway: async () => { throw new Error('frp_attach_cert_unknown') },
      probeVhostExposure: async () => false,
    })
    await controller.initialize()
    await controller.setEnabled(true)
    expect(controller.status()).toEqual({
      enabled: true,
      state: 'error',
      origin: 'https://1.2.3.4:33080',
      errorCode: 'frp_attach_cert_unknown',
    })
    await controller.close()
  })

  it('fails fast with the frps conflict frpc reports instead of the start timeout', async () => {
    // frpc logs a refused proxy registration as a warning and keeps running, so
    // the controller sees a healthy child and an entry port nobody published.
    // Before the output diagnosis this only ever ended in `frp_start_timeout`
    // after the full deadline, which pointed users at DNS, Caddy, and firewalls
    // while the real cause was another machine owning the proxy name.
    const { executable, config } = await fixture()
    const child = new FakeChild()
    const controller = new FrpController({
      store: new MemoryControlStore(),
      executable,
      config,
      instanceId: 'f'.repeat(64),
      createGateway: async () => gateway(),
      probeVhostExposure: async () => false,
      verifyConfig: async () => undefined,
      launchClient: () => child as unknown as ChildProcessWithoutNullStreams,
      probeDiscovery: vi.fn(async () => false),
      // A deadline far longer than the assertion below: only the diagnosis can
      // produce this error in time, so a regression fails instead of waiting.
      startTimeoutMs: 60_000,
      retryIntervalMs: 1,
    })
    await controller.initialize()
    await controller.setEnabled(true)
    child.stdout.write('\u001b[1;34m2026-09-29 10:11:28.046 [W] [client/control.go:163] [97eb0b6686ede78b] '
      + '[dsh-mobile-97eb0b6686ed] start error: ')
    expect(controller.status().state).toBe('connecting')
    child.stdout.write('proxy name [dsh-mobile-97eb0b6686ed] is already in use\n\u001b[0m')
    await vi.waitFor(() => { expect(controller.status().errorCode).toBe('frp_proxy_name_in_use') })
    expect(controller.status().state).toBe('error')
    await controller.close()
  })

  it('reports a taken entry port separately and keeps the proxy name case distinct', async () => {
    const { executable, config } = await fixture()
    const child = new FakeChild()
    const controller = new FrpController({
      store: new MemoryControlStore(),
      executable,
      config,
      instanceId: 'a'.repeat(64),
      createGateway: async () => gateway(),
      probeVhostExposure: async () => false,
      verifyConfig: async () => undefined,
      launchClient: () => child as unknown as ChildProcessWithoutNullStreams,
      probeDiscovery: vi.fn(async () => false),
      startTimeoutMs: 60_000,
      retryIntervalMs: 1,
    })
    await controller.initialize()
    await controller.setEnabled(true)
    child.stderr.write('[dsh-mobile] start error: ')
    expect(controller.status().state).toBe('connecting')
    child.stderr.write('port already used\n')
    await vi.waitFor(() => { expect(controller.status().errorCode).toBe('frp_remote_port_in_use') })
    await controller.close()
  })

  it('maps every other frpc start failure to the generic registration code', () => {
    // frps refusals that are neither a name nor a port conflict keep the child
    // alive for the same reason, so the generic signature must still match.
    expect(frpcDiagnosisCode('xxx [I] login to server success')).toBeUndefined()
    expect(frpcDiagnosisCode('[W] [dsh-mobile] start error: type [tcp] is not supported')).toBe('frp_proxy_start_failed')
    expect(frpcDiagnosisCode('start error: port already used')).toBe('frp_remote_port_in_use')
    expect(frpcDiagnosisCode('start error: proxy name [x] is already in use')).toBe('frp_proxy_name_in_use')
  })
})
