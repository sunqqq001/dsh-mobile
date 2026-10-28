import { createHash } from 'node:crypto'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CaddyComponentManager, CADDY_VERSION, type CaddyArtifact } from '../src/caddy-component.js'
import * as caddyFiles from '../src/caddy-files.js'
import { execFileText } from '../src/exec-file.js'

vi.mock('../src/caddy-files.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/caddy-files.js')>()
  return { ...actual, removeCaddyTree: vi.fn(actual.removeCaddyTree), renameCaddyPath: vi.fn(actual.renameCaddyPath) }
})
vi.mock('../src/exec-file.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/exec-file.js')>()
  return { ...actual, execFileText: vi.fn(actual.execFileText) }
})

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  const actual = await vi.importActual<typeof import('../src/caddy-files.js')>('../src/caddy-files.js')
  vi.mocked(caddyFiles.removeCaddyTree).mockImplementation(actual.removeCaddyTree)
  vi.mocked(caddyFiles.renameCaddyPath).mockImplementation(actual.renameCaddyPath)
  const execution = await vi.importActual<typeof import('../src/exec-file.js')>('../src/exec-file.js')
  vi.mocked(execFileText).mockImplementation(execution.execFileText)
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

const bytes = Buffer.from('owned Caddy component shutdown fixture')
const hash = createHash('sha256').update(bytes).digest('hex')
const artifact: CaddyArtifact = {
  version: CADDY_VERSION, platform: 'win32', arch: 'x64', downloadUrl: 'https://example.com/caddy.exe',
  downloadBytes: bytes.length, downloadSha256: hash, executableName: 'caddy.exe', executableBytes: bytes.length,
  executableSha256: hash, dnsPluginVersion: 'v0.4.3',
}
const metadata = { version: 'v' + CADDY_VERSION + ' h1:fixture', modules: 'dns.providers.tencentcloud v0.4.3\nNon-standard modules: 1\n' }

async function fixture(overrides: Partial<ConstructorParameters<typeof CaddyComponentManager>[0]> = {}) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-mobile-caddy-close-'))
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  const inspectExecutable = vi.fn(async () => metadata)
  const component = new CaddyComponentManager({ stateDirectory: root, platform: 'win32', arch: 'x64', artifact,
    fetchArtifact: async () => bytes, inspectExecutable, ...overrides })
  cleanups.push(() => component.close())
  return { root, component, inspectExecutable }
}

function verdict<T>(task: Promise<T>) {
  return task.then(value => ({ status: 'fulfilled' as const, value }), error => ({ status: 'rejected' as const, error }))
}

async function expectPending(task: Promise<unknown>): Promise<void> {
  let settled = false
  void task.then(() => { settled = true }, () => { settled = true })
  await new Promise<void>(resolve => setImmediate(resolve))
  expect(settled).toBe(false)
}

