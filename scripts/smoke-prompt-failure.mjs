/** Exercise the real packed composer with rejected prompts and an independently verified Host refusal guard. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { installPackedBundle, packBundle, packedManifest } from './packed-profile.mjs'
import { CLIENT_TIMEOUT_MS, createMobileProfile, dismissOnboarding, launchDsh,
  mobileProfilePnpmConfiguration, openPairing, pairMobilePage, removeTemporaryRoot, sanitized, within } from './mobile-boot-fixture.mjs'

const repository = fileURLToPath(new URL('..', import.meta.url))
const usage = `Usage: node scripts/smoke-prompt-failure.mjs [--check-navigation] [--stock] [--help]

Default: reject one text and one image prompt with HTTP 400, require recovered
drafts/images and a visible real DSH error alert. UI prompts never reach the
Host; one deliberate non-model HTTP probe verifies its independent refusal guard.

--check-navigation  Also hold requests across Session switches, return through
                    the real UI and require recovered drafts/images. A known
                    upstream lifecycle failure exits 1 after owned cleanup;
                    observing the failure is not a passing regression check.
--stock             Use an isolated stock DSH profile without Mobile installed.
--help              Print this help without creating a profile.

Environment:
DSH_BOOT_SMOKE_BIN              Exact installed DSH CLI lib/bin.js.
DSH_BOOT_SMOKE_MOBILE_TARBALL   Existing Mobile npm artifact; otherwise pack
                               built checkout files (not used by --stock).
DSH_PROMPT_FAILURE_SURFACE     mobile (default) or stock; --stock takes precedence.
DSH_PROMPT_FAILURE_VIEWPORT    WIDTHxHEIGHT, default 390x844; width 240..3840,
                               height 240..2160. Wide stock is not phone acceptance.
DSH_PROMPT_FAILURE_EVIDENCE    Optional JSON evidence output file.
`
const args = process.argv.slice(2)
const allowedArguments = new Set(['--check-navigation', '--stock', '--help'])
for (const argument of args) {
  if (!allowedArguments.has(argument)) throw new Error(`Unknown argument: ${argument}\n${usage}`)
}
assert.equal(new Set(args).size, args.length, `Duplicate arguments are not supported.\n${usage}`)
if (args.includes('--help')) { console.log(usage); process.exit(0) }
const configuredSurface = process.env.DSH_PROMPT_FAILURE_SURFACE ?? 'mobile'
assert(['mobile', 'stock'].includes(configuredSurface), `DSH_PROMPT_FAILURE_SURFACE must be mobile or stock.\n${usage}`)
const viewportText = process.env.DSH_PROMPT_FAILURE_VIEWPORT ?? '390x844'
const viewportMatch = /^([1-9]\d{2,3})x([1-9]\d{2,3})$/u.exec(viewportText)
assert(viewportMatch !== null, `DSH_PROMPT_FAILURE_VIEWPORT must use WIDTHxHEIGHT.\n${usage}`)
const viewport = { width: Number(viewportMatch[1]), height: Number(viewportMatch[2]) }
assert(viewport.width >= 240 && viewport.width <= 3840 && viewport.height >= 240 && viewport.height <= 2160,
  `DSH_PROMPT_FAILURE_VIEWPORT is outside the supported fixture bounds.\n${usage}`)
const checkNavigation = args.includes('--check-navigation')
const dshBin = process.env.DSH_BOOT_SMOKE_BIN ?? join(repository, 'node_modules/@deepseek-ai/dsh/lib/bin.js')
const tarballInput = process.env.DSH_BOOT_SMOKE_MOBILE_TARBALL
const stockSurface = args.includes('--stock') || configuredSurface === 'stock'
const prefix = 'dsh-mobile-prompt-failure-'
const root = await mkdtemp(join(tmpdir(), prefix))
const name = 'dsh-mobile-prompt-failure-fixture'
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC', 'base64')
const rejection = '{"error":"bad_request"}\n'
assert.equal(Buffer.byteLength(rejection), 24)
let dsh, browser, page, failure, stage = 'setup', sequence = 0, released, desktop, baseUrl
let promptAttempts = 0
let forwardedPrompts, hostGuardBeforeUi
const evidence = { surface: stockSurface ? 'stock DSH without Mobile installed' : 'paired Mobile Gateway', viewport, checkNavigation,
  cases: [], pageErrors: [] }

async function createStockProfile() {
  const home = join(root, 'home'), profile = join(home, 'profiles/web')
  await mkdir(join(profile, 'node_modules'), { recursive: true })
  await writeFile(join(profile, 'package.json'), JSON.stringify({ name: 'dsh-profile-web', private: true, dependencies: {},
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'] } } }) + '\n')
  await writeFile(join(profile, 'pnpm-workspace.yaml'), mobileProfilePnpmConfiguration({ packageStoreDirectory: join(root, 'pnpm-store') }))
  await writeFile(join(profile, 'cordis.patch.yml'), JSON.stringify([{ id: 'llm-deepseek', config: { models: [{
    id: 'prompt-failure-fixture-model', name: 'Prompt failure fixture', contextWindow: 128000, inputModalities: ['text', 'image'],
  }] } }]) + '\n')
  return home
}

/** Install an isolated HTTP refusal guard plus client observations and public navigation actions. */
async function addFixture(home) {
  const directory = join(root, name)
  await mkdir(join(directory, 'lib'), { recursive: true })
  await writeFile(join(directory, 'package.json'), JSON.stringify({ name, version: '1.0.0', type: 'module',
    main: './lib/index.mjs', exports: { '.': './lib/index.mjs', './package.json': './package.json', './client': './lib/client.js' },
    ...(checkNavigation ? { peerDependencies: { '@deepseek-ai/dsh-llm': '*' } } : {}),
    dsh: { bundle: { patch: './cordis.patch.yml' }, client: { platform: 'web', immediately: true,
      inject: ['@deepseek-ai/dsh-client-ui-conversation', '@deepseek-ai/dsh-client-ui-workspace', '@deepseek-ai/dsh-api-session-controller'] } } }) + '\n')
  await writeFile(join(directory, 'cordis.patch.yml'), JSON.stringify([{ insert: [{ id: 'prompt-failure-fixture', name }] }]) + '\n')
  await writeFile(join(directory, 'lib/index.mjs'), `${checkNavigation ? "import {createUserMessage} from '@deepseek-ai/dsh-llm';\n" : ''}
export const inject=${JSON.stringify(checkNavigation ? ['webServer', 'sessionController', 'sessions'] : ['webServer'])};
export function apply(ctx){
 let promptRequests=0;
 ctx.effect(()=>ctx.webServer.register({kind:'exact',path:'/api/session/prompt',handler:(request,response)=>{
  request.resume();
  if(request.method!=='POST'){response.writeHead(405);response.end();return}
  promptRequests++;
  response.writeHead(503,{'Content-Type':'application/json','Cache-Control':'no-store','X-Owned-Prompt-Guard':'active'});
  response.end(JSON.stringify({error:'owned_prompt_guard'}));
 }}));
 ctx.effect(()=>ctx.webServer.register({kind:'exact',path:'/api/mobile-prompt-failure-guard',handler:(request,response)=>{
  if(request.method!=='GET'){request.resume();response.writeHead(405);response.end();return}
  response.writeHead(200,{'Content-Type':'application/json','Cache-Control':'no-store'});response.end(JSON.stringify({promptRequests}));
 }}));
 ${checkNavigation ? `ctx.effect(()=>ctx.webServer.register({kind:'exact',path:'/api/mobile-prompt-failure-fixture',handler:async(request,response)=>{
 if(request.method!=='POST'){response.writeHead(405);response.end();return}
 const id=new URL(request.url,'http://fixture.invalid').searchParams.get('id');
 const resolved=await ctx.sessionController.resolveAgent(id);
 if(resolved.agent===undefined){response.writeHead(409);response.end();return}
 const session=resolved.agent.session;
 session.append('turn/start',{turn:1});
 session.append('user/message',createUserMessage({content:[{type:'text',text:'Owned existing Session history fixture'}],source:{kind:'user'}}),{surfaceOp:'append'});
 session.append('turn/end',{turn:1,reason:{kind:'completed'}});
 await ctx.sessions.flush(session);response.writeHead(200,{'Content-Type':'application/json'});response.end(JSON.stringify({ok:true}));
}}));` : ''}
}\n`)
  await writeFile(join(directory, 'lib/client.js'), `window.__ModuleLoader__.load({id:${JSON.stringify(name)},factory:()=>({
    inject:['conversation','sessions','uiWorkspace'],apply(ctx){ctx.effect(()=>{
      const ids=new WeakMap();let sequence=0;const identity=value=>{if(value==null)return null;let id=ids.get(value);if(id===undefined){id=++sequence;ids.set(value,id)}return id};
      window.__promptFailureFixture={open:id=>ctx.uiWorkspace.openSession(id),read:id=>{
        const scope=ctx.sessions.scope(id);if(scope===undefined)return null;
        const shell=ctx.conversation.input.for(scope),state=shell.state.getSnapshot();
        const failure=ctx.sessions.binding(id)?.session.getSnapshot().promptError;
        return {scopeIdentity:identity(scope),shellIdentity:identity(shell),sessionIdentity:identity(ctx.sessions.binding(id)?.session),retainInfo:ctx.sessions.retainInfo(id).getSnapshot(),
          draft:state.draft,phase:state.phase,attachmentIds:[...state.attachmentIds],notice:shell.notices.getSnapshot(),
          promptError:failure==null?failure:{op:failure.op,error:{name:failure.error.name,message:failure.error.message,code:failure.error.code}}};
      }};return()=>{delete window.__promptFailureFixture};
    })}})});\n`)
  await installPackedBundle(await packBundle(directory, root), join(home, 'profiles/web'), { dshBin })
}

