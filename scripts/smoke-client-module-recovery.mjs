import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { chromium } from 'playwright'
import selfsigned from 'selfsigned'

const mobileRoot = process.env.DSH_BOOT_SMOKE_MOBILE_ROOT === undefined
  ? fileURLToPath(new URL('..', import.meta.url)) : resolve(process.env.DSH_BOOT_SMOKE_MOBILE_ROOT)
const { MobileAccessGateway, MemoryDeviceStore, ClientModulePreferenceStore, parseGatewayConfig } = await import(pathToFileURL(resolve(mobileRoot, 'lib/index.mjs')).href)
const layoutId = '@deepseek-ai/dsh-client-ui-layout'
const core = ['@deepseek-ai/dsh-client-locale', ...['renderer', 'session', 'theme'].map(name => `@deepseek-ai/dsh-client-ui-${name}`)]
const modulePath = '/mobile-access/client-modules'

function manifest() {
  return { rev: 'recovery1234', entries: [
    ...core.map(id => ({ id, url: '/plugins/core.js?rev=recovery1234', rev: 'recovery1234', inject: [] })),
    { id: layoutId, url: '/plugins/layout.js?rev=recovery1234', rev: 'recovery1234', inject: [...core] },
    { id: 'feature', url: '/plugins/feature.js?rev=recovery1234', rev: 'recovery1234', inject: [] },
  ], batches: [
    { phase: 'bootstrap', url: '/plugins/bootstrap.js?rev=recovery1234', rev: 'recovery1234', entries: [...core] },
    { phase: 'application', url: '/plugins/application.js?rev=recovery1234', rev: 'recovery1234', entries: [layoutId, 'feature'] },
  ] }
}

