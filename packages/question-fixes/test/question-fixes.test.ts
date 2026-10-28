import { describe, expect, it } from 'vitest'
import { apply, questionEnterUsesNewline, type QuestionEnterEvent } from '../src/client.js'

function enter(overrides: Partial<QuestionEnterEvent> = {}): QuestionEnterEvent {
  return {
    key: 'Enter', keyCode: 13, defaultPrevented: false, isComposing: false,
    shiftKey: false, ctrlKey: false, altKey: false, metaKey: false,
    ...overrides,
  }
}

describe('question answer keyboard behavior', () => {
  const touchBrowser = { touchPrimary: true, nativeBridge: false }
  it('uses the native Enter newline only on touch-first devices', () => {
    expect(questionEnterUsesNewline(enter(), touchBrowser)).toBe(true)
    expect(questionEnterUsesNewline(enter(), { touchPrimary: false, nativeBridge: false })).toBe(false)
  })

  it('preserves a physical App keyboard and waits for a known soft keyboard state', () => {
    const app = { touchPrimary: true, nativeBridge: true }
    expect(questionEnterUsesNewline(enter(), app)).toBe(false)
    expect(questionEnterUsesNewline(enter(), { ...app, nativeState: { imeVisible: true, noHardwareKeyboard: false } })).toBe(false)
    expect(questionEnterUsesNewline(enter(), { ...app, nativeState: { imeVisible: false, noHardwareKeyboard: true } })).toBe(false)
    expect(questionEnterUsesNewline(enter(), { ...app, nativeState: { imeVisible: true, noHardwareKeyboard: true } })).toBe(true)
  })

  it.each(['shiftKey', 'ctrlKey', 'altKey', 'metaKey'] as const)('preserves the %s shortcut', modifier => {
    expect(questionEnterUsesNewline(enter({ [modifier]: true }), touchBrowser)).toBe(false)
  })

  it('preserves IME composition including Android keyCode 229', () => {
    expect(questionEnterUsesNewline(enter({ isComposing: true }), touchBrowser)).toBe(false)
    expect(questionEnterUsesNewline(enter({ keyCode: 229 }), touchBrowser)).toBe(false)
  })

  it('leaves other keys and already-handled events alone', () => {
    expect(questionEnterUsesNewline(enter({ key: 'Escape' }), touchBrowser)).toBe(false)
    expect(questionEnterUsesNewline(enter({ defaultPrevented: true }), touchBrowser)).toBe(false)
  })

  it('defers browser installation to the component effect', () => {
    const effects: Array<() => void | (() => void)> = []
    apply({ effect: effect => { effects.push(effect) } })
    expect(effects).toHaveLength(1)
  })
})