async function rpc(target, method, request) {
  const response = await target.evaluate(async ({ method, request, rpcId }) => {
    const result = await fetch(`/api/${method}`, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId, method, payload: { args: { request } } }), signal: AbortSignal.timeout(60_000) })
    return { status: result.status, body: await result.json() }
  }, { method, request, rpcId: `prompt-failure-${++sequence}` })
  assert.equal(response.status, 200, sanitized(JSON.stringify(response)))
  assert.equal(response.body.result?.ok, true, sanitized(JSON.stringify(response)))
  return response.body.result.value
}

/** Measure the independent Host guard through actual loopback HTTP, outside page route interception. */
async function readHostGuard(target, baseUrl, timeout = CLIENT_TIMEOUT_MS) {
  const response = await target.request.get(new URL('/api/mobile-prompt-failure-guard', baseUrl).href,
    { timeout, headers: { 'cache-control': 'no-store' } })
  try {
    assert.equal(response.status(), 200, 'The independent Host prompt guard counter was unavailable')
    const count = (await response.json()).promptRequests
    assert(Number.isSafeInteger(count) && count >= 0, 'Host prompt guard returned an invalid counter')
    return count
  } finally { await response.dispose() }
}

/** Prove exact-route priority before any UI submission, while the UI's default deny stays installed. */
async function verifyHostGuard(target, baseUrl) {
  const before = await readHostGuard(target, baseUrl)
  assert.equal(before, 0, 'An unexpected prompt reached the Host before guard verification')
  const response = await target.request.post(new URL('/api/session/prompt', baseUrl).href,
    { timeout: CLIENT_TIMEOUT_MS, data: { type: 'owned-fixture-guard-probe' } })
  try {
    assert.equal(response.status(), 503, 'The deliberate safety probe did not reach the Host refusal handler')
    assert.equal(response.headers()['x-owned-prompt-guard'], 'active', 'The Host guard did not own the safety response')
    assert.deepEqual(await response.json(), { error: 'owned_prompt_guard' })
  } finally { await response.dispose() }
  const after = await readHostGuard(target, baseUrl)
  assert.equal(after, before + 1, 'The Host did not count the deliberate refusal probe')
  evidence.hostGuard = { deliberateProbeBefore: before, deliberateProbeAfter: after }
  return after
}

