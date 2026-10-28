import { createServer, type IncomingHttpHeaders } from 'node:http'
import { Socket } from 'node:net'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import WebSocket, { WebSocketServer } from 'ws'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { parseGatewayConfig } from '../src/config.js'
import { MobileAccessGateway } from '../src/gateway.js'
import { SESSION_COOKIE } from '../src/http-security.js'
import { MemoryDeviceStore } from '../src/storage.js'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })

async function fixture(compression = true, maxWebSockets = 4, holdLogin = false) {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-mobile-ws-integration-'))
  cleanups.push(() => rm(directory, { recursive: true, force: true }))
  const sockets = new Set<Socket>()
  const clients = new Set<WebSocket>()
  const peers = new Set<WebSocket>()
  const observations: IncomingHttpHeaders[] = []
  const loginSeen = Promise.withResolvers<void>()
  const releaseLogin = Promise.withResolvers<void>()
  const backend = new WebSocketServer({ noServer: true, perMessageDeflate: false })
  const host = createServer((_request, response) => {
    loginSeen.resolve()
    const reply = (): void => {
      if (response.destroyed) return
      response.statusCode = 303
      response.setHeader('Location', '/')
      response.setHeader('Set-Cookie', 'dsh_launch=signed-upstream; Path=/; HttpOnly; Max-Age=3600')
      response.end()
    }
    if (holdLogin) void releaseLogin.promise.then(reply)
    else reply()
  })
  host.on('connection', socket => {
    sockets.add(socket)
    socket.on('error', () => { socket.destroy() })
    socket.once('close', () => { sockets.delete(socket) })
  })
  host.on('upgrade', (request, socket, head) => {
    observations.push(request.headers)
    if (request.headers.cookie !== 'dsh_launch=signed-upstream'
      || request.headers.origin !== origin || request.headers['sec-fetch-site'] !== 'same-origin') {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n')
      return
    }
    backend.handleUpgrade(request, socket, head, peer => {
      peers.add(peer)
      peer.on('error', () => { peer.terminate() })
      peer.once('close', () => { peers.delete(peer) })
      peer.on('message', (data, binary) => { peer.send(data, { binary }) })
    })
  })
  cleanups.push(async () => {
    releaseLogin.resolve()
    const closed = [...sockets].map(socket => new Promise<void>(resolve => { socket.once('close', resolve) }))
    for (const peer of peers) peer.terminate()
    for (const socket of sockets) socket.destroy()
    await Promise.all(closed)
    await new Promise<void>(resolve => { backend.close(() => { resolve() }) })
    if (host.listening) await new Promise<void>(resolve => { host.close(() => { resolve() }) })
  })
  await new Promise<void>(resolve => { host.listen(0, '127.0.0.1', resolve) })
  const bound = host.address()
  if (bound === null || typeof bound === 'string') throw new Error('Expected loopback listener')
  const origin = `http://127.0.0.1:${String(bound.port)}`
  const resolved = parseGatewayConfig({
    listenHost: '127.0.0.1', listenPort: 0,
    upstreamOrigin: origin, publicAuthorities: ['127.0.0.1'], allowedCidrs: ['127.0.0.0/8'],
    stateFile: join(directory, 'devices.json'), tls: { mode: 'disabled' }, maxWebSockets,
    websocketCompression: { paths: compression ? ['/api/remote.mux'] : [] },
  })
  const gateway = new MobileAccessGateway(Object.freeze({ ...resolved, discovery: false }),
    new MemoryDeviceStore(), undefined, `${origin}/?token=fixture-login`)
  await gateway.start()
  cleanups.push(async () => {
    const closed = [...clients].filter(client => client.readyState !== WebSocket.CLOSED).map(client =>
      new Promise<void>(resolve => { client.once('close', () => { resolve() }) }))
    for (const client of clients) client.terminate()
    await gateway.close()
    await Promise.all(closed)
  })
  const pairing = await gateway.access.openPairing()
  const paired = await gateway.access.pair('127.0.0.1', pairing.token, 'Integration phone')
  const address = gateway.address()
  const connect = async (path = '/api/remote.mux', token = paired.sessionToken, suppliedOrigin = address.origin) => {
    const client = new WebSocket(`ws://127.0.0.1:${String(address.port)}${path}`, {
      perMessageDeflate: true,
      headers: { origin: suppliedOrigin, cookie: `${SESSION_COOKIE}=${token}`, 'sec-fetch-site': 'same-origin' },
    })
    clients.add(client)
    const result = Promise.withResolvers<'open' | number>()
    client.on('error', () => { /* Rejected upgrades are observed below. */ })
    client.once('open', () => { result.resolve('open') })
    client.once('unexpected-response', (_request, response) => {
      const status = response.statusCode ?? 0
      response.resume()
      client.terminate()
      result.resolve(status)
    })
    return { client, result: await result.promise }
  }
  return { gateway, paired, connect, observations, peers, loginSeen: loginSeen.promise, releaseLogin: () => { releaseLogin.resolve() } }
}

