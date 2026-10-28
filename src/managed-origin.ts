import { lstat, readFile } from 'node:fs/promises'
import { dirname, isAbsolute } from 'node:path'
import type { MobileAccessControlState, MobileAccessControlStore } from './control.js'
import type { MobileAccessGateway } from './gateway.js'
import { assertCaddyParents, writeCaddyPrivateFile } from './caddy-files.js'
import { restrictPrivateFile } from './private-file.js'
import { settleRemoteResources, type RemoteProviderController, type RemoteProviderStatus } from './remote.js'

export type OriginUpstreamMode = 'external' | 'managed'
export interface OriginModeState { readonly version: 1; readonly mode: OriginUpstreamMode }
export interface OriginModeStore { load(): Promise<OriginModeState>; save(value: OriginModeState): Promise<void> }

/** Children never independently restore a durable enabled switch. */
export function createVolatileRemoteControlStore(): MobileAccessControlStore {
  let value: MobileAccessControlState = { version: 1, enabled: false }
  return { load: async () => value, save: async state => { value = Object.freeze({ ...state }) } }
}

function parseMode(value: unknown): OriginModeState {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('origin_mode_invalid')
  const record = value as Record<string, unknown>
  if (record.version !== 1 || (record.mode !== 'external' && record.mode !== 'managed')
    || Reflect.ownKeys(record).some(key => key !== 'version' && key !== 'mode')) throw new Error('origin_mode_invalid')
  return Object.freeze({ version: 1, mode: record.mode })
}

/** Persist only origin's upstream mode, defaulting to the existing external-proxy behavior. */
export class JsonOriginModeStore implements OriginModeStore {
  constructor(readonly file: string) { if (!isAbsolute(file)) throw new Error('origin mode file must be absolute') }
  async load(): Promise<OriginModeState> {
    await assertCaddyParents(dirname(this.file), this.file)
    let entry
    try { entry = await lstat(this.file) } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, mode: 'external' }
      throw error
    }
    if (!entry.isFile() || entry.isSymbolicLink() || entry.size > 1024) throw new Error('origin_mode_invalid')
    await restrictPrivateFile(this.file)
    return parseMode(JSON.parse(await readFile(this.file, 'utf8')))
  }
  async save(value: OriginModeState): Promise<void> {
    await writeCaddyPrivateFile(dirname(this.file), this.file, JSON.stringify(parseMode(value)) + '\n')
  }
}

export interface ManagedOriginStatus extends RemoteProviderStatus { readonly mode: OriginUpstreamMode }
export interface ManagedOriginControllerOptions {
  readonly store: MobileAccessControlStore
  readonly modeStore: OriginModeStore
  readonly external: RemoteProviderController
  readonly managed: RemoteProviderController & { cancelPendingStart?(): void }
}

/** One origin-provider owner selects exactly one upstream; external settings and shared device records remain untouched. */
export class ManagedOriginController implements RemoteProviderController {
  private selected: OriginUpstreamMode = 'external'
  private enabled = false
  private initialized = false
  private disposed = false
  private queue: Promise<void> = Promise.resolve()
  private closeTask: Promise<void> | undefined

  constructor(private readonly options: ManagedOriginControllerOptions) {}
  mode(): OriginUpstreamMode { return this.selected }
  status(): ManagedOriginStatus { return Object.freeze({ ...this.controller().status(), enabled: this.enabled, mode: this.selected }) }
  gateway(): MobileAccessGateway | undefined { return this.enabled ? this.controller().gateway() : undefined }

  initialize(initialState?: MobileAccessControlState): Promise<void> {
    return this.enqueue(async () => {
      if (this.initialized) return
      if (this.disposed) throw new Error('origin_controller_unavailable')
      this.selected = (await this.options.modeStore.load()).mode
      this.enabled = (initialState ?? await this.options.store.load()).enabled
      await this.options.external.initialize()
      await this.options.managed.initialize()
      await this.options.external.setEnabled(false)
      await this.options.managed.setEnabled(false)
      this.initialized = true
      if (this.enabled && !this.disposed) await this.controller().setEnabled(true)
    })
  }

  selectMode(mode: OriginUpstreamMode): Promise<ManagedOriginStatus> {
    if (mode !== this.selected) this.options.managed.cancelPendingStart?.()
    return this.enqueue(async () => {
      this.assertAvailable()
      if (mode !== 'external' && mode !== 'managed') throw new Error('origin_mode_invalid')
      if (mode === this.selected) return
      const previous = this.controller()
      await previous.setEnabled(false)
      try { await this.options.modeStore.save({ version: 1, mode }) } catch (error) {
        if (this.enabled && !this.disposed) await previous.setEnabled(true)
        throw error
      }
      this.selected = mode
      if (this.enabled && !this.disposed) {
        try { await this.controller().setEnabled(true) } catch (error) {
          await this.stopBoth()
          throw error
        }
      }
    }).then(() => this.status())
  }

  setEnabled(enabled: boolean): Promise<ManagedOriginStatus> {
    if (!enabled) this.options.managed.cancelPendingStart?.()
    return this.enqueue(async () => {
      this.assertAvailable()
      await this.options.store.save({ version: 1, enabled })
      if (!enabled) await this.stopBoth()
      this.enabled = enabled
      if (enabled && !this.disposed) {
        try { await this.controller().setEnabled(true) } catch (error) { await this.stopBoth(); throw error }
      }
    }).then(() => this.status())
  }
  reconnect(): Promise<ManagedOriginStatus> {
    this.options.managed.cancelPendingStart?.()
    return this.enqueue(async () => {
      this.assertAvailable()
      await this.options.store.save({ version: 1, enabled: true })
      await this.stopBoth()
      this.enabled = true
      if (!this.disposed) {
        try { await this.controller().reconnect() } catch (error) { await this.stopBoth(); throw error }
      }
    }).then(() => this.status())
  }
  reset(): Promise<ManagedOriginStatus> { return this.setEnabled(false) }
  close(): Promise<void> {
    this.disposed = true
    // Closing managed immediately cancels a public readiness probe ahead of queued work.
    this.closeTask ??= settleRemoteResources([() => this.options.external.close(), () => this.options.managed.close()])
      .then(() => this.queue)
      .catch((error: unknown) => { this.closeTask = undefined; throw error })
    return this.closeTask
  }
  private controller(): RemoteProviderController { return this.options[this.selected] }
  private assertAvailable(): void { if (!this.initialized || this.disposed) throw new Error('origin_controller_unavailable') }
  private stopBoth(): Promise<void> { return settleRemoteResources([
    async () => { await this.options.external.setEnabled(false) }, async () => { await this.options.managed.setEnabled(false) },
  ]) }
  private enqueue(operation: () => Promise<void>): Promise<void> {
    const task = this.queue.then(operation, operation)
    this.queue = task.then(() => undefined, () => undefined)
    return task
  }
}
