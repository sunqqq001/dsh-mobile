/** Exercise the real DSH history pager in a packed Mobile profile without submitting a prompt. */
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { installPackedBundle, packBundle } from './packed-profile.mjs'
import { completeSmoke, recordSmokeFailure } from './negative-control.mjs'
import {
  createMobileProfile, launchDsh, removeTemporaryRoot, openPairing,
  pairMobilePage, dismissOnboarding, CLIENT_TIMEOUT_MS, sanitized,
} from './mobile-boot-fixture.mjs'

const repository = fileURLToPath(new URL('..', import.meta.url))
const mobileRoot = process.env.DSH_BOOT_SMOKE_MOBILE_ROOT === undefined ? repository : resolve(process.env.DSH_BOOT_SMOKE_MOBILE_ROOT)
const dshBin = process.env.DSH_BOOT_SMOKE_BIN ?? fileURLToPath(new URL('../node_modules/@deepseek-ai/dsh/lib/bin.js', import.meta.url))
const prefix = 'dsh-mobile-history-smoke-'
const root = await mkdtemp(join(tmpdir(), prefix))
const fixtureName = 'dsh-mobile-history-fixture'
const seededTurns = 175
let dsh
let browser
let failure
let releaseFirstPage

// This Host-only fixture follows the existing sidebar smoke's public Session
// service path. It commits completed Turns; it never invokes an Agent or model.
async function installHistoryFixture(home) {
  const directory = join(root, fixtureName)
  await mkdir(join(directory, 'lib'), { recursive: true })
  await writeFile(join(directory, 'package.json'), JSON.stringify({
    name: fixtureName, version: '1.0.0', type: 'module', main: './lib/index.mjs',
    exports: { '.': './lib/index.mjs', './package.json': './package.json' },
    peerDependencies: { '@deepseek-ai/dsh-llm': '*' },
    dsh: { bundle: { patch: './cordis.patch.yml' } },
  }) + '\n')
  await writeFile(join(directory, 'lib/index.mjs'), `import {createUserMessage} from '@deepseek-ai/dsh-llm';
export const inject=['webServer','sessionController','sessions'];
export function apply(ctx){ctx.effect(()=>ctx.webServer.register({kind:'exact',path:'/api/mobile-history-fixture',handler:async(request,response)=>{
 if(request.method!=='POST'){response.writeHead(405);response.end();return}
 const id=new URL(request.url,'http://fixture.invalid').searchParams.get('id');
 const resolved=await ctx.sessionController.resolveAgent(id);
 if(resolved.agent===undefined){response.writeHead(409,{'Content-Type':'application/json'});response.end(JSON.stringify({error:resolved.error}));return}
 const session=resolved.agent.session;
 for(let turn=1;turn<=${seededTurns};turn++){
  session.append('turn/start',{turn});
  session.append('user/message',createUserMessage({content:[{type:'text',text:'History fixture turn '+String(turn).padStart(3,'0')}],source:{kind:'user'}}),{surfaceOp:'append'});
  session.append('turn/end',{turn,reason:{kind:'completed'}});
 }
 await ctx.sessions.flush(session);
 response.writeHead(200,{'Content-Type':'application/json'});response.end(JSON.stringify({ok:true,turns:${seededTurns}}));
}}))}
`)
  await writeFile(join(directory, 'cordis.patch.yml'), JSON.stringify([{ insert: [{ id: 'history-fixture', name: fixtureName }] }]) + '\n')
  await installPackedBundle(await packBundle(directory, root), join(home, 'profiles', 'web'), { dshBin })
}

async function rpc(page, method, request) {
  const response = await page.evaluate(async ({ method, request }) => {
    const result = await fetch(`/api/${method}`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId: 'history-smoke', method, payload: { args: { request } } }),
      signal: AbortSignal.timeout(60000),
    })
    return { status: result.status, body: await result.json() }
  }, { method, request })
  assert.equal(response.status, 200, `${method} HTTP failure`)
  assert.equal(response.body.result?.ok, true, `${method} RPC failure`)
  return response.body.result.value
}