async function openSession(id) {
  await page.waitForFunction(() => typeof window.__promptFailureFixture?.open === 'function', undefined, { timeout: CLIENT_TIMEOUT_MS })
  await page.evaluate(id => window.__promptFailureFixture.open(id), id)
  await page.waitForFunction(id => document.querySelector('[data-conversation-session]')?.getAttribute('data-conversation-session') === id, id)
  await page.locator('[data-composer-input][contenteditable="true"]').first().waitFor({ state: 'visible', timeout: CLIENT_TIMEOUT_MS })
  const drawer = page.locator('.dshm-drawer')
  if (await drawer.count() > 0 && await drawer.getAttribute('data-open') === 'true') await drawer.locator('button[data-dsh-mobile-toggle]').click()
}

async function snapshot(id, text) {
  return page.evaluate(({ id, text }) => {
    const visible = node => { const r = node.getBoundingClientRect(); const s = getComputedStyle(node); return r.width > 0 && r.height > 0 && s.display !== 'none' && s.visibility !== 'hidden' }
    const notices = [...document.querySelectorAll('[role="alert"], [role="status"], [data-composer-card]')]
      .filter(visible).map(node => ({ text: node.textContent?.trim(), role: node.getAttribute('role'),
        box: { top: node.getBoundingClientRect().top, bottom: node.getBoundingClientRect().bottom,
          left: node.getBoundingClientRect().left, right: node.getBoundingClientRect().right,
          width: node.getBoundingClientRect().width, height: node.getBoundingClientRect().height },
        viewport: { width: innerWidth, height: innerHeight, visualWidth: visualViewport?.width, visualHeight: visualViewport?.height },
        opacity: getComputedStyle(node).opacity, hit: (()=>{const r=node.getBoundingClientRect(),target=document.elementFromPoint(r.left+r.width/2,r.top+r.height/2);return target!==null&&(target===node||node.contains(target))})() })).filter(value => value.text)
    const content=document.querySelector('[data-conversation-session]')?.cloneNode(true)
    for(const node of content?.querySelectorAll('[data-composer-card]')??[])node.remove()
    return { input: window.__promptFailureFixture.read(id), visibleNotices: notices,
      optimisticTextPresent: content?.textContent.includes(text)??false,
      bodyText: document.body.innerText.slice(-4000),
      previews: [...document.querySelectorAll('[data-composer-card] [data-slot="conversation.input.attachments"] img')]
        .map(image => ({ name: image.alt, ready: image.complete && image.naturalWidth > 0 })) }
  }, { id, text })
}

