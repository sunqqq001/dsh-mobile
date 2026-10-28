import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import type { DeviceSnapshot, DeviceStore, StoredDevice } from './storage.js'

/** Stable error categories converted to deliberately terse HTTP responses. */
export class AccessError extends Error {
  constructor(readonly status: number, readonly code: string) {
    super(code)
    this.name = 'AccessError'
  }
}

/** Resource and lifetime controls for device authentication. */
export interface AccessControllerOptions {
  readonly pairingTtlMs: number
  readonly deviceTtlMs: number
  readonly sessionTtlMs: number
  readonly maxDevices: number
  readonly maxSessions: number
  readonly rateLimitWindowMs: number
  readonly maxPairingAttempts: number
  readonly maxRateLimitKeys: number
  /** Native identity stored with newly paired device credentials. */
  readonly pairingInstanceId?: string
  /** Native response identity for older credentials without a stored binding. */
  readonly legacyInstanceId?: string
  readonly now?: () => number
}

/** Values issued once after pairing; only digests survive the response. */
export interface PairingResult {
  readonly nativeInstanceId?: string
  readonly deviceId: string
  readonly deviceToken: string
  readonly deviceExpiresAt: number
  readonly sessionToken: string
  readonly csrfToken: string
  readonly sessionExpiresAt: number
}

/** Values issued after renewal with the persistent HttpOnly device Cookie. */
export interface RenewalResult {
  readonly nativeInstanceId?: string
  readonly deviceId: string
  readonly sessionToken: string
  readonly csrfToken: string
  readonly sessionExpiresAt: number
}

/** Authenticated Session identity retained only inside the gateway. */
export interface SessionAuthorization {
  readonly sessionKey: string
  readonly deviceId: string
  readonly expiresAt: number
}

/** Result of a persistent-device reachability check without opening a Session. */
export interface DeviceProbeResult {
  readonly nativeInstanceId?: string
  readonly deviceId: string
  readonly deviceExpiresAt: number
}

/** Why a short-lived Session ended; only device revocation is sent to clients. */
export type SessionEndReason = 'logout' | 'expired' | 'evicted' | 'revoked'

/** Safe device metadata returned by the loopback administration API. */
export interface DeviceSummary {
  readonly id: string
  readonly label: string
  readonly createdAt: number
  readonly expiresAt: number
  readonly lastSeenAt: number
  readonly revokedAt?: number
}

interface PairingWindow {
  readonly digest: Buffer
  readonly expiresAt: number
}

interface SessionRecord {
  readonly key: string
  readonly deviceId: string
  readonly csrfDigest: Buffer
  readonly createdAt: number
  readonly expiresAt: number
}

interface LimitBucket {
  count: number
  resetAt: number
}

/** Fixed-window limiter whose attacker-controlled key table is itself bounded. */
export class BoundedRateLimiter {
  private readonly buckets = new Map<string, LimitBucket>()

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
    private readonly maximumKeys: number,
  ) {}

  /** Consume one attempt; unknown keys fail closed when the bounded table is full. */
  take(key: string, now: number): boolean {
    for (const [candidate, bucket] of this.buckets) {
      if (bucket.resetAt <= now) this.buckets.delete(candidate)
    }
    const current = this.buckets.get(key)
    if (current === undefined) {
      if (this.buckets.size >= this.maximumKeys) return false
      this.buckets.set(key, { count: 1, resetAt: now + this.windowMs })
      return true
    }
    if (current.count >= this.limit) return false
    current.count += 1
    return true
  }

  /** Discard entries that no longer identify an eligible key in a trusted, finite key set. */
  retainKeys(eligible: ReadonlySet<string>): void {
    for (const key of this.buckets.keys()) {
      if (!eligible.has(key)) this.buckets.delete(key)
    }
  }

  /** Current table size, exposed for bounded-state assertions. */
  get size(): number {
    return this.buckets.size
  }
}

function opaqueToken(): string {
  return randomBytes(32).toString('base64url')
}

function digest(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest()
}

function digestHex(value: string): string {
  return digest(value).toString('hex')
}

function matchesDigest(value: string, expected: Buffer): boolean {
  return timingSafeEqual(digest(value), expected)
}

function normalizeLabel(value: string | undefined): string {
  const label = (value ?? 'Mobile device').normalize('NFC').trim()
  if (label.length < 1 || label.length > 64 || /[\u0000-\u001f\u007f]/u.test(label)) {
    throw new AccessError(400, 'invalid_request')
  }
  return label
}

