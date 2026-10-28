import { lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, relative } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { loadOrCreateInstallationId } from '../src/installation-id.js'

const publication = vi.hoisted(() => ({
  pauseNextWrite: false,
  writeStarted: undefined as (() => void) | undefined,
  writeGate: undefined as Promise<void> | undefined,
  rejectWrite: false,
  rejectClose: false,
  rejectPermissions: false,
  rejectLink: false,
  rejectCleanup: false,
  successfulLinks: 0,
}))

vi.mock('node:fs/promises', async () => {
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
  return {
    ...actual,
    async open(...args: Parameters<typeof actual.open>) {
      const handle = await actual.open(...args)
      const write = handle.writeFile.bind(handle)
      if (publication.pauseNextWrite) {
        publication.pauseNextWrite = false
        const announce = publication.writeStarted
        const gate = publication.writeGate
        vi.spyOn(handle, 'writeFile').mockImplementation(async (...values: Parameters<typeof handle.writeFile>) => {
          announce?.()
          await gate
          return write(...values)
        })
      } else if (publication.rejectWrite) {
        vi.spyOn(handle, 'writeFile').mockRejectedValue(new Error('fixture write failure'))
      }
      if (publication.rejectClose) {
        const close = handle.close.bind(handle)
        vi.spyOn(handle, 'close').mockImplementation(async () => {
          await close()
          throw new Error('fixture close failure')
        })
      }
      return handle
    },
    async link(...args: Parameters<typeof actual.link>) {
      if (publication.rejectLink) throw Object.assign(new Error('fixture hard links unavailable'), { code: 'ENOTSUP' })
      await actual.link(...args)
      publication.successfulLinks += 1
    },
    async unlink(...args: Parameters<typeof actual.unlink>) {
      if (publication.rejectCleanup && String(args[0]).endsWith('.tmp')) throw new Error('fixture cleanup failure')
      await actual.unlink(...args)
    },
  }
})

vi.mock('../src/private-file.js', async () => {
  const actual = await vi.importActual<typeof import('../src/private-file.js')>('../src/private-file.js')
  return {
    ...actual,
    async restrictPrivateFile(...args: Parameters<typeof actual.restrictPrivateFile>) {
      if (publication.rejectPermissions && args[0].endsWith('.tmp')) throw new Error('fixture permission failure')
      await actual.restrictPrivateFile(...args)
    },
  }
})

const temporaryDirectories: string[] = []

afterEach(async () => {
  publication.pauseNextWrite = false
  publication.writeStarted = undefined
  publication.writeGate = undefined
  publication.rejectWrite = false
  publication.rejectClose = false
  publication.rejectPermissions = false
  publication.rejectLink = false
  publication.rejectCleanup = false
  publication.successfulLinks = 0
  vi.restoreAllMocks()
  await Promise.all(temporaryDirectories.splice(0).map(async directory => {
    const withinTemp = relative(tmpdir(), directory)
    if (!withinTemp || withinTemp.startsWith('..') || isAbsolute(withinTemp)) throw new Error('unsafe test cleanup path')
    await rm(directory, { recursive: true, force: true })
  }))
})

async function installationFile(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-mobile-installation-id-'))
  temporaryDirectories.push(directory)
  return join(directory, 'installation-id')
}

