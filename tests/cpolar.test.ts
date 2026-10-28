import { EventEmitter } from 'node:events'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { PassThrough } from 'node:stream'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { MobileAccessControlState, MobileAccessControlStore } from '../src/control.js'
import { CpolarController, type CpolarStatus, parseCpolarOrigin } from '../src/cpolar.js'
import type { MobileAccessGateway } from '../src/gateway.js'

const temporaryDirectories: string[] = []
const controllers: CpolarController[] = []
const releaseBarriers: Array<() => void> = []

afterEach(async () => {
  for (const release of releaseBarriers.splice(0)) release()
  const results = await Promise.allSettled(controllers.splice(0).map(controller => controller.close()))
  await Promise.all(temporaryDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
  const failure = results.find(result => result.status === 'rejected')
  if (failure?.status === 'rejected') throw failure.reason
})

class MemoryControlStore implements MobileAccessControlStore {
  state: MobileAccessControlState = { version: 1, enabled: true }

  async load(): Promise<MobileAccessControlState> { return this.state }
  async save(state: MobileAccessControlState): Promise<void> { this.state = state }
}

class FakeChild extends EventEmitter {
  readonly stdin = new PassThrough()
  readonly stdout = new PassThrough()
  readonly stderr = new PassThrough()
  exitCode: number | null = null
  signalCode: NodeJS.Signals | null = null

  writeOrigin(origin: string): void {
    this.stdout.write(`time="now" level=info msg="Tunnel established at ${origin}"\n`)
  }

  kill(): boolean {
    if (this.exitCode !== null || this.signalCode !== null) return false
    this.exitCode = 0
    this.stdin.destroy()
    this.stdout.destroy()
    this.stderr.destroy()
    setImmediate(() => { this.emit('close', 0) })
    return true
  }
}

class StatusJournal {
  readonly values: CpolarStatus[] = []
  private readonly listeners = new Set<(status: CpolarStatus) => void>()

  readonly publish = (status: CpolarStatus): void => {
    this.values.push(status)
    for (const listener of [...this.listeners]) listener(status)
  }

  waitFor(predicate: (status: CpolarStatus) => boolean): Promise<CpolarStatus> {
    const current = this.values.findLast(predicate)
    if (current !== undefined) return Promise.resolve(current)
    return new Promise(resolve => {
      const listener = (status: CpolarStatus): void => {
        if (!predicate(status)) return
        this.listeners.delete(listener)
        resolve(status)
      }
      this.listeners.add(listener)
    })
  }
}

interface FakeGateway extends MobileAccessGateway {
  close: ReturnType<typeof vi.fn<() => Promise<void>>>
}

function gateway(origin: string, port: number, close: () => Promise<void> = async () => undefined): FakeGateway {
  return {
    address: () => ({ host: '127.0.0.1', port, origin }),
    close: vi.fn(close),
  } as unknown as FakeGateway
}

function deferred(): { readonly promise: Promise<void>; readonly resolve: () => void } {
  let resolvePromise: (() => void) | undefined
  const promise = new Promise<void>(resolve => { resolvePromise = resolve })
  const resolve = (): void => { resolvePromise?.() }
  releaseBarriers.push(resolve)
  return { promise, resolve }
}

async function fixture(
  createGateway: (origin: string, port: number) => Promise<MobileAccessGateway>,
  options: { readonly region?: string, readonly subdomain?: string } = {},
): Promise<{
  readonly child: FakeChild
  readonly controller: CpolarController
  readonly journal: StatusJournal
  readonly args: () => readonly string[]
}> {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-mobile-cpolar-'))
  temporaryDirectories.push(directory)
  const executable = join(directory, 'component', 'cpolar.exe')
  const configFile = join(directory, 'config', 'cpolar.yml')
  await Promise.all([mkdir(dirname(executable), { recursive: true }), mkdir(dirname(configFile), { recursive: true })])
  await Promise.all([writeFile(executable, 'fake-cpolar'), writeFile(configFile, 'fake-config')])
  const child = new FakeChild()
  let startedArgs: readonly string[] = []
  const journal = new StatusJournal()
  const controller = new CpolarController({
    store: new MemoryControlStore(),
    executable,
    configFile,
    createGateway,
    ...(options.region === undefined ? {} : { region: options.region }),
    ...(options.subdomain === undefined ? {} : { subdomain: options.subdomain }),
    onStatus: journal.publish,
    spawnProcess: (_executable, args) => {
      startedArgs = [...args]
      return child as unknown as ChildProcessWithoutNullStreams
    },
  })
  controllers.push(controller)
  await controller.initialize()
  return { child, controller, journal, args: () => startedArgs }
}

describe('cpolar log protocol', () => {
  it('accepts only provider HTTPS origins', () => {
    expect(parseCpolarOrigin('time="now" level=info msg="Tunnel established at http://example.r8.cpolar.cn"')).toBeUndefined()
    expect(parseCpolarOrigin('time="now" level=info msg="Tunnel established at https://example.r8.cpolar.cn"'))
      .toBe('https://example.r8.cpolar.cn')
    expect(parseCpolarOrigin('Tunnel established at https://example.cpolar.io')).toBe('https://example.cpolar.io')
    expect(parseCpolarOrigin('Tunnel established at https://reserved.vip.cpolar.cn')).toBe('https://reserved.vip.cpolar.cn')
  })

  it('rejects lookalike, credentialed, and non-root origins', () => {
    expect(() => parseCpolarOrigin('Tunnel established at https://example.cpolar.cn.evil.test')).toThrow('invalid_cpolar_origin')
    expect(() => parseCpolarOrigin('Tunnel established at https://user@example.cpolar.cn')).toThrow('invalid_cpolar_origin')
    expect(() => parseCpolarOrigin('Tunnel established at https://example.cpolar.cn/path')).toThrow('invalid_cpolar_origin')
  })
})

describe('cpolar provider lifecycle', () => {
  it('lets cpolar choose its default region unless one is explicitly configured', async () => {
    const automatic = await fixture(async () => gateway('https://automatic.r8.cpolar.cn', 1))
    expect(automatic.args()).not.toContain('-region=cn')

    const explicit = await fixture(async () => gateway('https://explicit.r8.cpolar.cn', 1), { region: 'cn_vip' })
    // An explicit region reaches the provider; leaving it unset leaves the route to cpolar.
    expect(explicit.args()).toContain('-region=cn_vip')
  })

  it('requests a reserved subdomain only when one is configured', async () => {
    // Without a reservation cpolar answers with a random hostname, which stays the
    // default for accounts that have not reserved a name.
    const automatic = await fixture(async () => gateway('https://automatic.r8.cpolar.cn', 1))
    expect(automatic.args().some(argument => argument.startsWith('-subdomain='))).toBe(false)

    const explicit = await fixture(
      async () => gateway('https://reserved.r8.cpolar.cn', 1),
      { subdomain: 'reserved', region: 'cn_vip' },
    )
    expect(explicit.args()).toContain('-subdomain=reserved')
    // Both flags reach cpolar, in the documented order. The name stays a request
    // to the provider: cpolar still reports the established origin, so a rejected
    // reservation cannot redirect the tunnel to a host this controller never validated.
    expect(explicit.args().indexOf('-subdomain=reserved'))
      .toBeLessThan(explicit.args().indexOf('-region=cn_vip'))
  })

  it('rejects malformed or oversized reserved-name requests before spawning', () => {
    const executable = join(tmpdir(), 'dsh-mobile-cpolar-validation', 'cpolar.exe')
    const configFile = join(tmpdir(), 'dsh-mobile-cpolar-validation', 'cpolar.yml')
    const build = (subdomain: string): CpolarController => new CpolarController({
      store: new MemoryControlStore(),
      executable,
      configFile,
      subdomain,
      createGateway: async () => gateway('https://unused.r8.cpolar.cn', 1),
    })

    for (const invalid of ['-leading', 'with space', 'sla/sh', 'a'.repeat(64)]) {
      expect(() => build(invalid)).toThrow('cpolar subdomain is invalid')
    }
    // Local request validation does not guarantee the provider accepts a reservation.
    expect(() => build('reserved-name')).not.toThrow()
    expect(() => build('a.b_c-d')).not.toThrow()
    expect(() => build('a'.repeat(63))).not.toThrow()
  })

  it('rotates different origins in order on the same loopback port', async () => {
    const firstClose = deferred()
    const gateways: FakeGateway[] = []
    const createGateway = vi.fn(async (origin: string, port: number): Promise<MobileAccessGateway> => {
      const created = gateway(origin, port, gateways.length === 0 ? () => firstClose.promise : undefined)
      gateways.push(created)
      return created
    })
    const { child, controller, journal } = await fixture(createGateway)
    const firstOrigin = 'https://first.r8.cpolar.cn'
    const secondOrigin = 'https://second.r8.cpolar.cn'
    const thirdOrigin = 'https://third.r8.cpolar.cn'

    const firstReady = journal.waitFor(status => status.state === 'ready' && status.origin === firstOrigin)
    child.writeOrigin(firstOrigin)
    await firstReady
    expect(controller.gateway()).toBe(gateways[0])
    const listenerPort = createGateway.mock.calls[0]![1]
    expect(listenerPort).toBeGreaterThan(0)

    // A duplicate establishment line is informational, not a rotation.
    child.writeOrigin(firstOrigin)
    await controller.setEnabled(true)
    expect(createGateway).toHaveBeenCalledTimes(1)

    const secondConnecting = journal.waitFor(status => status.state === 'connecting' && status.origin === secondOrigin)
    child.writeOrigin(secondOrigin)
    await secondConnecting
    expect(controller.gateway()).toBeUndefined()
    expect(gateways[0]!.close).toHaveBeenCalledOnce()
    expect(createGateway).toHaveBeenCalledTimes(1)

    // A later provider update queues behind the in-progress close instead of
    // racing a second listener onto the same loopback port.
    const secondReady = journal.waitFor(status => status.state === 'ready' && status.origin === secondOrigin)
    const thirdReady = journal.waitFor(status => status.state === 'ready' && status.origin === thirdOrigin)
    child.writeOrigin(thirdOrigin)
    firstClose.resolve()
    await secondReady
    await thirdReady

    expect(createGateway.mock.calls).toEqual([
      [firstOrigin, listenerPort],
      [secondOrigin, listenerPort],
      [thirdOrigin, listenerPort],
    ])
    expect(gateways[1]!.close).toHaveBeenCalledOnce()
    expect(controller.gateway()).toBe(gateways[2])
    expect(controller.status()).toEqual({ enabled: true, state: 'ready', origin: thirdOrigin })
    expect(journal.values.filter(status => status.state === 'connecting').map(status => status.origin)).toEqual([
      firstOrigin,
      secondOrigin,
      thirdOrigin,
    ])
  })

  it('stops the owned process when a rotated gateway cannot start', async () => {
    let created: FakeGateway | undefined
    const createGateway = vi.fn(async (origin: string, port: number): Promise<MobileAccessGateway> => {
      if (created !== undefined) throw new Error('replacement failed')
      created = gateway(origin, port)
      return created
    })
    const { child, controller, journal } = await fixture(createGateway)
    const ready = journal.waitFor(status => status.state === 'ready')
    child.writeOrigin('https://first.r8.cpolar.cn')
    await ready

    const failed = journal.waitFor(status => status.state === 'error')
    child.writeOrigin('https://second.r8.cpolar.cn')
    await failed

    expect(created?.close).toHaveBeenCalledOnce()
    expect(child.exitCode).toBe(0)
    expect(controller.gateway()).toBeUndefined()
    expect(controller.status()).toEqual({ enabled: true, state: 'error', errorCode: 'gateway_start_failed' })
  })

  it('does not start a replacement after close begins during rotation', async () => {
    const firstClose = deferred()
    const gateways: FakeGateway[] = []
    const createGateway = vi.fn(async (origin: string, port: number): Promise<MobileAccessGateway> => {
      const created = gateway(origin, port, () => firstClose.promise)
      gateways.push(created)
      return created
    })
    const { child, controller, journal } = await fixture(createGateway)
    const ready = journal.waitFor(status => status.state === 'ready')
    child.writeOrigin('https://first.r8.cpolar.cn')
    await ready

    const connecting = journal.waitFor(status => status.state === 'connecting' && status.origin === 'https://second.r8.cpolar.cn')
    child.writeOrigin('https://second.r8.cpolar.cn')
    await connecting
    const closing = controller.close()
    firstClose.resolve()
    await closing

    expect(createGateway).toHaveBeenCalledOnce()
    expect(gateways[0]!.close).toHaveBeenCalledOnce()
    expect(child.exitCode).toBe(0)
    expect(controller.gateway()).toBeUndefined()
  })
})
