import { createSecureContext, TLSSocket } from 'node:tls'
import { createServer, type Socket } from 'node:net'
import { generate } from 'selfsigned'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { waitForCaddyTls } from './helpers/caddy-tls-ready.js'

let certificate: { cert: string; private: string }
let otherCertificate: { cert: string; private: string }
beforeAll(async () => {
  const options = { keyType: 'ec' as const, curve: 'P-256' as const, algorithm: 'sha256', extensions: [
    { name: 'basicConstraints' as const, cA: true },
    { name: 'subjectAltName' as const, altNames: [{ type: 2 as const, value: 'phone.example.com' }] },
  ] }
  certificate = await generate([{ name: 'commonName', value: 'phone.example.com' }], options)
  otherCertificate = await generate([{ name: 'commonName', value: 'other-ca.example.com' }], options)
})
const cleanups: (() => Promise<void>)[] = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(yes => { resolve = yes })
  return { promise, resolve }
}

async function serverFixture({ hold = false, reset = false }: { hold?: boolean; reset?: boolean } = {}) {
  const context = createSecureContext({ key: certificate.private, cert: certificate.cert })
  const entered = deferred<void>(); const secondEntered = deferred<void>(); const rejected = deferred<void>()
  const sockets = new Set<Socket>(); const socketClosures: Promise<void>[] = []
  let ready = false; let attempts = 0; let applicationBytes = 0
  const callbacks: (() => void)[] = []
  const server = createServer(socket => {
    attempts++
    if (attempts === 2) secondEntered.resolve()
    if (ready) {
      const tls = new TLSSocket(socket, { isServer: true, secureContext: context })
      tls.on('error', () => { /* The client reports rejected trust/name checks. */ })
      tls.on('data', (bytes: Buffer) => { applicationBytes += bytes.length }); tls.resume()
      return
    }
    socket.once('data', () => {
      entered.resolve()
      const pending = (): void => {
        // A Go GetCertificate failure sends fatal alert 80, not Node's SNI-callback TCP reset.
        if (reset) socket.destroy()
        else socket.end(Buffer.from([21, 3, 3, 0, 2, 2, 80]))
        rejected.resolve()
      }
      if (hold) callbacks.push(pending)
      else pending()
    })
  })
  server.on('connection', socket => {
    sockets.add(socket)
    socketClosures.push(new Promise<void>(resolve => { socket.once('close', () => { sockets.delete(socket); resolve() }) }))
  })
  cleanups.push(async () => {
    for (const callback of callbacks.splice(0)) callback()
    for (const socket of sockets) socket.destroy()
    await Promise.all(socketClosures)
    await new Promise<void>((resolve, reject) => { server.close(error => error ? reject(error) : resolve()) })
  })
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('Missing TLS fixture listener')
  return { port: address.port, entered: entered.promise, secondEntered: secondEntered.promise, rejected: rejected.promise,
    ready: () => { ready = true }, release: () => { for (const callback of callbacks.splice(0)) callback() },
    attempts: () => attempts, applicationBytes: () => applicationBytes,
    closed: async () => { await Promise.all(socketClosures); expect(sockets.size).toBe(0) } }
}

function options(port: number, signal = new AbortController().signal) {
  return { port, ca: certificate.cert, servername: 'phone.example.com', signal, timeoutMs: 2_000, intervalMs: 10 }
}

function controlledDeadline(budget: number) {
  const nativeTimeout = globalThis.setTimeout
  const requested: number[] = []; const handles: NodeJS.Timeout[] = []; const callbacks: (() => void)[] = []
  const spy = vi.spyOn(globalThis, 'setTimeout').mockImplementation(((...args: Parameters<typeof setTimeout>) => {
    const [callback, duration, ...values] = args
    if (duration !== budget) return nativeTimeout(callback, duration, ...values)
    requested.push(duration)
    callbacks.push(() => callback(...values))
    const handle = nativeTimeout(callback, 30_000, ...values)
    handles.push(handle)
    return handle
  }) as typeof setTimeout)
  return {
    fire() { expect(requested).toEqual([budget]); callbacks[0]!() },
    single() { expect(requested).toEqual([budget]) },
    restore() { for (const handle of handles) clearTimeout(handle); spy.mockRestore() },
  }
}

