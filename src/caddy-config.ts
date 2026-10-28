import { lstat, readFile } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'
import { assertCaddyParents, ensureCaddyDirectory, removeCaddyTree, writeCaddyPrivateFile } from './caddy-files.js'
import { isCaddyDnsProvider, type CaddyDnsProvider } from './caddy-component.js'
import { validateOriginPublicOrigin } from './origin-proxy-config.js'
import { isIP } from './ip.js'
import { restrictPrivateFile } from './private-file.js'

export const DEFAULT_CADDY_LISTEN_PORT = 8443
const MAX_CONFIG_BYTES = 16 * 1024

/** Public HTTPS address and local TLS listener; a router may map their ports differently. */
export interface CaddySettings {
  readonly version: 1
  readonly publicOrigin: string
  readonly dnsProvider: CaddyDnsProvider
  readonly listenPort: number
}

/** DNS-01 credentials persisted only in the private authoritative configuration file. */
export interface CaddyCredentials { readonly secretId: string; readonly secretKey: string }

export interface CaddyConfigurationStatus {
  readonly configured: boolean
  readonly credentialsConfigured: boolean
  readonly storagePath: string
  readonly publicOrigin?: string
  readonly dnsProvider?: CaddyDnsProvider
  readonly listenPort?: number
  readonly errorCode?: string
}

/** Inject only the DNS credentials needed by the managed child. */
export function caddyCredentialEnvironment(provider: CaddyDnsProvider, credentials: CaddyCredentials): Record<string, string> {
  if (!isCaddyDnsProvider(provider)) throw new Error('caddy_dns_provider_invalid')
  return { TENCENTCLOUD_SECRET_ID: credentials.secretId, TENCENTCLOUD_SECRET_KEY: credentials.secretKey }
}

/** Validate saved or administrative settings, including ports reserved by DSH. */
export function parseCaddySettings(value: unknown): CaddySettings {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('caddy_settings_invalid')
  const record = value as Record<string, unknown>
  if (Reflect.ownKeys(record).some(key => !['version', 'publicOrigin', 'dnsProvider', 'listenPort'].includes(String(key)))
    || (record.version !== undefined && record.version !== 1)) throw new Error('caddy_settings_invalid')
  if (!isCaddyDnsProvider(record.dnsProvider)) throw new Error('caddy_dns_provider_invalid')
  const listenPort = record.listenPort ?? DEFAULT_CADDY_LISTEN_PORT
  if (!Number.isSafeInteger(listenPort) || Number(listenPort) < 1024 || Number(listenPort) > 65535) throw new Error('caddy_listen_port_invalid')
  if ([3444, 3443, 3080].includes(Number(listenPort))) throw new Error('caddy_listen_port_reserved')
  const publicOrigin = validateOriginPublicOrigin(record.publicOrigin)
  if (isIP(new URL(publicOrigin).hostname) !== 0) throw new Error('caddy_domain_required')
  return Object.freeze({ version: 1, publicOrigin, dnsProvider: record.dnsProvider, listenPort: Number(listenPort) })
}

function parseCredentials(value: unknown): CaddyCredentials {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('caddy_credentials_invalid')
  const record = value as Record<string, unknown>
  if (Reflect.ownKeys(record).some(key => key !== 'secretId' && key !== 'secretKey')) throw new Error('caddy_credentials_invalid')
  const { secretId, secretKey } = record
  if (typeof secretId !== 'string' || typeof secretKey !== 'string' || secretId.length === 0 || secretKey.length === 0
    || secretId.length > 512 || secretKey.length > 512 || /[\s\u0000-\u001f\u007f]/u.test(secretId + secretKey)) throw new Error('caddy_credentials_invalid')
  return Object.freeze({ secretId, secretKey })
}

/** Render a single TLS site, with no admin API, config autosave, or embedded DNS secrets. */
export function renderCaddyfile(settings: CaddySettings, stateDirectory: string, backendPort = 3444): string {
  const validated = parseCaddySettings(settings)
  if (!Number.isSafeInteger(backendPort) || backendPort < 1 || backendPort > 65535) throw new Error('caddy_backend_port_invalid')
  const root = resolve(stateDirectory, 'caddy')
  const dataDirectory = join(root, 'data').replaceAll('\\', '/')
  const hostname = new URL(validated.publicOrigin).hostname
  return [
    '{', '\tadmin off', '\tpersist_config off', '\tauto_https disable_redirects',
    `\tstorage file_system ${JSON.stringify(dataDirectory)}`,
    // DNS module errors can contain provider response details; raw child logs are not persisted.
    '\tlog {', '\t\toutput discard', '\t}', '}', '',
    `https://${hostname}:${String(validated.listenPort)} {`, '\ttls {', '\t\tdns tencentcloud {',
    '\t\t\tsecret_id {env.TENCENTCLOUD_SECRET_ID}', '\t\t\tsecret_key {env.TENCENTCLOUD_SECRET_KEY}', '\t\t}', '\t}',
    `\treverse_proxy 127.0.0.1:${String(backendPort)} {`,
    '\t\theader_up Host {http.request.hostport}', '\t\ttransport http {', '\t\t\tkeepalive off', '\t\t\tdial_timeout 5s', '\t\t}', '\t}', '}', '',
  ].join('\n')
}

