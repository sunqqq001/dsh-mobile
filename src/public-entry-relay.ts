/**
 * In-process public entry relay.
 *
 * The mobile gateway is bound to a LAN address and validates the exact origin it
 * advertises, so a phone reaching it through a public IP is rejected before pairing.
 * This relay terminates TLS with the gateway's own certificate, rewrites Host and
 * Origin to the LAN origin, and forwards the request over the loopback interface the
 * gateway already trusts.
 *
 * Running inside the plugin host means the relay shares the DSH process lifecycle:
 * no separate executable, nothing for a restart to orphan.
 */
import { createServer, request as httpsRequest, type Server } from 'node:https'
import { readFileSync } from 'node:fs'
import type { Socket } from 'node:net'

export interface PublicEntryRelayOptions {
  /** Public HTTPS origin the phone dials, e.g. https://203.0.113.10:3444 */
  readonly entry: URL
  /** LAN gateway origin the relay forwards to, e.g. https://192.168.50.10:3443 */
  readonly target: URL
  readonly certFile: string
  readonly keyFile: string
  readonly log: (message: string) => void
}

export interface PublicEntryRelay {
  readonly origin: string
  readonly port: number
  close(): Promise<void>
}

const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
])

function forwardedHeaders(
  incoming: NodeJS.Dict<string | string[]>,
  target: URL,
  upgrade = false,
): Record<string, string | string[]> {
  const headers: Record<string, string | string[]> = {}
  for (const [name, value] of Object.entries(incoming)) {
    if (value === undefined || HOP_BY_HOP.has(name.toLowerCase())) continue
    headers[name] = value
  }
  headers.host = target.host
  if (headers.origin !== undefined) headers.origin = target.origin
  if (typeof headers.referer === 'string') {
    headers.referer = headers.referer.replace(/^https?:\/\/[^/]+/iu, target.origin)
  }
  headers['x-forwarded-proto'] = 'https'
  // The upgrade handshake is defined by these two headers. Stripping them as ordinary
  // hop-by-hop fields turns a WebSocket request into a malformed plain HTTP request,
  // which the gateway answers with 400 and the phone then retries forever.
  if (upgrade) {
    headers.connection = 'Upgrade'
    headers.upgrade = typeof incoming.upgrade === 'string' ? incoming.upgrade : 'websocket'
  }
  return headers
}

/** Start the relay and resolve once it is listening. */
export async function startPublicEntryRelay(options: PublicEntryRelayOptions): Promise<PublicEntryRelay> {
  const { entry, target, certFile, keyFile, log } = options
  const port = Number(entry.port === '' ? 443 : entry.port)
  const targetHost = target.hostname
  const targetPort = Number(target.port === '' ? 443 : target.port)

  const forward = (method: string | undefined, url: string | undefined, headers: NodeJS.Dict<string | string[]>, upgrade = false) =>
    httpsRequest({
      host: targetHost,
      port: targetPort,
      method,
      path: url ?? '/',
      headers: forwardedHeaders(headers, target, upgrade),
      // The relay is the only client of its own gateway; the certificate chain is
      // the same one this process serves, so upstream verification adds nothing.
      rejectUnauthorized: false,
      servername: targetHost,
      localAddress: targetHost,
    })

  const server: Server = createServer(
    { cert: readFileSync(certFile), key: readFileSync(keyFile) },
    (request, response) => {
      const upstream = forward(request.method, request.url, request.headers)
      upstream.on('response', (proxied) => {
        response.writeHead(proxied.statusCode ?? 502, proxied.headers)
        proxied.pipe(response)
      })
      upstream.on('error', (error) => {
        if (!response.headersSent) response.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' })
        response.end(`relay upstream error: ${error.message}`)
      })
      request.pipe(upstream)
    },
  )

  server.on('upgrade', (request, socket, head) => {
    // An upgraded socket leaves HTTP framing behind: no idle timeout, and every error
    // must tear down both halves or the phone waits on a half-open connection.
    const clientSocket = socket as Socket
    clientSocket.setNoDelay(true)
    clientSocket.setTimeout(0)
    const upstream = forward(request.method, request.url, request.headers, true)
    upstream.on('upgrade', (proxied, proxiedSocket, proxiedHead) => {
      proxiedSocket.setNoDelay(true)
      proxiedSocket.setTimeout(0)
      const status = `HTTP/1.1 ${proxied.statusCode ?? 101} ${proxied.statusMessage ?? 'Switching Protocols'}`
      const lines = Object.entries(proxied.headers)
        .filter(([name]) => !['content-length', 'transfer-encoding'].includes(name.toLowerCase()))
        .map(([name, value]) => `${name}: ${value}`)
      socket.write(`${status}\r\n${lines.join('\r\n')}\r\n\r\n`)
      if (proxiedHead?.length) socket.write(proxiedHead)
      if (head?.length) proxiedSocket.write(head)
      proxiedSocket.pipe(socket)
      socket.pipe(proxiedSocket)
      const teardown = () => {
        socket.destroy()
        proxiedSocket.destroy()
      }
      socket.on('error', teardown)
      proxiedSocket.on('error', teardown)
      socket.on('close', teardown)
      proxiedSocket.on('close', teardown)
    })
    upstream.on('error', () => socket.destroy())
    // A refused upgrade arrives as an ordinary response. Without this the socket would
    // hang until the phone's timeout, which looks exactly like a dropped connection.
    upstream.on('response', (proxied) => {
      const status = `HTTP/1.1 ${proxied.statusCode ?? 502} ${proxied.statusMessage ?? 'Bad Gateway'}`
      const lines = Object.entries(proxied.headers)
        .filter(([name]) => !['transfer-encoding'].includes(name.toLowerCase()))
        .map(([name, value]) => `${name}: ${value}`)
      socket.write(`${status}\r\n${lines.join('\r\n')}\r\n\r\n`)
      proxied.pipe(socket)
      proxied.on('end', () => socket.destroy())
    })
    upstream.end()
  })

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '0.0.0.0', () => {
      server.removeListener('error', reject)
      resolve()
    })
  })

  log(`public entry relay listening on 0.0.0.0:${port} -> ${target.origin}`)

  return {
    origin: entry.origin,
    port,
    async close() {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    },
  }
}
