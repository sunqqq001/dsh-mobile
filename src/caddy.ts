import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import type { MobileAccessControlStore } from './control.js'
import type { MobileAccessGateway } from './gateway.js'
import type { CaddyComponentManager } from './caddy-component.js'
import { caddyInspectionEnvironment } from './caddy-component.js'
import { caddyCredentialEnvironment, type CaddyConfigStore, type CaddySettings } from './caddy-config.js'
import { execFileText } from './exec-file.js'
import { defaultProbeDiscovery } from './frp.js'
import { settleRemoteResources, terminateRemoteProcess, type RemoteProviderController } from './remote.js'

export type CaddyState = 'off' | 'unavailable' | 'starting' | 'ready' | 'error'
export interface CaddyStatus {
  readonly enabled: boolean
  readonly state: CaddyState
  readonly origin?: string
  readonly backendOrigin?: string
  readonly errorCode?: string
}

export interface CaddyControllerOptions {
  readonly store: MobileAccessControlStore
  readonly component: Pick<CaddyComponentManager, 'executable' | 'ensureExecutable' | 'status'>
  readonly config: CaddyConfigStore
  readonly instanceId: string
  readonly createGateway: (settings: CaddySettings) => Promise<MobileAccessGateway>
  readonly onStatus?: (status: CaddyStatus) => void
  readonly startupTimeoutMs?: number
  readonly probeIntervalMs?: number
  readonly probeDiscovery?: (origin: string, expectedInstanceId: string, signal: AbortSignal) => Promise<boolean>
  readonly validateConfig?: (executable: string, caddyfile: string, environment: NodeJS.ProcessEnv, signal: AbortSignal) => Promise<void>
  readonly spawnProcess?: (executable: string, args: readonly string[], environment: NodeJS.ProcessEnv) => ChildProcessWithoutNullStreams
  readonly terminateProcess?: (child: ChildProcessWithoutNullStreams) => Promise<void>
}

/** Private directories override Caddy's platform defaults; ambient API keys and admin/proxy overrides are omitted. */
export function caddyProcessEnvironment(config: CaddyConfigStore, settings: CaddySettings, environment: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const credentials = config.credentials()
  if (credentials === undefined) throw new Error('caddy_credentials_missing')
  return { ...caddyInspectionEnvironment(environment), ...caddyCredentialEnvironment(settings.dnsProvider, credentials),
    HOME: config.rootDirectory, USERPROFILE: config.rootDirectory, APPDATA: config.configDirectory,
    LOCALAPPDATA: config.dataDirectory, XDG_DATA_HOME: config.dataDirectory, XDG_CONFIG_HOME: config.configDirectory,
  }
}

