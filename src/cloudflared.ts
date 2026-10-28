import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { lstat } from 'node:fs/promises'
import { createServer, type Server } from 'node:net'
import { isAbsolute } from 'node:path'
import type { CloudflaredTunnelMode, CloudflaredTunnelSettings } from './cloudflared-tunnel.js'
import type { MobileAccessControlState, MobileAccessControlStore } from './control.js'
import type { MobileAccessGateway } from './gateway.js'
import { settleRemoteResources, terminateRemoteProcess, type RemoteProviderController } from './remote.js'

const MAX_LOG_BUFFER_BYTES = 64 * 1024
/**
 * A quick tunnel has to be allocated and registered with the Cloudflare edge
 * before the public hostname appears. That is slower than a cpolar control
 * handshake but still bounded; 60 s keeps a genuinely stalled client from
 * looking healthy for longer than a user will wait.
 */
const START_TIMEOUT_MS = 60_000
/**
 * How many startup-timeout rounds a named tunnel may wait through while its
 * connector process is still alive. A rebooted PC often autostarts DSH before
 * Wi-Fi / VPN / DNS is usable; cloudflared retries the edge on its own, so
 * killing it after a single 60 s window turns a slow boot into a manual
 * reconnect loop. An exited connector (bad token, bad config) still fails fast
 * on the first round.
 */
const NAMED_STARTUP_ROUNDS = 5
const CLOUDFLARED_HOST_SUFFIX = '.trycloudflare.com'

/**
 * Subdomains Cloudflare reserves for its own control plane.
 *
 * The quick-tunnel banner prints `https://api.trycloudflare.com` (the registration API) before it
 * prints the tunnel's own hostname, and that address satisfies a bare suffix check. Adopting it
 * would put the API host in the pairing QR code, where the phone gets `{"code":10005","message":
 * "Method Not Allowed"}` instead of DSH. A quick tunnel is always one random label under the
 * suffix, so the reserved single labels are refused outright.
 */
const RESERVED_CLOUDFLARED_LABELS: readonly string[] = Object.freeze(['api', 'www', 'update', 'login'])

/** Product-facing states for the optional cloudflared remote transport. */
export type CloudflaredState = 'off' | 'unavailable' | 'starting' | 'connecting' | 'ready' | 'error'

/** Safe cloudflared state returned only through the loopback DSH control route. */
export interface CloudflaredStatus {
  readonly enabled: boolean
  readonly state: CloudflaredState
  readonly origin?: string
  readonly errorCode?: string
}

/** Inputs for one cloudflared process and its authenticated DSH gateway. */
export interface CloudflaredControllerOptions {
  readonly store: MobileAccessControlStore
  readonly executable: string
  /** Named-tunnel configuration; quick tunnels are used when it reports quick mode. */
  readonly tunnel: { settings(): CloudflaredTunnelSettings }
  readonly createGateway: (origin: string, listenPort: number) => Promise<MobileAccessGateway>
  readonly onStatus?: (status: CloudflaredStatus) => void
  /** Liveness bound for one startup-timeout round; defaults to the product timeout. */
  readonly startupTimeoutMs?: number
  /**
   * Total startup-timeout rounds before a live named connector is given up on;
   * defaults to NAMED_STARTUP_ROUNDS. Quick tunnels always use a single round.
   */
  readonly maxStartupRounds?: number
  readonly spawnProcess?: (
    executable: string,
    args: readonly string[],
    environment: NodeJS.ProcessEnv,
  ) => ChildProcessWithoutNullStreams
}

interface PortReservation {
  readonly port: number
  readonly release: () => Promise<void>
}

function publicStatus(status: CloudflaredStatus): CloudflaredStatus {
  return Object.freeze({
    enabled: status.enabled,
    state: status.state,
    ...(status.origin === undefined ? {} : { origin: status.origin }),
    ...(status.errorCode === undefined ? {} : { errorCode: status.errorCode }),
  })
}

/**
 * Whether a hostname is a quick-tunnel host: exactly one random label under the provider suffix,
 * never one of the reserved control-plane labels.
 */
