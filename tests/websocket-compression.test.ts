import { createServer, type IncomingMessage, type Server } from 'node:http'
import { connect, Socket } from 'node:net'
import WebSocket, { WebSocketServer, type RawData } from 'ws'
import { afterEach, describe, expect, it } from 'vitest'
import { bridgeCompressedWebSocket, type WebSocketCompressionOptions } from '../src/websocket-compression.js'

const defaults: Readonly<WebSocketCompressionOptions> = Object.freeze({
  maxMessageBytes: 64 * 1024,
  maxQueuedBytes: 128 * 1024,
  thresholdBytes: 64,
  concurrencyLimit: 1,
  level: 3,
})

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('Expected loopback TCP address')
  return address.port
}

function message(socket: WebSocket): Promise<{ data: RawData; binary: boolean }> {
  return new Promise(resolve => { socket.once('message', (data, binary) => { resolve({ data, binary }) }) })
}

function closed(socket: WebSocket): Promise<{ code: number; reason: string }> {
  return new Promise(resolve => { socket.once('close', (code, reason) => { resolve({ code, reason: reason.toString() }) }) })
}

interface FixtureOptions {
  compression?: boolean
  limits?: Partial<WebSocketCompressionOptions>
  holdHandshake?: boolean
  rejectHandshake?: boolean
  handshakeTimeoutMs?: number
  head?: Buffer
}

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup() })

async function fixture(options: FixtureOptions = {}) {
  const host = createServer()
  const proxy = createServer()
  const backend = new WebSocketServer({
    noServer: true, perMessageDeflate: true, autoPong: false,
    handleProtocols: protocols => protocols.has('second') ? 'second' : false,
  })
  const rawSockets = new Set<Socket>()
  const peers = new Set<WebSocket>()
  const upstreamRequest = Promise.withResolvers<IncomingMessage>()
  const upstreamPeer = Promise.withResolvers<WebSocket>()
  const bridgeResult = Promise.withResolvers<Error | undefined>()
  const open = Promise.withResolvers<Error | undefined>()
  const errors: Error[] = []
  let device: WebSocket | undefined
  let clientTransport: Socket | undefined
  let upstreamTransport: Socket | undefined
  let handshakeHeaders: IncomingMessage['headers'] | undefined
  const track = (socket: Socket): void => {
    rawSockets.add(socket)
    socket.on('error', () => { /* The ws wrapper and bridge own transport failures. */ })
    socket.once('close', () => { rawSockets.delete(socket) })
  }
  host.on('connection', track)
  proxy.on('connection', track)
  const cleanup = async (): Promise<void> => {
    const sockets = [...rawSockets]
    const rawClosed = sockets.map(socket => new Promise<void>(resolve => { socket.once('close', resolve) }))
    const websockets = [...peers, ...(device === undefined ? [] : [device])]
    const wsClosed = websockets.filter(socket => socket.readyState !== WebSocket.CLOSED).map(socket => {
      const done = new Promise<void>(resolve => { socket.once('close', () => { resolve() }) })
      socket.terminate()
      return done
    })
    for (const socket of sockets) socket.destroy()
    await Promise.all([...rawClosed, ...wsClosed])
    await new Promise<void>(resolve => { backend.close(() => { resolve() }) })
    for (const server of [host, proxy]) {
      if (server.listening) await new Promise<void>((resolve, reject) => {
        server.close(error => { if (error !== undefined) reject(error); else resolve() })
      })
    }
  }
  cleanups.push(cleanup)
  host.on('upgrade', (request, socket, head) => {
    upstreamRequest.resolve(request)
    if (options.holdHandshake) return
    if (options.rejectHandshake) {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n')
      return
    }
    backend.handleUpgrade(request, socket, head, peer => {
      peers.add(peer)
      peer.on('error', error => { errors.push(error) })
      upstreamPeer.resolve(peer)
    })
  })
  const upstreamPort = await listen(host)
  const origin = `http://127.0.0.1:${String(upstreamPort)}`
  proxy.on('upgrade', (request, socket, head) => {
    if (!(socket instanceof Socket)) throw new Error('Expected TCP client socket')
    clientTransport = socket
    socket.pause()
    const raw = connect({ host: '127.0.0.1', port: upstreamPort })
    upstreamTransport = raw
    track(raw)
    void bridgeCompressedWebSocket(request, socket, raw,
      options.head === undefined ? head : Buffer.concat([head, options.head]),
      new URL(request.url ?? '/', origin), 'dsh_launch=signed-host-session',
      Object.freeze({ ...defaults, ...options.limits }), options.handshakeTimeoutMs ?? 3_000,
    ).then(() => { bridgeResult.resolve(undefined) }, (error: Error) => { bridgeResult.resolve(error) })
  })
  const proxyPort = await listen(proxy)
  device = new WebSocket(`ws://127.0.0.1:${String(proxyPort)}/socket?ticket=x%2By&path=%2Fworkspace`, ['first', 'second'], {
    perMessageDeflate: options.compression ?? true,
    headers: { origin: 'https://mobile.example', cookie: 'dsh_mobile=device-secret; dsh_launch=untrusted', 'sec-fetch-site': 'same-origin' },
  })
  device.on('upgrade', response => { handshakeHeaders = response.headers })
  device.once('open', () => { open.resolve(undefined) })
  device.on('error', error => { errors.push(error); open.resolve(error) })
  return {
    device, open: open.promise, upstreamRequest: upstreamRequest.promise, upstreamPeer: upstreamPeer.promise,
    bridgeResult: bridgeResult.promise, errors, origin,
    headers: () => handshakeHeaders,
    clientTransport: () => clientTransport,
    upstreamTransport: () => upstreamTransport,
  }
}

