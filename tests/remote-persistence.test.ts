import { ChildProcess, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CloudflaredController } from '../src/cloudflared.js'
import type { MobileAccessControlState, MobileAccessControlStore } from '../src/control.js'
import { CpolarController } from '../src/cpolar.js'
import { FrpConfigStore } from '../src/frp-config.js'
import { FrpController } from '../src/frp.js'
import { FunnelController } from '../src/funnel.js'
import { MobileAccessGateway } from '../src/gateway.js'
import { parseGatewayConfig } from '../src/config.js'
import { MemoryDeviceStore } from '../src/storage.js'
import { RemoteProviderCoordinator, type RemoteProviderController } from '../src/remote.js'

const spawning = vi.hoisted(() => ({ factory: undefined as (() => ChildProcessWithoutNullStreams) | undefined }))
vi.mock('node:child_process', async () => {
  const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process')
  return { ...actual, spawn: (...args: Parameters<typeof actual.spawn>) => spawning.factory?.() ?? actual.spawn(...args) }
})

class FakeChild extends ChildProcess implements ChildProcessWithoutNullStreams {
  override exitCode: number | null = null
  override readonly stdin = new PassThrough()
  override readonly stdout = new PassThrough()
  override readonly stderr = new PassThrough()
  override readonly stdio: [PassThrough, PassThrough, PassThrough, undefined, undefined] = [this.stdin, this.stdout, this.stderr, undefined, undefined]
  override kill(): boolean {
    if (this.exitCode !== null) return false
    this.exitCode = 0
    this.stdin.destroy(); this.stdout.destroy(); this.stderr.destroy()
    setImmediate(() => this.emit('close', 0))
    return true
  }
}

class FailingControlStore implements MobileAccessControlStore {
  state: MobileAccessControlState = { version: 1, enabled: false }
  fail = false
  attempts = 0
  async load(): Promise<MobileAccessControlState> { return this.state }
  async save(state: MobileAccessControlState): Promise<void> {
    this.attempts += 1
    if (this.fail) throw Object.assign(new Error('injected state save failure'), { code: 'EPERM' })
    this.state = state
  }
}

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
  spawning.factory = undefined
})

async function fixture(provider: string) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-mobile-provider-persistence-'))
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  const executable = join(root, 'provider.exe')
  const configFile = join(root, 'cpolar.yml')
  await writeFile(executable, 'fixture executable')
  await writeFile(configFile, 'fixture config')
  const store = new FailingControlStore()
  const children: FakeChild[] = []
  const spawn = (): ChildProcessWithoutNullStreams => {
    const child = new FakeChild(); children.push(child)
    return child
  }
  const closeGateway = vi.fn(async () => undefined)
  const instanceId = 'a'.repeat(64)
  const createGateway = async (origin = 'http://127.0.0.1:42123', port = 42123): Promise<MobileAccessGateway> => {
    const gateway = new MobileAccessGateway(parseGatewayConfig({
      stateFile: join(root, 'devices.json'), instanceId,
      listenHost: '127.0.0.1', tls: { mode: 'disabled' },
    }), new MemoryDeviceStore())
    vi.spyOn(gateway, 'address').mockReturnValue({ host: '127.0.0.1', port, origin })
    const dispose = gateway.close.bind(gateway)
    vi.spyOn(gateway, 'close').mockImplementation(async () => { await closeGateway(); await dispose() })
    return gateway
  }
  let controller: RemoteProviderController
  if (provider === 'cpolar') controller = new CpolarController({ store, executable, configFile, createGateway, spawnProcess: spawn })
  else if (provider === 'cloudflared') controller = new CloudflaredController({ store, executable, createGateway, spawnProcess: spawn, tunnel: { settings: () => ({ version: 1, mode: 'quick' }) } })
  else if (provider === 'frp') {
    const config = new FrpConfigStore(join(root, 'frp-config'))
    await config.initialize()
    await config.configure({ serverAddress: 'frp.example.com', serverPort: 7000, token: '0123456789abcdef0123456789abcdef', publicOrigin: 'https://dsh.example.com' })
    controller = new FrpController({ store, executable, config, instanceId, createGateway: origin => createGateway(origin),
      probeVhostExposure: async () => false, verifyConfig: async () => undefined, launchClient: spawn,
      probeDiscovery: async () => true, startTimeoutMs: 1000, retryIntervalMs: 1 })
  } else {
    spawning.factory = spawn
    controller = new FunnelController({ store, executable, stateDirectory: join(root, 'tailscale-state'), hostname: 'fixture', createGateway })
  }
  cleanups.push(() => controller.close())
  await controller.initialize()
  const start = async (): Promise<void> => {
    await controller.setEnabled(true)
    const child = children.at(-1)!
    if (provider === 'cpolar') child.stdout.write('Tunnel established at https://fixture.r8.cpolar.cn\n')
    else if (provider === 'cloudflared') child.stdout.write('https://fixture.trycloudflare.com\n')
    else if (provider === 'funnel') {
      child.stdout.write(`${JSON.stringify({ version: 1, type: 'ready', origin: 'https://fixture.ts.net' })}\n`)
      child.stdout.write(`${JSON.stringify({ version: 1, type: 'serving', origin: 'https://fixture.ts.net' })}\n`)
    }
    await vi.waitFor(() => expect(controller.status().state).toBe('ready'))
  }
  return { controller, store, children, closeGateway, root, start }
}

