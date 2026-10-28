import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { AccessController, type SessionAuthorization } from '../src/access.js'
import { JsonDeviceStore, MemoryDeviceStore, type DeviceStore, type StoredDevice } from '../src/storage.js'

const directories: string[] = []
const controllers: AccessController[] = []
const now = 1_000_000

function controller(store: DeviceStore, maxDevices = 4): AccessController {
  const access = new AccessController(store, {
    pairingTtlMs: 60_000,
    deviceTtlMs: 3_600_000,
    sessionTtlMs: 30_000,
    maxDevices,
    maxSessions: 8,
    rateLimitWindowMs: 60_000,
    maxPairingAttempts: 8,
    maxRateLimitKeys: 8,
    now: () => now,
  })
  controllers.push(access)
  return access
}

function legacyDevice(id: string, token: string, revokedAt?: number): StoredDevice {
  return {
    id: id.repeat(32),
    label: 'Legacy phone ' + id,
    tokenDigest: createHash('sha256').update(token).digest('hex'),
    createdAt: now - 1_000,
    expiresAt: now + 60_000,
    lastSeenAt: now - 1_000,
    ...(revokedAt === undefined ? {} : { revokedAt }),
  }
}

async function pair(access: AccessController, label: string) {
  const window = await access.openPairing()
  return access.pair('test-source', window.token, label)
}

afterEach(async () => {
  for (const access of controllers.splice(0)) await access.close()
  for (const directory of directories.splice(0)) {
    const withinTemp = relative(tmpdir(), directory)
    if (!withinTemp || withinTemp.startsWith('..') || isAbsolute(withinTemp)) throw new Error('unsafe test cleanup path')
    await rm(directory, { recursive: true, force: true })
  }
})

