import type { Readable } from 'node:stream'
import { StringDecoder } from 'node:string_decoder'

interface ListenerChild {
  readonly stderr: Readable
  readonly exitCode: number | null
  readonly signalCode: NodeJS.Signals | null
  on(event: 'error', listener: (error: Error) => void): unknown
  on(event: 'close', listener: () => void): unknown
  removeListener(event: 'error', listener: (error: Error) => void): unknown
  removeListener(event: 'close', listener: () => void): unknown
}

interface ListenerWaitOptions {
  readonly signal: AbortSignal
  readonly timeoutMs: number
}

interface ListenerObservation {
  wait(options: ListenerWaitOptions): Promise<number>
  dispose(): void
}

/**
 * Observe one spawned fixture's Caddy INFO port-zero listener record before waiting for spawn.
 * The receipt is cached for that child only; TLS and HTTP readiness remain separate checks.
 * @param child - Owned child configured to write JSON logs to stderr and bind 127.0.0.1:0.
 * @returns A bounded wait and disposer that release only their own listeners and deadline.
 */
export function observeCaddyListener(child: ListenerChild): ListenerObservation {
  const decoder = new StringDecoder('utf8')
  const lineLimit = 8192
  let buffered = ''
  let port: number | undefined
  let failure: Error | undefined
  let failureObserved = false
  let closed = false
  let disposed = false
  let pending: { resolve(port: number): void; reject(error: Error): void; cleanup(): void } | undefined

  const detach = (): void => {
    child.stderr.removeListener('data', data)
    child.stderr.removeListener('error', streamError)
    child.removeListener('error', processError)
    child.removeListener('close', close)
  }
  const fail = (error: Error): void => {
    failure ??= error
    detach()
    if (pending !== undefined) {
      const waiter = pending
      pending = undefined
      waiter.cleanup()
      failureObserved = true
      waiter.reject(failure)
    }
  }
  const line = (value: string): void => {
    if (Buffer.byteLength(value, 'utf8') > lineLimit) throw new Error('caddy_listener_log_line_too_large')
    if (!value.trimStart().startsWith('{')) return
    let parsed: unknown
    try { parsed = JSON.parse(value) } catch (error) { throw new Error('caddy_listener_invalid_json', { cause: error }) }
    if (parsed === null || typeof parsed !== 'object' || !('logger' in parsed) || !('msg' in parsed)
      || parsed.logger !== 'http' || parsed.msg !== 'port 0 listener') return
    if (!('level' in parsed) || parsed.level !== 'info' || !('input_address' in parsed)
      || parsed.input_address !== '127.0.0.1:0' || !('actual_address' in parsed)
      || typeof parsed.actual_address !== 'string') throw new Error('caddy_listener_invalid_record')
    const match = /^127\.0\.0\.1:([1-9]\d{0,4})$/u.exec(parsed.actual_address)
    const received = Number(match?.[1])
    if (!Number.isInteger(received) || received < 1 || received > 65535) throw new Error('caddy_listener_invalid_address')
    if (port !== undefined && port !== received) throw new Error('caddy_listener_ambiguous_port')
    port = received
  }
  const data = (chunk: Buffer): void => {
    try {
      buffered += decoder.write(chunk)
      let end: number
      while ((end = buffered.indexOf('\n')) !== -1) {
        line(buffered.slice(0, end))
        buffered = buffered.slice(end + 1)
      }
      if (Buffer.byteLength(buffered, 'utf8') > lineLimit) throw new Error('caddy_listener_log_line_too_large')
      // Parse the entire chunk before resolving so conflicting records cannot win by order.
      if (port !== undefined && pending !== undefined) {
        const waiter = pending
        pending = undefined
        waiter.cleanup()
        waiter.resolve(port)
      }
    } catch (error) { fail(new Error('caddy_listener_log_rejected', { cause: error })) }
  }
  const streamError = (error: Error): void => { fail(new Error('caddy_listener_stderr_error', { cause: error })) }
  const processError = (error: Error): void => { fail(new Error('caddy_listener_process_error', { cause: error })) }
  const close = (): void => {
    closed = true
    detach()
    if (port === undefined) fail(new Error('caddy_listener_closed_before_receipt'))
  }
  child.stderr.on('data', data)
  child.stderr.on('error', streamError)
  child.on('error', processError)
  child.on('close', close)
  if (child.exitCode !== null || child.signalCode !== null) close()

  return {
    async wait(options) {
      if (options.signal.aborted) fail(new Error('caddy_listener_aborted', { cause: options.signal.reason }))
      if (failure !== undefined) { failureObserved = true; throw failure }
      if (disposed) throw new Error('caddy_listener_disposed')
      if (closed) throw new Error('caddy_listener_process_closed')
      if (port !== undefined) return port
      if (pending !== undefined) throw new Error('caddy_listener_wait_already_pending')
      return new Promise<number>((resolve, reject) => {
        const abort = (): void => { fail(new Error('caddy_listener_aborted', { cause: options.signal.reason })) }
        const timer = setTimeout(() => { fail(new Error('caddy_listener_timeout')) }, options.timeoutMs)
        timer.unref()
        pending = { resolve, reject, cleanup: () => { clearTimeout(timer); options.signal.removeEventListener('abort', abort) } }
        options.signal.addEventListener('abort', abort, { once: true })
        if (options.signal.aborted) abort()
      })
    },
    dispose() {
      disposed = true
      detach()
      if (pending !== undefined) fail(new Error('caddy_listener_disposed'))
      if (failure !== undefined && !failureObserved) { failureObserved = true; throw failure }
    },
  }
}