function message(client: WebSocket): Promise<string> {
  return new Promise(resolve => { client.once('message', data => { resolve(data.toString()) }) })
}

describe('authenticated gateway compression integration', () => {
  it('compresses only opted-in connections and forwards the gateway signed cookie and HTTP Origin', async () => {
    const f = await fixture()
    const connection = await f.connect('/api/remote.mux?probe=one%2Btwo')
    expect(connection.result).toBe('open')
    expect(connection.client.extensions).toBe('permessage-deflate')
    const reply = message(connection.client)
    const payload = 'session projection '.repeat(1000)
    connection.client.send(payload)
    expect(await reply).toBe(payload)
    expect(f.observations).toHaveLength(1)
    expect(f.observations[0]?.cookie).toBe('dsh_launch=signed-upstream')
    expect(f.observations[0]?.['sec-websocket-extensions']).toBeUndefined()
  })

  it('keeps compression disabled by default', async () => {
    const f = await fixture(false)
    const connection = await f.connect()
    expect(connection.result).toBe('open')
    expect(connection.client.extensions).toBe('')
    const reply = message(connection.client)
    connection.client.send('unchanged raw transport')
    expect(await reply).toBe('unchanged raw transport')
  })

  it('retains Origin, session and route authorization before the compression bridge', async () => {
    const f = await fixture()
    expect((await f.connect('/api/remote.mux', f.paired.sessionToken, 'https://untrusted.example')).result).toBe(403)
    expect((await f.connect('/api/remote.mux', 'invalid')).result).toBe(401)
    expect((await f.connect('/unapproved', f.paired.sessionToken)).result).toBe(404)
    expect(f.observations).toHaveLength(0)
  })

  it('enforces the connection budget and closes compressed streams when the session ends', async () => {
    const f = await fixture(true, 1)
    const first = await f.connect()
    expect(first.result).toBe('open')
    expect((await f.connect()).result).toBe(429)
    const closed = new Promise<void>(resolve => { first.client.once('close', () => { resolve() }) })
    f.gateway.access.logout(f.gateway.access.authorizeSession(f.paired.sessionToken))
    await closed
    expect(first.client.readyState).toBe(WebSocket.CLOSED)
  })

  it('rechecks the connection budget after concurrent upgrades await the same upstream login', async () => {
    const f = await fixture(true, 1, true)
    const bothAuthorized = Promise.withResolvers<void>()
    const authorize = f.gateway.access.authorizeSession.bind(f.gateway.access)
    let calls = 0
    const observer = vi.spyOn(f.gateway.access, 'authorizeSession').mockImplementation(token => {
      calls++
      if (calls === 2) bothAuthorized.resolve()
      return authorize(token)
    })
    const first = f.connect()
    const second = f.connect()
    await bothAuthorized.promise
    await f.loginSeen
    f.releaseLogin()
    const results = await Promise.all([first, second])
    observer.mockRestore()
    expect(results.map(result => result.result).sort()).toEqual([429, 'open'])
    expect(f.observations).toHaveLength(1)
  })

  it('does not upgrade a device revoked while the upstream login is pending', async () => {
    const f = await fixture(true, 4, true)
    const connection = f.connect()
    await f.loginSeen
    await f.gateway.access.revokeDevice(f.paired.deviceId)
    f.releaseLogin()
    expect((await connection).result).toBe(401)
    expect(f.observations).toHaveLength(0)
  })

  it('revokes a paired device without leaving either compressed WebSocket leg active', async () => {
    const f = await fixture()
    const connection = await f.connect()
    expect(connection.result).toBe('open')
    const closed = new Promise<void>(resolve => { connection.client.once('close', () => { resolve() }) })
    await f.gateway.access.revokeDevice(f.paired.deviceId)
    await closed
    expect(connection.client.readyState).toBe(WebSocket.CLOSED)
    expect((await f.connect()).result).toBe(401)
  })
})
