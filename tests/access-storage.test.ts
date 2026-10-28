import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { AccessController, AccessError, BoundedRateLimiter } from '../src/access.js'
import { MemoryDeviceStore, parseDeviceSnapshot, type DeviceSnapshot, type DeviceStore } from '../src/storage.js'

function controller(store: DeviceStore, now: () => number, overrides: Partial<ConstructorParameters<typeof AccessController>[1]> = {}): AccessController {
  return new AccessController(store, {
    pairingTtlMs: 60_000,
    deviceTtlMs: 3_600_000,
    sessionTtlMs: 30_000,
    maxDevices: 4,
    maxSessions: 4,
    rateLimitWindowMs: 60_000,
    maxPairingAttempts: 4,
    maxRateLimitKeys: 4,
    now,
    ...overrides,
  })
}

function legacySnapshot(token: string): DeviceSnapshot {
  return {
    version: 1,
    devices: [{
      id: 'a'.repeat(32),
      label: 'Legacy phone',
      tokenDigest: createHash('sha256').update(token).digest('hex'),
      createdAt: 1_000,
      expiresAt: 120_000,
      lastSeenAt: 1_000,
    }],
  }
}

describe('device and Session state', () => {
  it('validates a persistent credential without changing last-seen state or opening a Session', async () => {
    let current = 10_000
    const store = new MemoryDeviceStore()
    const access = controller(store, () => current)
    await access.initialize()
    const opened = await access.openPairing()
    const paired = await access.pair('source', opened.token)
    const durable = store.inspect()
    const sessions = access.metrics().sessions
    current += 1_000
    expect(access.authorizeDevice(paired.deviceToken)).toEqual({ deviceId: paired.deviceId, deviceExpiresAt: paired.deviceExpiresAt })
    expect(store.inspect()).toEqual(durable)
    expect(access.metrics().sessions).toBe(sessions)
    expect(() => access.authorizeDevice('unknown')).toThrow(AccessError)
    current = paired.deviceExpiresAt
    expect(() => access.authorizeDevice(paired.deviceToken)).toThrow(AccessError)
    await access.close()
  })

  it('persists only a device digest and consumes pairing exactly once', async () => {
    let current = 1_000_000
    const store = new MemoryDeviceStore()
    const access = controller(store, () => current)
    await access.initialize()
    const opened = await access.openPairing()
    const [first, second] = await Promise.allSettled([
      access.pair('192.168.1.3', opened.token, 'Phone'),
      access.pair('192.168.1.3', opened.token, 'Phone'),
    ])
    const successful = [first, second].find(result => result.status === 'fulfilled')
    const failed = [first, second].find(result => result.status === 'rejected')
    expect(successful?.status).toBe('fulfilled')
    expect(failed?.status).toBe('rejected')
    if (successful?.status !== 'fulfilled') throw new Error('pairing did not succeed')
    const durable = JSON.stringify(store.inspect())
    expect(durable).not.toContain(opened.token)
    expect(durable).not.toContain(successful.value.deviceToken)
    expect(store.inspect().devices[0]?.tokenDigest).toMatch(/^[a-f\d]{64}$/)
    expect(successful.value).not.toHaveProperty('nativeInstanceId')
    expect(store.inspect().devices[0]).not.toHaveProperty('nativeInstanceId')
    expect(store.inspect().version).toBe(2)

    const authorization = access.authorizeSession(successful.value.sessionToken)
    expect(() => access.assertCsrf(authorization, 'wrong')).toThrowError(AccessError)
    expect(() => access.assertCsrf(authorization, successful.value.csrfToken)).not.toThrow()

    current += 1_000
    const reloaded = controller(store, () => current)
    await reloaded.initialize()
    const renewed = await reloaded.renew(successful.value.deviceToken)
    expect(renewed).not.toHaveProperty('nativeInstanceId')
    expect(reloaded.authorizeSession(renewed.sessionToken).deviceId).toBe(successful.value.deviceId)
  })

  it('expires Sessions, logs out one Session, and revokes every Session for a device', async () => {
    let current = 5_000
    const access = controller(new MemoryDeviceStore(), () => current, { sessionTtlMs: 1_000 })
    const ended: string[] = []
    access.onSessionEnded((_authorization, reason) => { ended.push(reason) })
    await access.initialize()
    const opened = await access.openPairing()
    const paired = await access.pair('source', opened.token)
    const authorization = access.authorizeSession(paired.sessionToken)
    access.logout(authorization)
    expect(() => access.authorizeSession(paired.sessionToken)).toThrowError(AccessError)

    const renewed = await access.renew(paired.deviceToken)
    current += 1_001
    expect(() => access.authorizeSession(renewed.sessionToken)).toThrowError(AccessError)

    current += 1
    const again = await access.renew(paired.deviceToken)
    expect(await access.revokeDevice(paired.deviceId)).toBe(true)
    expect(ended).toContain('revoked')
    expect(() => access.authorizeSession(again.sessionToken)).toThrowError(AccessError)
    await expect(access.renew(paired.deviceToken)).rejects.toMatchObject({ status: 401, code: 'authentication_failed' })
  })

  it('distinguishes an expired device from a deleted, no-longer-known credential', async () => {
    let current = 20_000
    const access = controller(new MemoryDeviceStore(), () => current, { deviceTtlMs: 1_000 })
    await access.initialize()
    const firstWindow = await access.openPairing()
    const first = await access.pair('source-a', firstWindow.token)
    current = 21_001
    await expect(access.renew(first.deviceToken)).rejects.toMatchObject({ status: 401, code: 'device_expired' })

    current = 30_000
    const secondWindow = await access.openPairing()
    const second = await access.pair('source-b', secondWindow.token)
    await access.revokeDevice(second.deviceId)
    await expect(access.renew(second.deviceToken)).rejects.toMatchObject({ status: 401, code: 'authentication_failed' })
  })

  it('probes a device without creating a short-lived Session', async () => {
    let current = 25_000
    const access = controller(new MemoryDeviceStore(), () => current)
    await access.initialize()
    const opened = await access.openPairing()
    const paired = await access.pair('source', opened.token)
    const before = access.metrics().sessions

    const result = await access.probe(paired.deviceToken)

    expect(result).toMatchObject({ deviceId: paired.deviceId, deviceExpiresAt: paired.deviceExpiresAt })
    expect(access.metrics().sessions).toBe(before)
    await access.revokeDevice(paired.deviceId)
    await expect(access.probe(paired.deviceToken)).rejects.toMatchObject({ status: 401, code: 'authentication_failed' })
  })

  it('caps a renewed Session at the persistent device expiry', async () => {
    let current = 30_000
    const access = controller(new MemoryDeviceStore(), () => current, {
      deviceTtlMs: 2_000,
      sessionTtlMs: 1_500,
    })
    await access.initialize()
    const opened = await access.openPairing()
    const paired = await access.pair('source', opened.token)
    current += 1_500

    const renewed = await access.renew(paired.deviceToken)
    expect(renewed.sessionExpiresAt).toBe(32_000)
    current = renewed.sessionExpiresAt
    expect(() => access.authorizeSession(renewed.sessionToken)).toThrowError(AccessError)
  })

  it('bounds Session eviction and attacker-controlled limiter keys', async () => {
    let current = 10_000
    const access = controller(new MemoryDeviceStore(), () => current, { maxSessions: 2 })
    await access.initialize()
    const opened = await access.openPairing()
    const paired = await access.pair('a', opened.token)
    current += 1
    const second = await access.renew(paired.deviceToken)
    current += 1
    const third = await access.renew(paired.deviceToken)
    expect(() => access.authorizeSession(paired.sessionToken)).toThrowError(AccessError)
    expect(access.authorizeSession(second.sessionToken).deviceId).toBe(paired.deviceId)
    expect(access.authorizeSession(third.sessionToken).deviceId).toBe(paired.deviceId)
    expect(access.metrics().sessions).toBe(2)

    const limiter = new BoundedRateLimiter(1, 1_000, 2)
    expect(limiter.take('one', current)).toBe(true)
    expect(limiter.take('one', current)).toBe(false)
    expect(limiter.take('two', current)).toBe(true)
    expect(limiter.take('three', current)).toBe(false)
    expect(limiter.size).toBe(2)
  })

  it('rate-limits failed pairing without blocking the valid one-time secret', async () => {
    const access = controller(new MemoryDeviceStore(), () => 20_000, { maxPairingAttempts: 2 })
    await access.initialize()
    const opened = await access.openPairing()
    await expect(access.pair('source', 'wrong')).rejects.toMatchObject({ status: 401 })
    await expect(access.pair('source', 'wrong-again')).rejects.toMatchObject({ status: 401 })
    await expect(access.pair('source', 'wrong-third')).rejects.toMatchObject({ status: 429 })
    const paired = await access.pair('source', opened.token)
    expect(paired.deviceId).toMatch(/^[a-f\d]{32}$/)
  })

  it('waits for an accepted durable mutation before teardown completes', async () => {
    const backing = new MemoryDeviceStore()
    let releaseSave!: () => void
    const saveGate = new Promise<void>(resolve => { releaseSave = resolve })
    let announceSave!: () => void
    const saveStarted = new Promise<void>(resolve => { announceSave = resolve })
    const store: DeviceStore = {
      load: () => backing.load(),
      async save(snapshot: DeviceSnapshot) {
        announceSave()
        await saveGate
        await backing.save(snapshot)
      },
    }
    const access = controller(store, () => 30_000)
    await access.initialize()
    const opened = await access.openPairing()
    const pairing = access.pair('source', opened.token)
    await saveStarted

    let closed = false
    const closing = access.close().then(() => { closed = true })
    await Promise.resolve()
    expect(closed).toBe(false)
    await expect(access.openPairing()).rejects.toThrow(/not available/)

    releaseSave()
    await Promise.all([pairing, closing])
    expect(closed).toBe(true)
    expect(access.metrics().sessions).toBe(0)
  })

  it('fails closed on malformed or duplicate durable identities', () => {
    expect(() => parseDeviceSnapshot({ version: 0, devices: [] })).toThrow(/unsupported/)
    const device = {
      id: 'a'.repeat(32),
      label: 'Phone',
      tokenDigest: 'b'.repeat(64),
      createdAt: 1,
      expiresAt: 2,
      lastSeenAt: 1,
    }
    expect(() => parseDeviceSnapshot({ version: 1, devices: [device, device] })).toThrow(/duplicate/)
    expect(() => parseDeviceSnapshot({ version: 1, devices: [{ ...device, tokenDigest: 'raw-token' }] })).toThrow(/digest/)
  })
})

