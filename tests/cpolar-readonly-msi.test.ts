import { createHash } from 'node:crypto'
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { CPOLAR_COMPONENT_RELEASE, CpolarComponentManager } from '../src/cpolar-component.js'
import { extractWindowsMsiBinary } from '../src/windows-msi-extract.js'

const source = process.env.DSH_CPOLAR_TEST_MSI
const archive = process.env.DSH_CPOLAR_TEST_ZIP
const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

// Opt-in fixed official MSI only; never starts MSI actions or the downloaded binary.
describe.skipIf(process.platform !== 'win32' || source === undefined)('official cpolar read-only MSI', () => {
  it('extracts the pinned executable through spaces and Unicode without changing its database', async () => {
    if (source === undefined) throw new Error('MSI fixture was not supplied')
    const root = await mkdtemp(join(tmpdir(), 'dsh-mobile-msi-live-'))
    roots.push(root)
    const destination = join(root, '中文 空格')
    await mkdir(destination)
    const msi = join(root, '只读 包.msi')
    await copyFile(source, msi)
    const before = createHash('sha256').update(await readFile(msi)).digest('hex')
    await extractWindowsMsiBinary(msi, destination, CPOLAR_COMPONENT_RELEASE.executableName, CPOLAR_COMPONENT_RELEASE.executableBytes)
    expect(createHash('sha256').update(await readFile(msi)).digest('hex')).toBe(before)
    const binary = await readFile(join(destination, CPOLAR_COMPONENT_RELEASE.executableName))
    expect(binary.length).toBe(CPOLAR_COMPONENT_RELEASE.executableBytes)
    expect(createHash('sha256').update(binary).digest('hex')).toBe(CPOLAR_COMPONENT_RELEASE.executableSha256)
  }, 120_000)

  it('rejects a mismatched file-table size without writing a cabinet', async () => {
    if (source === undefined) throw new Error('MSI fixture was not supplied')
    const root = await mkdtemp(join(tmpdir(), 'dsh-mobile-msi-reject-'))
    roots.push(root)
    await expect(extractWindowsMsiBinary(source, root, CPOLAR_COMPONENT_RELEASE.executableName,
      CPOLAR_COMPONENT_RELEASE.executableBytes + 1)).rejects.toMatchObject({ message: 'cpolar_extract_database_failed' })
    expect(await readdir(root)).toEqual([])
  }, 120_000)

  it('rejects a corrupt database without cabinet output or executable promotion', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-mobile-msi-invalid-'))
    roots.push(root)
    const msi = join(root, 'corrupt.msi')
    await writeFile(msi, 'not an MSI database')
    await expect(extractWindowsMsiBinary(msi, root, CPOLAR_COMPONENT_RELEASE.executableName,
      CPOLAR_COMPONENT_RELEASE.executableBytes)).rejects.toMatchObject({ message: 'cpolar_extract_database_failed' })
    expect(await readdir(root)).toEqual(['corrupt.msi'])
  }, 120_000)
})

describe.skipIf(process.platform !== 'win32' || archive === undefined)('official cpolar component ZIP', () => {
  it('installs only the pinned executable and removes all extraction staging', async () => {
    if (archive === undefined) throw new Error('ZIP fixture was not supplied')
    const bytes = await readFile(archive)
    expect(bytes.length).toBe(CPOLAR_COMPONENT_RELEASE.downloadBytes)
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(CPOLAR_COMPONENT_RELEASE.downloadSha256)
    const root = await mkdtemp(join(tmpdir(), 'dsh-mobile-cpolar-install-'))
    roots.push(root)
    const directory = join(root, '只读 解包')
    const manager = new CpolarComponentManager({ stateDirectory: directory, fetchArtifact: async () => bytes })
    await manager.initialize()
    await expect(manager.install()).resolves.toMatchObject({ installed: true, configured: false })
    const binary = await readFile(manager.executable)
    expect(binary.length).toBe(CPOLAR_COMPONENT_RELEASE.executableBytes)
    expect(createHash('sha256').update(binary).digest('hex')).toBe(CPOLAR_COMPONENT_RELEASE.executableSha256)
    expect(await readdir(join(directory, 'staging', 'cpolar'))).toEqual([])
    expect(await readdir(manager.componentStorage)).toEqual(['cpolar.exe'])
  }, 120_000)
})
