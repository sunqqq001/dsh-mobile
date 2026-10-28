import { spawn, execFile, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { lstat, rm } from 'node:fs/promises'
import { request as httpsRequest } from 'node:https'
import type { ClientRequest, IncomingMessage } from 'node:http'
import { connect } from 'node:net'
import { isAbsolute } from 'node:path'
import { Readable } from 'node:stream'
import type { MobileAccessControlState, MobileAccessControlStore } from './control.js'
import type { FrpConfigStore, FrpSettings } from './frp-config.js'
import { frpEntryOrigin, isFrpSelfSignedIngress, resolveFrpVhostHttpPort } from './frp-config.js'
import type { MobileAccessGateway } from './gateway.js'
import { settleRemoteResources, terminateRemoteProcess, type RemoteProviderController } from './remote.js'

const START_TIMEOUT_MS = 45_000
const DISCOVERY_REQUEST_TIMEOUT_MS = 5_000
const DISCOVERY_RETRY_MS = 1_000
const MAX_DISCOVERY_BYTES = 16 * 1024
const VHOST_PROBE_TIMEOUT_MS = 1_500
const INGRESS_CERT_CHECK_MS = 12 * 60 * 60_000
/** Cap on the frpc output retained for start-failure diagnosis. */
const MAX_CLIENT_DIAGNOSIS_CHARS = 8 * 1024

/**
 * frpc start-failure signatures, most specific first.
 *
 * frpc reports a refused proxy registration as a warning and keeps running, so
 * without this mapping the controller only ever saw a healthy child process and
 * an entry port nobody published: the start-up self-check burned its full 45s
 * deadline and reported `frp_start_timeout` ("the public endpoint did not become
 * ready"), which sent users looking at DNS, Caddy, and firewalls.
 *
 * The two real conflicts are a proxy name another client of the same frps holds
 * and an entry port another proxy already owns. Both are reported directly.
 */
const CLIENT_FAILURE_CODES: readonly (readonly [RegExp, string])[] = Object.freeze([
  [/proxy name \[[^\]]*\] is already in use/iu, 'frp_proxy_name_in_use'],
  [/(?:remote )?port (?:\[?[0-9]+\]? )?already (?:used|in use)/iu, 'frp_remote_port_in_use'],
  [/start error:/iu, 'frp_proxy_start_failed'],
])

/**
 * Stable error code for a chunk of frpc output, or undefined when it reports no
 * start failure. Exported for the conflict tests.
 */
export function frpcDiagnosisCode(output: string): string | undefined {
  return CLIENT_FAILURE_CODES.find(([pattern]) => pattern.test(output))?.[1]
}

/** Product-facing states for the restricted self-hosted FRP transport. */
export type FrpState = 'off' | 'unavailable' | 'starting' | 'connecting' | 'ready' | 'error'

/** Safe FRP state returned only through the loopback DSH control route. */
export interface FrpStatus {
  readonly enabled: boolean
  readonly state: FrpState
  readonly origin?: string
  readonly errorCode?: string
}

/**
 * Explicit target of the start-up discovery self-check.
 *
 * The target is derived from the effective entry, never assumed: the public-CA
 * entry answers on the saved origin (443 behind Caddy, publicly trusted chain),
 * while the self-signed entry is a raw TCP passthrough on `publicPort` whose
 * leaf chains to the plugin's own ingress CA.
 */
export interface FrpDiscoveryProbeTarget {
  /** Absolute HTTPS origin to dial, including the public entry port. */
  readonly origin: string
  /**
   * PEM bundle that anchors the entry leaf in place of the system trust store.
   * Absent keeps the default chain, which is correct for a publicly trusted
   * certificate; it is never a way to skip verification.
   */
  readonly trustAnchorPem?: string
}

/** Derived self-check target plus the origin the panel is told about. */
interface FrpDiscoveryCheck {
  /** Origin reported once the channel is ready; the actual HTTPS entry. */
  readonly publicOrigin: string
  /** Absolute origin the probe dials, including the effective entry port. */
  readonly targetOrigin: string
  /** Present only for the self-signed entry, where it must be pinned. */
  readonly trustAnchorPem?: string
}

