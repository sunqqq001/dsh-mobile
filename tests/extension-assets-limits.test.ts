import { Context } from '@deepseek-ai/cordis'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { EXTENSION_LIMITS, MobileAccessService } from '../src/extensions.js'

interface OwnedAssetFixture { run(count: number): Promise<void>; cleanup(): Promise<void> }
let active: OwnedAssetFixture | undefined

// Each real boundary case creates up to 257 files; acceptance fingerprints the 256-file tree twice.
// Keep this finite filesystem work and its drain budget local, not on the general extension suite.
const ASSET_FIXTURE_BUDGET_MS = 60_000
afterEach(async () => {
  const fixture = active; active = undefined
  await fixture?.cleanup()
}, ASSET_FIXTURE_BUDGET_MS)

function assetFixture(writeAsset: (file: string, body: string) => Promise<void> = (file, contents) => writeFile(file, contents)): OwnedAssetFixture {
  const controller = new AbortController()
  const signal = controller.signal
  const started = performance.now()
  let phase = 'not started'; let written = 0; let count = 0; let bodySettled = false
  let root: string | undefined; let context: Context | undefined; let service: MobileAccessService | undefined
  let body: Promise<void> | undefined
  let cleanupTask: Promise<void> | undefined
  const diagnostic = (): string => `phase=${phase}; elapsed=${Math.round(performance.now() - started)}ms; files=${written}/${count}`
  const step = async <T>(name: string, operation: () => Promise<T>): Promise<T> => {
    phase = name; signal.throwIfAborted()
    const result = await operation()
    signal.throwIfAborted()
    return result
  }
  const work = async (): Promise<void> => {
    phase = 'allocate root'
    root = await mkdtemp(join(tmpdir(), 'dsh-mobile-extension-count-'))
    signal.throwIfAborted()
    const directory = join(root, 'demo'); const assets = join(directory, 'assets')
    const imported = join(root, 'host-imported'); const activated = join(root, 'host-activated')
    await step('create assets directory', () => mkdir(assets, { recursive: true }))
    await step('write manifest', () => writeFile(join(directory, 'extension.json'), JSON.stringify({ schemaVersion: 1, id: 'demo', name: 'Count fixture', version: '1' })))
    await step('write client', () => writeFile(join(directory, 'mobile.js'), 'window.dshMobile.define({ apiVersion: 1, id: "demo", activate() {} })'))
    await step('write host', () => writeFile(join(directory, 'host.mjs'), `import { writeFile } from 'node:fs/promises'
await writeFile(${JSON.stringify(imported)}, 'imported')
export default async api => {
  await writeFile(${JSON.stringify(activated)}, 'activated')
  api.action('ping', { run: () => 'pong' })
}
`))
    phase = 'write real assets'
    let next = 0
    const results = await Promise.allSettled(Array.from({ length: 8 }, async () => {
      while (next < count) {
        signal.throwIfAborted()
        const index = next++
        await writeAsset(join(assets, `${String(index).padStart(4, '0')}.txt`), 'asset-' + String(index))
        written++
        signal.throwIfAborted()
      }
    }))
    const failures: unknown[] = []
    for (const result of results) if (result.status === 'rejected') { const reason: unknown = result.reason; failures.push(reason) }
    if (failures.length > 0) throw new AggregateError(failures, 'Owned asset writes failed')
    expect((await step('count real files', () => readdir(assets))).length).toBe(count)
    signal.throwIfAborted()
    context = new Context()
    service = new MobileAccessService(context)
    const current = service
    await step('startLocal and asset fingerprints', () => current.startLocal(root!, context!))
    if (count === EXTENSION_LIMITS.assetFiles) {
      expect(current.status()).toEqual({ loaded: 1, failed: 0 })
      const entries = current.manifest()
      expect(entries).toHaveLength(1)
      expect(entries[0]).toMatchObject({ id: 'demo', generation: expect.any(String) })
      expect(await step('read host import marker', () => readFile(imported, 'utf8'))).toBe('imported')
      expect(await step('read host activation marker', () => readFile(activated, 'utf8'))).toBe('activated')
      for (let index = 0; index < count; index++) {
        const asset = await step('read accepted asset snapshots', () => current.readAsset('demo', `${String(index).padStart(4, '0')}.txt`, signal, entries[0]!.generation))
        expect(asset.body.toString()).toBe('asset-' + String(index))
      }
      expect(await step('invoke accepted host', () => current.invoke('demo', 'ping', {}, { deviceId: 'owned-device', signal }))).toBe('pong')
    } else {
      expect(current.manifest()).toEqual([])
      expect(current.status()).toEqual({ loaded: 0, failed: 1 })
      expect(current.hostStatus().hosts).toEqual([])
    }
    await step('stop watcher and drain refresh', () => current.stopLocal())
    if (count > EXTENSION_LIMITS.assetFiles) {
      await expect(readFile(imported)).rejects.toMatchObject({ code: 'ENOENT' })
      await expect(readFile(activated)).rejects.toMatchObject({ code: 'ENOENT' })
    }
    phase = 'complete'
  }
  return {
    run(value) {
      count = value
      body = work().finally(() => { bodySettled = true })
      return body.catch((error: unknown) => { throw new Error('Extension asset-count fixture failed; ' + diagnostic(), { cause: error }) })
    },
    cleanup() {
      cleanupTask ??= (async () => {
        const interrupted = !bodySettled
        if (interrupted) console.warn('Extension asset-count fixture interrupted; ' + diagnostic())
        controller.abort(new Error('Owned asset-count fixture teardown'))
        const errors: unknown[] = []
        let stopped = true
        try { await service?.stopLocal() } catch (error) { stopped = false; errors.push(error) }
        // Aborting does not stop an in-flight filesystem call. Wait for all setup writes and scans before removal.
        try { await body } catch (_error) { /* The case already reports its body failure or runner timeout. */ }
        if (!bodySettled) { stopped = false; errors.push(new Error('Asset fixture body did not reach quiescence')) }
        try { await service?.stopLocal() } catch (error) { stopped = false; errors.push(error) }
        if (stopped) {
          try { await context?.fiber.dispose() } catch (error) { errors.push(error) }
          if (root !== undefined) {
            try { await rm(root, { recursive: true, force: true }) } catch (error) { errors.push(error) }
          }
        }
        if (errors.length > 0) throw new AggregateError(errors, 'Extension asset-count cleanup failed; ' + diagnostic()
          + (stopped ? '' : '; retained owned root: ' + root))
      })()
      return cleanupTask
    },
  }
}

