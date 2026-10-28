import { createServer, request as requestHttp, type IncomingHttpHeaders, type Server } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { parseGatewayConfig } from '../src/config.js'
import { MobileAccessGateway } from '../src/gateway.js'
import { DEVICE_COOKIE } from '../src/http-security.js'
import { parseAuthority } from '../src/network.js'
import { MemoryDeviceStore, type DeviceStore } from '../src/storage.js'

interface HttpResult { readonly status: number; readonly headers: IncomingHttpHeaders; readonly body: string }
const origin = 'https://mobile.example.test'
const host = 'mobile.example.test'
const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve())
  })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('test proxy has no TCP address')
  return address.port
}

async function close(server: Server): Promise<void> {
  if (!server.listening) return
  server.closeAllConnections()
  await new Promise<void>(resolve => { server.close(() => resolve()) })
}

function beginRequest(port: number, path: string, body: Record<string, unknown>, headers: Record<string, string> = {}) {
  const serialized = JSON.stringify(body)
  let abort = (): void => {}
  const result = new Promise<HttpResult>((resolve, reject) => {
    const outgoing = requestHttp({
      host: '127.0.0.1', port, path, method: 'POST', agent: false,
      headers: { host, origin, 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(serialized)), ...headers },
    }, response => {
      const chunks: Buffer[] = []
      response.on('data', chunk => { chunks.push(Buffer.from(chunk)) })
      response.once('error', reject)
      response.once('end', () => resolve({ status: response.statusCode ?? 0, headers: response.headers, body: Buffer.concat(chunks).toString('utf8') }))
    })
    outgoing.once('error', reject)
    outgoing.end(serialized)
    abort = () => { outgoing.destroy() }
  })
  return { result, abort: () => abort() }
}

async function post(port: number, path: string, body: Record<string, unknown>, headers?: Record<string, string>): Promise<HttpResult> {
  return beginRequest(port, path, body, headers).result
}