async function runCase(id, other, label, withImage, navigate) {
  stage = `case:${label}`
  console.log(`Prompt rejection case ${label}`)
  await openSession(id)
  const editor = page.locator('[data-composer-input][contenteditable="true"]').first()
  const text = `Owned rejected prompt ${label}; never reach Host`
  await editor.fill(text)
  if (withImage) await page.locator('[data-composer-card] input[type="file"][multiple]').first()
    .setInputFiles({ name: `${label}.png`, mimeType: 'image/png', buffer: png })
  await page.waitForFunction(({ id, text, count }) => {
    const state = window.__promptFailureFixture.read(id)
    return state?.draft === text && state.attachmentIds.length === count && state.phase === 'plain'
  }, { id, text, count: withImage ? 1 : 0 }, { timeout: CLIENT_TIMEOUT_MS })
  const before = await snapshot(id, text)
  let reached
  const requestReached = new Promise(resolveReached => { reached = resolveReached })
  let release
  const responseRelease = new Promise(resolveRelease => { release = resolveRelease })
  released = release
  let completed, rejectCompleted
  const responseCompleted = new Promise((resolveCompleted, rejectResponse) => { completed = resolveCompleted; rejectCompleted = rejectResponse })
  // Keep a setup failure from producing a separate unhandled rejection before the awaited response stage.
  void responseCompleted.catch(() => {})
  await page.route('**/api/session/prompt', async route => {
    try {
      promptAttempts++
      const body = route.request().postDataJSON()
      reached({ method: route.request().method(), payloadBytes: Buffer.byteLength(route.request().postData() ?? ''), bodyType: body.type })
      await responseRelease
      await route.fulfill({ status: 400, contentType: 'application/json', body: rejection })
      completed()
    } catch (error) { rejectCompleted(error) }
  })
  await page.getByRole('button', { name: 'Send message', exact: true }).click()
  let requestTimer
  const request = await Promise.race([requestReached, new Promise((_resolve, reject) => { requestTimer = setTimeout(() => reject(new Error('Real prompt was not attempted')), CLIENT_TIMEOUT_MS) })])
    .finally(() => clearTimeout(requestTimer))
  const pending = await snapshot(id, text)
  if (navigate) await openSession(other)
  release()
  await within(responseCompleted, CLIENT_TIMEOUT_MS, () => 'The controlled prompt rejection did not settle')
  if (!navigate) await page.waitForFunction(({ id, text, count }) => {
    const state = window.__promptFailureFixture.read(id)
    return state?.draft === text && state.attachmentIds.length === count && state.promptError?.op === 'send'
  }, { id, text, count: withImage ? 1 : 0 }, { timeout: CLIENT_TIMEOUT_MS })
  await page.evaluate(() => new Promise(resolveFrames => requestAnimationFrame(() => requestAnimationFrame(resolveFrames))))
  const offscreen = await snapshot(id, text)
  if (navigate) await openSession(id)
  await page.evaluate(() => new Promise(resolveFrames => requestAnimationFrame(() => requestAnimationFrame(resolveFrames))))
  const after = await snapshot(id, text)
  const noticeText = after.input?.notice?.text
  evidence.cases.push({ label, request, before, pending, offscreen, after,
    shellNoticeVisibleInBody: typeof noticeText === 'string' && after.bodyText.includes(noticeText) })
  const item = evidence.cases.at(-1)
  if (!navigate) {
    const alert = page.getByRole('alert').filter({ hasText: 'HTTP 400' })
    assert(await alert.isVisible(), 'Rejected prompt did not produce the actual DSH error alert')
    item.errorAlert = await alert.evaluate(node => {
      const rect = node.getBoundingClientRect(), style = getComputedStyle(node)
      return { role: node.getAttribute('role'), text: node.textContent?.trim(),
        box: { top: rect.top, bottom: rect.bottom, left: rect.left, right: rect.right, width: rect.width, height: rect.height },
        viewport: { width: innerWidth, height: innerHeight, visualWidth: visualViewport?.width, visualHeight: visualViewport?.height },
        opacity: Number(style.opacity), visible: Number(style.opacity) > 0.01 && style.visibility === 'visible' && style.display !== 'none',
        fullyInViewport: rect.top >= 0 && rect.bottom <= innerHeight && rect.left >= 0 && rect.right <= innerWidth }
    })
    assert(item.errorAlert.visible && item.errorAlert.fullyInViewport, 'The real DSH error alert was clipped, transparent or hidden')
    item.errorAlertObserved = true
    const shown = Date.now()
    await alert.waitFor({ state: 'detached', timeout: 10_000 })
    item.alertVisibleMs = Date.now() - shown
    item.errorAlert.visibleMs = item.alertVisibleMs
    item.afterAlertDismissal = await snapshot(id, text)
    assert.equal(item.afterAlertDismissal.input?.draft, text, 'Transient error alert dismissal lost the recovered draft')
  }
  item.restored = after.input?.draft === text
    && JSON.stringify(after.input.attachmentIds) === JSON.stringify(before.input.attachmentIds)
    && after.previews.length === (withImage ? 1 : 0) && after.previews.every(image => image.ready)
  await page.unroute('**/api/session/prompt')
  // A default-deny route remains in place after this case; no prompt is ever continued.
  await page.route('**/api/session/prompt', route => { promptAttempts++; return route.abort('blockedbyclient') })
}

