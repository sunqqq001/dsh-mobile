import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

const mobileRoot = process.env.DSH_BOOT_SMOKE_MOBILE_ROOT === undefined
  ? fileURLToPath(new URL('..', import.meta.url)) : resolve(process.env.DSH_BOOT_SMOKE_MOBILE_ROOT)
const require = createRequire(join(mobileRoot, 'package.json'))
const client = await readFile(require.resolve('dsh-mobile-question-fixes/client'), 'utf8')
const longQuestion = 'Please review this detailed deployment question before choosing an answer. '.repeat(45)
const card = id => `<div data-question-key="question:${id}"><section class="card" id="card-${id}" aria-labelledby="title-${id}">
  <header><h2 id="title-${id}">${longQuestion}</h2><button aria-expanded="true" aria-label="Minimize">−</button></header>
  <div data-question-scroll>${'<button class="option">A detailed answer option</button>'.repeat(6)}
    <label>Custom answer<textarea id="answer-${id}"></textarea></label></div>
  <footer id="footer-${id}"><button>Skip</button><button>Continue</button></footer>
</section></div>`

// These rules reproduce the stock flex-height failure and the dedicated mobile
// layout's body cap. The actual DSH boot test checks component assembly separately.
const fixture = mobile => `<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><style>
  *{box-sizing:border-box}body{margin:0;font:16px/1.4 system-ui}
  [data-question-key]{padding:8px}.card{display:flex;flex-direction:column;width:100%;max-height:min(60vh,520px);overflow:hidden;border:1px solid}
  header{display:flex;flex-shrink:0;gap:8px;padding:12px}h2{font:500 16px/22px system-ui;margin:0}
  [data-question-scroll]{flex:1 1 auto;min-height:0;overflow:auto;padding:8px}
  .option{display:block;width:100%;min-height:64px}textarea{display:block;width:100%;height:84px}
  footer{display:flex;flex:0 0 auto;gap:8px;padding:8px}button{min-height:44px}
  .minimized{max-height:none}.mobile .card{max-height:min(68dvh,520px)!important}
  .mobile [data-question-scroll]{flex:0 1 auto!important;max-height:min(42dvh,360px)!important}
  #composer{position:sticky;bottom:0}
</style></head><body class="${mobile ? 'mobile' : ''}"><main id="root">${card(1)}${card(2)}
<div id="composer" data-composer-seat>Composer</div><textarea id="outside"></textarea></main></body></html>`

