import { mkdtemp, lstat, readFile, readdir, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ClientModulePreferenceStore, parseExcludedClientModules } from '../src/client-module-preferences.js'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })

async function fixture(defaults: readonly string[] = []): Promise<{ store: ClientModulePreferenceStore; file: string; root: string }> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-mobile-module-preferences-'))
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  const file = join(root, 'preferences.json')
  return { root, file, store: new ClientModulePreferenceStore(file, defaults) }
}

const first = 'a'.repeat(32)
const second = 'b'.repeat(32)
const valid = async (): Promise<void> => undefined

describe('client module preference storage', () => {
  it('initializes concurrently without creating a file or overwriting later selections', async () => {
    const { store, file, root } = await fixture(['configured-module'])
    await Promise.all([store.initialize(), store.initialize(), store.read(first)])
    await expect(lstat(file)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await store.read(first)).toMatchObject({ source: 'plugin', excludedClientModules: ['configured-module'] })
    await store.configure(['selected'], undefined, valid)
    await store.initialize()
    expect(await store.read(first)).toMatchObject({ source: 'computer', excludedClientModules: ['selected'] })
    expect(await readdir(root)).toEqual(['preferences.json'])
    expect(await new ClientModulePreferenceStore(file, ['different-default']).read(first))
      .toMatchObject({ source: 'computer', excludedClientModules: ['selected'] })
  })

  it('keeps device overrides independent, including an explicit empty selection', async () => {
    const { store, file } = await fixture(['default'])
    await store.configure(['one'], first, valid)
    await store.configure([], second, valid)
    expect(await store.read(first)).toMatchObject({ source: 'device', excludedClientModules: ['one'], defaultExcludedClientModules: ['default'] })
    expect(await store.read(second)).toMatchObject({ source: 'device', excludedClientModules: [] })
    expect(await store.read()).toMatchObject({ source: 'plugin', excludedClientModules: ['default'] })
    const reopened = new ClientModulePreferenceStore(file, ['default'])
    expect(await reopened.read(first)).toMatchObject({ source: 'device', excludedClientModules: ['one'] })
    expect(await reopened.read(second)).toMatchObject({ source: 'device', excludedClientModules: [] })
  })

  it('resets only its selected scope and falls back to the current computer or plugin default', async () => {
    const { store } = await fixture(['plugin'])
    await store.configure(['computer'], undefined, valid)
    await store.configure(['one'], first, valid)
    await store.configure(['two'], second, valid)
    expect(await store.reset(first, valid)).toMatchObject({ source: 'computer', excludedClientModules: ['computer'] })
    expect(await store.read(second)).toMatchObject({ source: 'device', excludedClientModules: ['two'] })
    expect(await store.reset(undefined, valid)).toMatchObject({ source: 'plugin', excludedClientModules: ['plugin'] })
    expect(await store.read(first)).toMatchObject({ source: 'plugin', excludedClientModules: ['plugin'] })
    expect(await store.read(second)).toMatchObject({ source: 'device', excludedClientModules: ['two'] })
  })

  it('serializes validation and commits so concurrent device choices cannot overwrite one another', async () => {
    const { store } = await fixture()
    let enter!: () => void
    let release!: () => void
    const entered = new Promise<void>(resolve => { enter = resolve })
    const gate = new Promise<void>(resolve => { release = resolve })
    let secondValidated = false
    const one = store.configure(['one'], first, async () => { enter(); await gate })
    await entered
    const two = store.configure(['two'], second, async () => { secondValidated = true })
    try { expect(secondValidated).toBe(false) } finally { release() }
    await Promise.all([one, two])
    expect(secondValidated).toBe(true)
    expect(await store.read(first)).toMatchObject({ excludedClientModules: ['one'] })
    expect(await store.read(second)).toMatchObject({ excludedClientModules: ['two'] })
  })

  it('retains the complete previous file and preference when current-manifest validation rejects', async () => {
    const { store, file } = await fixture()
    await store.configure(['old'], first, valid)
    const before = await readFile(file)
    await expect(store.configure(['new'], first, async () => { throw new Error('dependency still active') })).rejects.toThrow('dependency still active')
    await expect(store.reset(first, async () => { throw new Error('default no longer installed') })).rejects.toThrow('default no longer installed')
    expect(await readFile(file)).toEqual(before)
    expect(await store.read(first)).toMatchObject({ excludedClientModules: ['old'] })
  })

  it.each(['broken json', '{"version":2,"devices":{}}', '{"version":1,"devices":{"not-a-device":[]}}', '{"version":1,"devices":{},"computer":["same","same"]}'])
    ('fails initialization loudly for invalid existing data: %s', async body => {
      const { store, file } = await fixture()
      await writeFile(file, body)
      await expect(store.initialize()).rejects.toThrow()
      await expect(store.initialize()).rejects.toThrow()
      expect(await readFile(file, 'utf8')).toBe(body)
    })

  it('refuses non-file targets on load and on save without removing the target', async () => {
    const { store, file } = await fixture()
    await store.initialize()
    await mkdir(file)
    await expect(store.configure([], undefined, valid)).rejects.toThrow('regular file')
    await expect(new ClientModulePreferenceStore(file, []).initialize()).rejects.toThrow('regular file')
    expect((await lstat(file)).isDirectory()).toBe(true)
  })

  it('removes only the revoked device and never creates state for a missing device', async () => {
    const { store, file } = await fixture(['default'])
    await store.removeDevice(first)
    await expect(lstat(file)).rejects.toMatchObject({ code: 'ENOENT' })
    await store.configure(['computer'], undefined, valid)
    await store.configure(['one'], first, valid)
    await store.configure(['two'], second, valid)
    await store.removeDevice(first)
    expect(await store.read(first)).toMatchObject({ source: 'computer', excludedClientModules: ['computer'] })
    expect(await store.read(second)).toMatchObject({ source: 'device', excludedClientModules: ['two'] })
  })

  it('rejects the bounded file write before replacing the old state or leaving temporary files', async () => {
    const { store, file, root } = await fixture()
    await store.configure(['old'], first, valid)
    const original = await readFile(file)
    await expect(store.configure(['x'.repeat(1024 * 1024)], first, valid)).rejects.toThrow('client_module_preferences_limit')
    expect(await readFile(file)).toEqual(original)
    expect(await readdir(root)).toEqual(['preferences.json'])
    expect(await store.read(first)).toMatchObject({ excludedClientModules: ['old'] })
  })

  it.each([null, {}, [''], ['trim '], ['line\nbreak'], ['same', 'same'], [1]])('rejects malformed selection %j before writing', async value => {
    const { store, file } = await fixture()
    expect(() => parseExcludedClientModules(value)).toThrow('excluded_client_modules_invalid')
    await expect(store.configure(value, first, valid)).rejects.toThrow('excluded_client_modules_invalid')
    await expect(lstat(file)).rejects.toMatchObject({ code: 'ENOENT' })
  })
})