function isCloudflaredHost(hostname: string): boolean {
  const lower = hostname.toLowerCase()
  if (!lower.endsWith(CLOUDFLARED_HOST_SUFFIX)) return false
  const label = lower.slice(0, -CLOUDFLARED_HOST_SUFFIX.length)
  return label !== '' && !label.includes('.') && !RESERVED_CLOUDFLARED_LABELS.includes(label)
}

/**
 * Extract a validated public HTTPS origin from one cloudflared output line.
 *
 * Quick tunnels print the public hostname inside a decorated banner, so the
 * candidate is taken from the line and then re-parsed as a URL: a lookalike such
 * as `https://x.trycloudflare.com.evil.test` fails the hostname check instead of
 * being truncated into an accepted origin.
 */
export function parseCloudflaredOrigin(line: string): string | undefined {
  if (!line.toLowerCase().includes('trycloudflare.com')) return undefined
  const match = /https?:\/\/[^\s"'|<>]+/u.exec(line)
  // A log line that merely mentions the provider suffix carries no origin, so it
  // is ignored. Only a URL that is present but fails validation is a protocol
  // violation worth failing the generation for.
  if (match === null) return undefined
  // Banner decoration can leave trailing punctuation attached to the hostname.
  const candidate = match[0].replace(/[),.;:]+$/u, '')
  let url: URL
  try { url = new URL(candidate) } catch { throw new Error('invalid_cloudflared_origin') }
  if (url.protocol !== 'https:' || url.port !== '' || !isCloudflaredHost(url.hostname)
    || url.pathname !== '/' || url.search !== '' || url.hash !== ''
    || url.username !== '' || url.password !== '') throw new Error('invalid_cloudflared_origin')
  return url.origin
}

/**
 * Whether one cloudflared log line reports an established edge connection.
 *
 * A named tunnel prints no banner, so registration is the only signal that the
 * connector reached Cloudflare and the public hostname can serve traffic. Both
 * the current and the older wording are accepted; anything else is ignored so a
 * chatty log line cannot be mistaken for readiness.
 */
export function isCloudflaredRegistration(line: string): boolean {
  return /registered tunnel connection/iu.test(line)
    || /connection\s+[0-9a-f][0-9a-f-]{7,}\s+registered/iu.test(line)
}

async function reserveLoopbackPort(requestedPort?: number): Promise<PortReservation> {
  const server: Server = createServer(socket => { socket.destroy() })
  await new Promise<void>((resolveListen, reject) => {
    server.once('error', reject)
    server.listen(requestedPort ?? 0, '127.0.0.1', () => {
      server.off('error', reject)
      resolveListen()
    })
  })
  const address = server.address()
  if (address === null || typeof address === 'string') {
    server.close()
    throw new Error('cloudflared_port_reservation_failed')
  }
  let released = false
  return {
    port: address.port,
    release: async () => {
      if (released) return
      released = true
      await new Promise<void>(resolveClose => { server.close(() => resolveClose()) })
    },
  }
}

function spawnCloudflaredProcess(
  executable: string,
  args: readonly string[],
  environment: NodeJS.ProcessEnv,
): ChildProcessWithoutNullStreams {
  return spawn(executable, [...args], {
    env: environment,
    shell: false,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  })
}

function withoutProxyEnvironment(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const blocked = new Set(['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY'])
  return Object.fromEntries(Object.entries(environment).filter(([name]) => !blocked.has(name.toUpperCase())))
}

/**
 * Owns an installed cloudflared client and a provider-specific DSH remote gateway.
 *
 * Quick tunnels allocate a random hostname and a random forward port on every
 * start. Named tunnels instead read an account token and a stable public
 * hostname from the tunnel store, forward to the configured loopback port, and
 * learn readiness from the connector's registration line rather than a banner.
 */
export class CloudflaredController implements RemoteProviderController {
  private enabled = false
  private initialized = false
  private disposed = false
  private child: ChildProcessWithoutNullStreams | undefined
  private gatewayValue: MobileAccessGateway | undefined
  private reservation: PortReservation | undefined
  private generation = 0
  private buffer = ''
  private mode: CloudflaredTunnelMode = 'quick'
  private namedOrigin: string | undefined
  private latest: CloudflaredStatus = publicStatus({ enabled: false, state: 'off' })
  private queue: Promise<void> = Promise.resolve()
  private startupTimer: NodeJS.Timeout | undefined
  private startupRounds = 0

