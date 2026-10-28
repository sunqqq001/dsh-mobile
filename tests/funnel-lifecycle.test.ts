import { ChildProcess, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { parseGatewayConfig } from '../src/config.js'
import type { MobileAccessControlState } from '../src/control.js'
import { FunnelController, type FunnelStatus } from '../src/funnel.js'
import { MobileAccessGateway } from '../src/gateway.js'
import { MemoryDeviceStore } from '../src/storage.js'

const spawning = vi.hoisted(() => ({ factories: new Map<string, () => ChildProcessWithoutNullStreams>() }))
vi.mock('node:child_process', async () => {
  const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process')
  return {
    ...actual,
    spawn: (...args: Parameters<typeof actual.spawn>) => spawning.factories.get(args[0])?.() ?? actual.spawn(...args),
  }
})

function gate(): { promise: Promise<void>; release(): void } {
  let release!: () => void
  const promise = new Promise<void>(resolve => { release = resolve })
  return { promise, release }
}

class FakeChild extends ChildProcess implements ChildProcessWithoutNullStreams {
  override exitCode: number | null = null
  override readonly stdin = new PassThrough()
  override readonly stdout = new PassThrough()
  override readonly stderr = new PassThrough()
  override readonly stdio: [PassThrough, PassThrough, PassThrough, undefined, undefined] = [this.stdin, this.stdout, this.stderr, undefined, undefined]
  readonly termination = gate()
  readonly closed = gate()
  holdClose = false

  override kill(): boolean {
    if (this.exitCode !== null) return false
    this.termination.release()
    if (!this.holdClose) queueMicrotask(() => { this.finish(0) })
    return true
  }

  finish(code: number): void {
    if (this.exitCode !== null) return
    this.exitCode = code
    this.stdin.destroy()
    this.stdout.destroy()
    this.stderr.destroy()
    this.emit('close', code)
    this.closed.release()
  }

  events(...events: Readonly<Record<string, unknown>>[]): void {
    this.stdout.write(events.map(event => JSON.stringify({ version: 1, ...event })).join('\n') + '\n')
  }
}

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  try {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
  } finally {
    spawning.factories.clear()
    vi.restoreAllMocks()
  }
})

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-funnel-lifecycle-'))
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  const executable = join(root, 'controlled-sidecar.exe')
  const stateDirectory = join(root, 'tailscale')
  await writeFile(executable, 'never executed')
  await mkdir(stateDirectory)
  const children: FakeChild[] = []
  const statuses: FunnelStatus[] = []
  let saved: MobileAccessControlState = { version: 1, enabled: false }
  const store = {
    load: async () => saved,
    save: vi.fn(async (state: MobileAccessControlState) => { saved = state }),
  }
  const gateway = new MobileAccessGateway(parseGatewayConfig({
    stateFile: join(root, 'devices.json'), instanceId: 'a'.repeat(64),
    listenHost: '127.0.0.1', tls: { mode: 'disabled' },
  }), new MemoryDeviceStore())
  vi.spyOn(gateway, 'address').mockReturnValue({ host: '127.0.0.1', port: 42123, origin: 'https://fixture.ts.net' })
  const closeGateway = vi.spyOn(gateway, 'close')
  const createGateway = vi.fn(async () => gateway)
  const controller = new FunnelController({
    store, executable, stateDirectory, ownedRoot: root, hostname: 'fixture', createGateway,
    onStatus: status => { statuses.push(status) },
  })
  spawning.factories.set(executable, () => {
    const child = new FakeChild()
    children.push(child)
    return child
  })
  cleanups.push(async () => {
    for (const child of children) {
      child.holdClose = false
      child.finish(0)
    }
    await controller.close()
    await gateway.close()
  })
  await controller.initialize()
  await controller.setEnabled(true)
  const child = children[0]!
  const ready = async (): Promise<void> => {
    child.events({ type: 'ready', origin: 'https://fixture.ts.net' }, { type: 'serving', origin: 'https://fixture.ts.net' })
    await vi.waitFor(() => { expect(controller.status().state).toBe('ready') })
  }
  return { controller, child, children, statuses, store, gateway, closeGateway, createGateway, ready }
}

const authorizationError = { type: 'error', code: 'funnel_https_required', url: 'https://tailscale.com/s/https' }
const authorizationStatus = {
  enabled: true, state: 'error', errorCode: 'funnel_https_required', setupUrl: 'https://tailscale.com/s/https',
}