describe('durable device deletion', () => {
  it('deletes the JSON row and all of its Sessions without affecting another device, including after restart', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-mobile-revoke-'))
    directories.push(directory)
    const file = join(directory, 'devices.json')
    const store = new JsonDeviceStore(file)
    const access = controller(store)
    await access.initialize()
    const removed = await pair(access, 'Phone to remove')
    const kept = await pair(access, 'Phone to keep')
    const renewed = await access.renew(removed.deviceToken)
    const removedRow = (await store.load()).devices.find(device => device.id === removed.deviceId)!
    const ended: Array<{ authorization: SessionAuthorization; reason: string }> = []
    access.onSessionEnded((authorization, reason) => { ended.push({ authorization, reason }) })

    expect(await access.revokeDevice(removed.deviceId)).toBe(true)

    expect((await store.load()).devices.map(device => device.id)).toEqual([kept.deviceId])
    const json = await readFile(file, 'utf8')
    for (const value of [removed.deviceId, removedRow.tokenDigest, removedRow.label, 'revokedAt']) expect(json).not.toContain(value)
    expect(access.listDevices().map(device => device.id)).toEqual([kept.deviceId])
    expect(ended).toHaveLength(2)
    expect(ended.every(event => event.authorization.deviceId === removed.deviceId && event.reason === 'revoked')).toBe(true)
    expect(() => access.authorizeSession(removed.sessionToken)).toThrow()
    expect(() => access.authorizeSession(renewed.sessionToken)).toThrow()
    expect(access.authorizeSession(kept.sessionToken).deviceId).toBe(kept.deviceId)
    await expect(access.renew(removed.deviceToken)).rejects.toMatchObject({ status: 401, code: 'authentication_failed' })
    await expect(access.probe(removed.deviceToken)).rejects.toMatchObject({ status: 401, code: 'authentication_failed' })
    expect(await access.revokeDevice(removed.deviceId)).toBe(false)
    await access.close()

    const restarted = controller(new JsonDeviceStore(file))
    await restarted.initialize()
    expect(restarted.listDevices().map(device => device.id)).toEqual([kept.deviceId])
    await expect(restarted.renew(removed.deviceToken)).rejects.toMatchObject({ status: 401, code: 'authentication_failed' })
    await expect(restarted.probe(removed.deviceToken)).rejects.toMatchObject({ status: 401, code: 'authentication_failed' })
    await expect(restarted.renew(kept.deviceToken)).resolves.toMatchObject({ deviceId: kept.deviceId })
  })

  it('removes legacy revoked rows durably before applying the active-device limit', async () => {
    const removed = legacyDevice('a', 'revoked-token', now - 1)
    const kept = legacyDevice('b', 'kept-token')
    const store = new MemoryDeviceStore({ version: 1, devices: [removed, kept] })
    const access = controller(store, 1)

    await access.initialize()

    expect(store.inspect().devices).toEqual([kept])
    expect(access.listDevices().map(device => device.id)).toEqual([kept.id])
    await expect(access.renew('revoked-token')).rejects.toMatchObject({ status: 401, code: 'authentication_failed' })
    await expect(access.probe('revoked-token')).rejects.toMatchObject({ status: 401, code: 'authentication_failed' })
    await expect(access.renew('kept-token')).resolves.toMatchObject({ deviceId: kept.id })
    const restarted = controller(store, 1)
    await restarted.initialize()
    expect(restarted.listDevices().map(device => device.id)).toEqual([kept.id])
  })

  it('persists legacy JSON cleanup rather than just filtering the desktop list', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-mobile-revoke-legacy-'))
    directories.push(directory)
    const file = join(directory, 'devices.json')
    const store = new JsonDeviceStore(file)
    const removed = legacyDevice('a', 'revoked-token', now - 1)
    const kept = legacyDevice('b', 'kept-token')
    await writeFile(file, JSON.stringify({ version: 1, devices: [removed, kept] }), { mode: 0o600 })
    expect(await store.load()).toEqual({ version: 1, devices: [removed, kept] })
    const access = controller(store)
    await access.initialize()
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({ version: 2, devices: [kept] })
    expect(await new JsonDeviceStore(file).load()).toEqual({ version: 2, devices: [kept] })
  })

  it('preserves a native identity binding through JSON writes and removes it with its credential', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-mobile-native-identity-'))
    directories.push(directory)
    const file = join(directory, 'devices.json')
    const bound = { ...legacyDevice('a', 'bound-token'), nativeInstanceId: 'c'.repeat(64) }
    const legacy = legacyDevice('b', 'legacy-token')
    const store = new JsonDeviceStore(file)
    await store.save({ version: 1, devices: [legacy] })
    expect(await store.load()).toEqual({ version: 2, devices: [legacy] })
    await store.save({ version: 1, devices: [bound, legacy] })
    expect(await new JsonDeviceStore(file).load()).toEqual({ version: 2, devices: [bound, legacy] })

    const access = controller(new JsonDeviceStore(file))
    await access.initialize()
    expect((await access.renew('bound-token')).nativeInstanceId).toBe(bound.nativeInstanceId)
    expect((await access.probe('bound-token')).nativeInstanceId).toBe(bound.nativeInstanceId)
    expect((await store.load()).devices.find(device => device.id === bound.id)?.nativeInstanceId).toBe(bound.nativeInstanceId)
    await access.revokeDevice(bound.id)
    expect(await store.load()).toEqual({ version: 2, devices: [legacy] })
    expect(await readFile(file, 'utf8')).not.toContain(bound.nativeInstanceId)
  })

  it('keeps non-revoked records unchanged and rejects a real device-limit overflow before writing', async () => {
    const first = legacyDevice('a', 'first-token')
    const second = legacyDevice('b', 'second-token')
    const backing = new MemoryDeviceStore({ version: 1, devices: [first, second] })
    let saves = 0
    const store: DeviceStore = {
      load: () => backing.load(),
      async save(snapshot) { saves += 1; await backing.save(snapshot) },
    }
    await controller(store).initialize()
    expect(saves).toBe(0)
    await expect(controller(store, 1).initialize()).rejects.toThrow('maxDevices')
    expect(saves).toBe(0)
    expect(backing.inspect().devices).toEqual([first, second])
  })

  it('does not publish deletion or end Sessions when durable storage rejects the write', async () => {
    const backing = new MemoryDeviceStore()
    let rejectSave = false
    let saves = 0
    const store: DeviceStore = {
      load: () => backing.load(),
      async save(snapshot) {
        saves += 1
        if (rejectSave) throw new Error('disk full')
        await backing.save(snapshot)
      },
    }
    const access = controller(store)
    await access.initialize()
    const paired = await pair(access, 'Phone')
    const before = backing.inspect()
    const ended: string[] = []
    access.onSessionEnded((_authorization, reason) => { ended.push(reason) })
    rejectSave = true

    await expect(access.revokeDevice(paired.deviceId)).rejects.toThrow('disk full')
    expect(backing.inspect()).toEqual(before)
    expect(access.listDevices().map(device => device.id)).toEqual([paired.deviceId])
    expect(access.authorizeSession(paired.sessionToken).deviceId).toBe(paired.deviceId)
    expect(ended).toEqual([])

    rejectSave = false
    expect(await access.revokeDevice(paired.deviceId)).toBe(true)
    expect(backing.inspect().devices).toEqual([])
    expect(ended).toEqual(['revoked'])
    const savesAfterDelete = saves
    expect(await access.revokeDevice(paired.deviceId)).toBe(false)
    expect(await access.revokeDevice('f'.repeat(32))).toBe(false)
    expect(saves).toBe(savesAfterDelete)
  })

  it('fails initialization closed if legacy cleanup cannot be persisted, and can retry', async () => {
    const removed = legacyDevice('a', 'revoked-token', now - 1)
    const backing = new MemoryDeviceStore({ version: 1, devices: [removed] })
    let rejectSave = true
    const access = controller({
      load: () => backing.load(),
      async save(snapshot) {
        if (rejectSave) throw new Error('disk full')
        await backing.save(snapshot)
      },
    })
    await expect(access.initialize()).rejects.toThrow('disk full')
    expect(() => access.listDevices()).toThrow('not available')
    expect(backing.inspect().devices).toEqual([removed])
    rejectSave = false
    await access.initialize()
    expect(backing.inspect().devices).toEqual([])
    expect(access.listDevices()).toEqual([])
  })

  it('serializes deletion with renewals so queued work cannot recreate a deleted row', async () => {
    const store = new MemoryDeviceStore()
    const access = controller(store)
    await access.initialize()
    const paired = await pair(access, 'Phone')

    const [renewed, revoked, lateRenewal] = await Promise.allSettled([
      access.renew(paired.deviceToken),
      access.revokeDevice(paired.deviceId),
      access.renew(paired.deviceToken),
    ])

    expect(renewed.status).toBe('fulfilled')
    expect(revoked).toEqual({ status: 'fulfilled', value: true })
    expect(lateRenewal).toMatchObject({ status: 'rejected', reason: { status: 401, code: 'authentication_failed' } })
    expect(store.inspect().devices).toEqual([])
    expect(access.metrics().sessions).toBe(0)
    if (renewed.status === 'fulfilled') expect(() => access.authorizeSession(renewed.value.sessionToken)).toThrow()
  })
})