  constructor(private readonly options: CloudflaredControllerOptions) {
    if (!isAbsolute(options.executable)) {
      throw new Error('cloudflared executable path must be absolute')
    }
  }

  /** Restore the remembered cloudflared switch independently from LAN and other providers. */
  async initialize(initialState?: MobileAccessControlState): Promise<void> {
    const state = initialState ?? await this.options.store.load()
    this.enabled = state.enabled
    this.initialized = true
    if (this.enabled) await this.start()
    else this.publish({ enabled: false, state: 'off' })
  }

  /** Return the active cloudflared-backed DSH gateway. */
  gateway(): MobileAccessGateway | undefined {
    return this.gatewayValue
  }

  /** Return state safe for the desktop control UI. */
  status(): CloudflaredStatus {
    return publicStatus(this.latest)
  }

  /** Enable or disable cloudflared without changing LAN or other provider state. */
  async setEnabled(enabled: boolean): Promise<CloudflaredStatus> {
    if (!this.initialized || this.disposed) throw new Error('cloudflared controller is unavailable')
    await this.enqueue(async () => {
      if (this.enabled === enabled && (enabled === false || this.child !== undefined)) return
      await this.options.store.save({ version: 1, enabled })
      this.enabled = enabled
      if (!enabled) await this.stop()
      if (enabled) await this.start()
      else this.publish({ enabled: false, state: 'off' })
    })
    return this.status()
  }

  /** Restart cloudflared and allocate a fresh quick tunnel. */
  async reconnect(): Promise<CloudflaredStatus> {
    if (!this.initialized || this.disposed) throw new Error('cloudflared controller is unavailable')
    await this.enqueue(async () => {
      if (!this.enabled) {
        await this.options.store.save({ version: 1, enabled: true })
        this.enabled = true
      }
      await this.stop()
      await this.start()
    })
    return this.status()
  }

  /** Disable cloudflared without deleting the installed component. */
  async reset(): Promise<CloudflaredStatus> {
    if (!this.initialized || this.disposed) throw new Error('cloudflared controller is unavailable')
    await this.enqueue(async () => {
      await this.options.store.save({ version: 1, enabled: false })
      this.enabled = false
      await this.stop()
      this.publish({ enabled: false, state: 'off' })
    })
    return this.status()
  }

  /** Stop owned resources without changing the remembered switch. */
  async close(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    await this.enqueue(() => this.stop())
  }

  private enqueue(operation: () => Promise<void>): Promise<void> {
    const task = this.queue.then(operation, operation)
    this.queue = task.then(() => undefined, () => undefined)
    return task
  }

  private publish(status: CloudflaredStatus): void {
    this.latest = publicStatus(status)
    try { this.options.onStatus?.(this.status()) } catch { /* UI observation cannot own runtime state. */ }
  }

