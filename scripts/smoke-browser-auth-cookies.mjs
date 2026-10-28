import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { request as requestHttps } from 'node:https'
import { connect } from 'node:net'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { chromium } from 'playwright'
import selfsigned from 'selfsigned'

const mobileRoot = process.env.DSH_BOOT_SMOKE_MOBILE_ROOT === undefined
  ? fileURLToPath(new URL('..', import.meta.url)) : resolve(process.env.DSH_BOOT_SMOKE_MOBILE_ROOT)
const { MobileAccessGateway, MemoryDeviceStore, parseGatewayConfig } = await import(pathToFileURL(resolve(mobileRoot, 'lib/index.mjs')).href)
const hostname = 'dsh.cookie-collision.test'
const parentDomain = '.cookie-collision.test'
const names = {
  session: 'dsh_ma_session', device: 'dsh_ma_device', csrf: 'dsh_ma_csrf',
  hostSession: '__Host-dsh_ma_session', hostCsrf: '__Host-dsh_ma_csrf', hostDevice: '__Host-dsh_ma_device_id',
}
const renewPath = '/mobile-access/auth/renew'
const directory = await mkdtemp(resolve(tmpdir(), 'dsh-mobile-browser-cookies-'))
const graph = {
  rev: 'cookie-smoke',
  entries: [{ id: '@deepseek-ai/dsh-client-ui-layout', url: '/plugins/layout.js', rev: 'cookie-smoke', inject: ['@deepseek-ai/dsh-client-runtime', '@deepseek-ai/dsh-client-ui-theme'] }],
}
const html = `<!doctype html><html><head><script>globalThis["__DSH_BOOT__"]=${JSON.stringify(graph)};</script></head><body><main>Authenticated cookie fixture</main></body></html>`
const upstream = createServer(async (request, response) => {
  const chunks = []
  for await (const chunk of request) chunks.push(Buffer.from(chunk))
  if (request.url === '/') {
    response.writeHead(200, { 'content-type': 'text/html' })
    response.end(html)
  } else {
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ ok: true, method: request.method, body: Buffer.concat(chunks).toString('utf8') }))
  }
})
const browserProxy = createServer((_request, response) => { response.writeHead(403).end() })
const proxySockets = new Set()
let gateway
let browser
let cases = 0
try {
  await new Promise((resolveListen, reject) => {
    upstream.once('error', reject)
    upstream.listen(0, '127.0.0.1', resolveListen)
  })
  const upstreamPort = upstream.address().port
  const certificate = await selfsigned.generate([{ name: 'commonName', value: hostname }], { keyType: 'ec', algorithm: 'sha256' })
  const certFile = resolve(directory, 'certificate.pem')
  const keyFile = resolve(directory, 'key.pem')
  await writeFile(certFile, certificate.cert)
  await writeFile(keyFile, certificate.private, { mode: 0o600 })
  gateway = new MobileAccessGateway(parseGatewayConfig({
    listenHost: '127.0.0.1', listenPort: 0,
    upstreamOrigin: `http://127.0.0.1:${upstreamPort}`,
    publicAuthorities: [hostname], allowedCidrs: ['127.0.0.0/8'],
    stateFile: resolve(directory, `${randomUUID()}.json`),
    tls: { mode: 'provided', certFile, keyFile },
  }), new MemoryDeviceStore())
  await gateway.start()
  const origin = gateway.address().origin
  await new Promise((resolveHealth, reject) => {
    const outgoing = requestHttps({
      hostname: '127.0.0.1', port: gateway.address().port,
      servername: hostname, path: '/mobile-access/health',
      headers: { host: new URL(origin).host }, rejectUnauthorized: false,
    }, response => {
      response.resume()
      response.once('end', () => {
        if (response.statusCode === 200) resolveHealth()
        else reject(new Error(`HTTPS fixture health returned ${response.statusCode}`))
      })
    })
    outgoing.once('error', reject)
    outgoing.end()
  })
  // Route only this synthetic hostname to the loopback TLS fixture. The browser
  // still owns TLS and Cookie serialization; no machine DNS or proxy settings change.
  browserProxy.on('connect', (request, client, head) => {
    if (request.url !== new URL(origin).host) { client.destroy(); return }
    const remote = connect(gateway.address().port, '127.0.0.1')
    for (const socket of [client, remote]) {
      proxySockets.add(socket)
      socket.on('error', () => { client.destroy(); remote.destroy() })
      socket.once('close', () => { proxySockets.delete(socket); client.destroy(); remote.destroy() })
    }
    remote.once('connect', () => {
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n')
      if (head.length > 0) remote.write(head)
      client.pipe(remote).pipe(client)
    })
  })
  await new Promise((resolveListen, reject) => {
    browserProxy.once('error', reject)
    browserProxy.listen(0, '127.0.0.1', resolveListen)
  })
  browser = await chromium.launch({
    headless: true,
    proxy: { server: `http://127.0.0.1:${browserProxy.address().port}` },
  })
  const context = await browser.newContext({ ignoreHTTPSErrors: true })
  const page = await context.newPage()
  const browserRequest = (path, body = {}, method = 'POST') => page.evaluate(async ({ path, body, method }) => {
    const response = await fetch(path, {
      method, credentials: 'same-origin',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    })
    return { status: response.status, body: await response.json() }
  }, { path, body, method })
  const legacyWindow = await gateway.access.openPairing()
  const legacy = await gateway.access.pair('fixture', legacyWindow.token, 'Legacy browser')
  await context.addCookies([
    { name: names.session, value: legacy.sessionToken, domain: hostname, path: '/', secure: true, httpOnly: true, sameSite: 'Strict' },
    { name: names.device, value: legacy.deviceToken, domain: hostname, path: renewPath, secure: true, httpOnly: true, sameSite: 'Strict' },
    { name: names.csrf, value: legacy.csrfToken, domain: hostname, path: '/', secure: true, sameSite: 'Strict' },
    { name: names.session, value: 'stale-parent', domain: parentDomain, path: '/', secure: true, httpOnly: true, sameSite: 'Strict' },
    { name: names.device, value: 'stale-parent', domain: parentDomain, path: '/mobile-access/', secure: true, httpOnly: true, sameSite: 'Strict' },
    { name: 'analytics', value: 'old%20parent', domain: parentDomain, path: '/', secure: true },
    { name: 'analytics', value: 'current', domain: hostname, path: '/', secure: true },
  ])
  assert.equal((await page.goto(origin))?.status(), 200)
  assert.equal(await page.evaluate(() => window.__DSH_MOBILE_FRONTEND__), 'dedicated')
  cases++
  const sessionsBefore = gateway.access.metrics().sessions
  const upgraded = await browserRequest(renewPath)
  assert.equal(upgraded.status, 200)
  assert.equal(upgraded.body.deviceId, legacy.deviceId)
  assert.equal(gateway.access.metrics().sessions, sessionsBefore + 1)
  const upgradedCookies = await context.cookies(origin)
  for (const name of [names.hostSession, names.hostCsrf, names.hostDevice]) {
    const cookie = upgradedCookies.find(candidate => candidate.name === name)
    assert.ok(cookie, `Missing protected browser cookie ${name}`)
    assert.equal(cookie.domain, hostname)
    assert.equal(cookie.path, '/')
    assert.equal(cookie.secure, true)
    assert.equal(cookie.sameSite, 'Strict')
    assert.equal(cookie.httpOnly, name !== names.hostCsrf)
  }
  assert.equal(upgradedCookies.some(candidate => candidate.name === names.device && candidate.domain === hostname), false)
  const renewalCookies = await context.cookies(`${origin}${renewPath}`)
  assert.equal(renewalCookies.filter(candidate => candidate.name === names.device).length, 2)
  cases++
  await context.addCookies([
    { name: names.session, value: legacy.sessionToken, domain: parentDomain, path: '/', secure: true, httpOnly: true, sameSite: 'Strict' },
    { name: names.device, value: legacy.deviceToken, domain: parentDomain, path: '/mobile-access/', secure: true, httpOnly: true, sameSite: 'Strict' },
    { name: names.csrf, value: legacy.csrfToken, domain: parentDomain, path: '/', secure: true, sameSite: 'Strict' },
  ])
  const repairedWindow = await gateway.access.openPairing()
  await page.goto(`${origin}/mobile-access/pair`)
  const repaired = await browserRequest('/mobile-access/auth/pair', { token: repairedWindow.token, label: 'Re-paired browser' })
  assert.equal(repaired.status, 201)
  assert.notEqual(repaired.body.deviceId, legacy.deviceId)
  await page.goto(origin)
  assert.equal(await page.evaluate(() => window.__DSH_MOBILE_FRONTEND__), 'dedicated')
  assert.equal((await browserRequest('/api/echo')).status, 200)
  cases++
  for (const method of ['PUT', 'PATCH', 'DELETE']) {
    const body = { size: 'large', label: '手机设置' }
    const saved = await browserRequest('/dsh-whale/size.json', body, method)
    assert.equal(saved.status, 200)
    assert.equal(saved.body.method, method)
    assert.equal(saved.body.body, JSON.stringify(body))
    cases++
  }
  const beforeTamper = await context.cookies(origin)
  const protectedSession = beforeTamper.find(candidate => candidate.name === names.hostSession)
  const protectedCsrf = beforeTamper.find(candidate => candidate.name === names.hostCsrf)
  const protectedId = beforeTamper.find(candidate => candidate.name === names.hostDevice)
  assert.ok(protectedSession && protectedCsrf && protectedId)
  await page.evaluate(({ sessionName, csrfName, idName }) => {
    document.cookie = `${sessionName}=parent-forgery; Domain=.cookie-collision.test; Path=/; Secure`
    document.cookie = `${csrfName}=parent-forgery; Domain=.cookie-collision.test; Path=/; Secure`
    document.cookie = `${idName}=parent-forgery; Domain=.cookie-collision.test; Path=/; Secure`
  }, { sessionName: names.hostSession, csrfName: names.hostCsrf, idName: names.hostDevice })
  const afterTamper = await context.cookies(origin)
  for (const expected of [protectedSession, protectedCsrf, protectedId]) {
    assert.equal(afterTamper.find(candidate => candidate.name === expected.name)?.value, expected.value)
    assert.equal(afterTamper.filter(candidate => candidate.name === expected.name).length, 1)
  }
  assert.equal((await browserRequest('/api/echo')).status, 200)
  cases++
  gateway.access.logout(gateway.access.authorizeSession(protectedSession.value))
  const renewed = await browserRequest(renewPath)
  assert.equal(renewed.status, 200)
  assert.equal(renewed.body.deviceId, repaired.body.deviceId)
  await page.goto(origin)
  assert.equal(await page.evaluate(() => window.__DSH_MOBILE_FRONTEND__), 'dedicated')
  cases++
  await gateway.access.revokeDevice(repaired.body.deviceId)
  const rejected = await browserRequest(renewPath)
  assert.equal(rejected.status, 401)
  assert.equal((await context.cookies(`${origin}${renewPath}`)).some(candidate => candidate.name === names.device && candidate.domain === hostname), true)
  const finalWindow = await gateway.access.openPairing()
  await page.goto(`${origin}/mobile-access/pair`)
  assert.equal((await browserRequest('/mobile-access/auth/pair', { token: finalWindow.token, label: 'Recovered again' })).status, 201)
  await page.goto(origin)
  assert.equal(await page.evaluate(() => window.__DSH_MOBILE_FRONTEND__), 'dedicated')
  assert.equal((await context.cookies(origin)).filter(candidate => candidate.name === 'analytics').length, 2)
  cases++
  const nativeWindow = await gateway.access.openPairing()
  const native = await browserRequest('/mobile-access/auth/native-pair', { token: nativeWindow.token, label: 'Native App' })
  assert.equal(native.status, 201)
  assert.deepEqual(Object.keys(native.body).sort(), ['instanceId', 'deviceId', 'deviceToken', 'deviceExpiresAt', 'sessionToken', 'csrfToken', 'sessionExpiresAt'].sort())
  const browserSession = (await context.cookies(origin)).find(candidate => candidate.name === names.hostSession)
  assert.ok(browserSession)
  gateway.access.logout(gateway.access.authorizeSession(browserSession.value))
  const installNativeAliases = async session => context.addCookies([
    { name: names.session, value: session.sessionToken, domain: hostname, path: '/', secure: true, httpOnly: true, sameSite: 'Strict' },
    { name: names.csrf, value: session.csrfToken, domain: hostname, path: '/', secure: true, sameSite: 'Strict' },
    { name: names.hostSession, value: session.sessionToken, domain: hostname, path: '/', secure: true, httpOnly: true, sameSite: 'Strict' },
    { name: names.hostCsrf, value: session.csrfToken, domain: hostname, path: '/', secure: true, sameSite: 'Strict' },
  ])
  await installNativeAliases(native.body)
  assert.equal((await page.goto(origin))?.status(), 200)
  assert.equal((await browserRequest('/api/echo')).status, 200)
  const nativeRenewed = await browserRequest('/mobile-access/auth/native-renew', { deviceToken: native.body.deviceToken })
  assert.equal(nativeRenewed.status, 200)
  assert.deepEqual(Object.keys(nativeRenewed.body).sort(), ['instanceId', 'deviceId', 'sessionToken', 'csrfToken', 'sessionExpiresAt'].sort())
  await installNativeAliases(nativeRenewed.body)
  assert.equal((await page.goto(origin))?.status(), 200)
  assert.equal((await browserRequest('/api/echo')).status, 200)
  cases++
  console.log(`Browser authentication cookie smoke passed (${cases} HTTPS Chromium scenarios).`)
} finally {
  await browser?.close()
  for (const socket of proxySockets) socket.destroy()
  browserProxy.closeAllConnections()
  if (browserProxy.listening) await new Promise(resolveClose => browserProxy.close(resolveClose))
  await gateway?.close()
  upstream.closeAllConnections()
  if (upstream.listening) await new Promise(resolveClose => upstream.close(resolveClose))
  await rm(directory, { recursive: true, force: true })
}
