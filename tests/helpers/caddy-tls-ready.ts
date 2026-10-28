import { connect } from 'node:tls'
import { setTimeout as delay } from 'node:timers/promises'

interface CaddyTlsReadyOptions {
  readonly port: number
  readonly ca: string
  readonly servername: string
  readonly signal: AbortSignal
  readonly timeoutMs: number
  readonly intervalMs: number
  /** When supplied, a stopped owned process fails readiness instead of waiting out the deadline. */
  readonly isRunning?: () => boolean
}

async function handshake(options: CaddyTlsReadyOptions, signal: AbortSignal): Promise<void> {
  const socket = connect({ host: '127.0.0.1', port: options.port, servername: options.servername,
    ca: options.ca, rejectUnauthorized: true })
  const closed = new Promise<void>(resolve => { socket.once('close', resolve) })
  let finish!: () => void
  let fail!: (error: Error) => void
  const result = new Promise<void>((resolve, reject) => { finish = resolve; fail = reject })
  const prematureClose = (): void => { fail(new Error('caddy_tls_closed_before_secure')) }
  socket.once('secureConnect', finish)
  socket.on('error', fail)
  socket.once('close', prematureClose)
  const abort = (): void => { socket.destroy(new Error('caddy_tls_ready_aborted', { cause: signal.reason })) }
  signal.addEventListener('abort', abort, { once: true })
  if (signal.aborted) abort()
  try { await result } finally {
    socket.destroy()
    await closed
    socket.removeListener('secureConnect', finish)
    socket.removeListener('error', fail)
    socket.removeListener('close', prematureClose)
    signal.removeEventListener('abort', abort)
  }
}

/**
 * Wait for the fixture's actual trusted TLS handshake, never an HTTP/API request.
 * Caddy starts certificate management asynchronously; an internal TLS alert can precede its leaf cache.
 * See Caddy's TLS.Manage and CertMagic's ManageAsync; a CA file or open listener is not leaf readiness.
 * Only that startup alert is retried. Trust/name errors and other transport failures are terminal.
 * Every attempt closes its socket before returning or trying again; abort preserves the caller's reason.
 * @param options - Pinned CA/name, owned port, total startup budget and optional process liveness check.
 * @returns Completion after a verified handshake and socket closure; otherwise a terminal failure.
 */
export async function waitForCaddyTls(options: CaddyTlsReadyOptions): Promise<void> {
  const deadline = new AbortController()
  const expired = new Error('caddy_tls_ready_timeout')
  const timer = setTimeout(() => { deadline.abort(expired) }, options.timeoutMs)
  timer.unref()
  const signal = AbortSignal.any([options.signal, deadline.signal])
  let lastError: unknown
  try {
    while (true) {
      signal.throwIfAborted()
      if (options.isRunning?.() === false) throw new Error('caddy_tls_process_exited')
      try {
        await handshake(options, signal)
        signal.throwIfAborted()
        if (options.isRunning?.() === false) throw new Error('caddy_tls_process_exited')
        return
      } catch (error) {
        if (signal.aborted) throw signal.reason
        if (options.isRunning?.() === false) throw new Error('caddy_tls_process_exited', { cause: error })
        if (error === null || typeof error !== 'object' || !('code' in error)
          || error.code !== 'ERR_SSL_TLSV1_ALERT_INTERNAL_ERROR') throw error
        lastError = error
      }
      await delay(options.intervalMs, undefined, { signal })
    }
  } catch (error) {
    if (options.signal.aborted) throw options.signal.reason
    if (deadline.signal.aborted) throw new Error('caddy_tls_ready_timeout', { cause: lastError ?? error })
    throw error
  } finally { clearTimeout(timer) }
}
