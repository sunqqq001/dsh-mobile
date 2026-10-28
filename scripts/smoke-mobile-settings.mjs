/** Mounted DSH General settings with local typography and a narrowly simulated native scale bridge. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { packBundle } from './packed-profile.mjs'
import { createMobileProfile, launchDsh, removeTemporaryRoot, openPairing, pairMobilePage,
  dismissOnboarding, openMobileSettings, CLIENT_TIMEOUT_MS, sanitized } from './mobile-boot-fixture.mjs'

const repository = fileURLToPath(new URL('..', import.meta.url))
const mobileRoot = process.env.DSH_BOOT_SMOKE_MOBILE_ROOT === undefined ? repository : resolve(process.env.DSH_BOOT_SMOKE_MOBILE_ROOT)
const dshBin = process.env.DSH_BOOT_SMOKE_BIN ?? fileURLToPath(new URL('../node_modules/@deepseek-ai/dsh/lib/bin.js', import.meta.url))
const prefix = 'dsh-mobile-settings-smoke-'
const root = await mkdtemp(join(tmpdir(), prefix))
const cases = []
let dsh
let browser
let failure
let tarballSha256

async function openSettings(page) {
  await openMobileSettings(page)
  await page.locator('[data-mobile-font-setting]').waitFor({ state: 'visible', timeout: CLIENT_TIMEOUT_MS })
}

async function touchTarget(page, locator, description) {
  await locator.scrollIntoViewIfNeeded()
  const result = await locator.evaluate(node => {
    const box = node.getBoundingClientRect()
    const hit = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2)
    const edgeHits = [box.x + 4, box.right - 4].every(x => {
      const edge = document.elementFromPoint(x, box.y + box.height / 2)
      return edge !== null && (edge === node || node.contains(edge))
    })
    return { width: box.width, height: box.height, left: box.left, right: box.right,
      viewport: innerWidth, hit: hit !== null && (hit === node || node.contains(hit)), edgeHits }
  })
  assert(result.height >= 48 && result.width >= 44, `${description}: small touch target ${JSON.stringify(result)}`)
  assert(result.left >= -1 && result.right <= result.viewport + 1 && result.hit, `${description}: clipped or blocked ${JSON.stringify(result)}`)
  assert(result.edgeHits, `${description}: touch target edges are blocked ${JSON.stringify(result)}`)
}

async function runCase({ width, height = 900, locale, bridgeMode }) {
  const context = await browser.newContext({ viewport: { width, height }, locale, isMobile: true,
    hasTouch: true, reducedMotion: 'reduce' })
  const errors = []
  const settingsWrites = []
  try {
    const page = await context.newPage()
    page.on('pageerror', error => errors.push(error.message))
    page.on('request', request => {
      if (request.method() === 'POST' && /\/api\/.*settings.*mutate/u.test(new URL(request.url()).pathname)) settingsWrites.push(new URL(request.url()).pathname)
    })
    await page.addInitScript(({ bridgeMode }) => {
      let moduleLoader
      Object.defineProperty(window, '__ModuleLoader__', {
        configurable: true,
        get: () => moduleLoader,
        set: value => {
          moduleLoader = value
          const create = value.create
          value.create = function (...args) {
            const modules = create.apply(this, args)
            window.__settingsModules = modules
            return modules
          }
        },
      })
      if (bridgeMode === 'browser') return
      const state = { percent: 100, calls: [], failNextSet: false }
      window.__settingsScaleFixture = state
      // Only this native operation is simulated; DSH, React, slots, local storage and pairing are real.
      window.__DSH_MOBILE_NATIVE__ = {
        capabilities: () => Promise.resolve(bridgeMode === 'old-app' ? ['files.pick'] : ['mobile.display-scale.get', 'mobile.display-scale.set']),
        invoke: async (action, input) => {
          if (!action.startsWith('mobile.display-scale.')) throw new Error('Unexpected native action')
          state.calls.push({ action, input })
          if (action === 'mobile.display-scale.set') {
            if (state.failNextSet) { state.failNextSet = false; throw new Error('Simulated native set failure') }
            if (!Number.isInteger(input?.percent) || input.percent < 80 || input.percent > 125) throw new Error('Invalid native scale')
            state.percent = input.percent
          }
          return { percent: state.percent, minPercent: 80, maxPercent: 125 }
        },
      }
    }, { bridgeMode })
    const pairUrl = await openPairing(desktop, undefined, dsh.logs)
    await pairMobilePage(page, pairUrl, dsh.logs, {
      beforeSubmit: async paired => { await paired.evaluate(() => { localStorage.setItem('dsh-mobile.content-font-size.v1', '20') }) },
    })
    await dismissOnboarding(page)
    await openSettings(page)
    const close = page.locator('[data-dsh-mobile-settings-header] button[class*="_close"]')
    await touchTarget(page, close, 'Settings close')
    const headerGeometry = await close.locator('..').evaluate(node => {
      const box = node.getBoundingClientRect()
      return { left: box.left, right: box.right, viewport: innerWidth }
    })
    assert(headerGeometry.left >= -1 && headerGeometry.right <= headerGeometry.viewport + 1, `Settings header clipped ${JSON.stringify(headerGeometry)}`)
    // First-run dismissal owns its own settings write; measure only the controls under test.
    settingsWrites.length = 0
    const row = page.locator('[data-mobile-font-setting]')
    await page.evaluate(async () => {
      const modules = window.__settingsModules
      const [react, reactDom, primitives] = await Promise.all([
        modules.import('react'), modules.import('react-dom/client'), modules.import('@deepseek-ai/dsh-client-ui-primitives'),
      ])
      const container = document.createElement('section')
      container.dataset.settingsFontProof = 'true'
      document.querySelector('[data-mobile-font-setting]').append(container)
      const root = reactDom.createRoot(container)
      root.render(react.createElement(primitives.MarkdownText, {
        text: 'Mobile typography preview.\n\n```js\nconst localFont = true;\n```',
        labels: { code: { copyLabel: 'Copy', copiedLabel: 'Copied' }, footnotes: 'Footnotes' },
      }))
      window.__settingsMarkdownRoot = root
    })
    await page.locator('[data-settings-font-proof] pre code').waitFor({ state: 'visible' })
    const renderedFonts = () => page.locator('[data-settings-font-proof]').evaluate(node => {
      const paragraph = getComputedStyle(node.querySelector('p'))
      const code = getComputedStyle(node.querySelector('pre code'))
      return { textSize: paragraph.fontSize, textFamily: paragraph.fontFamily, codeSize: code.fontSize, codeFamily: code.fontFamily }
    })
    const typographySupport = await page.locator('[data-settings-font-proof]').evaluate(node => {
      // Check the mounted primitives rather than trusting the plugin's own capability flags.
      const style = document.body.style
      const inputs = ['--dsh-code-font-size', '--dsh-font-family-text', '--dsh-font-family-code']
      const previous = inputs.map(property => ({ property, value: style.getPropertyValue(property), priority: style.getPropertyPriority(property) }))
      try {
        style.setProperty(inputs[0], '23px')
        style.setProperty(inputs[1], '"Mounted Fixture Text"')
        style.setProperty(inputs[2], '"Mounted Fixture Code"')
        return {
          codeSize: getComputedStyle(node.querySelector('pre code')).fontSize === '23px',
          textFamily: getComputedStyle(node.querySelector('p')).fontFamily.includes('Mounted Fixture Text'),
          codeFamily: getComputedStyle(node.querySelector('pre code')).fontFamily.includes('Mounted Fixture Code'),
        }
      } finally {
        for (const { property, value, priority } of previous) {
          if (value === '') style.removeProperty(property)
          else style.setProperty(property, value, priority)
        }
      }
    })
    const text = row.locator('[data-mobile-font-role="text"]')
    assert.equal(await text.locator('output').textContent(), '20px', 'Legacy font size did not migrate on a real mounted page')
    const hasAdvanced = Object.values(typographySupport).some(Boolean)
    assert.equal(await row.locator('details').count(), hasAdvanced ? 1 : 0, 'Advanced options do not match real theme support')
    if (hasAdvanced) assert.equal(await row.locator('details').getAttribute('open'), null, 'Advanced typography should start collapsed')
    assert.equal(await row.locator('[data-mobile-font-limited]').count(), Object.values(typographySupport).every(Boolean) ? 0 : 1)
    assert.equal(await row.locator('[data-mobile-font-role="code"]').count(), typographySupport.codeSize ? 1 : 0)
    for (const role of ['text', 'code']) assert.equal(await row.locator(`[data-mobile-font-family="${role}"]`).count(), typographySupport[`${role}Family`] ? 1 : 0)
    await touchTarget(page, text.getByRole('button').first(), 'Text decrease')
    await text.getByRole('button').first().click()
    await page.waitForFunction(() => document.body.style.getPropertyValue('--dsh-content-font-size') === '19px')
    assert.equal((await renderedFonts()).textSize, '19px', 'Actual Markdown body did not consume the mobile text size')
    if (hasAdvanced) await row.locator('summary').click()
    for (const [role, initial] of typographySupport.codeSize ? [['code', 11]] : []) {
      const controls = row.locator(`[data-mobile-font-role="${role}"]`)
      assert.equal(await controls.locator('output').textContent(), `${initial}px`)
      await touchTarget(page, controls.getByRole('button').last(), `${role} increase`)
      await controls.getByRole('button').last().click()
      await page.waitForFunction(({ role, expected }) => document.body.style.getPropertyValue(`--dsh-${role}-font-size`) === expected,
        { role, expected: `${initial + 1}px` })
    }
    assert.equal((await renderedFonts()).codeSize, typographySupport.codeSize ? '12px' : '11px', 'Actual Markdown code block does not match supported settings')
    for (const role of ['text', 'code'].filter(role => typographySupport[`${role}Family`])) {
      const input = row.locator(`[data-mobile-font-family="${role}"]`)
      await touchTarget(page, input, `${role} font input`)
      await input.fill('Local Fixture Font, monospace')
      await input.evaluate(node => { node.blur() })
      await page.waitForFunction(role => document.body.style.getPropertyValue(`--dsh-font-family-${role}`) === '"Local Fixture Font", monospace', role)
    }
    const changedFonts = await renderedFonts()
    assert.equal(changedFonts.textFamily.includes('Local Fixture Font'), typographySupport.textFamily, 'Actual Markdown body does not match supported text family')
    assert.equal(changedFonts.codeFamily.includes('Local Fixture Font'), typographySupport.codeFamily, 'Actual Markdown code block does not match supported code family')
    const persisted = await page.evaluate(() => JSON.parse(localStorage.getItem('dsh-mobile.typography.v1')))
    assert.deepEqual(persisted.sizes, { text: 19, code: typographySupport.codeSize ? 12 : 11 })
    assert.equal(persisted.families.code, typographySupport.codeFamily ? '"Local Fixture Font", monospace' : '')
    const reset = row.locator('[data-mobile-font-reset]')
    await touchTarget(page, reset, 'Restore font defaults')
    await reset.click()
    await page.waitForFunction(() => document.body.style.getPropertyValue('--dsh-content-font-size') === '16px')
    if (typographySupport.codeSize) assert.equal(await page.evaluate(() => document.body.style.getPropertyValue('--dsh-code-font-size')), '11px')
    for (const role of ['text', 'code'].filter(role => typographySupport[`${role}Family`])) {
      await page.waitForFunction(role => document.querySelector(`[data-mobile-font-family="${role}"]`)?.value === '', role)
      assert.equal(await row.locator(`[data-mobile-font-family="${role}"]`).inputValue(), '')
    }
    const restoredFonts = await renderedFonts()
    assert.equal(restoredFonts.textSize, '16px')
    assert.equal(restoredFonts.codeSize, '11px')
    assert(!restoredFonts.textFamily.includes('Local Fixture Font') && !restoredFonts.codeFamily.includes('Local Fixture Font'))
    assert.equal(await page.evaluate(() => localStorage.getItem('dsh-mobile.content-font-size.v1')), '16')

    if (width === 375 && Object.values(typographySupport).every(Boolean)) {
      await row.locator('[data-mobile-font-role="code"]').getByRole('button').last().click()
      for (const role of ['text', 'code']) {
        const input = row.locator(`[data-mobile-font-family="${role}"]`)
        await input.fill('Retained Fixture Font')
        await input.evaluate(node => { node.blur() })
      }
      const beforeThemeChange = await page.evaluate(() => localStorage.getItem('dsh-mobile.typography.v1'))
      await page.evaluate(() => {
        window.__settingsThemeRetainedDocument = true
        const sheet = document.createElement('style')
        sheet.dataset.settingsFixedTypography = 'true'
        sheet.textContent = 'body { --dsw-font-markdown-code-block:11px/19px monospace; --dsw-font-markdown-base:var(--dsh-content-font-size,14px)/24px sans-serif; }'
        document.head.append(sheet)
      })
      await row.locator('details').waitFor({ state: 'hidden' })
      assert.equal(await page.evaluate(() => localStorage.getItem('dsh-mobile.typography.v1')), beforeThemeChange, 'Theme capability withdrawal erased saved preferences')
      await reset.click()
      assert.equal(await page.evaluate(() => localStorage.getItem('dsh-mobile.typography.v1')), beforeThemeChange, 'Reset erased hidden unsupported preferences')
      await page.evaluate(() => { document.querySelector('[data-settings-fixed-typography]').remove() })
      await row.locator('details').waitFor({ state: 'visible' })
      await row.locator('summary').click()
      assert.equal(await row.locator('[data-mobile-font-role="code"] output').textContent(), '12px', 'Supported theme did not resume retained code size')
      assert.equal((await renderedFonts()).codeSize, '12px')
      assert((await renderedFonts()).textFamily.includes('Retained Fixture Font') && (await renderedFonts()).codeFamily.includes('Retained Fixture Font'))
      assert.equal(await page.evaluate(() => window.__settingsThemeRetainedDocument), true, 'Theme capability update replaced the DSH document')
      await reset.click()
      await page.waitForFunction(() => document.body.style.getPropertyValue('--dsh-code-font-size') === '11px')
    }

    const scale = page.locator('[data-mobile-display-scale-setting]')
    if (bridgeMode !== 'scale-app') {
      assert.equal(await scale.count(), 0, `${bridgeMode} exposes an unsupported native scale control`)
      if (bridgeMode === 'old-app') assert.deepEqual(await page.evaluate(() => window.__settingsScaleFixture.calls), [])
    } else {
      await scale.locator('select').waitFor({ state: 'visible', timeout: CLIENT_TIMEOUT_MS })
      await touchTarget(page, scale.locator('select'), 'Page scale selector')
      for (const percent of [80, 125]) {
        await scale.locator('select').selectOption(String(percent))
        await page.waitForFunction(percent => window.__settingsScaleFixture.percent === percent, percent)
        await scale.locator('select:not(:disabled)').waitFor()
        assert.equal(await scale.locator('select').inputValue(), String(percent))
      }
      const resetScale = scale.getByRole('button').last()
      await touchTarget(page, resetScale, 'Reset page scale')
      await resetScale.click()
      await page.waitForFunction(() => window.__settingsScaleFixture.percent === 100)
      await page.waitForFunction(() => document.querySelector('[data-mobile-display-scale-setting] select')?.value === '100')
      await page.evaluate(() => { window.__settingsScaleFixture.failNextSet = true })
      await scale.locator('select').selectOption('80')
      await scale.getByRole('button').last().waitFor({ state: 'visible' })
      await page.waitForFunction(() => document.querySelector('[data-mobile-display-scale-setting] select:not(:disabled)')?.value === '100')
      assert.equal(await page.evaluate(() => window.__settingsScaleFixture.percent), 100)
      await scale.getByRole('button').last().click()
      await page.waitForFunction(() => document.querySelector('[data-mobile-display-scale-setting] select:not(:disabled)')?.value === '100'
        && document.querySelector('[data-mobile-display-scale-setting] button')?.disabled === true)
    }
    const geometry = await page.evaluate(() => ({ viewport: innerWidth, body: document.body.scrollWidth, root: document.documentElement.scrollWidth,
      language: document.documentElement.lang, fontRowLanguage: document.querySelector('[data-mobile-font-setting]')?.getAttribute('lang') }))
    assert(geometry.body <= geometry.viewport + 1 && geometry.root <= geometry.viewport + 1, `Settings overflow ${JSON.stringify(geometry)}`)
    assert.equal(settingsWrites.length, 0, `Local settings wrote Host preferences: ${settingsWrites.join(', ')}`)
    assert.deepEqual(errors, [], 'Settings generated unhandled page errors')
    await page.evaluate(() => { window.__settingsMarkdownRoot.unmount() })
    await page.evaluate(() => { window.__settingsRetainedDocument = 'retain settings navigation' })
    await close.click()
    await row.waitFor({ state: 'hidden' })
    assert.equal(await page.evaluate(() => window.__settingsRetainedDocument), 'retain settings navigation', 'Closing settings replaced the DSH document')
    await page.locator('.dshm-main').waitFor({ state: 'visible' })
    cases.push({ width, height, locale, bridgeMode, language: geometry.fontRowLanguage, typographySupport })
  } finally { await context.close() }
}

let desktop
try {
  const tarball = process.env.DSH_SETTINGS_SMOKE_TARBALL === undefined ? await packBundle(mobileRoot, root) : resolve(process.env.DSH_SETTINGS_SMOKE_TARBALL)
  tarballSha256 = createHash('sha256').update(await readFile(tarball)).digest('hex')
  const home = await createMobileProfile(root, { tarball, dshBin, packageStoreDirectory: join(root, 'package-store') })
  dsh = launchDsh(root, home, dshBin)
  browser = await chromium.launch({ headless: true })
  desktop = await browser.newPage({ locale: 'en-US' })
  await openPairing(desktop, await dsh.ready(), dsh.logs)
  for (const width of [320, 288]) {
    for (const [locale, bridgeMode] of [['en-US', 'browser'], ['zh-CN', 'old-app'], ['it-IT', 'scale-app']]) await runCase({ width, locale, bridgeMode })
  }
  await runCase({ width: 375, height: 812, locale: 'en-US', bridgeMode: 'browser' })
  await runCase({ width: 844, height: 393, locale: 'zh-CN', bridgeMode: 'scale-app' })
  console.log(JSON.stringify({ passed: cases.length, tarballSha256, cases, nativeScaleBridge: 'simulated; actual Android viewport reflow is device-tested separately',
    typography: 'real mounted React/DSH settings, local storage migration, role writes, reset, touch targets and no Host writes' }))
} catch (error) {
  failure = error
  throw error
} finally {
  await browser?.close()
  const stopped = await dsh?.close()
  await removeTemporaryRoot(root, prefix)
  if (failure === undefined && stopped?.forced) throw new Error('DSH settings fixture needed forced termination')
}
