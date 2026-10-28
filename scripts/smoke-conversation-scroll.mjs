/** Exercise the existing DSH scrollport with and without dynamic viewport units. */
import assert from 'node:assert/strict'
import { mkdir, mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { packBundle } from './packed-profile.mjs'
import { completeSmoke, recordSmokeFailure } from './negative-control.mjs'
import {
  createMobileProfile, launchDsh, removeTemporaryRoot, openPairing,
  pairMobilePage, dismissOnboarding, CLIENT_TIMEOUT_MS, sanitized,
} from './mobile-boot-fixture.mjs'

const repository = fileURLToPath(new URL('..', import.meta.url))
const mobileRoot = process.env.DSH_BOOT_SMOKE_MOBILE_ROOT === undefined ? repository : resolve(process.env.DSH_BOOT_SMOKE_MOBILE_ROOT)
const dshBin = process.env.DSH_BOOT_SMOKE_BIN ?? fileURLToPath(new URL('../node_modules/@deepseek-ai/dsh/lib/bin.js', import.meta.url))
const negativeControl = process.argv.includes('--negative-control-viewport')
const prefix = 'dsh-mobile-scroll-smoke-'
const root = await mkdtemp(join(tmpdir(), prefix))
let dsh
let browser
let failure
let viewportFailureObserved = false

async function rpc(page, method, request) {
  const response = await page.evaluate(async ({ method, request }) => {
    const result = await fetch(`/api/${method}`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId: 'scroll-smoke', method, payload: { args: { request } } }),
      signal: AbortSignal.timeout(60000),
    })
    return { status: result.status, body: await result.json() }
  }, { method, request })
  assert.equal(response.status, 200, `${method} HTTP failure`)
  assert.equal(response.body.result?.ok, true, `${method} RPC failure`)
  return response.body.result.value
}