/** Owns one atomic configuration record and every Caddy-created private file. */
export class CaddyConfigStore {
  readonly rootDirectory: string
  readonly settingsFile: string
  readonly envFile: string
  readonly caddyfile: string
  readonly dataDirectory: string
  readonly configDirectory: string
  readonly logsDirectory: string
  private settingsValue: CaddySettings | undefined
  private credentialsValue: CaddyCredentials | undefined
  private errorCodeValue: string | undefined
  private queue: Promise<void> = Promise.resolve()

  constructor(private readonly stateDirectory: string) {
    if (!isAbsolute(stateDirectory)) throw new Error('caddy config state directory must be absolute')
    this.rootDirectory = resolve(stateDirectory, 'caddy')
    this.settingsFile = join(this.rootDirectory, 'config.json')
    this.envFile = this.settingsFile
    this.caddyfile = join(this.rootDirectory, 'Caddyfile')
    this.dataDirectory = join(this.rootDirectory, 'data')
    this.configDirectory = join(this.rootDirectory, 'xdg-config')
    this.logsDirectory = join(this.rootDirectory, 'logs')
  }

  settings(): CaddySettings | undefined { return this.settingsValue }
  credentials(): CaddyCredentials | undefined { return this.credentialsValue }
  errorCode(): string | undefined { return this.errorCodeValue }

  status(): CaddyConfigurationStatus {
    const settings = this.settingsValue
    return Object.freeze({ configured: settings !== undefined && this.credentialsValue !== undefined, credentialsConfigured: this.credentialsValue !== undefined,
      storagePath: this.rootDirectory,
      ...(settings === undefined ? {} : { publicOrigin: settings.publicOrigin, listenPort: settings.listenPort, dnsProvider: settings.dnsProvider }),
      ...(this.errorCodeValue === undefined ? {} : { errorCode: this.errorCodeValue }),
    })
  }

  async initialize(): Promise<void> {
    await this.enqueue(async () => {
      this.settingsValue = undefined; this.credentialsValue = undefined; this.errorCodeValue = undefined
      await assertCaddyParents(this.stateDirectory, this.settingsFile)
      let entry
      try { entry = await lstat(this.settingsFile) } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
        throw error
      }
      if (!entry.isFile() || entry.isSymbolicLink() || entry.size > MAX_CONFIG_BYTES) { this.errorCodeValue = 'caddy_config_invalid'; return }
      await restrictPrivateFile(this.settingsFile)
      try {
        const record: unknown = JSON.parse(await readFile(this.settingsFile, 'utf8'))
        if (typeof record !== 'object' || record === null || Array.isArray(record)) throw new Error('invalid')
        const values = record as Record<string, unknown>
        if (Reflect.ownKeys(values).some(key => key !== 'settings' && key !== 'credentials')) throw new Error('invalid')
        const settings = parseCaddySettings(values.settings)
        const credentials = parseCredentials(values.credentials)
        this.settingsValue = settings; this.credentialsValue = credentials
      } catch { this.errorCodeValue = 'caddy_config_invalid' }
    })
  }

  /** Atomically save validated settings and credentials; omitted or both-blank secrets retain saved ones. */
  configure(value: unknown, credentialInput?: unknown): Promise<void> {
    return this.enqueue(async () => {
      const settings = parseCaddySettings(value)
      const blank = typeof credentialInput === 'object' && credentialInput !== null && !Array.isArray(credentialInput)
        && (credentialInput as Record<string, unknown>).secretId === '' && (credentialInput as Record<string, unknown>).secretKey === ''
        && Reflect.ownKeys(credentialInput).every(key => key === 'secretId' || key === 'secretKey')
      const credentials = credentialInput === undefined || blank ? this.credentialsValue : parseCredentials(credentialInput)
      if (credentials === undefined) throw new Error('caddy_credentials_missing')
      await writeCaddyPrivateFile(this.stateDirectory, this.settingsFile, JSON.stringify({ settings, credentials }) + '\n')
      this.settingsValue = settings; this.credentialsValue = credentials; this.errorCodeValue = undefined
    })
  }

  /** Write derived runtime files after authoritative settings are available. */
  prepareCaddyfile(backendPort: number): Promise<void> {
    return this.enqueue(async () => {
      const settings = this.settingsValue
      if (settings === undefined || this.credentialsValue === undefined) throw new Error('caddy_config_missing')
      for (const directory of [this.dataDirectory, this.configDirectory, this.logsDirectory]) await ensureCaddyDirectory(this.stateDirectory, directory)
      await writeCaddyPrivateFile(this.stateDirectory, this.caddyfile, renderCaddyfile(settings, this.stateDirectory, backendPort))
    })
  }

  /** Remove credentials, certificates, private keys, configuration, logs, and runtime cache. */
  purge(): Promise<void> {
    return this.enqueue(async () => {
      await removeCaddyTree(this.stateDirectory, this.rootDirectory)
      this.settingsValue = undefined; this.credentialsValue = undefined; this.errorCodeValue = undefined
    })
  }

  private enqueue(operation: () => Promise<void>): Promise<void> {
    const task = this.queue.then(operation, operation)
    this.queue = task.then(() => undefined, () => undefined)
    return task
  }
}