async function runCase(browser, cookieKind) {
  const directory = await mkdtemp(resolve(tmpdir(), 'dsh-mobile-module-recovery-browser-'))
  const cleanups = [() => rm(directory, { recursive: true, force: true })]
  const errors = []
  let documents = 0
  let mutations = 0
  const graph = manifest()
  const upstream = createServer((request, response) => {
    if (request.url === '/') {
      const html = `<!doctype html><html><head><script>globalThis["__DSH_BOOT__"]=${JSON.stringify(graph)};</script></head><body>Recovered DSH fixture</body></html>`
      response.writeHead(200, { 'content-type': 'text/html' }); response.end(html)
    } else response.end('globalThis.fixtureModule = true;')
  })
  cleanups.push(async () => {
    upstream.closeAllConnections()
    if (upstream.listening) await new Promise(resolveClose => upstream.close(resolveClose))
  })
  try {
    await new Promise((resolveListen, reject) => { upstream.once('error', reject); upstream.listen(0, '127.0.0.1', resolveListen) })
    const certificate = await selfsigned.generate([{ name: 'commonName', value: '127.0.0.1' }], {
      keyType: 'ec', algorithm: 'sha256', extensions: [{ name: 'subjectAltName', altNames: [{ type: 7, ip: '127.0.0.1' }] }],
    })
    const certFile = resolve(directory, 'fixture.pem'), keyFile = resolve(directory, 'fixture.key')
    const mobileLayoutFile = resolve(directory, 'layout.js')
    await writeFile(certFile, certificate.cert, { mode: 0o600 })
    await writeFile(keyFile, certificate.private, { mode: 0o600 })
    await writeFile(mobileLayoutFile, 'globalThis.fixtureLayout = true;')
    const preferences = new ClientModulePreferenceStore(resolve(directory, 'preferences.json'), [])
    const config = parseGatewayConfig({ listenHost: '127.0.0.1', listenPort: 0,
      tls: { mode: 'provided', certFile, keyFile }, upstreamOrigin: `http://127.0.0.1:${upstream.address().port}`,
      publicAuthorities: ['127.0.0.1'], allowedCidrs: ['127.0.0.0/8'], stateFile: resolve(directory, 'devices.json'),
      mobileLayoutFile, mobileCompatibilityFile: resolve(mobileRoot, 'lib/mobile-compat.js'),
    })
    const gateway = new MobileAccessGateway(Object.freeze({ ...config, discovery: false }), new MemoryDeviceStore(), undefined, undefined, undefined, undefined, undefined, preferences)
    cleanups.push(() => gateway.close())
    await gateway.start()
    const pair = async () => { const window = await gateway.access.openPairing(); return gateway.access.pair('browser-fixture', window.token, 'Recovery fixture') }
    const first = await pair(), other = await pair()
    if (cookieKind === 'protected') await gateway.configureClientModules(['feature'], first.deviceId)
    else await gateway.configureClientModules(['feature'])
    await gateway.configureClientModules([], other.deviceId)
    const computerBefore = await preferences.read(), otherBefore = await preferences.read(other.deviceId), firstBefore = await preferences.read(first.deviceId)
    graph.entries.find(entry => entry.id === 'feature').immediately = true
    const origin = gateway.address().origin
    const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 375, height: 667 }, colorScheme: 'dark', locale: 'en-US' })
    cleanups.push(() => context.close())
    const sessionName = cookieKind === 'protected' ? '__Host-dsh_ma_session' : 'dsh_ma_session'
    const csrfName = cookieKind === 'protected' ? '__Host-dsh_ma_csrf' : 'dsh_ma_csrf'
    const setCookie = (name, value, httpOnly = false) => context.addCookies([{ name, value, url: origin, secure: true, httpOnly, sameSite: 'Strict' }])
    await setCookie(sessionName, first.sessionToken, true)
    await setCookie(csrfName, 'deliberately-invalid')
    if (cookieKind === 'protected') await setCookie('dsh_ma_csrf', first.csrfToken)
    const page = await context.newPage()
    page.on('pageerror', error => errors.push(error.message))
    page.on('framenavigated', frame => { if (frame === page.mainFrame()) documents++ })
    page.on('request', request => { if (new URL(request.url()).pathname === modulePath && request.method() === 'POST') mutations++ })
    const response = await page.goto(origin, { waitUntil: 'load' })
    assert.equal(response.status(), 200)
    assert.equal(response.headers()['cache-control'], 'no-store')
    assert.equal(response.headers()['x-frame-options'], 'DENY')
    assert.ok(response.headers()['content-security-policy'].includes("frame-ancestors 'none'"))
    const button = page.locator('#load-all-modules')
    await button.waitFor({ state: 'visible' })
    const geometry = await button.boundingBox()
    assert.ok(geometry.height >= 48 && geometry.x >= 0 && geometry.x + geometry.width <= 375)
    assert.equal(mutations, 0)
    assert.equal(documents, 1)
    assert.deepEqual(await preferences.read(first.deviceId), firstBefore)
    await button.click()
    await page.locator('#recovery-status').filter({ hasText: 'Could not restore the page' }).waitFor({ state: 'visible' })
    assert.equal(await button.isEnabled(), true)
    assert.equal(mutations, 1)
    assert.equal(documents, 1)
    assert.deepEqual(await preferences.read(first.deviceId), firstBefore)
    await setCookie(csrfName, first.csrfToken)
    await Promise.all([page.waitForEvent('framenavigated', { predicate: frame => frame === page.mainFrame() }), button.click()])
    await page.waitForLoadState('load')
    assert.equal(documents, 2)
    assert.equal(mutations, 2)
    assert.equal(await page.locator('#load-all-modules').count(), 0)
    assert.equal(await page.evaluate(() => globalThis.__DSH_BOOT__.entries.some(entry => entry.id === 'feature')), true)
    assert.deepEqual((await preferences.read(first.deviceId)).excludedClientModules, [])
    assert.deepEqual(await preferences.read(), computerBefore)
    assert.deepEqual(await preferences.read(other.deviceId), otherBefore)
    assert.deepEqual(errors, [])
  } finally {
    const results = await Promise.allSettled(cleanups.slice(2).reverse().map(cleanup => cleanup()))
    await cleanups[1]()
    await cleanups[0]()
    const failure = results.find(result => result.status === 'rejected')
    if (failure) throw failure.reason
  }
}

const browser = await chromium.launch({ headless: true })
try {
  for (const kind of ['protected', 'legacy']) await runCase(browser, kind)
  console.log('Client module recovery browser smoke passed: protected and legacy cookies, CSP, explicit action, failed-save retry, no automatic reload, and device-only persistence.')
} finally { await browser.close() }