try {
  const workspacePath = join(root, 'workspace')
  await mkdir(workspacePath)
  const tarball = await packBundle(mobileRoot, root)
  const home = await createMobileProfile(root, { tarball, dshBin })
  dsh = launchDsh(root, home, dshBin)
  browser = await chromium.launch({ headless: true })
  const desktop = await browser.newPage({ locale: 'en-US' })
  const pairUrl = await openPairing(desktop, await dsh.ready(), dsh.logs)
  const workspace = await rpc(desktop, 'workspace/create', { path: workspacePath })
  assert.equal(typeof workspace.workspace?.workspaceId, 'string')
  const phone = await browser.newPage({ viewport: { width: 375, height: 812 }, locale: 'en-US', isMobile: true, hasTouch: true, reducedMotion: 'reduce' })
  await pairMobilePage(phone, pairUrl, dsh.logs)
  await dismissOnboarding(phone)
  const drawer = phone.locator('.dshm-drawer')
  await drawer.locator('button[data-dsh-mobile-toggle]').click()
  const workspaceRow = drawer.locator(`[role="treeitem"][data-row-key="workspace:${workspace.workspace.workspaceId}"]`)
  const created = phone.waitForResponse(response => {
    if (new URL(response.url()).pathname !== '/api/session/create') return false
    return response.request().postDataJSON()?.payload?.args?.request?.workspaceId === workspace.workspace.workspaceId
  }, { timeout: CLIENT_TIMEOUT_MS })
  try { await workspaceRow.getByRole('button').last().click() } catch (error) { void created.catch(() => {}); throw error }
  assert.equal((await (await created).json()).result?.ok, true)
  await phone.locator('[data-conversation-scroll]').waitFor({ state: 'visible', timeout: CLIENT_TIMEOUT_MS })
  if (await drawer.getAttribute('data-open') === 'true') await drawer.locator('button[data-dsh-mobile-toggle]').click()
  // Inert content provides a deterministic range inside DSH's real scrollport;
  // it does not introduce another scroller, a model request, or a real Session event.
  await phone.evaluate(() => {
    const scroller = document.querySelector('[data-conversation-scroll]')
    const content = document.createElement('div')
    content.dataset.scrollFixture = 'true'
    content.style.cssText = 'height:2400px;flex:none;pointer-events:none'
    scroller.prepend(content)
    window.__scrollSmokeStyles = Array.from(document.querySelectorAll('style'), element => [element, element.textContent])
  })
  const session = await phone.context().newCDPSession(phone)
  await session.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 1 })
  const results = []
  for (const viewport of [{ width: 375, height: 812 }, { width: 844, height: 393 }]) {
    await phone.setViewportSize(viewport)
    for (const legacyViewport of [false, true]) {
      const removedFallback = await phone.evaluate(({ legacyViewport, negativeControl }) => {
        let removed = false
        for (const [element, original] of window.__scrollSmokeStyles) {
          let css = original
          if (legacyViewport) {
            // A pre-dvh engine rejects these declarations before resolving size.
            css = css.replace(/\b(?:min-|max-)?height\s*:[^;{}]*dvh[^;{}]*;/gu, '')
            if (negativeControl) {
              const withoutFallback = css.replace(/(\.dshm-shell\s*\{[^}]*?)height:100%;/u, '$1')
              removed ||= withoutFallback !== css
              css = withoutFallback
            }
          }
          element.textContent = css
        }
        document.querySelector('[data-conversation-scroll]').scrollTop = 0
        return removed
      }, { legacyViewport, negativeControl })
      if (legacyViewport && negativeControl) assert(removedFallback, 'Negative control could not remove the shell fallback')
      await phone.evaluate(() => new Promise(resolveFrame => requestAnimationFrame(() => requestAnimationFrame(resolveFrame))))
      const geometry = await phone.evaluate(() => {
        const scroller = document.querySelector('[data-conversation-scroll]')
        const rect = scroller.getBoundingClientRect()
        const css = getComputedStyle(scroller)
        const ancestors = []
        for (let node = scroller; node !== null; node = node.parentElement) {
          const style = getComputedStyle(node)
          ancestors.push({ touchAction: style.touchAction, overflowY: style.overflowY, height: Math.round(node.getBoundingClientRect().height) })
        }
        return { shellHeight: document.querySelector('.dshm-shell').getBoundingClientRect().height,
          viewportHeight: innerHeight, clientHeight: scroller.clientHeight, scrollHeight: scroller.scrollHeight,
          overflowY: css.overflowY, x: rect.x, y: rect.y, width: rect.width, height: rect.height, ancestors }
      })
      const name = `${viewport.width}x${viewport.height}/${legacyViewport ? 'no-dvh' : 'modern'}`
      viewportFailureObserved = negativeControl && legacyViewport && removedFallback
        && !(geometry.shellHeight > 0 && geometry.shellHeight <= geometry.viewportHeight + 1)
      assert(geometry.shellHeight > 0 && geometry.shellHeight <= geometry.viewportHeight + 1,
        `${name}: shell escaped viewport: ${JSON.stringify(geometry)}`)
      assert(geometry.clientHeight > 0 && geometry.scrollHeight > geometry.clientHeight + 500,
        `${name}: real conversation has no bounded scroll range: ${JSON.stringify(geometry)}`)
      assert(['auto', 'scroll'].includes(geometry.overflowY), `${name}: actual DSH scrollport is not scrollable`)
      assert(geometry.ancestors.every(value => value.touchAction !== 'none'), `${name}: ancestor blocks native touch scrolling`)
      await phone.locator('[data-conversation-scroll]').evaluate(element => { element.scrollTop = 80 })
      assert.equal(await phone.locator('[data-conversation-scroll]').evaluate(element => element.scrollTop), 80, `${name}: scrollTop write failed`)
      const touchX = Math.round(geometry.x + geometry.width / 2)
      const touchY = Math.round(geometry.y + Math.min(geometry.height - 20, 220))
      await session.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: touchX, y: touchY, id: 1 }] })
      for (let step = 1; step <= 5; step++) {
        await session.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: touchX, y: touchY - step * 24, id: 1 }] })
        await phone.evaluate(() => new Promise(resolveFrame => requestAnimationFrame(resolveFrame)))
      }
      await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
      try {
        await phone.waitForFunction(() => document.querySelector('[data-conversation-scroll]').scrollTop > 100, undefined, { timeout: 5000 })
      } catch (error) {
        const observed = await phone.evaluate(({ x, y, width, height }) => {
          const point = document.elementFromPoint(x + width / 2, y + Math.min(height - 20, 120))
          return { scrollTop: document.querySelector('[data-conversation-scroll]').scrollTop,
            hitTag: point?.tagName, hitClass: point?.className,
            hitInScroller: document.querySelector('[data-conversation-scroll]').contains(point),
            visualViewport: { width: visualViewport?.width, height: visualViewport?.height, scale: visualViewport?.scale } }
        }, geometry)
        throw new Error(`${name}: touch gesture did not advance: ${JSON.stringify({ geometry, observed })}`, { cause: error })
      }
      results.push({ name, ...geometry, scrollTop: await phone.locator('[data-conversation-scroll]').evaluate(element => element.scrollTop) })
    }
  }
  assert.equal(await phone.locator('[data-scroll-fixture]').count(), 1, 'Fixture created another transcript region')
  console.log(`Packed DSH conversation scroll acceptance passed in ${results.length} viewport/unit combinations; browser touch gestures and the existing scrollport remained usable.`)
  console.log(JSON.stringify(results))
} catch (error) {
  failure = new Error(`${sanitized(error instanceof Error ? error.stack ?? error.message : String(error))}\n${dsh?.logs() ?? ''}`)
} finally {
  const failures = failure === undefined ? [] : [failure]
  if (browser !== undefined) await browser.close().catch(error => { recordSmokeFailure(failures, error) })
  if (dsh !== undefined) {
    try {
      const stopped = await dsh.close()
      if (stopped.forced || (stopped.code !== 0 && stopped.signal !== 'SIGTERM')) {
        throw new Error(`Scroll DSH fixture did not stop quiescently: ${sanitized(JSON.stringify(stopped))}`)
      }
    } catch (error) { recordSmokeFailure(failures, error) }
  }
  await removeTemporaryRoot(root, prefix).catch(error => { recordSmokeFailure(failures, error) })
  completeSmoke(failures, negativeControl ? 'Viewport negative control detected' : undefined, viewportFailureObserved)
}
