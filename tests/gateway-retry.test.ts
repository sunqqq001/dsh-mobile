import { createServer, request as requestHttp, type ClientRequest, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { type Socket } from 'node:net'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MobileAccessGateway } from '../src/gateway.js'
import { parseGatewayConfig } from '../src/config.js'
import { MemoryDeviceStore } from '../src/storage.js'
import { CSRF_HEADER, SESSION_COOKIE } from '../src/http-security.js'
import { type PairingResult, type SessionAuthorization } from '../src/access.js'

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(complete => { resolve = complete })
  return { promise, resolve }
}

const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  try {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
  } finally {
    vi.restoreAllMocks()
  }
})

interface Invocation {
  readonly request: IncomingMessage
  readonly response: ServerResponse
  readonly task: Promise<void>
  readonly close: Promise<void>
  settled: boolean
  readonly initialCloseListeners: number
  readonly initialErrorListeners: number
}

interface HttpResult {
  readonly status: number
  readonly body: string
  readonly cacheControl: string | undefined
}

type ProxyMethod = (request: IncomingMessage, response: ServerResponse, authorization: SessionAuthorization) => Promise<void>

function activeRequests(instance: MobileAccessGateway): number {
  const requests: unknown = Reflect.get(instance, 'activeRequests')
  if (!(requests instanceof Map)) throw new Error('gateway request registry unavailable')
  return requests.size
}

async function fixture(
  responder: (request: IncomingMessage, response: ServerResponse) => void,
  maximumActiveRequests = 32,
): Promise<{
  gateway: MobileAccessGateway
  paired: PairingResult
  invoke: (path: string, options?: { method?: string; body?: string; transferEncoding?: string; credential?: PairingResult }) => {
    outgoing: ClientRequest
    result: Promise<HttpResult | Error>
    headers: Promise<void>
    firstChunk: Promise<void>
  }
  invocations: Invocation[]
}> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-mobile-static-retry-'))
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  const sockets = new Set<Socket>()
  const upstream: Server = createServer(responder)
  upstream.on('connection', socket => {
    sockets.add(socket)
    socket.once('close', () => sockets.delete(socket))
  })
  cleanups.push(async () => {
    for (const socket of sockets) socket.destroy()
    if (upstream.listening) await new Promise<void>(resolve => { upstream.close(() => resolve()) })
  })
  await new Promise<void>((resolve, reject) => {
    upstream.once('error', reject)
    upstream.listen(0, '127.0.0.1', resolve)
  })
  const address = upstream.address()
  if (address === null || typeof address === 'string') throw new Error('upstream TCP address unavailable')
  const config = parseGatewayConfig({
    listenHost: '127.0.0.1', listenPort: 0,
    upstreamOrigin: `http://127.0.0.1:${String(address.port)}`,
    publicAuthorities: ['127.0.0.1'], allowedCidrs: ['127.0.0.0/8'],
    stateFile: join(root, 'devices.json'), tls: { mode: 'disabled' },
    maxActiveRequests: maximumActiveRequests, upstreamTimeoutMs: 1_000,
  })
  const gateway = new MobileAccessGateway(Object.freeze({ ...config, discovery: false }), new MemoryDeviceStore())
  const invocations: Invocation[] = []
  // Observe real proxy completion so cancellation assertions also wait for its backoff to settle.
  const original: ProxyMethod = Reflect.get(gateway, 'proxyHttp')
  Reflect.set(gateway, 'proxyHttp', (request: IncomingMessage, response: ServerResponse, authorization: SessionAuthorization): Promise<void> => {
    const closed = deferred<void>()
    response.once('close', () => closed.resolve())
    const initialCloseListeners = request.listenerCount('close')
    const initialErrorListeners = request.listenerCount('error')
    const task = original.call(gateway, request, response, authorization)
    const invocation: Invocation = {
      request, response, task, close: closed.promise, settled: false,
      initialCloseListeners, initialErrorListeners,
    }
    invocations.push(invocation)
    void task.then(() => { invocation.settled = true }, () => { invocation.settled = true })
    return task
  })
  cleanups.push(async () => {
    await gateway.close()
    await Promise.allSettled(invocations.map(invocation => invocation.task))
  })
  await gateway.start()
  const pairing = await gateway.access.openPairing()
  const paired = await gateway.access.pair('fixture', pairing.token, 'Retry phone')
  const origin = gateway.address().origin
  return {
    gateway, paired, invocations,
    invoke: (path, options = {}) => {
      const gotHeaders = deferred<void>()
      const firstChunk = deferred<void>()
      const credential = options.credential ?? paired
      let outgoing!: ClientRequest
      const result = new Promise<HttpResult>((resolve, reject) => {
        outgoing = requestHttp({
          host: '127.0.0.1', port: gateway.address().port, path,
          method: options.method ?? 'GET', agent: false,
          headers: {
            host: new URL(origin).host, origin, 'sec-fetch-site': 'same-origin',
            cookie: `${SESSION_COOKIE}=${credential.sessionToken}`, [CSRF_HEADER]: credential.csrfToken,
            ...(options.transferEncoding === undefined
              ? options.body === undefined ? {} : { 'content-length': Buffer.byteLength(options.body) }
              : { 'transfer-encoding': options.transferEncoding }),
          },
        }, response => {
          gotHeaders.resolve()
          const chunks: Buffer[] = []
          response.on('data', chunk => { chunks.push(Buffer.from(chunk)); firstChunk.resolve() })
          response.once('error', reject)
          response.once('end', () => resolve({
            status: response.statusCode ?? 0,
            body: Buffer.concat(chunks).toString('utf8'),
            cacheControl: response.headers['cache-control'],
          }))
        })
        outgoing.once('error', reject)
        outgoing.end(options.body)
      }).catch((error: unknown) => error instanceof Error ? error : new Error(String(error)))
      cleanups.push(async () => { outgoing.destroy(); await result })
      return { outgoing, result, headers: gotHeaders.promise, firstChunk: firstChunk.promise }
    },
  }
}

