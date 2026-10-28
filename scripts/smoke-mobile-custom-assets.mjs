/** Exercise customization ownership and recovery on the actual installed DSH client and paired Gateway. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { chromium } from 'playwright'
import { createMobileProfile, launchDsh, removeTemporaryRoot, openPairing, pairMobilePage,
  dismissOnboarding, CLIENT_TIMEOUT_MS, sanitized } from './mobile-boot-fixture.mjs'

if (process.env.DSH_BOOT_SMOKE_BIN === undefined || process.env.DSH_BOOT_SMOKE_MOBILE_TARBALL === undefined) {
  throw new Error('Set DSH_BOOT_SMOKE_BIN and DSH_BOOT_SMOKE_MOBILE_TARBALL to the exact DSH and plugin artifacts')
}
const dshBin = resolve(process.env.DSH_BOOT_SMOKE_BIN)
const tarball = resolve(process.env.DSH_BOOT_SMOKE_MOBILE_TARBALL)
const tarballSha256 = createHash('sha256').update(await readFile(tarball)).digest('hex')
const dshVersion = JSON.parse(await readFile(join(dirname(dirname(dshBin)), 'package.json'), 'utf8')).version
const prefix = 'dsh-mobile-custom-assets-smoke-'
const root = await mkdtemp(join(tmpdir(), prefix))
const cases = []
const cleanupFailures = []
let dsh
let browser
let failure
let prompts = 0

const probeCss = revision => `[data-custom-assets-probe] { color: ${revision === 'one' ? 'rgb(13, 37, 59)' : 'rgb(41, 61, 83)'}; padding-top: 7px; }\n`
const probeScript = revision => `window.dshMobile.register(({ root, window }) => {
  window.__customAssetsMounts ??= [];
  window.__customAssetsMounts.push(${JSON.stringify(revision)});
  root.dataset.customAssetsProbe = ${JSON.stringify(revision)};
  root.textContent = 'Owned custom asset proof';
  root.style.cssText = 'position:fixed;width:1px;height:1px;left:0;bottom:0;pointer-events:none;opacity:0';
  return () => { root.replaceChildren(); };
});\n`

async function seed(home, revision) {
  await writeFile(join(home, 'mobile-access/mobile.css'), probeCss(revision))
  await writeFile(join(home, 'mobile-access/mobile.js'), probeScript(revision))
}

async function instrumentation(page) {
  const state = { requests: [], responses: [], warnings: [], recoveries: [], errors: [] }
  page.on('request', request => {
    const path = new URL(request.url()).pathname
    if (path.startsWith('/mobile-access/')) state.requests.push({ path, method: request.method() })
  })
  page.on('response', response => {
    const path = new URL(response.url()).pathname
    if (path.startsWith('/mobile-access/')) state.responses.push({ path, status: response.status() })
  })
  page.on('console', message => {
    if (!message.text().startsWith('[DSH Mobile]')) return
    if (message.type() === 'warning') state.warnings.push(message.text())
    if (message.type() === 'info') state.recoveries.push(message.text())
  })
  page.on('pageerror', error => { state.errors.push(sanitized(error.message)) })
  await page.addInitScript(() => {
    window.__customAssetsDocumentId = crypto.randomUUID()
    window.__customAssetsEventSources = []
    const OriginalEventSource = window.EventSource
    window.EventSource = class extends OriginalEventSource {
      constructor(url, options) {
        super(url, options)
        if (new URL(url, location.href).pathname === '/mobile-access/extensions/events') {
          const record = { source: this, closes: 0 }
          window.__customAssetsEventSources.push(record)
          this.__customAssetsRecord = record
        }
      }
      close() {
        if (this.__customAssetsRecord !== undefined) this.__customAssetsRecord.closes++
        super.close()
      }
    }
  })
  return state
}

async function probe(page, revision) {
  await page.waitForFunction(revision => {
    const node = document.querySelector(`[data-custom-assets-probe="${revision}"]`)
    return node !== null && window.__customAssetsMounts?.includes(revision)
      && getComputedStyle(node).color === (revision === 'one' ? 'rgb(13, 37, 59)' : 'rgb(41, 61, 83)')
      && getComputedStyle(node).paddingTop === '7px'
  }, revision, { timeout: CLIENT_TIMEOUT_MS })
}

async function streams(page) {
  return page.evaluate(() => (window.__customAssetsEventSources ?? []).map(entry => ({ closes: entry.closes, readyState: entry.source.readyState })))
}

async function waitForState(read, predicate, message) {
  const deadline = performance.now() + CLIENT_TIMEOUT_MS
  let value
  while (performance.now() < deadline) {
    value = await read()
    if (predicate(value)) return value
    await new Promise(resolveNext => setTimeout(resolveNext, 50))
  }
  throw new Error(`${message}: ${sanitized(JSON.stringify(value))}`)
}

/** Observe a negative request window, rejecting immediately when the selected traffic appears. */
async function noMatchingRequest(page, milliseconds, matches, description) {
  let timer
  let listener
  try {
    await new Promise((resolveQuiet, reject) => {
      listener = request => {
        if (matches(new URL(request.url()).pathname)) reject(new Error(description))
      }
      page.on('request', listener)
      timer = setTimeout(resolveQuiet, milliseconds)
    })
  } finally { clearTimeout(timer); if (listener !== undefined) page.off('request', listener) }
}

