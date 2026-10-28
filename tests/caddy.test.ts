import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { CaddyComponentManager, CADDY_VERSION, type CaddyArtifact } from '../src/caddy-component.js'
import { CaddyConfigStore, parseCaddySettings, renderCaddyfile } from '../src/caddy-config.js'
import { caddyProcessEnvironment } from '../src/caddy.js'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })
async function directory(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-mobile-caddy-'))
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  return root
}
const settings = { version: 1, publicOrigin: 'https://phone.example.com', dnsProvider: 'tencentcloud', listenPort: 8443 }
const credentials = { secretId: 'test-id', secretKey: 'test-secret' }
const bytes = new TextEncoder().encode('verified executable fixture')
const hash = createHash('sha256').update(bytes).digest('hex')
const artifact: CaddyArtifact = {
  version: CADDY_VERSION, platform: 'win32', arch: 'x64', downloadUrl: 'https://example.com/immutable/caddy.exe',
  downloadBytes: bytes.length, downloadSha256: hash, executableName: 'caddy.exe', executableBytes: bytes.length,
  executableSha256: hash, dnsPluginVersion: 'v0.4.3',
}
const metadata = { version: 'v' + CADDY_VERSION + ' h1:fixture', modules: 'dns.providers.tencentcloud v0.4.3\nNon-standard modules: 1\n' }
function manager(root: string, overrides: Partial<ConstructorParameters<typeof CaddyComponentManager>[0]> = {}): CaddyComponentManager {
  return new CaddyComponentManager({ stateDirectory: root, platform: 'win32', arch: 'x64', artifact,
    fetchArtifact: async () => bytes, inspectExecutable: async () => metadata, ...overrides })
}

describe('managed Caddy configuration', () => {
  it('uses the local TLS port independently from the public NAT port and retains public Host validation', () => {
    const rendered = renderCaddyfile(parseCaddySettings(settings), '/private', 51234)
    expect(rendered).toContain('https://phone.example.com:8443 {')
    expect(rendered).toContain('reverse_proxy 127.0.0.1:51234')
    expect(rendered).toContain('header_up Host {http.request.hostport}')
    expect(rendered).toContain('secret_id {env.TENCENTCLOUD_SECRET_ID}')
    expect(rendered).toContain('secret_key {env.TENCENTCLOUD_SECRET_KEY}')
    expect(rendered).not.toContain('tencentcloud_secret_id')
    expect(rendered).toContain('admin off'); expect(rendered).toContain('persist_config off')
    expect(rendered).toContain('output discard'); expect(rendered).not.toContain('response_header_timeout')
    expect(rendered).not.toContain(credentials.secretKey)
  })
  it.each([3080, 3443, 3444, 80, 0, 65536, 1.5])('rejects reserved or invalid local port %s', port => {
    expect(() => parseCaddySettings({ ...settings, listenPort: port })).toThrow()
  })
  it.each(['http://phone.example.com', 'https://localhost', 'https://10.0.0.1', 'https://phone.example.com/path', 'https://a.example.com@evil.example.com'])('rejects an unsafe public origin %s', publicOrigin => {
    expect(() => parseCaddySettings({ ...settings, publicOrigin })).toThrow()
  })
  it('validates the whole update before replacing settings or credentials and keeps secrets out of status', async () => {
    const root = await directory(); const store = new CaddyConfigStore(root)
    await store.initialize(); await expect(store.configure(settings)).rejects.toThrow('caddy_credentials_missing')
    await store.configure(settings, credentials)
    const before = await readFile(store.settingsFile, 'utf8')
    await expect(store.configure({ ...settings, listenPort: 9443 }, { secretId: 'invalid id', secretKey: 'new' })).rejects.toThrow()
    expect(await readFile(store.settingsFile, 'utf8')).toBe(before)
    expect(store.settings()?.listenPort).toBe(8443)
    await store.configure({ ...settings, listenPort: 9443 }, { secretId: '', secretKey: '' })
    expect(store.credentials()).toEqual(credentials)
    expect(JSON.stringify(store.status())).not.toContain(credentials.secretKey)
    const restored = new CaddyConfigStore(root); await restored.initialize()
    expect(restored.settings()?.listenPort).toBe(9443); expect(restored.credentials()).toEqual(credentials)
  })
  it('scrubs ambient secrets, Caddy admin and proxy overrides and owns platform directories', async () => {
    const root = await directory(); const store = new CaddyConfigStore(root)
    await store.configure(settings, credentials)
    const environment = caddyProcessEnvironment(store, parseCaddySettings(settings), {
      SystemRoot: 'C:/Windows', OPENAI_API_KEY: 'do-not-inherit', CADDY_ADMIN: ':2019', HTTP_PROXY: 'http://proxy',
      HOME: '/unrelated', XDG_DATA_HOME: '/unrelated-data',
    })
    expect(environment.OPENAI_API_KEY).toBeUndefined(); expect(environment.CADDY_ADMIN).toBeUndefined()
    expect(environment.HTTP_PROXY).toBeUndefined(); expect(environment.HOME).toBe(store.rootDirectory)
    expect(environment.XDG_CONFIG_HOME).toBe(store.configDirectory)
    expect(environment.TENCENTCLOUD_SECRET_KEY).toBe(credentials.secretKey)
  })
  it('purges credentials, certificate private keys, logs and caches but preserves unrelated device records', async () => {
    const root = await directory(); const store = new CaddyConfigStore(root)
    await store.configure(settings, credentials); await store.prepareCaddyfile(50001)
    await writeFile(join(store.dataDirectory, 'certificate.key'), 'fake private key')
    await writeFile(join(store.logsDirectory, 'old.log'), 'log')
    await writeFile(join(store.configDirectory, 'autosave.json'), 'cache')
    await writeFile(join(root, 'paired-devices.json'), 'paired')
    await store.purge()
    await expect(stat(store.rootDirectory)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await readFile(join(root, 'paired-devices.json'), 'utf8')).toBe('paired')
    expect(store.status().configured).toBe(false)
  })
  it('refuses linked config ancestors and unlinks a cleanup junction without deleting its target', async () => {
    const root = await directory(); const outside = await directory()
    await writeFile(join(outside, 'keep.txt'), 'outside')
    await symlink(outside, join(root, 'caddy'), 'junction')
    const store = new CaddyConfigStore(root)
    await expect(store.configure(settings, credentials)).rejects.toThrow('caddy_path_invalid')
    await store.purge()
    expect(await readFile(join(outside, 'keep.txt'), 'utf8')).toBe('outside')
  })
})

