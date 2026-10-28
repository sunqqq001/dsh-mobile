import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer, request as requestHttp, type IncomingHttpHeaders, type Server } from 'node:http'
import { createServer as createHttpsServer, request as requestHttps } from 'node:https'
import { type AddressInfo, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { generate } from 'selfsigned'
import { afterEach, describe, expect, it } from 'vitest'
import { parseGatewayConfig } from '../src/config.js'
import { MobileAccessGateway } from '../src/gateway.js'
import { CSRF_HEADER, SESSION_COOKIE } from '../src/http-security.js'
import { parseOriginSettings } from '../src/origin-proxy-config.js'
import { originGatewayConfig } from '../src/plugin.js'
import { MemoryDeviceStore } from '../src/storage.js'

const PUBLIC_ORIGIN = 'https://phone.example.com:8815'
const PUBLIC_HOST = 'phone.example.com:8815'
const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

async function listen(server: Server): Promise<number> {
  const sockets = new Set<Socket>()
  server.on('connection', socket => {
    sockets.add(socket)
    socket.on('error', () => { socket.destroy() })
    socket.once('close', () => { sockets.delete(socket) })
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  cleanups.push(async () => {
    for (const socket of sockets) socket.destroy()
    server.closeAllConnections()
    await new Promise<void>(resolve => { server.close(() => resolve()) })
  })
  return (server.address() as AddressInfo).port
}

interface HttpResult {
  readonly status: number
  readonly headers: IncomingHttpHeaders
  readonly body: string
}

async function fixture(allowedCidrs = ['127.0.0.0/8']) {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-mobile-origin-live-'))
  cleanups.push(() => rm(directory, { recursive: true, force: true }))
  const observed: { url: string; headers: IncomingHttpHeaders; body: string }[] = []
  const upstream = createServer(async (request, response) => {
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(Buffer.from(chunk))
    const body = Buffer.concat(chunks).toString('utf8')
    observed.push({ url: request.url ?? '', headers: request.headers, body })
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ ok: true, body }))
  })
  upstream.on('upgrade', (request, socket) => {
    const key = String(request.headers['sec-websocket-key'])
    observed.push({ url: request.url ?? '', headers: request.headers, body: '' })
    const accept = createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64')
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + accept + '\r\n\r\n')
    let input = Buffer.alloc(0)
    socket.on('data', (chunk: Buffer) => {
      input = Buffer.concat([input, chunk])
      if (input.length < 6) return
      const length = input[1]! & 0x7f
      if (length > 125 || (input[1]! & 0x80) === 0) { socket.destroy(); return }
      if (input.length < length + 6) return
      const payload = Buffer.from(input.subarray(6, 6 + length))
      for (let i = 0; i < payload.length; i += 1) payload[i] = payload[i]! ^ input[2 + (i % 4)]!
      socket.write(Buffer.concat([Buffer.from([0x81, length]), payload]))
      input = input.subarray(6 + length)
    })
  })
  const upstreamPort = await listen(upstream)
  const template = parseGatewayConfig({
    listenHost: '127.0.0.1', listenPort: 0, publicAuthorities: ['127.0.0.1'],
    allowedCidrs: ['127.0.0.0/8'], upstreamOrigin: 'http://127.0.0.1:' + String(upstreamPort),
    stateFile: join(directory, 'lan-devices.json'), tls: { mode: 'disabled' },
  })
  const settings = parseOriginSettings({ publicOrigin: PUBLIC_ORIGIN, allowedCidrs })
  const config = originGatewayConfig(template, settings, join(directory, 'remote-devices.json'), 'a'.repeat(64), 0)
  const gateway = new MobileAccessGateway(config, new MemoryDeviceStore())
  await gateway.start()
  cleanups.push(() => gateway.close())
  const backendPort = gateway.address().port
  const certificate = await generate([{ name: 'commonName', value: 'phone.example.com' }], {
    keyType: 'ec', curve: 'P-256', algorithm: 'sha256',
    extensions: [
      { name: 'basicConstraints', cA: true },
      { name: 'subjectAltName', altNames: [{ type: 2, value: 'phone.example.com' }] },
    ],
  })
  // A local TLS-terminating reverse proxy; no request leaves loopback.
  const ingress = createHttpsServer({ key: certificate.private, cert: certificate.cert }, (incoming, response) => {
    const outgoing = requestHttp({
      host: '127.0.0.1', port: backendPort, path: incoming.url, method: incoming.method,
      headers: { ...incoming.headers, 'x-forwarded-proto': 'https' }, agent: false,
    }, upstreamResponse => {
      response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers)
      upstreamResponse.pipe(response)
    })
    outgoing.once('error', () => { response.writeHead(502); response.end() })
    incoming.pipe(outgoing)
  })
  ingress.on('upgrade', (incoming, client, head) => {
    const outgoing = requestHttp({
      host: '127.0.0.1', port: backendPort, path: incoming.url, headers: incoming.headers, agent: false,
    })
    outgoing.once('error', () => { client.destroy() })
    outgoing.once('response', response => {
      client.end('HTTP/1.1 ' + String(response.statusCode) + ' Rejected\r\nConnection: close\r\n\r\n')
      response.resume()
    })
    outgoing.once('upgrade', (response, backend, backendHead) => {
      client.write('HTTP/1.1 101 Switching Protocols\r\n' + response.rawHeaders.reduce((lines, value, index, headers) =>
        index % 2 === 0 ? lines + value + ': ' + headers[index + 1] + '\r\n' : lines, '') + '\r\n')
      backend.on('error', () => { client.destroy(); backend.destroy() })
      client.on('error', () => { client.destroy(); backend.destroy() })
      client.once('close', () => { backend.destroy() })
      backend.once('close', () => { client.destroy() })
      if (head.length > 0) backend.write(head)
      if (backendHead.length > 0) client.write(backendHead)
      client.pipe(backend); backend.pipe(client)
    })
    outgoing.end()
  })
  const ingressPort = await listen(ingress)
  const tlsOptions = { host: '127.0.0.1', port: ingressPort, servername: 'phone.example.com', ca: certificate.cert, agent: false as const }
  const request = (pathname: string, options: { method?: string; headers?: Record<string, string>; body?: string } = {}): Promise<HttpResult> =>
    new Promise((resolve, reject) => {
      const outgoing = requestHttps({
        ...tlsOptions, path: pathname, method: options.method ?? 'GET',
        headers: {
          host: PUBLIC_HOST, origin: PUBLIC_ORIGIN, 'sec-fetch-site': 'same-origin',
          ...(options.body === undefined ? {} : { 'content-type': 'application/json', 'content-length': Buffer.byteLength(options.body) }),
          ...options.headers,
        },
      }, response => {
        const chunks: Buffer[] = []
        response.on('data', chunk => { chunks.push(Buffer.from(chunk)) })
        response.once('end', () => resolve({ status: response.statusCode ?? 0, headers: response.headers, body: Buffer.concat(chunks).toString('utf8') }))
      })
      outgoing.setTimeout(3_000, () => { outgoing.destroy(new Error('origin test request timed out')) })
      outgoing.once('error', reject)
      outgoing.end(options.body)
    })
  const webSocket = (cookie: string, headers: Record<string, string> = {}): Promise<{ status: number; echo?: string }> =>
    new Promise((resolve, reject) => {
      const outgoing = requestHttps({
        ...tlsOptions, path: '/api/events.mux', headers: {
          host: PUBLIC_HOST, origin: PUBLIC_ORIGIN, cookie, 'sec-fetch-site': 'same-origin',
          upgrade: 'websocket', connection: 'Upgrade', 'sec-websocket-version': '13',
          'sec-websocket-key': Buffer.from('0123456789abcdef').toString('base64'), ...headers,
        },
      })
      outgoing.setTimeout(3_000, () => { outgoing.destroy(new Error('WebSocket handshake timed out')) })
      outgoing.once('error', reject)
      outgoing.once('response', response => { response.resume(); resolve({ status: response.statusCode ?? 0 }) })
      outgoing.once('upgrade', (response, socket, head) => {
        const timer = setTimeout(() => { socket.destroy(); reject(new Error('WebSocket echo timed out')) }, 3_000)
        socket.on('error', reject)
        socket.once('close', () => { clearTimeout(timer) })
        let input = Buffer.from(head)
        socket.on('data', (chunk: Buffer) => {
          input = Buffer.concat([input, chunk])
          if (input.length < 2 || input.length < 2 + (input[1]! & 0x7f)) return
          clearTimeout(timer)
          const echo = input.subarray(2, 2 + (input[1]! & 0x7f)).toString('utf8')
          socket.destroy()
          resolve({ status: response.statusCode ?? 0, echo })
        })
        const text = Buffer.from('origin-websocket-ok')
        const mask = Buffer.from([1, 2, 3, 4])
        const payload = Buffer.from(text)
        for (let i = 0; i < payload.length; i += 1) payload[i] = payload[i]! ^ mask[i % 4]!
        socket.write(Buffer.concat([Buffer.from([0x81, 0x80 | payload.length]), mask, payload]))
      })
      outgoing.end()
    })
  return { gateway, config, request, webSocket, observed, backendPort }
}