/** Inputs for one FRP client process and authenticated DSH gateway. */
export interface FrpControllerOptions {
  readonly store: MobileAccessControlStore
  readonly executable: string
  readonly config: FrpConfigStore
  /**
   * Plugin-wide installation identity (the LAN pairing CA fingerprint).
   *
   * Retained for backward compatibility and constructor validation only. It no
   * longer takes part in the start-up self-check: that check compares against the
   * identity of the gateway this controller created and advertises, because the
   * self-signed FRP ingress gateway is pinned to the ingress CA fingerprint by
   * design, and that value deliberately differs from this one.
   */
  readonly instanceId: string
  readonly createGateway: (origin: string, settings: FrpSettings) => Promise<MobileAccessGateway>
  readonly onStatus?: (status: FrpStatus) => void
  readonly verifyConfig?: (executable: string, configFile: string) => Promise<void>
  readonly launchClient?: (executable: string, configFile: string) => ChildProcessWithoutNullStreams
  readonly probeVhostExposure?: (serverAddress: string, port: number) => Promise<boolean>
  readonly probeDiscovery?: (target: FrpDiscoveryProbeTarget, expectedInstanceId: string, signal: AbortSignal) => Promise<boolean>
  /**
   * Resolve the CA the self-check must pin for the self-signed entry.
   *
   * Only the composing plugin knows where the ingress material lives, so the
   * trust anchor is injected instead of guessed here. Consulted solely for the
   * self-signed passthrough; the public-CA entry always keeps the system trust
   * store. A configured resolver that cannot provide the CA fails startup with
   * `frp_ingress_ca_invalid`; the system trust store must not mask that failure.
   */
  readonly resolveDiscoveryTrustAnchor?: (settings: FrpSettings) => Promise<string | undefined>
  /** Re-issue an expiring leaf and reload the live TLS listener without changing its CA. */
  readonly maintainIngressCertificate?: (settings: FrpSettings, gateway: MobileAccessGateway) => Promise<void>
  /** Test seam for the maintenance timer; the product uses a twelve-hour interval. */
  readonly ingressCertificateCheckMs?: number
  readonly startTimeoutMs?: number
  readonly retryIntervalMs?: number
}

function publicStatus(status: FrpStatus): FrpStatus {
  return Object.freeze({
    enabled: status.enabled,
    state: status.state,
    ...(status.origin === undefined ? {} : { origin: status.origin }),
    ...(status.errorCode === undefined ? {} : { errorCode: status.errorCode }),
  })
}

async function defaultVerifyConfig(executable: string, configFile: string): Promise<void> {
  await new Promise<void>((resolveRun, reject) => {
    execFile(executable, ['verify', '-c', configFile], {
      windowsHide: true,
      timeout: 30_000,
      maxBuffer: 64 * 1024,
    }, error => {
      if (error === null) resolveRun()
      else reject(error)
    })
  })
}

function defaultLaunchClient(executable: string, configFile: string): ChildProcessWithoutNullStreams {
  return spawn(executable, ['-c', configFile], {
    shell: false,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  })
}

async function defaultProbeVhostExposure(serverAddress: string, port: number): Promise<boolean> {
  return new Promise<boolean>(resolveProbe => {
    const socket = connect({ host: serverAddress, port })
    let finished = false
    let received = ''
    const finish = (exposed: boolean): void => {
      if (finished) return
      finished = true
      clearTimeout(timer)
      socket.destroy()
      resolveProbe(exposed)
    }
    const timer = setTimeout(() => { finish(false) }, VHOST_PROBE_TIMEOUT_MS)
    timer.unref()
    socket.once('connect', () => {
      // A transparent proxy/TUN can acknowledge every TCP connect even when
      // the remote port is closed. Require an actual HTTP response from the
      // FRP vhost listener before treating the plaintext port as exposed.
      socket.write('GET /dsh-mobile-exposure-probe HTTP/1.1\r\nHost: invalid.example\r\nConnection: close\r\n\r\n')
    })
    socket.on('data', chunk => {
      received = `${received}${chunk.toString('latin1')}`.slice(0, 32)
      if (/^HTTP\/1\.[01] [1-5][0-9]{2}/u.test(received)) finish(true)
    })
    socket.once('close', () => { finish(false) })
    socket.once('error', () => { finish(false) })
  })
}