  private async start(): Promise<void> {
    const generation = ++this.generation
    let executableEntry
    try { executableEntry = await lstat(this.options.executable) } catch {
      this.publish({ enabled: true, state: 'unavailable', errorCode: 'cloudflared_component_missing' })
      return
    }
    if (!executableEntry.isFile() || executableEntry.isSymbolicLink()) {
      this.publish({ enabled: true, state: 'unavailable', errorCode: 'cloudflared_component_invalid' })
      return
    }

    const settings = this.options.tunnel.settings()
    const named = settings.mode === 'named' ? settings : undefined
    this.mode = settings.mode
    this.namedOrigin = named === undefined ? undefined : `https://${named.hostname}`

    let reservation: PortReservation
    try {
      reservation = await reserveLoopbackPort(named?.port)
    } catch (error) {
      // A bind conflict is the user's to resolve; anything else is an internal
      // reservation failure and must not be reported as a busy port.
      const conflict = (error as NodeJS.ErrnoException | undefined)?.code === 'EADDRINUSE'
      this.publish({
        enabled: true,
        state: 'error',
        errorCode: conflict
          ? (named === undefined ? 'cloudflared_port_unavailable' : 'cloudflared_tunnel_port_unavailable')
          : 'cloudflared_port_reservation_failed',
      })
      return
    }
    this.reservation = reservation
    this.buffer = ''
    this.startupRounds = 0
    this.publish({ enabled: true, state: 'starting' })

    if (named !== undefined) {
      // Cloudflare already routes the public hostname to this exact port, so the
      // gateway must be listening before the connector registers; the port has to
      // survive restarts, which is why it is configuration rather than a choice.
      const origin = this.namedOrigin as string
      this.publish({ enabled: true, state: 'connecting', origin })
      await reservation.release()
      if (this.reservation === reservation) this.reservation = undefined
      let gateway: MobileAccessGateway
      try {
        gateway = await this.options.createGateway(origin, reservation.port)
      } catch (error) {
        // Only a real bind conflict is a port problem; anything else (certificate,
        // configuration, permissions) must not send the user chasing the port.
        const conflict = (error as NodeJS.ErrnoException | undefined)?.code === 'EADDRINUSE'
        this.publish({
          enabled: true,
          state: 'error',
          errorCode: conflict ? 'cloudflared_tunnel_port_unavailable' : 'gateway_start_failed',
        })
        return
      }
      if (generation !== this.generation || !this.enabled || this.disposed) {
        await gateway.close()
        return
      }
      this.gatewayValue = gateway
    }

    // The local DSH remote gateway speaks plain HTTP, so neither flavour needs an
    // origin TLS override. A named tunnel takes its token from the environment so
    // the credential never appears in the process command line.
    const args = named === undefined
      ? ['tunnel', '--url', `http://127.0.0.1:${String(reservation.port)}`, '--no-autoupdate']
      : ['tunnel', '--no-autoupdate', 'run']
    const environment = withoutProxyEnvironment(process.env)
    if (named !== undefined) environment.TUNNEL_TOKEN = named.token
    const child = (this.options.spawnProcess ?? spawnCloudflaredProcess)(
      this.options.executable,
      args,
      environment,
    )
    this.child = child
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', chunk => { this.consume(generation, String(chunk)) })
    child.stderr.on('data', chunk => { this.consume(generation, String(chunk)) })
    child.once('error', () => { void this.enqueue(() => this.failGeneration(generation, 'cloudflared_launch_failed')) })
    child.once('close', code => {
      if (generation !== this.generation || this.child !== child) return
      this.child = undefined
      if (this.enabled) void this.enqueue(() => this.failGeneration(generation, code === 0 ? 'cloudflared_stopped' : 'cloudflared_exited'))
    })
    this.armStartupTimer(generation)
  }

  private armStartupTimer(generation: number): void {
    if (this.startupTimer !== undefined) clearTimeout(this.startupTimer)
    this.startupTimer = setTimeout(() => {
      void this.enqueue(() => this.checkStartupTimeout(generation))
    }, this.options.startupTimeoutMs ?? START_TIMEOUT_MS)
    this.startupTimer.unref()
  }

  /**
   * Give a live named connector more time instead of killing it: it retries the
   * edge on its own and usually registers once the rebooted network is usable.
   * A dead connector, or an exhausted budget, fails the generation as before.
   */
  private async checkStartupTimeout(generation: number): Promise<void> {
    if (generation !== this.generation || !this.enabled || this.disposed) return
    if (this.latest.state === 'ready') return
    const childAlive = this.child !== undefined && this.child.exitCode === null
    const budget = this.options.maxStartupRounds ?? NAMED_STARTUP_ROUNDS
    if (this.mode === 'named' && childAlive && this.startupRounds + 1 < budget) {
      this.startupRounds += 1
      this.armStartupTimer(generation)
      return
    }
    await this.failGeneration(generation, 'cloudflared_start_timeout')
  }

  private consume(generation: number, chunk: string): void {
    if (generation !== this.generation) return
    this.buffer += chunk
    if (Buffer.byteLength(this.buffer, 'utf8') > MAX_LOG_BUFFER_BYTES && !this.buffer.includes('\n')) {
      void this.enqueue(() => this.failGeneration(generation, 'cloudflared_invalid_output'))
      return
    }
    while (true) {
      const newline = this.buffer.indexOf('\n')
      if (newline < 0) return
      const line = this.buffer.slice(0, newline).replace(/\r$/u, '')
      this.buffer = this.buffer.slice(newline + 1)
      if (this.mode === 'named') {
        // The public origin is configuration here, so the log is only read for the
        // registration that proves the connector reached Cloudflare.
        if (isCloudflaredRegistration(line)) void this.enqueue(() => this.confirmNamedReady(generation))
        continue
      }
      let origin: string | undefined
      try { origin = parseCloudflaredOrigin(line) } catch {
        void this.enqueue(() => this.failGeneration(generation, 'cloudflared_invalid_origin'))
        return
      }
      if (origin !== undefined) void this.enqueue(() => this.attachGateway(generation, origin))
    }
  }

