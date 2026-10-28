/** Missing cancellation APIs for browsers with native AbortController support. */

type SourceListeners = Map<AbortSignal, EventListener>
type SignalGetter<T> = (this: AbortSignal) => T

/** Preserve supplied reasons on engines whose native cancellation has no reason getter. */
function installAbortReason(aborted: SignalGetter<boolean>): SignalGetter<unknown> {
  const nativeReason = Object.getOwnPropertyDescriptor(AbortSignal.prototype, 'reason')?.get
  if (nativeReason !== undefined) return nativeReason
  const signal = Object.getOwnPropertyDescriptor(AbortController.prototype, 'signal')?.get
  if (signal === undefined) throw new TypeError('AbortController signal getter is unavailable')
  const reasons = new WeakMap<AbortSignal, unknown>()
  const defaultReason = (): DOMException => new DOMException('This operation was aborted', 'AbortError')
  const reason: SignalGetter<unknown> = function () {
    if (!aborted.call(this)) return undefined
    // Old signals cancelled before installation did not retain a custom reason.
    if (!reasons.has(this)) reasons.set(this, defaultReason())
    return reasons.get(this)
  }
  const nativeAbort = AbortController.prototype.abort
  Object.defineProperty(AbortController.prototype, 'abort', {
    configurable: true, enumerable: true, writable: true,
    value: function abort(this: AbortController, supplied: unknown = undefined): void {
      const target: AbortSignal = signal.call(this)
      if (!aborted.call(target)) reasons.set(target, supplied === undefined ? defaultReason() : supplied)
      nativeAbort.call(this, supplied)
    },
  })
  const nativeStaticAbort = AbortSignal.abort
  if (typeof nativeStaticAbort === 'function') {
    Object.defineProperty(AbortSignal, 'abort', {
      configurable: true, enumerable: true, writable: true,
      value: function abort(supplied: unknown = undefined): AbortSignal {
        const target = nativeStaticAbort(supplied)
        reasons.set(target, supplied === undefined ? defaultReason() : supplied)
        return target
      },
    })
  }
  Object.defineProperty(AbortSignal.prototype, 'reason', { configurable: true, enumerable: true, get: reason })
  return reason
}

/** Fill missing cancellation checks before DSH starts, retaining native implementations. */
export function installAbortSignalCompatibility(): void {
  if (typeof AbortSignal === 'undefined' || typeof AbortController === 'undefined') return
  const aborted = Object.getOwnPropertyDescriptor(AbortSignal.prototype, 'aborted')?.get
  if (aborted === undefined) throw new TypeError('AbortSignal aborted getter is unavailable')
  const reason = installAbortReason(aborted)
  if (typeof AbortSignal.prototype.throwIfAborted !== 'function') {
    Object.defineProperty(AbortSignal.prototype, 'throwIfAborted', {
      configurable: true, enumerable: true, writable: true,
      value: function throwIfAborted(this: AbortSignal): void {
        if (aborted.call(this)) throw reason.call(this)
      },
    })
  }
  installAbortSignalAny()
}

/** Release source subscriptions without retaining their combined signal. */
function detachSources(listeners: SourceListeners): void {
  for (const [source, listener] of listeners) source.removeEventListener('abort', listener)
  listeners.clear()
}

/** Older engines without weak references retain subscriptions until cancellation. */
function signalReference(signal: AbortSignal): { deref(): AbortSignal | undefined } {
  return typeof WeakRef === 'function' ? new WeakRef(signal) : { deref: () => signal }
}

/**
 * Install signal composition without replacing a native implementation.
 *
 * Inputs are validated with the native AbortSignal getter, including signals from
 * another frame. Listeners remain until a source really aborts; a synthetic event
 * does not cancel the result or consume its subscription.
 */
export function installAbortSignalAny(): void {
  if (typeof AbortSignal === 'undefined' || typeof AbortController === 'undefined' || typeof AbortSignal.any === 'function') return
  const aborted = Object.getOwnPropertyDescriptor(AbortSignal.prototype, 'aborted')?.get
  const reason = Object.getOwnPropertyDescriptor(AbortSignal.prototype, 'reason')?.get
  if (aborted === undefined || reason === undefined) throw new TypeError('AbortSignal getters are unavailable')
  // A live output retains its controller through this weak key. Source listeners
  // and finalizer values contain only a weak reference to that output.
  const controllers = new WeakMap<AbortSignal, AbortController>()
  const finalizer = typeof FinalizationRegistry === 'function'
    ? new FinalizationRegistry<SourceListeners>(detachSources) : undefined
  const listenerFor = (
    source: AbortSignal, reference: { deref(): AbortSignal | undefined }, listeners: SourceListeners,
  ): EventListener => () => {
    const result = reference.deref()
    if (result === undefined) {
      detachSources(listeners)
      return
    }
    if (!aborted.call(source)) return
    const controller = controllers.get(result)!
    detachSources(listeners)
    finalizer?.unregister(listeners)
    controller.abort(reason.call(source))
  }
  Object.defineProperty(AbortSignal, 'any', {
    configurable: true,
    writable: true,
    value: function any(signals: Iterable<AbortSignal>): AbortSignal {
      if (signals == null || typeof signals[Symbol.iterator] !== 'function') throw new TypeError('AbortSignal.any requires an iterable')
      const sources: AbortSignal[] = []
      // WebIDL converts the complete sequence before selecting an aborted input.
      for (const source of signals) {
        aborted.call(source)
        sources.push(source)
      }
      const controller = new AbortController()
      for (const source of sources) {
        if (aborted.call(source)) {
          controller.abort(reason.call(source))
          return controller.signal
        }
      }
      const listeners: SourceListeners = new Map()
      const reference = signalReference(controller.signal)
      controllers.set(controller.signal, controller)
      if (typeof WeakRef === 'function') finalizer?.register(controller.signal, listeners, listeners)
      for (const source of sources) {
        if (listeners.has(source)) continue
        const listener = listenerFor(source, reference, listeners)
        listeners.set(source, listener)
        source.addEventListener('abort', listener)
      }
      return controller.signal
    },
  })
}