describe.each(['cpolar', 'cloudflared', 'frp', 'funnel'])('%s durable remote switch', provider => {
  it.each(['setEnabled', 'reset'])('keeps the working tunnel intact when %s cannot persist disabled state and allows retry', async action => {
    const { controller, store, children, closeGateway, root, start } = await fixture(provider)
    await start()
    const child = children.at(-1)!
    const before = controller.status()
    const attempts = store.attempts
    const stateMarker = join(root, 'tailscale-state', 'retained-state')
    if (provider === 'funnel') await writeFile(stateMarker, 'signed-in state')
    store.fail = true
    const disable = (): Promise<unknown> => action === 'reset' ? controller.reset() : controller.setEnabled(false)
    await expect(disable()).rejects.toThrow('injected state save failure')
    expect(store.state.enabled).toBe(true)
    expect(controller.status()).toEqual(before)
    expect(child.exitCode).toBeNull()
    expect(closeGateway).not.toHaveBeenCalled()
    if (provider === 'funnel') expect(await readFile(stateMarker, 'utf8')).toBe('signed-in state')
    store.fail = false
    await disable()
    expect(store.attempts).toBe(attempts + (provider === 'funnel' && action === 'reset' ? 3 : 2))
    expect(store.state.enabled).toBe(false)
    expect(controller.status()).toMatchObject({ enabled: false, state: 'off' })
    expect(child.exitCode).toBe(0)
    expect(closeGateway).toHaveBeenCalledOnce()
    if (provider === 'funnel' && action === 'reset') await expect(readFile(stateMarker)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it.each(['setEnabled', 'reconnect'])('does not launch or remember enabled when %s cannot save and remains retryable', async action => {
    const { controller, store, children } = await fixture(provider)
    store.fail = true
    const enable = (): Promise<unknown> => action === 'reconnect' ? controller.reconnect() : controller.setEnabled(true)
    await expect(enable()).rejects.toThrow('injected state save failure')
    expect(store.state.enabled).toBe(false)
    expect(controller.status()).toMatchObject({ enabled: false, state: 'off' })
    expect(children).toHaveLength(0)
    store.fail = false
    await enable()
    expect(store.attempts).toBe(2)
    expect(store.state.enabled).toBe(true)
    expect(children).toHaveLength(1)
  })

  it('Funnel stops owned resources when its state directory becomes invalid and retries after repair', async () => {
    if (provider !== 'funnel') return
    const { controller, store, children, closeGateway, root, start } = await fixture(provider)
    await start()
    const stateDirectory = join(root, 'tailscale-state')
    const child = children.at(-1)!
    const attempts = store.attempts
    await rm(stateDirectory, { recursive: true, force: true })
    await writeFile(stateDirectory, 'invalid state directory')

    await expect(controller.setEnabled(false)).rejects.toThrow('funnel_path_invalid')
    expect(store.attempts).toBe(attempts)
    expect(child.exitCode).toBe(0)
    expect(closeGateway).toHaveBeenCalledOnce()
    expect(controller.status()).toMatchObject({ enabled: true, state: 'unavailable', errorCode: 'funnel_state_invalid' })

    // A second close attempt must not return through the old enabled=false fast path.
    await expect(controller.setEnabled(false)).rejects.toThrow('funnel_path_invalid')
    expect(store.attempts).toBe(attempts)
    await rm(stateDirectory, { force: true })
    await mkdir(stateDirectory)
    await controller.setEnabled(false)
    expect(store.state.enabled).toBe(false)
    expect(controller.status()).toMatchObject({ enabled: false, state: 'off' })
  })

  it('Funnel makes repeated close calls share the same cleanup task', async () => {
    if (provider !== 'funnel') return
    const { controller, children, closeGateway, start } = await fixture(provider)
    await start()
    const first = controller.close()
    const second = controller.close()
    expect(second).toBe(first)
    await Promise.all([first, second])
    expect(children.at(-1)!.exitCode).toBe(0)
    expect(closeGateway).toHaveBeenCalledOnce()
  })

  it('Funnel releases its resources before a provider selection can complete', async () => {
    if (provider !== 'funnel') return
    const { controller, children, closeGateway, start } = await fixture(provider)
    await start()
    const inactive = (): RemoteProviderController => ({
      initialize: async () => {}, gateway: () => undefined,
      status: () => ({ enabled: false, state: 'off' }),
      setEnabled: async enabled => ({ enabled, state: enabled ? 'ready' : 'off' }),
      reconnect: async () => ({ enabled: true, state: 'ready' }),
      reset: async () => ({ enabled: false, state: 'off' }),
      close: async () => {},
    })
    const coordinator = new RemoteProviderCoordinator('tailscale', {
      tailscale: controller, cpolar: inactive(), cloudflared: inactive(), frp: inactive(), origin: inactive(),
    }, { save: async () => {} })
    await coordinator.select('cpolar')
    expect(coordinator.selected).toBe('cpolar')
    expect(children.at(-1)!.exitCode).toBe(0)
    expect(closeGateway).toHaveBeenCalledOnce()
  })
})
