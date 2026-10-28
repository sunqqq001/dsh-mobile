import { createHash, randomBytes } from 'node:crypto'
import { chmod, lstat, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'
import { assertCaddyParents, ensureCaddyDirectory, removeCaddyTree, renameCaddyPath } from './caddy-files.js'
import { downloadPinnedArtifact } from './component-download.js'
import { execFileText } from './exec-file.js'

export const CADDY_VERSION = '2.11.7'
export const CADDY_DNS_PLUGIN_VERSION = 'v0.4.3'
export const CADDY_DOWNLOAD_PAGE = 'https://github.com/saya-ch/dsh-mobile/releases/tag/caddy-component-2.11.7-tencentcloud-0.4.3-r1'

/** A size- and content-pinned release asset with independent wire and installed-byte checks. */
export interface CaddyArtifact {
  readonly version: string
  readonly platform: NodeJS.Platform
  readonly arch: string
  readonly downloadUrl: string
  readonly downloadBytes: number
  readonly downloadSha256: string
  readonly executableName: string
  readonly executableBytes: number
  readonly executableSha256: string
  readonly dnsPluginVersion: string
}

// Only independently verified official assets enter this source-owned catalog.
export const CADDY_COMPONENT_RELEASES: Readonly<Record<string, CaddyArtifact>> = Object.freeze({
  'linux-x64': Object.freeze({
    version: CADDY_VERSION, dnsPluginVersion: CADDY_DNS_PLUGIN_VERSION, platform: 'linux', arch: 'x64', executableName: 'caddy',
    downloadUrl: 'https://github.com/saya-ch/dsh-mobile/releases/download/caddy-component-2.11.7-tencentcloud-0.4.3-r1/caddy-2.11.7-tencentcloud-0.4.3-linux-x64',
    downloadBytes: 81_995_704, executableBytes: 81_995_704,
    downloadSha256: '13652ef9ea3792ebff772a5b873ade63ed6de1c0a794bb3403a523639b8f57af',
    executableSha256: '13652ef9ea3792ebff772a5b873ade63ed6de1c0a794bb3403a523639b8f57af',
  }),
  'win32-x64': Object.freeze({
    version: CADDY_VERSION, dnsPluginVersion: CADDY_DNS_PLUGIN_VERSION, platform: 'win32', arch: 'x64', executableName: 'caddy.exe',
    downloadUrl: 'https://github.com/saya-ch/dsh-mobile/releases/download/caddy-component-2.11.7-tencentcloud-0.4.3-r1/caddy-2.11.7-tencentcloud-0.4.3-win32-x64.exe',
    downloadBytes: 82_816_000, executableBytes: 82_816_000,
    downloadSha256: '962f7937a06e1e737513d2d1d4ad75df54ba503d36fa2a458912bd38fbd0094a',
    executableSha256: '962f7937a06e1e737513d2d1d4ad75df54ba503d36fa2a458912bd38fbd0094a',
  }),
})
export const CADDY_COMPONENT_RELEASE = Object.freeze({ version: CADDY_VERSION, dnsPluginVersion: CADDY_DNS_PLUGIN_VERSION })
export type CaddyDnsProvider = 'tencentcloud'

export function isCaddyDnsProvider(value: unknown): value is CaddyDnsProvider { return value === 'tencentcloud' }

export interface CaddyComponentStatus {
  readonly supported: boolean
  readonly installed: boolean
  readonly version: string
  readonly downloadBytes: number
  readonly installedBytes: number
  readonly sourceUrl: string
  readonly downloadPage: string
  readonly storagePath: string
  readonly errorCode?: string
}

interface CaddyComponentManagerOptions {
  readonly stateDirectory: string
  readonly platform?: NodeJS.Platform
  readonly arch?: string
  /** Instance-local artifact metadata for tests or a verified immutable release. */
  readonly artifact?: CaddyArtifact
  readonly fetchArtifact?: (url: string, signal: AbortSignal) => Promise<Uint8Array>
  readonly inspectExecutable?: (executable: string) => Promise<{ version: string; modules: string }>
  readonly promoteDirectory?: (source: string, destination: string) => Promise<void>
}

async function digest(file: string): Promise<string> { return createHash('sha256').update(await readFile(file)).digest('hex') }

/** Minimal process environment for version/module checks, without ambient API credentials or proxy overrides. */
export function caddyInspectionEnvironment(environment: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {}
  for (const name of ['SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'LANG', 'LC_ALL']) {
    if (environment[name] !== undefined) result[name] = environment[name]
  }
  return result
}

async function inspect(executable: string, assertOpen: () => void): Promise<{ version: string; modules: string }> {
  const options = { env: caddyInspectionEnvironment(), timeout: 15_000, maxBuffer: 256 * 1024 }
  const version = (await execFileText(executable, ['version'], options)).stdout.trim()
  assertOpen()
  const modules = (await execFileText(executable, ['list-modules', '--versions'], options)).stdout
  return { version, modules }
}

/** Owns only the optional pinned executable; runtime configuration belongs to CaddyConfigStore. */
export class CaddyComponentManager {
  readonly executable: string
  readonly componentRoot: string
  readonly componentStorage: string
  readonly logRoot: string
  private readonly stateDirectory: string
  private readonly stagingRoot: string
  private readonly artifact: CaddyArtifact | undefined
  private readonly fetchArtifact: (url: string, signal: AbortSignal) => Promise<Uint8Array>
  private readonly inspectExecutable: (executable: string) => Promise<{ version: string; modules: string }>
  private readonly promote: (source: string, destination: string) => Promise<void>
  private installed = false
  private errorCode: string | undefined
  private queue: Promise<void> = Promise.resolve()
  private closed = false
  private closing: Promise<void> | undefined
  private download: { controller: AbortController; timeout: ReturnType<typeof setTimeout> } | undefined
  private readonly cleanupPaths = new Set<string>()

  constructor(options: CaddyComponentManagerOptions) {
    if (!isAbsolute(options.stateDirectory)) throw new Error('caddy state directory must be absolute')
    this.stateDirectory = resolve(options.stateDirectory)
    const platform = options.platform ?? process.platform
    const arch = options.arch ?? process.arch
    const artifact = options.artifact ?? CADDY_COMPONENT_RELEASES[`${platform}-${arch}`]
    if (artifact !== undefined && (artifact.platform !== platform || artifact.arch !== arch
      || !/^https:\/\//u.test(artifact.downloadUrl) || !/^[a-f0-9]{64}$/u.test(artifact.downloadSha256)
      || !/^[a-f0-9]{64}$/u.test(artifact.executableSha256) || artifact.downloadBytes < 1 || artifact.executableBytes < 1
      || !/^[a-z0-9.-]+$/u.test(artifact.executableName))) throw new Error('caddy_artifact_invalid')
    this.artifact = artifact
    this.componentRoot = join(this.stateDirectory, 'components', 'caddy')
    this.componentStorage = join(this.componentRoot, artifact?.version ?? CADDY_VERSION)
    this.executable = join(this.componentStorage, artifact?.executableName ?? (platform === 'win32' ? 'caddy.exe' : 'caddy'))
    this.logRoot = join(this.stateDirectory, 'caddy', 'logs')
    this.stagingRoot = join(this.stateDirectory, 'staging', 'caddy')
    this.fetchArtifact = options.fetchArtifact ?? ((url, signal) => downloadPinnedArtifact({ url, signal, expectedBytes: artifact?.downloadBytes ?? 0, errorPrefix: 'caddy' }))
    this.inspectExecutable = options.inspectExecutable ?? (executable => inspect(executable, () => this.assertOpen()))
    this.promote = options.promoteDirectory ?? ((source, destination) => renameCaddyPath(this.stateDirectory, source, destination))
  }

  /** Recheck a pinned executable before launching; no unverified local binary can run. */
  ensureExecutable(): Promise<void> {
    return this.enqueue(() => this.checkExecutable())
  }

  private async checkExecutable(): Promise<void> {
    const artifact = this.artifact
    if (artifact === undefined) throw new Error('caddy_component_unavailable')
    await assertCaddyParents(this.stateDirectory, this.executable)
    this.assertOpen()
    const entry = await lstat(this.executable)
    if (!entry.isFile() || entry.isSymbolicLink() || entry.size !== artifact.executableBytes
      || await digest(this.executable) !== artifact.executableSha256) throw new Error('caddy_component_invalid')
    await this.verifyMetadata(this.executable, artifact)
  }

  async initialize(): Promise<void> {
    return this.enqueue(async () => {
      this.installed = false; this.errorCode = undefined
      if (this.artifact === undefined) { this.errorCode = 'caddy_component_unavailable'; return }
      try { await this.checkExecutable(); this.installed = true } catch (error) {
        this.assertOpen()
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') this.errorCode = 'caddy_component_invalid'
      }
    })
  }

  status(): CaddyComponentStatus {
    const artifact = this.artifact
    return Object.freeze({ supported: artifact !== undefined, installed: this.installed,
      version: artifact?.version ?? CADDY_VERSION, downloadBytes: artifact?.downloadBytes ?? 0,
      installedBytes: this.installed ? artifact?.executableBytes ?? 0 : 0,
      sourceUrl: artifact?.downloadUrl ?? CADDY_DOWNLOAD_PAGE, downloadPage: CADDY_DOWNLOAD_PAGE, storagePath: this.componentRoot,
      ...(this.errorCode === undefined ? {} : { errorCode: this.errorCode }),
    })
  }

  /** Explicit installation verifies bytes and reported modules before preserving-old promotion. */
  install(): Promise<CaddyComponentStatus> {
    return this.enqueue(async () => {
      const artifact = this.artifact
      if (artifact === undefined) throw new Error('caddy_component_unavailable')
      await ensureCaddyDirectory(this.stateDirectory, this.stagingRoot)
      this.assertOpen()
      await ensureCaddyDirectory(this.stateDirectory, this.componentRoot)
      this.assertOpen()
      const staging = await mkdtemp(join(this.stagingRoot, 'install-'))
      const candidate = join(this.componentRoot, '.install-' + randomBytes(12).toString('hex'))
      const backup = join(this.componentRoot, '.previous-' + randomBytes(12).toString('hex'))
      let previous = false
      let promoted = false
      let failed = false
      let operationError: unknown
      try {
        this.assertOpen()
        const controller = new AbortController()
        const timeout = setTimeout(() => { controller.abort() }, 600_000)
        timeout.unref()
        this.download = { controller, timeout }
        let bytes: Uint8Array
        try { bytes = await this.fetchArtifact(artifact.downloadUrl, controller.signal) } finally {
          clearTimeout(timeout)
          this.download = undefined
        }
        this.assertOpen()
        controller.signal.throwIfAborted()
        if (bytes.byteLength !== artifact.downloadBytes) throw new Error('caddy_download_size_mismatch')
        if (createHash('sha256').update(bytes).digest('hex') !== artifact.downloadSha256) throw new Error('caddy_download_hash_mismatch')
        await ensureCaddyDirectory(this.stateDirectory, candidate)
        this.assertOpen()
        const executable = join(candidate, artifact.executableName)
        await writeFile(executable, bytes, { flag: 'wx', mode: 0o700 })
        await chmod(executable, 0o700)
        if (bytes.byteLength !== artifact.executableBytes || await digest(executable) !== artifact.executableSha256) throw new Error('caddy_executable_hash_mismatch')
        await this.verifyMetadata(executable, artifact)
        this.assertOpen()
        try {
          const entry = await lstat(this.componentStorage)
          this.assertOpen()
          if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error('caddy_path_invalid')
          await renameCaddyPath(this.stateDirectory, this.componentStorage, backup); previous = true
        } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
        try {
          this.assertOpen()
          await this.promote(candidate, this.componentStorage); promoted = true
        } catch (error) {
          if (previous) {
            try { await renameCaddyPath(this.stateDirectory, backup, this.componentStorage); previous = false } catch (rollbackError) {
              this.installed = false; this.errorCode = 'caddy_component_invalid'
              // Keep the only old bytes in backup and expose both failures without claiming a usable installation.
              throw new AggregateError([error, rollbackError], 'caddy_component_rollback_failed', { cause: error })
            }
          }
          throw error
        }
        this.installed = true; this.errorCode = undefined
      } catch (error) { failed = true; operationError = error; throw error } finally {
        const cleanupErrors: unknown[] = []
        for (const path of [staging, candidate, ...(previous && promoted ? [backup] : [])]) {
          this.cleanupPaths.add(path)
          try {
            await removeCaddyTree(this.stateDirectory, path)
            this.cleanupPaths.delete(path)
          } catch (error) { cleanupErrors.push(error) }
        }
        if (cleanupErrors.length > 0) {
          if (!failed && cleanupErrors.length === 1) throw cleanupErrors[0]
          throw new AggregateError([...(failed ? [operationError] : []), ...cleanupErrors], 'caddy_component_cleanup_failed',
            failed ? { cause: operationError } : undefined)
        }
      }
    }).then(() => this.status())
  }

  /** Remove optional component files; callers stop the controller and purge runtime configuration separately. */
  purge(): Promise<CaddyComponentStatus> {
    return this.enqueue(async () => {
      await removeCaddyTree(this.stateDirectory, this.componentRoot)
      await removeCaddyTree(this.stateDirectory, this.stagingRoot)
      this.installed = false; this.errorCode = this.artifact === undefined ? 'caddy_component_unavailable' : undefined
    }).then(() => this.status())
  }

  /**
   * Permanently stop admission and abort downloads, then await admitted work and cleanup.
   * An already started promotion/purge settles normally; cancellation does not undo committed bytes.
   * A downloader that ignores abort remains owned until its promise settles. Failed temporary cleanup
   * is retried here; a failed close can be called again without reopening admission or deleting recovery backups.
   */
  close(): Promise<void> {
    if (this.closing !== undefined) return this.closing
    this.closed = true
    if (this.download !== undefined) {
      clearTimeout(this.download.timeout)
      this.download.controller.abort(new Error('caddy_component_closed'))
    }
    const task = this.queue.then(async () => {
      const errors: unknown[] = []
      for (const path of this.cleanupPaths) {
        try {
          await removeCaddyTree(this.stateDirectory, path)
          this.cleanupPaths.delete(path)
        } catch (error) { errors.push(error) }
      }
      if (errors.length === 1) throw errors[0]
      if (errors.length > 1) throw new AggregateError(errors, 'caddy_component_cleanup_failed')
    })
    this.closing = task
    void task.catch(() => { if (this.closing === task) this.closing = undefined })
    return task
  }

  private async verifyMetadata(executable: string, artifact: CaddyArtifact): Promise<void> {
    this.assertOpen()
    const info = await this.inspectExecutable(executable)
    this.assertOpen()
    if (!info.version.startsWith('v' + artifact.version + ' ')) throw new Error('caddy_executable_version_mismatch')
    const nonstandard = info.modules.split(/\r?\n/u).filter(line => line.startsWith('dns.providers.'))
    if (nonstandard.length !== 1 || nonstandard[0] !== 'dns.providers.tencentcloud ' + artifact.dnsPluginVersion
      || !info.modules.includes('Non-standard modules: 1')) throw new Error('caddy_executable_modules_mismatch')
  }

  private assertOpen(): void {
    if (this.closed) throw new Error('caddy_component_closed')
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    if (this.closed) return Promise.reject(new Error('caddy_component_closed'))
    const task = this.queue.then(() => { this.assertOpen(); return operation() })
    this.queue = task.then(() => undefined, () => undefined)
    return task
  }
}