function maskedText(text: string): Buffer {
  const body = Buffer.from(text)
  if (body.length > 125) throw new Error('Fixture frame must use a short payload')
  const mask = Buffer.from([1, 2, 3, 4])
  const encoded = Buffer.from(body.map((byte, index) => byte ^ mask[index % mask.length]!))
  return Buffer.concat([Buffer.from([0x81, 0x80 | body.length]), mask, encoded])
}

describe('optional gateway WebSocket compression bridge', () => {
  it('negotiates stateless client compression while keeping the upstream uncompressed and authenticated', async () => {
    const f = await fixture()
    expect(await f.open).toBeUndefined()
    expect(await f.bridgeResult).toBeUndefined()
    const upstream = await f.upstreamPeer
    const request = await f.upstreamRequest
    expect(f.device.extensions).toBe('permessage-deflate')
    expect(f.headers()?.['sec-websocket-extensions']).toContain('server_no_context_takeover')
    expect(f.headers()?.['sec-websocket-extensions']).toContain('client_no_context_takeover')
    expect(upstream.extensions).toBe('')
    expect(request.headers['sec-websocket-extensions']).toBeUndefined()
    expect(request.headers.cookie).toBe('dsh_launch=signed-host-session')
    expect(request.headers.origin).toBe(f.origin)
    expect(request.headers.host).toBe(new URL(f.origin).host)
    expect(request.headers['sec-fetch-site']).toBe('same-origin')
    expect(request.url).toBe('/socket?ticket=x%2By&path=%2Fworkspace')
    expect(f.device.protocol).toBe('second')
    expect(upstream.protocol).toBe('second')
  })

  it('retains plain clients that do not offer compression', async () => {
    const f = await fixture({ compression: false })
    expect(await f.open).toBeUndefined()
    const upstream = await f.upstreamPeer
    expect(f.device.extensions).toBe('')
    expect(f.headers()?.['sec-websocket-extensions']).toBeUndefined()
    const received = message(f.device)
    upstream.send('plain response')
    expect((await received).data.toString()).toBe('plain response')
  })

  it('preserves large text and binary messages in both directions', async () => {
    const f = await fixture()
    expect(await f.open).toBeUndefined()
    const upstream = await f.upstreamPeer
    const text = 'workspace event '.repeat(1_000)
    let received = message(upstream)
    f.device.send(text)
    expect(await received).toMatchObject({ binary: false, data: Buffer.from(text) })
    received = message(f.device)
    upstream.send(text)
    expect(await received).toMatchObject({ binary: false, data: Buffer.from(text) })
    const binary = Buffer.from([0, 255, 1, 128, 2, 0])
    received = message(upstream)
    f.device.send(binary)
    expect(await received).toMatchObject({ binary: true, data: binary })
    received = message(f.device)
    upstream.send(binary)
    expect(await received).toMatchObject({ binary: true, data: binary })
  })

  it('reduces downstream wire bytes while the loopback leg carries the original message', async () => {
    const f = await fixture()
    expect(await f.open).toBeUndefined()
    const upstream = await f.upstreamPeer
    const request = await f.upstreamRequest
    const client = f.clientTransport()
    if (client === undefined) throw new Error('Missing client transport')
    const text = 'repeatable workspace event '.repeat(1_000)
    const downstreamBefore = client.bytesWritten
    const upstreamBefore = request.socket.bytesWritten
    const received = message(f.device)
    upstream.send(text)
    expect((await received).data.toString()).toBe(text)
    expect(request.socket.bytesWritten - upstreamBefore).toBeGreaterThanOrEqual(Buffer.byteLength(text))
    expect(client.bytesWritten - downstreamBefore).toBeLessThan(Buffer.byteLength(text) / 4)
  })

  it('relays ping and pong without answering before the upstream responds', async () => {
    const f = await fixture()
    expect(await f.open).toBeUndefined()
    const upstream = await f.upstreamPeer
    const payload = Buffer.from('peer-heartbeat')
    let pongCount = 0
    f.device.on('pong', () => { pongCount++ })
    const pong = new Promise<Buffer>(resolve => { f.device.once('pong', resolve) })
    const ping = new Promise<Buffer>(resolve => { upstream.once('ping', resolve) })
    f.device.ping(payload)
    expect(await ping).toEqual(payload)
    expect(pongCount).toBe(0)
    upstream.pong(payload)
    expect(await pong).toEqual(payload)
    expect(pongCount).toBe(1)
    const upstreamPong = new Promise<Buffer>(resolve => { upstream.once('pong', resolve) })
    upstream.ping('host-heartbeat')
    expect(await upstreamPong).toEqual(Buffer.from('host-heartbeat'))
  })

  it('forwards an ordinary close code and reason', async () => {
    const f = await fixture()
    expect(await f.open).toBeUndefined()
    const upstream = await f.upstreamPeer
    const done = closed(f.device)
    upstream.close(1000, 'task completed')
    expect(await done).toEqual({ code: 1000, reason: 'task completed' })
    expect(f.errors).toEqual([])
  })

  it('does not serialize reserved 1006 when the upstream disappears', async () => {
    const f = await fixture()
    expect(await f.open).toBeUndefined()
    const upstream = await f.upstreamPeer
    const done = closed(f.device)
    upstream.terminate()
    expect((await done).code).toBe(1006)
    expect(f.errors).toEqual([])
  })

  it('forwards an empty close without putting reserved 1005 into a frame', async () => {
    const f = await fixture()
    expect(await f.open).toBeUndefined()
    const upstream = await f.upstreamPeer
    const done = closed(f.device)
    upstream.close()
    expect(await done).toEqual({ code: 1005, reason: '' })
    expect(f.errors).toEqual([])
  })

  it('bounds closing when the upstream stops reading and cannot acknowledge the close', async () => {
    const f = await fixture()
    expect(await f.open).toBeUndefined()
    const upstream = await f.upstreamPeer
    const transport = f.upstreamTransport()
    if (transport === undefined) throw new Error('Missing upstream transport')
    upstream.pause()
    const done = new Promise<void>(resolve => { transport.once('close', resolve) })
    f.device.close(1000)
    await done
    expect(transport.destroyed).toBe(true)
    expect(await f.bridgeResult).toBeUndefined()
  })

  it('closes with 1009 when a compressed message exceeds the decoded size limit', async () => {
    const f = await fixture({ limits: { maxMessageBytes: 512 } })
    expect(await f.open).toBeUndefined()
    const upstream = await f.upstreamPeer
    const forwarded: RawData[] = []
    upstream.on('message', data => { forwarded.push(data) })
    const done = closed(f.device)
    f.device.send('a'.repeat(8_192), { compress: true })
    expect((await done).code).toBe(1009)
    expect(forwarded).toEqual([])
  })

  it('bounds multiple messages already buffered before their send callbacks drain', async () => {
    const frames = Buffer.concat([maskedText('a'.repeat(20)), maskedText('b'.repeat(20))])
    const f = await fixture({ head: frames, limits: { maxQueuedBytes: 64 } })
    const done = closed(f.device)
    expect(await f.open).toBeUndefined()
    expect((await done).code).toBe(1009)
  })

  it('rejects the bridge when the client leaves during the upstream handshake', async () => {
    const f = await fixture({ holdHandshake: true })
    await f.upstreamRequest
    const done = closed(f.device)
    f.device.terminate()
    await done
    expect(await f.bridgeResult).toBeInstanceOf(Error)
  })

  it('rejects an upstream HTTP refusal before accepting the client', async () => {
    const f = await fixture({ rejectHandshake: true })
    expect(await f.open).toBeInstanceOf(Error)
    expect(await f.bridgeResult).toBeInstanceOf(Error)
  })

  it('bounds an upstream handshake that never returns an upgrade', async () => {
    const f = await fixture({ holdHandshake: true, handshakeTimeoutMs: 150 })
    expect(await f.open).toBeInstanceOf(Error)
    expect(await f.bridgeResult).toBeInstanceOf(Error)
  })

  it('releases both legs when the device disconnects with compression still pending', async () => {
    const f = await fixture()
    expect(await f.open).toBeUndefined()
    const upstream = await f.upstreamPeer
    const hostClosed = closed(upstream)
    const deviceClosed = closed(f.device)
    f.device.send('pending inflate '.repeat(2_000), { compress: true })
    f.device.terminate()
    await Promise.all([hostClosed, deviceClosed])
    expect(await f.bridgeResult).toBeUndefined()
  })

  it('releases wrappers after the gateway destroys an accepted transport', async () => {
    const f = await fixture()
    expect(await f.open).toBeUndefined()
    expect(await f.bridgeResult).toBeUndefined()
    const upstream = await f.upstreamPeer
    const hostClosed = closed(upstream)
    const deviceClosed = closed(f.device)
    const client = f.clientTransport()
    if (client === undefined) throw new Error('Missing client transport')
    f.device.send('revoked while inflating '.repeat(1_000), { compress: true })
    client.destroy()
    await Promise.all([hostClosed, deviceClosed])
    expect(client.destroyed).toBe(true)
    expect(await f.bridgeResult).toBeUndefined()
  })
})
