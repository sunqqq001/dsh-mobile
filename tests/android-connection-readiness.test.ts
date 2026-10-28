import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import { describe, expect, it } from 'vitest'

const source = readFileSync(new URL('../apps/mobile/android/app/src/main/java/io/github/sayach/dshmobile/WebViewDocumentState.kt', import.meta.url), 'utf8')
const script = source.match(/INITIAL_DSH_READY_PROBE = """([\s\S]*?)"""\.trimIndent\(\)/u)?.[1]
if (script === undefined) throw new Error('Missing native initial-page readiness script')
const readinessScript: string = script

interface ElementOptions {
  hidden?: boolean
  inert?: boolean
  disabled?: boolean
  ariaDisabled?: boolean
  opacity?: string
  display?: string
  visibility?: string
  pointerEvents?: string
  width?: number
  height?: number
  left?: number
  top?: number
  parent?: ElementOptions
  covered?: boolean
}

let lastMeasured: object | null = null
function element(options: ElementOptions = {}): object {
  const parent = options.parent === undefined ? null : element(options.parent)
  const blocked = options.hidden === true || options.inert === true || options.parent?.hidden === true || options.parent?.inert === true
  const result = {
    style: { display: options.display ?? 'block', visibility: options.visibility ?? 'visible', opacity: options.opacity ?? '1', pointerEvents: options.pointerEvents ?? 'auto' },
    parentElement: parent,
    closest: (selector: string) => selector === '[aria-disabled="true"]' ? (options.parent?.ariaDisabled ? {} : null) : (blocked ? {} : null),
    matches: () => options.disabled === true,
    getAttribute: () => options.ariaDisabled ? 'true' : null,
    contains: (candidate: object) => candidate === result,
    getBoundingClientRect: () => {
      lastMeasured = options.covered ? {} : result
      return { width: options.width ?? 100, height: options.height ?? 48, left: options.left ?? 10, top: options.top ?? 10,
        right: (options.left ?? 10) + (options.width ?? 100), bottom: (options.top ?? 10) + (options.height ?? 48) }
    },
  }
  return result
}

function ready({ controls = [], boot = [], body = true, dedicated = false }: { controls?: object[]; boot?: object[]; body?: boolean; dedicated?: boolean }): boolean {
  const root = { querySelectorAll: () => controls }
  return vm.runInNewContext(readinessScript, {
    document: { body: body ? root : null, getElementById: () => root, querySelectorAll: () => boot, elementFromPoint: () => lastMeasured },
    window: dedicated ? { __DSH_MOBILE_FRONTEND__: 'dedicated' } : {},
    innerWidth: 390, innerHeight: 844,
    getComputedStyle: (node: { style: object }) => node.style,
  }) as boolean
}

describe('Android initial connection readiness', () => {
  it.each([false, true])('accepts usable controls without a layout class (dedicated=%s)', dedicated => {
    expect(ready({ controls: [element()], dedicated })).toBe(true)
  })

  it('rejects an absent body, empty root and visible boot error even if it offers Retry', () => {
    expect(ready({ body: false, controls: [element()] })).toBe(false)
    expect(ready({ controls: [] })).toBe(false)
    expect(ready({ controls: [element()], boot: [element()] })).toBe(false)
    expect(ready({ controls: [element()], boot: [element({ display: 'none' })] })).toBe(true)
  })

  it.each<ElementOptions>([
    { hidden: true }, { inert: true }, { disabled: true }, { ariaDisabled: true },
    { display: 'none' }, { visibility: 'hidden' }, { visibility: 'collapse' },
    { opacity: '0' }, { parent: { opacity: '0' } }, { parent: { hidden: true } }, { parent: { ariaDisabled: true } },
    { pointerEvents: 'none' }, { width: 0 }, { height: 0 }, { left: 500 }, { top: 1000 }, { left: -200 }, { top: -100 }, { covered: true },
  ])('rejects noninteractive or nonvisible content: %j', options => {
    expect(ready({ controls: [element(options)] })).toBe(false)
  })

  it('does not let one disabled control hide another usable page action', () => {
    expect(ready({ controls: [element({ disabled: true }), element()] })).toBe(true)
  })
})
