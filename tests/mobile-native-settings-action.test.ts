import { describe, expect, it, vi } from 'vitest'
import {
  MobileNativeSettingsActionController,
  type MobileNativeSettingsAction,
  type MobileNativeSettingsBridge,
} from '../src/mobile-native-settings-action.js'

const actions = ['mobile.switch-computer', 'notification.settings'] as const

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((accept, fail) => { resolve = accept; reject = fail })
  return { promise, resolve, reject }
}

async function flush() {
  for (let turn = 0; turn < 8; turn++) await Promise.resolve()
}

function native(action: MobileNativeSettingsAction,
  invoke: MobileNativeSettingsBridge['invoke'] = vi.fn(async () => ({ ok: true }))) {
  return { capabilities: vi.fn(() => [action]), invoke }
}

describe.each(actions)('native setting action %s', action => {
  it('hides browser and unsupported controls without sending a request', async () => {
    let bridge: MobileNativeSettingsBridge | undefined
    const controller = new MobileNativeSettingsActionController(action, () => bridge)
    controller.start()
    controller.invoke()
    await flush()
    expect(controller.getSnapshot()).toEqual({ supported: false, state: 'idle' })
    const unsupported = { capabilities: vi.fn(() => []), invoke: vi.fn() }
    bridge = unsupported
    controller.refresh()
    await flush()
    controller.invoke()
    expect(unsupported.invoke).not.toHaveBeenCalled()
    controller.stop()
  })

  it('sets busy synchronously and blocks repeated taps until the reply', async () => {
    const response = deferred<unknown>()
    const bridge = native(action, vi.fn(() => response.promise))
    const controller = new MobileNativeSettingsActionController(action, () => bridge)
    controller.start()
    await flush()
    controller.invoke()
    controller.invoke()
    expect(controller.getSnapshot()).toEqual({ supported: true, state: 'busy' })
    await flush()
    expect(bridge.invoke).toHaveBeenCalledExactlyOnceWith(action, {})
    response.resolve({ ok: true })
    await flush()
    expect(controller.getSnapshot()).toEqual({ supported: true, state: 'success' })
    controller.stop()
  })

  it('retains a pending call across repeated readiness events for the same bridge', async () => {
    const response = deferred<unknown>()
    const bridge = native(action, vi.fn(() => response.promise))
    const controller = new MobileNativeSettingsActionController(action, () => bridge)
    controller.start()
    await flush()
    controller.invoke()
    await flush()
    controller.refresh()
    await flush()
    expect(controller.getSnapshot()).toEqual({ supported: true, state: 'busy' })
    controller.invoke()
    expect(bridge.invoke).toHaveBeenCalledTimes(1)
    response.resolve({ ok: true })
    await flush()
    expect(controller.getSnapshot().state).toBe('success')
    controller.stop()
  })

  it('exposes current native rejection for an explicit retry, without replay', async () => {
    const response = deferred<unknown>()
    const invoke = vi.fn<MobileNativeSettingsBridge['invoke']>()
      .mockImplementationOnce(() => response.promise)
      .mockResolvedValue({ ok: true })
    const bridge = native(action, invoke)
    const controller = new MobileNativeSettingsActionController(action, () => bridge)
    controller.start()
    await flush()
    controller.invoke()
    await flush()
    response.reject(Object.assign(new Error('native capability timed out'), { code: 'timeout' }))
    await flush()
    expect(controller.getSnapshot()).toEqual({ supported: true, state: 'error' })
    expect(invoke).toHaveBeenCalledTimes(1)
    controller.refresh()
    await flush()
    expect(controller.getSnapshot().state).toBe('error')
    expect(invoke).toHaveBeenCalledTimes(1)
    controller.invoke()
    await flush()
    expect(controller.getSnapshot().state).toBe('success')
    expect(invoke).toHaveBeenCalledTimes(2)
    controller.stop()
  })

  it('ignores a replaced adapter capability result', async () => {
    const capability = deferred<readonly string[]>()
    const old = { capabilities: () => capability.promise, invoke: vi.fn() }
    const next = { capabilities: () => [], invoke: vi.fn() }
    let bridge: MobileNativeSettingsBridge = old
    const controller = new MobileNativeSettingsActionController(action, () => bridge)
    controller.start()
    await flush()
    bridge = next
    controller.refresh()
    await flush()
    capability.resolve([action])
    await flush()
    expect(controller.getSnapshot()).toEqual({ supported: false, state: 'idle' })
    controller.invoke()
    expect(old.invoke).not.toHaveBeenCalled()
    expect(next.invoke).not.toHaveBeenCalled()
    controller.stop()
  })

  it('accepts only the latest capability probe for the same bridge', async () => {
    const oldProbe = deferred<readonly string[]>()
    const bridge = { capabilities: vi.fn().mockImplementationOnce(() => oldProbe.promise).mockResolvedValue([action]), invoke: vi.fn() }
    const controller = new MobileNativeSettingsActionController(action, () => bridge)
    controller.start()
    await flush()
    controller.refresh()
    await flush()
    expect(controller.getSnapshot().supported).toBe(true)
    oldProbe.reject(new Error('old discovery failed'))
    await flush()
    expect(controller.getSnapshot().supported).toBe(true)
    controller.stop()
  })

  it.each(['success', 'failure'] as const)('ignores replaced adapter late %s', async result => {
    const response = deferred<unknown>()
    const old = native(action, vi.fn(() => response.promise))
    const next = native(action)
    let bridge: MobileNativeSettingsBridge = old
    const controller = new MobileNativeSettingsActionController(action, () => bridge)
    controller.start()
    await flush()
    controller.invoke()
    await flush()
    bridge = next
    controller.refresh()
    await flush()
    expect(next.invoke).not.toHaveBeenCalled()
    controller.invoke()
    await flush()
    expect(controller.getSnapshot().state).toBe('success')
    if (result === 'success') response.resolve({ ok: true })
    else response.reject(new Error('old invocation failed'))
    await flush()
    expect(controller.getSnapshot()).toEqual({ supported: true, state: 'success' })
    expect(next.invoke).toHaveBeenCalledTimes(1)
    controller.stop()
  })

  it('does not dispatch queued work after disposal or a bridge replacement', async () => {
    const old = native(action)
    let bridge: MobileNativeSettingsBridge | undefined = old
    const controller = new MobileNativeSettingsActionController(action, () => bridge)
    controller.start()
    await flush()
    controller.invoke()
    controller.stop()
    await flush()
    expect(old.invoke).not.toHaveBeenCalled()
    controller.start()
    await flush()
    controller.invoke()
    bridge = undefined
    await flush()
    expect(old.invoke).not.toHaveBeenCalled()
    controller.refresh()
    expect(controller.getSnapshot().supported).toBe(false)
    controller.stop()
    controller.start()
    expect(controller.getSnapshot().supported).toBe(false)
    controller.stop()
  })

  it('does not publish an old result after unmount and a new mount', async () => {
    const response = deferred<unknown>()
    const invoke = vi.fn<MobileNativeSettingsBridge['invoke']>()
      .mockImplementationOnce(() => response.promise).mockResolvedValue({ ok: true })
    const bridge = native(action, invoke)
    const controller = new MobileNativeSettingsActionController(action, () => bridge)
    const changed = vi.fn()
    controller.subscribe(changed)
    controller.start()
    await flush()
    controller.invoke()
    await flush()
    controller.stop()
    const stoppedCount = changed.mock.calls.length
    response.reject(new Error('disposed action failed'))
    await flush()
    expect(changed).toHaveBeenCalledTimes(stoppedCount)
    controller.start()
    await flush()
    expect(controller.getSnapshot()).toEqual({ supported: true, state: 'idle' })
    controller.invoke()
    await flush()
    expect(controller.getSnapshot().state).toBe('success')
    controller.stop()
  })

  it('keeps a new mount pending when the previous mount replies late on the same bridge', async () => {
    const oldResponse = deferred<unknown>()
    const newResponse = deferred<unknown>()
    const invoke = vi.fn<MobileNativeSettingsBridge['invoke']>()
      .mockImplementationOnce(() => oldResponse.promise).mockImplementationOnce(() => newResponse.promise)
    const bridge = native(action, invoke)
    const controller = new MobileNativeSettingsActionController(action, () => bridge)
    controller.start()
    await flush()
    controller.invoke()
    await flush()
    controller.stop()
    controller.start()
    await flush()
    controller.invoke()
    await flush()
    oldResponse.reject(new Error('previous mount failed'))
    await flush()
    expect(controller.getSnapshot().state).toBe('busy')
    newResponse.resolve({ ok: true })
    await flush()
    expect(controller.getSnapshot().state).toBe('success')
    expect(invoke).toHaveBeenCalledTimes(2)
    controller.stop()
  })

  it('withdraws an invocation result when the capability is no longer advertised', async () => {
    const response = deferred<unknown>()
    const bridge = { capabilities: vi.fn().mockReturnValueOnce([action]).mockReturnValue([]), invoke: vi.fn(() => response.promise) }
    const controller = new MobileNativeSettingsActionController(action, () => bridge)
    controller.start()
    await flush()
    controller.invoke()
    await flush()
    controller.refresh()
    await flush()
    response.resolve({ ok: true })
    await flush()
    expect(controller.getSnapshot()).toEqual({ supported: false, state: 'idle' })
    expect(bridge.invoke).toHaveBeenCalledTimes(1)
    controller.stop()
  })

  it('permits notification reopen but keeps an accepted computer switch single-use', async () => {
    const bridge = native(action)
    const controller = new MobileNativeSettingsActionController(action, () => bridge)
    controller.start()
    await flush()
    controller.invoke()
    await flush()
    controller.invoke()
    await flush()
    expect(bridge.invoke).toHaveBeenCalledTimes(action === 'notification.settings' ? 2 : 1)
    expect(controller.getSnapshot().state).toBe('success')
    controller.stop()
  })
})
