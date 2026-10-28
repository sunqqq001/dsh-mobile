/** Lifecycle for the two native navigation actions in DSH General settings. */
export interface MobileNativeSettingsBridge {
  capabilities(): Promise<readonly string[]> | readonly string[]
  invoke(action: string, input?: unknown): Promise<unknown>
}

export type MobileNativeSettingsAction = 'mobile.switch-computer' | 'notification.settings'

export interface MobileNativeSettingsSnapshot {
  readonly supported: boolean
  readonly state: 'idle' | 'busy' | 'success' | 'error'
}

/** Own capability discovery and explicit calls; native actions retain the App's own timeout. */
export class MobileNativeSettingsActionController {
  private snapshot: MobileNativeSettingsSnapshot = Object.freeze({ supported: false, state: 'idle' })
  private readonly listeners = new Set<() => void>()
  private bridge: MobileNativeSettingsBridge | undefined
  private active = false
  private generation = 0
  private probe = 0
  private attempt = 0

  constructor(
    private readonly action: MobileNativeSettingsAction,
    private readonly getBridge: () => MobileNativeSettingsBridge | undefined,
  ) {}

  getSnapshot = (): MobileNativeSettingsSnapshot => this.snapshot
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  start(): void {
    this.active = true
    this.publish({ supported: false, state: 'idle' })
    this.refresh()
  }
  stop(): void {
    this.active = false
    this.generation += 1
    this.probe += 1
    this.attempt += 1
    this.bridge = undefined
  }

  /** Recheck support without replaying or invalidating an in-flight call to the same adapter. */
  refresh = (): void => {
    if (!this.active) return
    const bridge = this.getBridge()
    const probe = ++this.probe
    if (bridge !== this.bridge) {
      this.bridge = bridge
      this.generation += 1
      this.attempt += 1
      this.publish({ supported: false, state: 'idle' })
    }
    if (bridge === undefined) return
    const generation = this.generation
    const settle = (supported: boolean): void => {
      if (!this.current(bridge, generation) || probe !== this.probe) return
      if (!supported) this.attempt += 1
      this.publish({ supported, state: supported ? this.snapshot.state : 'idle' })
    }
    void Promise.resolve().then(() => {
      if (!this.current(bridge, generation) || probe !== this.probe) return undefined
      return bridge.capabilities()
    }).then(capabilities => { settle(capabilities?.includes(this.action) === true) }, () => { settle(false) })
  }

  /** Send at most one explicit action; late replies cannot update a replaced or unmounted row. */
  invoke = (): void => {
    const bridge = this.bridge
    if (bridge === undefined || !this.snapshot.supported || !this.current(bridge, this.generation)
      || this.snapshot.state === 'busy' || (this.action === 'mobile.switch-computer' && this.snapshot.state === 'success')) return
    const generation = this.generation
    const attempt = ++this.attempt
    this.publish({ supported: true, state: 'busy' })
    const current = (): boolean => this.current(bridge, generation) && attempt === this.attempt && this.snapshot.supported
    void Promise.resolve().then(() => {
      if (!current()) return undefined
      return bridge.invoke(this.action, {})
    }).then(() => {
      if (current()) this.publish({ supported: true, state: 'success' })
    }, () => {
      if (current()) this.publish({ supported: true, state: 'error' })
    })
  }

  private current(bridge: MobileNativeSettingsBridge, generation: number): boolean {
    return this.active && generation === this.generation && this.bridge === bridge && this.getBridge() === bridge
  }

  private publish(snapshot: MobileNativeSettingsSnapshot): void {
    if (snapshot.supported === this.snapshot.supported && snapshot.state === this.snapshot.state) return
    this.snapshot = Object.freeze(snapshot)
    for (const listener of this.listeners) listener()
  }
}