async function boundedResponseBytes(response: Response): Promise<Uint8Array> {
  if (response.body === null) throw new Error('frp_discovery_invalid')
  const declaredLength = Number(response.headers.get('content-length'))
  if (Number.isFinite(declaredLength) && declaredLength > MAX_DISCOVERY_BYTES) throw new Error('frp_discovery_invalid')
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let received = 0
  while (true) {
    const result = await reader.read()
    if (result.done) break
    received += result.value.byteLength
    if (received > MAX_DISCOVERY_BYTES) {
      await reader.cancel()
      throw new Error('frp_discovery_invalid')
    }
    chunks.push(result.value)
  }
  const bytes = new Uint8Array(received)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return bytes
}

/** Web view over an HTTPS response so the byte cap applies to both paths alike. */
function discoveryResponse(message: IncomingMessage): Response {
  const headers = new Headers()
  const declaredLength = message.headers['content-length']
  if (declaredLength !== undefined) headers.set('content-length', declaredLength)
  return new Response(Readable.toWeb(message) as ReadableStream<Uint8Array>, {
    status: message.statusCode ?? 200,
    headers,
  })
}

/**
 * Perform one discovery request against the public entry.
 *
 * `node:https` carries this request instead of the global `fetch` for a single
 * reason: only here can the trust anchor be stated. The self-signed entry
 * presents a leaf the plugin's own ingress CA signed, so the default chain
 * always fails there (`UNABLE_TO_VERIFY_LEAF_SIGNATURE`) even though the
 * transport itself is healthy. The anchor is *added* to the trust store — never
 * `rejectUnauthorized: false` — so the peer must still prove its identity, and
 * the verified name stays the host of the origin, which is the name the app
 * dials as well (Node matches IP literals against `IP Address:` SANs).
 *
 * A non-200 answer resolves `undefined` for retry; discovery requires a body.
 * transport, TLS, and timeout failures reject so the caller keeps retrying.
 * The request stays cancellable until the bounded response body has completed.
 */
function requestDiscovery(
  target: FrpDiscoveryProbeTarget,
  signal: AbortSignal,
): Promise<Uint8Array | undefined> {
  if (signal.aborted) return Promise.reject(new Error('frp_discovery_aborted'))
  const url = new URL(`${target.origin}/mobile-access/discovery`)
  if (url.protocol !== 'https:' || url.hostname === '') return Promise.reject(new Error('frp_discovery_invalid'))
  return new Promise<Uint8Array | undefined>((resolveRequest, rejectRequest) => {
    let settled = false
    let request: ClientRequest | undefined
    const release = (): void => {
      clearTimeout(timeout)
      signal.removeEventListener('abort', onAbort)
    }
    const fail = (error: Error): void => {
      if (settled) return
      settled = true
      release()
      request?.destroy()
      rejectRequest(error)
    }
    const succeed = (value: Uint8Array | undefined): void => {
      if (settled) return
      settled = true
      release()
      resolveRequest(value)
    }
    const onAbort = (): void => { fail(new Error('frp_discovery_aborted')) }
    // The request timeout spans the whole exchange, body included: it is released
    // only once the response socket is done, which is exactly what the aborted
    // fetch used to do. A timeout after the headers still tears the body read
    // down, so a stalled body keeps retrying instead of hanging forever.
    const timeout = setTimeout(() => { fail(new Error('frp_discovery_timeout')) }, DISCOVERY_REQUEST_TIMEOUT_MS)
    timeout.unref()
    signal.addEventListener('abort', onAbort, { once: true })
    request = httpsRequest({
      host: url.hostname,
      port: url.port === '' ? 443 : Number(url.port),
      path: url.pathname,
      method: 'GET',
      headers: { accept: 'application/json' },
      // Adding the anchor keeps certificate verification and the hostname check
      // switched on; it only widens what counts as a trusted issuer.
      ...(target.trustAnchorPem === undefined ? {} : { ca: target.trustAnchorPem }),
      // One fresh connection per attempt: a pooled socket must never let a stale
      // handshake decide the state of a new generation.
      agent: false,
    }, message => {
      const status = message.statusCode ?? 0
      if (status !== 200) {
        succeed(undefined)
        message.destroy()
        return
      }
      void boundedResponseBytes(discoveryResponse(message)).then(succeed, fail)
    })
    request.once('error', error => {
      fail(error instanceof Error ? error : new Error('frp_discovery_request_failed'))
    })
    request.end()
  })
}

