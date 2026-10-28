import { spawn, type ChildProcess, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createServer, request as httpRequest, type IncomingHttpHeaders, type IncomingMessage } from 'node:http'
import { channel } from 'node:diagnostics_channel'
import { request } from 'node:https'
import { connect as connectHttp2, type ClientHttp2Stream } from 'node:http2'
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { once } from 'node:events'
import WebSocket, { WebSocketServer } from 'ws'
import { afterEach, expect, it, vi } from 'vitest'
import { execFileText } from '../src/exec-file.js'
import { CaddyConfigStore, parseCaddySettings, renderCaddyfile } from '../src/caddy-config.js'
import { CaddyController, caddyProcessEnvironment } from '../src/caddy.js'
import { CaddyComponentManager, type CaddyArtifact } from '../src/caddy-component.js'
import { createVolatileRemoteControlStore } from '../src/managed-origin.js'
import { parseGatewayConfig } from '../src/config.js'
import { MobileAccessGateway } from '../src/gateway.js'
import { JsonDeviceStore } from '../src/storage.js'
import { installedCaddyFixture } from './helpers/caddy-component-fixture.js'
import { observeCaddyListener } from './helpers/caddy-listener.js'
import { waitForCaddyTls } from './helpers/caddy-tls-ready.js'
import { remoteGatewayConfig } from '../src/plugin.js'
import { terminateRemoteProcess } from '../src/remote.js'
import { CSRF_COOKIE, CSRF_HEADER, DEVICE_COOKIE, SESSION_COOKIE, parseCookies } from '../src/http-security.js'

const inputExecutable = process.env.DSH_CADDY_TEST_EXECUTABLE
const manifestFile = process.env.DSH_CADDY_TEST_MANIFEST
const cleanups: (() => Promise<void>)[] = []
let fixtureController: AbortController | undefined
let activeBodyTask: Promise<void> | undefined
afterEach(async () => {
  // Runner timeout alone does not cancel its callback. Quiesce the inner work before taking the cleanup snapshot.
  fixtureController?.abort(new Error('Live fixture teardown'))
  try { await activeBodyTask } catch { /* The test body reports its own failure. */ }
  activeBodyTask = undefined
  fixtureController = undefined
  const errors: unknown[] = []
  for (const cleanup of cleanups.splice(0).reverse()) {
    try { await cleanup() } catch (error) { errors.push(error) }
  }
  if (errors.length > 0) throw new AggregateError(errors, 'Owned live-fixture cleanup failed')
}, 60_000)

function exchange(signal: AbortSignal, port: number, ca: string, path: string, method = 'GET', headers: Record<string, string> = {}, body = '', idleTimeoutMs = 10_000): Promise<{ status: number; headers: IncomingHttpHeaders; body: string; rawBody: Buffer; receivedAt: number[] }> {
  return new Promise((resolve, reject) => {
    const outgoing = request({ host: '127.0.0.1', port, servername: 'phone.example.com', ca, agent: false, method, path, signal,
      headers: { host: 'phone.example.com', origin: 'https://phone.example.com', 'sec-fetch-site': 'same-origin', ...headers },
    }, incoming => {
      const chunks: Buffer[] = []
      const receivedAt: number[] = []
      incoming.on('data', (chunk: Buffer) => { chunks.push(chunk); receivedAt.push(performance.now()) })
      incoming.once('end', () => { const rawBody = Buffer.concat(chunks); resolve({ status: incoming.statusCode ?? 0, headers: incoming.headers, body: rawBody.toString(), rawBody, receivedAt }) })
      incoming.once('error', reject)
    })
    outgoing.setTimeout(idleTimeoutMs, () => outgoing.destroy(new Error('TLS request timeout: ' + method + ' ' + path.split('?', 1)[0])))
    outgoing.once('error', reject); outgoing.end(body)
  })
}

