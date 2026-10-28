import { EventEmitter, getEventListeners } from 'node:events'
import { PassThrough } from 'node:stream'
import { afterEach, expect, it, vi } from 'vitest'
import { observeCaddyListener } from './helpers/caddy-listener.js'

class FixtureChild extends EventEmitter {
  readonly stderr = new PassThrough()
  exitCode: number | null = null
  signalCode: NodeJS.Signals | null = null
}

const cleanups: (() => void)[] = []
afterEach(() => {
  const errors: unknown[] = []
  try {
    for (const cleanup of cleanups.splice(0).reverse()) {
      try { cleanup() } catch (error) { errors.push(error) }
    }
  } finally { vi.useRealTimers() }
  if (errors.length > 0) throw new AggregateError(errors, 'Owned listener-fixture cleanup failed')
})

function fixture(): { child: FixtureChild; observation: ReturnType<typeof observeCaddyListener>; controller: AbortController; released(): void } {
  const child = new FixtureChild()
  const controller = new AbortController()
  const observation = observeCaddyListener(child)
  cleanups.push(() => { try { observation.dispose() } finally { child.stderr.destroy() } })
  const released = (): void => {
    expect(child.listenerCount('error')).toBe(0)
    expect(child.listenerCount('close')).toBe(0)
    expect(child.stderr.listenerCount('data')).toBe(0)
    expect(child.stderr.listenerCount('error')).toBe(0)
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0)
    expect(vi.getTimerCount()).toBe(0)
  }
  return { child, observation, controller, released }
}

function record(port = 43127, fields: Record<string, unknown> = {}): string {
  return JSON.stringify({ level: 'info', logger: 'http', msg: 'port 0 listener', input_address: '127.0.0.1:0',
    actual_address: '127.0.0.1:' + String(port), ...fields }) + '\n'
}

it('caches a child receipt across split UTF-8 and multiple log lines before the wait', async () => {
  vi.useFakeTimers()
  const { child, observation, controller, released } = fixture()
  const prefix = Buffer.from(JSON.stringify({ level: 'info', msg: '启动' }) + '\n' + record())
  const split = prefix.indexOf(Buffer.from('启')) + 1
  child.stderr.write(prefix.subarray(0, split))
  child.stderr.write(prefix.subarray(split, prefix.length - 2))
  child.stderr.write(prefix.subarray(prefix.length - 2))
  expect(await observation.wait({ signal: controller.signal, timeoutMs: 20_000 })).toBe(43127)
  expect(await observation.wait({ signal: controller.signal, timeoutMs: 20_000 })).toBe(43127)
  observation.dispose()
  released()
})

it('waits for the exact INFO logger and input, ignoring other normal logs', async () => {
  vi.useFakeTimers()
  const { child, observation, controller, released } = fixture()
  const wait = observation.wait({ signal: controller.signal, timeoutMs: 20_000 })
  child.stderr.write('plain adapter output\n' + record(43200, { logger: 'other' }) + record(43201, { msg: 'starting server loop' }))
  expect(vi.getTimerCount()).toBe(1)
  child.stderr.write(record())
  expect(await wait).toBe(43127)
  expect(vi.getTimerCount()).toBe(0)
  expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0)
  observation.dispose()
  released()
})

it.each([
  { level: 'debug' }, { input_address: ':0' }, { input_address: '0.0.0.0:0' },
  { actual_address: '0.0.0.0:43127' }, { actual_address: '[::1]:43127' },
  { actual_address: '127.0.0.1:0' }, { actual_address: '127.0.0.1:65536' },
  { actual_address: '127.0.0.1:00431' }, { actual_address: 43127 },
])('rejects a matching listener record with invalid fields: %j', async fields => {
  vi.useFakeTimers()
  const { child, observation, controller, released } = fixture()
  const wait = observation.wait({ signal: controller.signal, timeoutMs: 20_000 })
  const rejected = expect(wait).rejects.toThrow('caddy_listener_log_rejected')
  child.stderr.write(record(43127, fields))
  await rejected
  released()
})

it('rejects malformed JSON and oversized incomplete lines without retaining listeners', async () => {
  vi.useFakeTimers()
  for (const value of ['{"logger":\n', 'x'.repeat(8193), JSON.stringify({ msg: 'x'.repeat(8193) }) + '\n']) {
    const { child, observation, controller, released } = fixture()
    const wait = observation.wait({ signal: controller.signal, timeoutMs: 20_000 })
    const rejected = expect(wait).rejects.toThrow('caddy_listener_log_rejected')
    child.stderr.write(value)
    await rejected
    released()
  }
})

it('does not mistake many bounded lines in one chunk for an oversized line', async () => {
  vi.useFakeTimers()
  const { child, observation, controller, released } = fixture()
  child.stderr.write((JSON.stringify({ msg: 'normal' }) + '\n').repeat(1000) + record())
  expect(await observation.wait({ signal: controller.signal, timeoutMs: 20_000 })).toBe(43127)
  observation.dispose()
  released()
})

