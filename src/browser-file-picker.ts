/** Browser chooser lifetime shared by camera controls and the extension SDK. */
export const BROWSER_FILE_PICKER_DEADLINE_MS = 300_000

/** The chooser consumes only file metadata and native selection events. */
export interface BrowserFilePickerInput extends EventTarget {
  type: string
  accept: string
  capture: string
  multiple: boolean
  hidden: boolean | string
  readonly files: Iterable<File> | null
}

/** One owned input; opening must remain synchronous with the user's action. */
export interface BrowserFilePickerSource {
  readonly input: BrowserFilePickerInput
  open(): void
  remove(): void
}

/** DOM and timer adapters keep tests independent of a real chooser or profile. */
export interface BrowserFilePickerEnvironment {
  createSource(): BrowserFilePickerSource
  deadline(callback: () => void, milliseconds: number): () => void
}

export interface BrowserFilePickerOptions {
  readonly signal: AbortSignal
  readonly accept: string
  readonly capture?: string
  readonly multiple?: boolean
  readonly abortReason?: () => unknown
}

const browserEnvironment: BrowserFilePickerEnvironment = {
  createSource: () => {
    const input = document.createElement('input')
    return { input, open: () => { document.body.append(input); input.click() }, remove: () => { input.remove() } }
  },
  deadline: (callback, milliseconds) => {
    const timer = window.setTimeout(callback, milliseconds)
    return () => { window.clearTimeout(timer) }
  },
}

/** Select files without treating focus/visibility restoration as cancellation.
 * @param options - MIME selection, lifetime and optional camera capture mode.
 * @param environment - Browser DOM and timer owner; tests may supply an owned source.
 * @returns Selected files, or undefined for explicit cancellation or deadline; abort rejects.
 */
export function pickBrowserFiles(options: BrowserFilePickerOptions, environment = browserEnvironment): Promise<readonly File[] | undefined> {
  const abortReason = (): unknown => options.abortReason?.() ?? options.signal.reason ?? new DOMException('File selection aborted', 'AbortError')
  if (options.signal.aborted) return Promise.reject(abortReason())
  return new Promise((resolve, reject) => {
    let source: BrowserFilePickerSource | undefined
    let input: BrowserFilePickerInput | undefined
    let settled = false
    let cancelDeadline: (() => void) | undefined
    const cleanup = (): readonly unknown[] => {
      const errors: unknown[] = []
      const attempt = (operation: () => void): void => { try { operation() } catch (error) { errors.push(error) } }
      if (cancelDeadline !== undefined) attempt(cancelDeadline)
      cancelDeadline = undefined
      attempt(() => { input?.removeEventListener('change', onChange) })
      attempt(() => { input?.removeEventListener('cancel', onCancel) })
      attempt(() => { options.signal.removeEventListener('abort', onAbort) })
      attempt(() => { source?.remove() })
      return errors
    }
    type Outcome = { readonly kind: 'files'; readonly files: readonly File[] } | { readonly kind: 'cancelled' } | { readonly kind: 'failed'; readonly error: unknown }
    const finish = (outcome: Outcome): void => {
      if (settled) return
      settled = true
      const cleanupErrors = cleanup()
      if (outcome.kind === 'failed') reject(outcome.error)
      else if (cleanupErrors.length > 0) reject(cleanupErrors[0])
      else if (outcome.kind === 'cancelled') resolve(undefined)
      else resolve(outcome.files)
    }
    const onChange = (): void => {
      if (settled || input === undefined) return
      try {
        const files = input.files === null ? [] : [...input.files]
        finish(files.length === 0 ? { kind: 'cancelled' } : { kind: 'files', files: Object.freeze(files) })
      } catch (error) { finish({ kind: 'failed', error }) }
    }
    const onCancel = (): void => { finish({ kind: 'cancelled' }) }
    const onAbort = (): void => { finish({ kind: 'failed', error: abortReason() }) }
    try {
      source = environment.createSource(); input = source.input
      input.type = 'file'; input.accept = options.accept
      if (options.capture !== undefined) input.capture = options.capture
      input.multiple = options.multiple ?? false; input.hidden = true
      input.addEventListener('change', onChange)
      input.addEventListener('cancel', onCancel)
      options.signal.addEventListener('abort', onAbort, { once: true })
      cancelDeadline = environment.deadline(onCancel, BROWSER_FILE_PICKER_DEADLINE_MS)
      if (options.signal.aborted) { onAbort(); return }
      source.open()
    } catch (error) { finish({ kind: 'failed', error }) }
  })
}