function spawnCaddy(executable: string, args: readonly string[], environment: NodeJS.ProcessEnv): ChildProcessWithoutNullStreams {
  return spawn(executable, [...args], { env: environment, shell: false, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
}

async function validate(executable: string, caddyfile: string, environment: NodeJS.ProcessEnv, signal: AbortSignal): Promise<void> {
  try { await execFileText(executable, ['adapt', '--config', caddyfile, '--adapter', 'caddyfile'], {
    env: environment, signal, timeout: 15_000, maxBuffer: 256 * 1024,
  }) } catch { throw new Error('caddy_config_validation_failed') }
}

interface CaddyChild {
  readonly process: ChildProcessWithoutNullStreams
  closed: boolean
}

/** Owns Caddy and a loopback Gateway until both have stopped; ready requires verified public TLS and instance identity. */
export class CaddyController implements RemoteProviderController {
  private enabled = false
  private initialized = false
  private disposed = false
  private child: CaddyChild | undefined
  private gatewayValue: MobileAccessGateway | undefined
  private generation = 0
  private startupAbort: AbortController | undefined
  private latest: CaddyStatus = Object.freeze({ enabled: false, state: 'off' })
  private queue: Promise<void> = Promise.resolve()
  private closeTask: Promise<void> | undefined

  constructor(private readonly options: CaddyControllerOptions) {}

  initialize(): Promise<void> {
    return this.enqueue(async () => {
      if (this.initialized) return
      if (this.disposed) throw new Error('caddy_controller_unavailable')
      this.enabled = (await this.options.store.load()).enabled
      this.initialized = true
      if (this.enabled) await this.start()
    })
  }

  gateway(): MobileAccessGateway | undefined { return this.latest.state === 'ready' ? this.gatewayValue : undefined }
  status(): CaddyStatus { return this.latest }
  /** Cancel a readiness attempt before its owning coordinator waits for queued teardown. */
  cancelPendingStart(): void { this.startupAbort?.abort() }

  setEnabled(enabled: boolean): Promise<CaddyStatus> {
    if (!enabled) this.startupAbort?.abort()
    return this.enqueue(async () => {
      this.assertAvailable()
      if (this.enabled === enabled && (!enabled || this.latest.state === 'ready')) return
      if (!enabled) await this.stop()
      await this.options.store.save({ version: 1, enabled })
      this.enabled = enabled
      if (enabled) await this.start()
      else this.publish({ enabled: false, state: 'off' })
    }).then(() => this.status())
  }

  reconnect(): Promise<CaddyStatus> {
    this.startupAbort?.abort()
    return this.enqueue(async () => {
      this.assertAvailable()
      await this.stop()
      await this.options.store.save({ version: 1, enabled: true })
      this.enabled = true
      await this.start()
    }).then(() => this.status())
  }

  reset(): Promise<CaddyStatus> { return this.setEnabled(false) }

  close(): Promise<void> {
    this.disposed = true
    this.startupAbort?.abort()
    this.closeTask ??= this.enqueue(async () => { await this.stop(); this.publish({ enabled: this.enabled, state: 'off' }) })
      .catch((error: unknown) => { this.closeTask = undefined; throw error })
    return this.closeTask
  }

  private assertAvailable(): void { if (!this.initialized || this.disposed) throw new Error('caddy_controller_unavailable') }
  private enqueue(operation: () => Promise<void>): Promise<void> {
    const task = this.queue.then(operation, operation)
    this.queue = task.then(() => undefined, () => undefined)
    return task
  }
  private publish(status: CaddyStatus): void {
    this.latest = Object.freeze(status)
    try { this.options.onStatus?.(this.latest) } catch { /* Observers do not own process lifecycle. */ }
  }

  private async start(): Promise<void> {
    if (this.child !== undefined || this.gatewayValue !== undefined) await this.stop()
    const generation = ++this.generation
    const startup = new AbortController()
    this.startupAbort = startup
    const settings = this.options.config.settings()
    if (settings === undefined || this.options.config.credentials() === undefined) {
      this.publish({ enabled: true, state: 'unavailable', errorCode: 'caddy_config_missing' }); this.startupAbort = undefined; return
    }
    if (!this.options.component.status().supported) {
      this.publish({ enabled: true, state: 'unavailable', errorCode: 'caddy_component_unavailable' }); this.startupAbort = undefined; return
    }
    this.publish({ enabled: true, state: 'starting', origin: settings.publicOrigin })
    let childFailure: string | undefined
    const deadline = setTimeout(() => { startup.abort() }, this.options.startupTimeoutMs ?? 120_000)
    deadline.unref()
    try {
      await this.options.component.ensureExecutable()
      if (startup.signal.aborted || this.disposed) throw new Error('caddy_start_cancelled')
      const gateway = await this.options.createGateway(settings)
      this.gatewayValue = gateway
      if (startup.signal.aborted || this.disposed) throw new Error('caddy_start_cancelled')
      await this.options.config.prepareCaddyfile(gateway.address().port)
      const environment = caddyProcessEnvironment(this.options.config, settings)
      await (this.options.validateConfig ?? validate)(this.options.component.executable, this.options.config.caddyfile, environment, startup.signal)
      if (startup.signal.aborted || this.disposed) throw new Error('caddy_start_cancelled')
      const child = (this.options.spawnProcess ?? spawnCaddy)(this.options.component.executable,
        ['run', '--config', this.options.config.caddyfile, '--adapter', 'caddyfile'], environment)
      const ownedChild: CaddyChild = { process: child, closed: false }
      this.child = ownedChild
      child.once('close', () => { ownedChild.closed = true })
      // No provider response or DNS credentials enter DSH logs, and pipes cannot fill and stall the child.
      child.stdout.resume(); child.stderr.resume(); child.stdin.end()
      const failed = (code: string): void => {
        if (generation !== this.generation || this.child !== ownedChild) return
        childFailure = code
        startup.abort()
        if (this.latest.state === 'ready') {
          void this.enqueue(async () => {
            if (generation !== this.generation) return
            await this.stop()
            if (this.enabled && !this.disposed) this.publish({ enabled: true, state: 'error', errorCode: code })
          }).catch(() => { this.publish({ enabled: this.enabled, state: 'error', errorCode: 'caddy_cleanup_failed' }) })
        }
      }
      child.once('error', () => { failed('caddy_launch_failed') })
      child.once('close', () => { failed('caddy_exited') })
      const probe = this.options.probeDiscovery ?? ((origin, expected, signal) => defaultProbeDiscovery({ origin }, expected, signal))
      while (true) {
        if (startup.signal.aborted || this.disposed) throw new Error(childFailure ?? 'caddy_start_timeout')
        let ready = false
        try { ready = await probe(settings.publicOrigin, this.options.instanceId, startup.signal) } catch (error) {
          if (error instanceof Error && (error.message === 'frp_discovery_mismatch' || error.message === 'frp_discovery_invalid')) {
            throw new Error('caddy_public_identity_invalid')
          }
        }
        if (startup.signal.aborted || this.disposed || generation !== this.generation) throw new Error(childFailure ?? 'caddy_start_timeout')
        if (ready) break
        await this.waitForProbe(startup.signal)
      }
      this.publish({ enabled: true, state: 'ready', origin: settings.publicOrigin, backendOrigin: 'http://127.0.0.1:' + String(gateway.address().port) })
    } catch (error) {
      // Intentional termination must not replace the startup failure with a child-close event.
      ++this.generation
      await this.stopResources()
      if (!this.disposed) this.publish({ enabled: this.enabled, state: 'error', errorCode: childFailure
        ?? (error instanceof Error && error.message.startsWith('caddy_') ? error.message
          : (error as NodeJS.ErrnoException).code === 'EADDRINUSE' ? 'caddy_backend_port_in_use' : 'caddy_start_failed') })
    } finally {
      clearTimeout(deadline)
      if (this.startupAbort === startup) this.startupAbort = undefined
    }
  }

  private waitForProbe(signal: AbortSignal): Promise<void> {
    if (signal.aborted) return Promise.resolve()
    return new Promise(resolve => {
      const done = (): void => { clearTimeout(timer); signal.removeEventListener('abort', done); resolve() }
      const timer = setTimeout(done, this.options.probeIntervalMs ?? 1000)
      timer.unref(); signal.addEventListener('abort', done, { once: true })
    })
  }
  private async stop(): Promise<void> { ++this.generation; this.startupAbort?.abort(); await this.stopResources() }
  private waitForChildClose(child: CaddyChild): Promise<void> {
    if (child.closed) return Promise.resolve()
    return new Promise((resolve, reject) => {
      const finish = (error?: Error): void => {
        clearTimeout(timer)
        child.process.removeListener('close', closed)
        if (error === undefined) resolve()
        else reject(error)
      }
      const closed = (): void => { finish() }
      // The process can exit before its stdio closes; retain ownership through that bounded final phase.
      const timer = setTimeout(() => { finish(new Error('caddy_process_close_timeout')) }, 1_500)
      timer.unref()
      child.process.once('close', closed)
    })
  }
  private async stopResources(): Promise<void> {
    const child = this.child
    const gateway = this.gatewayValue
    try {
      await settleRemoteResources([
        async () => {
          if (child !== undefined) {
            await (this.options.terminateProcess ?? terminateRemoteProcess)(child.process)
            await this.waitForChildClose(child)
            if (this.child === child) this.child = undefined
          }
        },
        async () => { if (gateway !== undefined) { await gateway.close(); if (this.gatewayValue === gateway) this.gatewayValue = undefined } },
      ], 'caddy cleanup failed')
    } catch (error) {
      this.publish({ enabled: this.enabled, state: 'error', errorCode: 'caddy_cleanup_failed' })
      throw error
    }
  }
}
