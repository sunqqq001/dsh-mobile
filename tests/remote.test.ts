import { EventEmitter } from 'node:events'
import type { ChildProcess } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  configuredRemoteProvider,
  JsonRemoteProviderStore,
  prepareDisabledRemoteProviders,
  REMOTE_PROVIDERS,
  parseRemoteProviderState,
  RemoteProviderCoordinator,
  settleRemoteResources,
  terminateRemoteProcess,
  type RemoteProviderController,
  type RemoteProviderStatus,
} from '../src/remote.js'
import type { MobileAccessControlState } from '../src/control.js'

const temporaryDirectories: string[] = []

afterEach(async () => {
  vi.useRealTimers()
  await Promise.all(temporaryDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
})

class FakeRemoteController implements RemoteProviderController {
  enabled = false
  readonly changes: boolean[] = []

  async initialize(): Promise<void> {}
  gateway(): undefined { return undefined }
  status(): RemoteProviderStatus { return { enabled: this.enabled, state: this.enabled ? 'ready' : 'off' } }
  async setEnabled(enabled: boolean): Promise<RemoteProviderStatus> {
    this.changes.push(enabled)
    this.enabled = enabled
    return this.status()
  }
  async reconnect(): Promise<RemoteProviderStatus> { return this.setEnabled(true) }
  async reset(): Promise<RemoteProviderStatus> { return this.setEnabled(false) }
  async close(): Promise<void> {}
}

describe('remote provider selection', () => {
  it.each(REMOTE_PROVIDERS)('prepares only the inactive providers when %s is selected', async selected => {
    const disabled: MobileAccessControlState = Object.freeze({ version: 1, enabled: false })
    const stores = {
      tailscale: { disableIfPresent: vi.fn(async () => disabled) },
      cpolar: { disableIfPresent: vi.fn(async () => disabled) },
      cloudflared: { disableIfPresent: vi.fn(async () => disabled) },
      frp: { disableIfPresent: vi.fn(async () => disabled) },
      origin: { disableIfPresent: vi.fn(async () => disabled) },
    }
    const prepared = await prepareDisabledRemoteProviders(selected, stores)
    expect(prepared.size).toBe(4)
    expect(prepared.has(selected)).toBe(false)
    for (const provider of REMOTE_PROVIDERS) {
      if (provider === selected) expect(stores[provider].disableIfPresent).not.toHaveBeenCalled()
      else {
        expect(stores[provider].disableIfPresent).toHaveBeenCalledOnce()
        expect(prepared.get(provider)).toBe(disabled)
      }
    }
  })

  it('waits for a delayed disabled-state write before reporting another preparation failure', async () => {
    const disabled: MobileAccessControlState = { version: 1, enabled: false }
    const failure = new Error('fixture private-file failure')
    let finishWrite: ((state: MobileAccessControlState) => void) | undefined
    const delayed = new Promise<MobileAccessControlState>(resolve => { finishWrite = resolve })
    const stores = {
      tailscale: { disableIfPresent: vi.fn(async () => disabled) },
      cpolar: { disableIfPresent: vi.fn(async () => { throw failure }) },
      cloudflared: { disableIfPresent: vi.fn(async () => disabled) },
      frp: { disableIfPresent: vi.fn(() => delayed) },
      origin: { disableIfPresent: vi.fn(async () => disabled) },
    }
    let completed = false
    const preparation = prepareDisabledRemoteProviders('tailscale', stores).catch((error: unknown) => {
      completed = true
      return error
    })
    try {
      expect(stores.frp.disableIfPresent).toHaveBeenCalledOnce()
      // The rejection handlers drain while the explicit write barrier remains held.
      await new Promise<void>(resolve => { setImmediate(resolve) })
      expect(completed).toBe(false)
    } finally { finishWrite?.(disabled) }
    expect(await preparation).toBe(failure)
    expect(completed).toBe(true)
  })

  it('accepts only one supported provider and no extra fields', () => {
    expect(parseRemoteProviderState({ version: 1, provider: 'tailscale' })).toEqual({ version: 1, provider: 'tailscale' })
    expect(parseRemoteProviderState({ version: 1, provider: 'cpolar' })).toEqual({ version: 1, provider: 'cpolar' })
    expect(parseRemoteProviderState({ version: 1, provider: 'frp' })).toEqual({ version: 1, provider: 'frp' })
    expect(parseRemoteProviderState({ version: 1, provider: 'cloudflared' })).toEqual({ version: 1, provider: 'cloudflared' })
    expect(parseRemoteProviderState({ version: 1, provider: 'origin' })).toEqual({ version: 1, provider: 'origin' })
    expect(() => parseRemoteProviderState({ version: 1, provider: 'other' })).toThrow('unsupported format')
    expect(() => parseRemoteProviderState({ version: 1, provider: 'cpolar', token: 'secret' })).toThrow('unsupported format')
  })

  it('uses the environment only for the first-run default', async () => {
    expect(configuredRemoteProvider({})).toBe('tailscale')
    expect(configuredRemoteProvider({ DSH_MOBILE_REMOTE_PROVIDER: 'cpolar' })).toBe('cpolar')
    expect(configuredRemoteProvider({ DSH_MOBILE_REMOTE_PROVIDER: 'frp' })).toBe('frp')
    expect(configuredRemoteProvider({ DSH_MOBILE_REMOTE_PROVIDER: 'cloudflared' })).toBe('cloudflared')
    expect(configuredRemoteProvider({ DSH_MOBILE_REMOTE_PROVIDER: 'origin' })).toBe('origin')
    expect(() => configuredRemoteProvider({ DSH_MOBILE_REMOTE_PROVIDER: 'invalid' }))
      .toThrow('must be tailscale, cpolar, cloudflared, frp, or origin')

    const directory = await mkdtemp(join(tmpdir(), 'dsh-mobile-remote-provider-'))
    temporaryDirectories.push(directory)
    const file = join(directory, 'state', 'provider.json')
    const store = new JsonRemoteProviderStore(file, 'tailscale')
    expect(await store.load()).toEqual({ version: 1, provider: 'tailscale' })
    await store.save({ version: 1, provider: 'cpolar' })
    expect(await new JsonRemoteProviderStore(file, 'tailscale').load()).toEqual({ version: 1, provider: 'cpolar' })
  })

  it('serializes enable and selection so the previous provider cannot finish late', async () => {
    const controllers = {
      tailscale: new FakeRemoteController(),
      cpolar: new FakeRemoteController(),
      cloudflared: new FakeRemoteController(),
      frp: new FakeRemoteController(),
      origin: new FakeRemoteController(),
    }
    const saved: string[] = []
    const coordinator = new RemoteProviderCoordinator('tailscale', controllers, {
      save: async state => { saved.push(state.provider) },
    })
    let releaseEnable: (() => void) | undefined
    const enableGate = new Promise<void>(resolve => { releaseEnable = resolve })
    let enableStarted: (() => void) | undefined
    const started = new Promise<void>(resolve => { enableStarted = resolve })

    const enabling = coordinator.mutate(async controller => {
      enableStarted?.()
      await enableGate
      return controller.setEnabled(true)
    })
    await started
    const selecting = coordinator.select('frp')
    expect(saved).toEqual([])
    releaseEnable?.()
    await Promise.all([enabling, selecting])

    expect(coordinator.selected).toBe('frp')
    expect(saved).toEqual(['frp'])
    expect(controllers.tailscale.enabled).toBe(false)
    expect(controllers.cpolar.enabled).toBe(false)
  })

  it('restores the single-provider invariant even when a mutation fails', async () => {
    const controllers = {
      tailscale: new FakeRemoteController(),
      cpolar: new FakeRemoteController(),
      cloudflared: new FakeRemoteController(),
      frp: new FakeRemoteController(),
      origin: new FakeRemoteController(),
    }
    controllers.cpolar.enabled = true
    controllers.origin.enabled = true
    const coordinator = new RemoteProviderCoordinator('tailscale', controllers, { save: async () => {} })
    await expect(coordinator.mutate(async () => { throw new Error('operation failed') })).rejects.toThrow('operation failed')
    expect(controllers.cpolar.enabled).toBe(false)
    expect(controllers.frp.enabled).toBe(false)
    expect(controllers.origin.enabled).toBe(false)
  })

  it('rejects configuration for a provider that another selection already replaced', async () => {
    const controllers = { tailscale: new FakeRemoteController(), cpolar: new FakeRemoteController(), cloudflared: new FakeRemoteController(), frp: new FakeRemoteController(), origin: new FakeRemoteController() }
    const coordinator = new RemoteProviderCoordinator('origin', controllers, { save: async () => {} })
    const configure = vi.fn(async controller => controller.setEnabled(true))
    const selected = coordinator.select('cpolar')
    const configuring = coordinator.mutateSelected('origin', configure)
    const result = configuring.catch(error => error)
    await selected
    expect(await result).toBeInstanceOf(Error)
    expect((await result).message).toBe('remote_provider_changed')
    expect(configure).not.toHaveBeenCalled()
    expect(controllers.cpolar.enabled).toBe(false)
  })

  it('keeps configuration and activation in one queue item before a later provider selection', async () => {
    const controllers = { tailscale: new FakeRemoteController(), cpolar: new FakeRemoteController(), cloudflared: new FakeRemoteController(), frp: new FakeRemoteController(), origin: new FakeRemoteController() }
    const coordinator = new RemoteProviderCoordinator('origin', controllers, { save: async () => {} })
    let release: (() => void) | undefined
    let enter: (() => void) | undefined
    const ready = new Promise<void>(resolve => { enter = resolve })
    const barrier = new Promise<void>(resolve => { release = resolve })
    const configuring = coordinator.mutateSelected('origin', async controller => {
      enter?.(); await barrier
      return controller.setEnabled(true)
    })
    await ready
    const selected = coordinator.select('cpolar')
    expect(coordinator.selected).toBe('origin')
    release?.()
    await Promise.all([configuring, selected])
    expect(coordinator.selected).toBe('cpolar')
    expect(controllers.origin.enabled).toBe(false)
    expect(controllers.cpolar.enabled).toBe(false)
  })

  it('waits for process close after escalating from TERM to KILL', async () => {
    vi.useFakeTimers()
    const process = new EventEmitter() as EventEmitter & {
      exitCode: number | null
      signalCode: NodeJS.Signals | null
      kill: ReturnType<typeof vi.fn>
    }
    process.exitCode = null
    process.signalCode = null
    process.kill = vi.fn(() => true)
    let completed = false
    const stopping = terminateRemoteProcess(process as unknown as ChildProcess, 100, 100)
      .then(() => { completed = true })

    await vi.advanceTimersByTimeAsync(100)
    expect(process.kill).toHaveBeenNthCalledWith(1, 'SIGTERM')
    expect(process.kill).toHaveBeenNthCalledWith(2, 'SIGKILL')
    expect(completed).toBe(false)
    process.emit('close', null, null)
    await stopping
    expect(completed).toBe(true)
  })

  it('drains the accepted mutation while rejecting queued and new work before provider cleanup', async () => {
    const controllers = { tailscale: new FakeRemoteController(), cpolar: new FakeRemoteController(), cloudflared: new FakeRemoteController(), frp: new FakeRemoteController(), origin: new FakeRemoteController() }
    const save = vi.fn(async () => {})
    const coordinator = new RemoteProviderCoordinator('origin', controllers, { save })
    let enter!: () => void
    let release!: () => void
    const entered = new Promise<void>(resolve => { enter = resolve })
    const barrier = new Promise<void>(resolve => { release = resolve })
    const accepted = coordinator.mutate(async controller => {
      enter()
      await barrier
      return controller.setEnabled(true)
    })
    await entered
    const queued = vi.fn(async () => undefined)
    const queueResult = coordinator.mutate(queued).catch((error: unknown) => error)
    let completed = false
    const closing = coordinator.close()
    void closing.then(() => { completed = true })
    expect(coordinator.close()).toBe(closing)
    await expect(coordinator.select('cpolar')).rejects.toThrow('remote_provider_closed')
    await expect(coordinator.mutateSelected('origin', queued)).rejects.toThrow('remote_provider_closed')
    expect(completed).toBe(false)
    release()
    expect((await accepted).enabled).toBe(true)
    expect(await queueResult).toMatchObject({ message: 'remote_provider_closed' })
    await closing
    expect(completed).toBe(true)
    expect(queued).not.toHaveBeenCalled()
    expect(save).not.toHaveBeenCalled()
    expect(controllers.origin.enabled).toBe(true)
  })

  it('does not wait again after a process has already exited by signal', async () => {
    const process = new EventEmitter() as EventEmitter & {
      exitCode: number | null
      signalCode: NodeJS.Signals | null
      kill: ReturnType<typeof vi.fn>
    }
    process.exitCode = null
    process.signalCode = 'SIGTERM'
    process.kill = vi.fn(() => true)

    await terminateRemoteProcess(process as unknown as ChildProcess)

    expect(process.kill).not.toHaveBeenCalled()
  })

  it('settles every provider resource before aggregating cleanup failures', async () => {
    const completed: string[] = []
    let failure: unknown
    try {
      await settleRemoteResources([
        async () => { completed.push('process'); throw new Error('process failed') },
        async () => { completed.push('gateway') },
        async () => { completed.push('config'); throw new Error('config failed') },
      ])
    } catch (error) { failure = error }
    expect(completed).toEqual(['process', 'gateway', 'config'])
    expect(failure).toBeInstanceOf(AggregateError)
    expect((failure as AggregateError).errors).toHaveLength(2)
  })
})
