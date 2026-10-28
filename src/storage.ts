import { lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { restrictPrivateFile } from './private-file.js'

/** Persistent record containing only a digest of the long-lived device credential. */
export interface StoredDevice {
  readonly id: string
  readonly label: string
  readonly tokenDigest: string
  readonly createdAt: number
  readonly expiresAt: number
  readonly lastSeenAt: number
  /** Native pairing identity bound to this credential; older records omit it. */
  readonly nativeInstanceId?: string
  /** Legacy tombstone accepted on load; AccessController removes it during initialization. */
  readonly revokedAt?: number
}

/** Versioned device state. Raw device and Session credentials are never members. */
export interface DeviceSnapshot {
  readonly version: 1 | 2
  readonly devices: readonly StoredDevice[]
}

/** Persistence seam for device-token digests and revocation metadata. */
export interface DeviceStore {
  /** Read either supported version without assigning identities to legacy rows. */
  load(): Promise<DeviceSnapshot>
  /** Validate and persist version 2, retaining any credential identity bindings. */
  save(snapshot: DeviceSnapshot): Promise<void>
}

function assertInteger(value: unknown, name: string): asserts value is number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`device state ${name} must be a non-negative integer`)
  }
}

function parseDevice(value: unknown): StoredDevice {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('device state contains an invalid device')
  const record = value as Record<string, unknown>
  if (typeof record.id !== 'string' || !/^[a-f\d]{32}$/u.test(record.id)) throw new Error('device state contains an invalid id')
  if (typeof record.label !== 'string' || record.label.length < 1 || record.label.length > 64 || /[\u0000-\u001f\u007f]/u.test(record.label)) {
    throw new Error('device state contains an invalid label')
  }
  if (typeof record.tokenDigest !== 'string' || !/^[a-f\d]{64}$/u.test(record.tokenDigest)) {
    throw new Error('device state contains an invalid credential digest')
  }
  if (record.nativeInstanceId !== undefined
    && (typeof record.nativeInstanceId !== 'string' || !/^[a-f\d]{64}$/u.test(record.nativeInstanceId))) {
    throw new Error('device state contains an invalid native instance id')
  }
  assertInteger(record.createdAt, 'createdAt')
  assertInteger(record.expiresAt, 'expiresAt')
  assertInteger(record.lastSeenAt, 'lastSeenAt')
  if (record.revokedAt !== undefined) assertInteger(record.revokedAt, 'revokedAt')
  if (record.expiresAt <= record.createdAt || record.lastSeenAt < record.createdAt) {
    throw new Error('device state contains inconsistent timestamps')
  }
  return Object.freeze({
    id: record.id,
    label: record.label,
    tokenDigest: record.tokenDigest,
    createdAt: record.createdAt,
    expiresAt: record.expiresAt,
    lastSeenAt: record.lastSeenAt,
    ...(record.nativeInstanceId === undefined ? {} : { nativeInstanceId: record.nativeInstanceId }),
    ...(record.revokedAt === undefined ? {} : { revokedAt: record.revokedAt }),
  })
}

/** Validate durable data before it can authorize a device. */
export function parseDeviceSnapshot(value: unknown, maximumDevices = 256): DeviceSnapshot {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('device state must be an object')
  const snapshot = value as Record<string, unknown>
  if ((snapshot.version !== 1 && snapshot.version !== 2)
    || !Array.isArray(snapshot.devices) || snapshot.devices.length > maximumDevices) {
    throw new Error('device state has an unsupported version or device count')
  }
  const devices = snapshot.devices.map(parseDevice)
  if (new Set(devices.map(device => device.id)).size !== devices.length
    || new Set(devices.map(device => device.tokenDigest)).size !== devices.length) {
    throw new Error('device state contains duplicate device identities')
  }
  return Object.freeze({ version: snapshot.version, devices: Object.freeze(devices) })
}

function snapshotForSave(snapshot: DeviceSnapshot, maximumDevices?: number): DeviceSnapshot {
  const validated = parseDeviceSnapshot(snapshot, maximumDevices)
  return Object.freeze({ version: 2, devices: validated.devices })
}

/** Atomic JSON implementation with symlink refusal and owner-only file creation. */
export class JsonDeviceStore implements DeviceStore {
  constructor(private readonly file: string, private readonly maximumDevices = 256) {}

  async load(): Promise<DeviceSnapshot> {
    let stat
    try {
      stat = await lstat(this.file)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return Object.freeze({ version: 1, devices: Object.freeze([]) })
      throw error
    }
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024) {
      throw new Error('device state must be a regular file no larger than 1 MiB')
    }
    await restrictPrivateFile(this.file)
    let parsed: unknown
    try {
      parsed = JSON.parse(await readFile(this.file, 'utf8')) as unknown
    } catch (error) {
      throw new Error('device state is not valid JSON', { cause: error })
    }
    return parseDeviceSnapshot(parsed, this.maximumDevices)
  }

  async save(snapshot: DeviceSnapshot): Promise<void> {
    const validated = snapshotForSave(snapshot, this.maximumDevices)
    const directory = dirname(this.file)
    await mkdir(directory, { recursive: true, mode: 0o700 })
    try {
      const current = await lstat(this.file)
      if (!current.isFile() || current.isSymbolicLink()) throw new Error('device state target must remain a regular file')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    const temporary = join(directory, `.${basename(this.file)}.${randomBytes(12).toString('hex')}.tmp`)
    try {
      await writeFile(temporary, `${JSON.stringify(validated)}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 })
      await rename(temporary, this.file)
      await restrictPrivateFile(this.file)
    } catch (error) {
      try {
        await rm(temporary, { force: true })
      } catch (cleanupError) {
        throw new AggregateError([error, cleanupError], 'device state write and temporary cleanup both failed')
      }
      throw error
    }
  }
}

/** In-memory store useful for embedding and deterministic tests. */
export class MemoryDeviceStore implements DeviceStore {
  private snapshot: DeviceSnapshot

  constructor(initial: DeviceSnapshot = { version: 1, devices: [] }) {
    this.snapshot = parseDeviceSnapshot(initial)
  }

  async load(): Promise<DeviceSnapshot> {
    return structuredClone(this.snapshot)
  }

  async save(snapshot: DeviceSnapshot): Promise<void> {
    this.snapshot = structuredClone(snapshotForSave(snapshot))
  }

  /** Return a defensive copy for assertions or administrative export. */
  inspect(): DeviceSnapshot {
    return structuredClone(this.snapshot)
  }
}