async function pair(local: Awaited<ReturnType<typeof fixture>>) {
  const opened = await local.gateway.access.openPairing()
  const paired = await local.request('/mobile-access/auth/pair', {
    method: 'POST', body: JSON.stringify({ token: opened.token, label: 'Local proxy test' }),
  })
  expect(paired.status).toBe(201)
  const cookies = paired.headers['set-cookie'] ?? []
  expect(cookies.every(cookie => cookie.includes('; Secure'))).toBe(true)
  const cookie = cookies.find(value => value.startsWith(SESSION_COOKIE + '='))?.split(';')[0]
  expect(cookie).toBeTruthy()
  return { cookie: cookie!, csrf: (JSON.parse(paired.body) as { csrfToken: string }).csrfToken }
}

describe('local TLS reverse proxy to the real HTTP origin gateway', () => {
  it('retains public HTTPS identity and authenticates HTTP and WebSocket traffic end to end', async () => {
    const local = await fixture()
    expect(local.gateway.address().origin).toBe(PUBLIC_ORIGIN)
    expect(local.config.tls.mode).toBe('disabled')
    expect(local.config.publicTls).toBe(true)
    const discovery = await local.request('/mobile-access/discovery')
    expect(discovery.status).toBe(200)
    expect(JSON.parse(discovery.body)).toMatchObject({ origin: PUBLIC_ORIGIN, instanceId: 'a'.repeat(64) })
    expect((await local.request('/mobile-access/ca.cer')).status).toBe(404)
    expect((await local.request('/api/test')).status).toBe(401)
    expect((await local.webSocket('')).status).toBe(401)
    const paired = await pair(local)
    const read = await local.request('/api/test', { headers: { cookie: paired.cookie } })
    expect(read.status).toBe(200)
    expect(JSON.parse(read.body)).toMatchObject({ ok: true })
    expect((await local.request('/api/test', { method: 'POST', body: '{}', headers: { cookie: paired.cookie } })).status).toBe(403)
    const changed = await local.request('/api/test', {
      method: 'POST', body: '{"test":true}', headers: { cookie: paired.cookie, [CSRF_HEADER]: paired.csrf },
    })
    expect(changed.status).toBe(200)
    expect(JSON.parse(changed.body)).toMatchObject({ body: '{"test":true}' })
    expect(await local.webSocket(paired.cookie)).toEqual({ status: 101, echo: 'origin-websocket-ok' })
    expect(local.observed.find(entry => entry.url === '/api/events.mux')).toBeDefined()
    expect(local.observed.every(entry => !entry.headers.cookie?.includes(SESSION_COOKIE))).toBe(true)
    expect((await local.request('/api/mobile-access/remote/origin/configure', {
      method: 'POST', body: '{}', headers: { cookie: paired.cookie, [CSRF_HEADER]: paired.csrf },
    })).status).toBe(404)
  })

  it('rejects backend Host rewriting, lost external ports, and foreign or HTTP origins', async () => {
    const local = await fixture()
    for (const host of ['phone.example.com', 'phone.example.com:3444', '127.0.0.1:' + String(local.backendPort), 'attacker.example:8815']) {
      expect((await local.request('/mobile-access/discovery', { headers: { host } })).status).toBe(403)
    }
    for (const origin of ['https://phone.example.com', 'http://phone.example.com:8815', 'https://attacker.example:8815']) {
      expect((await local.request('/mobile-access/auth/pair', { method: 'POST', body: '{}', headers: { origin } })).status).toBe(403)
    }
    const paired = await pair(local)
    expect((await local.webSocket(paired.cookie, { origin: 'https://attacker.example:8815' })).status).toBe(403)
    expect((await local.webSocket(paired.cookie, { host: '127.0.0.1:' + String(local.backendPort) })).status).toBe(403)
  })

  it('never lets forwarded headers impersonate an allowed direct proxy peer', async () => {
    // The real reverse proxy connects from 127.0.0.1, which this allowlist excludes.
    const local = await fixture(['127.0.0.2/32'])
    const result = await local.request('/mobile-access/discovery', { headers: {
      'x-forwarded-for': '127.0.0.2', 'x-real-ip': '127.0.0.2',
      forwarded: 'for=127.0.0.2;proto=https;host=phone.example.com:8815',
      'x-forwarded-host': PUBLIC_HOST,
    } })
    expect(result.status).toBe(403)
    expect(local.observed).toHaveLength(0)
  })
})
