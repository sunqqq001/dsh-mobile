import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { Duplex } from 'node:stream'
import { describe, expect, it } from 'vitest'
import { relayProbeThroughProxy } from '../src/diagnostics.js'

async function expectClosed(closed: Promise<void>): Promise<void> {
  let timer: NodeJS.Timeout | undefined
  try {
    await Promise.race([
      closed,
      new Promise<never>((_resolve, reject) => { timer = setTimeout(() => { reject(new Error('CONNECT socket remained open')) }, 1_000) }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

async function withConnectProxy(
  respond: (socket: Duplex) => void,
  run: (proxy: URL, closed: Promise<void>) => Promise<void>,
): Promise<void> {
  const sockets = new Set<Duplex>()
  let markClosed: (() => void) | undefined
  const closed = new Promise<void>(resolve => { markClosed = resolve })
  const server = createServer()
  server.on('connect', (_request, socket) => {
    sockets.add(socket)
    socket.once('close', () => { sockets.delete(socket); markClosed?.() })
    socket.once('end', () => { socket.end() })
    respond(socket)
    socket.resume()
  })
  try {
    await new Promise<void>(resolve => { server.listen(0, '127.0.0.1', resolve) })
    const port = (server.address() as AddressInfo).port
    await run(new URL(`http://127.0.0.1:${port}`), closed)
  } finally {
    for (const socket of sockets) socket.destroy()
    await new Promise<void>(resolve => { server.close(() => resolve()) })
  }
}

describe('relay diagnostic socket ownership', () => {
  const target = new URL('https://example.test/mobile-access/health')

  it('closes a keep-alive CONNECT socket after proxy rejection', async () => {
    await withConnectProxy(
      socket => { socket.write('HTTP/1.1 407 Proxy Authentication Required\r\nConnection: keep-alive\r\nContent-Length: 0\r\n\r\n') },
      async (proxy, closed) => {
        await expect(relayProbeThroughProxy(target, proxy, 300)).rejects.toThrow('proxy_tunnel_rejected_407')
        await expectClosed(closed)
      },
    )
  })

  it('closes the pending CONNECT request when the relay never answers', async () => {
    await withConnectProxy(
      () => {},
      async (proxy, closed) => {
        await expect(relayProbeThroughProxy(target, proxy, 80)).rejects.toThrow('proxy_tunnel_timeout')
        await expectClosed(closed)
      },
    )
  })
})
