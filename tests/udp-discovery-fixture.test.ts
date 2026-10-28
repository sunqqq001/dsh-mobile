import { createSocket, Socket } from 'node:dgram'
import { createServer } from 'node:net'
import { afterEach, expect, it } from 'vitest'
import { startWithMappedUdpDiscovery } from './udp-discovery-fixture.js'

const fixtures: Fixture[] = []

async function closeSocket(socket: Socket): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    try { Reflect.apply(Socket.prototype.close, socket, [resolve]) } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ERR_SOCKET_DGRAM_NOT_RUNNING') resolve()
      else reject(error)
    }
  })
}

class Fixture {
  discoverySocket: Socket | undefined
  readonly server = createServer()
  readonly sockets: Socket[] = []
  starts = 0
  closes = 0
  requestedPort: number | undefined
  bindError = false
  borrowBind = false
  status: { broadcast: boolean; mdns: boolean; errorCode?: string } = { broadcast: true, mdns: true }

  constructor() { fixtures.push(this) }
  address() {
    const address = this.server.address()
    if (address === null || typeof address === 'string') throw new Error('Fixture TCP listener is not ready')
    return { host: '127.0.0.1', port: address.port, origin: `http://127.0.0.1:${address.port}` }
  }
  discoveryStatus() { return this.status }
  socket() { const socket = createSocket('udp4'); this.sockets.push(socket); return socket }
  async start() {
    this.starts += 1
    await new Promise<void>((resolve, reject) => { this.server.once('error', reject); this.server.listen(0, '127.0.0.1', resolve) })
    const socket = this.socket()
    if (this.bindError) Object.defineProperty(socket, 'bind', {
      configurable: true, writable: true,
      value: function (this: Socket) { this.emit('error', Object.assign(new Error('bind denied'), { code: 'EACCES' })); return this },
    })
    this.discoverySocket = socket
    if (this.borrowBind) {
      const other = this.socket()
      await new Promise<void>((resolve, reject) => {
        other.once('error', reject)
        Reflect.apply(socket.bind, other, [0, '127.0.0.1', resolve])
      })
    }
    socket.on('message', (message, remote) => { socket.send(message, remote.port, remote.address) })
    await new Promise<void>((resolve, reject) => {
      socket.once('error', reject)
      socket.bind(this.requestedPort ?? this.address().port, '127.0.0.1', resolve)
    })
  }
  async close() {
    this.closes += 1
    const socket = this.discoverySocket
    this.discoverySocket = undefined
    if (socket !== undefined) await closeSocket(socket)
    if (this.server.listening) await new Promise<void>(resolve => { this.server.close(() => resolve()) })
  }
  async cleanup() {
    for (const socket of this.sockets) await closeSocket(socket)
    if (this.server.listening) await new Promise<void>(resolve => { this.server.close(() => resolve()) })
  }
}

afterEach(async () => { for (const fixture of fixtures.splice(0)) await fixture.cleanup() })

it('maps only the owned bind, keeps real UDP and restores the live socket for normal close', async () => {
  const fixture = new Fixture()
  fixture.borrowBind = true
  const originalField = Object.getOwnPropertyDescriptor(fixture, 'discoverySocket')
  const originalPrototypeBind = Socket.prototype.bind
  const port = await startWithMappedUdpDiscovery(fixture)
  const socket = fixture.discoverySocket!
  expect(port).toBe(socket.address().port)
  expect(Object.getOwnPropertyDescriptor(fixture, 'discoverySocket')).toEqual({ ...originalField, value: socket })
  expect(Object.hasOwn(socket, 'bind')).toBe(false)
  expect(Object.hasOwn(socket, 'close')).toBe(false)
  expect(Socket.prototype.bind).toBe(originalPrototypeBind)
  const client = fixture.socket()
  const message = await new Promise<Buffer>((resolve, reject) => {
    client.once('error', reject)
    client.once('message', resolve)
    client.send(Buffer.from('mapped UDP'), port, '127.0.0.1')
  })
  expect(message.toString()).toBe('mapped UDP')
  expect(fixture.starts).toBe(1)
  expect(fixture.closes).toBe(0)
  await fixture.close()
  expect(fixture.discoverySocket).toBeUndefined()
})

