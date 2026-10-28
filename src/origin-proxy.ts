import type { MobileAccessControlStore } from './control.js'
import type { MobileAccessGateway } from './gateway.js'
import type { OriginConfigStore, OriginSettings } from './origin-proxy-config.js'
import type { RemoteProviderController } from './remote.js'

export type OriginState = 'off' | 'unavailable' | 'starting' | 'ready' | 'error'

/** Ready means the private listener is ready, not that public ingress was tested. */
export interface OriginStatus {
  readonly enabled: boolean
  readonly state: OriginState
  readonly origin?: string
  readonly backendOrigin?: string
  readonly errorCode?: string
}

export interface OriginControllerOptions {
  readonly store: MobileAccessControlStore
  readonly config: OriginConfigStore
  readonly createGateway: (settings: OriginSettings) => Promise<MobileAccessGateway>
  readonly onStatus?: (status: OriginStatus) => void
}

/** Owns an authenticated HTTP gateway, with no tunnel process or public network probes. */
export class OriginController implements RemoteProviderController {
  private enabled = false
  private initialized = false
  private disposed = false
  private gatewayValue: MobileAccessGateway | undefined
  private latest: OriginStatus = Object.freeze({ enabled: false, state: 'off' })
  private queue: Promise<void> = Promise.resolve()

  constructor(private readonly options: OriginControllerOptions) {}

  async initialize(): Promise<void> {
    await this.enqueue(async () => {
      if (this.disposed) throw new Error('origin_controller_unavailable')
      if (this.initialized) return
      this.enabled = (await this.options.store.load()).enabled
      this.initialized = true
      if (this.enabled) await this.start()
      else this.publish({ enabled: false, state: 'off' })
    })
  }

  gateway(): MobileAccessGateway | undefined { return this.gatewayValue }
  status(): OriginStatus { return this.latest }

  async setEnabled(enabled: boolean): Promise<OriginStatus> {
    this.assertAvailable()
    await this.enqueue(async () => {
      this.assertAvailable()
      if (this.enabled === enabled && (!enabled || this.gatewayValue !== undefined)) return
      if (!enabled) await this.stop()
      await this.options.store.save({ version: 1, enabled })
      this.enabled = enabled
      if (enabled) await this.start()
      else this.publish({ enabled: false, state: 'off' })
    })
    return this.status()
  }

  async reconnect(): Promise<OriginStatus> {
    this.assertAvailable()
    await this.enqueue(async () => {
      this.assertAvailable()
      if (!this.enabled) {
        await this.options.store.save({ version: 1, enabled: true })
        this.enabled = true
      }
      await this.stop()
      await this.start()
    })
    return this.status()
  }

  /** Reset the switch, retaining both settings and shared remote device pairings. */
  async reset(): Promise<OriginStatus> { return this.setEnabled(false) }

  /** Stop the listener without changing the durable switch. */
  async close(): Promise<void> {
    this.disposed = true
    await this.enqueue(async () => {
      await this.stop()
      this.publish({ enabled: this.enabled, state: 'off' })
    })
  }

  private assertAvailable(): void {
    if (!this.initialized || this.disposed) throw new Error('origin_controller_unavailable')
  }

  private enqueue(operation: () => Promise<void>): Promise<void> {
    const task = this.queue.then(operation, operation)
    this.queue = task.then(() => undefined, () => undefined)
    return task
  }

  private publish(status: OriginStatus): void {
    this.latest = Object.freeze({ ...status })
    try { this.options.onStatus?.(this.latest) } catch { /* Observers do not own the listener. */ }
  }

  private async start(): Promise<void> {
    const settings = this.options.config.settings()
    if (settings === undefined) {
      this.publish({ enabled: true, state: 'unavailable', errorCode: this.options.config.status().errorCode ?? 'origin_config_missing' })
      return
    }
    this.publish({ enabled: true, state: 'starting', origin: settings.publicOrigin })
    let gateway: MobileAccessGateway
    try { gateway = await this.options.createGateway(settings) } catch (error) {
      const code = typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined
      this.publish({
        enabled: true, state: 'error', origin: settings.publicOrigin,
        errorCode: code === 'EADDRINUSE' ? 'origin_listen_port_in_use'
          : code === 'EADDRNOTAVAIL' ? 'origin_listen_address_unavailable' : 'origin_gateway_start_failed',
      })
      return
    }
    this.gatewayValue = gateway
    if (this.disposed) {
      await this.stop()
      return
    }
    this.publish({
      enabled: true, state: 'ready', origin: settings.publicOrigin,
      backendOrigin: 'http://' + settings.listenHost + ':' + String(gateway.address().port),
    })
  }

  private async stop(): Promise<void> {
    const gateway = this.gatewayValue
    if (gateway === undefined) return
    // Retain ownership on close failure so a later stop can retry cleanup.
    await gateway.close()
    this.gatewayValue = undefined
    this.publish({ enabled: this.enabled, state: 'off' })
  }
}
