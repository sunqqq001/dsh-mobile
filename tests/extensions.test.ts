import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { getEventListeners, once } from 'node:events'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { combineSignals, disposeLateExtensionResponse, EXTENSION_LIMITS, MobileAccessService, MobileExtensionError, parseExtensionManifest } from '../src/extensions.js'

const contexts: Context[] = []
const directories: string[] = []
const services: { service: MobileAccessService; context: Context }[] = []

function createService(context: Context): MobileAccessService {
  const service = new MobileAccessService(context)
  services.push({ service, context })
  return service
}

afterEach(async () => {
  vi.useRealTimers()
  const errors: unknown[] = []
  const owned = services.splice(0)
  const stopped = await Promise.allSettled(owned.map(({ service }) => service.stopLocal()))
  const retainedContexts = new Set<Context>()
  for (const [index, result] of stopped.entries()) {
    if (result.status === 'rejected') {
      const reason: unknown = result.reason; errors.push(reason)
      retainedContexts.add(owned[index]!.context)
    }
  }
  const disposed = await Promise.allSettled(contexts.splice(0).filter(context => !retainedContexts.has(context)).map(context => context.fiber.dispose()))
  for (const result of disposed) if (result.status === 'rejected') { const reason: unknown = result.reason; errors.push(reason) }
  // Retain owned directories when a service did not confirm its watcher/refresh had stopped.
  if (stopped.every(result => result.status === 'fulfilled')) {
    const removed = await Promise.allSettled(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
    for (const result of removed) if (result.status === 'rejected') { const reason: unknown = result.reason; errors.push(reason) }
  }
  const retainedDirectories = directories.splice(0)
  if (errors.length > 0) throw new AggregateError(errors, 'Extension test fixture cleanup failed'
    + (retainedDirectories.length === 0 ? '' : '; retained owned directories: ' + retainedDirectories.join(', ')))
})

async function createExtension(root: string, host: string, script = 'window.dshMobile.define({ apiVersion: 1, id: "demo", activate() {} })'): Promise<string> {
  const directory = join(root, 'demo')
  await mkdir(directory, { recursive: true })
  await writeFile(join(directory, 'extension.json'), JSON.stringify({ schemaVersion: 1, id: 'demo', name: 'Demo', version: '1.0.0' }))
  await writeFile(join(directory, 'mobile.js'), script)
  await writeFile(join(directory, 'host.mjs'), host)
  return directory
}

describe('mobile extension registry', () => {
  it('matches a root prefix while keeping other prefixes within their path segments', async () => {
    const context = new Context(); contexts.push(context)
    const service = createService(context)
    service.registerExtension({ schemaVersion: 1, id: 'root-route', name: 'Root', version: '1', routes: [
      { method: 'GET', path: '/', kind: 'prefix', handle: request => ({ body: request.pathname }) },
    ] })
    service.registerExtension({ schemaVersion: 1, id: 'files-route', name: 'Files', version: '1', routes: [
      { method: 'GET', path: '/files', kind: 'prefix', handle: request => ({ body: request.pathname }) },
    ] })
    const request = (pathname: string) => ({ method: 'GET', pathname, query: new URLSearchParams(), headers: {}, body: new Uint8Array(), deviceId: 'device', signal: new AbortController().signal })
    for (const pathname of ['/', '/child', '/child/nested']) {
      await expect(service.route('root-route', 'GET', pathname, request(pathname))).resolves.toEqual({ body: pathname })
    }
    for (const pathname of ['/files', '/files/child']) {
      await expect(service.route('files-route', 'GET', pathname, request(pathname))).resolves.toEqual({ body: pathname })
    }
    await expect(service.route('files-route', 'GET', '/files-other', request('/files-other'))).rejects.toMatchObject({ code: 'route_not_found' })
    await expect(service.route('root-route', 'POST', '/child', { ...request('/child'), method: 'POST' })).rejects.toMatchObject({ code: 'route_not_found' })
  })
  it('snapshots operation budgets without changing class-based host method receivers', async () => {
    vi.useFakeTimers()
    class Action {
      #prefix = 'action:'
      timeoutMs = 50
      get input(): { parse(value: unknown): unknown } { return { parse: value => String(value) } }
      run(_context: unknown, value: unknown): Promise<string> {
        return new Promise(resolve => { setTimeout(() => resolve(this.#prefix + String(value)), 10) })
      }
    }
    class Route {
      #body = 'route'
      method = 'GET'
      path = 'status'
      timeoutMs = 50
      handle(): Promise<{ body: string }> {
        return new Promise(resolve => { setTimeout(() => resolve({ body: this.#body }), 10) })
      }
    }
    const context = new Context(); contexts.push(context)
    const service = createService(context)
    const action = new Action()
    const route = new Route()
    service.registerExtension({ schemaVersion: 1, id: 'class-host', name: 'ClassHost', version: '1', actions: { echo: action }, routes: [route] })
    action.timeoutMs = 1
    route.timeoutMs = 1
    const base = { deviceId: 'device', signal: new AbortController().signal }
    const invocation = service.invoke('class-host', 'echo', 42, base)
    await vi.advanceTimersByTimeAsync(10)
    await expect(invocation).resolves.toBe('action:42')
    const routed = service.route('class-host', 'GET', '/status', { ...base, method: 'GET', pathname: '/status', query: new URLSearchParams(), headers: {}, body: new Uint8Array() })
    await vi.advanceTimersByTimeAsync(10)
    await expect(routed).resolves.toEqual({ body: 'route' })
  })

  it('does not attach generation or caller listeners for rejected local-extension dispatches', async () => {
    vi.useFakeTimers()
    const root = await mkdtemp(join(tmpdir(), 'dsh-mobile-admission-')); directories.push(root)
    await createExtension(root, `export default api => {
      api.action('hang', { timeoutMs: 50, run: () => new Promise(() => {}) })
      api.action('ping', { run: () => 'pong' })
      api.route({ method: 'GET', path: 'status', handle: () => ({ body: 'ok' }) })
    }`)
    const context = new Context(); contexts.push(context)
    const service = createService(context)
    await service.startLocal(root, context)
    const generation = service.signal('demo')!
    const caller = new AbortController()
    const base = { deviceId: 'device', signal: caller.signal }
    const hanging = service.invoke('demo', 'hang', {}, base)
    const rejected = expect(hanging).rejects.toMatchObject({ code: 'extension_action_timeout' })
    await vi.advanceTimersByTimeAsync(50)
    await rejected
    const generationListeners = getEventListeners(generation, 'abort').length
    const callerListeners = getEventListeners(caller.signal, 'abort').length
    for (let index = 0; index < 12; index++) {
      await expect(service.invoke('demo', 'ping', {}, base)).rejects.toMatchObject({ code: 'extension_busy' })
      await expect(service.route('demo', 'GET', '/status', { ...base, method: 'GET', pathname: '/status', query: new URLSearchParams(), headers: {}, body: new Uint8Array() })).rejects.toMatchObject({ code: 'extension_busy' })
    }
    expect(getEventListeners(generation, 'abort')).toHaveLength(generationListeners)
    expect(getEventListeners(caller.signal, 'abort')).toHaveLength(callerListeners)
    await service.stopLocal()
  })

  it('ignores malformed late response getters and stream-like values during disposal', () => {
    expect(() => disposeLateExtensionResponse({ get body() { throw new Error('bad getter') } })).not.toThrow()
    expect(() => disposeLateExtensionResponse({ body: { pipe() {}, destroy() {} } })).not.toThrow()
  })

  it('validates manifests and rejects duplicate ids', () => {
    expect(parseExtensionManifest({ schemaVersion: 1, id: 'hello-world', name: 'Hello', version: '1.0.0' })).toMatchObject({ id: 'hello-world' })
    expect(() => parseExtensionManifest({ schemaVersion: 1, id: '../escape', name: 'bad', version: '1' })).toThrow(MobileExtensionError)
    const context = new Context(); contexts.push(context)
    const service = createService(context)
    const definition = { schemaVersion: 1 as const, id: 'sample', name: 'Sample', version: '1.0.0', actions: { ping: { run: async () => ({ ok: true }) } } }
    const dispose = service.registerExtension(definition)
    expect(() => service.registerExtension(definition)).toThrow(/already registered/)
    expect(service.manifest()).toEqual([{ schemaVersion: 1, id: 'sample', name: 'Sample', version: '1.0.0' }])
    dispose()
    expect(service.manifest()).toEqual([])
  })

  it('validates per-action and per-route operation timeout bounds', () => {
    const context = new Context(); contexts.push(context)
    const service = createService(context)
    const actionWith = (id: string, timeoutMs: unknown): void => {
      service.registerExtension({
        schemaVersion: 1, id, name: 'Timed', version: '1.0.0',
        actions: { slow: { ...(timeoutMs === undefined ? {} : { timeoutMs: timeoutMs as number }), run: async () => true } },
      })
    }
    expect(() => actionWith('timed-min', 1)).not.toThrow()
    expect(() => actionWith('timed-max', 300_000)).not.toThrow()
    expect(() => actionWith('timed-absent', undefined)).not.toThrow()
    const invalid = [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, '30000', null, 300_001]
    for (const [index, value] of invalid.entries()) {
      expect(() => actionWith(`timed-invalid-${String(index)}`, value)).toThrow(MobileExtensionError)
    }
    const routeWith = (id: string, timeoutMs: unknown): void => {
      service.registerExtension({
        schemaVersion: 1, id, name: 'Timed', version: '1.0.0',
        routes: [{ method: 'GET', path: 'status', ...(timeoutMs === undefined ? {} : { timeoutMs: timeoutMs as number }), handle: async () => ({ body: 'ok' }) }],
      })
    }
    expect(() => routeWith('timed-route-ok', 30_000)).not.toThrow()
    expect(() => routeWith('timed-route-absent', undefined)).not.toThrow()
    for (const [index, value] of invalid.entries()) {
      expect(() => routeWith(`timed-route-invalid-${String(index)}`, value)).toThrow(MobileExtensionError)
    }
  })

  it('bounds hanging actions with the default and overridden deadlines, including input parsing', async () => {
    vi.useFakeTimers()
    const context = new Context(); contexts.push(context)
    const service = createService(context)
    const hanging = (id: string, action: Record<string, unknown>): void => {
      service.registerExtension({ schemaVersion: 1, id, name: 'Hanging', version: '1.0.0', actions: action as never })
    }
    let observed: AbortSignal | undefined
    hanging('hanging-never', { never: { run: ({ signal }: { signal: AbortSignal }) => { observed = signal; return new Promise(() => {}) } } })
    hanging('hanging-quick', { quick: { timeoutMs: 50, run: () => new Promise(() => {}) } })
    hanging('hanging-parse', { 'parse-hang': { timeoutMs: 50, input: () => new Promise(() => {}), run: async () => true } })
    const request = new AbortController()
    const base = { deviceId: 'device', signal: request.signal }
    const never = service.invoke('hanging-never', 'never', {}, base)
    const neverRejected = expect(never).rejects.toMatchObject({ code: 'extension_action_timeout', status: 500 })
    await vi.advanceTimersByTimeAsync(30_000)
    await neverRejected
    expect(observed?.aborted).toBe(true)
    expect(request.signal.aborted).toBe(false)
    const quick = service.invoke('hanging-quick', 'quick', {}, base)
    const quickRejected = expect(quick).rejects.toMatchObject({ code: 'extension_action_timeout' })
    await vi.advanceTimersByTimeAsync(50)
    await quickRejected
    const parseHang = service.invoke('hanging-parse', 'parse-hang', {}, base)
    const parseRejected = expect(parseHang).rejects.toMatchObject({ code: 'extension_action_timeout' })
    await vi.advanceTimersByTimeAsync(50)
    await parseRejected
    vi.useRealTimers()
  })

  it('never dispatches run after cancellation during input parsing', async () => {
    vi.useFakeTimers()
    const context = new Context(); contexts.push(context)
    const service = createService(context)
    let resolveParse: ((value: unknown) => void) | undefined
    let ran = false
    service.registerExtension({
      schemaVersion: 1, id: 'parse-cancel', name: 'ParseCancel', version: '1.0.0',
      actions: {
        deferred: {
          timeoutMs: 50,
          input: () => new Promise(resolve => { resolveParse = resolve }),
          run: () => { ran = true; return 'x' },
        },
        ok: { run: async () => 'fine' },
      },
    })
    const base = { deviceId: 'device', signal: new AbortController().signal }
    const timed = service.invoke('parse-cancel', 'deferred', {}, base)
    const timedRejected = expect(timed).rejects.toMatchObject({ code: 'extension_action_timeout' })
    await vi.advanceTimersByTimeAsync(50)
    await timedRejected
    resolveParse?.({})
    await vi.advanceTimersByTimeAsync(1)
    expect(ran).toBe(false)
    await expect(service.invoke('parse-cancel', 'ok', {}, base)).resolves.toBe('fine')
    const caller = new AbortController()
    const cancelledParse = service.invoke('parse-cancel', 'deferred', {}, { deviceId: 'device', signal: caller.signal })
    const cancelledRejected = expect(cancelledParse).rejects.toThrow('gone')
    caller.abort(new Error('gone'))
    await cancelledRejected
    resolveParse?.({})
    await vi.advanceTimersByTimeAsync(1)
    expect(ran).toBe(false)
    vi.useRealTimers()
  })

  it('disposes late route results defensively after detachment', async () => {
    const unhandled: unknown[] = []
    const onUnhandled = (reason: unknown): void => { unhandled.push(reason) }
    process.on('unhandledRejection', onUnhandled)
    try {
      vi.useFakeTimers()
      const context = new Context(); contexts.push(context)
      const service = createService(context)
      let failing: PassThrough | undefined
      service.registerExtension({
        schemaVersion: 1, id: 'late-null', name: 'LateNull', version: '1.0.0',
        routes: [
          { method: 'GET', path: 'null-late', timeoutMs: 50, handle: () => new Promise(resolve => { setTimeout(() => resolve(null as never), 100) }) },
        ],
      })
      service.registerExtension({
        schemaVersion: 1, id: 'late-failing', name: 'LateFailing', version: '1.0.0',
        routes: [
          { method: 'GET', path: 'failing-stream', timeoutMs: 50, handle: () => new Promise(resolve => { setTimeout(() => { failing = new PassThrough({ destroy(_error, callback) { callback(new Error('destroy failed')) } }); resolve({ body: failing }) }, 100) }) },
        ],
      })
      const baseRequest = { method: 'GET', pathname: '', query: new URLSearchParams(), headers: {}, body: new Uint8Array(), deviceId: 'device', signal: new AbortController().signal }
      const nullLate = service.route('late-null', 'GET', '/null-late', { ...baseRequest, pathname: '/null-late' })
      const nullRejected = expect(nullLate).rejects.toMatchObject({ code: 'extension_route_timeout' })
      await vi.advanceTimersByTimeAsync(50)
      await nullRejected
      const failingCall = service.route('late-failing', 'GET', '/failing-stream', { ...baseRequest, pathname: '/failing-stream' })
      const failingRejected = expect(failingCall).rejects.toMatchObject({ code: 'extension_route_timeout' })
      await vi.advanceTimersByTimeAsync(50)
      await failingRejected
      await vi.advanceTimersByTimeAsync(60)
      expect(unhandled).toEqual([])
      expect(failing?.destroyed).toBe(true)
      vi.useRealTimers()
    } finally {
      process.off('unhandledRejection', onUnhandled)
    }
  })

  it('clears caller-wait resources when an operation is externally cancelled', async () => {
    vi.useFakeTimers()
    const context = new Context(); contexts.push(context)
    const service = createService(context)
    service.registerExtension({
      schemaVersion: 1, id: 'long-hang', name: 'LongHang', version: '1.0.0',
      actions: { hang: { timeoutMs: 300_000, run: () => new Promise(() => {}) } },
    })
    const caller = new AbortController()
    const call = service.invoke('long-hang', 'hang', {}, { deviceId: 'device', signal: caller.signal })
    const rejected = expect(call).rejects.toThrow('gone')
    caller.abort(new Error('gone'))
    await rejected
    await vi.advanceTimersByTimeAsync(0)
    expect(vi.getTimerCount()).toBe(0)
    vi.useRealTimers()
  })

  it('bounds hanging route handlers while keeping resolved stream lifetimes untouched', async () => {
    vi.useFakeTimers()
    const context = new Context(); contexts.push(context)
    const service = createService(context)
    const routing = (id: string, routes: unknown): void => {
      service.registerExtension({ schemaVersion: 1, id, name: 'Routing', version: '1.0.0', routes: routes as never })
    }
    let observed: AbortSignal | undefined
    let lateStream: PassThrough | undefined
    routing('routing-hang', [{ method: 'GET', path: 'hang', handle: () => new Promise<never>(() => {}) }])
    routing('routing-quick', [{ method: 'GET', path: 'quick-hang', timeoutMs: 50, handle: () => new Promise<never>(() => {}) }])
    routing('routing-live', [{ method: 'GET', path: 'live-stream', timeoutMs: 50, handle: ({ signal }: { signal: AbortSignal }) => { observed = signal; return { body: new PassThrough() } } }])
    routing('routing-late', [{ method: 'GET', path: 'late-stream', timeoutMs: 50, handle: () => new Promise(resolve => { setTimeout(() => { lateStream = new PassThrough(); resolve({ body: lateStream }) }, 100) }) }])
    const baseRequest = { method: 'GET', pathname: '', query: new URLSearchParams(), headers: {}, body: new Uint8Array(), deviceId: 'device', signal: new AbortController().signal }
    const hang = service.route('routing-hang', 'GET', '/hang', { ...baseRequest, pathname: '/hang' })
    const hangRejected = expect(hang).rejects.toMatchObject({ code: 'extension_route_timeout', status: 500 })
    await vi.advanceTimersByTimeAsync(30_000)
    await hangRejected
    const quick = service.route('routing-quick', 'GET', '/quick-hang', { ...baseRequest, pathname: '/quick-hang' })
    const quickRejected = expect(quick).rejects.toMatchObject({ code: 'extension_route_timeout' })
    await vi.advanceTimersByTimeAsync(50)
    await quickRejected
    const late = service.route('routing-late', 'GET', '/late-stream', { ...baseRequest, pathname: '/late-stream' })
    const lateRejected = expect(late).rejects.toMatchObject({ code: 'extension_route_timeout' })
    await vi.advanceTimersByTimeAsync(100)
    await lateRejected
    expect(lateStream?.destroyed).toBe(true)
    const live = await service.route('routing-live', 'GET', '/live-stream', { ...baseRequest, pathname: '/live-stream' })
    const stream = live.body as PassThrough
    await vi.advanceTimersByTimeAsync(500)
    expect(stream.destroyed).toBe(false)
    expect(observed?.aborted).toBe(false)
    const ended = once(stream, 'end')
    stream.resume(); stream.end()
    await ended
    vi.useRealTimers()
  })

  it('gates dispatch on abandoned work, keeps siblings running, and recovers on settlement', async () => {
    vi.useFakeTimers()
    const context = new Context(); contexts.push(context)
    const service = createService(context)
    let observedCancel: AbortSignal | undefined
    service.registerExtension({
      schemaVersion: 1, id: 'abandoned', name: 'Abandoned', version: '1.0.0',
      actions: {
        'ok-slow': { run: () => new Promise(resolve => { setTimeout(() => resolve('slow-ok'), 80) }) },
        'hang-timeout': { timeoutMs: 50, run: () => new Promise(() => {}) },
        'late-reject': { timeoutMs: 50, run: () => new Promise((_, reject) => { setTimeout(() => reject(new Error('late')), 150) }) },
        'hang-cancel': { timeoutMs: 300_000, run: ({ signal }) => { observedCancel = signal; return new Promise(() => {}) } },
        ok: { run: async () => 'fine' },
      },
    })
    const base = { deviceId: 'device', signal: new AbortController().signal }
    const pre = new AbortController()
    pre.abort(new Error('already gone'))
    await expect(service.invoke('abandoned', 'ok', {}, { deviceId: 'device', signal: pre.signal })).rejects.toThrow('already gone')
    await expect(service.invoke('abandoned', 'ok', {}, base)).resolves.toBe('fine')
    const slow = service.invoke('abandoned', 'ok-slow', {}, base)
    const late = service.invoke('abandoned', 'late-reject', {}, base)
    const lateRejected = expect(late).rejects.toMatchObject({ code: 'extension_action_timeout' })
    await vi.advanceTimersByTimeAsync(50)
    await lateRejected
    await expect(service.invoke('abandoned', 'ok', {}, base)).rejects.toMatchObject({ code: 'extension_busy', status: 503 })
    await vi.advanceTimersByTimeAsync(30)
    await expect(slow).resolves.toBe('slow-ok')
    await expect(service.invoke('abandoned', 'ok', {}, base)).rejects.toMatchObject({ code: 'extension_busy', status: 503 })
    await vi.advanceTimersByTimeAsync(100)
    await expect(service.invoke('abandoned', 'ok', {}, base)).resolves.toBe('fine')
    const hang = service.invoke('abandoned', 'hang-timeout', {}, base)
    const hangRejected = expect(hang).rejects.toMatchObject({ code: 'extension_action_timeout' })
    await vi.advanceTimersByTimeAsync(50)
    await hangRejected
    await expect(service.invoke('abandoned', 'ok', {}, base)).rejects.toMatchObject({ code: 'extension_busy', status: 503 })
    // External cancellation detaches on a separate extension, leaving others available.
    service.registerExtension({
      schemaVersion: 1, id: 'abandoned-cancel', name: 'Abandoned', version: '1.0.0',
      actions: {
        'hang-cancel': { timeoutMs: 300_000, run: ({ signal }) => { observedCancel = signal; return new Promise(() => {}) } },
        ok: { run: async () => 'fine' },
      },
    })
    const caller = new AbortController()
    const cancelled = service.invoke('abandoned-cancel', 'hang-cancel', {}, { deviceId: 'device', signal: caller.signal })
    const cancelledRejected = expect(cancelled).rejects.toThrow('caller went away')
    await vi.advanceTimersByTimeAsync(0)  // let the action start before cancelling it
    caller.abort(new Error('caller went away'))
    await cancelledRejected
    expect(observedCancel?.aborted).toBe(true)
    await expect(service.invoke('abandoned-cancel', 'ok', {}, base)).rejects.toMatchObject({ code: 'extension_busy', status: 503 })
    await expect(service.invoke('abandoned', 'ok', {}, base)).rejects.toMatchObject({ code: 'extension_busy', status: 503 })
    vi.useRealTimers()
  })

  it('loads local host actions and swaps generations without exposing traversal', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-mobile-extensions-')); directories.push(root)
    const directory = join(root, 'demo')
    await (await import('node:fs/promises')).mkdir(directory, { recursive: true })
    await writeFile(join(directory, 'extension.json'), JSON.stringify({ schemaVersion: 1, id: 'demo', name: 'Demo', version: '1.0.0' }))
    await writeFile(join(directory, 'mobile.js'), 'window.dshMobile.define({ apiVersion: 1, id: "demo", activate() {} })')
    await writeFile(join(directory, 'host.mjs'), 'export default async api => api.action("ping", { async run() { return { version: 1 } } })')
    const context = new Context(); contexts.push(context)
    const service = createService(context)
    await service.startLocal(root, context)
    expect(service.manifest()).toMatchObject([{
      id: 'demo',
      generation: expect.stringMatching(/^[a-f\d]{64}$/u),
      scriptUrl: expect.stringContaining('/mobile-access/extensions/demo/mobile.js?generation='),
      assetsUrl: '/mobile-access/extensions/demo/assets/',
    }])
    await expect(service.invoke('demo', 'ping', {}, { deviceId: 'device', signal: new AbortController().signal })).resolves.toEqual({ version: 1 })
    const revoked = new AbortController()
    revoked.abort(new Error('device_revoked'))
    await expect(service.readClientFile('demo', 'script', revoked.signal)).rejects.toThrow('device_revoked')
    await expect(service.readAsset('demo', '../secret')).rejects.toThrow()
    await writeFile(join(directory, 'host.mjs'), 'export default async api => api.action("ping", { async run() { return { version: 2 } } })')
    await service.refreshLocal()
    await expect(service.invoke('demo', 'ping', {}, { deviceId: 'device', signal: new AbortController().signal })).resolves.toEqual({ version: 2 })
    await service.stopLocal()
    expect(service.manifest()).toEqual([])
  })

  it('accepts callable Schemastery schemas and parse adapters for action input', async () => {
    const context = new Context(); contexts.push(context)
    const service = createService(context)
    service.registerExtension({
      schemaVersion: 1,
      id: 'callable',
      name: 'Callable',
      version: '1.0.0',
      actions: {
        echo: {
          input: z.object({ name: z.string() }),
          run: async (_context, input) => input,
        },
      },
    })
    service.registerExtension({
      schemaVersion: 1,
      id: 'adapter',
      name: 'Adapter',
      version: '1.0.0',
      actions: {
        echo: {
          input: { parse: value => ({ normalized: String((value as { name?: unknown }).name ?? '') }) },
          run: async (_context, input) => input,
        },
      },
    })
    const request = { deviceId: 'device', signal: new AbortController().signal }
    await expect(service.invoke('callable', 'echo', { name: 'Ada' }, request)).resolves.toEqual({ name: 'Ada' })
    await expect(service.invoke('adapter', 'echo', { name: 42 }, request)).resolves.toEqual({ normalized: '42' })
    await expect(service.invoke('callable', 'echo', { name: 42 }, request)).rejects.toMatchObject({ code: 'invalid_action_input', status: 400 })
  })

  it('keeps the immediately previous Host generation while the browser stages new UI', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout'] })
    const root = await mkdtemp(join(tmpdir(), 'dsh-mobile-extension-generations-')); directories.push(root)
    const directory = await createExtension(root, 'export default async api => api.action("ping", { async run() { return { version: 1 } } })')
    const context = new Context(); contexts.push(context)
    const service = createService(context)
    await service.startLocal(root, context)
    const first = service.manifest()[0]?.generation
    let changes = 0
    service.onContentChanged(() => { changes += 1 })
    expect(first).toMatch(/^[a-f\d]{64}$/u)

    await writeFile(join(directory, 'host.mjs'), 'export default async api => api.action("ping", { async run() { return { version: 2 } } })')
    await service.refreshLocal()
    const second = service.manifest()[0]?.generation
    expect(second).not.toBe(first)
    expect(changes).toBe(1)
    const request = { deviceId: 'device', signal: new AbortController().signal }
    await expect(service.invoke('demo', 'ping', {}, request, first)).resolves.toEqual({ version: 1 })
    await expect(service.invoke('demo', 'ping', {}, request, second)).resolves.toEqual({ version: 2 })
    await expect(service.invoke('demo', 'ping', {}, request)).resolves.toEqual({ version: 2 })
    await vi.advanceTimersByTimeAsync(10 * 60_000 + 1)
    await expect(service.invoke('demo', 'ping', {}, request, first)).rejects.toMatchObject({ code: 'extension_not_found' })
  })

  it('removes a deleted extension generation immediately', async () => {
    const globals = globalThis as typeof globalThis & { __removedCleanup?: number; __removedSignal?: AbortSignal }
    globals.__removedCleanup = 0
    const root = await mkdtemp(join(tmpdir(), 'dsh-mobile-extension-delete-')); directories.push(root)
    const directory = await createExtension(root, `export default async api => {
      globalThis.__removedSignal = api.signal
      api.effect(() => () => { globalThis.__removedCleanup += 1 })
      api.action('ping', { async run() { return true } })
    }`)
    const context = new Context(); contexts.push(context)
    const service = createService(context)
    await service.startLocal(root, context)
    const generation = service.manifest()[0]?.generation
    expect(generation).toMatch(/^[a-f\d]{64}$/u)

    await rm(directory, { recursive: true, force: true })
    await service.refreshLocal()

    expect(service.manifest()).toEqual([])
    expect(globals.__removedSignal?.aborted).toBe(true)
    expect(globals.__removedCleanup).toBe(1)
    await expect(service.invoke('demo', 'ping', {}, { deviceId: 'device', signal: new AbortController().signal }, generation))
      .rejects.toMatchObject({ code: 'extension_not_found' })
    delete globals.__removedCleanup; delete globals.__removedSignal
  })

  it('keeps a route request lifetime until its response stream settles', async () => {
    const globals = globalThis as typeof globalThis & { __routeAborted?: number }
    globals.__routeAborted = 0
    const root = await mkdtemp(join(tmpdir(), 'dsh-mobile-extension-stream-')); directories.push(root)
    await createExtension(root, `import { PassThrough } from 'node:stream'
      export default async api => api.route({ method: 'GET', path: '/events', handle(request) {
        request.signal.addEventListener('abort', () => { globalThis.__routeAborted += 1 }, { once: true })
        return { body: new PassThrough() }
      } })`)
    const context = new Context(); contexts.push(context)
    const service = createService(context)
    await service.startLocal(root, context)
    const generation = service.manifest()[0]?.generation
    const baseRequest = { method: 'GET', pathname: '/events', query: new URLSearchParams(), headers: {}, body: new Uint8Array(), deviceId: 'device' }

    const cancelled = new AbortController()
    const cancelledRemove = vi.spyOn(cancelled.signal, 'removeEventListener')
    const cancelledResponse = await service.route('demo', 'GET', '/events', { ...baseRequest, signal: cancelled.signal }, generation)
    expect(cancelledRemove).not.toHaveBeenCalled()
    cancelled.abort('client disconnected')
    expect(globals.__routeAborted).toBe(1)
    expect(cancelledRemove).toHaveBeenCalledWith('abort', expect.any(Function))
    ;(cancelledResponse.body as PassThrough).destroy()

    const completed = new AbortController()
    const completedRemove = vi.spyOn(completed.signal, 'removeEventListener')
    const completedResponse = await service.route('demo', 'GET', '/events', { ...baseRequest, signal: completed.signal }, generation)
    const responseBody = completedResponse.body as PassThrough
    expect(completedRemove).not.toHaveBeenCalled()
    const ended = once(responseBody, 'end')
    responseBody.resume()
    responseBody.end()
    await ended
    expect(completedRemove).toHaveBeenCalledWith('abort', expect.any(Function))
    delete globals.__routeAborted
  })

  it('publishes refreshes before bounded teardown and remains refreshable when a disposer never settles', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout'] })
    const globals = globalThis as typeof globalThis & { __disposeStarted?: number }
    globals.__disposeStarted = 0
    const root = await mkdtemp(join(tmpdir(), 'dsh-mobile-extension-disposer-')); directories.push(root)
    const directory = await createExtension(root, 'export default async api => { api.effect(() => () => { globalThis.__disposeStarted += 1; return new Promise(() => {}) }); api.action("ping", { async run() { return 1 } }) }')
    const context = new Context(); contexts.push(context)
    const service = createService(context)
    try {
      await service.startLocal(root, context)
      let changes = 0
      service.onContentChanged(() => { changes += 1 })

      await writeFile(join(directory, 'host.mjs'), 'export default async api => api.action("ping", { async run() { return 2 } })')
      await expect(service.refreshLocal()).resolves.toBeUndefined()
      expect(changes).toBe(1)
      await vi.advanceTimersByTimeAsync(10 * 60_000 + 1)
      expect(globals.__disposeStarted).toBe(1)
      await writeFile(join(directory, 'host.mjs'), 'export default async api => api.action("ping", { async run() { return 3 } })')
      await expect(service.refreshLocal()).resolves.toBeUndefined()
      await expect(service.invoke('demo', 'ping', {}, { deviceId: 'device', signal: new AbortController().signal })).resolves.toBe(3)
      expect(changes).toBe(2)
    } finally {
      const stopping = service.stopLocal()
      try {
        // Finish the advisory disposer deadline while its clock still exists; real-timer restoration would discard it.
        await vi.runOnlyPendingTimersAsync()
        await stopping
      } finally { vi.useRealTimers(); delete globals.__disposeStarted }
    }
  })

  it('cancels an in-flight staging Host before stopLocal returns', async () => {
    const globals = globalThis as typeof globalThis & {
      __stopActivationGate?: Promise<void>
      __resolveStopActivation?: () => void
      __stopActivationStarted?: number
      __stopEffectSetup?: number
      __stopEffectCleanup?: number
      __stopLateEffectSetup?: number
      __stopLateRejected?: number
    }
    globals.__stopActivationGate = new Promise(resolve => { globals.__resolveStopActivation = resolve })
    globals.__stopActivationStarted = 0
    globals.__stopEffectSetup = 0
    globals.__stopEffectCleanup = 0
    globals.__stopLateEffectSetup = 0
    globals.__stopLateRejected = 0
    const root = await mkdtemp(join(tmpdir(), 'dsh-mobile-extension-stop-refresh-')); directories.push(root)
    const directory = await createExtension(root, 'export default async api => api.action("ping", { async run() { return true } })')
    const context = new Context(); contexts.push(context)
    const service = createService(context)
    await service.startLocal(root, context)
    await writeFile(join(directory, 'host.mjs'), `export default async api => {
      globalThis.__stopActivationStarted += 1
      api.effect(() => {
        globalThis.__stopEffectSetup += 1
        return () => { globalThis.__stopEffectCleanup += 1 }
      })
      await globalThis.__stopActivationGate
      try { api.effect(() => { globalThis.__stopLateEffectSetup += 1 }) }
      catch { globalThis.__stopLateRejected += 1 }
    }`)

    const refreshing = service.refreshLocal()
    await vi.waitFor(() => { expect(globals.__stopActivationStarted).toBe(1) })
    await service.stopLocal()

    expect(globals.__stopEffectSetup).toBe(1)
    expect(globals.__stopEffectCleanup).toBe(1)
    expect(service.manifest()).toEqual([])
    expect(service.status()).toEqual({ loaded: 0, failed: 0 })
    globals.__resolveStopActivation?.()
    await refreshing
    await vi.waitFor(() => { expect(globals.__stopLateRejected).toBe(1) })
    expect(globals.__stopLateEffectSetup).toBe(0)
    expect(service.manifest()).toEqual([])
    expect(service.status()).toEqual({ loaded: 0, failed: 0 })
    delete globals.__stopActivationGate; delete globals.__resolveStopActivation; delete globals.__stopActivationStarted
    delete globals.__stopEffectSetup; delete globals.__stopEffectCleanup; delete globals.__stopLateEffectSetup; delete globals.__stopLateRejected
  })

  it('does not revive the watcher when stopLocal overlaps the initial refresh', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    const globals = globalThis as typeof globalThis & {
      __startStopGate?: Promise<void>
      __resolveStartStop?: () => void
      __startStopStarted?: number
      __startStopSetup?: number
      __startStopCleanup?: number
      __startStopLateSetup?: number
      __startStopLateRejected?: number
    }
    globals.__startStopGate = new Promise(resolve => { globals.__resolveStartStop = resolve })
    globals.__startStopStarted = 0
    globals.__startStopSetup = 0
    globals.__startStopCleanup = 0
    globals.__startStopLateSetup = 0
    globals.__startStopLateRejected = 0
    const root = await mkdtemp(join(tmpdir(), 'dsh-mobile-extension-start-stop-')); directories.push(root)
    await createExtension(root, `export default async api => {
      globalThis.__startStopStarted += 1
      api.effect(() => {
        globalThis.__startStopSetup += 1
        return () => { globalThis.__startStopCleanup += 1 }
      })
      await globalThis.__startStopGate
      try { api.effect(() => { globalThis.__startStopLateSetup += 1 }) }
      catch { globalThis.__startStopLateRejected += 1 }
    }`)
    const context = new Context(); contexts.push(context)
    const service = createService(context)
    const refresh = vi.spyOn(service, 'refreshLocal')

    const starting = service.startLocal(root, context)
    await vi.waitFor(() => { expect(globals.__startStopStarted).toBe(1) })
    await Promise.all([starting, service.stopLocal()])

    expect(globals.__startStopSetup).toBe(1)
    expect(globals.__startStopCleanup).toBe(1)
    expect(service.manifest()).toEqual([])
    expect(service.status()).toEqual({ loaded: 0, failed: 0 })
    await vi.advanceTimersByTimeAsync(10_000)
    expect(refresh).toHaveBeenCalledTimes(1)
    globals.__resolveStartStop?.()
    await vi.waitFor(() => { expect(globals.__startStopLateRejected).toBe(1) })
    expect(globals.__startStopLateSetup).toBe(0)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(refresh).toHaveBeenCalledTimes(1)
    expect(service.manifest()).toEqual([])
    expect(service.status()).toEqual({ loaded: 0, failed: 0 })
    delete globals.__startStopGate; delete globals.__resolveStartStop; delete globals.__startStopStarted
    delete globals.__startStopSetup; delete globals.__startStopCleanup; delete globals.__startStopLateSetup; delete globals.__startStopLateRejected
  })

  it('snapshots assets into the generation and refreshes on asset-only changes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-mobile-extension-assets-')); directories.push(root)
    const directory = await createExtension(root, 'export default async () => undefined')
    await mkdir(join(directory, 'assets', 'nested'), { recursive: true })
    await writeFile(join(directory, 'assets', 'nested', 'value.txt'), 'one')
    const context = new Context(); contexts.push(context)
    const service = createService(context)
    await service.startLocal(root, context)
    const first = service.manifest()[0]?.generation
    let assetChanges = 0
    service.onContentChanged(() => { assetChanges += 1 })
    expect((await service.readAsset('demo', 'nested/value.txt', undefined, first)).body.toString()).toBe('one')

    await writeFile(join(directory, 'assets', 'nested', 'value.txt'), 'two')
    await service.refreshLocal()
    const second = service.manifest()[0]?.generation
    expect(second).not.toBe(first)
    expect(assetChanges).toBe(1)
    expect((await service.readAsset('demo', 'nested/value.txt', undefined, first)).body.toString()).toBe('one')
    expect((await service.readAsset('demo', 'nested/value.txt', undefined, second)).body.toString()).toBe('two')
  })

  it('rejects an assets symlink or junction that leaves the extension directory', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-mobile-extension-asset-link-')); directories.push(root)
    const outside = await mkdtemp(join(tmpdir(), 'dsh-mobile-extension-outside-')); directories.push(outside)
    const directory = await createExtension(root, 'export default async () => undefined')
    await writeFile(join(outside, 'secret.txt'), 'secret')
    await symlink(outside, join(directory, 'assets'), process.platform === 'win32' ? 'junction' : 'dir')
    const context = new Context(); contexts.push(context)
    const service = createService(context)
    await service.startLocal(root, context)
    expect(service.manifest()).toEqual([])
    expect(service.status()).toEqual({ loaded: 0, failed: 1 })
  })

  it('rejects asset trees that exceed the nesting-depth limit', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-mobile-extension-asset-depth-')); directories.push(root)
    const directory = await createExtension(root, 'export default async () => undefined')
    const segments = Array.from({ length: EXTENSION_LIMITS.assetDepth + 1 }, (_, index) => `level-${String(index)}`)
    await mkdir(join(directory, 'assets', ...segments), { recursive: true })
    const context = new Context(); contexts.push(context)
    const service = createService(context)
    await service.startLocal(root, context)
    expect(service.manifest()).toEqual([])
    expect(service.status()).toEqual({ loaded: 0, failed: 1 })
  })

  it('rejects asset trees that exceed the aggregate byte limit', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-mobile-extension-asset-bytes-')); directories.push(root)
    const directory = await createExtension(root, 'export default async () => undefined')
    const assets = join(directory, 'assets')
    await mkdir(assets, { recursive: true })
    const body = Buffer.alloc(7 * 1024 * 1024)
    for (let index = 0; index < 5; index += 1) await writeFile(join(assets, `${String(index)}.bin`), body)
    const context = new Context(); contexts.push(context)
    const service = createService(context)
    await service.startLocal(root, context)
    expect(service.manifest()).toEqual([])
    expect(service.status()).toEqual({ loaded: 0, failed: 1 })
  })

  it('rejects registrations after activation timeout and cleans an effect that resolves late', async () => {
    const globals = globalThis as typeof globalThis & { __lateSetup?: number; __lateCleanup?: number; __lateRejected?: number }
    globals.__lateSetup = 0; globals.__lateCleanup = 0; globals.__lateRejected = 0
    const root = await mkdtemp(join(tmpdir(), 'dsh-mobile-extension-timeout-')); directories.push(root)
    await createExtension(root, `export default async api => {
      api.effect(async () => { await new Promise(resolve => setTimeout(resolve, 6000)); globalThis.__lateSetup += 1; return () => { globalThis.__lateCleanup += 1 } })
      await new Promise(resolve => setTimeout(resolve, 7000))
      try { api.action('late', { async run() { return true } }) } catch { globalThis.__lateRejected += 1 }
      try { api.route({ method: 'GET', path: 'late', async handle() { return { body: 'late' } } }) } catch { globalThis.__lateRejected += 1 }
      try { api.effect(() => { globalThis.__lateSetup += 100 }) } catch { globalThis.__lateRejected += 1 }
    }`)
    const context = new Context(); contexts.push(context)
    const service = createService(context)
    await service.startLocal(root, context)
    expect(service.manifest()).toEqual([])
    await new Promise(resolve => setTimeout(resolve, 1_100))
    expect(globals.__lateSetup).toBe(1)
    expect(globals.__lateCleanup).toBe(1)
    expect(globals.__lateRejected).toBe(3)
    delete globals.__lateSetup; delete globals.__lateCleanup; delete globals.__lateRejected
  }, 12_000)

  it('keeps the complete previous client generation when a replacement host fails', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-mobile-extension-rollback-')); directories.push(root)
    const directory = join(root, 'demo')
    await (await import('node:fs/promises')).mkdir(directory, { recursive: true })
    await writeFile(join(directory, 'extension.json'), JSON.stringify({ schemaVersion: 1, id: 'demo', name: 'Demo', version: '1.0.0' }))
    await writeFile(join(directory, 'mobile.js'), 'window.goodGeneration = true')
    await writeFile(join(directory, 'mobile.css'), '.good-generation { color: green }')
    await writeFile(join(directory, 'host.mjs'), 'export default async api => api.action("ping", { async run() { return "good" } })')
    const context = new Context(); contexts.push(context)
    const service = createService(context)
    await service.startLocal(root, context)

    expect((await service.readClientFile('demo', 'script')).body.toString('utf8')).toContain('goodGeneration')
    expect((await service.readClientFile('demo', 'style')).body.toString('utf8')).toContain('good-generation')
    let committedChanges = 0
    service.onContentChanged(() => { committedChanges += 1 })
    await writeFile(join(directory, 'mobile.js'), 'window.badGeneration = true')
    await writeFile(join(directory, 'mobile.css'), '.bad-generation { color: red }')
    await writeFile(join(directory, 'host.mjs'), 'export default async () => { throw new Error("replacement failed") }')
    await service.refreshLocal()

    expect((await service.readClientFile('demo', 'script')).body.toString('utf8')).toContain('goodGeneration')
    expect((await service.readClientFile('demo', 'style')).body.toString('utf8')).toContain('good-generation')
    await expect(service.invoke('demo', 'ping', {}, { deviceId: 'device', signal: new AbortController().signal })).resolves.toBe('good')
    expect(service.status()).toEqual({ loaded: 1, failed: 1 })
    expect(committedChanges).toBe(0)
  })

  it('notifies observers only after committed registry changes', () => {
    const context = new Context(); contexts.push(context)
    const service = createService(context)
    let changes = 0
    const unsubscribe = service.onContentChanged(() => { changes += 1 })
    const dispose = service.registerExtension({ schemaVersion: 1, id: 'sample', name: 'Sample', version: '1.0.0' })
    expect(changes).toBe(1)
    dispose()
    expect(changes).toBe(2)
    unsubscribe()
    service.registerExtension({ schemaVersion: 1, id: 'other', name: 'Other', version: '1.0.0' })
    expect(changes).toBe(2)
  })

  it('combines host and request abort lifetimes without AbortSignal.any', () => {
    const generation = new AbortController()
    const request = new AbortController()
    const combined = combineSignals(generation.signal, request.signal)
    request.abort('request stopped')
    expect(combined.aborted).toBe(true)
    expect(combined.reason).toBe('request stopped')
  })
})
