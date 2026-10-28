/** Exercise real packed DSH sidebar slots, Workspace rows and mobile hit/scroll ownership. */
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { access, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { installPackedBundle, packBundle } from './packed-profile.mjs'
import { completeSmoke, recordSmokeFailure } from './negative-control.mjs'
import { observeMobileBootDiagnostics, summarizeMobileBootDiagnostics } from './mobile-boot-diagnostics.mjs'
import { CLIENT_TIMEOUT_MS, createMobileProfile, dismissOnboarding, launchDsh, openMobileSettings, openPairing,
  pairMobilePage, removeTemporaryRoot, sanitized } from './mobile-boot-fixture.mjs'

const args = process.argv.slice(2)
assert(args.length === 0 || args.length === 1 && args[0] === '--negative-control-drawer', 'Unexpected sidebar smoke arguments')
const negative = args.includes('--negative-control-drawer')
const marker = 'Mobile sidebar scroll ownership negative control detected'
const repository = fileURLToPath(new URL('..', import.meta.url))
const dshBin = process.env.DSH_BOOT_SMOKE_BIN
const tarball = process.env.DSH_BOOT_SMOKE_MOBILE_TARBALL
assert(dshBin !== undefined && tarball !== undefined, 'Set exact DSH_BOOT_SMOKE_BIN and DSH_BOOT_SMOKE_MOBILE_TARBALL artifacts')
await access(dshBin); await access(tarball)
const prefix = 'dsh-mobile-sidebar-smoke-'
const root = await mkdtemp(join(tmpdir(), prefix))
const evidence = process.env.DSH_SIDEBAR_EVIDENCE_DIR === undefined
  ? join(repository, 'local/mobile-sidebar-smoke', randomUUID()) : resolve(process.env.DSH_SIDEBAR_EVIDENCE_DIR)
const fixtureName = 'dsh-mobile-sidebar-fixture'
const record = { geometry: [], checks: [], errors: [], prompts: 0 }
const failures = []
let browser, dsh, phone, bootDiagnostics, stage = 'installation', observedNegative = false, sequence = 0

// Public additive slots stress the actual SidebarRoot and WorkspaceBrowser.
// No stock rows, handlers or styles are copied into this fixture.
const fixtureClient = `window.__ModuleLoader__.load({id:${JSON.stringify(fixtureName)},factory:require=>{
 const {createElement:h,useState,useEffect}=require('react');
 const state={long:true,overlay:false,clicks:[]};window.__sidebarFixture=state;
 function useFixture(){const [revision,setRevision]=useState(0);useEffect(()=>{const update=()=>setRevision(value=>value+1);window.addEventListener('sidebar-fixture-update',update);return()=>window.removeEventListener('sidebar-fixture-update',update)},[]);return state}
 const update=()=>window.dispatchEvent(new Event('sidebar-fixture-update'));
 function Footer({wide}){const current=useFixture();return h('div',{'data-sidebar-fixture-footer':true,style:{width:'100%',minHeight:wide&&current.long?280:48,display:'flex',flexDirection:'column',justifyContent:'flex-end'}},h('button',{id:'sidebar-fixture-footer',style:{font:'inherit',minHeight:48,width:'100%'},onClick:()=>{state.clicks.push('footer');state.overlay=true;update()}},'Owned footer action'))}
 function Overlay(){const current=useFixture();return current.overlay?h('div',{id:'sidebar-fixture-dialog',role:'dialog','aria-label':'Owned sidebar overlay',style:{position:'fixed',inset:'72px 16px auto',padding:16,zIndex:1200,background:'var(--dsw-alias-bg-base)',color:'var(--dsw-alias-label-primary)'}},h('button',{id:'sidebar-fixture-close',style:{minWidth:48,minHeight:48},onClick:()=>{state.clicks.push('overlay');state.overlay=false;update()}},'Close owned overlay')):null}
 function Stop(){return h('button',{id:'sidebar-fixture-stop',style:{minWidth:44,minHeight:44},onClick:()=>state.clicks.push('stop')},'Owned Stop control')}
 function apply(ctx){ctx.effect(()=>{const off=[];state.setLong=value=>{state.long=value;update()};state.hasSession=id=>ctx.sessions.list.getSnapshot().byId[id]!==undefined;state.openSession=id=>ctx.uiWorkspace.openSession(id);
 for(const [name,id,component] of [['sidebar.footer.action','sidebar-fixture-footer',Footer],['shell.overlay','sidebar-fixture-overlay',Overlay],['conversation.input.right','sidebar-fixture-stop',Stop]])off.push(ctx.slots.inject(name,()=>ctx.slots.register({name,id},component)));
 for(let i=0;i<5;i++){const id='sidebar-fixture-panel-'+i;off.push(ctx.slots.inject('sidebar.panellist',()=>ctx.slots.register({name:'sidebar.panellist',id,label:'Owned panel '+i},()=>h('span',null,'P'))));off.push(ctx.slots.inject('main',()=>ctx.slots.register({name:'main',key:id},()=>h('div',{'data-sidebar-fixture-panel':id},'Owned panel '+i))))}
 return()=>{off.reverse().forEach(dispose=>dispose());delete window.__sidebarFixture}})}return{inject:['slots','uiWorkspace','sessions'],apply};}});`

async function addFixture(home) {
  const directory = join(root, fixtureName)
  await mkdir(join(directory, 'lib'), { recursive: true })
  await writeFile(join(directory, 'package.json'), JSON.stringify({ name: fixtureName, version: '1.0.0', type: 'module',
    main: './lib/index.mjs', exports: { '.': './lib/index.mjs', './package.json': './package.json', './client': './lib/client.js' },
    peerDependencies: { '@deepseek-ai/dsh-llm': '*' },
    dsh: { bundle: { patch: './cordis.patch.yml' }, client: { platform: 'web', inject: ['@deepseek-ai/dsh-client-ui-sidebar', '@deepseek-ai/dsh-client-ui-workspace'], immediately: true } } }) + '\n')
  // Blank Sessions are intentionally omitted from the real Workspace tree.
  // Commit a completed synthetic message in these owned Sessions, without a
  // prompt RPC, model, tool or replacement client projection.
  await writeFile(join(directory, 'lib/index.mjs'), `import {createUserMessage} from '@deepseek-ai/dsh-llm';
export const inject=['webServer','sessionController','sessions'];
export function apply(ctx){ctx.effect(()=>ctx.webServer.register({kind:'exact',path:'/api/mobile-sidebar-fixture',handler:async(request,response)=>{
 if(request.method!=='POST'){response.writeHead(405);response.end();return}
 const id=new URL(request.url,'http://fixture.invalid').searchParams.get('id');
 const resolved=await ctx.sessionController.resolveAgent(id);
 if(resolved.agent===undefined){response.writeHead(409,{'Content-Type':'application/json'});response.end(JSON.stringify({error:resolved.error}));return}
 const session=resolved.agent.session;
 session.append('turn/start',{turn:1});
 session.append('user/message',createUserMessage({content:[{type:'text',text:'Owned completed sidebar fixture; no model runs.'}],source:{kind:'user'}}),{surfaceOp:'append'});
 session.append('turn/end',{turn:1,reason:{kind:'completed'}});await ctx.sessions.flush(session);
 response.writeHead(200,{'Content-Type':'application/json'});response.end(JSON.stringify({ok:true}));
}}))}\n`)
  await writeFile(join(directory, 'lib/client.js'), fixtureClient + '\n')
  await writeFile(join(directory, 'cordis.patch.yml'), JSON.stringify([{ insert: [{ id: 'sidebar-fixture', name: fixtureName }] }]) + '\n')
  await installPackedBundle(await packBundle(directory, root), join(home, 'profiles/web'), { dshBin })
}

async function rpc(page, method, request, argumentName = 'request') {
  const result = await page.evaluate(async ({ method, request, argumentName, rpcId }) => {
    const response = await fetch(`/api/${method}`, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId, method, payload: { args: { [argumentName]: request } } }), signal: AbortSignal.timeout(60_000) })
    return { status: response.status, body: await response.json() }
  }, { method, request, argumentName, rpcId: `sidebar-smoke-${++sequence}` })
  assert.equal(result.status, 200, `${method}: HTTP rejected`)
  assert.equal(result.body.result?.ok, true, `${method}: ${sanitized(JSON.stringify(result.body))}`)
  return result.body.result.value
}

