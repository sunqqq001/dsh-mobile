import { afterEach, describe, expect, it, vi } from 'vitest'
import { installMobileBootFeedback } from '../src/mobile-boot-feedback.js'

class BootNode extends EventTarget {
  readonly attributes = new Map<string, string>()
  readonly children: BootNode[] = []
  className = ''
  id = ''
  type = ''
  get nonce(): string { return this.attributes.get('nonce') ?? '' }
  private text = ''
  parent: BootNode | undefined
  constructor(readonly tagName: string) { super() }
  get childElementCount(): number { return this.children.length }
  get textContent(): string { return this.text + this.children.map(child => child.textContent).join('') }
  set textContent(value: string) { this.text = value }
  setAttribute(name: string, value: string): void { this.attributes.set(name, value) }
  getAttribute(name: string): string | null { return this.attributes.get(name) ?? null }
  hasAttribute(name: string): boolean { return this.attributes.has(name) }
  append(...nodes: BootNode[]): void { for (const node of nodes) { this.children.push(node); node.parent = this } }
  remove(): void {
    const at = this.parent?.children.indexOf(this) ?? -1
    if (at >= 0) this.parent?.children.splice(at, 1)
    this.parent = undefined
  }
}

class BootDocument extends EventTarget {
  readonly documentElement = Object.assign(new BootNode('HTML'), { lang: 'en' })
  readonly body = new BootNode('BODY')
  readonly head = new BootNode('HEAD')
  readonly root = new BootNode('DIV')
  readonly currentScript = new BootNode('SCRIPT')
  constructor(readonly marked: boolean) { super(); this.body.append(this.root); this.currentScript.setAttribute('nonce', 'existing-csp-nonce') }
  querySelector(selector: string): BootNode | null { return this.marked && selector.startsWith('meta[') ? this.head : null }
  getElementById(id: string): BootNode | null { return id === 'root' ? this.root : null }
  createElement(tag: string): BootNode { return new BootNode(tag.toUpperCase()) }
}

class BootView extends EventTarget {
  readonly setTimeout = globalThis.setTimeout
  readonly clearTimeout = globalThis.clearTimeout
  readonly location = { reload: vi.fn() }
}

class BootObserver {
  static instances: BootObserver[] = []
  readonly disconnect = vi.fn()
  readonly observe = vi.fn()
  constructor(readonly callback: () => void) { BootObserver.instances.push(this) }
}

class BootErrorEvent extends Event {
  constructor(readonly error: unknown, readonly message: string) { super('error') }
}

const cleanups: Array<() => void> = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

function environment(options: { marked?: boolean; language?: string } = {}) {
  vi.useFakeTimers()
  BootObserver.instances = []
  const page = new BootDocument(options.marked ?? true)
  const view = new BootView()
  vi.stubGlobal('window', view)
  vi.stubGlobal('document', page)
  vi.stubGlobal('navigator', { languages: [options.language ?? 'en'], language: options.language ?? 'en' })
  vi.stubGlobal('MutationObserver', BootObserver)
  vi.stubGlobal('ErrorEvent', BootErrorEvent)
  const notice = (): BootNode | undefined => page.body.children.find(node => node.hasAttribute('data-dsh-mobile-boot-failure'))
  const start = (): void => { cleanups.push(installMobileBootFeedback()) }
  return { page, view, notice, start }
}