async function exchangeHttp2(signal: AbortSignal, port: number, ca: string, path: string, headers: Record<string, string>, body: string): Promise<{ status: number; body: string; receivedAt: number[] }> {
  signal.throwIfAborted()
  const client = connectHttp2('https://127.0.0.1:' + String(port), { ca, servername: 'phone.example.com' })
  const closed = new Promise<void>(resolve => { client.once('close', resolve) })
  let stream: ClientHttp2Stream | undefined
  const abort = (): void => { client.destroy(new Error('Quiet HTTP/2 request aborted')) }
  signal.addEventListener('abort', abort, { once: true })
  try {
    return await new Promise((resolve, reject) => {
      client.on('error', reject)
      stream = client.request({ ':method': 'POST', ':path': path, ':authority': 'phone.example.com',
        origin: 'https://phone.example.com', 'sec-fetch-site': 'same-origin', ...headers })
      const chunks: Buffer[] = []
      const receivedAt: number[] = []
      let status = 0
      let ended = false
      stream.once('response', responseHeaders => { status = Number(responseHeaders[':status']) })
      stream.on('data', (chunk: Buffer) => { chunks.push(chunk); receivedAt.push(performance.now()) })
      stream.once('error', reject)
      stream.once('end', () => { ended = true; resolve({ status, body: Buffer.concat(chunks).toString(), receivedAt }) })
      stream.once('close', () => { if (!ended) reject(new Error('Quiet HTTP/2 stream closed before EOF')) })
      stream.setTimeout(80_000, () => { client.destroy(new Error('Quiet HTTP/2 stream timed out')) })
      stream.end(body)
    })
  } finally {
    signal.removeEventListener('abort', abort)
    stream?.close()
    client.destroy()
    await closed
  }
}

/** One direct, cookie-free boundary probe; never follows redirects or proxy environment. */
async function directUnauthenticated(signal: AbortSignal, port: number, path: string): Promise<{ status: number; headers: IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const outgoing = httpRequest({ host: '127.0.0.1', port, path, method: 'GET', agent: false, signal,
      headers: { host: 'phone.example.com', origin: 'https://phone.example.com', 'sec-fetch-site': 'same-origin' },
    }, incoming => {
      let body = ''
      incoming.on('data', (chunk: Buffer) => { body = (body + chunk.toString()).slice(0, 2048) })
      incoming.once('end', () => resolve({ status: incoming.statusCode ?? 0, headers: incoming.headers, body }))
      incoming.once('error', reject)
    })
    outgoing.setTimeout(10_000, () => outgoing.destroy(new Error('Direct gateway request timeout')))
    outgoing.once('error', reject); outgoing.end()
  })
}

function responseDiagnostic(response: { status: number; headers: IncomingHttpHeaders; body: string }): string {
  const names = ['content-type', 'content-length', 'cache-control', 'strict-transport-security', 'server']
  return JSON.stringify({ status: response.status, body: response.body.slice(0, 2048),
    headers: Object.fromEntries(names.map(name => [name, String(response.headers[name] ?? '').slice(0, 512)])),
  })
}