const frames = page => page.evaluate(() => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done))))
const sidebar = () => phone.locator('[data-dsh-mobile-sidebar]')
const sidebarRoot = () => phone.locator('[data-dsh-mobile-sidebar-root]')

async function openDrawer() {
  if (await sidebar().getAttribute('data-open') !== 'true') await sidebar().locator('[data-dsh-mobile-toggle]').tap()
  await phone.waitForFunction(() => document.querySelector('[data-dsh-mobile-sidebar]')?.dataset.open === 'true')
  await sidebarRoot().evaluate(node => { node.scrollTop = 0 })
  await frames(phone)
}

async function hit(locator, label, tap = true) {
  await locator.scrollIntoViewIfNeeded()
  await frames(phone)
  const value = await locator.evaluate(node => {
    const rect = node.getBoundingClientRect(), hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2)
    return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, width: rect.width, height: rect.height,
      hit: hit === node || node.contains(hit), covering: hit?.className ?? hit?.tagName }
  })
  const viewport = phone.viewportSize()
  assert(value.left >= -1 && value.right <= viewport.width + 1 && value.top >= -1 && value.bottom <= viewport.height + 1 && value.hit,
    `${label}: unreachable target ${JSON.stringify(value)}`)
  if (tap) await locator.tap()
  return value
}