describe('Gateway pre-render boot feedback', () => {
  it('does not attach to ordinary DSH/preview documents or classify the UA as a hard failure', () => {
    const { view, notice, start } = environment({ marked: false })
    start()
    view.dispatchEvent(new BootErrorEvent(new SyntaxError('private script'), 'https://host/?token=private'))
    vi.advanceTimersByTime(30_000)
    expect(notice()).toBeUndefined()
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each([
    ['zh-CN', 'DSH 未能启动', '重新载入页面'],
    ['en-US', 'DSH could not start', 'Reload page'],
    ['it-IT', 'Impossibile avviare DSH', 'Ricarica pagina'],
  ])('shows %s syntax feedback without disclosing error text, URL, stack or credentials', (language, title, retry) => {
    const { page, view, notice, start } = environment({ language })
    start()
    view.dispatchEvent(new BootErrorEvent(new SyntaxError('secret-token private/path'), 'https://private/?token=secret-token'))
    const card = notice()
    expect(card?.getAttribute('data-dsh-mobile-boot-failure')).toBe('syntax_error')
    expect(card?.getAttribute('role')).toBe('alert')
    expect(card?.textContent).toContain(title)
    expect(card?.textContent).toContain(retry)
    expect(card?.textContent).not.toMatch(/secret-token|private|https:/u)
    expect(page.head.children[0]?.getAttribute('nonce')).toBe('existing-csp-nonce')
    expect(page.root.children).toHaveLength(0)
    expect(page.documentElement.attributes.has('data-dsh-boot')).toBe(false)
    expect(view.location.reload).not.toHaveBeenCalled()
  })

  it('retains the first bounded failure and ignores unrelated link/image errors', () => {
    const { view, notice, start } = environment()
    start()
    const imageFailure = new Event('error')
    Object.defineProperty(imageFailure, 'target', { value: new BootNode('IMG') })
    view.dispatchEvent(imageFailure)
    expect(notice()).toBeUndefined()
    const scriptFailure = new Event('error')
    Object.defineProperty(scriptFailure, 'target', { value: new BootNode('SCRIPT') })
    view.dispatchEvent(scriptFailure)
    view.dispatchEvent(new BootErrorEvent(new TypeError('private'), 'private'))
    expect(notice()?.getAttribute('data-dsh-mobile-boot-failure')).toBe('script_load_failed')
  })

  it('retains a head-script failure until the parser creates the application mount point', () => {
    const { page, view, notice, start } = environment()
    let rootReady = false
    vi.spyOn(page, 'getElementById').mockImplementation(() => rootReady ? page.root : null)
    start()
    view.dispatchEvent(new BootErrorEvent(new SyntaxError('private early script'), 'private'))
    expect(notice()).toBeUndefined()
    rootReady = true
    page.dispatchEvent(new Event('DOMContentLoaded'))
    expect(notice()?.getAttribute('data-dsh-mobile-boot-failure')).toBe('syntax_error')
  })

  it('keeps business errors, an existing loader and the mounted page under DSH ownership', () => {
    const { page, view, notice, start } = environment()
    const loader = new BootNode('DIV')
    loader.setAttribute('data-dsh-boot', '')
    page.root.append(loader)
    start()
    view.dispatchEvent(new BootErrorEvent(new TypeError('unrelated'), 'unrelated'))
    view.dispatchEvent(new Event('unhandledrejection'))
    vi.advanceTimersByTime(30_000)
    expect(notice()).toBeUndefined()
    expect(page.root.children).toEqual([loader])
    expect(vi.getTimerCount()).toBe(0)
  })

  it('shows a nonfatal stalled notice only while the mount point remains empty', () => {
    const { view, notice, start } = environment()
    start()
    vi.advanceTimersByTime(11_999)
    expect(notice()).toBeUndefined()
    vi.advanceTimersByTime(1)
    expect(notice()?.getAttribute('data-dsh-mobile-boot-failure')).toBe('startup_stalled')
    expect(view.location.reload).not.toHaveBeenCalled()
  })

  it('removes the notice and listeners when the current page subsequently renders', () => {
    const { page, view, notice, start } = environment()
    start()
    view.dispatchEvent(new Event('unhandledrejection'))
    expect(notice()?.getAttribute('data-dsh-mobile-boot-failure')).toBe('promise_rejected')
    const application = new BootNode('MAIN')
    page.root.append(application)
    BootObserver.instances[0]?.callback()
    expect(notice()).toBeUndefined()
    expect(page.head.children).toHaveLength(0)
    expect(page.root.children).toEqual([application])
    expect(BootObserver.instances[0]?.disconnect).toHaveBeenCalledOnce()
    view.dispatchEvent(new BootErrorEvent(new TypeError('business failure'), 'private'))
    vi.advanceTimersByTime(30_000)
    expect(notice()).toBeUndefined()
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each(['retry', 'dismiss', 'pagehide'] as const)('cleans up on %s without automatic navigation or deleting state', action => {
    const { page, view, notice, start } = environment()
    start()
    start()
    view.dispatchEvent(new BootErrorEvent(new Error('private'), 'private'))
    expect(page.body.children).toHaveLength(2)
    const actions = notice()?.children.find(child => child.className === 'dsh-mobile-boot-feedback__actions')?.children ?? []
    if (action === 'pagehide') view.dispatchEvent(new Event('pagehide'))
    else actions[action === 'retry' ? 0 : 1]?.dispatchEvent(new Event('click'))
    expect(view.location.reload).toHaveBeenCalledTimes(action === 'retry' ? 1 : 0)
    expect(notice()).toBeUndefined()
    expect(page.head.children).toHaveLength(0)
    expect(vi.getTimerCount()).toBe(0)
    view.dispatchEvent(new BootErrorEvent(new Error('late'), 'late'))
    expect(notice()).toBeUndefined()
  })
})