function publicDevice(device: StoredDevice): DeviceSummary {
  return Object.freeze({
    id: device.id,
    label: device.label,
    createdAt: device.createdAt,
    expiresAt: device.expiresAt,
    lastSeenAt: device.lastSeenAt,
    ...(device.revokedAt === undefined ? {} : { revokedAt: device.revokedAt }),
  })
}

/** Pairing, persistent-device, short-Session, revocation, and CSRF state machine. */
export class AccessController {
  private readonly now: () => number
  private readonly pairLimiter: BoundedRateLimiter
  private devices: StoredDevice[] = []
  private pairingWindow: PairingWindow | undefined
  private pairPending = false
  private readonly sessions = new Map<string, SessionRecord>()
  private readonly sessionEndedListeners = new Set<(authorization: SessionAuthorization, reason: SessionEndReason) => void>()
  private mutation: Promise<void> = Promise.resolve()
  private initialized = false
  private closing = false
  private closeTask: Promise<void> | undefined

  constructor(private readonly store: DeviceStore, private readonly options: AccessControllerOptions) {
    this.now = options.now ?? Date.now
    this.pairLimiter = new BoundedRateLimiter(
      options.maxPairingAttempts,
      options.rateLimitWindowMs,
      options.maxRateLimitKeys,
    )
  }

  /** Load and validate digest-only durable state before accepting traffic. */
  async initialize(): Promise<void> {
    if (this.initialized || this.closing) throw new Error('access controller cannot be initialized again')
    const snapshot = await this.store.load()
    // Older releases retained revoked identities. Remove those tombstones on upgrade.
    const devices = snapshot.devices.filter(device => device.revokedAt === undefined)
    if (devices.length > this.options.maxDevices) throw new Error('device state exceeds configured maxDevices')
    if (devices.length !== snapshot.devices.length) await this.store.save(this.snapshot(devices))
    this.devices = devices
    this.initialized = true
  }

  private requireInitialized(): void {
    if (!this.initialized || this.closing) throw new Error('access controller is not available')
  }