/**
 * Read the public discovery advertisement and compare it with the expected
 * identity.
 *
 * `frp_discovery_invalid` (malformed body) and `frp_discovery_mismatch` (the
 * entry advertises another identity) stay immediate failures; transport, TLS,
 * and timeout problems reject so the caller retries until its deadline.
 */
export async function defaultProbeDiscovery(
  target: FrpDiscoveryProbeTarget,
  expectedInstanceId: string,
  signal: AbortSignal,
): Promise<boolean> {
  // The byte cap, transport faults, and timeout all cover the complete body;
  // a peer that sends only headers cannot leave the controller connecting forever.
  const bytes = await requestDiscovery(target, signal)
  if (bytes === undefined) return false
  let value: unknown
  try { value = JSON.parse(new TextDecoder().decode(bytes)) as unknown } catch {
    throw new Error('frp_discovery_invalid')
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('frp_discovery_invalid')
  const actual = (value as Record<string, unknown>).instanceId
  if (typeof actual !== 'string') throw new Error('frp_discovery_invalid')
  if (actual !== expectedInstanceId) throw new Error('frp_discovery_mismatch')
  return true
}

/** Owns frpc, its generation-specific configuration, and the remote gateway. */
export class FrpController implements RemoteProviderController {
  private enabled = false
  private initialized = false
  private disposed = false
  private child: ChildProcessWithoutNullStreams | undefined
  private gatewayValue: MobileAccessGateway | undefined
  private generation = 0
  private latest: FrpStatus = publicStatus({ enabled: false, state: 'off' })
  private queue: Promise<void> = Promise.resolve()
  private startupAbort: AbortController | undefined
  private ingressCertificateTimer: NodeJS.Timeout | undefined

  constructor(private readonly options: FrpControllerOptions) {
    if (!isAbsolute(options.executable)) throw new Error('frpc executable path must be absolute')
    if (!/^[a-f0-9]{64}$/u.test(options.instanceId)) throw new Error('FRP instance ID is invalid')
    if (options.ingressCertificateCheckMs !== undefined
      && (!Number.isSafeInteger(options.ingressCertificateCheckMs)
        || options.ingressCertificateCheckMs < 1 || options.ingressCertificateCheckMs > 2_147_483_647)) {
      throw new Error('frp_ingress_check_interval_invalid')
    }
  }

  /** Restore the remembered FRP switch without changing LAN or other providers. */
  async initialize(initialState?: MobileAccessControlState): Promise<void> {
    const state = initialState ?? await this.options.store.load()
    this.enabled = state.enabled
    this.initialized = true
    if (this.enabled) await this.start()
    else this.publish({ enabled: false, state: 'off' })
  }

  /** Return the active FRP-backed DSH gateway. */
  gateway(): MobileAccessGateway | undefined {
    return this.gatewayValue
  }

  /** Return state safe for the desktop control UI. */
  status(): FrpStatus {
    return publicStatus(this.latest)
  }

  /** Enable or disable FRP without changing LAN or another provider. */
  async setEnabled(enabled: boolean): Promise<FrpStatus> {
    if (!this.initialized || this.disposed) throw new Error('FRP controller is unavailable')
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

  /** Restart FRP while retaining its private server settings and devices. */
  async reconnect(): Promise<FrpStatus> {
    if (!this.initialized || this.disposed) throw new Error('FRP controller is unavailable')
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

  /** Disable FRP without deleting its explicitly managed component or settings. */
  async reset(): Promise<FrpStatus> {
    if (!this.initialized || this.disposed) throw new Error('FRP controller is unavailable')
    await this.enqueue(async () => {
      await this.options.store.save({ version: 1, enabled: false })
      this.enabled = false
      await this.stop()
      this.publish({ enabled: false, state: 'off' })
    })
    return this.status()
  }

  /** Stop all FRP resources without changing the remembered switch. */
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

  private publish(status: FrpStatus): void {
    this.latest = publicStatus(status)
    try { this.options.onStatus?.(this.status()) } catch { /* UI observation cannot own runtime state. */ }
  }

  private async start(): Promise<void> {
    const generation = ++this.generation
    let executableEntry
    try { executableEntry = await lstat(this.options.executable) } catch {
      this.publish({ enabled: true, state: 'unavailable', errorCode: 'frp_component_missing' })
      return
    }
    if (!executableEntry.isFile() || executableEntry.isSymbolicLink()) {
      this.publish({ enabled: true, state: 'unavailable', errorCode: 'frp_component_invalid' })
      return
    }
    const settings = this.options.config.settings()
    if (settings === undefined) {
      this.publish({ enabled: true, state: 'unavailable', errorCode: 'frp_config_missing' })
      return
    }
    const entryOrigin = frpEntryOrigin(settings)
    this.publish({ enabled: true, state: 'starting', origin: entryOrigin })
    // The plaintext-vhost gate must probe the port the user's frps actually
    // listens on. Probing the hard-coded upstream 7080 would report "not
    // exposed" for a reachable vhost on any other port and let a cleartext
    // session-cookie path through.
    //
    // The self-signed entry is a raw TCP passthrough with no vhost at all, so
    // the probe does not apply: there the equivalent exposure — the public entry
    // port being reachable — is the design itself, and protection comes from the
    // gateway's own device pairing and authentication.
    if (!isFrpSelfSignedIngress(settings)) {
      let exposed: boolean
      try {
        exposed = await (this.options.probeVhostExposure ?? defaultProbeVhostExposure)(
          settings.serverAddress,
          resolveFrpVhostHttpPort(settings),
        )
      } catch {
        this.publish({ enabled: true, state: 'error', origin: entryOrigin, errorCode: 'frp_vhost_probe_failed' })
        return
      }
      if (exposed) {
        this.publish({ enabled: true, state: 'error', origin: entryOrigin, errorCode: 'frp_vhost_publicly_reachable' })
        return
      }
    }
    let gateway: MobileAccessGateway
    try { gateway = await this.options.createGateway(settings.publicOrigin, settings) } catch (error) {
      // Ingress certificate problems carry their own stable code so the panel can
      // explain how to re-issue it instead of showing a generic start failure.
      const code = error instanceof Error && error.message.startsWith('frp_') ? error.message : 'gateway_start_failed'
      this.publish({ enabled: true, state: 'error', origin: entryOrigin, errorCode: code })
      return
    }
    if (generation !== this.generation || !this.enabled) {
      await gateway.close()
      return
    }
    this.gatewayValue = gateway
    let configFile: string
    try {
      configFile = await this.options.config.writeRuntimeConfig(gateway.address().port)
      await (this.options.verifyConfig ?? defaultVerifyConfig)(this.options.executable, configFile)
    } catch {
      await this.failGeneration(generation, 'frp_config_verify_failed')
      return
    }
    if (generation !== this.generation || !this.enabled) return
    let child: ChildProcessWithoutNullStreams
    try { child = (this.options.launchClient ?? defaultLaunchClient)(this.options.executable, configFile) } catch {
      await this.failGeneration(generation, 'frp_launch_failed')
      return
    }
    this.child = child
    // frpc can keep running after a refused proxy registration. Buffer each
    // stream separately so a partial `start error:` chunk cannot hide the more
    // specific name or port conflict later on the same line.
    const pending = { stdout: '', stderr: '' }
    let diagnosed = false
    const inspectLine = (line: string): void => {
      if (diagnosed) return
      const code = frpcDiagnosisCode(line)
      if (code === undefined) return
      diagnosed = true
      void this.enqueue(() => this.failGeneration(generation, code))
    }
    const inspect = (stream: 'stdout' | 'stderr', chunk: Buffer | string): void => {
      if (diagnosed) return
      const lines = (pending[stream] + String(chunk)).split(/\r\n|\r|\n/u)
      pending[stream] = (lines.pop() ?? '').slice(-MAX_CLIENT_DIAGNOSIS_CHARS)
      for (const line of lines) inspectLine(line.slice(-MAX_CLIENT_DIAGNOSIS_CHARS))
    }
    child.stdout.on('data', chunk => inspect('stdout', chunk))
    child.stderr.on('data', chunk => inspect('stderr', chunk))
    child.stdout.resume()
    child.stderr.resume()
    child.once('error', () => { void this.enqueue(() => this.failGeneration(generation, 'frp_launch_failed')) })
    child.once('close', code => {
      inspectLine(pending.stdout)
      inspectLine(pending.stderr)
      if (generation !== this.generation || this.child !== child) return
      this.child = undefined
      if (this.enabled && !diagnosed) void this.enqueue(() => this.failGeneration(generation, code === 0 ? 'frp_stopped' : 'frp_exited'))
    })
    this.publish({ enabled: true, state: 'connecting', origin: entryOrigin })
    // The probe target is derived from the effective entry *before* the abort
    // controller exists, so reading the ingress anchor can never resurrect it
    // after a concurrent stop.
    let check: FrpDiscoveryCheck
    try { check = await this.discoveryCheck(settings) } catch (error) {
      const code = error instanceof Error && error.message.startsWith('frp_')
        ? error.message : 'frp_ingress_ca_invalid'
      await this.failGeneration(generation, code)
      return
    }
    if (generation !== this.generation || !this.enabled) return
    // A conflict reported while the ingress material was being resolved already
    // failed this generation; continuing would overwrite that diagnosis with the
    // generic deadline code.
    if (diagnosed) return
    const controller = new AbortController()
    this.startupAbort = controller
    // The self-check must compare the public advertisement against the identity
    // *this* gateway advertises, never the plugin-wide installation identity.
    // The self-signed ingress gateway is pinned to the ingress CA fingerprint
    // (`frpIngressGatewayConfig`), which is exactly what the app pins from
    // `pairingCaFile`, so the plugin identity can never match there and the
    // channel would only ever end in `frp_start_timeout`. For the public-CA entry
    // both values are equal, so that path is unchanged. `discoveryCheck` supplies
    // the other half of the contract: the port that is actually dialled and, for
    // the self-signed entry, the CA that must anchor the handshake.
    void this.waitForDiscovery(generation, check, gateway.config.instanceId, settings, gateway, controller.signal)
  }

  /**
   * Derive the self-check target and trust anchor for the effective entry.
   *
   * The public-CA entry is reached on the saved origin itself: Caddy terminates
   * TLS on 443 with a publicly trusted certificate, so the probe must keep the
   * system trust store and the origin URL untouched. The self-signed entry is a
   * raw TCP passthrough on `publicPort` whose leaf chains to the ingress CA the
   * app pins from `pairingCaFile`; probing `publicOrigin` there would knock on
   * 443 — where nothing listens — with a chain the system cannot verify. Both
   * facts used to be implicit, and together they kept the channel out of `ready`
   * until `frp_start_timeout`.
   */
  private async discoveryCheck(settings: FrpSettings): Promise<FrpDiscoveryCheck> {
    if (!isFrpSelfSignedIngress(settings)) {
      return { publicOrigin: settings.publicOrigin, targetOrigin: settings.publicOrigin }
    }
    const targetOrigin = frpEntryOrigin(settings)
    const trustAnchorPem = await this.options.resolveDiscoveryTrustAnchor?.(settings)
    if (this.options.resolveDiscoveryTrustAnchor !== undefined && trustAnchorPem === undefined) {
      throw new Error('frp_ingress_ca_invalid')
    }
    return Object.freeze({
      publicOrigin: targetOrigin,
      targetOrigin,
      ...(trustAnchorPem === undefined ? {} : { trustAnchorPem }),
    })
  }

  private async waitForDiscovery(
    generation: number,
    check: FrpDiscoveryCheck,
    advertisedInstanceId: string,
    settings: FrpSettings,
    gateway: MobileAccessGateway,
    signal: AbortSignal,
  ): Promise<void> {
    const deadline = Date.now() + (this.options.startTimeoutMs ?? START_TIMEOUT_MS)
    const probe = this.options.probeDiscovery ?? defaultProbeDiscovery
    const target: FrpDiscoveryProbeTarget = Object.freeze({
      origin: check.targetOrigin,
      ...(check.trustAnchorPem === undefined ? {} : { trustAnchorPem: check.trustAnchorPem }),
    })
    while (!signal.aborted && Date.now() < deadline) {
      try {
        if (await probe(target, advertisedInstanceId, signal)) {
          await this.enqueue(async () => {
            if (generation !== this.generation || signal.aborted || !this.enabled) return
            this.startupAbort = undefined
            this.publish({ enabled: true, state: 'ready', origin: check.publicOrigin })
            this.scheduleIngressCertificateCheck(generation, settings, gateway)
          })
          return
        }
      } catch (error) {
        if (signal.aborted) return
        if (error instanceof Error && (error.message === 'frp_discovery_mismatch' || error.message === 'frp_discovery_invalid')) {
          await this.enqueue(() => this.failGeneration(generation, error.message))
          return
        }
      }
      await new Promise<void>(resolveWait => {
        let finished = false
        const finish = (): void => {
          if (finished) return
          finished = true
          clearTimeout(timer)
          signal.removeEventListener('abort', finish)
          resolveWait()
        }
        const timer = setTimeout(finish, this.options.retryIntervalMs ?? DISCOVERY_RETRY_MS)
        timer.unref()
        signal.addEventListener('abort', finish, { once: true })
      })
    }
    if (!signal.aborted) await this.enqueue(() => this.failGeneration(generation, 'frp_start_timeout'))
  }

  private scheduleIngressCertificateCheck(generation: number, settings: FrpSettings, gateway: MobileAccessGateway): void {
    const maintain = this.options.maintainIngressCertificate
    if (!isFrpSelfSignedIngress(settings) || maintain === undefined) return
    const timer = setTimeout(() => {
      if (this.ingressCertificateTimer !== timer) return
      this.ingressCertificateTimer = undefined
      void this.enqueue(async () => {
        if (generation !== this.generation || !this.enabled || this.disposed || this.gatewayValue !== gateway) return
        try {
          await maintain(settings, gateway)
        } catch (error) {
          const code = error instanceof Error && error.message.startsWith('frp_')
            ? error.message : 'frp_ingress_renewal_failed'
          await this.failGeneration(generation, code)
          return
        }
        if (generation === this.generation && this.enabled && !this.disposed && this.gatewayValue === gateway) {
          this.scheduleIngressCertificateCheck(generation, settings, gateway)
        }
      }).catch(() => {
        if (generation === this.generation && this.enabled && !this.disposed) {
          this.publish({ enabled: true, state: 'error', errorCode: 'frp_ingress_renewal_failed' })
        }
      })
    }, this.options.ingressCertificateCheckMs ?? INGRESS_CERT_CHECK_MS)
    timer.unref()
    this.ingressCertificateTimer = timer
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
    clearTimeout(this.ingressCertificateTimer)
    this.ingressCertificateTimer = undefined
    this.startupAbort?.abort()
    this.startupAbort = undefined
    const child = this.child
    this.child = undefined
    const gateway = this.gatewayValue
    this.gatewayValue = undefined
    await settleRemoteResources([
      () => child !== undefined && child.exitCode === null ? terminateRemoteProcess(child) : undefined,
      () => gateway?.close(),
      () => rm(this.options.config.runtimeConfigFile, { force: true }),
    ], 'FRP resource cleanup failed')
  }
}
