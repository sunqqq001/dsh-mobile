/** Check the shipped early-error UI in modern Chromium; this does not emulate an old parser or an Android Activity. */
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { chromium } from 'playwright'

const bundle = await readFile(new URL('../lib/mobile-compat.js', import.meta.url), 'utf8')
const native = await readFile(new URL('../apps/mobile/android/app/src/main/java/io/github/sayach/dshmobile/WebViewDocumentState.kt', import.meta.url), 'utf8')
const readyProbe = /internal val INITIAL_DSH_READY_PROBE = """([\s\S]*?)"""/u.exec(native)?.[1]
assert.ok(readyProbe, 'Current App readiness expression was not found')
const browser = await chromium.launch({ headless: true })
try {
  for (const mode of [
    { locale: 'en-US', colorScheme: 'light', viewport: { width: 375, height: 812 }, title: 'DSH could not start' },
    { locale: 'it-IT', colorScheme: 'dark', viewport: { width: 390, height: 844 }, title: 'Impossibile avviare DSH' },
    { locale: 'zh-CN', colorScheme: 'dark', viewport: { width: 844, height: 390 }, title: 'DSH 未能启动', large: true },
  ]) {
    const page = await browser.newPage({ locale: mode.locale, colorScheme: mode.colorScheme, viewport: mode.viewport, reducedMotion: 'reduce' })
    let documents = 0
    const policyErrors = []
    page.on('console', message => {
      if (message.type() === 'error' && /Content Security Policy/iu.test(message.text())) policyErrors.push(message.text())
    })
    await page.route('https://feedback.test/**', route => {
      const pathname = new URL(route.request().url()).pathname
      if (pathname === '/compat.js') return route.fulfill({ contentType: 'text/javascript', body: bundle })
      if (pathname === '/broken.js') return route.fulfill({ contentType: 'text/javascript', body: 'class Broken { static { ??? } } // private-marker' })
      documents += 1
      return route.fulfill({
        contentType: 'text/html',
        headers: { 'Content-Security-Policy': "default-src 'none'; script-src 'nonce-fixture'; style-src 'nonce-fixture';" },
        body: `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="dsh-mobile-gateway" content="authenticated"><style nonce="fixture">:root{font-size:${mode.large ? '24px' : '16px'}}</style><script nonce="fixture" src="/compat.js"></script><script nonce="fixture" type="module" src="/broken.js"></script></head><body><div id="root"></div></body></html>`,
      })
    })
    await page.goto('https://feedback.test/?private=private-marker')
    const card = page.locator('[data-dsh-mobile-boot-failure="syntax_error"]')
    await card.waitFor({ state: 'visible' })
    assert.equal(await card.locator('h1').innerText(), mode.title)
    assert.equal(await page.evaluate(readyProbe), true, 'The actual native expression must recognize genuine error actions')
    assert.equal(await page.locator('.dshm-shell').count(), 0, 'The feedback must not impersonate mounted DSH')
    assert.doesNotMatch(await card.innerText(), /private-marker|feedback\.test|broken\.js/u)
    const geometry = await card.evaluate(node => {
      const rect = node.getBoundingClientRect()
      const buttons = [...node.querySelectorAll('button')].map(button => {
        const box = button.getBoundingClientRect()
        return { width: box.width, height: box.height }
      })
      return { left: rect.left, right: rect.right, width: rect.width, horizontalOverflow: node.scrollWidth > node.clientWidth, buttons }
    })
    assert.ok(geometry.left >= 0 && geometry.right <= mode.viewport.width && geometry.width <= 816, JSON.stringify(geometry))
    assert.equal(geometry.horizontalOverflow, false)
    assert.ok(geometry.buttons.every(button => button.height >= 48 && button.width >= 44), JSON.stringify(geometry))
    assert.deepEqual(policyErrors, [], 'Nonce-restricted CSP must remain effective without blocking the feedback style')
    assert.equal(documents, 1, 'No automatic navigation is permitted')
    await page.evaluate(() => { globalThis.feedbackDocument = document })
    await page.evaluate(() => { document.querySelector('#root').innerHTML = '<main><button id="ready">Ready</button></main>' })
    await card.waitFor({ state: 'detached' })
    assert.equal(await page.evaluate(() => feedbackDocument === document), true)
    assert.equal(await page.locator('#ready').isVisible(), true)
    await page.close()
  }
  for (const mode of ['healthy', 'existing-loader', 'ordinary-preview', 'actions']) {
    const page = await browser.newPage({ locale: 'en-US' })
    let documents = 0
    await page.route('https://control.test/**', route => {
      if (new URL(route.request().url()).pathname === '/compat.js') return route.fulfill({ contentType: 'text/javascript', body: bundle })
      documents += 1
      return route.fulfill({ contentType: 'text/html', body: `<!doctype html><html><head>${mode === 'ordinary-preview' ? '' : '<meta name="dsh-mobile-gateway" content="authenticated">'}<script src="/compat.js"></script></head><body><div id="root">${mode === 'existing-loader' ? '<div data-dsh-boot>DSH loader</div>' : mode === 'healthy' ? '<button>Ready</button>' : ''}</div></body></html>` })
    })
    await page.goto('https://control.test/')
    const fail = () => page.evaluate(() => { window.dispatchEvent(new ErrorEvent('error', { error: new TypeError('private-marker'), message: 'private-marker' })) })
    await fail()
    const card = page.locator('[data-dsh-mobile-boot-failure]')
    if (mode === 'actions') {
      await card.waitFor({ state: 'visible' })
      await Promise.all([page.waitForEvent('load'), card.getByRole('button', { name: 'Reload page', exact: true }).click()])
      await page.waitForFunction(() => document.documentElement.hasAttribute('data-dsh-mobile-boot-feedback-installed'))
      assert.equal(documents, 2, 'Reload is a single explicit navigation')
      await fail()
      await card.getByRole('button', { name: 'Keep waiting', exact: true }).click()
      await card.waitFor({ state: 'detached' })
      await fail()
      assert.equal(await card.count(), 0, 'A dismissed notice must not immediately reopen')
      assert.equal(documents, 2)
    } else {
      assert.equal(await card.count(), 0, mode)
      assert.equal(await page.evaluate(readyProbe), mode === 'healthy', mode)
    }
    await page.close()
  }
  console.log('Early boot feedback: localized portrait/landscape geometry, nonce CSP, native probe expression, late mount and explicit recovery passed in modern Chromium; physical old WebView remains unverified')
} finally {
  await browser.close()
}
