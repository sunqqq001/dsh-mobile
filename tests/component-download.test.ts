import { afterEach, describe, expect, it, vi } from 'vitest'
import { createServer } from 'node:http'
import { downloadPinnedArtifact } from '../src/component-download.js'

const BODY = 'abcd'
const BYTES = new TextEncoder().encode(BODY)
const URL_PINNED = 'https://github.com/owner/repo/releases/download/v1/tool.exe'
const URL_ASSET = 'https://release-assets.githubusercontent.com/github-production-release-asset/1/2?token=x'
const cleanups: Array<() => Promise<void>> = []

interface Call {
  readonly url: string
  readonly redirect: string | undefined
}

/** Replace global fetch with a scripted queue and record how each call was configured. */
function stubFetch(responses: readonly Response[]): Call[] {
  const calls: Call[] = []
  let index = 0
  vi.stubGlobal('fetch', (url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), redirect: init?.redirect })
    const response = responses[index]
    index += 1
    if (response === undefined) throw new Error(`unexpected fetch #${String(index)} for ${String(url)}`)
    return Promise.resolve(response)
  })
  return calls
}

function response(status: number, headers: Record<string, string>, body: string = BODY): Response {
  return new Response(body, { status, headers })
}

afterEach(async () => {
  vi.unstubAllGlobals()
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

describe('pinned component download', () => {
  it.each([
    { status: 404, headers: {}, code: 'tool_download_http_404' },
    { status: 200, headers: { 'content-length': '99' }, code: 'tool_download_size_mismatch' },
    { status: 302, headers: { location: 'https://evil.example/tool.exe' }, code: 'tool_download_redirect_rejected' },
    { status: 302, headers: {}, code: 'tool_download_redirect_missing' },
    { status: 302, headers: { location: 'https://[' }, code: 'tool_download_redirect_invalid' },
  ])('cancels the rejected response body for $code', async ({ status, headers, code }) => {
    const cancel = vi.fn(async () => {})
    const body = new ReadableStream<Uint8Array>({ cancel })
    stubFetch([new Response(body, { status, headers })])
    try {
      await expect(downloadPinnedArtifact({
        url: URL_PINNED, expectedBytes: BYTES.byteLength, errorPrefix: 'tool', signal: new AbortController().signal,
      })).rejects.toThrow(code)
      expect(cancel).toHaveBeenCalledOnce()
    } finally { await body.cancel() }
  })

  it('waits for response cancellation before returning a metadata verdict', async () => {
    let finishCancel: (() => void) | undefined
    const cancellation = new Promise<void>(resolve => { finishCancel = resolve })
    const cancel = vi.fn(() => cancellation)
    const body = new ReadableStream<Uint8Array>({ cancel })
    stubFetch([new Response(body, { status: 200, headers: { 'content-length': '99' } })])
    let completed = false
    const download = downloadPinnedArtifact({
      url: URL_PINNED, expectedBytes: BYTES.byteLength, errorPrefix: 'tool', signal: new AbortController().signal,
    }).catch((error: unknown) => { completed = true; return error })
    try {
      await new Promise<void>(resolve => { setImmediate(resolve) })
      expect(cancel).toHaveBeenCalledOnce()
      expect(completed).toBe(false)
    } finally { finishCancel?.(); await body.cancel() }
    expect(await download).toMatchObject({ message: 'tool_download_size_mismatch' })
  })

  it('finishes cancelling a redirect body before following its validated target', async () => {
    let finishCancel: (() => void) | undefined
    const cancellation = new Promise<void>(resolve => { finishCancel = resolve })
    const cancel = vi.fn(() => cancellation)
    const body = new ReadableStream<Uint8Array>({ cancel })
    const calls = stubFetch([
      new Response(body, { status: 302, headers: { location: URL_ASSET } }),
      response(200, { 'content-length': String(BYTES.byteLength) }),
    ])
    const download = downloadPinnedArtifact({
      url: URL_PINNED, expectedBytes: BYTES.byteLength, errorPrefix: 'tool', signal: new AbortController().signal,
    })
    try {
      await new Promise<void>(resolve => { setImmediate(resolve) })
      expect(cancel).toHaveBeenCalledOnce()
      expect(calls).toHaveLength(1)
    } finally { finishCancel?.(); await body.cancel() }
    expect([...(await download)]).toEqual([...BYTES])
    expect(calls).toHaveLength(2)
  })

  it('releases its reader when the body read fails and retains the transport error', async () => {
    const failure = new Error('fixture body read failed')
    const body = new ReadableStream<Uint8Array>({ start(controller) { controller.error(failure) } })
    stubFetch([new Response(body, { status: 200 })])
    await expect(downloadPinnedArtifact({
      url: URL_PINNED, expectedBytes: BYTES.byteLength, errorPrefix: 'tool', signal: new AbortController().signal,
    })).rejects.toBe(failure)
    expect(body.locked).toBe(false)
  })

  it('retains an overflow verdict when body cancellation fails instead of retrying the cleanup error', async () => {
    const cancel = vi.fn(async () => { throw new TypeError('fixture cancellation failure') })
    const body = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new TextEncoder().encode(`${BODY}extra`)) }, cancel,
    }, { highWaterMark: 0 })
    const calls = stubFetch([new Response(body, { status: 200 })])
    await expect(downloadPinnedArtifact({
      url: URL_PINNED, expectedBytes: BYTES.byteLength, errorPrefix: 'tool', signal: new AbortController().signal,
    })).rejects.toThrow('tool_download_size_mismatch')
    expect(cancel).toHaveBeenCalledOnce()
    expect(calls).toHaveLength(1)
    expect(body.locked).toBe(false)
  })

  it('retains a metadata verdict when cancelling the discarded body fails', async () => {
    const cancel = vi.fn(async () => { throw new TypeError('fixture cancellation failure') })
    const body = new ReadableStream<Uint8Array>({ cancel })
    const calls = stubFetch([new Response(body, { status: 200, headers: { 'content-length': '99' } })])
    await expect(downloadPinnedArtifact({
      url: URL_PINNED, expectedBytes: BYTES.byteLength, errorPrefix: 'tool', signal: new AbortController().signal,
    })).rejects.toThrow('tool_download_size_mismatch')
    expect(cancel).toHaveBeenCalledOnce()
    expect(calls).toHaveLength(1)
  })

  it.each([
    { status: 404, headers: {}, code: 'tool_download_http_404' },
    { status: 200, headers: { 'content-length': '99' }, code: 'tool_download_size_mismatch' },
    { status: 302, headers: { location: 'https://rejected.example/fixture' }, code: 'tool_download_redirect_rejected' },
  ])('closes the actual HTTP response after rejecting $code without aborting its caller', async ({ status, headers, code }) => {
    let closed = false
    const controller = new AbortController()
    const server = createServer((_request, response) => {
      response.once('close', () => { closed = true })
      response.writeHead(status, headers)
      response.write('unread fixture body')
    })
    cleanups.push(async () => {
      controller.abort()
      server.closeAllConnections()
      if (server.listening) await new Promise<void>(resolve => { server.close(() => resolve()) })
    })
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', resolve)
    })
    const address = server.address()
    if (address === null || typeof address === 'string') throw new Error('fixture listener has no TCP address')
    await expect(downloadPinnedArtifact({
      url: `http://127.0.0.1:${String(address.port)}/fixture`, expectedBytes: BYTES.byteLength,
      errorPrefix: 'tool', signal: controller.signal,
    })).rejects.toThrow(code)
    await vi.waitFor(() => { expect(closed).toBe(true) }, { timeout: 5_000 })
    expect(controller.signal.aborted).toBe(false)
  })

  it('accepts a direct response whose length matches the pin', async () => {
    const calls = stubFetch([response(200, { 'content-length': String(BYTES.byteLength) })])
    const bytes = await downloadPinnedArtifact({
      url: URL_PINNED, expectedBytes: BYTES.byteLength, errorPrefix: 'tool', signal: new AbortController().signal,
    })
    expect([...bytes]).toEqual([...BYTES])
    // A direct response is requested with manual redirects so a hop can be validated explicitly.
    expect(calls).toEqual([{ url: URL_PINNED, redirect: 'manual' }])
  })

  it('accepts an exact response when the server omits Content-Length', async () => {
    stubFetch([response(200, {})])
    const bytes = await downloadPinnedArtifact({
      url: URL_PINNED, expectedBytes: BYTES.byteLength, errorPrefix: 'tool', signal: new AbortController().signal,
    })
    expect([...bytes]).toEqual([...BYTES])
  })

  it('cancels an unbounded response before reading past the pinned size', async () => {
    let cancelled = false
    const body = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new TextEncoder().encode(`${BODY}extra`)) },
      pull() { throw new Error('read after the size cap') },
      cancel() { cancelled = true },
    }, { highWaterMark: 0 })
    stubFetch([new Response(body, { status: 200 })])
    await expect(downloadPinnedArtifact({
      url: URL_PINNED, expectedBytes: BYTES.byteLength, errorPrefix: 'tool', signal: new AbortController().signal,
    })).rejects.toThrow('tool_download_size_mismatch')
    expect(cancelled).toBe(true)
  })

  it('follows exactly one redirect to a release asset host', async () => {
    // This is the shape every GitHub release download uses, and the one `redirect: 'error'` broke.
    const calls = stubFetch([
      response(302, { location: URL_ASSET }),
      response(200, { 'content-length': String(BYTES.byteLength) }),
    ])
    const bytes = await downloadPinnedArtifact({
      url: URL_PINNED, expectedBytes: BYTES.byteLength, errorPrefix: 'tool', signal: new AbortController().signal,
    })
    expect([...bytes]).toEqual([...BYTES])
    expect(calls).toHaveLength(2)
    expect(calls[0]).toEqual({ url: URL_PINNED, redirect: 'manual' })
    expect(calls[1]?.url).toBe(URL_ASSET)
    // The hop target must serve the bytes itself: a second redirect is refused.
    expect(calls[1]?.redirect).toBe('error')
  })

  it('refuses a redirect to a host that is not a release asset host', async () => {
    stubFetch([response(302, { location: 'https://evil.example/tool.exe' })])
    await expect(downloadPinnedArtifact({
      url: URL_PINNED, expectedBytes: BYTES.byteLength, errorPrefix: 'tool', signal: new AbortController().signal,
    })).rejects.toThrow('tool_download_redirect_rejected')
  })

  it('refuses a cleartext redirect and a redirect without a location', async () => {
    stubFetch([response(302, { location: 'http://release-assets.githubusercontent.com/tool.exe' })])
    await expect(downloadPinnedArtifact({
      url: URL_PINNED, expectedBytes: BYTES.byteLength, errorPrefix: 'tool', signal: new AbortController().signal,
    })).rejects.toThrow('tool_download_redirect_rejected')

    vi.unstubAllGlobals()
    stubFetch([response(302, {})])
    await expect(downloadPinnedArtifact({
      url: URL_PINNED, expectedBytes: BYTES.byteLength, errorPrefix: 'tool', signal: new AbortController().signal,
    })).rejects.toThrow('tool_download_redirect_missing')
  })

  it('refuses a body whose length differs from the pin', async () => {
    stubFetch([response(200, { 'content-length': '99' })])
    await expect(downloadPinnedArtifact({
      url: URL_PINNED, expectedBytes: BYTES.byteLength, errorPrefix: 'tool', signal: new AbortController().signal,
    })).rejects.toThrow('tool_download_size_mismatch')
  })

  it('reports the http status when the artifact is not served', async () => {
    // A 5xx is retried once, so both attempts must answer before the verdict surfaces.
    stubFetch([response(503, {}), response(503, {})])
    await expect(downloadPinnedArtifact({
      url: URL_PINNED, expectedBytes: BYTES.byteLength, errorPrefix: 'tool', signal: new AbortController().signal,
    })).rejects.toThrow('tool_download_http_503')
  })

  it('retries a transport failure once, because a long transfer can reset mid-stream', async () => {
    let call = 0
    vi.stubGlobal('fetch', () => {
      call += 1
      if (call === 1) return Promise.reject(new TypeError('fetch failed'))
      return Promise.resolve(response(200, { 'content-length': String(BYTES.byteLength) }))
    })
    const bytes = await downloadPinnedArtifact({
      url: URL_PINNED, expectedBytes: BYTES.byteLength, errorPrefix: 'tool', signal: new AbortController().signal,
    })
    expect([...bytes]).toEqual([...BYTES])
    expect(call).toBe(2)
  })

  it('does not retry a verdict', async () => {
    let call = 0
    vi.stubGlobal('fetch', () => {
      call += 1
      return Promise.resolve(response(200, { 'content-length': '99' }))
    })
    await expect(downloadPinnedArtifact({
      url: URL_PINNED, expectedBytes: BYTES.byteLength, errorPrefix: 'tool', signal: new AbortController().signal,
    })).rejects.toThrow('tool_download_size_mismatch')
    expect(call).toBe(1)
  })
})