const settleFrames = page => page.evaluate(() => new Promise(resolveFrame => requestAnimationFrame(() => requestAnimationFrame(resolveFrame))))
const turnText = turn => `History fixture turn ${String(turn).padStart(3, '0')}`
const scrollMetrics = page => page.locator('[data-conversation-scroll]').evaluate(element => ({
  top: element.scrollTop, height: element.scrollHeight, client: element.clientHeight,
}))
const waitForQuietScroll = page => page.locator('[data-conversation-scroll]').evaluate(element => new Promise((resolveQuiet, rejectQuiet) => {
  let quietTimer
  const clear = () => { clearTimeout(quietTimer); clearTimeout(deadline); element.removeEventListener('scroll', reset) }
  const reset = () => {
    clearTimeout(quietTimer)
    quietTimer = setTimeout(() => { clear(); resolveQuiet() }, 1800)
  }
  const deadline = setTimeout(() => { clear(); rejectQuiet(new Error('history scroller did not settle for the quiet window')) }, 6000)
  element.addEventListener('scroll', reset, { passive: true })
  reset()
}))

try {
  const workspacePath = join(root, 'workspace')
  await mkdir(workspacePath)
  const tarball = process.env.DSH_BOOT_SMOKE_MOBILE_TARBALL === undefined
    ? await packBundle(mobileRoot, root) : resolve(process.env.DSH_BOOT_SMOKE_MOBILE_TARBALL)
  const home = await createMobileProfile(root, { tarball, dshBin })
  await installHistoryFixture(home)
  dsh = launchDsh(root, home, dshBin)
  browser = await chromium.launch({ headless: true })
  const desktop = await browser.newPage({ locale: 'en-US' })
  const pairUrl = await openPairing(desktop, await dsh.ready(), dsh.logs)
  const workspace = await rpc(desktop, 'workspace/create', { path: workspacePath })
  assert.equal(typeof workspace.workspace?.workspaceId, 'string')
  const ownedSession = await rpc(desktop, 'session/create', { workspaceId: workspace.workspace.workspaceId })
  assert.equal(typeof ownedSession.sessionId, 'string')
  const seeded = await desktop.evaluate(async id => {
    const response = await fetch(`/api/mobile-history-fixture?id=${encodeURIComponent(id)}`, {
      method: 'POST', signal: AbortSignal.timeout(60_000),
    })
    return { status: response.status, body: await response.json() }
  }, ownedSession.sessionId)
  assert.deepEqual(seeded, { status: 200, body: { ok: true, turns: seededTurns } }, 'Host fixture did not commit long Session history')

  const phone = await browser.newPage({ viewport: { width: 375, height: 812 }, locale: 'en-US', isMobile: true, hasTouch: true, reducedMotion: 'reduce' })
  let promptRequests = 0
  await phone.route('**/api/session/prompt', async route => { promptRequests++; await route.abort('blockedbyclient') })
  const baseline = await pairMobilePage(phone, pairUrl, dsh.logs)
  assert(baseline.value.items.some(item => item.workspaceId === workspace.workspace.workspaceId
    && item.sessionIds.includes(ownedSession.sessionId)), 'Workspace baseline omitted the seeded Session')
  await dismissOnboarding(phone)
  const drawer = phone.locator('.dshm-drawer')
  await drawer.locator('button[data-dsh-mobile-toggle]').click()
  const sessionRow = drawer.locator(`[role="treeitem"][data-row-key="session:${ownedSession.sessionId}"]`)
  await sessionRow.waitFor({ state: 'visible', timeout: CLIENT_TIMEOUT_MS })
  await sessionRow.click()
  await phone.waitForFunction(id => document.querySelector('[data-conversation-session]')?.dataset.conversationSession === id,
    ownedSession.sessionId, { timeout: CLIENT_TIMEOUT_MS })
  await phone.locator('[data-conversation-scroll]').waitFor({ state: 'visible', timeout: CLIENT_TIMEOUT_MS })
  if (await drawer.getAttribute('data-open') === 'true') await drawer.locator('button[data-dsh-mobile-toggle]').click()
  const loader = phone.locator('[data-dsh-mobile-history-loader]')
  const loaderButton = loader.getByRole('button', { name: 'Load earlier' })
  await loaderButton.waitFor({ state: 'visible', timeout: CLIENT_TIMEOUT_MS })
  assert(await loaderButton.isEnabled(), 'real hasMore loader was not enabled after Session open')
  await phone.waitForFunction(text => document.querySelector('[data-conversation-scroll]')?.textContent?.includes(text),
    turnText(seededTurns), { timeout: CLIENT_TIMEOUT_MS })
  const initial = await scrollMetrics(phone)
  assert(initial.height > initial.client + 500, `real history gave no scroll range: ${JSON.stringify(initial)}`)
  assert.equal(await phone.locator('[data-conversation-scroll]').getByText(turnText(100), { exact: true }).count(), 0,
    'opening tail unexpectedly included the first older page')

  // Hold the actual session/page HTTP response. The route never fabricates a
  // page: after the gesture and busy-state observations it forwards to DSH.
  const pageRequests = []
  const firstPageGate = new Promise(resolveGate => { releaseFirstPage = resolveGate })
  await phone.route('**/api/session/page', async route => {
    pageRequests.push({ method: route.request().method(), url: new URL(route.request().url()).pathname })
    if (pageRequests.length === 1) await firstPageGate
    await route.continue()
  })
  await settleFrames(phone)
  const setScrollTop = top => phone.locator('[data-conversation-scroll]').evaluate((element, value) => { element.scrollTop = value }, top)

  // Scripted position changes alone cannot request an older page.
  await setScrollTop(200)
  await settleFrames(phone)
  await setScrollTop(50)
  await settleFrames(phone)
  const noInputRequests = pageRequests.length
  assert.equal(noInputRequests, 0, 'programmatic scrollTop 200→50 requested an older page')

  const geometry = await phone.evaluate(() => {
    const scroller = document.querySelector('[data-conversation-scroll]')
    const rect = scroller.getBoundingClientRect()
    return { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
  })
  const session = await phone.context().newCDPSession(phone)
  await session.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 2 })
  const touchX = Math.round(geometry.x + geometry.width / 2)
  const touchY = Math.round(geometry.y + Math.min(geometry.height - 80, 160))
  const dragOlder = async (fingers, previousRequests) => {
    await setScrollTop(320)
    await settleFrames(phone)
    assert.equal(pageRequests.length, previousRequests, 'pre-drag script position requested history')
    const points = step => Array.from({ length: fingers }, (_, index) => ({
      x: touchX + (index === 0 ? -15 : 15), y: touchY + step * 30, id: index + 1,
    }))
    await session.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: points(0) })
    for (let step = 1; step <= 16 && pageRequests.length === previousRequests; step++) {
      await session.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: points(step) })
      await settleFrames(phone)
    }
    await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
    await settleFrames(phone)
    assert.equal(pageRequests.length, previousRequests + 1,
      `${fingers}-finger drag did not make exactly one real older-page request: ${JSON.stringify({ geometry, pageRequests, scroll: await scrollMetrics(phone) })}`)
  }

  const firstResponse = phone.waitForResponse(response => new URL(response.url()).pathname === '/api/session/page', { timeout: CLIENT_TIMEOUT_MS })
  void firstResponse.catch(() => {})
  await dragOlder(1, 0)
  await phone.waitForFunction(() => document.querySelector('[data-dsh-mobile-history-loader] button')?.disabled === true,
    undefined, { timeout: CLIENT_TIMEOUT_MS })
  const busyBox = await loader.evaluate(row => ({ height: row.getBoundingClientRect().height,
    text: row.querySelector('button')?.textContent?.trim() }))
  const beforeCommit = await scrollMetrics(phone)
  releaseFirstPage()
  const firstResult = await (await firstResponse).json()
  assert.equal(firstResult.result?.ok, true, `first real history page rejected: ${sanitized(JSON.stringify(firstResult))}`)
  assert.equal(firstResult.result.value?.hasMore, true, 'first older page unexpectedly exhausted history')
  await phone.waitForFunction(text => document.querySelector('[data-conversation-scroll]')?.textContent?.includes(text),
    turnText(100), { timeout: CLIENT_TIMEOUT_MS })
  await settleFrames(phone)
  const afterCommit = await scrollMetrics(phone)
  const addedHeight = afterCommit.height - beforeCommit.height
  assert(addedHeight > 100, `actual page did not enlarge history: ${JSON.stringify({ beforeCommit, afterCommit })}`)
  assert(Math.abs((afterCommit.top - beforeCommit.top) - addedHeight) <= 12,
    `real page prepend did not preserve viewport position: ${JSON.stringify({ beforeCommit, afterCommit, addedHeight })}`)
  assert(await loaderButton.isEnabled(), 'hasMore loader did not re-enable after the real page committed')
  const enabledBox = await loader.evaluate(row => ({ height: row.getBoundingClientRect().height,
    text: row.querySelector('button')?.textContent?.trim() }))
  assert(Math.abs(busyBox.height - enabledBox.height) <= 1,
    `actual loading label shifted the row: ${JSON.stringify({ busyBox, enabledBox })}`)
  // This is an explicit no-chain observation window longer than the 1600ms
  // gesture quiet interval, not a readiness sleep.
  await waitForQuietScroll(phone)
  assert.equal(pageRequests.length, 1, 'real page prepend or scroll compensation chained a second older request')

  // Chromium treats two simultaneous contacts as a pinch rather than the
  // single-finger history pull. Observe actual two-contact events and require
  // that a gesture which did not reach the top cannot request an older page.
  await phone.evaluate(() => {
    const scroller = document.querySelector('[data-conversation-scroll]')
    window.__historyTouchTrace = []
    for (const type of ['touchstart', 'touchmove', 'touchend']) {
      scroller.addEventListener(type, event => {
        window.__historyTouchTrace.push({ type, changed: Array.from(event.changedTouches, touch => touch.identifier) })
      }, { capture: true })
    }
  })
  const beforeMulti = await scrollMetrics(phone)
  assert(beforeMulti.top > 64, `two-contact test did not start away from the history zone: ${JSON.stringify(beforeMulti)}`)
  const twoTouches = step => [
    { x: touchX - 15, y: touchY + step * 20, id: 1 },
    { x: touchX + 15, y: touchY + step * 20, id: 2 },
  ]
  await session.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: twoTouches(0) })
  for (let step = 1; step <= 6; step++) {
    await session.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: twoTouches(step) })
    await settleFrames(phone)
  }
  await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
  await settleFrames(phone)
  const touchTrace = await phone.evaluate(() => window.__historyTouchTrace)
  const startedTouches = [...new Set(touchTrace.filter(event => event.type === 'touchstart').flatMap(event => event.changed))]
  assert.deepEqual(startedTouches.sort(), [1, 2],
    `browser did not deliver both contacts to the real scroller: ${JSON.stringify(touchTrace)}`)
  assert(touchTrace.some(event => event.type === 'touchmove' && event.changed.length > 0),
    `browser did not deliver a two-contact move to the real scroller: ${JSON.stringify(touchTrace)}`)
  const afterMulti = await scrollMetrics(phone)
  assert(afterMulti.top > 64, `two-contact gesture unexpectedly reached the history zone: ${JSON.stringify({ beforeMulti, afterMulti })}`)
  assert.equal(pageRequests.length, 1, 'two-contact gesture made an unintended older-page request')
  // Controlled scroll writes after the 1600ms quiet lease must not borrow an
  // old two-contact arm. This is not claimed to be a natural two-finger drag.
  await waitForQuietScroll(phone)
  await setScrollTop(200)
  await settleFrames(phone)
  await setScrollTop(50)
  await settleFrames(phone)
  assert.equal(pageRequests.length, 1, 'quiet two-contact intent survived and scripted scrolling requested history')

  // The original localized button remains visible, keyboard-reachable and
  // large enough. Busy/enabled height stays stable at each tested font size.
  const loaderBox = await phone.evaluate(() => {
    const row = document.querySelector('[data-dsh-mobile-history-loader]')
    const button = row.querySelector('button')
    const samples = []
    const originalFont = row.style.fontSize
    const originalText = button.textContent
    const measure = label => {
      const box = button.getBoundingClientRect()
      samples.push({ label, rowHeight: row.getBoundingClientRect().height, buttonHeight: box.height,
        buttonWidth: box.width, fontSize: Number.parseFloat(getComputedStyle(button).fontSize),
        visibility: getComputedStyle(button).visibility, tabIndex: button.tabIndex })
    }
    for (const font of ['', '24px']) {
      row.style.fontSize = font
      const scale = font === '' ? 'default' : font
      button.disabled = false
      measure(`enabled@${scale}`)
      button.disabled = true
      button.textContent = 'Loading...'
      measure(`disabled@${scale}`)
      button.disabled = false
      button.textContent = originalText
      measure(`re-enabled@${scale}`)
    }
    row.style.fontSize = originalFont
    button.disabled = false
    button.textContent = originalText
    return samples
  })
  for (const font of ['default', '24px']) {
    const samples = loaderBox.filter(sample => sample.label.endsWith(`@${font}`))
    const heights = samples.map(sample => sample.rowHeight)
    assert(Math.max(...heights) - Math.min(...heights) <= 1,
      `loader row shifts between enabled and busy at ${font}: ${JSON.stringify(samples)}`)
    for (const sample of samples) {
      assert(sample.rowHeight >= 48 && sample.buttonHeight >= 44 && sample.buttonWidth >= 44,
        `loader hit box is too small in ${sample.label}: ${JSON.stringify(sample)}`)
      assert(sample.visibility === 'visible' && sample.tabIndex >= 0,
        `loader button is not visibly keyboard-reachable in ${sample.label}: ${JSON.stringify(sample)}`)
    }
  }
  assert(loaderBox.filter(sample => sample.label.endsWith('@24px')).every(sample => Math.abs(sample.fontSize - 24) <= 0.5),
    `large-text test did not reach the actual button: ${JSON.stringify(loaderBox)}`)

  await loaderButton.focus()
  assert(await loaderButton.evaluate(button => document.activeElement === button), 'real loader did not take keyboard focus')
  const [, secondResponse] = await Promise.all([
    phone.keyboard.press('Enter'),
    phone.waitForResponse(response => new URL(response.url()).pathname === '/api/session/page', { timeout: CLIENT_TIMEOUT_MS }),
  ])
  const secondResult = await secondResponse.json()
  assert.equal(secondResult.result?.ok, true, `keyboard history page rejected: ${sanitized(JSON.stringify(secondResult))}`)
  assert.equal(secondResult.result.value?.hasMore, true, 'keyboard page unexpectedly exhausted history')
  await phone.waitForFunction(text => document.querySelector('[data-conversation-scroll]')?.textContent?.includes(text),
    turnText(50), { timeout: CLIENT_TIMEOUT_MS })
  await settleFrames(phone)
  await waitForQuietScroll(phone)
  assert.equal(pageRequests.length, 2, 'keyboard page compensation chained another request')

  const [, thirdResponse] = await Promise.all([
    loaderButton.click(),
    phone.waitForResponse(response => new URL(response.url()).pathname === '/api/session/page', { timeout: CLIENT_TIMEOUT_MS }),
  ])
  const thirdResult = await thirdResponse.json()
  assert.equal(thirdResult.result?.ok, true, `pointer history page rejected: ${sanitized(JSON.stringify(thirdResult))}`)
  assert.equal(thirdResult.result.value?.hasMore, false, 'pointer load did not exhaust the seeded history')
  await phone.waitForFunction(text => document.querySelector('[data-conversation-scroll]')?.textContent?.includes(text),
    turnText(1), { timeout: CLIENT_TIMEOUT_MS })
  await loader.waitFor({ state: 'detached', timeout: CLIENT_TIMEOUT_MS })
  assert.equal(pageRequests.length, 3, 'keyboard and pointer fallback did not make exactly one request each')
  assert(pageRequests.every(request => request.method === 'POST' && request.url === '/api/session/page'),
    `unexpected history transport: ${JSON.stringify(pageRequests)}`)
  assert.equal(promptRequests, 0, 'history smoke attempted a model prompt')
  const summary = { seededTurns, noInputRequests, pageRequests: pageRequests.length,
    busyBox, enabledBox, beforeCommit, afterCommit, addedHeight, beforeMulti, afterMulti, loaderBox, touchTrace, promptRequests }
  console.log('Packed DSH history smoke passed: three real older pages, stable viewport, no chained load, two-contact no-spurious-load/quiet expiry, keyboard and pointer loader.')
  console.log(JSON.stringify(summary))
} catch (error) {
  failure = new Error(`${sanitized(error instanceof Error ? error.stack ?? error.message : String(error))}\n${dsh?.logs() ?? ''}`)
} finally {
  releaseFirstPage?.()
  const failures = failure === undefined ? [] : [failure]
  if (browser !== undefined) await browser.close().catch(error => { recordSmokeFailure(failures, error) })
  if (dsh !== undefined) {
    try {
      const stopped = await dsh.close()
      if (stopped.forced || (stopped.code !== 0 && stopped.signal !== 'SIGTERM')) {
        throw new Error(`History scroll DSH fixture did not stop quiescently: ${sanitized(JSON.stringify(stopped))}`)
      }
    } catch (error) { recordSmokeFailure(failures, error) }
  }
  await removeTemporaryRoot(root, prefix).catch(error => { recordSmokeFailure(failures, error) })
  completeSmoke(failures)
}