const browser = await chromium.launch({ headless: true })
try {
  for (const device of [
    { viewport: { width: 980, height: 720 }, hasTouch: false, isMobile: false },
    { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true },
    { viewport: { width: 390, height: 320 }, hasTouch: true, isMobile: true },
  ]) {
    const context = await browser.newContext(device)
    try {
      const page = await context.newPage()
      await page.route('http://question-fixes.test/**', route => route.fulfill({ contentType: 'text/html', body: fixture(device.hasTouch) }))
      await page.goto('http://question-fixes.test/')
      await page.evaluate(() => {
        window.__ModuleLoader__ = { load: ({ factory }) => { window.fixes = factory(() => { throw new Error('Unexpected browser dependency') }) } }
        window.keyEvents = []
        window.submits = 0
        document.querySelector('#root').addEventListener('keydown', event => {
          if (event.key !== 'Enter') return
          window.keyEvents.push({ shift: event.shiftKey, composing: event.isComposing, keyCode: event.keyCode })
          if (!event.shiftKey && !event.ctrlKey && !event.altKey && !event.metaKey && !event.isComposing && event.keyCode !== 229) {
            event.preventDefault()
            window.submits++
          }
        })
        localStorage.setItem('unrelated-preference', 'keep')
      })
      await page.addScriptTag({ content: client })
      await page.evaluate(() => { window.disposeFixes = window.fixes.installQuestionFixes() })

      for (const id of [1, 2]) {
        const result = await page.evaluate(id => {
          const card = document.querySelector(`#card-${id}`)
          const body = card.querySelector('[data-question-scroll]')
          card.scrollTop = card.scrollHeight
          const bounds = card.getBoundingClientRect()
          const footer = card.querySelector('footer').getBoundingClientRect()
          const answer = card.querySelector('textarea').getBoundingClientRect()
          return {
            height: bounds.height, cap: parseFloat(getComputedStyle(card).maxHeight),
            scrollHeight: card.scrollHeight, clientHeight: card.clientHeight,
            bodyHeight: body.getBoundingClientRect().height,
            footerReachable: footer.top >= bounds.top && footer.bottom <= bounds.bottom,
            answerReachable: answer.top >= bounds.top && answer.bottom <= bounds.bottom,
          }
        }, id)
        assert(result.height <= result.cap + 1, `Card exceeds height cap: ${JSON.stringify(result)}`)
        assert(result.bodyHeight > 0 && result.scrollHeight > result.clientHeight, 'Long question has no usable scrollport')
        assert(result.footerReachable && result.answerReachable, 'Answer and footer cannot be reached together')
      }
      const composerPosition = await page.evaluate(() => getComputedStyle(document.querySelector('#composer')).position)
      assert.equal(composerPosition, 'sticky', 'Question component changed composer placement')

      await page.locator('#answer-1').fill('first')
      await page.keyboard.press('Enter')
      assert.equal(await page.locator('#answer-1').inputValue(), device.hasTouch ? 'first\n' : 'first')
      assert.equal(await page.evaluate(() => window.submits), device.hasTouch ? 0 : 1)
      const keysBefore = await page.evaluate(() => window.keyEvents.length)
      await page.keyboard.press('Shift+Enter')
      assert.equal(await page.evaluate(() => window.keyEvents.length), keysBefore + 1, 'Modified Enter was swallowed')
      await page.locator('#answer-1').evaluate(answer => {
        answer.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', isComposing: true, keyCode: 229, bubbles: true }))
      })
      assert.equal(await page.evaluate(() => window.keyEvents.at(-1).composing), true, 'IME event was swallowed')
      if (device.hasTouch) {
        await page.evaluate(() => {
          window.__DSH_MOBILE_NATIVE__ = {}
          window.__DSH_MOBILE_KEYBOARD_STATE__ = { imeVisible: true, noHardwareKeyboard: false }
        })
        await page.locator('#answer-1').fill('hardware')
        const appSubmits = await page.evaluate(() => window.submits)
        await page.keyboard.press('Enter')
        assert.equal(await page.evaluate(() => window.submits), appSubmits + 1, 'App hardware Enter was swallowed')
        await page.evaluate(() => { window.__DSH_MOBILE_KEYBOARD_STATE__ = { imeVisible: true, noHardwareKeyboard: true } })
        await page.locator('#answer-1').fill('soft')
        await page.keyboard.press('Enter')
        assert.equal(await page.locator('#answer-1').inputValue(), 'soft\n', 'App soft Enter did not insert a newline')
        await page.evaluate(() => { delete window.__DSH_MOBILE_NATIVE__; delete window.__DSH_MOBILE_KEYBOARD_STATE__ })
      }
      assert.deepEqual(await page.evaluate(() => Object.keys(localStorage)), ['unrelated-preference'], 'Answer draft was persisted')

      await page.evaluate(() => {
        const card = document.querySelector('#card-2')
        card.classList.add('minimized')
        card.querySelector('[aria-expanded]').setAttribute('aria-expanded', 'false')
        card.querySelector('[data-question-scroll]').remove()
        card.querySelector('footer').remove()
      })
      assert((await page.locator('#card-2').boundingBox()).height < 140, 'Minimized long question still fills the screen')
      await page.evaluate(() => { window.disposeFixes() })
      assert.equal(await page.locator('style[data-plugin="dsh-mobile-question-fixes"]').count(), 0)
      assert.equal(await page.locator('#card-1').evaluate(card => getComputedStyle(card).overflowY), 'hidden')
      assert((await page.locator('#card-2').boundingBox()).height > 140, 'Disabled component retained its title clamp')
      assert.equal(await page.evaluate(() => document.querySelector('[data-question-key] [style]') === null), true, 'Inline styles were left behind')
      await page.locator('#answer-1').fill('after disable')
      const submitsBefore = await page.evaluate(() => window.submits)
      await page.keyboard.press('Enter')
      assert.equal(await page.evaluate(() => window.submits), submitsBefore + 1, 'Disposal retained the keyboard interceptor')
    } finally { await context.close() }
  }
  console.log('Question-card scrolling, disposal, keyboard and draft privacy checks passed in 3 viewports')
} finally { await browser.close() }
