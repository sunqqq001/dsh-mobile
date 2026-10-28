import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CaddyComponentManager, CADDY_COMPONENT_RELEASES, CADDY_DNS_PLUGIN_VERSION, CADDY_VERSION } from '../src/caddy-component.js'
import * as execution from '../src/exec-file.js'

const targets = ['linux-x64', 'win32-x64'] as const
const cleanups: (() => Promise<void>)[] = []
let fixtureController: AbortController | undefined
let activeBody: Promise<void> | undefined
afterEach(async () => {
  fixtureController?.abort(new Error('Default-source fixture teardown'))
  try { await activeBody } catch (_error) { /* The test body reports its own failure. */ }
  activeBody = undefined; fixtureController = undefined
  const errors: unknown[] = []
  for (const cleanup of cleanups.splice(0).reverse()) {
    try { await cleanup() } catch (error) { errors.push(error) }
  }
  vi.restoreAllMocks(); vi.unstubAllGlobals()
  if (errors.length > 0) throw new AggregateError(errors, 'Default-source fixture cleanup failed')
}, 60_000)

async function directory(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-mobile-caddy-default-'))
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  return root
}
function own(manager: CaddyComponentManager): CaddyComponentManager {
  cleanups.push(() => manager.close())
  return manager
}
function pin(target: string) {
  const value = CADDY_COMPONENT_RELEASES[target]
  if (value === undefined) throw new Error('Missing default Caddy artifact: ' + target)
  return value
}
function digest(bytes: Uint8Array): string { return createHash('sha256').update(bytes).digest('hex') }

describe('managed Caddy default production source', () => {
  it('pins exactly the verified Windows/Linux x64 raw component sources', () => {
    expect(Object.keys(CADDY_COMPONENT_RELEASES).sort()).toEqual(targets)
    expect(Object.isFrozen(CADDY_COMPONENT_RELEASES)).toBe(true)
    for (const target of targets) {
      const artifact = pin(target)
      const extension = target === 'win32-x64' ? '.exe' : ''
      const tag = `caddy-component-${CADDY_VERSION}-tencentcloud-${CADDY_DNS_PLUGIN_VERSION.slice(1)}-r1`
      const asset = `caddy-${CADDY_VERSION}-tencentcloud-${CADDY_DNS_PLUGIN_VERSION.slice(1)}-${target}${extension}`
      expect(Object.isFrozen(artifact)).toBe(true)
      expect(artifact).toMatchObject({ version: CADDY_VERSION, dnsPluginVersion: CADDY_DNS_PLUGIN_VERSION,
        platform: target === 'win32-x64' ? 'win32' : 'linux', arch: 'x64',
        executableName: 'caddy' + extension,
        downloadUrl: `https://github.com/saya-ch/dsh-mobile/releases/download/${tag}/${asset}` })
      expect(Number.isSafeInteger(artifact.downloadBytes) && artifact.downloadBytes > 0).toBe(true)
      expect(artifact.downloadBytes).toBe(artifact.executableBytes)
      expect(artifact.downloadSha256).toMatch(/^[a-f0-9]{64}$/u)
      expect(artifact.downloadSha256).toBe(artifact.executableSha256)
    }
  })

  it.each(targets)('uses the default %s artifact without caller-provided release metadata', async target => {
    const artifact = pin(target)
    const component = own(new CaddyComponentManager({ stateDirectory: await directory(), platform: artifact.platform, arch: artifact.arch }))
    await component.initialize()
    expect(component.status()).toMatchObject({ supported: true, installed: false, version: CADDY_VERSION,
      sourceUrl: artifact.downloadUrl, downloadBytes: artifact.downloadBytes, installedBytes: 0 })
    expect(component.status().errorCode).toBeUndefined()
  })

  it.each(targets)('uses the real default %s downloader and cancels an incorrect-length response before execution', async target => {
    const artifact = pin(target)
    const cancel = vi.fn(async () => {})
    const body = new ReadableStream<Uint8Array>({ cancel }, { highWaterMark: 0 })
    const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toBe(artifact.downloadUrl)
      expect(init?.redirect).toBe('manual')
      expect(new Headers(init?.headers).has('authorization')).toBe(false)
      return new Response(body, { status: 200, headers: { 'content-length': String(artifact.downloadBytes + 1) } })
    })
    vi.stubGlobal('fetch', fetch)
    const inspect = vi.spyOn(execution, 'execFileText')
    const component = own(new CaddyComponentManager({ stateDirectory: await directory(), platform: artifact.platform, arch: artifact.arch }))
    await expect(component.install()).rejects.toThrow('caddy_download_size_mismatch')
    expect(fetch).toHaveBeenCalledOnce(); expect(cancel).toHaveBeenCalledOnce()
    expect(inspect.mock.calls.filter(([, args]) => args[0] === 'version' || args[0] === 'list-modules')).toEqual([])
    await expect(lstat(component.executable)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await readdir(component.componentRoot)).toEqual([])
  })

  it.each([
    { platform: 'darwin', arch: 'x64' }, { platform: 'darwin', arch: 'arm64' },
    { platform: 'linux', arch: 'arm64' }, { platform: 'win32', arch: 'arm64' }, { platform: 'freebsd', arch: 'x64' },
  ] as const)('rejects unsupported $platform/$arch without downloading', async options => {
    const fetch = vi.fn(async () => { throw new Error('Unexpected unsupported-platform download') })
    vi.stubGlobal('fetch', fetch)
    const component = own(new CaddyComponentManager({ stateDirectory: await directory(), ...options }))
    await component.initialize()
    expect(component.status()).toMatchObject({ supported: false, installed: false, errorCode: 'caddy_component_unavailable' })
    await expect(component.install()).rejects.toThrow('caddy_component_unavailable')
    expect(fetch).not.toHaveBeenCalled()
  })
})