function assertSecurityHeaders(headers) {
  assert(headers['content-security-policy']?.includes("default-src 'self'"))
  assert(headers['content-security-policy']?.includes("object-src 'none'"))
  assert(headers['content-security-policy']?.includes("connect-src 'self'"))
  assert.equal(headers['x-content-type-options'], 'nosniff')
  assert.equal(headers['x-frame-options'], 'SAMEORIGIN')
  assert.equal(headers['referrer-policy'], 'no-referrer')
}

try {
  const workspacePath = join(root, 'owned-workspace')
  await mkdir(workspacePath)
  const home = await createMobileProfile(root, { tarball, dshBin, packageStoreDirectory: join(root, 'package-store'),
    extraPatches: [{ id: 'llm-deepseek', config: { models: [{ id: 'custom-assets-model', name: 'Owned customization model',
      contextWindow: 128000, inputModalities: ['text'] }] } }] })
  await seed(home, 'one')
  dsh = launchDsh(root, home, dshBin)
  browser = await chromium.launch({ headless: true })
  const desktopContext = await browser.newContext({ locale: 'en-US' })
  const desktop = await desktopContext.newPage()
  const desktopUrl = await dsh.ready()
  await desktop.goto(desktopUrl, { waitUntil: 'domcontentloaded' })
  const createdWorkspace = await desktop.evaluate(async path => {
    const response = await fetch('/api/workspace/create', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId: 'custom-assets-workspace', method: 'workspace/create', payload: { args: { request: { path } } } }),
      signal: AbortSignal.timeout(60_000) })
    return { status: response.status, body: await response.json() }
  }, workspacePath)
  assert.equal(createdWorkspace.status, 200, 'Owned Workspace creation was rejected')
  assert.equal(createdWorkspace.body.result?.ok, true, 'Owned Workspace creation failed')
  const workspaceId = createdWorkspace.body.result.value.workspace.workspaceId
  const phoneContext = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, locale: 'en-US' })
  const phone = await phoneContext.newPage()
  const state = await instrumentation(phone)
  await phone.route('**/api/session/prompt', async route => { prompts++; await route.abort('blockedbyclient') })
  const baseline = await pairMobilePage(phone, await openPairing(desktop, undefined, dsh.logs), dsh.logs)
  assert(baseline.value.items.some(item => item.workspaceId === workspaceId), 'Workspace baseline omitted the owned Workspace')
  await dismissOnboarding(phone)
  await probe(phone, 'one')
  await waitForState(() => streams(phone), sources => sources.length === 1 && sources[0].readyState === 1, 'The authenticated event stream did not open')
  const gatewayOrigin = new URL(phone.url()).origin
  const initial = await phone.request.get(`${gatewayOrigin}/`, { headers: { accept: 'text/html' } })
  assert.equal(initial.status(), 200)
  const dedicatedHeaders = initial.headers()
  assertSecurityHeaders(dedicatedHeaders)
  assert((await initial.text()).includes('<meta name="dsh-mobile-gateway" content="authenticated">'))
  assert.equal(await phone.evaluate(() => window.__DSH_MOBILE_FRONTEND__), 'dedicated')
  assert(state.responses.some(entry => entry.path === '/mobile-access/custom.css' && entry.status === 200))
  assert(state.responses.some(entry => entry.path === '/mobile-access/custom.js' && entry.status === 200))
  cases.push('paired dedicated Gateway applied real custom CSS and JavaScript')
  console.log('Packed custom assets: paired dedicated CSS/JS and event stream passed')

  // A fresh profile can remain on Landing without a conversation editor. Open
  // an owned Session through the real Workspace action before measuring its draft.
  const drawer = phone.locator('.dshm-drawer')
  if (await drawer.getAttribute('data-open') !== 'true') await drawer.locator('button[data-dsh-mobile-toggle]').click()
  const createdSession = phone.waitForResponse(response => new URL(response.url()).pathname === '/api/session/create'
    && response.request().postDataJSON()?.payload?.args?.request?.workspaceId === workspaceId, { timeout: CLIENT_TIMEOUT_MS })
  try {
    await drawer.locator(`[role="treeitem"][data-row-key="workspace:${workspaceId}"]`).getByRole('button').last().click()
  } catch (error) { void createdSession.catch(() => {}); throw error }
  const sessionResponse = await (await createdSession).json()
  assert.equal(sessionResponse.result?.ok, true, 'Owned Session creation failed')
  const sessionId = sessionResponse.result.value.sessionId
  await phone.waitForFunction(id => document.querySelector('[data-conversation-session]')?.dataset.conversationSession === id,
    sessionId, { timeout: CLIENT_TIMEOUT_MS })
  if (await drawer.getAttribute('data-open') === 'true') await drawer.locator('button[data-dsh-mobile-toggle]').click()
  const editor = phone.locator('[data-conversation-session] [data-composer-input][contenteditable="true"]').first()
  await editor.waitFor({ state: 'visible', timeout: CLIENT_TIMEOUT_MS })
  const draft = 'Retained customization smoke draft; do not submit'
  await editor.fill(draft)
  await editor.evaluate(node => { window.__customAssetsOriginalEditor = node })
  const documentId = await phone.evaluate(() => window.__customAssetsDocumentId)
  const manifestPath = '**/mobile-access/extensions/manifest'
  let denied = 0
  await phone.route(manifestPath, async route => {
    denied++
    await route.fulfill({ status: 401, contentType: 'application/json', body: '{"error":"authentication_failed"}' })
  })
  const warningsBefore = state.warnings.length
  const resourceRequestsBefore = state.requests.filter(entry => entry.path === '/mobile-access/custom.css' || entry.path === '/mobile-access/custom.js').length
  await phone.evaluate(() => window.dispatchEvent(new Event('focus')))
  await waitForState(() => Promise.resolve(denied), count => count >= 1, 'Manifest rejection was not observed')
  await waitForState(() => Promise.resolve(state.warnings.length), count => count === warningsBefore + 1, 'Authentication warning was not emitted')
  await waitForState(() => streams(phone), sources => sources.every(source => source.readyState === 2), 'The event stream did not close after authentication failure')
  await probe(phone, 'one')
  await phone.evaluate(() => window.dispatchEvent(new Event('focus')))
  await waitForState(() => Promise.resolve(denied), count => count >= 2, 'Explicit focus did not retry the manifest')
  assert.equal(state.warnings.length, warningsBefore + 1, 'The same authentication warning was duplicated')
  assert.equal(state.requests.filter(entry => entry.path === '/mobile-access/custom.css' || entry.path === '/mobile-access/custom.js').length, resourceRequestsBefore)
  console.log('Packed custom assets: observing a 35-second unauthorized SSE retry window')
  await noMatchingRequest(phone, 35_000, path => path === '/mobile-access/extensions/events', 'An unauthorized event stream restarted')
  assert.equal(state.warnings.length, warningsBefore + 1, 'A late authentication warning was duplicated')
  assert.equal(state.requests.filter(entry => entry.path === '/mobile-access/custom.css' || entry.path === '/mobile-access/custom.js').length, resourceRequestsBefore,
    'A rejected manifest triggered late custom resource requests')
  assert.equal(await phone.evaluate(() => window.__customAssetsDocumentId), documentId)
  assert(await editor.evaluate(node => node === window.__customAssetsOriginalEditor))
  assert.equal(await editor.textContent(), draft)
  cases.push('manifest 401 retained CSS/document/editor/draft, deduplicated warnings and paused SSE retries')

  await seed(home, 'two')
  await phone.unroute(manifestPath)
  await phone.evaluate(() => window.dispatchEvent(new Event('focus')))
  await probe(phone, 'two')
  await waitForState(() => streams(phone), sources => sources.length === 2 && sources[1].readyState === 1, 'The recovered event stream did not reopen')
  await waitForState(() => Promise.resolve(state.recoveries.length), count => count === 1, 'Recovery was not reported exactly once')
  assert.equal(await phone.evaluate(() => window.__customAssetsDocumentId), documentId)
  assert(await editor.evaluate(node => node === window.__customAssetsOriginalEditor))
  assert.equal(await editor.textContent(), draft)
  cases.push('removing the injected manifest 401 and focusing restored CSS/JS and real SSE without reload')
  console.log('Packed custom assets: authenticated recovery retained the actual DSH draft and document')

  const stock = await phone.goto(`${gatewayOrigin}/?frontend=stock`, { waitUntil: 'domcontentloaded' })
  assert.equal(stock?.status(), 200)
  await probe(phone, 'two')
  assertSecurityHeaders(stock.headers())
  assert.equal(stock.headers()['content-security-policy'], dedicatedHeaders['content-security-policy'])
  const stockHtml = await stock.text()
  assert(stockHtml.includes('<meta name="dsh-mobile-gateway" content="authenticated">'))
  assert(!stockHtml.includes('__DSH_MOBILE_FRONTEND__'))
  assert(!stockHtml.includes('__DSH_TRANSPORT__'))
  assert(!stockHtml.includes('/mobile-access/mobile-layout.js'))
  assert(!stockHtml.includes('/mobile-access/compat.js'))
  assert.equal(await phone.evaluate(() => window.__DSH_MOBILE_FRONTEND__), undefined)
  const upstream = await desktop.request.get(new URL('/', desktopUrl).href, { headers: { accept: 'text/html' } })
  assert.equal(upstream.status(), 200)
  const upstreamHtml = await upstream.text()
  const scripts = html => [...html.matchAll(/<script\b[^>]*>[\s\S]*?<\/script>/giu)].map(match => match[0])
  assert(JSON.stringify(scripts(stockHtml)) === JSON.stringify(scripts(upstreamHtml)), 'Gateway stock changed upstream executable script contents or attributes')
  assert.equal([...stockHtml.matchAll(/<meta\b[^>]*http-equiv=["']Content-Security-Policy["'][^>]*>/giu)].map(match => match[0]).join('\n'),
    [...upstreamHtml.matchAll(/<meta\b[^>]*http-equiv=["']Content-Security-Policy["'][^>]*>/giu)].map(match => match[0]).join('\n'), 'Stock CSP meta changed')
  cases.push('paired loopback stock page applied CSS/JS without dedicated graph/transport/CSP changes')
  console.log('Packed custom assets: loopback stock document retained its upstream scripts and CSP')

  const raw = await desktop.context().newPage()
  const rawState = await instrumentation(raw)
  const previewUrl = new URL('/', desktopUrl)
  previewUrl.searchParams.set('dsh-mobile-preview', '1')
  await raw.goto(previewUrl.href, { waitUntil: 'domcontentloaded' })
  await raw.locator('style[data-plugin="dsh-mobile"]').waitFor({ state: 'attached', timeout: CLIENT_TIMEOUT_MS })
  await waitForState(() => Promise.resolve(rawState.warnings.length), count => count === 1, 'The unpaired raw DSH page did not report customization ownership')
  assert.equal(await raw.evaluate(() => document.querySelector('meta[name="dsh-mobile-gateway"]') !== null), false)
  assert.equal(await raw.evaluate(() => window.__DSH_MOBILE_FRONTEND__), undefined)
  assert.deepEqual(rawState.requests, [], 'Raw DSH preview requested Mobile Gateway APIs')
  assert.equal((await streams(raw)).length, 0)
  assert.equal(await raw.evaluate(() => window.__customAssetsMounts), undefined)
  const rawQuiet = noMatchingRequest(raw, 2_000, path => path.startsWith('/mobile-access/'), 'Raw DSH preview focus started Mobile Gateway APIs')
  await raw.evaluate(() => window.dispatchEvent(new Event('focus')))
  await rawQuiet
  assert.deepEqual(rawState.requests, [], 'Raw DSH preview focus started Mobile Gateway APIs')
  assert.equal((await streams(raw)).length, 0)
  assert.equal(rawState.warnings.length, 1)
  const previewBack = await raw.evaluate(() => {
    const layer = document.createElement('section')
    layer.dataset.dshMobileSurfacePlacement = 'overlay'
    layer.style.cssText = 'position:fixed;inset:10px auto auto 10px;width:40px;height:40px;pointer-events:none'
    document.body.append(layer)
    try {
      const event = new Event('dsh-mobile:native-back', { cancelable: true })
      window.dispatchEvent(event)
      return { consumed: event.defaultPrevented, hidden: layer.hidden }
    } finally { layer.remove() }
  })
  assert.deepEqual(previewBack, { consumed: true, hidden: true }, 'Raw preview lost its DOM Back enhancement when customization APIs were disabled')
  assert.deepEqual(rawState.requests, [])
  cases.push('real raw DSH preview retained DOM Back enhancement with no custom API or SSE requests')
  assert.deepEqual(state.errors, [], 'Paired customization generated unhandled page errors')
  assert.deepEqual(rawState.errors, [], 'Raw preview generated unhandled page errors')
  assert.equal(prompts, 0, 'The customization smoke attempted a model prompt')
} catch (error) {
  failure = new Error(sanitized(error instanceof Error ? error.stack ?? error.message : String(error)))
} finally {
  try { await browser?.close() } catch (error) { cleanupFailures.push(error) }
  let processExited = dsh === undefined
  try {
    const stopped = await dsh?.close()
    if (stopped !== undefined) processExited = true
    if (stopped?.forced) cleanupFailures.push(new Error('The DSH customization fixture required forced termination'))
  } catch (error) { cleanupFailures.push(error) }
  if (processExited) {
    try { await removeTemporaryRoot(root, prefix) } catch (error) { cleanupFailures.push(error) }
  } else cleanupFailures.push(new Error('DSH process exit was not confirmed; the owned private profile was retained'))
}
if (failure !== undefined || cleanupFailures.length > 0) {
  throw new AggregateError([...(failure === undefined ? [] : [failure]), ...cleanupFailures], 'Packed mobile customization smoke failed')
}
console.log(JSON.stringify({ passed: cases.length, dshVersion, tarballSha256, cases,
  evidence: 'real packed DSH profile, paired browser DOM/computed styles, actual JavaScript activation and SSE; injected manifest 401 is an owned failure control',
  scope: 'loopback/private fixture only; no public DNS, account or physical Android claim', cleanup: 'browser/process/private profile removed' }))