try {
  evidence.dshVersion = JSON.parse(await readFile(join(dirname(dshBin), '..', 'package.json'), 'utf8')).version
  const tarball = stockSurface ? undefined : tarballInput === undefined ? await packBundle(repository, root) : resolve(tarballInput)
  evidence.pluginVersion = tarball === undefined ? null : (await packedManifest(tarball)).version
  if (tarball !== undefined) evidence.artifactSha256 = createHash('sha256').update(await readFile(tarball)).digest('hex')
  stage = 'isolated packed profile installation'
  const home = stockSurface ? await createStockProfile() : await createMobileProfile(root, { tarball, dshBin, packageStoreDirectory: join(root, 'pnpm-store'), extraPatches: [
    { id: 'llm-deepseek', config: { models: [{ id: 'prompt-failure-fixture-model', name: 'Prompt failure fixture', contextWindow: 128000, inputModalities: ['text', 'image'] }] } },
  ] })
  await addFixture(home)
  const workspacePath = join(root, 'workspace')
  await mkdir(workspacePath)
  stage = 'isolated DSH startup'
  dsh = launchDsh(root, home, dshBin)
  browser = await chromium.launch({ headless: true })
  const context = await browser.newContext({ locale: 'en-US', viewport, isMobile: true, hasTouch: true, reducedMotion: 'reduce' })
  // This context-wide default deny is installed before any page exists.
  await context.route('**/api/session/prompt', route => { promptAttempts++; return route.abort('blockedbyclient') })
  desktop = await browser.newPage({ locale: 'en-US' })
  await desktop.route('**/api/session/prompt', route => { promptAttempts++; return route.abort('blockedbyclient') })
  baseUrl = await dsh.ready()
  let pairUrl
  if (stockSurface) await desktop.goto(baseUrl, { waitUntil: 'domcontentloaded' })
  else pairUrl = await openPairing(desktop, baseUrl, dsh.logs)
  stage = 'independent Host prompt guard verification'
  hostGuardBeforeUi = await verifyHostGuard(desktop, baseUrl)
  stage = 'owned Workspace and Session creation'
  const workspace = await rpc(desktop, 'workspace/create', { path: workspacePath })
  const sessions = []
  for (let i = 0; i < (checkNavigation ? 5 : 2); i++) sessions.push((await rpc(desktop, 'session/create', { workspaceId: workspace.workspace.workspaceId })).sessionId)
  if (checkNavigation) {
    const seeded = await desktop.evaluate(async id => {
      const response = await fetch(`/api/mobile-prompt-failure-fixture?id=${encodeURIComponent(id)}`, { method: 'POST', signal: AbortSignal.timeout(60_000) })
      return { status: response.status, body: await response.json() }
    }, sessions[4])
    assert.deepEqual(seeded, { status: 200, body: { ok: true } }, 'Existing Session history fixture did not commit')
  }
  page = await context.newPage()
  page.on('pageerror', error => evidence.pageErrors.push(sanitized(error.message)))
  evidence.promptRequests = []
  page.on('requestfailed', request => {
    if (new URL(request.url()).pathname === '/api/session/prompt') evidence.promptRequests.push({ kind: 'failed', error: request.failure()?.errorText })
  })
  page.on('response', response => {
    if (new URL(response.url()).pathname === '/api/session/prompt') evidence.promptRequests.push({ kind: 'response', status: response.status() })
  })
  stage = stockSurface ? 'direct DSH frontend boot' : 'paired mounted mobile boot'
  if (stockSurface) await page.goto(baseUrl, { waitUntil: 'domcontentloaded' })
  else await pairMobilePage(page, pairUrl, dsh.logs)
  await dismissOnboarding(page)
  await runCase(sessions[0], sessions[3], 'plain', false, false)
  await runCase(sessions[1], sessions[3], 'image', true, false)
  if (checkNavigation) {
    await runCase(sessions[2], sessions[3], 'image-switched', true, true)
    await runCase(sessions[4], sessions[3], 'existing-image-switched', true, true)
  }
  assert.equal(promptAttempts, checkNavigation ? 4 : 2, 'Unexpected prompt retry')
  const hostGuardAfterUi = await readHostGuard(desktop, baseUrl)
  forwardedPrompts = hostGuardAfterUi - hostGuardBeforeUi
  Object.assign(evidence.hostGuard, { beforeUi: hostGuardBeforeUi, afterUi: hostGuardAfterUi, uiDelta: forwardedPrompts })
  assert.equal(forwardedPrompts, 0, 'A prompt reached the Host')
  assert.deepEqual(evidence.promptRequests.slice(0, 2), [{ kind: 'response', status: 400 }, { kind: 'response', status: 400 }],
    'The regular rejection cases did not receive exactly the controlled HTTP 400 responses')
  assert.deepEqual(evidence.pageErrors, [], 'The real DSH page raised an execution error')
  evidence.promptAttempts = promptAttempts
  evidence.forwardedPrompts = forwardedPrompts
  const lost = evidence.cases.filter(item => !item.restored).map(item => item.label)
  if (lost.length > 0) throw new Error(`DSH navigation lifecycle lost the rejected prompt draft/images after returning to: ${lost.join(', ')}. This check failed; the observed upstream failure is not a passing plugin regression.`)
} catch (error) {
  failure = new Error(`${stage}: ${sanitized(error instanceof Error ? error.stack ?? error.message : String(error))}\n${dsh?.logs() ?? ''}`)
} finally {
  released?.()
  const failures = failure === undefined ? [] : [failure]
  const cleanup = { browserClosed: browser === undefined, dshExit: null, temporaryRootRemoved: false }
  if (hostGuardBeforeUi !== undefined && baseUrl !== undefined && desktop !== undefined && !desktop.isClosed()) {
    try {
      const hostGuardAfterUi = await readHostGuard(desktop, baseUrl, 5000)
      forwardedPrompts = hostGuardAfterUi - hostGuardBeforeUi
      Object.assign(evidence.hostGuard, { beforeUi: hostGuardBeforeUi, afterUi: hostGuardAfterUi, uiDelta: forwardedPrompts })
      assert.equal(forwardedPrompts, 0, 'A browser prompt unexpectedly reached the independent Host guard')
    } catch (error) { failures.push(error) }
  }
  if (failure !== undefined && page !== undefined && !page.isClosed()) {
    evidence.failurePage = await page.locator('body').innerText().catch(() => 'unavailable')
    evidence.failureState = await page.evaluate(() => {
      const id = document.querySelector('[data-conversation-session]')?.getAttribute('data-conversation-session')
      return id === null || id === undefined ? null : window.__promptFailureFixture?.read(id)
    }).catch(error => ({ unavailable: sanitized(String(error)) }))
  }
  if (browser !== undefined) await browser.close().then(() => { cleanup.browserClosed = true }, error => failures.push(error))
  if (dsh !== undefined) {
    try {
      cleanup.dshExit = await dsh.close()
      assert(!cleanup.dshExit.forced && (cleanup.dshExit.code === 0 || cleanup.dshExit.signal === 'SIGTERM'), `Unclean owned DSH exit ${JSON.stringify(cleanup.dshExit)}`)
    }
    catch (error) { failures.push(error) }
  }
  await removeTemporaryRoot(root, prefix).then(() => { cleanup.temporaryRootRemoved = true }, error => failures.push(error))
  const destination = process.env.DSH_PROMPT_FAILURE_EVIDENCE
  if (destination !== undefined) {
    try { await writeFile(resolve(destination), JSON.stringify({ ...evidence, stage, promptAttempts, forwardedPrompts, cleanup }, null, 2) + '\n') }
    catch (error) { failures.push(error) }
  }
  console.log(JSON.stringify({ dshVersion: evidence.dshVersion, pluginVersion: evidence.pluginVersion, surface: evidence.surface, viewport,
    checkNavigation, result: failures.length === 0 ? 'passed' : 'failed', stage, promptAttempts, forwardedPrompts,
    hostGuard: evidence.hostGuard, cleanup, cases: evidence.cases.map(item => ({ label: item.label,
    shellNotice: item.after?.input?.notice ?? null, shellNoticeVisibleInBody: item.shellNoticeVisibleInBody,
    errorAlertObserved: item.errorAlertObserved ?? false, alertVisibleMs: item.alertVisibleMs,
    restoredImages: item.after?.previews?.length ?? null, restored: item.restored })) }))
  if (failures.length === 1) throw failures[0]
  if (failures.length > 1) throw new AggregateError(failures, 'Prompt failure smoke and cleanup failed')
}
