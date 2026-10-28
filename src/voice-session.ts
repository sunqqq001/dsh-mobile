/** Screen wake-lock ownership and mobile composer focus during DSH dictation. */

/** Voice phases during which the user is dictating. */
const DICTATING_PHASES: readonly string[] = ['requesting', 'recording', 'transcribing']

/** Whether DSH's published voice phase requires an active dictation surface. */
export function phaseIsDictating(phase: string | null | undefined): boolean {
  return typeof phase === 'string' && DICTATING_PHASES.includes(phase)
}

/** The subset of the Screen Wake Lock API this uses. */
interface WakeLockSentinel {
  released: boolean
  release(): Promise<void>
  addEventListener(type: 'release', listener: () => void): void
}

/** The wake lock API, or undefined where the browser does not offer it. */
function wakeLockApi(): { request(type: 'screen'): Promise<WakeLockSentinel> } | undefined {
  const api = (navigator as Navigator & {
    wakeLock?: { request(type: 'screen'): Promise<WakeLockSentinel> }
  }).wakeLock
  return api === undefined ? undefined : api
}

/**
 * Hold an available screen wake lock while DSH dictation is active and visible.
 * @param allowKeyboardDismissal Whether a mobile composer may lose text focus when capture starts.
 * @returns A disposer that releases held and subsequently returned wake locks.
 */
export function installVoiceSession(allowKeyboardDismissal = true): () => void {
  const api = wakeLockApi()
  if (api === undefined && !allowKeyboardDismissal) return () => {}
  let sentinel: WakeLockSentinel | null = null
  let pending = false
  let disposed = false
  let generation = 0
  let lastRow: HTMLElement | null = null
  let lastVisible = !document.hidden

  const currentRow = (): HTMLElement | null =>
    Array.from(document.querySelectorAll<HTMLElement>('[data-voice-activity]'))
      .find(row => phaseIsDictating(row.getAttribute('data-voice-activity'))) ?? null

  const releaseLock = (lock: WakeLockSentinel): void => {
    if (!lock.released) void lock.release().catch((_error) => {
      // The browser also releases the sentinel when its document becomes hidden.
    })
  }

  const release = (): void => {
    const held = sentinel
    sentinel = null
    if (held !== null) releaseLock(held)
  }

  const acquireIfWanted = (): void => {
    if (api === undefined || disposed || pending || sentinel !== null || document.hidden) return
    const row = currentRow()
    if (row === null) return
    const requestedGeneration = generation
    pending = true
    void api.request('screen').then((lock) => {
      lock.addEventListener('release', () => { if (sentinel === lock) sentinel = null })
      if (disposed || document.hidden || requestedGeneration !== generation || currentRow() !== row) releaseLock(lock)
      else if (!lock.released) sentinel = lock
    }, (_error) => {
      // Low battery and browser policy can refuse a screen wake lock.
    }).finally(() => {
      pending = false
      // A new visible capture may have started while the old request was pending.
      // Unrelated DOM updates never retry a refused request.
      if (!disposed && requestedGeneration !== generation) acquireIfWanted()
    })
  }

  const dismissKeyboard = (row: HTMLElement): void => {
    if (!allowKeyboardDismissal) return
    const mobileKeyboard = window.__DSH_MOBILE_NATIVE__ !== undefined
      ? window.__DSH_MOBILE_KEYBOARD_STATE__?.noHardwareKeyboard === true
      : window.matchMedia('(pointer:coarse) and (hover:none)').matches
    if (!mobileKeyboard) return
    const active = document.activeElement
    const composer = row.closest('[data-composer-card]')
    if (active instanceof HTMLElement && composer?.contains(active)
      && active.closest('[data-composer-input]') !== null
      && (active.isContentEditable || active instanceof HTMLTextAreaElement || active instanceof HTMLInputElement)) active.blur()
  }

  const apply = (): void => {
    const row = currentRow()
    const visible = !document.hidden
    const changed = row !== lastRow || visible !== lastVisible
    if (changed) {
      generation++
      release()
      if (row !== null && row !== lastRow && visible) dismissKeyboard(row)
    }
    lastRow = row
    lastVisible = visible
    if (changed) acquireIfWanted()
  }

  const containsVoiceRow = (node: Node): boolean => node instanceof Element
    && (node.matches('[data-voice-activity]') || node.querySelector('[data-voice-activity]') !== null)
  const observer = new MutationObserver(records => {
    if (records.some(record => record.type === 'attributes'
      || [...record.addedNodes, ...record.removedNodes].some(containsVoiceRow))) apply()
  })
  observer.observe(document.documentElement, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ['data-voice-activity'],
  })

  const onVisibility = (): void => { apply() }
  document.addEventListener('visibilitychange', onVisibility)

  apply()

  return () => {
    disposed = true
    generation++
    observer.disconnect()
    document.removeEventListener('visibilitychange', onVisibility)
    release()
  }
}