  private async exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const prior = this.mutation
    let release!: () => void
    this.mutation = new Promise<void>(resolve => { release = resolve })
    await prior
    try {
      return await operation()
    } finally {
      release()
    }
  }

  private snapshot(devices: readonly StoredDevice[]): DeviceSnapshot {
    return Object.freeze({ version: 2, devices: Object.freeze([...devices]) })
  }

  private nativeIdentity(device: StoredDevice): Pick<DeviceProbeResult, 'nativeInstanceId'> {
    const nativeInstanceId = device.nativeInstanceId ?? this.options.legacyInstanceId ?? this.options.pairingInstanceId
    return nativeInstanceId === undefined ? {} : { nativeInstanceId }
  }

  private emitSessionEnded(session: SessionRecord, reason: SessionEndReason): void {
    const authorization = Object.freeze({
      sessionKey: session.key,
      deviceId: session.deviceId,
      expiresAt: session.expiresAt,
    })
    for (const listener of this.sessionEndedListeners) listener(authorization, reason)
  }

  private removeSession(key: string, reason: SessionEndReason): void {
    const session = this.sessions.get(key)
    if (session === undefined) return
    this.sessions.delete(key)
    this.emitSessionEnded(session, reason)
  }

  private pruneSessions(now: number): void {
    for (const [key, session] of this.sessions) {
      if (session.expiresAt <= now) this.removeSession(key, 'expired')
    }
  }

  private createSession(device: StoredDevice, now: number): RenewalResult {
    this.pruneSessions(now)
    if (this.sessions.size >= this.options.maxSessions) {
      const oldest = [...this.sessions.values()].sort((left, right) => left.createdAt - right.createdAt)[0]
      if (oldest !== undefined) this.removeSession(oldest.key, 'evicted')
    }
    const sessionToken = opaqueToken()
    const csrfToken = opaqueToken()
    const key = digestHex(sessionToken)
    const record: SessionRecord = Object.freeze({
      key,
      deviceId: device.id,
      csrfDigest: digest(csrfToken),
      createdAt: now,
      expiresAt: Math.min(now + this.options.sessionTtlMs, device.expiresAt),
    })
    this.sessions.set(key, record)
    return Object.freeze({
      ...this.nativeIdentity(device),
      deviceId: device.id,
      sessionToken,
      csrfToken,
      sessionExpiresAt: record.expiresAt,
    })
  }

  /** Open one short pairing window and return its one-time secret to a loopback caller only. */
  async openPairing(requestedTtlMs?: number): Promise<{ token: string; expiresAt: number }> {
    this.requireInitialized()
    return this.exclusive(async () => {
      const ttl = requestedTtlMs ?? this.options.pairingTtlMs
      if (!Number.isSafeInteger(ttl) || ttl < 10_000 || ttl > this.options.pairingTtlMs) {
        throw new AccessError(400, 'invalid_request')
      }
      const token = opaqueToken()
      const expiresAt = this.now() + ttl
      this.pairingWindow = Object.freeze({ digest: digest(token), expiresAt })
      return Object.freeze({ token, expiresAt })
    })
  }

  /** Limit invalid guesses by peer without letting them consume a valid one-time secret's admission. */
  private rejectPairingAttempt(sourceKey: string, now: number): never {
    if (!this.pairLimiter.take(sourceKey, now)) throw new AccessError(429, 'rate_limited')
    throw new AccessError(401, 'authentication_failed')
  }

  /** Consume the pairing window exactly once and persist only the device-token digest. */
  async pair(sourceKey: string, token: string, label?: string): Promise<PairingResult> {
    this.requireInitialized()
    const initialNow = this.now()
    const initialWindow = this.pairingWindow
    // Reject unknown guesses before the serialized mutation queue. A candidate
    // is checked again inside it because another pairing or opening can replace
    // the one-time window while this request waits.
    if (token.length > 512 || initialWindow === undefined || initialWindow.expiresAt <= initialNow
      || !matchesDigest(token, initialWindow.digest)) {
      this.rejectPairingAttempt(sourceKey, initialNow)
    }
    if (this.pairPending) throw new AccessError(429, 'rate_limited')
    this.pairPending = true
    try {
      return await this.exclusive(async () => {
        const now = this.now()
        const window = this.pairingWindow
        if (window === undefined || window.expiresAt <= now || !matchesDigest(token, window.digest)) {
          if (window !== undefined && window.expiresAt <= now) this.pairingWindow = undefined
          this.rejectPairingAttempt(sourceKey, now)
        }
        this.pairingWindow = undefined
        const active = this.devices.filter(device => device.revokedAt === undefined && device.expiresAt > now)
        if (active.length >= this.options.maxDevices) throw new AccessError(409, 'device_limit')

        const deviceToken = opaqueToken()
        const device: StoredDevice = Object.freeze({
          id: randomBytes(16).toString('hex'),
          label: normalizeLabel(label),
          tokenDigest: digestHex(deviceToken),
          createdAt: now,
          expiresAt: now + this.options.deviceTtlMs,
          lastSeenAt: now,
          ...(this.options.pairingInstanceId === undefined ? {} : { nativeInstanceId: this.options.pairingInstanceId }),
        })
        const retained = this.devices.filter(candidate => candidate.revokedAt === undefined && candidate.expiresAt > now)
        const next = [...retained, device]
        await this.store.save(this.snapshot(next))
        this.devices = next
        const session = this.createSession(device, now)
        return Object.freeze({
          ...session,
          deviceToken,
          deviceExpiresAt: device.expiresAt,
        })
      })
    } finally {
      this.pairPending = false
    }
  }

  /** Exchange a valid persistent device credential for a new short Session. */
  async renew(deviceToken: string): Promise<RenewalResult> {
    this.requireInitialized()
    return this.exclusive(async () => {
      const now = this.now()
      const device = this.requireDevice(deviceToken, now)
      const index = this.devices.indexOf(device)
      const updated: StoredDevice = Object.freeze({ ...device, lastSeenAt: now })
      const next = [...this.devices]
      next[index] = updated
      await this.store.save(this.snapshot(next))
      this.devices = next
      return this.createSession(device, now)
    })
  }

  /** Validate a persistent device credential without consuming a Session slot. */
  async probe(deviceToken: string): Promise<DeviceProbeResult> {
    this.requireInitialized()
    return this.exclusive(async () => {
      const now = this.now()
      const device = this.requireDevice(deviceToken, now)
      const index = this.devices.indexOf(device)
      const updated: StoredDevice = Object.freeze({ ...device, lastSeenAt: now })
      const next = [...this.devices]
      next[index] = updated
      await this.store.save(this.snapshot(next))
      this.devices = next
      return Object.freeze({ ...this.nativeIdentity(device), deviceId: device.id, deviceExpiresAt: device.expiresAt })
    })
  }

  /** Validate a device credential without writing state or opening a Session. */
  authorizeDevice(deviceToken: string): DeviceProbeResult {
    this.requireInitialized()
    const device = this.requireDevice(deviceToken, this.now())
    return Object.freeze({ ...this.nativeIdentity(device), deviceId: device.id, deviceExpiresAt: device.expiresAt })
  }

  private requireDevice(deviceToken: string, now: number): StoredDevice {
    if (deviceToken.length > 512) throw new AccessError(401, 'authentication_failed')
    const tokenDigest = digest(deviceToken)
    const device = this.devices.find(candidate => timingSafeEqual(Buffer.from(candidate.tokenDigest, 'hex'), tokenDigest))
    if (device === undefined) throw new AccessError(401, 'authentication_failed')
    if (device.revokedAt !== undefined) throw new AccessError(401, 'device_revoked')
    if (device.expiresAt <= now) throw new AccessError(401, 'device_expired')
    return device
  }

  /** Resolve a short Session Cookie without revealing whether device or Session failed. */
  authorizeSession(sessionToken: string): SessionAuthorization {
    this.requireInitialized()
    if (sessionToken.length > 512) throw new AccessError(401, 'authentication_failed')
    const now = this.now()
    this.pruneSessions(now)
    const key = digestHex(sessionToken)
    const session = this.sessions.get(key)
    const device = session === undefined ? undefined : this.devices.find(candidate => candidate.id === session.deviceId)
    if (session === undefined || device === undefined || device.revokedAt !== undefined || device.expiresAt <= now) {
      if (session !== undefined) this.removeSession(session.key, 'expired')
      throw new AccessError(401, 'authentication_failed')
    }
    return Object.freeze({ sessionKey: key, deviceId: session.deviceId, expiresAt: session.expiresAt })
  }

  /** Require the Session-bound anti-CSRF value for an authenticated mutation. */
  assertCsrf(authorization: SessionAuthorization, csrfToken: string | undefined): void {
    const session = this.sessions.get(authorization.sessionKey)
    if (session === undefined || csrfToken === undefined || csrfToken.length > 512
      || !matchesDigest(csrfToken, session.csrfDigest)) {
      throw new AccessError(403, 'forbidden')
    }
  }

  /** End one short Session and notify the gateway to abort its attached work. */
  logout(authorization: SessionAuthorization): void {
    this.removeSession(authorization.sessionKey, 'logout')
  }

  /** Durably delete the device, then end every Session owned by that device. */
  async revokeDevice(deviceId: string): Promise<boolean> {
    this.requireInitialized()
    return this.exclusive(async () => {
      const next = this.devices.filter(device => device.id !== deviceId)
      if (next.length === this.devices.length) return false
      await this.store.save(this.snapshot(next))
      this.devices = next
      for (const [key, session] of this.sessions) {
        if (session.deviceId === deviceId) this.removeSession(key, 'revoked')
      }
      return true
    })
  }

  /** Remove every persistent credential and terminate every active Session. */
  async resetDevices(): Promise<void> {
    this.requireInitialized()
    await this.exclusive(async () => {
      await this.store.save(this.snapshot([]))
      this.devices = []
      for (const key of [...this.sessions.keys()]) this.removeSession(key, 'revoked')
      this.pairingWindow = undefined
    })
  }

  /** Safe metadata for the loopback administration surface. */
  listDevices(): readonly DeviceSummary[] {
    this.requireInitialized()
    return Object.freeze(this.devices.map(publicDevice))
  }

  /** Pairing status without exposing the one-time secret. */
  pairingStatus(): { open: boolean; expiresAt?: number } {
    this.requireInitialized()
    const window = this.pairingWindow
    if (window === undefined || window.expiresAt <= this.now()) {
      this.pairingWindow = undefined
      return Object.freeze({ open: false })
    }
    return Object.freeze({ open: true, expiresAt: window.expiresAt })
  }

  /** Subscribe gateway resources to Session logout, expiry, eviction, and device revocation. */
  onSessionEnded(listener: (authorization: SessionAuthorization, reason: SessionEndReason) => void): () => void {
    this.sessionEndedListeners.add(listener)
    return () => { this.sessionEndedListeners.delete(listener) }
  }

  /** Stop new operations, drain durable mutations, then clear volatile credentials. */
  close(): Promise<void> {
    if (this.closeTask !== undefined) return this.closeTask
    this.closing = true
    this.closeTask = this.finishClose()
    return this.closeTask
  }

  private async finishClose(): Promise<void> {
    await this.mutation
    this.pairingWindow = undefined
    for (const key of [...this.sessions.keys()]) this.removeSession(key, 'expired')
    this.sessionEndedListeners.clear()
    this.initialized = false
  }

  /** Bounded volatile-state metrics for tests and local status. */
  metrics(): { sessions: number; rateLimitKeys: number } {
    return Object.freeze({ sessions: this.sessions.size, rateLimitKeys: this.pairLimiter.size })
  }
}
