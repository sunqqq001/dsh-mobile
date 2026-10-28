import { describe, expect, it } from 'vitest'
import { AccessController, type AccessControllerOptions, type AccessError } from '../src/access.js'
import { MemoryDeviceStore, type DeviceStore } from '../src/storage.js'

const options: AccessControllerOptions = {
  pairingTtlMs: 60_000,
  deviceTtlMs: 90_000,
  sessionTtlMs: 30_000,
  maxDevices: 3,
  maxSessions: 8,
  rateLimitWindowMs: 60_000,
  maxPairingAttempts: 2,
  maxRateLimitKeys: 4,
  now: () => 20_000,
}

describe('pairing failure admission', () => {
  it('keeps a valid one-time secret usable after the same peer exhausts invalid guesses', async () => {
    const store = new MemoryDeviceStore()
    const access = new AccessController(store, options)
    await access.initialize()
    try {
      await expect(access.pair('proxy', 'bad-1')).rejects.toMatchObject({ status: 401, code: 'authentication_failed' })
      await expect(access.pair('proxy', 'bad-2')).rejects.toMatchObject({ status: 401, code: 'authentication_failed' })
      await expect(access.pair('proxy', 'bad-3')).rejects.toMatchObject({ status: 429, code: 'rate_limited' })
      const opened = await access.openPairing()
      const paired = await access.pair('proxy', opened.token)
      expect(paired.deviceToken).toMatch(/^[\w-]{43}$/u)
      expect(store.inspect().devices).toHaveLength(1)
      await expect(access.pair('proxy', opened.token)).rejects.toMatchObject({ status: 429, code: 'rate_limited' })
    } finally {
      await access.close()
    }
  })

  it('rejects anonymous work before a held mutation and admits only one valid candidate to the queue', async () => {
    const backing = new MemoryDeviceStore()
    let holdNextWrite = false
    let announceWrite!: () => void
    const writing = new Promise<void>(resolve => { announceWrite = resolve })
    let releaseWrite!: () => void
    const held = new Promise<void>(resolve => { releaseWrite = resolve })
    const store: DeviceStore = {
      load: () => backing.load(),
      async save(snapshot) {
        if (holdNextWrite) {
          holdNextWrite = false
          announceWrite()
          await held
        }
        await backing.save(snapshot)
      },
    }
    const access = new AccessController(store, options)
    await access.initialize()
    const firstWindow = await access.openPairing()
    const firstDevice = await access.pair('proxy', firstWindow.token)
    const secondWindow = await access.openPairing()
    holdNextWrite = true
    const probe = access.probe(firstDevice.deviceToken)
    await writing
    const accepted = access.pair('proxy', secondWindow.token)
    try {
      await expect(access.pair('proxy', secondWindow.token)).rejects.toMatchObject({ status: 429, code: 'rate_limited' })
      let timeout: ReturnType<typeof setTimeout> | undefined
      try {
        const invalid = access.pair('proxy', 'anonymous-guess').then(
          () => new Error('invalid pairing unexpectedly succeeded'),
          (error: AccessError) => error,
        )
        const settled = await Promise.race([
          invalid,
          new Promise<Error>(resolve => { timeout = setTimeout(() => resolve(new Error('invalid request entered the mutation queue')), 1_000) }),
        ])
        expect(settled).toMatchObject({ status: 401, code: 'authentication_failed' })
      } finally {
        if (timeout !== undefined) clearTimeout(timeout)
      }
    } finally {
      releaseWrite()
      await probe
    }
    const paired = await accepted
    expect(paired.deviceId).not.toBe(firstDevice.deviceId)
    expect(backing.inspect().devices).toHaveLength(2)
    await access.close()
  })

  it('rechecks a queued one-time secret after a newer pairing window replaces it', async () => {
    const backing = new MemoryDeviceStore()
    let holdNextWrite = false
    let announceWrite!: () => void
    const writing = new Promise<void>(resolve => { announceWrite = resolve })
    let releaseWrite!: () => void
    const held = new Promise<void>(resolve => { releaseWrite = resolve })
    const access = new AccessController({
      load: () => backing.load(),
      async save(snapshot) {
        if (holdNextWrite) {
          holdNextWrite = false
          announceWrite()
          await held
        }
        await backing.save(snapshot)
      },
    }, options)
    await access.initialize()
    const firstWindow = await access.openPairing()
    const device = await access.pair('proxy', firstWindow.token)
    const staleWindow = await access.openPairing()
    holdNextWrite = true
    const probe = access.probe(device.deviceToken)
    await writing
    const replacementWindow = access.openPairing()
    const stalePair = access.pair('proxy', staleWindow.token)
    try {
      releaseWrite()
      await probe
      const replacement = await replacementWindow
      await expect(stalePair).rejects.toMatchObject({ status: 401, code: 'authentication_failed' })
      const paired = await access.pair('proxy', replacement.token)
      expect(paired.deviceId).not.toBe(device.deviceId)
    } finally {
      await access.close()
    }
  })
})