async function revealSessionRow(sessionId) {
  // WorkspaceBrowser virtualizes its list. Scroll the actual owner until the
  // requested row mounts instead of requiring every account row in the DOM.
  await phone.evaluate(() => {
    const region = document.querySelector('[data-dsh-mobile-sidebar-root] [class*="_regionArea"]')
    const list = [...region.querySelectorAll('[class]')].find(node => [...node.classList].some(token => token.endsWith('_list')))
    if (list === undefined || getComputedStyle(list).overflowY !== 'auto') throw new Error('Actual Workspace scroll owner missing')
    list.dataset.sidebarFixtureScroller = 'true'; list.scrollTop = 0
  })
  const row = sidebar().locator(`[data-row-key="session:${sessionId}"]`)
  for (let step = 0; step < 32; step++) {
    await frames(phone)
    if (await row.count() === 1) return row
    const moved = await phone.locator('[data-sidebar-fixture-scroller]').evaluate(node => {
      const before = node.scrollTop
      node.scrollTop += Math.max(32, node.clientHeight / 2)
      return node.scrollTop > before
    })
    if (!moved) break
  }
  throw new Error('Actual Workspace virtual list did not reveal the requested owned Session')
}

async function geometry(label) {
  const value = await phone.evaluate(() => {
    const root = document.querySelector('[data-dsh-mobile-sidebar-root]'), region = root.querySelector('[class*="_regionArea"]')
    const list = region.querySelector('[class*="_list"]:not([class*="_listArea"])')
    const css = getComputedStyle(root), area = region.getBoundingClientRect(), bounds = root.getBoundingClientRect()
    return { root: { height: bounds.height, client: root.clientHeight, scroll: root.scrollHeight, top: bounds.top, bottom: bounds.bottom,
      overflow: css.overflowY }, region: { height: area.height, flex: getComputedStyle(region).flex, shrink: getComputedStyle(region).flexShrink },
      list: list === null ? null : { client: list.clientHeight, scroll: list.scrollHeight, overflow: getComputedStyle(list).overflowY },
      frame: document.querySelector('[data-dsh-mobile-frame]') === null ? null : getComputedStyle(document.querySelector('[data-dsh-mobile-frame]')).pointerEvents,
      width: innerWidth, height: innerHeight, documentWidth: document.documentElement.scrollWidth }
  })
  record.geometry.push({ label, ...value })
  return value
}