it.runIf(inputExecutable !== undefined || manifestFile !== undefined)('runs optional installed Caddy through trusted TLS, durable pairing, API/WSS, restart, corruption and purge', async () => {
  if (inputExecutable === undefined) throw new Error('Explicit test executable required')
  fixtureController = new AbortController()
  const signal = fixtureController.signal
  const controller = fixtureController
  // The quiet API regression deliberately crosses 60s; setup, three native starts and cleanup retain separate headroom.
  const deadline = setTimeout(() => controller.abort(new Error('Live fixture 180s deadline exceeded')), 180_000)
  const body = async (): Promise<void> => {
  const childLogs = new Map<string, string>()
  const diagnostics = (): string => [...childLogs].map(([name, text]) => name + ': ' + text).join('\n').slice(-8192)
  const captureChild = (name: string, child: ChildProcessWithoutNullStreams): ReturnType<typeof observeCaddyListener> => {
    const listener = observeCaddyListener(child)
    cleanups.push(async () => { listener.dispose() })
    childLogs.set(name, '')
    child.stdout.resume()
    child.stderr.on('data', (chunk: Buffer) => { childLogs.set(name, (childLogs.get(name)! + chunk.toString()).slice(-8192)) })
    child.stdin.end()
    return listener
  }
  const step = async <T>(operation: () => Promise<T>): Promise<T> => {
    signal.throwIfAborted()
    const result = await operation()
    signal.throwIfAborted()
    return result
  }
  const phaseStep = async <T>(name: string, operation: () => Promise<T>): Promise<T> => {
    try { return await step(operation) } catch (error) {
      throw new Error('Caddy live phase ' + name + ' failed; owned stderr=' + diagnostics(), { cause: error })
    }
  }
  signal.throwIfAborted()
  const root = await mkdtemp(join(tmpdir(), 'dsh-mobile-caddy-live-'))
  const ownedChildren: { child: ChildProcess; closed: boolean }[] = []
  const ownChild = (child: ChildProcess): (() => Promise<void>) => {
    const owned = { child, closed: false }
    ownedChildren.push(owned)
    // Register immediately after spawn: only the actual close event confirms all child handles closed.
    child.once('close', () => { owned.closed = true })
    const stop = async (): Promise<void> => {
      if (!owned.closed) await terminateRemoteProcess(child)
      // terminateRemoteProcess can return on exitCode before stdio's close event.
      if (!owned.closed) await once(child, 'close', { signal: AbortSignal.timeout(1_500) })
    }
    cleanups.push(stop)
    return stop
  }
  cleanups.push(async () => {
    // Independent cleanup still runs on stop failure, but never remove files under an unclosed child.
    if (ownedChildren.some(owned => !owned.closed)) {
      throw new Error('Owned Caddy close unconfirmed; retained fixture root: ' + root)
    }
    // Only the root allocated by this test is recursively removed.
    expect((await lstat(root)).isDirectory()).toBe(true)
    await rm(root, { recursive: true, force: true })
  })
  // A late mkdtemp result is owned before the cancellation check.
  signal.throwIfAborted()
  const fixture = manifestFile === undefined ? undefined : await step(() => installedCaddyFixture(root, inputExecutable, manifestFile, fn => cleanups.push(fn), signal))
  const executable = fixture?.executable ?? inputExecutable
  const upstreamRequests = new Map<string, number>()
  const upstreamSockets = new Map<string, IncomingMessage['socket']>()
  const upstreamConnections = new Map<string, string | undefined>()
  const consumedBodies = new Map<string, Buffer>()
  const quietTimers = new Set<NodeJS.Timeout>()
  const quietRequests = new Map<string, { started: number; completed?: number }>()
  const gatewayRequests = new Map<string, number>()
  const gatewaySockets = new Map<string, IncomingMessage['socket']>()
  const gatewayVersions = new Map<string, string>()
  const upstream = createServer((incoming, outgoing) => {
    const target = new URL(incoming.url!, 'http://owned-fixture')
    const id = target.searchParams.get('requestId')
    if (id !== null) {
      upstreamRequests.set(id, (upstreamRequests.get(id) ?? 0) + 1)
      upstreamSockets.set(id, incoming.socket)
      upstreamConnections.set(id, incoming.headers.connection)
    }
    if (target.pathname === '/api/caddy-test-quiet-headers' || target.pathname === '/api/caddy-test-quiet-body') {
      if (id === null || incoming.method !== 'POST') { outgoing.writeHead(400); outgoing.end(); return }
      const chunks: Buffer[] = []
      incoming.on('error', () => { outgoing.destroy() })
      incoming.on('data', (chunk: Buffer) => chunks.push(chunk))
      incoming.once('end', () => {
        consumedBodies.set(id, Buffer.concat(chunks))
        const observation: { started: number; completed?: number } = { started: performance.now() }
        quietRequests.set(id, observation)
        const streaming = target.pathname === '/api/caddy-test-quiet-body'
        if (streaming) {
          outgoing.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' })
          outgoing.write('data: stream-start\n\n')
        }
        const timer = setTimeout(() => {
          quietTimers.delete(timer)
          observation.completed = performance.now()
          if (!outgoing.headersSent) outgoing.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' })
          outgoing.end(streaming ? 'data: quiet-complete\n\n' : 'quiet-complete')
        }, 65_000)
        quietTimers.add(timer)
        outgoing.once('close', () => { clearTimeout(timer); quietTimers.delete(timer) })
      })
      return
    }
    if (target.pathname === '/api/caddy-test-reset' || target.pathname === '/api/caddy-test-gateway-reset') {
      const chunks: Buffer[] = []
      incoming.on('error', () => undefined)
      incoming.on('data', (chunk: Buffer) => chunks.push(chunk))
      incoming.once('end', () => {
        consumedBodies.set(id!, Buffer.concat(chunks))
        if (target.pathname === '/api/caddy-test-gateway-reset') {
          // Simulate a first-hop failure AFTER the upstream has committed its side effect.
          gatewaySockets.get(id!)!.resetAndDestroy()
          outgoing.end('side-effect-committed')
        } else incoming.socket.destroy()
      })
      return
    }
    if (target.pathname === '/api/caddy-test-resource') { outgoing.writeHead(200, { 'content-type': 'application/octet-stream' }); outgoing.end(Buffer.from([0, 1, 2, 250])); return }
    outgoing.writeHead(404); outgoing.end()
  })
  const webSockets = new WebSocketServer({ noServer: true })
  const peers = new Set<WebSocket>()
  webSockets.on('connection', peer => { peers.add(peer); peer.on('message', data => peer.send(data)); peer.on('close', () => peers.delete(peer)) })
  upstream.on('upgrade', (incoming, socket, head) => { webSockets.handleUpgrade(incoming, socket, head, peer => webSockets.emit('connection', peer, incoming)) })
  cleanups.push(async () => {
    for (const timer of quietTimers) clearTimeout(timer)
    quietTimers.clear()
    for (const peer of peers) peer.terminate()
    await new Promise<void>(resolve => webSockets.close(() => resolve()))
    upstream.closeAllConnections()
    await new Promise<void>(resolve => upstream.close(() => resolve()))
  })
  await step(() => new Promise<void>((resolve, reject) => { upstream.once('error', reject); upstream.listen(0, '127.0.0.1', resolve) }))
  const upstreamAddress = upstream.address(); if (upstreamAddress === null || typeof upstreamAddress === 'string') throw new Error('missing port')
  const template = parseGatewayConfig({ listenHost: '127.0.0.1', listenPort: 0, tls: { mode: 'disabled' },
    stateFile: join(root, 'devices.json'), upstreamOrigin: 'http://127.0.0.1:' + String(upstreamAddress.port),
    publicAuthorities: ['127.0.0.1'], allowedCidrs: ['127.0.0.0/8'],
  })
  const store = new JsonDeviceStore(template.stateFile)
  const gatewayConfig = remoteGatewayConfig(template, 'https://phone.example.com', template.stateFile, 'a'.repeat(64))
  const gateway = new MobileAccessGateway(gatewayConfig, store)
  cleanups.push(() => gateway.close())
  await step(() => gateway.start())
  const gatewayPort = gateway.address().port
  const requestStarts = channel('http.server.request.start')
  const observeGatewayRequest = (message: unknown): void => {
    const incoming = (message as { request: IncomingMessage }).request
    if (incoming.socket.localPort !== gatewayPort) return
    const id = new URL(incoming.url!, 'http://owned-fixture').searchParams.get('requestId')
    if (id === null) return
    gatewayRequests.set(id, (gatewayRequests.get(id) ?? 0) + 1)
    gatewaySockets.set(id, incoming.socket)
    gatewayVersions.set(id, incoming.httpVersion)
  }
  requestStarts.subscribe(observeGatewayRequest)
  cleanups.push(async () => { requestStarts.unsubscribe(observeGatewayRequest) })
  const settings = parseCaddySettings({ publicOrigin: 'https://phone.example.com', dnsProvider: 'tencentcloud', listenPort: 8443 })
  const config = new CaddyConfigStore(root)
  await step(() => config.configure(settings, { secretId: 'fake-id', secretKey: 'fake-key' }))
  await step(() => config.prepareCaddyfile(gateway.address().port))
  const environment = caddyProcessEnvironment(config, settings)
  // Validate the actual DNS-01 template without contacting DNS or acquiring a production certificate.
  await step(() => execFileText(executable, ['adapt', '--config', config.caddyfile, '--adapter', 'caddyfile'], { env: environment, timeout: 15_000 }))
  const rendered = renderCaddyfile(settings, root, gateway.address().port)
  expect(rendered.match(/https:\/\/phone\.example\.com:8443 \{/gu)).toHaveLength(1)
  expect(rendered.match(/\ttls \{\n\t\tdns tencentcloud \{[\s\S]*?\n\t\t\}\n\t\}/gu)).toHaveLength(1)
  const internal = rendered
    .replace('{\n', '{\n\tskip_install_trust\n\tservers {\n\t\tprotocols h1 h2\n\t}\n')
    .replace('https://phone.example.com:8443 {', 'https://phone.example.com:0 {\n\tbind 127.0.0.1')
    .replace(/\ttls \{\n\t\tdns tencentcloud \{[\s\S]*?\n\t\t\}\n\t\}/u, '\ttls internal')
    .replace('output discard', 'output stderr\n\t\tformat json')
  const testConfig = join(config.rootDirectory, 'Caddyfile.internal-test')
  await step(() => writeFile(testConfig, internal, { mode: 0o600 }))
  expect(internal).toContain('\tskip_install_trust\n')
  expect(internal).toContain('https://phone.example.com:0 {\n\tbind 127.0.0.1')
  expect(internal).toContain('\ttls internal\n')
  expect(internal).not.toMatch(/dns|acme|tencentcloud|8443/iu)
  const adapted = JSON.parse((await step(() => execFileText(executable, ['adapt', '--config', testConfig, '--adapter', 'caddyfile'], { env: environment, timeout: 15_000 }))).stdout)
  expect(adapted.apps.tls.automation.policies[0].issuers).toEqual([{ module: 'internal' }])
  expect(adapted.apps.http.servers.srv0.listen).toEqual(['127.0.0.1:0'])
  const proxyHandlers: { transport?: { protocol?: string; keep_alive?: { enabled?: boolean; max_idle_conns_per_host?: number }; versions?: string[] } }[] = []
  const findProxyHandlers = (value: unknown): void => {
    if (typeof value !== 'object' || value === null) return
    const row = value as Record<string, unknown>
    if (row.handler === 'reverse_proxy') proxyHandlers.push(row)
    for (const child of Object.values(row)) findProxyHandlers(child)
  }
  findProxyHandlers(adapted)
  expect(proxyHandlers).toHaveLength(1)
  expect(proxyHandlers[0]!.transport?.protocol).toBe('http')
  expect(proxyHandlers[0]!.transport?.keep_alive?.max_idle_conns_per_host).toBeUndefined()
  expect(proxyHandlers[0]!.transport?.keep_alive?.enabled).toBe(false)
  expect(proxyHandlers[0]!.transport?.versions ?? []).not.toContain('h2c')
  signal.throwIfAborted()
  const child = spawn(executable, ['run', '--config', testConfig, '--adapter', 'caddyfile'], { env: environment, shell: false, windowsHide: true, stdio: 'pipe' })
  const stopChild = ownChild(child)
  const initialListener = captureChild('initial', child)
  await step(() => once(child, 'spawn', { signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]) }))
  if (child.pid === undefined) throw new Error('Missing child PID')
  let port = await phaseStep('initial listener', () => initialListener.wait({ signal, timeoutMs: 20_000 }))
  let ca = ''
  await step(() => vi.waitFor(async () => { ca = await step(() => readFile(join(config.dataDirectory, 'pki', 'authorities', 'local', 'root.crt'), 'utf8')) }, { timeout: 10_000 }))
  await phaseStep('initial TLS readiness', () => waitForCaddyTls({ port, ca, servername: 'phone.example.com', signal,
    timeoutMs: 20_000, intervalMs: 100, isRunning: () => child.exitCode === null && child.signalCode === null }))
  const discovery = await phaseStep('discovery', () => exchange(signal, port, ca, '/mobile-access/discovery'))
  expect(discovery.status, '[DEBUG-caddy-live] Discovery response=' + responseDiagnostic(discovery)
    + '; Caddy stderr=' + diagnostics()).toBe(200)
  expect(JSON.parse(discovery.body).instanceId).toBe(gateway.config.instanceId)
  const unauthenticated = await phaseStep('unauthenticated API', () => exchange(signal, port, ca, '/api/caddy-test-resource'))
  if (unauthenticated.status !== 401) {
    const direct = await step(() => directUnauthenticated(signal, gateway.address().port, '/api/caddy-test-resource')
      .then(responseDiagnostic, (error: unknown) => String(error).slice(0, 2048)))
    throw new Error('[DEBUG-caddy-live] Unauthenticated API expected 401; proxied=' + responseDiagnostic(unauthenticated)
      + '; direct=' + direct + '; Caddy stderr=' + diagnostics())
  }
  expect(unauthenticated.status).toBe(401)
  const pairing = await step(() => gateway.access.openPairing())
  const paired = await phaseStep('pairing POST', () => exchange(signal, port, ca, '/mobile-access/auth/pair', 'POST', { 'content-type': 'application/json' }, JSON.stringify({ token: pairing.token, label: 'Isolated Caddy test' })))
  expect(paired.status).toBe(201)
  const cookie = paired.headers['set-cookie']?.find(value => value.startsWith(SESSION_COOKIE + '='))?.split(';')[0]
  expect(cookie).toBeDefined()
  const deviceCookie = paired.headers['set-cookie']?.find(value => value.startsWith(DEVICE_COOKIE + '='))?.split(';')[0]
  const deviceToken = parseCookies(deviceCookie)?.get(DEVICE_COOKIE)
  // The cookie serializer uses a raw base64url value, not percent encoding; never log credentials.
  expect(typeof deviceToken === 'string' && deviceToken.length > 0).toBe(true)
  const resource = await phaseStep('authenticated API', () => exchange(signal, port, ca, '/api/caddy-test-resource', 'GET', { cookie: cookie! }))
  expect(resource.status).toBe(200); expect(resource.rawBody).toEqual(Buffer.from([0, 1, 2, 250]))
  const csrfCookie = paired.headers['set-cookie']?.find(value => value.startsWith(CSRF_COOKIE + '='))?.split(';')[0]
  const csrf = parseCookies(csrfCookie)?.get(CSRF_COOKIE)
  expect(csrf).toBeDefined()
  // Real request bodies cover read-idle ownership; HTTP/2 SSE also crosses the write-idle interval between chunks.
  const quietBody = '{"quietProbe":true}'
  const quietHeaders = { cookie: cookie!, [CSRF_HEADER]: csrf!, 'content-type': 'application/json' }
  await Promise.all(['h1-headers', 'h1-body', 'h2-body'].map(async protocolPhase => {
    const phase = protocolPhase.endsWith('headers') ? 'headers' : 'body'
    const id = 'quiet-' + protocolPhase
    const path = '/api/caddy-test-quiet-' + phase + '?requestId=' + id
    const result = await phaseStep('quiet ' + protocolPhase, () => protocolPhase.startsWith('h2')
      ? exchangeHttp2(signal, port, ca, path, quietHeaders, quietBody)
      : exchange(signal, port, ca, path, 'POST', quietHeaders, quietBody, 80_000))
    expect(result.status).toBe(200)
    expect(result.body).toBe(phase === 'body' ? 'data: stream-start\n\ndata: quiet-complete\n\n' : 'quiet-complete')
    if (phase === 'body') {
      expect(result.receivedAt.length).toBeGreaterThanOrEqual(2)
      expect(result.receivedAt.at(-1)! - result.receivedAt[0]!).toBeGreaterThan(60_000)
    }
    const observation = quietRequests.get(id)
    expect(observation?.completed).toBeDefined()
    expect(observation!.completed! - observation!.started).toBeGreaterThan(60_000)
    expect(gatewayRequests.get(id)).toBe(1)
    expect(upstreamRequests.get(id)).toBe(1)
    expect(consumedBodies.get(id)).toEqual(Buffer.from(quietBody))
    expect(gatewayVersions.get(id)).toBe('1.1')
  }))
  expect(quietTimers.size).toBe(0)
  // Count both hops: success must not be explained by reused sockets or hidden API replay.
  const requestIds = Array.from({ length: 12 }, (_, index) => 'single-use-' + String(index))
  const readResource = async (id: string): Promise<void> => {
    const result = await phaseStep(id, () => exchange(signal, port, ca, '/api/caddy-test-resource?requestId=' + id, 'GET', { cookie: cookie! }))
    expect(result.status).toBe(200)
    expect(result.rawBody).toEqual(Buffer.from([0, 1, 2, 250]))
  }
  for (const id of requestIds.slice(0, 4)) await readResource(id)
  await Promise.all(requestIds.slice(4).map(readResource))
  for (const id of requestIds) {
    expect(gatewayRequests.get(id)).toBe(1)
    expect(upstreamRequests.get(id)).toBe(1)
    expect(upstreamConnections.get(id)).toBe('close')
    expect(gatewayVersions.get(id)).toBe('1.1')
  }
  expect(new Set(requestIds.map(id => gatewaySockets.get(id))).size).toBe(requestIds.length)
  expect(new Set(requestIds.map(id => upstreamSockets.get(id))).size).toBe(requestIds.length)
  for (const method of ['GET', 'POST']) {
    const id = 'reset-after-consumption-' + method
    const failed = await phaseStep(id, () => exchange(signal, port, ca, '/api/caddy-test-reset?requestId=' + id, method,
      { cookie: cookie!, [CSRF_HEADER]: csrf!, 'content-type': 'application/json' }, method === 'POST' ? '{"sideEffect":true}' : ''))
    expect(failed.status).toBe(502)
    expect(JSON.parse(failed.body)).toEqual({ error: 'upstream_unavailable' })
    expect(gatewayRequests.get(id)).toBe(1)
    expect(upstreamRequests.get(id)).toBe(1)
    expect(consumedBodies.get(id)).toEqual(Buffer.from(method === 'POST' ? '{"sideEffect":true}' : ''))
  }
  for (const method of ['GET', 'POST']) {
    const id = 'gateway-reset-after-side-effect-' + method
    const failed = await phaseStep(id, () => exchange(signal, port, ca, '/api/caddy-test-gateway-reset?requestId=' + id, method,
      { cookie: cookie!, [CSRF_HEADER]: csrf!, 'content-type': 'application/json' }, method === 'POST' ? '{"sideEffect":true}' : ''))
    expect(failed.status).toBe(502)
    expect(gatewayRequests.get(id)).toBe(1)
    expect(upstreamRequests.get(id)).toBe(1)
    expect(consumedBodies.get(id)).toEqual(Buffer.from(method === 'POST' ? '{"sideEffect":true}' : ''))
    expect(gatewayVersions.get(id)).toBe('1.1')
  }
  const socketOptions: WebSocket.ClientOptions & { servername: string } = { ca, servername: 'phone.example.com',
    headers: { host: 'phone.example.com', origin: 'https://phone.example.com', cookie: cookie! },
  }
  signal.throwIfAborted()
  const socket = new WebSocket('wss://127.0.0.1:' + String(port) + '/api/events.mux', socketOptions)
  cleanups.push(async () => { if (socket.readyState !== WebSocket.CLOSED) { const closed = once(socket, 'close', { signal: AbortSignal.timeout(5_000) }); socket.terminate(); await closed } })
  await phaseStep('WSS open', () => once(socket, 'open', { signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]) }))
  signal.throwIfAborted()
  const received = once(socket, 'message', { signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]) }); socket.send('CADDY_WSS_ROUNDTRIP')
  const [echo] = await received; signal.throwIfAborted(); expect(String(echo)).toBe('CADDY_WSS_ROUNDTRIP')
  const socketClosed = once(socket, 'close', { signal: AbortSignal.any([signal, AbortSignal.timeout(5_000)]) }); socket.terminate(); await socketClosed
  signal.throwIfAborted()
  await step(() => stopChild())
  const pairedBody = JSON.parse(paired.body) as { paired: boolean; deviceId: string; deviceToken?: unknown; sessionExpiresAt: number }
  expect(pairedBody.paired).toBe(true)
  expect(pairedBody.deviceId).toMatch(/^[a-f\d]{32}$/u)
  expect(pairedBody.sessionExpiresAt).toBeGreaterThan(Date.now())
  // Browser pairing withholds the device credential from JSON; durable state stores only its digest.
  expect(pairedBody.deviceToken === undefined).toBe(true)
  signal.throwIfAborted()
  const restartedChild = spawn(executable, ['run', '--config', testConfig, '--adapter', 'caddyfile'], { env: environment, shell: false, windowsHide: true, stdio: 'pipe' })
  const stopRestartedChild = ownChild(restartedChild)
  const restartedListener = captureChild('restart', restartedChild)
  await step(() => once(restartedChild, 'spawn', { signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]) }))
  if (restartedChild.pid === undefined) throw new Error('Missing restarted child PID')
  port = await phaseStep('restart listener', () => restartedListener.wait({ signal, timeoutMs: 20_000 }))
  await phaseStep('restart TLS readiness', () => waitForCaddyTls({ port, ca, servername: 'phone.example.com', signal,
    timeoutMs: 20_000, intervalMs: 100, isRunning: () => restartedChild.exitCode === null && restartedChild.signalCode === null }))
  expect((await phaseStep('restart authenticated API', () => exchange(signal, port, ca, '/api/caddy-test-resource', 'GET', { cookie: cookie! }))).rawBody).toEqual(Buffer.from([0, 1, 2, 250]))
  await step(() => stopRestartedChild())
  await step(() => gateway.close())
  const snapshot = await step(() => store.load())
  const deviceBytes = await step(() => readFile(template.stateFile))
  expect(snapshot.devices).toHaveLength(1)
  expect(snapshot.devices[0]).toMatchObject({ id: pairedBody.deviceId, label: 'Isolated Caddy test' })
  expect(snapshot.devices[0]?.tokenDigest === createHash('sha256').update(deviceToken!, 'utf8').digest('hex')).toBe(true)
  expect(deviceBytes.toString().includes(deviceToken!)).toBe(false)
  expect(deviceBytes.toString().includes(cookie!.slice((SESSION_COOKIE + '=').length))).toBe(false)
  const restartedGateway = new MobileAccessGateway(gatewayConfig, new JsonDeviceStore(template.stateFile))
  cleanups.push(() => restartedGateway.close())
  await step(() => restartedGateway.start())
  expect(restartedGateway.access.listDevices()).toEqual([expect.objectContaining({ id: pairedBody.deviceId, label: 'Isolated Caddy test' })])
  expect(restartedGateway.access.authorizeDevice(deviceToken!).deviceId).toBe(pairedBody.deviceId)
  await step(() => restartedGateway.close())
  expect(await step(() => new JsonDeviceStore(template.stateFile).load())).toEqual(snapshot)
  if (fixture !== undefined) {
    const artifact = { ...JSON.parse(await step(() => readFile(manifestFile!, 'utf8'))) as CaddyArtifact,
      downloadUrl: 'https://fixture.invalid/pinned/caddy' }
    const component = new CaddyComponentManager({ stateDirectory: root, artifact })
    cleanups.push(() => component.close())
    await step(() => component.initialize())
    expect(component.status().installed).toBe(true)
    let controlledChild: ChildProcess | undefined
    let controlledListener: { child: ChildProcess; receipt: ReturnType<typeof observeCaddyListener> } | undefined
    let tlsReadyChild: ChildProcess | undefined
    let controlledPort = 0
    const managed = new CaddyController({ component, config, store: createVolatileRemoteControlStore(),
      instanceId: gatewayConfig.instanceId,
      createGateway: async () => {
        const controlled = new MobileAccessGateway(gatewayConfig, new JsonDeviceStore(template.stateFile))
        cleanups.push(() => controlled.close())
        await controlled.start()
        return controlled
      },
      validateConfig: async (binary, file, childEnvironment, childSignal) => {
        const generated = await readFile(file, 'utf8')
        const controlledInternal = generated.replace('{\n', '{\n\tskip_install_trust\n\tservers {\n\t\tprotocols h1\n\t}\n')
          .replace('https://phone.example.com:8443 {', 'https://phone.example.com:0 {\n\tbind 127.0.0.1')
          .replace(/\ttls \{\n\t\tdns tencentcloud \{[\s\S]*?\n\t\t\}\n\t\}/u, '\ttls internal')
          .replace('output discard', 'output stderr\n\t\tformat json')
        expect(controlledInternal).toContain('\ttls internal\n')
        expect(controlledInternal).not.toMatch(/dns|acme|tencentcloud|8443/iu)
        await writeFile(file, controlledInternal, { mode: 0o600 })
        await execFileText(binary, ['adapt', '--config', file, '--adapter', 'caddyfile'],
          { env: childEnvironment, signal: childSignal, timeout: 15_000 })
      },
      spawnProcess: (binary, args, childEnvironment) => {
        const acquired = spawn(binary, [...args], { env: childEnvironment, shell: false, windowsHide: true, stdio: 'pipe' })
        controlledChild = acquired
        controlledListener = { child: acquired, receipt: captureChild('managed', acquired) }
        ownChild(acquired)
        return acquired
      },
      probeDiscovery: async (_publicOrigin, expected, probeSignal) => {
        const activeChild = controlledChild
        if (activeChild?.pid === undefined) return false
        const listener = controlledListener
        if (listener?.child !== activeChild) throw new Error('Missing owned Caddy listener observer')
        controlledPort = await phaseStep('managed listener', () => listener.receipt.wait({ signal: probeSignal, timeoutMs: 20_000 }))
        if (tlsReadyChild !== activeChild) {
          await phaseStep('managed TLS readiness', () => waitForCaddyTls({ port: controlledPort, ca, servername: 'phone.example.com',
            signal: probeSignal, timeoutMs: 20_000, intervalMs: 100,
            isRunning: () => activeChild.exitCode === null && activeChild.signalCode === null }))
          tlsReadyChild = activeChild
        }
        const result = await phaseStep('managed discovery', () => exchange(probeSignal, controlledPort, ca, '/mobile-access/discovery'))
        if (result.status !== 200) return false
        expect(JSON.parse(result.body).instanceId).toBe(expected)
        return true
      },
    })
    cleanups.push(() => managed.close())
    await step(() => managed.initialize())
    await step(() => managed.setEnabled(true))
    expect(managed.status()).toMatchObject({ state: 'ready', origin: 'https://phone.example.com' })
    expect(managed.gateway()?.access.authorizeDevice(deviceToken!).deviceId).toBe(pairedBody.deviceId)
    expect((await phaseStep('managed unauthenticated API', () => exchange(signal, controlledPort, ca, '/api/caddy-test-resource'))).status).toBe(401)
    await step(() => managed.close())
    expect(managed.status().state).toBe('off')
    expect(ownedChildren.find(owned => owned.child === controlledChild)?.closed).toBe(true)
    await step(() => component.close())
    const privateKey = join(config.dataDirectory, 'pki', 'authorities', 'local', 'root.key')
    expect((await step(() => readFile(privateKey))).byteLength).toBeGreaterThan(0)
    const cache = join(config.configDirectory, 'owned-test-cache')
    await step(() => writeFile(cache, 'isolated-cache'))
    const providerMarker = join(root, 'components', 'neighbor-provider', 'marker')
    await step(() => mkdir(join(root, 'components', 'neighbor-provider')))
    const dataMarker = join(root, 'neighbor-data')
    await step(() => writeFile(providerMarker, 'provider-preserved'))
    await step(() => writeFile(dataMarker, 'data-preserved'))
    // All owned WSS clients, children and gateways are stopped before mutation or purge.
    expect(ownedChildren.every(owned => owned.closed)).toBe(true)
    await step(() => fixture.corruptAndPurge())
    await step(() => config.purge())
    for (const path of [config.rootDirectory, privateKey, cache]) await step(() => expect(lstat(path)).rejects.toMatchObject({ code: 'ENOENT' }))
    expect(config.status().configured).toBe(false)
    expect(await step(() => readFile(template.stateFile))).toEqual(deviceBytes)
    expect(await step(() => new JsonDeviceStore(template.stateFile).load())).toEqual(snapshot)
    expect(await step(() => readFile(providerMarker, 'utf8'))).toBe('provider-preserved')
    expect(await step(() => readFile(dataMarker, 'utf8'))).toBe('data-preserved')
  }
  }
  activeBodyTask = body()
  try { await activeBodyTask } finally { clearTimeout(deadline) }
}, 210_000)