describe('real extension asset file-count limits', () => {
  it.each([256, 257])('handles a real %i-file tree before publishing or activating its host', async count => {
    expect(EXTENSION_LIMITS.assetFiles).toBe(256)
    active = assetFixture()
    await active.run(count)
  }, ASSET_FIXTURE_BUDGET_MS)

  it('drains admitted setup writes before removing their directory after cancellation', async () => {
    let enter!: (file: string) => void; let release!: () => void; let finishedWrites = 0
    const entered = new Promise<string>(resolve => { enter = resolve })
    const barrier = new Promise<void>(resolve => { release = resolve })
    active = assetFixture(async (file, contents) => {
      enter(file)
      await barrier
      await writeFile(file, contents)
      finishedWrites++
    })
    const fixture = active
    const running = fixture.run(257).catch((error: unknown) => error)
    let closing: Promise<void> | undefined
    try {
      const file = await entered
      const root = dirname(dirname(dirname(file)))
      let closed = false
      closing = fixture.cleanup().then(() => { closed = true })
      expect((await readFile(join(root, 'demo', 'extension.json'), 'utf8'))).toContain('Count fixture')
      expect(closed).toBe(false)
      release()
      await closing
      expect(finishedWrites).toBe(8)
      const failure = await running
      expect(failure).toBeInstanceOf(Error)
      expect(failure).toMatchObject({ cause: { message: 'Owned asset writes failed' } })
      await expect(readFile(join(root, 'demo', 'extension.json'))).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      release()
      await running
      await closing
    }
  })
})
