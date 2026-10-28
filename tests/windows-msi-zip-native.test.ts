import { createHash } from 'node:crypto'
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { extractWindowsMsiArchive } from '../src/windows-msi-extract.js'
import { writeWindowsMsiZipFixture as createZip, type WindowsMsiZipEntryFixture as ZipEntryFixture } from './helpers/windows-msi-zip-fixture.js'

const prefix = 'dsh-mobile-native-zip-negative-'
const digest = (value: Uint8Array): string => createHash('sha256').update(value).digest('hex')

async function withOwnedFixture(operation: (archive: string, destination: string, sentinel: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), prefix))
  try {
    const destination = join(root, '中文 输出 空格')
    await mkdir(destination)
    const sentinel = join(root, 'outside.msi')
    await writeFile(sentinel, 'unrelated sentinel', { flag: 'wx' })
    await operation(join(root, '只读 包.zip'), destination, sentinel)
    expect(await readFile(sentinel, 'utf8')).toBe('unrelated sentinel')
  } finally {
    expect(dirname(resolve(root))).toBe(resolve(tmpdir()))
    expect(basename(root).startsWith(prefix)).toBe(true)
    const info = await lstat(root)
    expect(info.isDirectory() && !info.isSymbolicLink()).toBe(true)
    await rm(root, { recursive: true })
    await expect(lstat(root)).rejects.toMatchObject({ code: 'ENOENT' })
  }
}

const rejectedCases: readonly { readonly name: string; readonly entries: readonly ZipEntryFixture[] }[] = [
  { name: 'missing MSI', entries: [{ name: 'readme.txt', bytes: 4 }] },
  { name: 'multiple MSI files', entries: [{ name: 'one.msi', bytes: 4 }, { name: 'two.MSI', bytes: 4 }] },
  { name: 'duplicate MSI names', entries: [{ name: 'installer.msi', bytes: 4 }, { name: 'installer.msi', bytes: 4 }] },
  { name: '129 entries', entries: [{ name: 'installer.msi', bytes: 4 }, ...Array.from({ length: 128 }, (_, index) => ({ name: `extra-${index}.txt`, bytes: 0 }))] },
  { name: 'parent traversal', entries: [{ name: '../outside.msi', bytes: 4 }] },
  { name: 'absolute path', entries: [{ name: '/outside.msi', bytes: 4 }] },
  { name: 'drive path', entries: [{ name: 'C:/outside.msi', bytes: 4 }] },
  { name: 'alternate data stream', entries: [{ name: 'installer:stream.msi', bytes: 4 }] },
  { name: 'Unix symlink metadata', entries: [{ name: 'installer.msi', bytes: 4, attributes: -1_610_612_736 }] },
  { name: 'DOS reparse metadata', entries: [{ name: 'installer.msi', bytes: 4, attributes: 0x400 }] },
  { name: '33 MiB uncompressed MSI', entries: [{ name: 'installer.msi', bytes: 33 * 1024 * 1024 }] },
]

// Real System32 Windows PowerShell/.NET only; other platforms explicitly skip this lane.
describe.skipIf(process.platform !== 'win32')('native Windows ZIP-to-MSI reader', () => {
  it('reads one controlled MSI through Unicode paths and releases every file for cleanup', async () => {
    await withOwnedFixture(async (archive, destination) => {
      await createZip(archive, [{ name: 'nested/fixture.msi', bytes: 4 }])
      const before = digest(await readFile(archive))
      expect(await extractWindowsMsiArchive(archive, destination)).toBe(join(destination, 'installer.msi'))
      expect(await readFile(join(destination, 'installer.msi'))).toEqual(Buffer.alloc(4))
      expect(await readdir(destination)).toEqual(['installer.msi'])
      expect(digest(await readFile(archive))).toBe(before)
    })
  }, 180_000)

  it.each(rejectedCases)('rejects $name before output while preserving the archive and unrelated files', async ({ entries }) => {
    await withOwnedFixture(async (archive, destination) => {
      await createZip(archive, entries)
      const before = digest(await readFile(archive))
      await expect(extractWindowsMsiArchive(archive, destination)).rejects.toMatchObject({ message: 'cpolar_extract_archive_failed', stage: 'archive', nativeCode: 1 })
      expect(await readdir(destination)).toEqual([])
      expect(digest(await readFile(archive))).toBe(before)
    })
  }, 180_000)

  it('keeps an existing installer.msi intact when CreateNew rejects it', async () => {
    await withOwnedFixture(async (archive, destination) => {
      await createZip(archive, [{ name: 'fixture.msi', bytes: 4 }])
      const before = digest(await readFile(archive))
      const existing = join(destination, 'installer.msi')
      await writeFile(existing, 'existing output, do not overwrite', { flag: 'wx' })
      await expect(extractWindowsMsiArchive(archive, destination)).rejects.toMatchObject({ message: 'cpolar_extract_archive_failed', stage: 'archive', nativeCode: 1 })
      expect(await readFile(existing, 'utf8')).toBe('existing output, do not overwrite')
      expect(await readdir(destination)).toEqual(['installer.msi'])
      expect(digest(await readFile(archive))).toBe(before)
    })
  }, 180_000)

  it('rejects a corrupt ZIP without writing an installer or retaining open handles', async () => {
    await withOwnedFixture(async (archive, destination) => {
      await writeFile(archive, 'not a ZIP archive', { flag: 'wx' })
      const before = digest(await readFile(archive))
      await expect(extractWindowsMsiArchive(archive, destination)).rejects.toMatchObject({ message: 'cpolar_extract_archive_failed', stage: 'archive', nativeCode: 1 })
      expect(await readdir(destination)).toEqual([])
      expect(digest(await readFile(archive))).toBe(before)
    })
  }, 180_000)
})
