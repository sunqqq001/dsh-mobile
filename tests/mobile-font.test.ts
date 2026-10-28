import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_MOBILE_FONT_SIZE, MOBILE_FONT_STORAGE_KEY, MOBILE_TYPOGRAPHY_STORAGE_KEY,
  MobileFontPreference, installMobileFontPreference, normalizeMobileFontFamily, parseMobileFontSize } from '../src/mobile-font.js'
import { readMobileTypographyCapabilities, type MobileTypographyCapabilities } from '../src/mobile-font-capabilities.js'

afterEach(() => { vi.unstubAllGlobals() })

describe('mobile font preference', () => {
  it('defaults locally instead of inheriting a Host preference', () => {
    expect(new MobileFontPreference(null).getSnapshot()).toBe(16)
    for (const value of [null, '', '20px', '-1', '33', '11', '16.5', 'Infinity']) expect(parseMobileFontSize(value)).toBe(DEFAULT_MOBILE_FONT_SIZE)
    expect(parseMobileFontSize('20')).toBe(20)
  })

  it('persists local changes and restores them without Host RPCs', () => {
    const values = new Map<string, string>()
    const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value) } }
    const preference = new MobileFontPreference(storage)
    const listener = vi.fn()
    const unsubscribe = preference.subscribe(listener)
    preference.set(20)
    expect(values.get(MOBILE_FONT_STORAGE_KEY)).toBe('20')
    expect(new MobileFontPreference(storage).getSnapshot()).toBe(20)
    expect(listener).toHaveBeenCalledTimes(1)
    preference.set(20)
    expect(listener).toHaveBeenCalledTimes(1)
    unsubscribe()
    preference.set(18)
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('keeps controls usable when storage is denied', () => {
    const storage = { getItem: () => { throw new Error('denied') }, setItem: () => { throw new Error('quota') } }
    const preference = new MobileFontPreference(storage)
    expect(preference.getSnapshot()).toBe(16)
    preference.set(22)
    expect(preference.getSnapshot()).toBe(22)
  })

  it('rejects malformed sizes without changing the saved preference', () => {
    const preference = new MobileFontPreference(null)
    for (const size of [11, 33, 16.5, NaN, Infinity]) expect(() => preference.set(size)).toThrow(RangeError)
    expect(preference.getSnapshot()).toBe(16)
  })

  it('migrates the legacy mobile text size while adding an independent code default', () => {
    const values = new Map([[MOBILE_FONT_STORAGE_KEY, '22']])
    const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value) } }
    const preference = new MobileFontPreference(storage)
    expect(preference.getTypographySnapshot()).toEqual({ sizes: { text: 22, code: 11 }, families: { text: '', code: '' } })
    preference.setRoleSize('code', 17)
    preference.setRoleFamily('code', 'JetBrains Mono, monospace')
    expect(new MobileFontPreference(storage).getTypographySnapshot()).toEqual({
      sizes: { text: 22, code: 17 }, families: { text: '', code: '"JetBrains Mono", monospace' },
    })
    expect(values.get(MOBILE_FONT_STORAGE_KEY)).toBe('22')
  })

  it('keeps the last readable legacy size when the new JSON is corrupted or inaccessible', () => {
    for (const value of ['not-json', 'null', '[]', '{}', '{"sizes":null,"families":null}']) {
      const preference = new MobileFontPreference({ getItem: key => key === MOBILE_FONT_STORAGE_KEY ? '20' : value, setItem() {} })
      expect(preference.getTypographySnapshot()).toEqual({ sizes: { text: 20, code: 11 }, families: { text: '', code: '' } })
    }
    const preference = new MobileFontPreference({ getItem: key => {
      if (key === MOBILE_TYPOGRAPHY_STORAGE_KEY) throw new Error('denied')
      return '24'
    }, setItem() {} })
    expect(preference.getSnapshot()).toBe(24)
  })

  it('validates persisted roles independently without trusting arbitrary JSON fields', () => {
    const value = JSON.stringify({ sizes: { text: 100, code: 19, terminal: '20' }, families: { text: 42, code: '  Mono Font, monospace ', terminal: 'serif' }, injected: true })
    const preference = new MobileFontPreference({ getItem: key => key === MOBILE_FONT_STORAGE_KEY ? '18' : value, setItem() {} })
    expect(preference.getTypographySnapshot()).toEqual({ sizes: { text: 18, code: 19 }, families: { text: '', code: '"Mono Font", monospace' } })
    expect(Object.isFrozen(preference.getTypographySnapshot())).toBe(true)
    expect(Object.isFrozen(preference.getTypographySnapshot().sizes)).toBe(true)
    expect(Object.isFrozen(preference.getTypographySnapshot().families)).toBe(true)
  })

  it('normalizes existing font names and generic stacks idempotently with bounded input', () => {
    expect(normalizeMobileFontFamily(' "Noto Sans",\n monospace, , system-ui ')).toBe('"Noto Sans", monospace, system-ui')
    expect(normalizeMobileFontFamily('<>\\\u0000')).toBe('')
    expect(normalizeMobileFontFamily('x'.repeat(2048))).toHaveLength(1024)
    const long = normalizeMobileFontFamily('x'.repeat(2048))
    expect(normalizeMobileFontFamily(long)).toBe(long)
    const value = normalizeMobileFontFamily('Noto Sans SC, -apple-system, sans-serif')
    expect(normalizeMobileFontFamily(value)).toBe(value)
  })

  it('restores every local font role and keeps the legacy preference consistent', () => {
    const values = new Map<string, string>()
    const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value) } }
    const preference = new MobileFontPreference(storage)
    preference.set(24)
    preference.setRoleSize('code', 15)
    for (const role of ['text', 'code'] as const) preference.setRoleFamily(role, 'Custom Font')
    const listener = vi.fn()
    preference.subscribe(listener)
    preference.reset()
    expect(new MobileFontPreference(storage).getTypographySnapshot()).toEqual({ sizes: { text: 16, code: 11 }, families: { text: '', code: '' } })
    expect(values.get(MOBILE_FONT_STORAGE_KEY)).toBe('16')
    preference.reset()
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('rejects invalid code values while keeping available local controls responsive', () => {
    const preference = new MobileFontPreference({ getItem: () => null, setItem: () => { throw new Error('quota') } })
    for (const role of ['code'] as const) {
      for (const size of [9, 33, 12.5, NaN, Infinity]) expect(() => preference.setRoleSize(role, size)).toThrow(RangeError)
      preference.setRoleSize(role, 20)
      preference.setRoleFamily(role, 'monospace')
    }
    expect(preference.getTypographySnapshot()).toEqual({ sizes: { text: 16, code: 20 }, families: { text: '', code: 'monospace' } })
  })

  it('retains unsupported saved roles when resetting visible controls', () => {
    const preference = new MobileFontPreference(null)
    preference.set(24)
    preference.setRoleSize('code', 20)
    preference.setRoleFamily('text', 'Saved Text')
    preference.setRoleFamily('code', 'Saved Mono')
    preference.updateCapabilities({ codeSize: false, textFamily: true, codeFamily: false })
    preference.resetSupported()
    expect(preference.getTypographySnapshot()).toEqual({ sizes: { text: 16, code: 20 }, families: { text: '', code: '"Saved Mono"' } })
  })

  it('notifies capability subscribers only when actual support changes', () => {
    const preference = new MobileFontPreference(null)
    const listener = vi.fn()
    const unsubscribe = preference.subscribeCapabilities(listener)
    const supported = { codeSize: true, textFamily: true, codeFamily: true }
    preference.updateCapabilities(supported)
    preference.updateCapabilities({ ...supported })
    expect(listener).toHaveBeenCalledTimes(1)
    expect(Object.isFrozen(preference.getCapabilitiesSnapshot())).toBe(true)
    unsubscribe()
    preference.updateCapabilities({ codeSize: false, textFamily: true, codeFamily: true })
    expect(listener).toHaveBeenCalledTimes(1)
  })
})