describe('Funnel terminal generation ownership', () => {
  it.each(['natural', 'terminated'])('retains the specific authorization failure after a %s child close', async exit => {
    const { controller, child, statuses } = await fixture()
    child.events(authorizationError)
    if (exit === 'natural') child.finish(1)
    await child.closed.promise
    await controller.close()
    expect(controller.status()).toEqual(authorizationStatus)
    expect(statuses.filter(status => status.state === 'error')).toEqual([authorizationStatus])
  })

  it.each([0, 1])('reports a generic error when the child closes with %s without an earlier failure', async code => {
    const { controller, child, statuses } = await fixture()
    child.finish(code)
    await controller.close()
    expect(controller.status()).toEqual({ enabled: true, state: 'error', errorCode: code === 0 ? 'sidecar_stopped' : 'sidecar_exited' })
    expect(statuses.filter(status => status.state === 'error')).toHaveLength(1)
  })

  it('retains a launch failure when the failed child subsequently closes', async () => {
    const { controller, child, statuses } = await fixture()
    child.emit('error', new Error('controlled launch rejection'))
    child.finish(1)
    await controller.close()
    expect(controller.status()).toEqual({ enabled: true, state: 'error', errorCode: 'sidecar_launch_failed' })
    expect(statuses.filter(status => status.state === 'error')).toHaveLength(1)
  })

  it.each([
    { type: 'serving', origin: 'https://fixture.ts.net' },
    { type: 'ready', origin: 'https://fixture.ts.net' },
    { type: 'login', url: 'https://login.tailscale.com/a/fixture' },
  ])('does not revive a failed generation with a queued $type event', async event => {
    const { controller, child, statuses, createGateway } = await fixture()
    child.events(authorizationError, event)
    await child.closed.promise
    await controller.close()
    expect(controller.status()).toEqual(authorizationStatus)
    expect(createGateway).not.toHaveBeenCalled()
    expect(statuses.filter(status => !['off', 'starting'].includes(status.state))).toEqual([authorizationStatus])
  })

  it('starts a fresh generation after failure and ignores callbacks owned by the former child', async () => {
    const { controller, child, children } = await fixture()
    const lateData = child.stdout.listeners('data')[0]!
    const lateClose = child.listeners('close')[0]!
    child.events(authorizationError)
    await child.closed.promise
    await controller.reconnect()
    expect(controller.status().state).toBe('starting')
    lateData(Buffer.from(JSON.stringify(authorizationError) + '\n'))
    lateClose(1, null)
    child.emit('error', new Error('late old-child error'))
    children[1]!.events({ type: 'error', code: 'tailscale_dns_missing' })
    await children[1]!.termination.promise
    await controller.close()
    expect(controller.status()).toEqual({ enabled: true, state: 'error', errorCode: 'tailscale_dns_missing' })
    expect(children).toHaveLength(2)
  })

  it('waits for both process close and asynchronous gateway cleanup before finishing a failure', async () => {
    const { controller, child, closeGateway, ready } = await fixture()
    await ready()
    const gatewayClosing = gate()
    const releaseGateway = gate()
    cleanups.push(async () => { releaseGateway.release() })
    closeGateway.mockImplementationOnce(async () => { gatewayClosing.release(); await releaseGateway.promise })
    child.holdClose = true
    child.events(authorizationError)
    await child.termination.promise
    await gatewayClosing.promise
    let settled = false
    const closing = controller.close().then(() => { settled = true })
    await Promise.resolve()
    expect(settled).toBe(false)
    expect(controller.status().state).toBe('ready')
    releaseGateway.release()
    await Promise.resolve()
    expect(settled).toBe(false)
    child.finish(0)
    await closing
    expect(controller.status()).toEqual(authorizationStatus)
    expect(controller.gateway()).toBeUndefined()
  })

  it('contains a background cleanup rejection, retains the resource and permits an explicit retry', async () => {
    const { controller, child, children, gateway, closeGateway, ready } = await fixture()
    await ready()
    closeGateway.mockRejectedValueOnce(new Error('injected background cleanup rejection'))
      .mockRejectedValueOnce(new Error('injected explicit cleanup rejection'))
    child.events(authorizationError)
    await vi.waitFor(() => {
      expect(controller.status()).toEqual({ enabled: true, state: 'error', errorCode: 'funnel_cleanup_failed' })
    })
    expect(controller.gateway()).toBe(gateway)
    expect(child.exitCode).toBe(0)
    expect(children).toHaveLength(1)
    await expect(controller.reconnect()).rejects.toThrow('injected explicit cleanup rejection')
    expect(controller.gateway()).toBe(gateway)
    expect(controller.status()).toEqual({ enabled: true, state: 'error', errorCode: 'funnel_cleanup_failed' })
    expect(children).toHaveLength(1)
    await controller.reconnect()
    expect(closeGateway).toHaveBeenCalledTimes(3)
    expect(controller.gateway()).toBeUndefined()
    expect(controller.status()).toEqual({ enabled: true, state: 'starting' })
    expect(children).toHaveLength(2)
  })

  it('retains a process whose termination failed and retries it before creating another child', async () => {
    const { controller, child, children } = await fixture()
    const kill = vi.spyOn(child, 'kill').mockImplementationOnce(() => { throw new Error('injected termination rejection') })
    child.events(authorizationError)
    await vi.waitFor(() => {
      expect(controller.status()).toEqual({ enabled: true, state: 'error', errorCode: 'funnel_cleanup_failed' })
    })
    expect(child.exitCode).toBeNull()
    expect(children).toHaveLength(1)
    await controller.reconnect()
    expect(kill).toHaveBeenCalledTimes(2)
    expect(child.exitCode).toBe(0)
    expect(children).toHaveLength(2)
    expect(controller.status()).toEqual({ enabled: true, state: 'starting' })
  })

  it.each(['disable', 'reset', 'close'])('does not publish a child-exit failure while %s stops the provider', async operation => {
    const { controller, child, statuses, store, ready } = await fixture()
    await ready()
    if (operation === 'disable') await controller.setEnabled(false)
    else if (operation === 'reset') await controller.reset()
    else await controller.close()
    expect(child.exitCode).toBe(0)
    expect(controller.gateway()).toBeUndefined()
    expect(statuses.filter(status => status.state === 'error')).toEqual([])
    if (operation !== 'close') {
      expect(controller.status()).toEqual({ enabled: false, state: 'off' })
      expect(store.save).toHaveBeenCalledWith({ version: 1, enabled: false })
    }
  })
})
