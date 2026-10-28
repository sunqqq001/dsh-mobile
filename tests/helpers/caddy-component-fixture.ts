import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { lstat, readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect } from 'vitest'
import { CaddyComponentManager, CADDY_VERSION, CADDY_DNS_PLUGIN_VERSION, type CaddyArtifact } from '../../src/caddy-component.js'
import { downloadPinnedArtifact } from '../../src/component-download.js'

/** Independent manifest pins are checked before any input executable is run. */
export async function installedCaddyFixture(root: string, executable: string, manifestFile: string, cleanup: (fn: () => Promise<void>) => void, fixtureSignal: AbortSignal) {
  const step = async <T>(operation: () => Promise<T>): Promise<T> => {
    fixtureSignal.throwIfAborted()
    const result = await operation()
    fixtureSignal.throwIfAborted()
    return result
  }
  const manifest = JSON.parse(await step(() => readFile(manifestFile, 'utf8'))) as CaddyArtifact
  expect(manifest.version).toBe(CADDY_VERSION)
  expect(manifest.dnsPluginVersion).toBe(CADDY_DNS_PLUGIN_VERSION)
  expect(manifest.platform).toBe(process.platform)
  expect(manifest.arch).toBe(process.arch)
  expect(manifest.executableName).toBe(process.platform === 'win32' ? 'caddy.exe' : 'caddy')
  for (const size of [manifest.downloadBytes, manifest.executableBytes]) {
    expect(Number.isSafeInteger(size) && size > 0).toBe(true)
  }
  for (const hash of [manifest.downloadSha256, manifest.executableSha256]) expect(hash).toMatch(/^[a-f0-9]{64}$/u)
  const entry = await step(() => lstat(executable))
  expect(entry.isFile() && !entry.isSymbolicLink()).toBe(true)
  const bytes = await step(() => readFile(executable))
  const hash = createHash('sha256').update(bytes).digest('hex')
  expect(bytes.byteLength).toBe(manifest.downloadBytes)
  expect(bytes.byteLength).toBe(manifest.executableBytes)
  expect(hash).toBe(manifest.downloadSha256)
  expect(hash).toBe(manifest.executableSha256)
  const artifact: CaddyArtifact = { ...manifest, downloadUrl: 'https://fixture.invalid/pinned/caddy' }
  let requests = 0
  let corruptDownload = false
  fixtureSignal.throwIfAborted()
  const server = createServer((request, response) => {
    requests += 1
    if (request.url !== '/pinned/caddy' || request.method !== 'GET') { response.writeHead(404); response.end(); return }
    response.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': bytes.byteLength })
    if (corruptDownload) { const corrupt = Buffer.from(bytes); corrupt[corrupt.length - 1] = corrupt[corrupt.length - 1]! ^ 1; response.end(corrupt) }
    else response.end(bytes)
  })
  cleanup(async () => { server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())) })
  await step(() => new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) }))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('missing fixture port')
  // Exercise the production streaming downloader, not the default GitHub HTTPS/redirect route.
  const fetchArtifact = async (url: string, managerSignal: AbortSignal) => {
    fixtureSignal.throwIfAborted()
    expect(url).toBe(artifact.downloadUrl)
    return downloadPinnedArtifact({ url: `http://127.0.0.1:${String(address.port)}/pinned/caddy`,
      signal: AbortSignal.any([managerSignal, fixtureSignal, AbortSignal.timeout(10_000)]),
      expectedBytes: artifact.downloadBytes, errorPrefix: 'caddy' })
  }
  const options = { stateDirectory: root, artifact, fetchArtifact }
  const manager = new CaddyComponentManager(options) // Default real inspector: each version/list-modules exec is bounded to 15s.
  expect((await step(() => manager.install())).installed).toBe(true)
  expect(requests).toBe(1)
  await step(() => manager.ensureExecutable())
  const restarted = new CaddyComponentManager(options)
  await step(() => restarted.initialize())
  expect(restarted.status()).toMatchObject({ installed: true, installedBytes: manifest.executableBytes })
  expect(requests).toBe(1)
  corruptDownload = true
  await step(() => expect(restarted.install()).rejects.toThrow('caddy_download_hash_mismatch'))
  expect(requests).toBe(2)
  // Native binaries are ~83 MB: generic deep equality enumerates byte keys and can exhaust V8's heap.
  expect((await step(() => readFile(restarted.executable))).equals(bytes)).toBe(true)
  await step(() => restarted.ensureExecutable())
  expect(await step(() => readdir(join(root, 'staging', 'caddy')))).toEqual([])
  expect((await step(() => readdir(manager.componentRoot))).filter(name => /^\.(install|previous)-/u.test(name))).toEqual([])
  return {
    executable: restarted.executable,
    async corruptAndPurge() {
      fixtureSignal.throwIfAborted()
      const corrupt = Buffer.from(bytes); corrupt[corrupt.length - 1] = corrupt[corrupt.length - 1]! ^ 1
      await step(() => writeFile(restarted.executable, corrupt))
      await step(() => expect(restarted.ensureExecutable()).rejects.toThrow('caddy_component_invalid'))
      const invalid = new CaddyComponentManager(options)
      await step(() => invalid.initialize())
      expect(invalid.status()).toMatchObject({ installed: false, errorCode: 'caddy_component_invalid' })
      expect(requests).toBe(2)
      await step(() => restarted.purge())
      await step(() => expect(lstat(restarted.componentRoot)).rejects.toMatchObject({ code: 'ENOENT' }))
      await step(() => expect(lstat(join(root, 'staging', 'caddy'))).rejects.toMatchObject({ code: 'ENOENT' }))
    },
  }
}