async function observeWorkspaceScroll() {
  const top = await phone.evaluate(() => {
    const region = document.querySelector('[data-dsh-mobile-sidebar-root] [class*="_regionArea"]')
    const list = [...region.querySelectorAll('[class]')].find(node => [...node.classList].some(token => token.endsWith('_list')))
    if (list === undefined) throw new Error('Actual Workspace list missing')
    list.scrollTop = Math.min(80, list.scrollHeight - list.clientHeight)
    return list.scrollTop
  })
  await frames(phone)
  assert(top > 0, 'Actual Workspace list with an overflowing range did not scroll')
  return top
}

async function removeDrawerOwnership() {
  return phone.evaluate(() => {
    let count = 0
    const visit = rules => {
      for (let index = rules.length - 1; index >= 0; index--) {
        const rule = rules[index]
        if (rule.selectorText?.includes('[data-dsh-mobile-sidebar-root]')
          && (rule.style?.getPropertyValue('flex') === '1 0 50%' || rule.style?.getPropertyValue('overflow-y') === 'auto')) {
          if (rule.parentRule !== null) rule.parentRule.deleteRule(index)
          else rule.parentStyleSheet.deleteRule(index)
          count++
        } else if (rule.cssRules !== undefined) visit(rule.cssRules)
      }
    }
    const style = document.querySelector('style[data-plugin="dsh-mobile"]')
    if (style === null) throw new Error('Missing packed mobile stylesheet')
    visit(style.sheet.cssRules)
    return count
  })
}