function fontSurface(initial: Record<string, string>, capabilities: MobileTypographyCapabilities = { codeSize: true, textFamily: true, codeFamily: true }) {
  const supported = { ...capabilities }
  const values = new Map(Object.entries(initial).map(([property, value]) => [property, { value, priority: '' }]))
  const style = {
    get cssText() { return JSON.stringify([...values]) },
    getPropertyValue: (property: string) => values.get(property)?.value ?? '',
    getPropertyPriority: (property: string) => values.get(property)?.priority ?? '',
    setProperty: (property: string, value: string, priority = '') => { values.set(property, { value, priority }) },
    removeProperty: (property: string) => { const value = values.get(property)?.value ?? ''; values.delete(property); return value },
  }
  const disconnect = vi.fn()
  const observers: Array<(records: MutationRecord[]) => void> = []
  const observations: Array<{ target: object; options: MutationObserverInit; callback: (records: MutationRecord[]) => void }> = []
  const probes: Array<{ style: { cssText: string; font: string }; setAttribute: () => void; remove: () => void }> = []
  const body = { style, className: '', getAttribute: () => null, append() {} }
  const doc = { body, head: { addEventListener() {}, removeEventListener() {} }, documentElement: {}, createElement: () => {
    const probe = { style: { cssText: '', font: '' }, setAttribute() {}, remove: vi.fn() }
    probes.push(probe)
    return probe
  } }
  vi.stubGlobal('window', { localStorage: null })
  vi.stubGlobal('document', doc)
  vi.stubGlobal('getComputedStyle', (probe: typeof probes[number]) => {
    const code = probe.style.font.includes('code-block')
    return { fontSize: code && supported.codeSize ? style.getPropertyValue('--dsh-code-font-size') : code ? '11px' : '14px',
      fontFamily: code && supported.codeFamily ? style.getPropertyValue('--dsh-font-family-code')
        : !code && supported.textFamily ? style.getPropertyValue('--dsh-font-family-text') : 'Default Font' }
  })
  vi.stubGlobal('MutationObserver', class {
    constructor(private readonly callback: (records: MutationRecord[]) => void) { observers.push(callback) }
    observe(target: object, options: MutationObserverInit) { observations.push({ target, options, callback: this.callback }) }
    disconnect = disconnect
  })
  return { style, disconnect, probes, observations, doc, capabilities: supported, notify: () => { observers[0]?.([]) },
    notifyBodyTextMutation: () => {
      const interested = observations.filter(({ target, options }) => (target === body && options.childList)
        || (target === doc.documentElement && options.subtree && (options.childList || options.characterData)))
      for (const { callback } of interested) callback([])
      return interested.length
    } }
}