describe('native credential identity', () => {
  it.each([1, 2] as const)('retains optional bindings and the input snapshot version %s', version => {
    const device = { ...legacySnapshot('legacy-token').devices[0]!, nativeInstanceId: 'b'.repeat(64) }
    const parsed = parseDeviceSnapshot({ version, devices: [{ ...device, discarded: 'not persisted' }] })
    expect(parsed).toEqual({ version, devices: [device] })
    expect(parseDeviceSnapshot({ version, devices: legacySnapshot('legacy-token').devices }).devices[0])
      .not.toHaveProperty('nativeInstanceId')
  })

  it.each([1, 2] as const)('rejects an invalid binding rather than treating version %s as legacy', version => {
    for (const nativeInstanceId of [null, '', 'a'.repeat(63), 'A'.repeat(64), 3]) {
      expect(() => parseDeviceSnapshot({
        version,
        devices: [{ ...legacySnapshot('legacy-token').devices[0], nativeInstanceId }],
      })).toThrow('invalid native instance id')
    }
    expect(() => parseDeviceSnapshot({ version: 3, devices: [] })).toThrow('unsupported version')
  })

  it('keeps legacy identities unbound and new identities bound across writes and restart', async () => {
    const legacyToken = 'legacy-token'
    const pairingInstanceId = 'b'.repeat(64)
    const legacyInstanceId = 'c'.repeat(64)
    const store = new MemoryDeviceStore(legacySnapshot(legacyToken))
    const access = controller(store, () => 2_000, { pairingInstanceId, legacyInstanceId })
    await access.initialize()
    expect(store.inspect().version).toBe(1)

    const legacyRenewed = await access.renew(legacyToken)
    expect(legacyRenewed.nativeInstanceId).toBe(legacyInstanceId)
    expect((await access.probe(legacyToken)).nativeInstanceId).toBe(legacyInstanceId)
    expect(access.authorizeDevice(legacyToken).nativeInstanceId).toBe(legacyInstanceId)
    expect(store.inspect().version).toBe(2)
    expect(store.inspect().devices[0]).not.toHaveProperty('nativeInstanceId')

    const opened = await access.openPairing()
    const paired = await access.pair('source', opened.token)
    expect(paired.nativeInstanceId).toBe(pairingInstanceId)
    expect(store.inspect().devices.find(device => device.id === paired.deviceId)?.nativeInstanceId).toBe(pairingInstanceId)
    expect(access.listDevices().every(device => !('nativeInstanceId' in device))).toBe(true)
    await access.close()

    const restarted = controller(store, () => 3_000, { pairingInstanceId: 'd'.repeat(64), legacyInstanceId })
    await restarted.initialize()
    expect((await restarted.renew(legacyToken)).nativeInstanceId).toBe(legacyInstanceId)
    expect((await restarted.renew(paired.deviceToken)).nativeInstanceId).toBe(pairingInstanceId)
    expect((await restarted.probe(paired.deviceToken)).nativeInstanceId).toBe(pairingInstanceId)
    expect(restarted.authorizeDevice(paired.deviceToken).nativeInstanceId).toBe(pairingInstanceId)
    expect(store.inspect().devices.find(device => device.id === 'a'.repeat(32))).not.toHaveProperty('nativeInstanceId')
    await restarted.close()
  })

  it('falls back to the pairing identity for an unbound credential without a legacy option', async () => {
    const store = new MemoryDeviceStore(legacySnapshot('legacy-token'))
    const access = controller(store, () => 2_000, { pairingInstanceId: 'b'.repeat(64) })
    await access.initialize()
    expect((await access.renew('legacy-token')).nativeInstanceId).toBe('b'.repeat(64))
    expect((await access.probe('legacy-token')).nativeInstanceId).toBe('b'.repeat(64))
    expect(store.inspect().devices[0]).not.toHaveProperty('nativeInstanceId')
    await access.close()
  })

  it('omits native identity fields for an unbound credential without either identity option', async () => {
    const store = new MemoryDeviceStore(legacySnapshot('legacy-token'))
    const access = controller(store, () => 2_000)
    await access.initialize()
    expect(await access.renew('legacy-token')).not.toHaveProperty('nativeInstanceId')
    expect(await access.probe('legacy-token')).not.toHaveProperty('nativeInstanceId')
    expect(access.authorizeDevice('legacy-token')).not.toHaveProperty('nativeInstanceId')
    expect(store.inspect().devices[0]).not.toHaveProperty('nativeInstanceId')
    await access.close()
  })

  it('loads legacy memory snapshots unchanged and writes the current format with or without bindings', async () => {
    const legacy = legacySnapshot('legacy-token')
    const store = new MemoryDeviceStore(legacy)
    expect(await store.load()).toEqual(legacy)
    await store.save(legacy)
    expect(await store.load()).toEqual({ version: 2, devices: legacy.devices })
    const bound = { ...legacy.devices[0]!, nativeInstanceId: 'b'.repeat(64) }
    await store.save({ version: 1, devices: [bound] })
    expect(await store.load()).toEqual({ version: 2, devices: [bound] })
  })

  it.each(['unknown', 'revoked', 'expired'] as const)('rejects a %s token before returning an identity or changing state', async mode => {
    let current = 2_000
    const store = new MemoryDeviceStore()
    const access = controller(store, () => current, {
      pairingInstanceId: 'b'.repeat(64),
      legacyInstanceId: 'c'.repeat(64),
      deviceTtlMs: 1_000,
    })
    await access.initialize()
    const opened = await access.openPairing()
    const paired = await access.pair('source', opened.token)
    if (mode === 'revoked') await access.revokeDevice(paired.deviceId)
    if (mode === 'expired') current = paired.deviceExpiresAt
    const token = mode === 'unknown' ? 'unknown-token' : paired.deviceToken
    const before = store.inspect()
    const sessions = access.metrics().sessions
    const code = mode === 'expired' ? 'device_expired' : 'authentication_failed'
    await expect(access.renew(token)).rejects.toMatchObject({ status: 401, code })
    await expect(access.probe(token)).rejects.toMatchObject({ status: 401, code })
    expect(() => access.authorizeDevice(token)).toThrow(AccessError)
    expect(store.inspect()).toEqual(before)
    expect(access.metrics().sessions).toBe(sessions)
    await access.close()
  })

  it('does not issue a bound device credential or Session when the pairing write fails', async () => {
    const backing = new MemoryDeviceStore()
    const store: DeviceStore = {
      load: () => backing.load(),
      async save() { throw new Error('disk full') },
    }
    const access = controller(store, () => 2_000, { pairingInstanceId: 'b'.repeat(64) })
    await access.initialize()
    const opened = await access.openPairing()
    await expect(access.pair('source', opened.token)).rejects.toThrow('disk full')
    expect(backing.inspect()).toEqual({ version: 1, devices: [] })
    expect(access.listDevices()).toEqual([])
    expect(access.metrics().sessions).toBe(0)
    expect(access.pairingStatus().open).toBe(false)
    await access.close()
  })

  it.each(['renew', 'probe'] as const)('retains the binding and existing Session when a %s write fails', async operation => {
    let current = 2_000
    const backing = new MemoryDeviceStore()
    let rejectSave = false
    const store: DeviceStore = {
      load: () => backing.load(),
      async save(snapshot) {
        if (rejectSave) throw new Error('disk full')
        await backing.save(snapshot)
      },
    }
    const access = controller(store, () => current, { pairingInstanceId: 'b'.repeat(64) })
    await access.initialize()
    const opened = await access.openPairing()
    const paired = await access.pair('source', opened.token)
    const before = backing.inspect()
    const sessions = access.metrics().sessions
    current += 1_000
    rejectSave = true
    await expect(access[operation](paired.deviceToken)).rejects.toThrow('disk full')
    expect(backing.inspect()).toEqual(before)
    expect(access.metrics().sessions).toBe(sessions)
    expect(access.authorizeSession(paired.sessionToken).deviceId).toBe(paired.deviceId)
    expect(access.authorizeDevice(paired.deviceToken).nativeInstanceId).toBe('b'.repeat(64))
    await access.close()
  })
})