try {
  await mkdir(evidence, { recursive: true })
  record.tarballSha256 = createHash('sha256').update(await readFile(tarball)).digest('hex')
  const home = await createMobileProfile(root, { tarball: resolve(tarball), dshBin, packageStoreDirectory: join(root, 'pnpm-store'),
    extraPatches: [{ id: 'llm-deepseek', config: { models: [{ id: 'sidebar-model', name: 'Owned sidebar model', contextWindow: 128000, inputModalities: ['text'] }] } }] })
  await addFixture(home)
  console.log('Packed sidebar candidate and public-slot fixture installed in an owned profile.')
  const workspacePath = join(root, 'owned-workspace'); await mkdir(workspacePath)
  stage = 'boot'
  dsh = launchDsh(root, home, dshBin)
  browser = await chromium.launch({ headless: true })
  const desktop = await browser.newPage({ viewport: { width: 1280, height: 900 }, locale: 'en-US' })
  const launchUrl = await dsh.ready()
  const pairUrl = await openPairing(desktop, launchUrl, dsh.logs)
  console.log('Owned DSH desktop and Mobile Gateway are ready.')
  const workspace = await rpc(desktop, 'workspace/create', { path: workspacePath })
  const sessions = []
  for (let index = 0; index < 12; index++) {
    const id = (await rpc(desktop, 'session/create', { workspaceId: workspace.workspace.workspaceId })).sessionId
    const seeded = await desktop.evaluate(async id => {
      const response = await fetch(`/api/mobile-sidebar-fixture?id=${encodeURIComponent(id)}`, { method: 'POST', signal: AbortSignal.timeout(60_000) })
      const text = await response.text(); let body
      try { body = JSON.parse(text) } catch { body = undefined }
      return { status: response.status, body }
    }, id)
    assert.equal(seeded.status, 200, `Owned completed-turn fixture rejected: ${JSON.stringify(seeded)}`)
    assert.equal(seeded.body?.ok, true, `Owned completed-turn response was not accepted: ${JSON.stringify(seeded)}`)
    sessions.push(id)
  }
  record.seededList = await rpc(desktop, 'session/list', {}, '_request')
  phone = await browser.newPage({ viewport: { width: 393, height: 659 }, locale: 'en-US', isMobile: true, hasTouch: true, reducedMotion: 'reduce' })
  bootDiagnostics = observeMobileBootDiagnostics(phone)
  phone.on('pageerror', error => record.errors.push(error.message))
  await phone.route('**/api/session/prompt', async route => { record.prompts++; await route.abort('blockedbyclient') })
  const baseline = await pairMobilePage(phone, pairUrl, dsh.logs); await dismissOnboarding(phone)
  const account = baseline.value.items.find(item => item.workspaceId === workspace.workspace.workspaceId)
  assert(account !== undefined && sessions.every(id => account.sessionIds.includes(id)), 'Actual Workspace baseline omitted owned Session membership')
  await phone.waitForFunction(() => typeof window.__sidebarFixture?.openSession === 'function', undefined, { timeout: CLIENT_TIMEOUT_MS })
  const stockPreview = new URL(launchUrl)
  stockPreview.searchParams.delete('token')
  stockPreview.searchParams.set('dsh-mobile-preview', '1')
  record.stockScope = 'Authenticated stock DSH preview on its private server; not the raw frontend=stock Gateway route, which skips mobile boot/trust'
  const desktopBefore = await desktop.locator('[class*="_frame"]').first().evaluate(node => ({ pointer: getComputedStyle(node).pointerEvents, width: node.clientWidth }))
  for (const frontend of ['dedicated', 'stock']) {
    stage = `${frontend}-boot`
    if (frontend === 'stock') {
      // The diagnostic raw Gateway route omits mobile trust/boot. Use the
      // authenticated stock DSH document for this geometry comparison; the
      // existing preview flag selects only its mobile adapter on loopback.
      // The launch-token exchange redirects to ./ and drops all query fields.
      await phone.goto(launchUrl, { waitUntil: 'domcontentloaded' })
      await phone.goto(stockPreview.href, { waitUntil: 'domcontentloaded' })
      await phone.locator('[data-dsh-mobile-frame]').waitFor({ state: 'attached', timeout: CLIENT_TIMEOUT_MS })
      assert.equal(await phone.locator('.dshm-shell').count(), 0, 'Stock control loaded the dedicated layout')
    }
    await phone.waitForFunction(() => typeof window.__sidebarFixture?.openSession === 'function')
    await phone.waitForFunction(id => window.__sidebarFixture.hasSession(id), sessions[0], { timeout: CLIENT_TIMEOUT_MS })
    await phone.evaluate(id => window.__sidebarFixture.openSession(id), sessions[0])
    await phone.locator('[data-composer-input][contenteditable="true"]').waitFor({ state: 'visible', timeout: CLIENT_TIMEOUT_MS })
    for (const viewport of [{ width: 393, height: 659 }, { width: 369, height: 800 }, { width: 659, height: 393 }]) {
      await phone.setViewportSize(viewport)
      for (const large of [false, true]) {
        const label = `${frontend} ${viewport.width}x${viewport.height}${large ? ' large-text' : ''}`
        stage = label
        console.log(`Checking ${label}`)
        if (large) await phone.addStyleTag({ content: '[data-dsh-mobile-sidebar-root] :is(button,[role="treeitem"],span){font-size:22px!important;line-height:1.5!important}' }).then(style => style.evaluate(node => { node.dataset.sidebarLargeText = 'true' }))
        await openDrawer()
        const mounted = await sidebar().locator('[data-row-key^="session:"]').evaluateAll(nodes => nodes.map(node => node.dataset.rowKey))
        record.mountedRows = mounted
        assert(mounted.length > 0, 'Actual WorkspaceBrowser did not render any Session rows')
        if (negative) {
          assert.equal(await removeDrawerOwnership(), 2, 'Negative control did not remove exactly the drawer/region ownership rules')
          await frames(phone)
          const broken = await geometry(label)
          assert(Number(broken.region.shrink) > 0 && broken.region.height < 80 && broken.root.overflow !== 'auto', `Deliberate collapse was not observed: ${JSON.stringify(broken)}`)
          observedNegative = true
          throw new Error(marker)
        }
        const value = await geometry(label)
        assert(value.root.overflow === 'auto' && value.region.shrink === '0' && value.region.height >= value.root.height * .49,
          `${label}: workspace seat collapsed ${JSON.stringify(value)}`)
        assert(value.root.scroll > value.root.client, `${label}: controlled oversized footer/panels did not stress the outer scrollport`)
        assert(value.documentWidth <= value.width + 1, `${label}: page horizontal overflow`)
        if (frontend === 'stock') assert.equal(value.frame, 'none', `${label}: layout frame reclaimed the hit target`)
        if (value.list.scroll > value.list.client + 1) record.geometry.at(-1).workspaceScrollTop = await observeWorkspaceScroll()
        const row = await revealSessionRow(sessions[9])
        const rowHit = await hit(row, `${label} actual Session row`)
        await phone.waitForFunction(id => document.querySelector('[data-conversation-session]')?.dataset.conversationSession === id, sessions[9])
        record.checks.push(`${label}: actual WorkspaceBrowser row tap opened owned Session`)
        await openDrawer()
        await hit(sidebar().getByRole('button', { name: 'Owned panel 0', exact: true }), `${label} panel`)
        await phone.locator('[data-sidebar-fixture-panel="sidebar-fixture-panel-0"]').waitFor({ state: 'visible' })
        await openDrawer()
        await hit(sidebar().locator('button[class*="_newSession"]'), `${label} New Session`)
        await phone.locator('[data-composer-input][contenteditable="true"]').waitFor({ state: 'visible' })
        await dismissOnboarding(phone)
        await openDrawer()
        await hit(phone.locator('#sidebar-fixture-footer'), `${label} footer`)
        record.geometry.at(-1).footerScrollTop = await sidebarRoot().evaluate(node => node.scrollTop)
        assert(record.geometry.at(-1).footerScrollTop > 0, `${label}: footer did not exercise the actual outer drawer scrollport`)
        await phone.locator('#sidebar-fixture-dialog').waitFor({ state: 'visible' })
        await hit(phone.locator('#sidebar-fixture-close'), `${label} shell overlay dialog`)
        assert.equal(await phone.evaluate(() => window.__sidebarFixture.clicks.at(-1)), 'overlay')
        await openMobileSettings(phone, { sidebar: sidebar(), activate: (button, stage) => hit(button, `${label} Settings ${stage}`) })
        const settingsDialog = phone.locator('[data-dsh-mobile-settings]')
        await settingsDialog.waitFor({ state: 'visible' })
        await settingsDialog.evaluate(node => {
          const popup = node.closest('[role="presentation"]')
          if (popup !== null) popup.dataset.sidebarFixtureSettingsPopup = 'true'
        })
        await hit(settingsDialog.locator('[data-dsh-mobile-settings-header] button[class*="_close"]'), `${label} Settings close`)
        await settingsDialog.waitFor({ state: 'detached' })
        await phone.locator('[data-sidebar-fixture-settings-popup]').waitFor({ state: 'detached' })
        await openDrawer()
        await phone.touchscreen.tap(viewport.width - 4, Math.round(viewport.height / 2))
        await phone.waitForFunction(() => document.querySelector('[data-dsh-mobile-sidebar]')?.dataset.open === 'false')
        const editor = phone.locator('[data-composer-input][contenteditable="true"]')
        await hit(editor, `${label} composer`)
        assert(await editor.evaluate(node => node.contains(document.activeElement)), `${label}: composer did not focus`)
        await editor.fill('Owned sidebar draft; never submit.')
        const send = phone.locator('[data-composer-card] button[class*="_primary"]')
        assert(await send.isEnabled(), `${label}: stock Send not enabled for draft`)
        await hit(send, `${label} stock Send geometry`, false)
        await hit(phone.locator('#sidebar-fixture-stop'), `${label} additive Stop slot control`)
        assert.equal(await phone.evaluate(() => window.__sidebarFixture.clicks.at(-1)), 'stop')
        record.checks.push(`${label}: new/panel/footer/settings/overlay; outside dismissal; focused composer; real Send hit and additive Stop activation`)
        record.geometry.at(-1).sessionHit = rowHit
        await editor.fill('')
        if (large) await phone.locator('style[data-sidebar-large-text]').evaluateAll(nodes => nodes.forEach(node => node.remove()))
      }
    }
    await phone.setViewportSize({ width: 1000, height: 800 }); await frames(phone)
    await phone.evaluate(() => window.__sidebarFixture.setLong(false)); await openDrawer()
    const wide = await geometry(`${frontend} wide control`)
    assert.notEqual(wide.region.shrink, '0', 'Narrow scroll-seat override leaked onto a wide viewport')
    if (frontend === 'stock') assert.equal(wide.frame, 'auto', 'Narrow frame hit policy leaked onto wide stock')
    record.checks.push(`${frontend}: wide geometry/hit policy remained stock`)
    await phone.evaluate(() => window.__sidebarFixture.setLong(true))
    await phone.setViewportSize({ width: 393, height: 659 })
  }
  const desktopAfter = await desktop.locator('[class*="_frame"]').first().evaluate(node => ({ pointer: getComputedStyle(node).pointerEvents, width: node.clientWidth }))
  assert.deepEqual(desktopAfter, desktopBefore, 'Mobile changes altered desktop frame geometry/hit policy')
  assert.equal(record.prompts, 0, 'Sidebar smoke attempted a model request')
  assert.deepEqual(record.errors, [], 'Sidebar smoke emitted a page error')
  record.completed = true
  stage = 'completed'
} catch (error) {
  record.failure = sanitized(error instanceof Error ? error.stack ?? error.message : String(error))
  record.stage = stage
  if (dsh !== undefined) record.hostLogs = dsh.logs()
  recordSmokeFailure(failures, error)
  if (bootDiagnostics !== undefined) record.bootDiagnostics = await bootDiagnostics.snapshot().then(summarizeMobileBootDiagnostics).catch(cause => ({ unavailable: sanitized(String(cause)) }))
  if (phone !== undefined) record.dom = await phone.evaluate(() => ({ slots: [...document.querySelectorAll('[data-slot-error]')].map(node => node.dataset.slotError),
    fixtureLoaded: window.__sidebarFixture !== undefined, sidebar: document.querySelector('[data-dsh-mobile-sidebar]')?.dataset.open,
    dialogs: [...document.querySelectorAll('[role="dialog"],[role="presentation"]')].map(node => ({ role: node.getAttribute('role'), label: node.getAttribute('aria-label'),
      text: node.textContent?.slice(0, 500), buttons: [...node.querySelectorAll('button')].map(button => ({ text: button.textContent, label: button.getAttribute('aria-label') })) })) })).catch(() => undefined)
} finally {
  bootDiagnostics?.dispose()
  if (browser !== undefined) await browser.close().catch(error => recordSmokeFailure(failures, error))
  if (dsh !== undefined) {
    try { record.hostExit = await dsh.close(); assert(!record.hostExit.forced && (record.hostExit.code === 0 || record.hostExit.signal === 'SIGTERM'), 'Sidebar fixture needed forced/abnormal DSH termination') }
    catch (error) { recordSmokeFailure(failures, error) }
  }
  await removeTemporaryRoot(root, prefix).catch(error => recordSmokeFailure(failures, error))
  record.cleanup = failures.length === (record.failure === undefined ? 0 : 1) ? 'completed' : 'failed'
  await mkdir(evidence, { recursive: true }).catch(error => recordSmokeFailure(failures, error))
  await writeFile(join(evidence, 'evidence.json'), JSON.stringify(record, null, 2) + '\n').catch(error => recordSmokeFailure(failures, error))
}
console.log(JSON.stringify({ completed: record.completed ?? false, geometryCases: record.geometry.length, evidence, stage,
  scope: 'packed dedicated Mobile Gateway plus authenticated stock DSH preview; not raw stock Gateway, reporter scripts or physical Android' }))
completeSmoke(failures, negative ? marker : undefined, observedNegative)