describe('plugin installation identity', () => {
  it('persists one private random ID across repeated loads', async () => {
    const file = await installationFile()
    const first = await loadOrCreateInstallationId(file)
    expect(first).toMatch(/^[a-f0-9]{64}$/u)
    expect(await readFile(file, 'utf8')).toBe(`${first}\n`)
    expect(await loadOrCreateInstallationId(file)).toBe(first)
  })

  it('creates different IDs in separate private roots', async () => {
    const first = await loadOrCreateInstallationId(await installationFile())
    const second = await loadOrCreateInstallationId(await installationFile())
    expect(first).not.toBe(second)
  })

  it('publishes one complete marker for parallel loads from the same root', async () => {
    const file = await installationFile()
    const identities = await Promise.all(Array.from({ length: 8 }, () => loadOrCreateInstallationId(file)))
    expect(new Set(identities).size).toBe(1)
    expect(publication.successfulLinks).toBe(1)
    expect(await readFile(file, 'utf8')).toBe(`${identities[0]}\n`)
    expect(await readdir(dirname(file))).toEqual(['installation-id'])
  })

  it('keeps an incomplete candidate private while another caller publishes the shared marker', async () => {
    const file = await installationFile()
    let releaseWrite!: () => void
    let announceWrite!: () => void
    publication.writeGate = new Promise<void>(resolve => { releaseWrite = resolve })
    const writeStarted = new Promise<void>(resolve => { announceWrite = resolve })
    publication.writeStarted = announceWrite
    publication.pauseNextWrite = true
    const first = loadOrCreateInstallationId(file)
    try {
      await writeStarted
      const candidates = await readdir(dirname(file))
      expect(candidates).toHaveLength(1)
      expect(candidates[0]).toMatch(/^\.installation-id\.[a-f0-9]{24}\.tmp$/u)
      expect((await lstat(join(dirname(file), candidates[0]!))).size).toBe(0)
      await expect(lstat(file)).rejects.toMatchObject({ code: 'ENOENT' })

      const second = await loadOrCreateInstallationId(file)
      expect(await readFile(file, 'utf8')).toBe(`${second}\n`)
      releaseWrite()
      expect(await first).toBe(second)
      expect(publication.successfulLinks).toBe(1)
      expect(await readdir(dirname(file))).toEqual(['installation-id'])
    } finally {
      releaseWrite()
      await Promise.allSettled([first])
    }
  })

  it.each(['write', 'close', 'permissions', 'link'] as const)('does not publish an identity after a candidate %s failure', async stage => {
    const file = await installationFile()
    publication.rejectWrite = stage === 'write'
    publication.rejectClose = stage === 'close'
    publication.rejectPermissions = stage === 'permissions'
    publication.rejectLink = stage === 'link'
    await expect(loadOrCreateInstallationId(file)).rejects.toThrow(stage === 'link' ? 'must support hard links' : `fixture ${stage === 'permissions' ? 'permission' : stage} failure`)
    await expect(lstat(file)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(publication.successfulLinks).toBe(0)
    expect(await readdir(dirname(file))).toEqual([])
  })

  it('retains both a candidate write failure and its close failure', async () => {
    const file = await installationFile()
    publication.rejectWrite = true
    publication.rejectClose = true
    const failure = await loadOrCreateInstallationId(file).catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(AggregateError)
    if (!(failure instanceof AggregateError)) throw new Error('candidate write did not retain its close failure')
    expect(failure.errors).toEqual([
      expect.objectContaining({ message: 'fixture write failure' }),
      expect.objectContaining({ message: 'fixture close failure' }),
    ])
    await expect(lstat(file)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await readdir(dirname(file))).toEqual([])
  })

  it('retains publication and cleanup failures without replacing a marker', async () => {
    const file = await installationFile()
    publication.rejectLink = true
    publication.rejectCleanup = true
    const failure = await loadOrCreateInstallationId(file).catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(AggregateError)
    if (!(failure instanceof AggregateError)) throw new Error('publication did not return both failures')
    expect(failure.errors).toHaveLength(2)
    expect(failure.errors[0]).toMatchObject({ message: expect.stringContaining('must support hard links') })
    expect(failure.errors[1]).toMatchObject({ message: 'fixture cleanup failure' })
    await expect(lstat(file)).rejects.toMatchObject({ code: 'ENOENT' })
    const candidates = await readdir(dirname(file))
    expect(candidates).toHaveLength(1)
    publication.rejectCleanup = false
    await unlink(join(dirname(file), candidates[0]!))
  })

  it('keeps the published marker readable when candidate cleanup fails', async () => {
    const file = await installationFile()
    publication.rejectCleanup = true
    await expect(loadOrCreateInstallationId(file)).rejects.toThrow('fixture cleanup failure')
    const contents = await readFile(file, 'utf8')
    expect(contents).toMatch(/^[a-f0-9]{64}\n$/u)
    expect(await loadOrCreateInstallationId(file)).toBe(contents.slice(0, -1))
    expect(publication.successfulLinks).toBe(1)
    const candidates = (await readdir(dirname(file))).filter(name => name.endsWith('.tmp'))
    expect(candidates).toHaveLength(1)
    publication.rejectCleanup = false
    await unlink(join(dirname(file), candidates[0]!))
    expect(await readdir(dirname(file))).toEqual(['installation-id'])
  })

  it('rejects invalid, oversized, and non-file markers without replacing them', async () => {
    const invalid = await installationFile()
    await writeFile(invalid, `${'A'.repeat(64)}\n`)
    await expect(loadOrCreateInstallationId(invalid)).rejects.toThrow('installation_id_invalid')
    expect(await readFile(invalid, 'utf8')).toBe(`${'A'.repeat(64)}\n`)

    const oversized = await installationFile()
    await writeFile(oversized, `${'a'.repeat(65)}\n`)
    await expect(loadOrCreateInstallationId(oversized)).rejects.toThrow('installation_id_invalid')

    const directory = await installationFile()
    await mkdir(directory)
    await expect(loadOrCreateInstallationId(directory)).rejects.toThrow('installation_id_invalid')
  })

  it.skipIf(process.platform === 'win32')('rejects a symlink marker', async () => {
    const target = await installationFile()
    await writeFile(target, `${'a'.repeat(64)}\n`)
    const link = await installationFile()
    await symlink(target, link)
    await expect(loadOrCreateInstallationId(link)).rejects.toThrow('installation_id_invalid')
    expect((await lstat(link)).isSymbolicLink()).toBe(true)
  })

  it('rejects a linked state root without reading or replacing the marker it projects', async () => {
    const file = await installationFile()
    const outside = await installationFile()
    const expected = `${'a'.repeat(64)}\n`
    await writeFile(outside, expected)
    const alias = join(dirname(file), 'alias')
    await symlink(dirname(outside), alias, process.platform === 'win32' ? 'junction' : 'dir')
    await expect(loadOrCreateInstallationId(join(alias, 'installation-id'))).rejects.toThrow('installation_id_path_invalid')
    expect(await readFile(outside, 'utf8')).toBe(expected)
    expect(await readdir(dirname(outside))).toEqual(['installation-id'])
  })
})
