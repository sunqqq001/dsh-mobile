/** Real packed DSH attachment intake without sending a prompt or using a normal profile. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { installPackedBundle, packBundle } from './packed-profile.mjs'
import { createMobileProfile, launchDsh, removeTemporaryRoot, openPairing, pairMobilePage,
  dismissOnboarding, CLIENT_TIMEOUT_MS, sanitized } from './mobile-boot-fixture.mjs'
import { completeSmoke, recordSmokeFailure } from './negative-control.mjs'

const args = process.argv.slice(2)
assert(args.length === 0 || args.length === 1 && ['--negative-control-items', '--expect-legacy-items-failure'].includes(args[0]),
  'Usage: smoke-mobile-attachments.mjs [--negative-control-items | --expect-legacy-items-failure]')
const negative = args.length === 1
const injectMissingItems = args[0] === '--negative-control-items'
const marker = 'Attachment handoff negative control detected'
const repository = fileURLToPath(new URL('..', import.meta.url))
const mobileRoot = process.env.DSH_BOOT_SMOKE_MOBILE_ROOT === undefined ? repository : resolve(process.env.DSH_BOOT_SMOKE_MOBILE_ROOT)
const dshBin = process.env.DSH_BOOT_SMOKE_BIN ?? fileURLToPath(new URL('../node_modules/@deepseek-ai/dsh/lib/bin.js', import.meta.url))
const prefix = 'dsh-mobile-attachments-smoke-'
const fixtureName = 'dsh-mobile-attachment-state-fixture'
const root = await mkdtemp(join(tmpdir(), prefix))
const previousNpmCache = process.env.npm_config_cache
process.env.npm_config_cache = join(root, 'npm-cache')
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC', 'base64')
const failures = []
const pageErrors = []
const prompts = []
let browser, dsh, observedNegative = false, sequence = 0

// Only a read-only snapshot of DSH's public per-session input facade is exposed.
// No replacement attachment consumer, Host attachment-directory count, or model path is used.
const fixtureClient = `window.__ModuleLoader__.load({id:${JSON.stringify(fixtureName)},factory:require=>{
 function apply(ctx){ctx.effect(()=>{
   window.__dshAttachmentState=id=>{
     const scope=ctx.sessions.scope(id);if(scope===undefined)return null;
     const value=ctx.conversation.input.for(scope).state.getSnapshot();
     return {attachmentIds:[...value.attachmentIds],draft:value.draft,phase:value.phase};
   };
   return()=>{delete window.__dshAttachmentState};
 })}
 return {inject:['conversation','sessions'],apply};}});`

async function addStateFixture(home) {
  const directory = join(root, fixtureName)
  await mkdir(join(directory, 'lib'), { recursive: true })
  await writeFile(join(directory, 'package.json'), JSON.stringify({ name: fixtureName, version: '1.0.0', type: 'module',
    main: './lib/index.mjs', exports: { '.': './lib/index.mjs', './package.json': './package.json', './client': './lib/client.js' },
    dsh: { bundle: { patch: './cordis.patch.yml' }, client: { platform: 'web',
      inject: ['@deepseek-ai/dsh-client-ui-conversation', '@deepseek-ai/dsh-api-session-controller'], immediately: true } } }) + '\n')
  await writeFile(join(directory, 'lib', 'index.mjs'), 'export function apply() {}\n')
  await writeFile(join(directory, 'lib', 'client.js'), fixtureClient + '\n')
  await writeFile(join(directory, 'cordis.patch.yml'), JSON.stringify([{ insert: [{ id: 'attachment-state-fixture', name: fixtureName }] }]) + '\n')
  await installPackedBundle(await packBundle(directory, root), join(home, 'profiles', 'web'), { dshBin })
}

async function rpc(page, method, request) {
  const response = await page.evaluate(async ({ method, request, rpcId }) => {
    const result = await fetch(`/api/${method}`, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId, method, payload: { args: { request } } }),
      signal: AbortSignal.timeout(60_000) })
    return { status: result.status, body: await result.json() }
  }, { method, request, rpcId: `attachment-smoke-${++sequence}` })
  assert.equal(response.status, 200, sanitized(JSON.stringify(response)))
  assert.equal(response.body.result?.ok, true, sanitized(JSON.stringify(response)))
  return response.body.result.value
}

const frames = page => page.evaluate(() => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done))))

async function snapshot(page, sessionId) {
  return page.evaluate(id => {
    const input = window.__dshAttachmentState?.(id)
    const rail = document.querySelector('[data-composer-card] [data-slot="conversation.input.attachments"]')
    return { input, previews: Array.from(rail?.querySelectorAll('img') ?? [], image => ({ name: image.alt,
      ready: image.complete && image.naturalWidth > 0, source: image.src.startsWith('blob:') ? 'blob' : 'other' })) }
  }, sessionId)
}

async function expectAttachments(page, sessionId, names) {
  await page.waitForFunction(({ id, names }) => {
    const input = window.__dshAttachmentState?.(id)
    const rail = document.querySelector('[data-composer-card] [data-slot="conversation.input.attachments"]')
    const images = Array.from(rail?.querySelectorAll('img') ?? [])
    return input !== null && input !== undefined && input.attachmentIds.length === names.length
      && images.length === names.length && images.every((image, index) => image.alt === names[index]
        && image.complete && image.naturalWidth > 0)
  }, { id: sessionId, names }, { timeout: CLIENT_TIMEOUT_MS })
  const state = await snapshot(page, sessionId)
  assert.equal(new Set(state.input.attachmentIds).size, names.length, 'DSH input contains duplicate or missing attachment identities')
  assert(state.previews.every(preview => preview.source === 'blob'), 'Preview did not come from the real browser attachment descriptor')
  return state
}

async function clearImages(page, sessionId, names) {
  for (const name of names) await page.getByRole('button', { name: `Remove image ${name}`, exact: true }).click()
  await expectAttachments(page, sessionId, [])
}

async function launchCamera(page) {
  const count = await page.evaluate(() => window.__attachmentDeliveryFixture.pickers.length)
  await page.locator('[data-composer-card] button[aria-haspopup="listbox"]').first().click()
  const camera = page.getByRole('option', { name: 'Take photo', exact: true })
  await camera.waitFor({ state: 'visible', timeout: CLIENT_TIMEOUT_MS })
  try {
    await page.waitForFunction(() => document.querySelector('[data-dsh-mobile-media-action="camera"]')?.disabled === false,
      undefined, { timeout: 15_000 })
  } catch (error) {
    const diagnostic = await page.evaluate(() => {
      const camera = document.querySelector('[data-dsh-mobile-media-action="camera"]')
      const sessionId = document.querySelector('[data-conversation-session]')?.getAttribute('data-conversation-session')
      const state = sessionId === null || sessionId === undefined ? null : window.__dshAttachmentState?.(sessionId)
      return { title: camera?.title, disabled: camera?.disabled, inputPhase: state?.phase,
        attachmentCount: state?.attachmentIds.length, editorDisabled: document.querySelector('[data-composer-input]')?.getAttribute('aria-disabled') }
    })
    throw new Error(`Camera preflight did not become available: ${JSON.stringify(diagnostic)}`, { cause: error })
  }
  await camera.click()
  await page.waitForFunction(previous => window.__attachmentDeliveryFixture.pickers.length === previous + 1, count)
  return count
}

async function deliverCamera(page, picker, names) {
  await page.evaluate(({ picker, names, base64 }) => {
    const input = window.__attachmentDeliveryFixture.pickers[picker]
    const bytes = Uint8Array.from(atob(base64), character => character.charCodeAt(0))
    const transfer = new DataTransfer()
    for (const name of names) transfer.items.add(new File([bytes], name, { type: 'image/png' }))
    input.files = transfer.files
    input.dispatchEvent(new Event('change', { bubbles: true }))
  }, { picker, names, base64: png.toString('base64') })
}

try {
  const workspace = join(root, 'workspace')
  await mkdir(workspace)
  const tarball = process.env.DSH_BOOT_SMOKE_MOBILE_TARBALL === undefined ? await packBundle(mobileRoot, root)
    : resolve(process.env.DSH_BOOT_SMOKE_MOBILE_TARBALL)
  const artifactSha256 = createHash('sha256').update(await readFile(tarball)).digest('hex')
  console.log(JSON.stringify({ artifactSha256, privatePackageCaches: true, expectedLegacyFault: negative }))
  const home = await createMobileProfile(root, { tarball, dshBin, packageStoreDirectory: join(root, 'pnpm-store'),
    extraPatches: [{ id: 'llm-deepseek', config: {
    models: [{ id: 'attachment-test-model', name: 'Attachment fixture', contextWindow: 128000, inputModalities: ['text', 'image'] }],
  } }] })
  await addStateFixture(home)
  dsh = launchDsh(root, home, dshBin)
  browser = await chromium.launch({ headless: true })
  const desktop = await browser.newPage({ locale: 'en-US' })
  const pairUrl = await openPairing(desktop, await dsh.ready(), dsh.logs)
  const createdWorkspace = await rpc(desktop, 'workspace/create', { path: workspace })
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, locale: 'en-US', isMobile: true,
    hasTouch: true, reducedMotion: 'reduce' })
  page.on('pageerror', error => pageErrors.push(error.message))
  await page.route('**/api/session/prompt', async route => { prompts.push('session/prompt'); await route.abort('blockedbyclient') })
  await page.addInitScript(({ injectMissingItems }) => {
    const fixture = { pickers: [], drops: [], injectMissingItems }
    window.__attachmentDeliveryFixture = fixture
    const originalClick = HTMLInputElement.prototype.click
    HTMLInputElement.prototype.click = function () {
      if (this.type === 'file' && this.capture === 'environment' && this.accept === 'image/*') {
        fixture.pickers.push(this)
        return
      }
      return originalClick.call(this)
    }
    if (injectMissingItems) {
      const originalDispatch = Document.prototype.dispatchEvent
      Document.prototype.dispatchEvent = function (event) {
        if (event.type === 'drop' && event.dataTransfer !== undefined) {
          const legacy = new Event('drop', { bubbles: true, cancelable: true })
          Object.defineProperty(legacy, 'dataTransfer', { value: { dropEffect: event.dataTransfer.dropEffect,
            effectAllowed: event.dataTransfer.effectAllowed, files: event.dataTransfer.files, types: event.dataTransfer.types } })
          return originalDispatch.call(this, legacy)
        }
        return originalDispatch.call(this, event)
      }
    }
    document.addEventListener('drop', event => {
      const value = event.dataTransfer
      if (value === null || value === undefined) return
      fixture.drops.push({ names: Array.from(value.files, file => file.name),
        itemsIterable: value.items !== undefined && typeof value.items[Symbol.iterator] === 'function' })
    }, true)
  }, { injectMissingItems })
  await pairMobilePage(page, pairUrl, dsh.logs)
  await dismissOnboarding(page)
  const drawer = page.locator('.dshm-drawer')
  if (await drawer.getAttribute('data-open') !== 'true') await drawer.locator('button[data-dsh-mobile-toggle]').click()
  const created = page.waitForResponse(response => new URL(response.url()).pathname === '/api/session/create'
    && response.request().postDataJSON()?.payload?.args?.request?.workspaceId === createdWorkspace.workspace.workspaceId,
  { timeout: CLIENT_TIMEOUT_MS })
  try {
    await drawer.locator(`[role="treeitem"][data-row-key="workspace:${createdWorkspace.workspace.workspaceId}"]`).getByRole('button').last().click()
  } catch (error) { void created.catch(() => {}); throw error }
  const response = await (await created).json()
  assert.equal(response.result?.ok, true)
  const sessionId = response.result.value.sessionId
  await page.waitForFunction(id => document.querySelector('[data-conversation-session]')?.getAttribute('data-conversation-session') === id, sessionId)
  const card = page.locator('[data-composer-card]').first()
  const editor = card.locator('[data-composer-input][contenteditable="true"]')
  await editor.waitFor({ state: 'visible', timeout: CLIENT_TIMEOUT_MS })
  if (await drawer.getAttribute('data-open') === 'true') await drawer.locator('button[data-dsh-mobile-toggle]').click()
  await page.waitForFunction(id => window.__dshAttachmentState?.(id)?.phase === 'plain', sessionId)
  const heldDraft = 'Held attachment acceptance draft — never submit'
  await editor.fill(heldDraft)
  await page.waitForFunction(({ id, text }) => window.__dshAttachmentState?.(id)?.draft === text,
    { id: sessionId, text: heldDraft }, { timeout: CLIENT_TIMEOUT_MS })
  const initial = await snapshot(page, sessionId)
  assert.equal(initial.input.attachmentIds.length, 0)

  // Establish real DSH native multi-file intake as a control before testing our handoff.
  const multiple = ['native-first.png', 'native-second.png']
  const fileInput = card.locator('input[type="file"][multiple]').first()
  assert.equal(await fileInput.count(), 1, 'The stock multiple-file input was not mounted')
  await fileInput.setInputFiles(multiple.map(name => ({ name, mimeType: 'image/png', buffer: png })))
  await expectAttachments(page, sessionId, multiple)
  await clearImages(page, sessionId, multiple)
  assert.deepEqual(pageErrors, [], 'Stock attachment control failed before testing the mobile handoff')

  const firstCamera = await launchCamera(page)
  await deliverCamera(page, firstCamera, ['browser-camera.png'])
  await frames(page)
  if (negative) {
    await page.waitForFunction(() => window.__attachmentDeliveryFixture.drops.some(drop => drop.itemsIterable === false))
    const state = await snapshot(page, sessionId)
    assert.equal(state.input.attachmentIds.length, 0, 'The negative control still entered DSH input state')
    assert.equal(state.previews.length, 0, 'The negative control still rendered a DSH attachment')
    assert.equal(pageErrors.length, 1, 'The negative control observed unrelated or duplicate page errors')
    assert.match(pageErrors[0], /^dataTransfer\.items is not iterable$/u, 'No actual DSH items-iterator failure was observed')
    assert.equal(prompts.length, 0)
    observedNegative = true
    throw new Error(marker)
  }
  await expectAttachments(page, sessionId, ['browser-camera.png'])
  assert.deepEqual(await page.evaluate(() => window.__attachmentDeliveryFixture.drops.at(-1)),
    { names: ['browser-camera.png'], itemsIterable: true }, 'The handoff did not supply a usable DataTransfer item list')
  await clearImages(page, sessionId, ['browser-camera.png'])

  const cancelled = await launchCamera(page)
  await page.evaluate(index => window.__attachmentDeliveryFixture.pickers[index].dispatchEvent(new Event('cancel')), cancelled)
  await deliverCamera(page, cancelled, ['cancelled-camera.png'])
  await frames(page)
  assert.deepEqual(await snapshot(page, sessionId), initial, 'A cancelled camera changed the real draft or attachment state')

  const late = await launchCamera(page)
  await page.evaluate(() => { window.dispatchEvent(new Event('focus')); document.dispatchEvent(new Event('visibilitychange')) })
  // Deliberately cross the removed one-second cleanup policy before a genuine change event.
  await page.waitForTimeout(1250)
  assert(await page.evaluate(index => window.__attachmentDeliveryFixture.pickers[index].isConnected, late),
    'Camera input was removed on focus before its result arrived')
  await deliverCamera(page, late, ['late-camera.png'])
  await expectAttachments(page, sessionId, ['late-camera.png'])
  await clearImages(page, sessionId, ['late-camera.png'])

  const stale = await launchCamera(page)
  const current = await launchCamera(page)
  await deliverCamera(page, stale, ['superseded-camera.png'])
  await frames(page)
  assert.deepEqual(await snapshot(page, sessionId), initial, 'A superseded camera response changed the current draft')
  await deliverCamera(page, current, ['current-camera.png'])
  const accepted = await expectAttachments(page, sessionId, ['current-camera.png'])
  assert.equal(accepted.input.draft, initial.input.draft, 'Attachment intake changed the held draft')
  await clearImages(page, sessionId, ['current-camera.png'])
  assert.deepEqual(pageErrors, [], 'Attachment consumer generated an unhandled page error')
  assert.equal(prompts.length, 0, 'Attachment testing attempted a model submission')
  console.log('Packed DSH attachments passed native multi-file control, browser-camera handoff, actual input attachment identities and decoded previews, cancellation, late focus result, superseded result, and unchanged held draft. No prompt/model call was made; Android camera/bridge itself was not tested.')
} catch (error) {
  recordSmokeFailure(failures, new Error(`${sanitized(error instanceof Error ? error.stack ?? error.message : String(error))}\n${dsh?.logs() ?? ''}`))
} finally {
  if (browser !== undefined) await browser.close().catch(error => recordSmokeFailure(failures, error))
  if (dsh !== undefined) {
    try {
      const stopped = await dsh.close()
      if (stopped.forced || (stopped.code !== 0 && stopped.signal !== 'SIGTERM')) throw new Error(`Attachment fixture did not stop quiescently: ${sanitized(JSON.stringify(stopped))}`)
    } catch (error) { recordSmokeFailure(failures, error) }
  }
  await removeTemporaryRoot(root, prefix).catch(error => recordSmokeFailure(failures, error))
  if (previousNpmCache === undefined) delete process.env.npm_config_cache
  else process.env.npm_config_cache = previousNpmCache
}
completeSmoke(failures, negative ? marker : undefined, observedNegative)