describe('managed Caddy component shutdown', () => {
  it('aborts an active download and awaits its cleanup without inspecting or promoting bytes', async () => {
    const timers = vi.spyOn(globalThis, 'setTimeout')
    const cleared = vi.spyOn(globalThis, 'clearTimeout')
    const entered = deferred<AbortSignal>()
    const finished = deferred<void>()
    const { component, inspectExecutable } = await fixture({ fetchArtifact: async (_url, signal) => {
      entered.resolve(signal)
      try { await new Promise<void>((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })) }
      finally { await finished.promise }
      return bytes
    } })
    const result = verdict(component.install())
    const signal = await entered.promise
    const timer = timers.mock.results[timers.mock.calls.findIndex(call => call[1] === 600_000)]?.value
    expect(timer).toBeDefined()
    const closing = component.close()
    expect(signal.aborted).toBe(true)
    expect(cleared).toHaveBeenCalledWith(timer)
    expect(component.close()).toBe(closing)
    await expectPending(closing)
    finished.resolve()
    expect(await result).toMatchObject({ status: 'rejected', error: { message: 'caddy_component_closed' } })
    await closing
    expect(inspectExecutable).not.toHaveBeenCalled()
    expect(await readdir(component.componentRoot)).toEqual([])
  })

  it('holds shutdown for an abort-ignoring fetch and rejects queued and new work without deleting old bytes', async () => {
    const { root } = await fixture()
    const first = new CaddyComponentManager({ stateDirectory: root, platform: 'win32', arch: 'x64', artifact,
      fetchArtifact: async () => bytes, inspectExecutable: async () => metadata })
    cleanups.push(() => first.close())
    await first.install()
    const entered = deferred<AbortSignal>(); const release = deferred<Uint8Array>()
    const inspectExecutable = vi.fn(async () => metadata)
    const component = new CaddyComponentManager({ stateDirectory: root, platform: 'win32', arch: 'x64', artifact,
      inspectExecutable, fetchArtifact: async (_url, signal) => { entered.resolve(signal); return release.promise } })
    cleanups.push(() => component.close())
    await component.initialize(); inspectExecutable.mockClear()
    const result = verdict(component.install())
    const signal = await entered.promise
    const queuedInstall = verdict(component.install()); const queuedPurge = verdict(component.purge())
    const closing = component.close()
    expect(signal.aborted).toBe(true)
    for (const task of [component.install(), component.purge(), component.ensureExecutable(), component.initialize()]) {
      await expect(task).rejects.toThrow('caddy_component_closed')
    }
    await expectPending(closing)
    release.resolve(bytes)
    for (const task of [result, queuedInstall, queuedPurge]) {
      expect(await task).toMatchObject({ status: 'rejected', error: { message: 'caddy_component_closed' } })
    }
    await closing
    expect(inspectExecutable).not.toHaveBeenCalled()
    expect(await readFile(component.executable)).toEqual(bytes)
    expect(await readdir(component.componentRoot)).toEqual([CADDY_VERSION])
    expect(component.status().installed).toBe(true)
  })

  it('waits for in-flight executable inspection and never starts promotion after shutdown', async () => {
    const entered = deferred<void>(); const release = deferred<typeof metadata>()
    const promoteDirectory = vi.fn(async () => undefined)
    const { component } = await fixture({ inspectExecutable: async () => { entered.resolve(); return release.promise }, promoteDirectory })
    const result = verdict(component.install())
    await entered.promise
    const closing = component.close()
    await expectPending(closing)
    release.resolve(metadata)
    expect(await result).toMatchObject({ status: 'rejected', error: { message: 'caddy_component_closed' } })
    await closing
    expect(promoteDirectory).not.toHaveBeenCalled()
    expect(await readdir(component.componentRoot)).toEqual([])
  })

  it.each(['initialize', 'ensureExecutable'] as const)('owns an admitted %s inspection until completion', async operation => {
    const { component, root } = await fixture()
    await component.install(); await component.close()
    const entered = deferred<void>(); const release = deferred<typeof metadata>()
    const next = new CaddyComponentManager({ stateDirectory: root, platform: 'win32', arch: 'x64', artifact,
      inspectExecutable: async () => { entered.resolve(); return release.promise } })
    cleanups.push(() => next.close())
    const result = verdict(next[operation]())
    await entered.promise
    const closing = next.close(); await expectPending(closing)
    release.resolve(metadata)
    expect(await result).toMatchObject({ status: 'rejected', error: { message: 'caddy_component_closed' } })
    await closing
    expect(await readFile(next.executable)).toEqual(bytes)
  })

  it('waits for an already-started promotion to commit and retains the committed executable', async () => {
    const entered = deferred<void>(); const release = deferred<void>()
    const { component, root } = await fixture({ promoteDirectory: async (source, target) => {
      entered.resolve(); await release.promise
      await caddyFiles.renameCaddyPath(root, source, target)
    } })
    const result = verdict(component.install())
    await entered.promise
    const closing = component.close(); await expectPending(closing)
    release.resolve()
    expect(await result).toMatchObject({ status: 'fulfilled', value: { installed: true } })
    await closing
    expect(await readFile(component.executable)).toEqual(bytes)
    expect(await readdir(component.componentRoot)).toEqual([CADDY_VERSION])
  })

  it('settles rollback after an admitted promotion fails during shutdown', async () => {
    const { root } = await fixture()
    const first = new CaddyComponentManager({ stateDirectory: root, platform: 'win32', arch: 'x64', artifact,
      fetchArtifact: async () => bytes, inspectExecutable: async () => metadata })
    cleanups.push(() => first.close()); await first.install()
    const entered = deferred<void>(); const release = deferred<void>()
    const failure = new Error('promotion_failed')
    const component = new CaddyComponentManager({ stateDirectory: root, platform: 'win32', arch: 'x64', artifact,
      fetchArtifact: async () => bytes, inspectExecutable: async () => metadata,
      promoteDirectory: async () => { entered.resolve(); await release.promise; throw failure } })
    cleanups.push(() => component.close()); await component.initialize()
    const result = verdict(component.install()); await entered.promise
    const closing = component.close(); await expectPending(closing)
    release.resolve()
    expect(await result).toEqual({ status: 'rejected', error: failure })
    await closing
    expect(await readFile(component.executable)).toEqual(bytes)
    expect(await readdir(component.componentRoot)).toEqual([CADDY_VERSION])
  })

  it('restores an old installation if shutdown arrives while moving it to the recovery backup', async () => {
    const { component, root } = await fixture(); await component.install(); await component.close()
    const entered = deferred<void>(); const release = deferred<void>()
    const actual = await vi.importActual<typeof import('../src/caddy-files.js')>('../src/caddy-files.js')
    vi.mocked(caddyFiles.renameCaddyPath).mockImplementation(async (state, source, target) => {
      if (source === component.componentStorage) { entered.resolve(); await release.promise }
      await actual.renameCaddyPath(state, source, target)
    })
    const promoteDirectory = vi.fn(actual.renameCaddyPath.bind(undefined, root))
    const next = new CaddyComponentManager({ stateDirectory: root, platform: 'win32', arch: 'x64', artifact,
      fetchArtifact: async () => bytes, inspectExecutable: async () => metadata, promoteDirectory })
    cleanups.push(() => next.close()); await next.initialize()
    const result = verdict(next.install()); await entered.promise
    const closing = next.close(); await expectPending(closing)
    release.resolve()
    expect(await result).toMatchObject({ status: 'rejected', error: { message: 'caddy_component_closed' } })
    await closing
    expect(promoteDirectory).not.toHaveBeenCalled()
    expect(await readFile(next.executable)).toEqual(bytes)
    expect(await readdir(next.componentRoot)).toEqual([CADDY_VERSION])
  })

  it('does not delete the only recovery backup when promotion and restoration fail', async () => {
    const { component, root } = await fixture()
    await component.install(); await component.close()
    const promotionError = new Error('promotion_failed'); const restoreError = new Error('restoration_failed')
    const actual = await vi.importActual<typeof import('../src/caddy-files.js')>('../src/caddy-files.js')
    vi.mocked(caddyFiles.renameCaddyPath).mockImplementation(async (state, source, target) => {
      if (source.includes('.previous-')) throw restoreError
      await actual.renameCaddyPath(state, source, target)
    })
    const next = new CaddyComponentManager({ stateDirectory: root, platform: 'win32', arch: 'x64', artifact,
      fetchArtifact: async () => bytes, inspectExecutable: async () => metadata,
      promoteDirectory: async () => { throw promotionError } })
    cleanups.push(() => next.close()); await next.initialize()
    const result = await verdict(next.install())
    expect(result.status).toBe('rejected')
    if (result.status !== 'rejected') throw new Error('expected failed rollback')
    expect(result.error).toMatchObject({ message: 'caddy_component_rollback_failed', errors: [promotionError, restoreError] })
    await next.close()
    expect(next.status()).toMatchObject({ installed: false, errorCode: 'caddy_component_invalid' })
    const entries = await readdir(next.componentRoot)
    expect(entries).toHaveLength(1); expect(entries[0]).toMatch(/^\.previous-/u)
    expect(await readFile(join(next.componentRoot, entries[0]!, artifact.executableName))).toEqual(bytes)
  })

  it('waits for a purge that already owns its deletion and does not reopen admission', async () => {
    const { component } = await fixture(); await component.install()
    const entered = deferred<void>(); const release = deferred<void>()
    const actual = await vi.importActual<typeof import('../src/caddy-files.js')>('../src/caddy-files.js')
    vi.mocked(caddyFiles.removeCaddyTree).mockImplementation(async (root, path) => {
      if (path === component.componentRoot) { entered.resolve(); await release.promise }
      await actual.removeCaddyTree(root, path)
    })
    const result = verdict(component.purge()); await entered.promise
    const closing = component.close(); await expectPending(closing)
    await expect(component.purge()).rejects.toThrow('caddy_component_closed')
    release.resolve()
    expect(await result).toMatchObject({ status: 'fulfilled', value: { installed: false } })
    await closing
    await expect(readdir(component.componentRoot)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('never starts the modules subprocess after a version subprocess completes during shutdown', async () => {
    const { component, root } = await fixture(); await component.install(); await component.close()
    const entered = deferred<void>(); const release = deferred<{ stdout: string; stderr: string }>()
    const execute = vi.mocked(execFileText).mockImplementation(async () => { entered.resolve(); return release.promise })
    execute.mockClear()
    const next = new CaddyComponentManager({ stateDirectory: root, platform: 'win32', arch: 'x64', artifact })
    cleanups.push(() => next.close())
    const result = verdict(next.ensureExecutable()); await entered.promise
    const closing = next.close(); await expectPending(closing)
    release.resolve({ stdout: metadata.version, stderr: '' })
    expect(await result).toMatchObject({ status: 'rejected', error: { message: 'caddy_component_closed' } })
    await closing
    expect(execute).toHaveBeenCalledTimes(1)
    expect(execute.mock.calls[0]?.[1]).toEqual(['version'])
  })

  it('preserves the operation and cleanup errors, retries only owned temporary cleanup, and keeps admission closed', async () => {
    const remove = vi.mocked(caddyFiles.removeCaddyTree)
    const actual = await vi.importActual<typeof import('../src/caddy-files.js')>('../src/caddy-files.js')
    const failure = new Error('download_failed'); const cleanupFailure = new Error('cleanup_failed')
    let blocked = true
    remove.mockImplementation(async (root, path) => {
      if (blocked && path.includes('install-')) throw cleanupFailure
      await actual.removeCaddyTree(root, path)
    })
    const { component } = await fixture({ fetchArtifact: async () => { throw failure } })
    const result = await verdict(component.install())
    expect(result.status).toBe('rejected')
    if (result.status !== 'rejected') throw new Error('expected install failure')
    expect(result.error).toBeInstanceOf(AggregateError)
    expect(result.error.errors).toEqual([failure, cleanupFailure, cleanupFailure])
    await expect(component.close()).rejects.toBeInstanceOf(AggregateError)
    blocked = false
    await component.close()
    expect(await readdir(join(component.componentRoot, '..', '..', 'staging', 'caddy'))).toEqual([])
    expect(await readdir(component.componentRoot)).toEqual([])
    await expect(component.install()).rejects.toThrow('caddy_component_closed')
  })

  it('does not turn a previously reported verification failure into a shutdown failure', async () => {
    const { component, inspectExecutable } = await fixture({ fetchArtifact: async () => Buffer.alloc(bytes.length, 90) })
    await expect(component.install()).rejects.toThrow('caddy_download_hash_mismatch')
    await expect(component.close()).resolves.toBeUndefined()
    expect(inspectExecutable).not.toHaveBeenCalled()
    expect(await readdir(component.componentRoot)).toEqual([])
  })
})
