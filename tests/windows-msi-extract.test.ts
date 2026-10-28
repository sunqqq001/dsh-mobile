import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { inspect } from 'node:util'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CPOLAR_COMPONENT_RELEASE } from '../src/cpolar-component.js'
import { cpolarWindowsExtractionStep, cpolarWindowsSystemTool, extractWindowsMsiArchive, extractWindowsMsiBinary, runCpolarWindowsTool } from '../src/windows-msi-extract.js'

const commands = vi.hoisted(() => ({ run: vi.fn(), stat: vi.fn() }))
vi.mock('../src/exec-file.js', () => ({ execFileText: commands.run }))
vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return { ...actual, lstat: commands.stat }
})
const roots: string[] = []
const nativePowerShell = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'
const member = 'cpolar_exe'

async function fixture(): Promise<{ readonly root: string; readonly msi: string }> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-mobile-msi-'))
  roots.push(root)
  const msi = join(root, 'fixture.msi')
  await writeFile(msi, 'fixture database')
  return { root, msi }
}

beforeEach(async () => {
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
  commands.stat.mockReset().mockImplementation(actual.lstat)
  vi.stubGlobal('process', { ...process, platform: 'win32', env: { ...process.env, SystemRoot: 'C:\\Windows' } })
  commands.run.mockReset()
  commands.run.mockImplementation(async (file: string, args: string[], options: { env?: NodeJS.ProcessEnv }) => {
    if (file === nativePowerShell) {
      const destination = options.env?.DSH_CAB_DESTINATION
      if (destination !== undefined) {
        await writeFile(join(destination, options.env?.DSH_CAB_MEMBER ?? member), 'test')
        return { stdout: 'DSH_MSI_CABINET_READY', stderr: '' }
      }
      const cabinet = options.env?.DSH_MSI_CABINET
      if (cabinet === undefined) throw new Error('fixture cabinet missing')
      await writeFile(cabinet, Buffer.alloc(36))
      return { stdout: JSON.stringify({ Member: member, Bytes: 4, CabinetBytes: 36 }), stderr: '' }
    }
    throw new Error('fixture refuses non-PowerShell tools')
  })
})
afterEach(async () => {
  vi.unstubAllGlobals()
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('Unicode-safe Windows MSI ZIP extraction', () => {
  it('passes Unicode and quoted paths only as environment data to one fixed system reader', async () => {
    const { root } = await fixture()
    const destination = await mkdtemp(join(root, "中文 路径 '单引号'; $(not-command)-"))
    const archive = join(destination, "官方下载 '组件'.zip")
    await writeFile(archive, 'pinned ZIP fixture')
    commands.run.mockImplementationOnce(async (_file, _args, options) => {
      await writeFile(options.env.DSH_MSI_OUTPUT, 'MSI fixture', { flag: 'wx' })
      return { stdout: 'DSH_MSI_ZIP_READY\r\n', stderr: '' }
    })
    const msi = await extractWindowsMsiArchive(archive, destination)
    expect(msi).toBe(join(destination, 'installer.msi'))
    expect(await readFile(msi, 'utf8')).toBe('MSI fixture')
    expect(await readFile(archive, 'utf8')).toBe('pinned ZIP fixture')
    expect(commands.run).toHaveBeenCalledTimes(1)
    const [tool, args, options] = commands.run.mock.calls[0]!
    expect(tool).toBe(nativePowerShell)
    expect(args.slice(0, 4)).toEqual(['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand'])
    expect(options).toMatchObject({ windowsHide: true, timeout: 120_000, maxBuffer: 16_384,
      env: { DSH_MSI_ZIP: archive, DSH_MSI_OUTPUT: msi } })
    const source = Buffer.from(args[4] as string, 'base64').toString('utf16le')
    expect(source).toContain('ZipFile]::OpenRead($env:DSH_MSI_ZIP)')
    expect(source).toContain('[System.IO.FileMode]::CreateNew')
    expect(source).toContain('$env:DSH_MSI_OUTPUT')
    expect(source).toContain('$zip.Entries.Count -gt 128')
    expect(source).toContain('33554432')
    expect(source).toContain('$entry.ExternalAttributes')
    expect(source).toContain('ZIP_PATH_INVALID')
    expect(source).toContain('ZIP_LINK_INVALID')
    expect(source).toContain('ZIP_MSI_INVALID')
    expect(source).toContain('ZIP_STREAM_OVERFLOW')
    expect(source).toContain('ZIP_STREAM_TRUNCATED')
    expect(source).toContain('$zipMsiOutput.Dispose()')
    expect(source).toContain('$zipEntryStream.Dispose()')
    expect(source).toContain('$zip.Dispose()')
    expect(source).not.toContain(archive)
    expect(source).not.toContain(destination)
    expect(source).not.toMatch(/MsiInstallProduct|MsiDoAction|msiexec|AdminExecuteSequence|InstallExecuteSequence|ExtractToDirectory/u)
  })

  it.each(['', 'DSH_MSI_ZIP_FAILED', 'banner\nDSH_MSI_ZIP_READY', 'DSH_MSI_ZIP_READY\nextra', '{}'])('rejects non-terminal marker output %j', async stdout => {
    const { root, msi } = await fixture()
    commands.run.mockResolvedValueOnce({ stdout, stderr: '' })
    await expect(extractWindowsMsiArchive(msi, root)).rejects.toMatchObject({ message: 'cpolar_extract_archive_failed', stage: 'archive' })
    expect(commands.run).toHaveBeenCalledTimes(1)
    expect(commands.stat.mock.calls.some(([path]) => path === join(root, 'installer.msi'))).toBe(false)
    expect(await readdir(root)).toEqual(['fixture.msi'])
  })

  it.each([
    { size: 0, regular: true, linked: false },
    { size: 33_554_433, regular: true, linked: false },
    { size: 16, regular: false, linked: false },
    { size: 16, regular: true, linked: true },
  ])('rejects an invalid written MSI $size / regular=$regular / linked=$linked', async info => {
    const { root, msi } = await fixture()
    commands.run.mockResolvedValueOnce({ stdout: 'DSH_MSI_ZIP_READY', stderr: '' })
    const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
    commands.stat.mockImplementation(async path => path === join(root, 'installer.msi')
      ? { size: info.size, isFile: () => info.regular, isSymbolicLink: () => info.linked }
      : actual.lstat(path))
    await expect(extractWindowsMsiArchive(msi, root)).rejects.toMatchObject({ message: 'cpolar_extract_archive_failed', stage: 'archive' })
    expect(commands.stat.mock.calls.filter(([path]) => path === join(root, 'installer.msi'))).toEqual([[join(root, 'installer.msi')]])
    expect(commands.run).toHaveBeenCalledTimes(1)
  })

  it('rejects a ready marker without a created MSI instead of falling back to another extractor', async () => {
    const { root, msi } = await fixture()
    commands.run.mockResolvedValueOnce({ stdout: 'DSH_MSI_ZIP_READY', stderr: '' })
    await expect(extractWindowsMsiArchive(msi, root)).rejects.toMatchObject({ stage: 'archive', nativeCode: 'ENOENT' })
    expect(commands.run).toHaveBeenCalledTimes(1)
    expect(await readdir(root)).toEqual(['fixture.msi'])
  })

  it('does not overwrite a preexisting MSI when the fixed reader refuses CreateNew', async () => {
    const { root, msi } = await fixture()
    const output = join(root, 'installer.msi')
    await writeFile(output, 'existing owned data')
    commands.run.mockImplementationOnce(async (_file, _args, options) => {
      await writeFile(options.env.DSH_MSI_OUTPUT, 'replacement', { flag: 'wx' })
      return { stdout: 'DSH_MSI_ZIP_READY', stderr: '' }
    })
    await expect(extractWindowsMsiArchive(msi, root)).rejects.toMatchObject({ stage: 'archive', nativeCode: 'EEXIST' })
    expect(await readFile(output, 'utf8')).toBe('existing owned data')
    expect(commands.run).toHaveBeenCalledTimes(1)
  })

  it('redacts an archive process error while retaining safe timeout fields', async () => {
    const { root, msi } = await fixture()
    const secret = 'private-中文-path-and-account-token'
    commands.run.mockRejectedValueOnce(Object.assign(new Error(`powershell.exe ${secret}`), {
      code: null, signal: 'SIGTERM', killed: true, stdout: secret, stderr: secret, path: secret,
    }))
    try {
      await extractWindowsMsiArchive(msi, root)
      throw new Error('fixture must reject')
    } catch (error) {
      expect(error).toMatchObject({ stage: 'archive', nativeCode: null, signal: 'SIGTERM', killed: true, deadlineMs: 120_000 })
      expect(inspect(error)).not.toContain(secret)
    }
    expect(commands.run).toHaveBeenCalledTimes(1)
    expect(commands.stat.mock.calls.some(([path]) => path === join(root, 'installer.msi'))).toBe(false)
  })

  it('reports a missing system PowerShell as tools failure with no PATH or tar fallback', async () => {
    const { root, msi } = await fixture()
    commands.run.mockRejectedValueOnce(Object.assign(new Error('missing private system path'), { code: 'ENOENT' }))
    await expect(extractWindowsMsiArchive(msi, root)).rejects.toMatchObject({ stage: 'tools', nativeCode: 'ENOENT', deadlineMs: 120_000 })
    expect(commands.run).toHaveBeenCalledTimes(1)
    expect(commands.run.mock.calls[0]![0]).toBe(nativePowerShell)
  })

  it.each([
    { directory: false, linked: false },
    { directory: true, linked: true },
  ])('rejects an invalid destination before starting the reader: directory=$directory linked=$linked', async info => {
    const { root, msi } = await fixture()
    commands.stat.mockResolvedValueOnce({ isDirectory: () => info.directory, isSymbolicLink: () => info.linked })
    await expect(extractWindowsMsiArchive(msi, root)).rejects.toMatchObject({ stage: 'archive' })
    expect(commands.run).not.toHaveBeenCalled()
    expect(await readdir(root)).toEqual(['fixture.msi'])
  })

  it('rejects nonabsolute inputs and other platforms before invoking an extraction process', async () => {
    const { root, msi } = await fixture()
    await expect(extractWindowsMsiArchive('relative.zip', root)).rejects.toMatchObject({ stage: 'archive' })
    await expect(extractWindowsMsiArchive(msi, 'relative-target')).rejects.toMatchObject({ stage: 'archive' })
    vi.stubGlobal('process', { ...process, platform: 'linux' })
    await expect(extractWindowsMsiArchive(msi, root)).rejects.toMatchObject({ stage: 'archive' })
    expect(commands.run).not.toHaveBeenCalled()
  })
})

describe('read-only Windows MSI binary extraction', () => {
  it('uses fixed system tools, bounded reads and exact cabinet members without executing an installer', async () => {
    const { root, msi } = await fixture()
    await extractWindowsMsiBinary(msi, root, 'cpolar.exe', 4)
    expect(await readFile(join(root, 'cpolar.exe'), 'utf8')).toBe('test')
    expect(commands.run.mock.calls.map(call => basename(call[0] as string))).toHaveLength(2)
    const cabinetCall = commands.run.mock.calls[1]!
    expect(cabinetCall[0]).toBe(nativePowerShell)
    expect(cabinetCall[1].slice(0, 4)).toEqual(['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand'])
    expect(cabinetCall[2]).toMatchObject({ windowsHide: true, timeout: 120_000, maxBuffer: 16_384, env: {
      DSH_CAB_SOURCE: join(root, 'component.cab'), DSH_CAB_DESTINATION: join(root, 'cabinet'),
      DSH_CAB_MEMBER: member, DSH_CAB_BYTES: '4',
    } })
    const cabinetSource = Buffer.from(cabinetCall[1][4] as string, 'base64').toString('utf16le')
    expect(cabinetSource).toContain('SetupIterateCabinetW')
    expect(cabinetSource).toContain('DllImportSearchPath.System32')
    expect(cabinetSource).toContain('public IntPtr NameInCabinet')
    expect(cabinetSource).toContain('Marshal.PtrToStringUni(entry.NameInCabinet)')
    expect(cabinetSource).toContain('Marshal.Copy(path, 0, IntPtr.Add(param1, targetOffset), MaxPath)')
    expect(cabinetSource).toContain('targetOffset != IntPtr.Size + 14')
    expect(cabinetSource).toContain('entry.FileSize != (uint)expectedBytes')
    expect(cabinetSource).toContain('return FileopSkip')
    expect(cabinetSource).toContain('++matched != 1')
    expect(cabinetSource).toContain('Directory.GetFileSystemEntries(directory).Length != 0')
    expect(cabinetSource).toContain('File.Exists(target) || Directory.Exists(target)')
    expect(cabinetSource).toContain('notification == NeedNewCabinet')
    expect(cabinetSource).toContain('return notification == FileInCabinet ? FileopAbort : InvalidData')
    expect(cabinetSource).toContain('result.Win32Error != 0')
    expect(cabinetSource).toContain('GC.KeepAlive(callback)')
    expect(cabinetSource).not.toContain('Marshal.StructureToPtr')
    expect(cabinetSource).not.toContain(msi)
    expect(cabinetSource).not.toContain(root)
    expect(cabinetSource).not.toMatch(/MsiInstallProduct|MsiDoAction|msiexec|AdminExecuteSequence|InstallExecuteSequence|expand\.exe/u)
    const call = commands.run.mock.calls[0]!
    expect(call[0]).toBe(nativePowerShell)
    expect(call[2]).toMatchObject({ windowsHide: true, timeout: 120_000, maxBuffer: 16_384, env: {
      DSH_MSI_SOURCE: msi, DSH_MSI_CABINET: join(root, 'component.cab'), DSH_MSI_BINARY: 'cpolar.exe', DSH_MSI_BYTES: '4',
    } })
    const source = Buffer.from(call[1][4] as string, 'base64').toString('utf16le')
    expect(source).toContain('MsiOpenDatabaseW(msi, IntPtr.Zero')
    expect(source).toContain('FileMode.CreateNew')
    expect(source).toContain('MsiRecordReadStream')
    expect(source).toContain('MsiCloseHandle')
    expect(source).toContain('DllImportSearchPath.System32')
    expect(source).not.toContain(msi)
    expect(source).not.toMatch(/MsiInstallProduct|MsiDoAction|msiexec|AdminExecuteSequence|InstallExecuteSequence/u)
  })

  it.each(['../outside', 'file/name', 'file\\name', '..', '-option', 'wild*card', 'x?'])('rejects unsafe MSI member %s before expansion', async badMember => {
    const { root, msi } = await fixture()
    commands.run.mockImplementationOnce(async (_file, _args, options) => {
      await writeFile(options.env.DSH_MSI_CABINET, Buffer.alloc(36))
      return { stdout: JSON.stringify({ Member: badMember, Bytes: 4, CabinetBytes: 36 }), stderr: '' }
    })
    await expect(extractWindowsMsiBinary(msi, root, 'cpolar.exe', 4)).rejects.toMatchObject({ message: 'cpolar_extract_database_failed', stage: 'database' })
    expect(commands.run).toHaveBeenCalledTimes(1)
    expect(await readdir(root)).not.toContain('cabinet')
  })

  it.each([
    { Member: member, Bytes: 5, CabinetBytes: 36 },
    { Member: member, Bytes: 4, CabinetBytes: 33_554_433 },
    { Member: member, Bytes: 4, CabinetBytes: 35 },
    { Member: member, Bytes: 4, CabinetBytes: 37 },
  ])('rejects invalid MSI or written cabinet size $CabinetBytes', async metadata => {
    const { root, msi } = await fixture()
    commands.run.mockImplementationOnce(async (_file, _args, options) => {
      await writeFile(options.env.DSH_MSI_CABINET, Buffer.alloc(36))
      return { stdout: JSON.stringify(metadata), stderr: '' }
    })
    await expect(extractWindowsMsiBinary(msi, root, 'cpolar.exe', 4)).rejects.toMatchObject({ stage: 'database' })
    expect(commands.run).toHaveBeenCalledTimes(1)
  })

  it.each(['null', '[]', '"text"', '', '{} trailing output', '{}\n{}', 'banner\n{}'])('rejects non-metadata reader output %s', async stdout => {
    const { root, msi } = await fixture()
    commands.run.mockResolvedValueOnce({ stdout, stderr: '' })
    await expect(extractWindowsMsiBinary(msi, root, 'cpolar.exe', 4)).rejects.toMatchObject({ stage: 'database' })
    expect(commands.run).toHaveBeenCalledTimes(1)
  })

  it('rejects a linked cabinet rather than passing its target to expand', async () => {
    const { root, msi } = await fixture()
    const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
    commands.stat.mockImplementation(async path => Object.assign(await actual.lstat(path), { isSymbolicLink: () => true }))
    await expect(extractWindowsMsiBinary(msi, root, 'cpolar.exe', 4)).rejects.toMatchObject({ stage: 'database' })
    expect(commands.run).toHaveBeenCalledTimes(1)
    expect(await readdir(root)).not.toContain('cabinet')
  })

  it('rejects a preexisting extraction directory rather than writing into it', async () => {
    const { root, msi } = await fixture()
    await writeFile(join(root, 'cabinet'), 'do not replace')
    await expect(extractWindowsMsiBinary(msi, root, 'cpolar.exe', 4)).rejects.toMatchObject({ stage: 'cabinet' })
    expect(await readFile(join(root, 'cabinet'), 'utf8')).toBe('do not replace')
    expect(commands.run).toHaveBeenCalledTimes(1)
  })

  it('classifies a timed out reader and never starts cabinet expansion', async () => {
    const { root, msi } = await fixture()
    commands.run.mockRejectedValueOnce(Object.assign(new Error('timed out command with private paths'), { killed: true, signal: 'SIGTERM', code: null }))
    await expect(extractWindowsMsiBinary(msi, root, 'cpolar.exe', 4)).rejects.toMatchObject({
      message: 'cpolar_extract_database_failed', nativeCode: null, signal: 'SIGTERM', killed: true, deadlineMs: 120_000,
      cause: { code: null, signal: 'SIGTERM', killed: true, deadlineMs: 120_000 },
    })
    expect(commands.run).toHaveBeenCalledTimes(1)
    expect(await readdir(root)).toEqual(['fixture.msi'])
  })

  it.each(['powershell.exe', 'tar.exe'] as const)('classifies missing %s as a tool failure', async tool => {
    commands.run.mockRejectedValueOnce(Object.assign(new Error('ENOENT private executable path'), { code: 'ENOENT' }))
    await expect(cpolarWindowsExtractionStep('database', () => runCpolarWindowsTool(tool, []))).rejects.toMatchObject({
      message: 'cpolar_extract_tools_failed', stage: 'tools', nativeCode: 'ENOENT', deadlineMs: 120_000,
    })
  })

  it('rejects extra or wrong-sized cabinet output instead of promoting it', async () => {
    const { root, msi } = await fixture()
    commands.run.mockImplementationOnce(async (_file, _args, options) => {
      await writeFile(options.env.DSH_MSI_CABINET, Buffer.alloc(36))
      return { stdout: JSON.stringify({ Member: member, Bytes: 4, CabinetBytes: 36 }), stderr: '' }
    }).mockImplementationOnce(async (_file, _args, options) => {
      await writeFile(join(options.env.DSH_CAB_DESTINATION, member), 'wrong size')
      await writeFile(join(options.env.DSH_CAB_DESTINATION, 'unexpected.exe'), 'extra')
      return { stdout: 'DSH_MSI_CABINET_READY', stderr: '' }
    })
    await expect(extractWindowsMsiBinary(msi, root, 'cpolar.exe', 4)).rejects.toMatchObject({ stage: 'file' })
    expect(await readdir(root)).not.toContain('cpolar.exe')
  })

  it.each(['', 'DSH_MSI_CABINET_FAILED', 'DSH_MSI_CABINET_READY\nextra'])('rejects incomplete cabinet reader output %j', async stdout => {
    const { root, msi } = await fixture()
    commands.run.mockImplementationOnce(async (_file, _args, options) => {
      await writeFile(options.env.DSH_MSI_CABINET, Buffer.alloc(36))
      return { stdout: JSON.stringify({ Member: member, Bytes: 4, CabinetBytes: 36 }), stderr: '' }
    }).mockResolvedValueOnce({ stdout, stderr: '' })
    await expect(extractWindowsMsiBinary(msi, root, 'cpolar.exe', 4)).rejects.toMatchObject({ stage: 'cabinet' })
    expect(commands.run).toHaveBeenCalledTimes(2)
    expect(await readdir(join(root, 'cabinet'))).toEqual([])
    expect(await readdir(root)).not.toContain('cpolar.exe')
  })

  it('redacts a cabinet-reader timeout without promoting partial output or falling back', async () => {
    const { root, msi } = await fixture()
    const secret = 'private cabinet path and token'
    commands.run.mockImplementationOnce(async (_file, _args, options) => {
      await writeFile(options.env.DSH_MSI_CABINET, Buffer.alloc(36))
      return { stdout: JSON.stringify({ Member: member, Bytes: 4, CabinetBytes: 36 }), stderr: '' }
    }).mockRejectedValueOnce(Object.assign(new Error(secret), { code: null, killed: true, signal: 'SIGTERM', stderr: secret }))
    try {
      await extractWindowsMsiBinary(msi, root, 'cpolar.exe', 4)
      throw new Error('fixture must reject')
    } catch (error) {
      expect(error).toMatchObject({ stage: 'cabinet', killed: true, signal: 'SIGTERM', deadlineMs: 120_000 })
      expect(inspect(error)).not.toContain(secret)
    }
    expect(commands.run.mock.calls.map(call => call[0])).toEqual([nativePowerShell, nativePowerShell])
    expect(await readdir(root)).not.toContain('cpolar.exe')
  })

  it.each(['database', 'cabinet', 'archive'] as const)('redacts subprocess details at %s', async stage => {
    const secret = 'private-path-and-account-token'
    const raw = Object.assign(new Error(`powershell.exe ${secret}`), { code: 5, stderr: secret, stdout: secret, path: secret })
    try {
      await cpolarWindowsExtractionStep(stage, async () => { throw raw })
      throw new Error('fixture must reject')
    } catch (error) {
      expect(error).toMatchObject({ message: `cpolar_extract_${stage}_failed`, stage, nativeCode: 5 })
      expect(inspect(error)).not.toContain(secret)
    }
  })

  it('does not choose a PATH binary when the system root is absent or relative', () => {
    for (const root of [undefined, 'relative', '\\\\host\\share']) {
      vi.stubGlobal('process', { ...process, platform: 'win32', env: { SystemRoot: root, PATH: 'untrusted' } })
      expect(() => cpolarWindowsSystemTool('powershell.exe')).toThrow('cpolar_extract_tools_failed')
    }
    expect(commands.run).not.toHaveBeenCalled()
  })

  it('rejects unsupported platforms and unsafe input before starting a process', async () => {
    const { root, msi } = await fixture()
    await expect(extractWindowsMsiBinary(msi, root, '../cpolar.exe', 4)).rejects.toMatchObject({ nativeCode: 'INPUT_INVALID' })
    vi.stubGlobal('process', { ...process, platform: 'linux' })
    await expect(extractWindowsMsiBinary(msi, root, 'cpolar.exe', 4)).rejects.toMatchObject({ nativeCode: 'INPUT_INVALID' })
    expect(commands.run).not.toHaveBeenCalled()
  })
})

const officialMsi = process.env.DSH_CPOLAR_TEST_MSI

// These controls execute the fixed native callback, but never start MSI actions or the binary.
describe.skipIf(process.platform !== 'win32' || officialMsi === undefined)('native Unicode cabinet rejection controls', () => {
  it.each(['missing-member', 'wrong-size', 'occupied-directory'] as const)('rejects %s without publishing executable data', async fault => {
    if (officialMsi === undefined) throw new Error('MSI fixture was not supplied')
    const { root } = await fixture()
    const actual = await vi.importActual<typeof import('../src/exec-file.js')>('../src/exec-file.js')
    commands.run.mockImplementation(async (tool, args, options) => {
      if (options.env?.DSH_CAB_SOURCE !== undefined) {
        const env = { ...options.env }
        if (fault === 'missing-member') env.DSH_CAB_MEMBER = 'intentionally_absent_member'
        if (fault === 'wrong-size') env.DSH_CAB_BYTES = String(Number(env.DSH_CAB_BYTES) + 1)
        if (fault === 'occupied-directory') await writeFile(join(env.DSH_CAB_DESTINATION, env.DSH_CAB_MEMBER), 'keep this owned file', { flag: 'wx' })
        return actual.execFileText(tool, args, { ...options, env })
      }
      return actual.execFileText(tool, args, options)
    })
    await expect(extractWindowsMsiBinary(officialMsi, root, CPOLAR_COMPONENT_RELEASE.executableName,
      CPOLAR_COMPONENT_RELEASE.executableBytes)).rejects.toMatchObject({ stage: 'cabinet' })
    expect(commands.run.mock.calls.map(call => call[0])).toEqual([nativePowerShell, nativePowerShell])
    expect(await readdir(root)).not.toContain('cpolar.exe')
    const files = await readdir(join(root, 'cabinet'))
    if (fault === 'occupied-directory') {
      expect(files).toHaveLength(1)
      expect(await readFile(join(root, 'cabinet', files[0]!), 'utf8')).toBe('keep this owned file')
    } else expect(files).toEqual([])
  }, 120_000)
})
