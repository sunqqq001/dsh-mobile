import { afterEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { BROWSER_FILE_PICKER_DEADLINE_MS, pickBrowserFiles, type BrowserFilePickerEnvironment, type BrowserFilePickerInput } from '../src/browser-file-picker.js'

class OwnedPickerInput extends EventTarget implements BrowserFilePickerInput {
  type = ''
  accept = ''
  capture = ''
  multiple = false
  hidden = false
  files: readonly File[] | null = null
}

function fixture() {
  const input = new OwnedPickerInput()
  const open = vi.fn()
  const remove = vi.fn()
  const source = vi.fn(() => ({ input, open, remove }))
  const environment: BrowserFilePickerEnvironment = {
    createSource: source,
    deadline: (callback, milliseconds) => {
      const timer = setTimeout(callback, milliseconds)
      return () => { clearTimeout(timer) }
    },
  }
  const controller = new AbortController()
  return { input, open, remove, source, environment, controller }
}

describe('browser file selection lifetime', () => {
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals() })

  it('opens synchronously with MIME/capture flags and accepts a late change after focus returns', async () => {
    vi.useFakeTimers()
    const owned = fixture()
    const view = new EventTarget(), page = Object.assign(new EventTarget(), { visibilityState: 'visible' })
    vi.stubGlobal('window', view); vi.stubGlobal('document', page)
    const removed = vi.spyOn(owned.input, 'removeEventListener')
    const abortRemoved = vi.spyOn(owned.controller.signal, 'removeEventListener')
    const pending = pickBrowserFiles({ signal: owned.controller.signal, accept: 'image/*', capture: 'environment', multiple: true }, owned.environment)
    expect(owned.open).toHaveBeenCalledTimes(1)
    expect(owned.input).toMatchObject({ type: 'file', accept: 'image/*', capture: 'environment', multiple: true, hidden: true })
    view.dispatchEvent(new Event('focus'))
    page.dispatchEvent(new Event('visibilitychange'))
    await vi.advanceTimersByTimeAsync(5_000)
    expect(owned.remove).not.toHaveBeenCalled()
    const first = new File(['first'], 'first.png', { type: 'image/png' })
    const second = new File(['second'], 'second.jpg', { type: 'image/jpeg' })
    owned.input.files = [first, second]
    owned.input.dispatchEvent(new Event('change'))
    await expect(pending).resolves.toEqual([first, second])
    expect(owned.remove).toHaveBeenCalledTimes(1)
    expect(removed).toHaveBeenCalledWith('change', expect.any(Function))
    expect(removed).toHaveBeenCalledWith('cancel', expect.any(Function))
    expect(abortRemoved).toHaveBeenCalledWith('abort', expect.any(Function))
    expect(vi.getTimerCount()).toBe(0)
    owned.input.dispatchEvent(new Event('change')); owned.controller.abort()
    expect(owned.remove).toHaveBeenCalledTimes(1)
  })

  it('settles explicit cancel and empty change quietly without a later result', async () => {
    vi.useFakeTimers()
    for (const event of ['cancel', 'change']) {
      const owned = fixture()
      const pending = pickBrowserFiles({ signal: owned.controller.signal, accept: '*/*' }, owned.environment)
      owned.input.dispatchEvent(new Event(event))
      await expect(pending).resolves.toBeUndefined()
      owned.input.files = [new File(['late'], 'late.png', { type: 'image/png' })]
      owned.input.dispatchEvent(new Event('change'))
      expect(owned.remove).toHaveBeenCalledTimes(1)
      expect(vi.getTimerCount()).toBe(0)
    }
  })

  it('keeps the five-minute deadline, then cancels without calling selection success', async () => {
    vi.useFakeTimers()
    const owned = fixture()
    const settled = vi.fn()
    const pending = pickBrowserFiles({ signal: owned.controller.signal, accept: 'image/*' }, owned.environment).then(settled)
    await vi.advanceTimersByTimeAsync(BROWSER_FILE_PICKER_DEADLINE_MS - 1)
    expect(settled).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    await pending
    expect(settled).toHaveBeenCalledWith(undefined)
    expect(owned.remove).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('leaves capture absent for ordinary file selection and writes it only for camera requests', async () => {
    vi.useFakeTimers()
    for (const capture of [undefined, 'environment']) {
      const owned = fixture()
      const assign = vi.fn((value: string) => { void value })
      Object.defineProperty(owned.input, 'capture', { get: () => '', set: assign })
      const pending = pickBrowserFiles({ signal: owned.controller.signal, accept: 'image/*', ...(capture === undefined ? {} : { capture }) }, owned.environment)
      if (capture === undefined) expect(assign).not.toHaveBeenCalled()
      else expect(assign).toHaveBeenCalledExactlyOnceWith('environment')
      owned.input.dispatchEvent(new Event('cancel'))
      await expect(pending).resolves.toBeUndefined()
    }
    expect(vi.getTimerCount()).toBe(0)
  })

  it('rejects disposal using the caller reason and removes the input immediately', async () => {
    vi.useFakeTimers()
    const owned = fixture()
    const reason = new Error('Owned extension disposed')
    const pending = pickBrowserFiles({ signal: owned.controller.signal, accept: '*/*' }, owned.environment)
    const rejected = expect(pending).rejects.toBe(reason)
    owned.controller.abort(reason)
    await rejected
    expect(owned.remove).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
    const inactive = fixture(); inactive.controller.abort(reason)
    await expect(pickBrowserFiles({ signal: inactive.controller.signal, accept: '*/*' }, inactive.environment)).rejects.toBe(reason)
    expect(inactive.source).not.toHaveBeenCalled()
  })

  it('retains SDK cancellation reasons and reports a failed open after releasing resources', async () => {
    vi.useFakeTimers()
    const owned = fixture()
    const pending = pickBrowserFiles({ signal: owned.controller.signal, accept: '*/*', abortReason: () => 'sdk-disposed' }, owned.environment)
    const rejected = expect(pending).rejects.toBe('sdk-disposed')
    owned.controller.abort(); await rejected
    const blocked = fixture()
    const failure = new Error('Camera cannot open')
    blocked.open.mockImplementation(() => { throw failure })
    await expect(pickBrowserFiles({ signal: blocked.controller.signal, accept: 'image/*' }, blocked.environment)).rejects.toBe(failure)
    expect(blocked.remove).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('cleans acquired inputs when setup or deadline registration fails', async () => {
    vi.useFakeTimers()
    const failure = new Error('Owned setup failure')
    const missing = fixture(); missing.source.mockImplementation(() => { throw failure })
    await expect(pickBrowserFiles({ signal: missing.controller.signal, accept: '*/*' }, missing.environment)).rejects.toBe(failure)
    expect(missing.open).not.toHaveBeenCalled()
    const setter = fixture()
    Object.defineProperty(setter.input, 'accept', { set: () => { throw failure } })
    await expect(pickBrowserFiles({ signal: setter.controller.signal, accept: '*/*' }, setter.environment)).rejects.toBe(failure)
    expect(setter.remove).toHaveBeenCalledTimes(1)
    expect(setter.open).not.toHaveBeenCalled()
    const timer = fixture()
    await expect(pickBrowserFiles({ signal: timer.controller.signal, accept: '*/*' }, { ...timer.environment, deadline: () => { throw failure } })).rejects.toBe(failure)
    expect(timer.remove).toHaveBeenCalledTimes(1)
    expect(timer.open).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('settles even if removal fails without reporting unconfirmed cleanup as cancellation success', async () => {
    vi.useFakeTimers()
    const cleanupFailure = new Error('Owned input removal failure')
    const selected = fixture(); selected.remove.mockImplementation(() => { throw cleanupFailure })
    const pending = pickBrowserFiles({ signal: selected.controller.signal, accept: 'image/*' }, selected.environment)
    const rejected = expect(pending).rejects.toBe(cleanupFailure)
    selected.input.files = [new File(['image'], 'image.png', { type: 'image/png' })]
    selected.input.dispatchEvent(new Event('change')); await rejected
    expect(vi.getTimerCount()).toBe(0)
    const aborted = fixture(); aborted.remove.mockImplementation(() => { throw cleanupFailure })
    const reason = new Error('Owned caller disposed')
    const aborting = pickBrowserFiles({ signal: aborted.controller.signal, accept: '*/*' }, aborted.environment)
    const abortRejected = expect(aborting).rejects.toBe(reason)
    aborted.controller.abort(reason); await abortRejected
    const cancelled = fixture(); cancelled.remove.mockImplementation(() => { throw cleanupFailure })
    const cancelling = pickBrowserFiles({ signal: cancelled.controller.signal, accept: '*/*' }, cancelled.environment)
    const cancelRejected = expect(cancelling).rejects.toBe(cleanupFailure)
    cancelled.input.dispatchEvent(new Event('cancel'))
    await cancelRejected
    expect(vi.getTimerCount()).toBe(0)
  })

  it('keeps the camera and first-file SDK wrappers on the same chooser lifetime', () => {
    const native = readFileSync(new URL('../src/native-mobile.ts', import.meta.url), 'utf8')
    const client = readFileSync(new URL('../src/client.ts', import.meta.url), 'utf8')
    expect(native).toContain("pickBrowserFiles({ accept: 'image/*', capture: 'environment', signal: mediaPickerAbortController.signal })")
    const start = client.indexOf("if (action === 'files.pick' || action === 'camera.capture')")
    const end = client.indexOf("throw new Error('native capability is unavailable')", start)
    const sdk = client.slice(start, end)
    expect(sdk).toContain('return pickBrowserFiles(')
    expect(sdk).toContain('abortReason }).then(files => files?.[0])')
    expect(sdk).not.toContain('scheduleCancel')
    expect(sdk).not.toContain('visibilitychange')
    expect(sdk).not.toContain('new Promise')
  })
})