it('fails before startup if the private socket data field is missing', async () => {
  const fixture = new Fixture()
  Reflect.deleteProperty(fixture, 'discoverySocket')
  await expect(startWithMappedUdpDiscovery(fixture)).rejects.toThrow('unstarted discoverySocket data field')
  expect(fixture.starts).toBe(0)
  expect(fixture.closes).toBe(1)
})

it('rejects duplicate sockets and closes the formerly owned bound socket', async () => {
  const fixture = new Fixture()
  const start = fixture.start.bind(fixture)
  fixture.start = async () => { await start(); fixture.discoverySocket = fixture.socket() }
  await expect(startWithMappedUdpDiscovery(fixture)).rejects.toThrow('multiple discovery sockets')
  expect(() => fixture.sockets[0]!.address()).toThrow()
  expect(fixture.starts).toBe(1)
})

it('fails when production requests a different port instead of silently remapping it', async () => {
  const fixture = new Fixture()
  fixture.requestedPort = 0
  await expect(startWithMappedUdpDiscovery(fixture)).rejects.toThrow('advertised HTTP port exactly once')
  expect(fixture.starts).toBe(1)
})

it('propagates a bind failure without another start', async () => {
  const fixture = new Fixture()
  fixture.bindError = true
  await expect(startWithMappedUdpDiscovery(fixture)).rejects.toThrow('bind denied')
  expect(fixture.starts).toBe(1)
})

it('awaits a producer close after post-bind failure clears the field', async () => {
  const fixture = new Fixture()
  const start = fixture.start.bind(fixture)
  let closed = false
  fixture.start = async () => {
    await start()
    const socket = fixture.discoverySocket!
    socket.once('close', () => { closed = true })
    fixture.discoverySocket = undefined
    socket.close()
    fixture.status = { broadcast: false, mdns: true, errorCode: 'discovery_broadcast_EACCES' }
  }
  await expect(startWithMappedUdpDiscovery(fixture)).rejects.toThrow('discovery_broadcast_EACCES')
  expect(closed).toBe(true)
  expect(fixture.starts).toBe(1)
})

it('restores original flags and reports descriptor drift without losing close ownership', async () => {
  const fixture = new Fixture()
  const start = fixture.start.bind(fixture)
  fixture.start = async () => { await start(); Object.defineProperty(fixture, 'discoverySocket', { enumerable: false }) }
  await expect(startWithMappedUdpDiscovery(fixture)).rejects.toThrow('descriptor flags changed')
  expect(Object.getOwnPropertyDescriptor(fixture, 'discoverySocket')?.enumerable).toBe(true)
  expect(() => fixture.sockets[0]!.address()).toThrow()
})

it('reports cleanup failure together with the original discovery failure', async () => {
  const fixture = new Fixture()
  fixture.status = { broadcast: false, mdns: true, errorCode: 'discovery_broadcast_EACCES' }
  const close = fixture.close.bind(fixture)
  const closeError = new Error('controlled cleanup failure')
  fixture.close = async () => { await close(); throw closeError }
  const error = await startWithMappedUdpDiscovery(fixture).catch((value: unknown) => value)
  expect(error).toBeInstanceOf(AggregateError)
  if (!(error instanceof AggregateError)) throw new Error('Expected combined startup and cleanup failures')
  expect(error.errors).toContain(closeError)
  expect(fixture.starts).toBe(1)
})

it('rejects when socket close throws before requesting closure instead of awaiting a missing event', async () => {
  const fixture = new Fixture()
  const start = fixture.start.bind(fixture)
  const closeError = new Error('socket close refused')
  fixture.start = async () => {
    await start()
    Object.defineProperty(fixture.discoverySocket, 'close', {
      configurable: true, writable: true, value: () => { throw closeError },
    })
    fixture.status = { broadcast: false, mdns: true, errorCode: 'discovery_broadcast_EACCES' }
  }
  fixture.close = async () => {
    fixture.closes += 1
    fixture.discoverySocket?.close()
  }
  const error = await startWithMappedUdpDiscovery(fixture).catch((value: unknown) => value)
  expect(error).toBeInstanceOf(AggregateError)
  if (!(error instanceof AggregateError)) throw new Error('Expected visible startup and socket-close failures')
  expect(error.errors).toContain(closeError)
  expect(fixture.starts).toBe(1)
  expect(fixture.closes).toBe(1)
})