  /** Mark a named tunnel ready once the connector has registered with the edge. */
  private async confirmNamedReady(generation: number): Promise<void> {
    if (generation !== this.generation || !this.enabled || this.disposed) return
    if (this.gatewayValue === undefined || this.latest.state === 'ready') return
    if (this.startupTimer !== undefined) clearTimeout(this.startupTimer)
    this.startupTimer = undefined
    this.publish({ enabled: true, state: 'ready', ...(this.namedOrigin === undefined ? {} : { origin: this.namedOrigin }) })
  }

  private async attachGateway(generation: number, origin: string): Promise<void> {
    if (generation !== this.generation || !this.enabled || this.disposed) return
    const current = this.gatewayValue
    if (current !== undefined) {
      if (current.address().origin === origin) return
      await this.rotateGateway(generation, origin, current)
      return
    }
    const reservation = this.reservation
    if (reservation === undefined) return
    this.publish({ enabled: true, state: 'connecting', origin })
    await reservation.release()
    if (this.reservation === reservation) this.reservation = undefined
    let gateway: MobileAccessGateway
    try { gateway = await this.options.createGateway(origin, reservation.port) } catch {
      await this.failGeneration(generation, 'gateway_start_failed')
      return
    }
    if (generation !== this.generation || !this.enabled || this.disposed || this.child === undefined) {
      await gateway.close()
      return
    }
    this.gatewayValue = gateway
    if (this.startupTimer !== undefined) clearTimeout(this.startupTimer)
    this.startupTimer = undefined
    this.publish({ enabled: true, state: 'ready', origin })
  }

  /** Replace the gateway authority when a quick tunnel restarts on a new hostname. */
  private async rotateGateway(
    generation: number,
    origin: string,
    current: MobileAccessGateway,
  ): Promise<void> {
    const listenPort = current.address().port
    // A replacement must bind the same port cloudflared already forwards to.
    // Stop exposing the closing instance before releasing that port.
    if (this.gatewayValue === current) this.gatewayValue = undefined
    this.publish({ enabled: true, state: 'connecting', origin })
    try {
      await current.close()
    } catch {
      await this.failGeneration(generation, 'gateway_start_failed')
      return
    }
    if (generation !== this.generation || !this.enabled || this.disposed || this.child === undefined) return

    let replacement: MobileAccessGateway
    try { replacement = await this.options.createGateway(origin, listenPort) } catch {
      await this.failGeneration(generation, 'gateway_start_failed')
      return
    }
    if (generation !== this.generation || !this.enabled || this.disposed || this.child === undefined) {
      await replacement.close()
      return
    }
    this.gatewayValue = replacement
    this.publish({ enabled: true, state: 'ready', origin })
  }

  private async failGeneration(generation: number, code: string): Promise<void> {
    if (generation !== this.generation) return
    await this.stopProcessAndGateway()
    if (this.enabled) this.publish({ enabled: true, state: 'error', errorCode: code })
  }

  private async stop(): Promise<void> {
    ++this.generation
    await this.stopProcessAndGateway()
  }

  private async stopProcessAndGateway(): Promise<void> {
    if (this.startupTimer !== undefined) clearTimeout(this.startupTimer)
    this.startupTimer = undefined
    const reservation = this.reservation
    this.reservation = undefined
    const child = this.child
    this.child = undefined
    const gateway = this.gatewayValue
    this.gatewayValue = undefined
    await settleRemoteResources([
      () => reservation?.release(),
      () => child !== undefined && child.exitCode === null ? terminateRemoteProcess(child) : undefined,
      () => gateway?.close(),
    ], 'cloudflared resource cleanup failed')
  }
}
