import { chmod } from 'node:fs/promises'
import { win32 } from 'node:path'
import { performance } from 'node:perf_hooks'
import { execFileText as execFile } from './exec-file.js'

let userSidTask: Promise<string> | undefined

/** Windows permission operation that failed before the private file became usable. */
export type PrivateFilePermissionStage = 'sid-query' | 'acl-apply'

interface CommandFailureDetails {
  readonly code?: string | number | null
  readonly signal?: string | null
  readonly killed?: boolean
}

function commandFailureDetails(error: unknown): CommandFailureDetails {
  if (error === null || typeof error !== 'object') return {}
  let descriptors: PropertyDescriptorMap
  try { descriptors = Object.getOwnPropertyDescriptors(error) } catch (_error) {
    // A host wrapper can supply an error whose proxy refuses inspection.
    return {}
  }
  const code: unknown = descriptors.code?.value
  const signal: unknown = descriptors.signal?.value
  const killed: unknown = descriptors.killed?.value
  return {
    ...(code === null || (typeof code === 'number' && Number.isSafeInteger(code))
      || (typeof code === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/u.test(code)) ? { code } : {}),
    ...(signal === null || (typeof signal === 'string' && /^SIG[A-Z0-9]{1,16}$/u.test(signal)) ? { signal } : {}),
    ...(typeof killed === 'boolean' ? { killed } : {}),
  }
}

/** Phase and full await duration, including subprocess creation, without arguments, output or private paths. */
export class PrivateFilePermissionError extends Error {
  readonly code: string | number | null | undefined
  readonly signal: string | null | undefined
  readonly killed: boolean | undefined

  constructor(readonly stage: PrivateFilePermissionStage, readonly elapsedMs: number, error: unknown) {
    const details = commandFailureDetails(error)
    const fields = [
      ...(details.code === undefined ? [] : [`code=${String(details.code)}`]),
      ...(details.signal === undefined ? [] : [`signal=${String(details.signal)}`]),
      ...(details.killed === undefined ? [] : [`killed=${String(details.killed)}`]),
    ]
    const summary = `Windows private-file ${stage} failed after ${String(elapsedMs)} ms${fields.length === 0 ? '' : ` (${fields.join(', ')})`}`
    // Cordis logs causes recursively; raw execFile errors can contain SID arguments and private paths.
    const cause = Object.assign(new Error('Windows permission operation failed'), details)
    super(summary, { cause })
    this.name = 'PrivateFilePermissionError'
    this.code = details.code
    this.signal = details.signal
    this.killed = details.killed
  }
}

async function permissionOperation<T>(stage: PrivateFilePermissionStage, operation: () => Promise<T>): Promise<T> {
  const started = performance.now()
  try { return await operation() } catch (error) {
    throw new PrivateFilePermissionError(stage, Math.max(0, Math.round(performance.now() - started)), error)
  }
}

function windowsSystemTool(name: 'whoami.exe' | 'icacls.exe'): string {
  const systemRoot = process.env.SystemRoot ?? process.env.WINDIR
  if (systemRoot === undefined || !win32.isAbsolute(systemRoot)) {
    throw Object.assign(new Error('Windows system root is unavailable'), { code: 'WINDOWS_SYSTEM_ROOT_UNAVAILABLE' })
  }
  return win32.join(systemRoot, 'System32', name)
}

async function currentWindowsUserSid(): Promise<string> {
  userSidTask ??= permissionOperation('sid-query', async () => {
    const { stdout } = await execFile(windowsSystemTool('whoami.exe'), ['/user', '/fo', 'csv', '/nh'], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 10_000,
    })
    const match = /,"(S-\d(?:-\d+)+)"\s*$/u.exec(stdout.trim())
    if (match?.[1] === undefined) throw Object.assign(new Error('unable to resolve the current Windows user SID'), { code: 'WINDOWS_USER_SID_INVALID' })
    return match[1]
  }).catch((error: unknown) => {
    userSidTask = undefined
    throw error
  })
  return userSidTask
}

/** Restrict a sensitive regular file to the current user and Windows administrators; reject Windows permission failures with redacted phase and duration. */
export async function restrictPrivateFile(file: string, mode = 0o600): Promise<void> {
  await chmod(file, mode)
  if (process.platform !== 'win32') return
  const userSid = await currentWindowsUserSid()
  await permissionOperation('acl-apply', () => execFile(windowsSystemTool('icacls.exe'), [
    file,
    '/inheritance:r',
    '/grant:r',
    `*${userSid}:(F)`,
    '*S-1-5-18:(F)',
    '*S-1-5-32-544:(F)',
    '/remove:g',
    '*S-1-1-0',
    '*S-1-5-11',
    '*S-1-5-32-545',
  ], { encoding: 'utf8', windowsHide: true, timeout: 10_000 }))
}