async function within<T>(task: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      task,
      new Promise<T>((_resolve, reject) => { timer = setTimeout(() => reject(new Error('authentication request did not settle promptly')), 2_000) }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

async function fixture(overrides: Record<string, unknown> = {}, storeFactory?: (backing: MemoryDeviceStore) => DeviceStore) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-mobile-auth-rate-limits-'))
  const backing = new MemoryDeviceStore()
  const base = parseGatewayConfig({
    listenHost: '127.0.0.1', listenPort: 0,
    upstreamOrigin: 'http://127.0.0.1:1', publicAuthorities: ['127.0.0.1'],
    allowedCidrs: ['127.0.0.0/8'], stateFile: join(root, 'devices.json'), tls: { mode: 'disabled' },
    maxPairingAttempts: 2, maxDevices: 2, ...overrides,
  })
  // The test proxy represents HTTPS termination. The Gateway remains an HTTP
  // loopback listener but validates the public HTTPS Host and Origin.
  const config = Object.freeze({ ...base, authorities: Object.freeze([parseAuthority(`${host}:443`)]), publicTls: true, discovery: false })
  const gateway = new MobileAccessGateway(config, storeFactory?.(backing) ?? backing)
  let proxy: Server | undefined
  try {
    await gateway.start()
    proxy = createServer((incoming, response) => {
      const upstream = requestHttp({
        host: '127.0.0.1', port: gateway.address().port, path: incoming.url, method: incoming.method,
        headers: { ...incoming.headers, host }, agent: false,
      }, result => {
        response.writeHead(result.statusCode ?? 502, result.headers)
        result.pipe(response)
      })
      upstream.on('error', () => { if (!response.headersSent) response.writeHead(502); response.end() })
      response.once('close', () => { upstream.destroy() })
      incoming.pipe(upstream)
    })
    const port = await listen(proxy)
    const ownedProxy = proxy
    cleanups.push(async () => { await close(ownedProxy); await gateway.close(); await rm(root, { recursive: true, force: true }) })
    return { port, gateway, backing }
  } catch (error) {
    if (proxy !== undefined) await close(proxy)
    await gateway.close()
    await rm(root, { recursive: true, force: true })
    throw error
  }
}

function cookie(headers: IncomingHttpHeaders, name: string): string {
  const values = headers['set-cookie'] ?? []
  const line = values.find(value => value.startsWith(`${name}=`))
  if (line === undefined) throw new Error('test pairing response omitted a device Cookie')
  return line.slice(name.length + 1).split(';', 1)[0] ?? ''
}

async function browserPair(port: number, gateway: MobileAccessGateway) {
  const opened = await gateway.access.openPairing()
  const response = await post(port, '/mobile-access/auth/pair', { token: opened.token, label: 'Browser device' })
  expect(response.status).toBe(201)
  return { deviceId: (JSON.parse(response.body) as { deviceId: string }).deviceId, token: cookie(response.headers, DEVICE_COOKIE) }
}

async function nativePair(port: number, gateway: MobileAccessGateway) {
  const opened = await gateway.access.openPairing()
  const response = await post(port, '/mobile-access/auth/native-pair', { token: opened.token, label: 'App device' })
  expect(response.status).toBe(201)
  return JSON.parse(response.body) as { deviceId: string; deviceToken: string }
}

describe('authenticated work behind one HTTPS proxy peer', () => {
  it('keeps browser and native pairing usable after forged-client invalid attempts exhaust the peer budget', async () => {
    const { port, gateway } = await fixture()
    const statuses: number[] = []
    for (const forwarded of ['198.51.100.1', '198.51.100.2', '198.51.100.3']) {
      statuses.push((await post(port, '/mobile-access/auth/pair', { token: 'wrong' }, { 'x-forwarded-for': forwarded })).status)
    }
    expect(statuses).toEqual([401, 401, 429])
    const browser = await browserPair(port, gateway)
    const app = await nativePair(port, gateway)
    expect(browser.deviceId).not.toBe(app.deviceId)
    expect(gateway.devices()).toHaveLength(2)
  })

  it('keeps valid browser and native renewal and probe separate from invalid peer failures', async () => {
    const { port, gateway, backing } = await fixture()
    const browser = await browserPair(port, gateway)
    const app = await nativePair(port, gateway)
    const before = backing.inspect()
    const renewStatuses: number[] = []
    for (let attempt = 0; attempt < 9; attempt++) {
      renewStatuses.push((await post(port, '/mobile-access/auth/renew', {}, { 'x-forwarded-for': `198.51.100.${String(attempt + 1)}` })).status)
    }
    expect(renewStatuses).toEqual([...Array<number>(8).fill(401), 429])
    expect(backing.inspect()).toEqual(before)
    expect((await post(port, '/mobile-access/auth/renew', {}, { cookie: `${DEVICE_COOKIE}=${browser.token}` })).status).toBe(200)
    expect((await post(port, '/mobile-access/auth/native-renew', { deviceToken: app.deviceToken })).status).toBe(200)

    const probeStatuses: number[] = []
    for (let attempt = 0; attempt < 9; attempt++) {
      probeStatuses.push((await post(port, '/mobile-access/auth/native-probe', { deviceToken: 'wrong' },
        { 'x-forwarded-for': `203.0.113.${String(attempt + 1)}` })).status)
    }
    expect(probeStatuses).toEqual([...Array<number>(8).fill(401), 429])
    expect((await post(port, '/mobile-access/auth/native-probe', { deviceToken: browser.token })).status).toBe(200)
    expect((await post(port, '/mobile-access/auth/native-probe', { deviceToken: app.deviceToken })).status).toBe(200)
  })

  it('limits each valid device without letting it spend another device’s renewal or probe budget', async () => {
    const { port, gateway } = await fixture({ maxPairingAttempts: 1, maxRateLimitKeys: 1 })
    const first = await nativePair(port, gateway)
    const second = await nativePair(port, gateway)
    const renewStatuses = []
    for (let attempt = 0; attempt < 5; attempt++) {
      renewStatuses.push((await post(port, '/mobile-access/auth/native-renew', { deviceToken: first.deviceToken })).status)
    }
    expect(renewStatuses).toEqual([200, 200, 200, 200, 429])
    expect((await post(port, '/mobile-access/auth/native-renew', { deviceToken: second.deviceToken })).status).toBe(200)
    const probeStatuses = []
    for (let attempt = 0; attempt < 9; attempt++) {
      probeStatuses.push((await post(port, '/mobile-access/auth/native-probe', { deviceToken: first.deviceToken })).status)
    }
    expect(probeStatuses).toEqual([...Array<number>(8).fill(200), 429])
    expect((await post(port, '/mobile-access/auth/native-probe', { deviceToken: second.deviceToken })).status).toBe(200)

    await gateway.access.revokeDevice(first.deviceId)
    const replacement = await nativePair(port, gateway)
    expect((await post(port, '/mobile-access/auth/native-renew', { deviceToken: replacement.deviceToken })).status).toBe(200)
    expect((await post(port, '/mobile-access/auth/native-probe', { deviceToken: replacement.deviceToken })).status).toBe(200)
  })

  it.each(['native-renew', 'native-probe'] as const)('holds one %s per device until its durable operation settles, even after disconnect', async route => {
    let holdNextWrite = false
    let announceWrite!: () => void
    const writing = new Promise<void>(resolve => { announceWrite = resolve })
    let releaseWrite!: () => void
    const held = new Promise<void>(resolve => { releaseWrite = resolve })
    const { port, gateway } = await fixture({}, backing => ({
      load: () => backing.load(),
      async save(snapshot) {
        if (holdNextWrite) {
          holdNextWrite = false
          announceWrite()
          await held
        }
        await backing.save(snapshot)
      },
    }))
    const first = await nativePair(port, gateway)
    const second = await nativePair(port, gateway)
    const path = `/mobile-access/auth/${route}`
    holdNextWrite = true
    const disconnected = beginRequest(port, path, { deviceToken: first.deviceToken })
    void disconnected.result.catch(() => {})
    let other: Promise<HttpResult> | undefined
    try {
      await writing
      disconnected.abort()
      const duplicate = await within(post(port, path, { deviceToken: first.deviceToken }))
      expect(duplicate.status).toBe(429)
      other = post(port, path, { deviceToken: second.deviceToken })
    } finally {
      releaseWrite()
    }
    await Promise.allSettled([disconnected.result])
    expect((await other).status).toBe(200)
    expect((await post(port, path, { deviceToken: first.deviceToken })).status).toBe(200)
  })

  it.each(['native-renew', 'native-probe'] as const)('releases %s admission after a failed durable write', async route => {
    let failNextWrite = false
    const { port, gateway, backing } = await fixture({}, store => ({
      load: () => store.load(),
      async save(snapshot) {
        if (failNextWrite) {
          failNextWrite = false
          throw new Error('owned fixture write failure')
        }
        await store.save(snapshot)
      },
    }))
    const device = await nativePair(port, gateway)
    const before = backing.inspect()
    const path = `/mobile-access/auth/${route}`
    failNextWrite = true
    expect((await post(port, path, { deviceToken: device.deviceToken })).status).toBe(500)
    expect(backing.inspect()).toEqual(before)
    expect((await post(port, path, { deviceToken: device.deviceToken })).status).toBe(200)
  })
})
