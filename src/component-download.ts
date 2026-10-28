/**
 * Hosts a pinned GitHub release download may redirect to.
 *
 * `github.com/<owner>/<repo>/releases/download/<tag>/<asset>` does not serve the bytes itself: it
 * answers 302 with a signed URL on a release-asset host. A fetch configured with
 * `redirect: 'error'` fails that hop as `TypeError: fetch failed` (cause: `unexpected redirect`)
 * before a single byte is transferred, which is exactly how the cloudflared component could never
 * install. Following one validated hop keeps the origin restriction while allowing the shape
 * every GitHub release download uses.
 */
const RELEASE_ASSET_HOSTS: readonly string[] = Object.freeze([
  'release-assets.githubusercontent.com',
  'objects.githubusercontent.com',
])

/** Input for {@link downloadPinnedArtifact}. */
export interface PinnedDownloadRequest {
  /** Absolute URL of the pinned artifact. */
  readonly url: string
  /** Exact byte length the artifact must have. */
  readonly expectedBytes: number
  /** Stable error-code prefix owned by the calling component, such as `cloudflared`. */
  readonly errorPrefix: string
  readonly signal: AbortSignal
  /** Hosts a single redirect hop may target; defaults to the GitHub release asset hosts. */
  readonly redirectHosts?: readonly string[]
}

/** Release an unused body without replacing a download or validation failure. */
async function discardBody(body: { cancel(): Promise<void> } | null): Promise<void> {
  if (body === null) return
  try { await body.cancel() } catch (_error) {
    // Cancellation can reject after a transport failure; the download verdict remains authoritative.
  }
}

/** Follow one redirect hop after checking its scheme and host. A second hop is refused. */
async function followValidatedRedirect(response: Response, request: PinnedDownloadRequest): Promise<Response> {
  let target: URL
  try {
    const location = response.headers.get('location')
    if (location === null) throw new Error(`${request.errorPrefix}_download_redirect_missing`)
    try {
      target = new URL(location, request.url)
    } catch {
      throw new Error(`${request.errorPrefix}_download_redirect_invalid`)
    }
    const hosts = request.redirectHosts ?? RELEASE_ASSET_HOSTS
    if (target.protocol !== 'https:' || !hosts.includes(target.hostname)) {
      throw new Error(`${request.errorPrefix}_download_redirect_rejected`)
    }
  } finally { await discardBody(response.body) }
  return fetch(target, { redirect: 'error', signal: request.signal })
}

/** Attempts per install. A 55 MB transfer through a TUN proxy can reset mid-stream: the first
 * real run in the development environment failed after 1.5 MB and succeeded on the next attempt,
 * which is exactly the confusing "nothing happened" the user saw. */
const DOWNLOAD_ATTEMPTS = 2
const RETRY_DELAY_MS = 750

/** Whether a failure is a transport problem worth a second attempt rather than a verdict. */
function isRetryable(error: unknown): boolean {
  // undici reports network faults as TypeError('fetch failed'), and a 5xx is worth one more try.
  if (error instanceof TypeError) return true
  if (error instanceof Error && /_download_http_5\d\d$/u.test(error.message)) return true
  return false
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => { setTimeout(resolve, ms) })
}

async function attemptDownload(request: PinnedDownloadRequest): Promise<Uint8Array> {
  const first = await fetch(request.url, { redirect: 'manual', signal: request.signal })
  const redirected = first.status >= 300 && first.status < 400
  const response = redirected ? await followValidatedRedirect(first, request) : first
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
  let ended = false
  try {
    if (!response.ok) throw new Error(`${request.errorPrefix}_download_http_${String(response.status)}`)
    const contentLength = response.headers.get('content-length')
    if (contentLength !== null && (!/^\d+$/u.test(contentLength) || Number(contentLength) !== request.expectedBytes)) {
      throw new Error(`${request.errorPrefix}_download_size_mismatch`)
    }
    if (response.body === null) throw new Error(`${request.errorPrefix}_download_size_mismatch`)
    const bytes = new Uint8Array(request.expectedBytes)
    reader = response.body.getReader()
    let received = 0
    while (true) {
      const chunk = await reader.read()
      if (chunk.done) { ended = true; break }
      if (chunk.value.byteLength > bytes.byteLength - received) {
        throw new Error(`${request.errorPrefix}_download_size_mismatch`)
      }
      bytes.set(chunk.value, received)
      received += chunk.value.byteLength
    }
    if (received !== request.expectedBytes) throw new Error(`${request.errorPrefix}_download_size_mismatch`)
    return bytes
  } finally {
    if (reader === undefined) await discardBody(response.body)
    else {
      try { if (!ended) await discardBody(reader) } finally { reader.releaseLock() }
    }
  }
}

/**
 * Download a pinned artifact, following at most one validated redirect, and check its exact length.
 * A transport failure is retried once; a length or redirect verdict is not. The caller still
 * verifies the SHA-256 before publishing anything.
 * @param request - the pinned URL, its exact byte length and the caller's error prefix.
 * @returns the artifact bytes.
 */
export async function downloadPinnedArtifact(request: PinnedDownloadRequest): Promise<Uint8Array> {
  let lastError: unknown
  for (let attempt = 1; attempt <= DOWNLOAD_ATTEMPTS; attempt += 1) {
    try {
      return await attemptDownload(request)
    } catch (error) {
      lastError = error
      if (attempt === DOWNLOAD_ATTEMPTS || !isRetryable(error)) throw error
      await delay(RETRY_DELAY_MS)
    }
  }
  throw lastError
}