describe('managed Caddy components', () => {
  it('refuses installation on an unsupported platform', async () => {
    const root = await directory(); const component = new CaddyComponentManager({ stateDirectory: root, platform: 'darwin', arch: 'arm64' })
    await component.initialize()
    expect(component.status()).toMatchObject({ installed: false, supported: false, errorCode: 'caddy_component_unavailable' })
    await expect(component.install()).rejects.toThrow('caddy_component_unavailable')
  })
  it('installs, rechecks size, hash, reported core and DNS module before launch, then removes the component', async () => {
    const root = await directory(); const component = manager(root)
    await component.initialize(); expect(component.status().installed).toBe(false)
    await component.install(); await component.ensureExecutable()
    expect(await readFile(component.executable)).toEqual(Buffer.from(bytes))
    await writeFile(component.executable, new Uint8Array(bytes.length).fill(90))
    await expect(component.ensureExecutable()).rejects.toThrow('caddy_component_invalid')
    await component.purge(); await expect(stat(component.componentRoot)).rejects.toMatchObject({ code: 'ENOENT' })
  })
  it('rejects same-sized wrong hashes without executing them', async () => {
    const root = await directory(); let inspections = 0
    const component = manager(root, { stateDirectory: root, fetchArtifact: async () => new Uint8Array(bytes.length).fill(90),
      inspectExecutable: async () => { inspections++; return metadata } })
    await expect(component.install()).rejects.toThrow('caddy_download_hash_mismatch')
    expect(inspections).toBe(0)
  })
  it.each([{ ...metadata, version: 'v2.11.8 h1:other' }, { ...metadata, modules: 'dns.providers.tencentcloud v0.4.2\nNon-standard modules: 1' },
    { ...metadata, modules: 'dns.providers.tencentcloud v0.4.3\nNon-standard modules: 2' }])('rejects metadata mismatches %j', async info => {
    const root = await directory(); const component = manager(root, { stateDirectory: root, inspectExecutable: async () => info })
    await expect(component.install()).rejects.toThrow(/caddy_executable_(version|modules)_mismatch/u)
    await expect(stat(component.componentStorage)).rejects.toMatchObject({ code: 'ENOENT' })
  })
  it('restores the previous installation when promotion fails', async () => {
    const root = await directory(); const first = manager(root); await first.install()
    const component = manager(root, { stateDirectory: root, promoteDirectory: async () => { throw new Error('promotion_failed') } })
    await component.initialize(); await expect(component.install()).rejects.toThrow('promotion_failed')
    expect(await readFile(component.executable)).toEqual(Buffer.from(bytes))
    await component.ensureExecutable()
  })
})
