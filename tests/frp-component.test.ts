import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  FRP_COMPONENT_RELEASES,
  FrpComponentManager,
  selectFrpExecutableEntry,
} from '../src/frp-component.js'

const temporaryDirectories: string[] = []

afterEach(async () => {
  vi.unstubAllGlobals()
  await Promise.all(temporaryDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
})

describe('managed FRP component', () => {
  it.each([
    { status: 404, headers: {}, code: 'frp_download_http_404' },
    { status: 200, headers: { 'content-length': '99' }, code: 'frp_download_size_mismatch' },
    { status: 302, headers: { location: 'https://untrusted.githubusercontent.com/frpc' }, code: 'frp_download_redirect_rejected' },
  ])('cancels rejected download bodies through install for $code', async ({ status, headers, code }) => {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-mobile-frp-download-'))
    temporaryDirectories.push(directory)
    const manager = new FrpComponentManager({ stateDirectory: directory, platform: 'win32', arch: 'x64' })
    await manager.initialize()
    const cancel = vi.fn(async () => undefined)
    const body = new ReadableStream<Uint8Array>({ cancel })
    const fetch = vi.fn(async () => new Response(body, { status, headers }))
    vi.stubGlobal('fetch', fetch)
    await expect(manager.install()).rejects.toThrow(code)
    expect(cancel).toHaveBeenCalledOnce()
    expect(body.locked).toBe(false)
    expect(fetch).toHaveBeenCalledWith(FRP_COMPONENT_RELEASES['win32-x64']!.downloadUrl, expect.objectContaining({ redirect: 'manual' }))
    expect(await readdir(join(directory, 'staging', 'frp'))).toEqual([])
    expect(manager.status().installed).toBe(false)
  })

  it('releases the download reader before enforcing the unchanged archive hash pin', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-mobile-frp-download-'))
    temporaryDirectories.push(directory)
    const extract = vi.fn(async () => undefined)
    const manager = new FrpComponentManager({ stateDirectory: directory, platform: 'win32', arch: 'x64', extractArtifact: extract })
    await manager.initialize()
    const artifact = FRP_COMPONENT_RELEASES['win32-x64']!
    const body = new ReadableStream<Uint8Array>({ start(controller) {
      controller.enqueue(new Uint8Array(artifact.downloadBytes))
      controller.close()
    } })
    vi.stubGlobal('fetch', vi.fn(async () => new Response(body, { status: 200, headers: { 'content-length': String(artifact.downloadBytes) } })))
    await expect(manager.install()).rejects.toThrow('frp_download_hash_mismatch')
    expect(body.locked).toBe(false)
    expect(extract).not.toHaveBeenCalled()
    expect(await readdir(join(directory, 'staging', 'frp'))).toEqual([])
  })

  it('releases a reader after a transfer fails before extraction', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-mobile-frp-download-'))
    temporaryDirectories.push(directory)
    const manager = new FrpComponentManager({ stateDirectory: directory, platform: 'win32', arch: 'x64' })
    await manager.initialize()
    const body = new ReadableStream<Uint8Array>({ start(controller) { controller.error(new Error('fixture connection reset')) } })
    vi.stubGlobal('fetch', vi.fn(async () => new Response(body, { status: 200 })))
    await expect(manager.install()).rejects.toThrow('fixture connection reset')
    expect(body.locked).toBe(false)
    expect(await readdir(join(directory, 'staging', 'frp'))).toEqual([])
  })

  it('pins official artifacts for each supported desktop target', () => {
    expect(Object.keys(FRP_COMPONENT_RELEASES).sort()).toEqual([
      'darwin-arm64', 'darwin-x64', 'linux-arm64', 'linux-x64', 'win32-arm64', 'win32-x64',
    ])
    for (const release of Object.values(FRP_COMPONENT_RELEASES)) {
      expect(release.downloadUrl).toMatch(/^https:\/\/github\.com\/fatedier\/frp\/releases\/download\/v0\.70\.1\//u)
      expect(release.downloadSha256).toMatch(/^[a-f0-9]{64}$/u)
      expect(release.downloadBytes).toBeGreaterThan(10_000_000)
    }
  })

  it('recognizes only the managed version and purges all owned files', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-mobile-frp-component-'))
    temporaryDirectories.push(directory)
    const manager = new FrpComponentManager({
      stateDirectory: directory,
      platform: 'win32',
      arch: 'x64',
      inspectExecutable: async () => '0.70.1',
    })
    await mkdir(dirname(manager.executable), { recursive: true })
    await writeFile(manager.executable, 'fake-frpc')
    await manager.initialize()
    expect(manager.status()).toMatchObject({ supported: true, installed: true, version: '0.70.1' })
    await manager.purge()
    expect(manager.status()).toMatchObject({ supported: true, installed: false, installedBytes: 0 })
  })

  it('reports unsupported targets without downloading', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-mobile-frp-component-'))
    temporaryDirectories.push(directory)
    const manager = new FrpComponentManager({ stateDirectory: directory, platform: 'freebsd', arch: 'x64' })
    await manager.initialize()
    expect(manager.status()).toMatchObject({ supported: false, installed: false })
    await expect(manager.install()).rejects.toThrow('frp_component_unsupported')
  })

  it('accepts the official top-level directory while rejecting archive escapes', () => {
    expect(selectFrpExecutableEntry([
      'frp_0.70.1_windows_amd64/',
      'frp_0.70.1_windows_amd64/LICENSE',
      'frp_0.70.1_windows_amd64/frpc.exe',
    ], 'frpc.exe')).toBe('frp_0.70.1_windows_amd64/frpc.exe')
    expect(() => selectFrpExecutableEntry([
      'frp_0.70.1_windows_amd64/',
      '../frpc.exe',
    ], 'frpc.exe')).toThrow('frp_archive_path_invalid')
  })
})
