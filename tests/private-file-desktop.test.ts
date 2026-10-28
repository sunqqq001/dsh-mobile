import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Context, Logger, type Exporter } from '@deepseek-ai/cordis'
import { performance } from 'node:perf_hooks'
import { inspect } from 'node:util'

const commands = vi.hoisted(() => ({
  exec: vi.fn(),
  chmod: vi.fn().mockResolvedValue(undefined),
}))
const nativeWhoami = 'C:\\Windows\\System32\\whoami.exe'
const nativeIcacls = 'C:\\Windows\\System32\\icacls.exe'
vi.mock('node:child_process', () => ({ execFile: commands.exec }))
vi.mock('node:fs/promises', () => ({ chmod: commands.chmod }))

beforeEach(() => {
  vi.resetModules()
  vi.stubGlobal('process', {
    ...process,
    platform: 'win32',
    env: { ...process.env, SystemRoot: 'C:\\Windows', WINDIR: 'C:\\OtherWindows', PATH: 'C:\\Program Files\\Git\\usr\\bin' },
  })
  commands.exec.mockReset()
  commands.chmod.mockClear()
  commands.exec.mockImplementation((file, _args, _options, callback) => {
    callback(null, file === nativeWhoami ? '"desktop\\user","S-1-5-21-123-456-789-1001"\r\n' : '', '')
  })
})
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })

describe('Windows private files under a desktop execFile wrapper', () => {
  it('resolves a SID and still applies restrictive ACLs', async () => {
    const { restrictPrivateFile } = await import('../src/private-file.js')
    await restrictPrivateFile('fixture.json')
    expect(commands.chmod).toHaveBeenCalledWith('fixture.json', 0o600)
    expect(commands.exec).toHaveBeenLastCalledWith(nativeIcacls, expect.arrayContaining([
      'fixture.json', '/inheritance:r', '*S-1-5-21-123-456-789-1001:(F)', '/remove:g', '*S-1-1-0',
    ]), expect.objectContaining({ timeout: 10_000, windowsHide: true }), expect.any(Function))
    await restrictPrivateFile('second.json')
    expect(commands.exec.mock.calls.filter(call => call[0] === nativeWhoami)).toHaveLength(1)
  })

  it('rejects an invalid SID without running icacls and retries on the next request', async () => {
    commands.exec.mockImplementationOnce((_file, _args, _options, callback) => callback(null, 'invalid SID', ''))
    const { restrictPrivateFile } = await import('../src/private-file.js')
    await expect(restrictPrivateFile('fixture.json')).rejects.toMatchObject({ stage: 'sid-query', code: 'WINDOWS_USER_SID_INVALID' })
    expect(commands.exec).toHaveBeenCalledTimes(1)
    await expect(restrictPrivateFile('fixture.json')).resolves.toBeUndefined()
    expect(commands.exec).toHaveBeenCalledTimes(3)
  })

  it('does not report success when applying the ACL fails', async () => {
    commands.exec.mockImplementation((file, _args, _options, callback) => {
      callback(file === nativeIcacls ? new Error('ACL denied') : null, '"user","S-1-5-21-123"', '')
    })
    const { restrictPrivateFile } = await import('../src/private-file.js')
    await expect(restrictPrivateFile('fixture.json')).rejects.toMatchObject({ stage: 'acl-apply' })
  })

  it('fails closed if Windows does not identify its system directory', async () => {
    vi.stubGlobal('process', { ...process, platform: 'win32', env: { PATH: 'C:\\Program Files\\Git\\usr\\bin' } })
    const { restrictPrivateFile } = await import('../src/private-file.js')
    await expect(restrictPrivateFile('fixture.json')).rejects.toMatchObject({ stage: 'sid-query', code: 'WINDOWS_SYSTEM_ROOT_UNAVAILABLE' })
    expect(commands.exec).not.toHaveBeenCalled()
  })

  it('shares a delayed SID query and does not apply ACLs before its result arrives', async () => {
    let completeSid: (() => void) | undefined
    commands.exec.mockImplementation((file, _args, _options, callback) => {
      if (file === nativeWhoami) {
        completeSid = () => callback(null, '"user","S-1-5-21-123"', '')
      } else callback(null, '', '')
    })
    const { restrictPrivateFile } = await import('../src/private-file.js')
    let settled = 0
    const first = restrictPrivateFile('first.json').then(() => { settled++ })
    const second = restrictPrivateFile('second.json').then(() => { settled++ })
    await vi.waitFor(() => expect(completeSid).toBeTypeOf('function'))
    expect(commands.exec.mock.calls.filter(call => call[0] === nativeWhoami)).toHaveLength(1)
    expect(commands.exec.mock.calls.filter(call => call[0] === nativeIcacls)).toHaveLength(0)
    expect(settled).toBe(0)
    completeSid!()
    await Promise.all([first, second])
    expect(settled).toBe(2)
    expect(commands.exec.mock.calls.filter(call => call[0] === nativeIcacls)).toHaveLength(2)
  })

  it.each([
    { tool: nativeWhoami, stage: 'sid-query' },
    { tool: nativeIcacls, stage: 'acl-apply' },
  ] as const)('attributes a $stage timeout and preserves safe machine fields and duration', async ({ tool, stage }) => {
    const raw = Object.assign(new Error('command timed out with private arguments'), {
      code: null, signal: 'SIGTERM', killed: true,
    })
    let failCommand: (() => void) | undefined
    commands.exec.mockImplementation((file, _args, _options, callback) => {
      if (file === tool) failCommand = () => callback(raw, '', '')
      else callback(null, '"user","S-1-5-21-123"', '')
    })
    const now = vi.spyOn(performance, 'now').mockReturnValue(100)
    const { restrictPrivateFile } = await import('../src/private-file.js')
    const task = restrictPrivateFile('fixture.json')
    await vi.waitFor(() => expect(failCommand).toBeTypeOf('function'))
    now.mockReturnValue(250)
    failCommand!()
    await expect(task).rejects.toMatchObject({
      name: 'PrivateFilePermissionError', stage, elapsedMs: 150,
      code: null, signal: 'SIGTERM', killed: true,
      cause: { code: null, signal: 'SIGTERM', killed: true },
    })
    expect(commands.exec).toHaveBeenCalledWith(tool, expect.any(Array), expect.objectContaining({ timeout: 10_000 }), expect.any(Function))
  })

  it('retries after a shared SID query fails without treating any waiting file as private', async () => {
    let failSid: (() => void) | undefined
    commands.exec.mockImplementationOnce((_file, _args, _options, callback) => {
      failSid = () => callback(Object.assign(new Error('SID unavailable'), { code: 'EACCES' }), '', '')
    })
    const { restrictPrivateFile } = await import('../src/private-file.js')
    const first = restrictPrivateFile('first.json')
    const second = restrictPrivateFile('second.json')
    const results = Promise.allSettled([first, second])
    await vi.waitFor(() => expect(failSid).toBeTypeOf('function'))
    failSid!()
    expect(await results).toEqual([
      { status: 'rejected', reason: expect.objectContaining({ stage: 'sid-query', code: 'EACCES' }) },
      { status: 'rejected', reason: expect.objectContaining({ stage: 'sid-query', code: 'EACCES' }) },
    ])
    expect(commands.exec).toHaveBeenCalledTimes(1)
    await expect(restrictPrivateFile('retry.json')).resolves.toBeUndefined()
    expect(commands.exec.mock.calls.filter(call => call[0] === nativeWhoami)).toHaveLength(2)
  })

  it('retains a numeric ACL exit code and reuses the resolved SID when retrying the ACL', async () => {
    let denied = true
    commands.exec.mockImplementation((file, _args, _options, callback) => {
      const failure = file === nativeIcacls && denied ? Object.assign(new Error('ACL command failed'), { code: 5 }) : null
      if (file === nativeIcacls) denied = false
      callback(failure, '"user","S-1-5-21-123"', '')
    })
    const { restrictPrivateFile } = await import('../src/private-file.js')
    await expect(restrictPrivateFile('fixture.json')).rejects.toMatchObject({ stage: 'acl-apply', code: 5, cause: { code: 5 } })
    await expect(restrictPrivateFile('fixture.json')).resolves.toBeUndefined()
    expect(commands.exec.mock.calls.filter(call => call[0] === nativeWhoami)).toHaveLength(1)
    expect(commands.exec.mock.calls.filter(call => call[0] === nativeIcacls)).toHaveLength(2)
  })

  it('excludes raw paths, SID arguments and output even when Cordis renders causes recursively', async () => {
    const sensitive = 'SECRET-SID-TOKEN-and-private-path'
    const raw = Object.assign(new Error(sensitive), {
      code: 'EACCES', signal: null, killed: false,
      cmd: sensitive, stdout: sensitive, stderr: sensitive,
      cause: new Error(sensitive),
    })
    commands.exec.mockImplementation((file, _args, _options, callback) => {
      callback(file === nativeIcacls ? raw : null, '"user","S-1-5-21-123"', '')
    })
    const { restrictPrivateFile, PrivateFilePermissionError } = await import('../src/private-file.js')
    const result = await restrictPrivateFile(sensitive).catch((error: unknown) => error)
    expect(result).toBeInstanceOf(PrivateFilePermissionError)
    expect(result).toMatchObject({ stage: 'acl-apply', code: 'EACCES', cause: { code: 'EACCES' } })
    expect(inspect(result, { depth: 10 })).not.toContain(sensitive)
    expect(JSON.stringify(result)).not.toContain(sensitive)

    const context = new Context()
    const messages: string[] = []
    const exporter: Exporter = {
      colors: false, levels: { default: 3 },
      export(message) { messages.push(Logger.format(exporter, message)) },
    }
    const remove = context.logger.exporter(exporter)
    try {
      context.logger('private-file-fixture').error(result)
      expect(messages).toHaveLength(2)
      expect(messages.join('\n')).toContain('acl-apply')
      expect(messages.join('\n')).not.toContain(sensitive)
    } finally { await remove(); await context.fiber.dispose() }
  })

  it('drops untrusted error fields that are not bounded machine codes', async () => {
    const sensitive = 'S-1-5-21-private-token'
    const raw = Object.assign(new Error(sensitive), { code: sensitive, signal: sensitive, killed: sensitive })
    commands.exec.mockImplementationOnce((_file, _args, _options, callback) => callback(raw, '', ''))
    const { restrictPrivateFile } = await import('../src/private-file.js')
    const result = await restrictPrivateFile('fixture.json').catch((error: unknown) => error)
    expect(result).toMatchObject({ stage: 'sid-query', code: undefined, signal: undefined, killed: undefined })
    expect(inspect(result, { depth: 10 })).not.toContain(sensitive)
  })

  it('does not invoke error field getters or retain inherited fields', async () => {
    const inherited = { code: 'EACCES', signal: 'SIGTERM', killed: true }
    const raw: object = Object.create(inherited)
    const getter = vi.fn(() => { throw new Error('secret error field') })
    Object.defineProperty(raw, 'code', { get: getter })
    commands.exec.mockImplementationOnce((_file, _args, _options, callback) => callback(raw, '', ''))
    const { restrictPrivateFile } = await import('../src/private-file.js')
    await expect(restrictPrivateFile('fixture.json')).rejects.toMatchObject({
      stage: 'sid-query', code: undefined, signal: undefined, killed: undefined,
    })
    expect(getter).not.toHaveBeenCalled()
  })

  it('reports the failed phase when a host error refuses inspection', async () => {
    const raw = new Proxy({}, { ownKeys() { throw new Error('secret inspection failure') } })
    commands.exec.mockImplementationOnce((_file, _args, _options, callback) => callback(raw, '', ''))
    const { restrictPrivateFile } = await import('../src/private-file.js')
    const result = await restrictPrivateFile('fixture.json').catch((error: unknown) => error)
    expect(result).toMatchObject({ stage: 'sid-query', code: undefined })
    expect(inspect(result, { depth: 10 })).not.toContain('secret inspection failure')
  })
})