describe('Caddy fixture TLS readiness', () => {
  it('waits across a controlled pending-certificate barrier and never sends an HTTP request', async () => {
    const fixture = await serverFixture({ hold: true })
    let completed = false
    const waiting = waitForCaddyTls(options(fixture.port)).then(() => { completed = true })
    await fixture.entered
    expect(completed).toBe(false)
    fixture.release()
    await fixture.rejected
    expect(completed).toBe(false)
    fixture.ready()
    await waiting
    expect(fixture.attempts()).toBe(2)
    expect(fixture.applicationBytes()).toBe(0)
    await fixture.closed()
  })

  it('rejects an untrusted CA on the first handshake rather than retrying it', async () => {
    const fixture = await serverFixture(); fixture.ready()
    await expect(waitForCaddyTls({ ...options(fixture.port), ca: otherCertificate.cert })).rejects.toMatchObject({ code: 'DEPTH_ZERO_SELF_SIGNED_CERT' })
    expect(fixture.attempts()).toBe(1)
    expect(fixture.applicationBytes()).toBe(0)
    await fixture.closed()
  })

  it('rejects a hostname mismatch on the first handshake', async () => {
    const fixture = await serverFixture(); fixture.ready()
    await expect(waitForCaddyTls({ ...options(fixture.port), servername: 'wrong.example.com' })).rejects.toMatchObject({ code: 'ERR_TLS_CERT_ALTNAME_INVALID' })
    expect(fixture.attempts()).toBe(1)
    await fixture.closed()
  })

  it('aborts a held handshake, preserves the caller reason and closes the owned connection', async () => {
    const fixture = await serverFixture({ hold: true })
    const abort = new AbortController(); const reason = new Error('fixture_cancelled')
    const result = waitForCaddyTls(options(fixture.port, abort.signal)).catch((error: unknown) => error)
    await fixture.entered
    abort.abort(reason)
    expect(await result).toBe(reason)
    fixture.release()
    await fixture.closed()
    expect(fixture.attempts()).toBe(1)
    expect(fixture.applicationBytes()).toBe(0)
  })

  it('has one total deadline across pending-certificate alerts and closes every attempt', async () => {
    const fixture = await serverFixture()
    const deadline = controlledDeadline(150); const abort = new AbortController()
    const waiting = waitForCaddyTls({ ...options(fixture.port, abort.signal), timeoutMs: 150 })
    const settled = waiting.catch((_error: unknown) => { /* The original promise is asserted below. */ })
    let disposed = false
    const dispose = async (): Promise<void> => {
      if (disposed) return
      disposed = true; abort.abort(new Error('Controlled deadline fixture cleanup'))
      try { await settled } finally { deadline.restore() }
    }
    cleanups.push(dispose)
    try {
      await Promise.race([fixture.entered, waiting.then(() => { throw new Error('Readiness completed before the first connection') })])
      await Promise.race([fixture.secondEntered, waiting.then(() => { throw new Error('Readiness completed before the second connection') })])
      deadline.single(); deadline.fire()
      await expect(waiting).rejects.toThrow('caddy_tls_ready_timeout')
      deadline.single()
      expect(fixture.attempts()).toBeGreaterThan(1)
      await fixture.closed()
      expect(fixture.applicationBytes()).toBe(0)
    } finally { await dispose() }
  })

  it('closes a handshake that never receives its pending certificate at the deadline', async () => {
    const fixture = await serverFixture({ hold: true })
    const deadline = controlledDeadline(150); const abort = new AbortController()
    const waiting = waitForCaddyTls({ ...options(fixture.port, abort.signal), timeoutMs: 150 })
    const settled = waiting.catch((_error: unknown) => { /* The original promise is asserted below. */ })
    let disposed = false
    const dispose = async (): Promise<void> => {
      if (disposed) return
      disposed = true; abort.abort(new Error('Controlled deadline fixture cleanup'))
      try { await settled } finally { deadline.restore() }
    }
    cleanups.push(dispose)
    try {
      await Promise.race([fixture.entered, waiting.then(() => { throw new Error('Readiness completed before its held handshake') })])
      deadline.single(); deadline.fire()
      await expect(waiting).rejects.toThrow('caddy_tls_ready_timeout')
      deadline.single()
      fixture.release()
      await fixture.closed()
      expect(fixture.attempts()).toBe(1)
      expect(fixture.applicationBytes()).toBe(0)
    } finally { await dispose() }
  })

  it('does not open a connection when the caller already aborted or the process exited', async () => {
    const fixture = await serverFixture()
    const abort = new AbortController(); const reason = new Error('already_cancelled'); abort.abort(reason)
    await expect(waitForCaddyTls(options(fixture.port, abort.signal))).rejects.toBe(reason)
    await expect(waitForCaddyTls({ ...options(fixture.port), isRunning: () => false })).rejects.toThrow('caddy_tls_process_exited')
    expect(fixture.attempts()).toBe(0)
    await fixture.closed()
  })

  it('does not treat an unexplained connection reset as a pending-certificate alert', async () => {
    const fixture = await serverFixture({ reset: true })
    await expect(waitForCaddyTls(options(fixture.port))).rejects.toMatchObject({ code: 'ECONNRESET' })
    expect(fixture.attempts()).toBe(1)
    await fixture.closed()
  })
})