const publicExecutable = process.env.DSH_CADDY_DEFAULT_TEST_EXECUTABLE
it.runIf(publicExecutable !== undefined)('installs and reinspects verified public bytes through the default source, downloader and native inspector', async () => {
  fixtureController = new AbortController()
  const signal = fixtureController.signal
  const deadline = setTimeout(() => { fixtureController?.abort(new Error('Default-source fixture deadline')) }, 100_000)
  const step = async <T>(operation: () => Promise<T>): Promise<T> => {
    signal.throwIfAborted()
    const result = await operation()
    signal.throwIfAborted()
    return result
  }
  const body = async (): Promise<void> => {
    if (publicExecutable === undefined || !isAbsolute(publicExecutable)) throw new Error('Expected an absolute verified public Caddy executable')
    const artifact = pin(process.platform + '-' + process.arch)
    const entry = await step(() => lstat(publicExecutable))
    expect(entry.isFile() && !entry.isSymbolicLink()).toBe(true)
    expect(entry.size).toBe(artifact.downloadBytes)
    const bytes = await step(() => readFile(publicExecutable))
    expect(digest(bytes)).toBe(artifact.downloadSha256)
    const root = await directory()
    await step(() => mkdir(join(root, 'components', 'neighbor'), { recursive: true }))
    const neighbor = join(root, 'components', 'neighbor', 'keep')
    const pairings = join(root, 'paired-devices.json')
    await step(() => writeFile(neighbor, 'preserved-neighbor'))
    await step(() => writeFile(pairings, 'preserved-pairings'))
    let corrupted = false; let requests = 0
    const server = createServer((request, response) => {
      requests++
      if (request.method !== 'GET' || request.url !== '/binary') { response.writeHead(404); response.end(); return }
      response.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': bytes.length })
      if (corrupted) {
        response.write(bytes.subarray(0, bytes.length - 1))
        response.end(Buffer.from([bytes[bytes.length - 1]! ^ 1]))
      } else response.end(bytes)
    })
    cleanups.push(async () => {
      server.closeAllConnections()
      if (server.listening) await new Promise<void>((resolve, reject) => { server.close(error => error ? reject(error) : resolve()) })
    })
    await step(() => new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) }))
    const address = server.address()
    if (address === null || typeof address === 'string') throw new Error('Missing default-source fixture listener')
    const localUrl = `http://127.0.0.1:${String(address.port)}/binary`
    const redirectUrl = 'https://release-assets.githubusercontent.com/dsh-mobile/default-caddy-fixture'
    const nativeFetch = globalThis.fetch
    const calls: { url: string; redirect: RequestRedirect | undefined }[] = []
    vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input)
      calls.push({ url, redirect: init?.redirect })
      expect(new Headers(init?.headers).has('authorization')).toBe(false)
      expect(new Headers(init?.headers).has('cookie')).toBe(false)
      if (url === artifact.downloadUrl) {
        expect(init?.redirect).toBe('manual')
        return new Response(null, { status: 302, headers: { location: redirectUrl } })
      }
      if (url !== redirectUrl) throw new Error('Unexpected default-source fixture URL')
      expect(init?.redirect).toBe('error')
      return nativeFetch(localUrl, { ...init, signal: AbortSignal.any([signal, ...(init?.signal == null ? [] : [init.signal])]) })
    })
    const inspection = vi.spyOn(execution, 'execFileText')
    const inspections = () => inspection.mock.calls.filter(([, args]) => args[0] === 'version' || args[0] === 'list-modules')
    // No artifact, fetchArtifact, inspectExecutable or promotion override: use the actual production path.
    const manager = own(new CaddyComponentManager({ stateDirectory: root }))
    await step(() => manager.initialize())
    expect(manager.status()).toMatchObject({ supported: true, installed: false, sourceUrl: artifact.downloadUrl })
    expect((await step(() => manager.install())).installed).toBe(true)
    expect(inspections().map(([, args]) => args)).toEqual([['version'], ['list-modules', '--versions']])
    expect(requests).toBe(1)
    expect(calls).toEqual([{ url: artifact.downloadUrl, redirect: 'manual' }, { url: redirectUrl, redirect: 'error' }])
    expect(digest(await step(() => readFile(manager.executable)))).toBe(artifact.executableSha256)
    await step(() => manager.ensureExecutable())
    expect(inspections()).toHaveLength(4)
    await step(() => manager.close())
    const restarted = own(new CaddyComponentManager({ stateDirectory: root }))
    await step(() => restarted.initialize())
    expect(restarted.status()).toMatchObject({ installed: true, installedBytes: bytes.length })
    expect(inspections()).toHaveLength(6)
    expect(requests).toBe(1)
    corrupted = true
    const beforeCorruption = inspections().length
    await step(() => expect(restarted.install()).rejects.toThrow('caddy_download_hash_mismatch'))
    expect(requests).toBe(2); expect(inspections()).toHaveLength(beforeCorruption)
    expect(digest(await step(() => readFile(restarted.executable)))).toBe(artifact.executableSha256)
    await step(() => restarted.ensureExecutable())
    expect(inspections()).toHaveLength(8)
    expect(await step(() => readdir(join(root, 'staging', 'caddy')))).toEqual([])
    expect(await step(() => readdir(restarted.componentRoot))).toEqual([CADDY_VERSION])
    await step(() => restarted.purge()); await step(() => restarted.close())
    await step(() => expect(lstat(restarted.componentRoot)).rejects.toMatchObject({ code: 'ENOENT' }))
    await step(() => expect(lstat(join(root, 'staging', 'caddy'))).rejects.toMatchObject({ code: 'ENOENT' }))
    expect(await step(() => readFile(neighbor, 'utf8'))).toBe('preserved-neighbor')
    expect(await step(() => readFile(pairings, 'utf8'))).toBe('preserved-pairings')
  }
  activeBody = body()
  try { await activeBody } finally { clearTimeout(deadline) }
}, 120_000)