describe('mobile font presentation ownership', () => {
  it('projects text and code onto body while leaving native terminal settings intact', () => {
    const surface = fontSurface({ '--dsh-content-font-size': '14px', '--dsh-font-family-text': 'Host Font', '--dsh-terminal-font-size': '18px', '--dsh-font-family-terminal': 'Host Terminal', '--other-token': 'keep' })
    const local = installMobileFontPreference()
    try {
      expect(surface.style.getPropertyValue('--dsh-content-font-size')).toBe('16px')
      expect(surface.style.getPropertyValue('--dsh-code-font-size')).toBe('11px')
      expect(surface.style.getPropertyValue('--dsh-terminal-font-size')).toBe('18px')
      expect(surface.style.getPropertyValue('--dsh-font-family-terminal')).toBe('Host Terminal')
      expect(surface.style.getPropertyValue('--dsh-font-family-text')).toBe('')
      local.preference.setRoleSize('code', 18)
      local.preference.setRoleFamily('code', 'Local Mono')
      expect(surface.style.getPropertyValue('--dsh-code-font-size')).toBe('18px')
      expect(surface.style.getPropertyValue('--dsh-font-family-code')).toBe('"Local Mono"')
      expect(surface.style.getPropertyValue('--other-token')).toBe('keep')
    } finally { local.dispose() }
    expect(surface.style.getPropertyValue('--dsh-content-font-size')).toBe('14px')
    expect(surface.style.getPropertyValue('--dsh-font-family-text')).toBe('Host Font')
    expect(surface.style.getPropertyValue('--dsh-code-font-size')).toBe('')
    expect(surface.disconnect).toHaveBeenCalledTimes(2)
  })

  it('retains mobile values through Host presentation updates and restores the latest foreign values on dispose', () => {
    const surface = fontSurface({ '--dsh-content-font-size': '14px' })
    const local = installMobileFontPreference()
    local.preference.set(22)
    surface.style.setProperty('--dsh-content-font-size', '18px', 'important')
    surface.style.setProperty('--dsh-font-family-code', 'Host Mono')
    surface.notify()
    expect(surface.style.getPropertyValue('--dsh-content-font-size')).toBe('22px')
    expect(surface.style.getPropertyValue('--dsh-font-family-code')).toBe('')
    local.dispose()
    expect(surface.style.getPropertyValue('--dsh-content-font-size')).toBe('18px')
    expect(surface.style.getPropertyPriority('--dsh-content-font-size')).toBe('important')
    expect(surface.style.getPropertyValue('--dsh-font-family-code')).toBe('Host Mono')
    local.preference.set(24)
    expect(surface.style.getPropertyValue('--dsh-content-font-size')).toBe('18px')
  })

  it('leaves a newer foreign write intact when disposal precedes observer delivery', () => {
    const surface = fontSurface({ '--dsh-content-font-size': '14px' })
    const local = installMobileFontPreference()
    surface.style.setProperty('--dsh-content-font-size', '19px')
    surface.style.setProperty('--dsh-font-family-terminal', 'Foreign Mono')
    local.dispose()
    expect(surface.style.getPropertyValue('--dsh-content-font-size')).toBe('19px')
    expect(surface.style.getPropertyValue('--dsh-font-family-terminal')).toBe('Foreign Mono')
  })

  it('tracks a foreign priority change even when the font value matches the local value', () => {
    const surface = fontSurface({ '--dsh-content-font-size': '14px' })
    const local = installMobileFontPreference()
    surface.style.setProperty('--dsh-content-font-size', '16px', 'important')
    surface.notify()
    expect(surface.style.getPropertyPriority('--dsh-content-font-size')).toBe('')
    local.dispose()
    expect(surface.style.getPropertyValue('--dsh-content-font-size')).toBe('16px')
    expect(surface.style.getPropertyPriority('--dsh-content-font-size')).toBe('important')
  })

  it('does not claim theme support from unused custom properties or project unsupported preferences', () => {
    const surface = fontSurface({ '--dsh-code-font-size': '17px', '--dsh-font-family-code': 'Unused Mono' },
      { codeSize: false, textFamily: false, codeFamily: false })
    const local = installMobileFontPreference()
    local.preference.setRoleSize('code', 23)
    local.preference.setRoleFamily('code', 'Saved Mono')
    expect(local.preference.getCapabilitiesSnapshot()).toEqual({ codeSize: false, textFamily: false, codeFamily: false })
    expect(surface.style.getPropertyValue('--dsh-code-font-size')).toBe('17px')
    expect(surface.style.getPropertyValue('--dsh-font-family-code')).toBe('Unused Mono')
    expect(surface.style.getPropertyValue('--dsh-content-font-size')).toBe('16px')
    local.dispose()
  })

  it('detects each consumer independently and restores every probe input', () => {
    const surface = fontSurface({ '--dsh-code-font-size': '17px', '--dsh-font-family-text': 'Host Font' },
      { codeSize: true, textFamily: false, codeFamily: true })
    expect(readMobileTypographyCapabilities(document)).toEqual({ codeSize: true, textFamily: false, codeFamily: true })
    expect(surface.style.getPropertyValue('--dsh-code-font-size')).toBe('17px')
    expect(surface.style.getPropertyValue('--dsh-font-family-text')).toBe('Host Font')
    expect(surface.style.getPropertyValue('--dsh-font-family-code')).toBe('')
    for (const probe of surface.probes) expect(probe.remove).toHaveBeenCalledOnce()
  })

  it('restores temporary inputs and removes probes when style sampling fails', () => {
    const surface = fontSurface({ '--dsh-code-font-size': '17px' })
    surface.style.setProperty('--dsh-code-font-size', '17px', 'important')
    vi.stubGlobal('getComputedStyle', () => { throw new Error('Style sampling interrupted') })
    expect(() => readMobileTypographyCapabilities(document)).toThrow('Style sampling interrupted')
    expect(surface.style.getPropertyValue('--dsh-code-font-size')).toBe('17px')
    expect(surface.style.getPropertyPriority('--dsh-code-font-size')).toBe('important')
    expect(surface.style.getPropertyValue('--dsh-font-family-code')).toBe('')
    for (const probe of surface.probes) expect(probe.remove).toHaveBeenCalledOnce()
  })

  it('withdraws unsupported projections and resumes retained values when the active theme changes', () => {
    const surface = fontSurface({ '--dsh-code-font-size': '14px', '--dsh-font-family-code': 'Host Mono' })
    const local = installMobileFontPreference()
    local.preference.setRoleSize('code', 20)
    local.preference.setRoleFamily('code', 'Saved Mono')
    surface.capabilities.codeSize = false
    surface.capabilities.codeFamily = false
    surface.style.setProperty('--theme-change', 'old-theme')
    surface.notify()
    expect(surface.style.getPropertyValue('--dsh-code-font-size')).toBe('14px')
    expect(surface.style.getPropertyValue('--dsh-font-family-code')).toBe('Host Mono')
    expect(local.preference.getTypographySnapshot().sizes.code).toBe(20)
    surface.capabilities.codeSize = true
    surface.capabilities.codeFamily = true
    surface.style.setProperty('--theme-change', 'supported-theme')
    surface.notify()
    expect(surface.style.getPropertyValue('--dsh-code-font-size')).toBe('20px')
    expect(surface.style.getPropertyValue('--dsh-font-family-code')).toBe('"Saved Mono"')
    local.dispose()
  })

  it('does not repeat synchronous probes in response to their own style mutations', () => {
    const surface = fontSurface({})
    const local = installMobileFontPreference()
    expect(surface.probes).toHaveLength(2)
    surface.notify()
    surface.notify()
    expect(surface.probes).toHaveLength(2)
    local.preference.set(20)
    surface.notify()
    expect(surface.probes).toHaveLength(2)
    local.dispose()
  })

  it('does not observe conversation text mutations or scan the body subtree for stylesheets', () => {
    const surface = fontSurface({})
    const local = installMobileFontPreference()
    expect(surface.observations.map(({ target }) => target)).toEqual([surface.doc.body, surface.doc.head])
    expect(surface.observations[0]?.options).toEqual({ attributes: true, attributeFilter: ['style', 'class', 'data-ds-dark-theme'] })
    expect(surface.observations[1]?.options).toEqual({ subtree: true, childList: true, characterData: true, attributes: true,
      attributeFilter: ['href', 'media', 'disabled', 'rel'] })
    for (let chunk = 0; chunk < 100; chunk++) expect(surface.notifyBodyTextMutation()).toBe(0)
    expect(surface.probes).toHaveLength(2)
    local.dispose()
  })

  it('preserves an unsupported foreign write before newly acquiring that property', () => {
    const surface = fontSurface({ '--dsh-code-font-size': '14px' }, { codeSize: false, textFamily: false, codeFamily: false })
    const local = installMobileFontPreference()
    local.preference.setRoleSize('code', 20)
    surface.style.setProperty('--dsh-code-font-size', '18px', 'important')
    surface.capabilities.codeSize = true
    surface.notify()
    expect(surface.style.getPropertyValue('--dsh-code-font-size')).toBe('20px')
    local.dispose()
    expect(surface.style.getPropertyValue('--dsh-code-font-size')).toBe('18px')
    expect(surface.style.getPropertyPriority('--dsh-code-font-size')).toBe('important')
  })
})