/** Hold only the first 150ms retry timer; socket I/O and other fixture timers stay real. */
function firstBackoff(): { reached: Promise<void>; release: () => void } {
  const reached = deferred<void>()
  const original = globalThis.setTimeout
  let callback: (() => void) | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  let held = false
  vi.spyOn(globalThis, 'setTimeout').mockImplementation((handler, delay, ...args) => {
    if (delay === 150 && !held) {
      held = true
      callback = () => handler(...args)
      // A bounded watchdog is not the race condition: reached/release own that condition.
      timer = original(callback, 10_000)
      reached.resolve()
      return timer
    }
    return original(handler, delay, ...args)
  })
  const release = (): void => {
    if (timer !== undefined) clearTimeout(timer)
    const run = callback
    callback = undefined
    run?.()
  }
  cleanups.push(async () => { release() })
  return { reached: reached.promise, release }
}

describe('static pass-through retry lifecycle', () => {
  it.each([
    ['/plugins/client.js?rev=revision1234', 'private, max-age=31536000, immutable'],
    ['/assets/client-a1b2c3d4.js', 'private, max-age=31536000, immutable'],
    ['/assets/unversioned.js', 'no-store'],
  ])('replays only the bodyless static GET %s after a pre-header reset', async (path, cacheControl) => {
    let attempts = 0
    const setup = await fixture((incoming, response) => {
      if (++attempts === 1) { incoming.socket.destroy(); return }
      response.writeHead(200, { 'content-type': 'text/javascript' })
      response.end('globalThis.staticLoaded = true;')
    })
    const result = await setup.invoke(path).result
    expect(result).toMatchObject({ status: 200, body: 'globalThis.staticLoaded = true;', cacheControl })
    expect(attempts).toBe(2)
    await setup.invocations[0]!.task
    expect(activeRequests(setup.gateway)).toBe(0)
  })

  it('exhausts four pre-header resets without caching the failure or accumulating request listeners', async () => {
    let attempts = 0
    const setup = await fixture(incoming => { attempts += 1; incoming.socket.destroy() })
    const result = await setup.invoke('/assets/client-a1b2c3d4.js').result
    expect(result).toMatchObject({ status: 502, body: '{"error":"upstream_unavailable"}\n', cacheControl: 'no-store' })
    expect(attempts).toBe(4)
    const invocation = setup.invocations[0]!
    await expect(invocation.task).rejects.toMatchObject({ status: 502, code: 'upstream_unavailable' })
    expect(invocation.request.listenerCount('close')).toBeLessThanOrEqual(invocation.initialCloseListeners + 1)
    expect(invocation.request.listenerCount('error')).toBeLessThanOrEqual(invocation.initialErrorListeners + 1)
    expect(activeRequests(setup.gateway)).toBe(0)
  })

  it.each([404, 503])('passes a deterministic %s response through once without immutable caching', async status => {
    let attempts = 0
    const setup = await fixture((_incoming, response) => { attempts += 1; response.writeHead(status); response.end('rejected') })
    expect(await setup.invoke('/assets/client-a1b2c3d4.js').result).toMatchObject({ status, body: 'rejected', cacheControl: 'no-store' })
    expect(attempts).toBe(1)
  })

  it.each([
    ['HEAD', '/assets/client-a1b2c3d4.js'],
    ['POST', '/assets/client-a1b2c3d4.js'],
    ['PUT', '/plugins/client.js?rev=revision1234'],
    ['PATCH', '/plugins/client.js?rev=revision1234'],
    ['DELETE', '/assets/client-a1b2c3d4.js'],
    ['GET', '/api/session.history'],
    ['GET', '/sidebar/api/files'],
  ])('does not replay %s %s after a transport reset', async (method, path) => {
    let attempts = 0
    const setup = await fixture(incoming => { attempts += 1; incoming.socket.destroy() })
    expect(await setup.invoke(path, { method }).result).toMatchObject({ status: 502, cacheControl: 'no-store' })
    expect(attempts).toBe(1)
  })

  it.each([undefined, 'chunked'])('forwards a static GET body only once with transfer encoding %s', async transferEncoding => {
    const bodies: string[] = []
    const setup = await fixture(incoming => {
      const chunks: Buffer[] = []
      incoming.on('data', chunk => chunks.push(Buffer.from(chunk)))
      incoming.once('end', () => { bodies.push(Buffer.concat(chunks).toString()); incoming.socket.destroy() })
    })
    expect(await setup.invoke('/assets/client-a1b2c3d4.js', { body: 'payload', ...(transferEncoding === undefined ? {} : { transferEncoding }) }).result)
      .toMatchObject({ status: 502, cacheControl: 'no-store' })
    expect(bodies).toEqual(['payload'])
  })

  it.each(['headers', 'body'] as const)('does not retry after committing %s to the downstream response', async phase => {
    let attempts = 0
    let upstreamSocket: Socket | undefined
    const setup = await fixture((incoming, response) => {
      attempts += 1
      upstreamSocket = incoming.socket
      response.writeHead(200, { 'content-type': 'text/javascript', 'content-length': 100 })
      response.flushHeaders()
      if (phase === 'body') response.write('partial')
    }, 1)
    const pending = setup.invoke('/assets/client-a1b2c3d4.js')
    if (phase === 'body') await pending.firstChunk
    else await vi.waitFor(() => { expect(setup.invocations[0]?.response.headersSent).toBe(true) })
    expect(setup.invocations[0]!.response.headersSent).toBe(true)
    upstreamSocket!.destroy()
    expect(await pending.result).toBeInstanceOf(Error)
    await setup.invocations[0]!.task
    expect(attempts).toBe(1)
    expect(activeRequests(setup.gateway)).toBe(0)
  })

  it('keeps the static response idle deadline and returns one uncacheable 504 without retrying', async () => {
    let attempts = 0
    const setup = await fixture(() => { attempts += 1 })
    expect(await setup.invoke('/assets/client-a1b2c3d4.js').result)
      .toMatchObject({ status: 504, body: '{"error":"upstream_timeout"}\n', cacheControl: 'no-store' })
    expect(attempts).toBe(1)
    expect(activeRequests(setup.gateway)).toBe(0)
  })

  it.each(['caller', 'gateway', 'device'] as const)('cancels the held backoff on %s disposal and releases its single request slot', async cancelledBy => {
    const seen: string[] = []
    const setup = await fixture((incoming, response) => {
      seen.push(incoming.url ?? '')
      if (incoming.url === '/assets/client-a1b2c3d4.js') { incoming.socket.destroy(); return }
      response.end('probe')
    }, 1)
    const secondPairing = await setup.gateway.access.openPairing()
    const otherDevice = await setup.gateway.access.pair('other', secondPairing.token, 'Other phone')
    const backoff = firstBackoff()
    const pending = setup.invoke('/assets/client-a1b2c3d4.js')
    await backoff.reached
    const invocation = setup.invocations[0]!
    expect(invocation.settled).toBe(false)
    expect(activeRequests(setup.gateway)).toBe(1)
    expect(await setup.invoke('/assets/probe.js', { credential: otherDevice }).result).toMatchObject({ status: 429 })
    if (cancelledBy === 'caller') pending.outgoing.destroy()
    else if (cancelledBy === 'gateway') await setup.gateway.close()
    else await setup.gateway.access.revokeDevice(setup.paired.deviceId)
    await invocation.close
    await vi.waitFor(() => { expect(invocation.settled).toBe(true) })
    await invocation.task
    expect(await pending.result).toBeInstanceOf(Error)
    expect(activeRequests(setup.gateway)).toBe(0)
    backoff.release()
    expect(seen).toEqual(['/assets/client-a1b2c3d4.js'])
    if (cancelledBy !== 'gateway') {
      expect(await setup.invoke('/assets/probe.js', { credential: otherDevice }).result).toMatchObject({ status: 200, body: 'probe' })
      expect(seen).toEqual(['/assets/client-a1b2c3d4.js', '/assets/probe.js'])
    }
  })
})