it('rejects conflicting ports in one chunk before resolving, but accepts repeated identical receipts', async () => {
  vi.useFakeTimers()
  const first = fixture()
  const wait = first.observation.wait({ signal: first.controller.signal, timeoutMs: 20_000 })
  const rejected = expect(wait).rejects.toThrow('caddy_listener_log_rejected')
  first.child.stderr.write(record(43127) + record(43128))
  await rejected
  first.released()
  const second = fixture()
  second.child.stderr.write(record() + record())
  expect(await second.observation.wait({ signal: second.controller.signal, timeoutMs: 20_000 })).toBe(43127)
  second.observation.dispose()
  second.released()
})

it('reports a late conflicting port during cleanup instead of silently accepting it', async () => {
  vi.useFakeTimers()
  const { child, observation, controller, released } = fixture()
  child.stderr.write(record())
  expect(await observation.wait({ signal: controller.signal, timeoutMs: 20_000 })).toBe(43127)
  child.stderr.write(record(43128))
  expect(() => observation.dispose()).toThrow('caddy_listener_log_rejected')
  released()
})

it.each(['error', 'stderr error', 'close', 'truncated close'])('rejects %s before a receipt, including before wait starts', async kind => {
  vi.useFakeTimers()
  const { child, observation, controller, released } = fixture()
  if (kind === 'error') child.emit('error', new Error('owned spawn failed'))
  else if (kind === 'stderr error') child.stderr.emit('error', new Error('owned stderr failed'))
  else {
    if (kind === 'truncated close') child.stderr.write(record().slice(0, -1))
    child.exitCode = 1
    child.emit('close', 1, null)
  }
  await expect(observation.wait({ signal: controller.signal, timeoutMs: 20_000 })).rejects.toThrow(/^caddy_listener_/u)
  released()
})

it('rejects the pending wait when the actual child closes', async () => {
  vi.useFakeTimers()
  const { child, observation, controller, released } = fixture()
  const rejected = expect(observation.wait({ signal: controller.signal, timeoutMs: 20_000 })).rejects.toThrow('caddy_listener_closed_before_receipt')
  child.emit('close', 1, null)
  await rejected
  released()
})

it('preserves abort reason and releases its wait before deadline, including a pre-aborted wait', async () => {
  vi.useFakeTimers()
  for (const before of [false, true]) {
    const { observation, controller, released } = fixture()
    const reason = new Error('owned cancellation')
    if (before) controller.abort(reason)
    const rejected = expect(observation.wait({ signal: controller.signal, timeoutMs: 20_000 })).rejects.toMatchObject({ message: 'caddy_listener_aborted', cause: reason })
    if (!before) controller.abort(reason)
    await rejected
    released()
  }
})

it('bounds missing announcements by the exact supplied deadline and detaches all listeners', async () => {
  vi.useFakeTimers()
  const { observation, controller, released } = fixture()
  const rejected = expect(observation.wait({ signal: controller.signal, timeoutMs: 20_000 })).rejects.toThrow('caddy_listener_timeout')
  expect(vi.getTimerCount()).toBe(1)
  await vi.advanceTimersByTimeAsync(19_999)
  expect(vi.getTimerCount()).toBe(1)
  await vi.advanceTimersByTimeAsync(1)
  await rejected
  released()
})

it('disposes pending work without destroying the child stream or unrelated listeners', async () => {
  vi.useFakeTimers()
  const { child, observation, controller } = fixture()
  const unrelated = vi.fn()
  child.stderr.on('data', unrelated)
  const rejected = expect(observation.wait({ signal: controller.signal, timeoutMs: 20_000 })).rejects.toThrow('caddy_listener_disposed')
  observation.dispose()
  await rejected
  expect(child.stderr.destroyed).toBe(false)
  child.stderr.write(record())
  expect(unrelated).toHaveBeenCalledOnce()
  expect(child.stderr.listenerCount('data')).toBe(1)
  expect(vi.getTimerCount()).toBe(0)
  child.stderr.removeListener('data', unrelated)
  await expect(observation.wait({ signal: controller.signal, timeoutMs: 20_000 })).rejects.toThrow('caddy_listener_disposed')
})

it('never reuses the old child receipt for a new child and rejects a closed child cache', async () => {
  vi.useFakeTimers()
  const old = fixture()
  old.child.stderr.write(record(43127))
  expect(await old.observation.wait({ signal: old.controller.signal, timeoutMs: 20_000 })).toBe(43127)
  old.child.emit('close', 0, null)
  await expect(old.observation.wait({ signal: old.controller.signal, timeoutMs: 20_000 })).rejects.toThrow('caddy_listener_process_closed')
  old.released()
  const current = fixture()
  const wait = current.observation.wait({ signal: current.controller.signal, timeoutMs: 20_000 })
  expect(vi.getTimerCount()).toBe(1)
  current.child.stderr.write(record(43128))
  expect(await wait).toBe(43128)
  current.observation.dispose()
  current.released()
})
