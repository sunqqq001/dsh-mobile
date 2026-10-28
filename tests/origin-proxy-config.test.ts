import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { OriginConfigStore, parseOriginSettings } from '../src/origin-proxy-config.js'

const directories: string[] = []
afterEach(async () => {
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
})
const input = { publicOrigin: 'https://phone.example.com:8815' }
async function fixture(): Promise<{ directory: string; store: OriginConfigStore }> {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-mobile-origin-config-'))
  directories.push(directory)
  return { directory, store: new OriginConfigStore(join(directory, 'remote', 'origin', 'config')) }
}

describe('self-hosted reverse proxy settings', () => {
  it('defaults to a separate loopback HTTP listener and preserves a custom HTTPS port', () => {
    const settings = parseOriginSettings(input)
    expect(settings).toEqual({ version: 1, ...input, listenHost: '127.0.0.1', listenPort: 3444, allowedCidrs: ['127.0.0.0/8'] })
    expect(Object.isFrozen(settings)).toBe(true)
    expect(Object.isFrozen(settings.allowedCidrs)).toBe(true)
    expect(parseOriginSettings({ publicOrigin: 'https://PHONE.example.com:443/' }).publicOrigin).toBe('https://phone.example.com')
    expect(parseOriginSettings({ publicOrigin: 'https://1.1.1.1:8443' }).publicOrigin).toBe('https://1.1.1.1:8443')
  })

  it.each([
    'http://phone.example.com', 'https://localhost', 'https://foo.localhost', 'https://foo.local',
    'https://foo.lan', 'https://foo.home', 'https://foo.internal', 'https://home.arpa', 'https://foo.home.arpa',
    'https://192.168.1.2', 'https://127.0.0.1', 'https://0x7f000001', 'https://10.0.0.1',
    'https://100.64.0.1', 'https://203.0.113.10', 'https://224.0.0.1', 'https://[::1]',
    'https://user:password@phone.example.com', 'https://phone.example.com/path',
    'https://phone.example.com?query', 'https://phone.example.com#fragment',
    ' https://phone.example.com', 'https://phone.example.com\n', 'https://phone.example.com:0',
  ])('rejects invalid public origin %s', publicOrigin => {
    expect(() => parseOriginSettings({ ...input, publicOrigin })).toThrow('origin_public_origin_invalid')
  })

  it.each(['0.0.0.0', '1.1.1.1', '100.64.0.2', '169.254.1.2', 'localhost', '::1', '::ffff:127.0.0.1', '192.168.001.2'])('rejects unsafe listen host %s', listenHost => {
    expect(() => parseOriginSettings({ ...input, listenHost })).toThrow('origin_listen_host_invalid')
  })

  it.each([0, -1, 65536, 1.5, '3444', null])('rejects invalid saved port %s', listenPort => {
    expect(() => parseOriginSettings({ ...input, listenPort })).toThrow('origin_listen_port_invalid')
  })

  it('keeps the backend port in the unprivileged range', () => {
    // Below 1024 the bind needs privileges the plugin does not have, so on Linux and
    // macOS it would fail with EACCES and surface as a generic start failure.
    for (const listenPort of [1, 80, 443, 1023]) {
      expect(() => parseOriginSettings({ ...input, listenPort }), String(listenPort)).toThrow('origin_listen_port_invalid')
    }
    expect(parseOriginSettings({ ...input, listenPort: 1024 }).listenPort).toBe(1024)
  })

  it('reserves LAN port 3443 and DSH port 3080 and requires explicit proxy peers for private binds', () => {
    expect(() => parseOriginSettings({ ...input, listenPort: 3443 })).toThrow('origin_listen_port_reserved')
    // 3080 is DSH's own WebServer, which the plugin cannot work without.
    expect(() => parseOriginSettings({ ...input, listenPort: 3080 })).toThrow('origin_listen_port_reserved')
    expect(parseOriginSettings({ ...input, listenPort: 3081 }).listenPort).toBe(3081)
    expect(() => parseOriginSettings({ ...input, listenHost: '192.168.1.10' })).toThrow('origin_allowed_cidrs_invalid')
    expect(() => parseOriginSettings({ ...input, listenHost: '192.168.1.10', allowedCidrs: ['127.0.0.0/8'] })).toThrow('origin_allowed_cidrs_invalid')
    expect(parseOriginSettings({ ...input, listenHost: '192.168.1.10', allowedCidrs: ['192.168.1.1/32'] }).allowedCidrs).toEqual(['192.168.1.1/32'])
  })

  it.each([
    [], ['0.0.0.0/0'], ['128.0.0.0/1'], ['10.0.0.0/7'], ['172.0.0.0/8'],
    ['192.0.0.0/8'], ['127.0.0.0/7'], ['1.1.1.1/32'], ['192.168.1.1/24'],
    ['::ffff:127.0.0.1/32'], ['::1/128'], ['192.168.1.1'], [123], Array(17).fill('127.0.0.1/32'),
  ])('rejects unsafe proxy CIDRs %j', (...entries) => {
    // Vitest expands each table row; all entries belong to one CIDR array.
    expect(() => parseOriginSettings({ ...input, allowedCidrs: entries })).toThrow('origin_allowed_cidrs_invalid')
  })

  it('accepts only subnets entirely within RFC1918 or loopback', () => {
    const allowedCidrs = ['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', '127.0.0.0/8']
    expect(parseOriginSettings({ ...input, allowedCidrs }).allowedCidrs).toEqual(allowedCidrs)
    expect(parseOriginSettings({ ...input, allowedCidrs: ['127.0.0.1/32', '127.0.0.1/32'] }).allowedCidrs).toEqual(['127.0.0.1/32'])
    for (const value of [null, [], 1, { ...input, version: 2 }, { ...input, token: 'not-supported' }]) {
      expect(() => parseOriginSettings(value)).toThrow('origin_settings_invalid')
    }
  })

  it('round-trips private settings and purges only its own file', async () => {
    const { directory, store } = await fixture()
    await store.initialize()
    expect(store.status().configured).toBe(false)
    await store.configure(input)
    expect(store.status()).toMatchObject({ configured: true, backendOrigin: 'http://127.0.0.1:3444', publicOrigin: input.publicOrigin })
    const restored = new OriginConfigStore(store.stateRoot)
    await restored.initialize()
    expect(restored.settings()).toEqual(store.settings())
    expect((await lstat(store.settingsFile)).isFile()).toBe(true)
    const devices = join(directory, 'remote', 'devices.json')
    await writeFile(devices, 'shared paired devices')
    await store.purge()
    expect(store.status().configured).toBe(false)
    await expect(lstat(store.settingsFile)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await readFile(devices, 'utf8')).toBe('shared paired devices')
  })

  it.each(['{broken', ' '.repeat(8193), JSON.stringify({ ...input, allowedCidrs: ['0.0.0.0/0'] })])('fails closed on invalid persisted settings', async body => {
    const { store } = await fixture()
    await mkdir(store.stateRoot, { recursive: true })
    await writeFile(store.settingsFile, body)
    await store.initialize()
    expect(store.settings()).toBeUndefined()
    expect(store.status()).toMatchObject({ configured: false, errorCode: 'origin_config_invalid' })
    await store.configure(input)
    expect(store.status().errorCode).toBeUndefined()
  })

  it('refuses to overwrite a directory target', async () => {
    const { store } = await fixture()
    await mkdir(store.settingsFile, { recursive: true })
    await store.initialize()
    expect(store.status().errorCode).toBe('origin_config_invalid')
    await expect(store.configure(input)).rejects.toThrow('origin_config_target_invalid')
  })

  it.skipIf(process.platform === 'win32')('rejects symlinked settings without changing the target', async () => {
    const { directory, store } = await fixture()
    const target = join(directory, 'other.json')
    await writeFile(target, JSON.stringify(input))
    await mkdir(store.stateRoot, { recursive: true })
    await symlink(target, store.settingsFile)
    await store.initialize()
    expect(store.status().errorCode).toBe('origin_config_invalid')
    await expect(store.configure(input)).rejects.toThrow('origin_config_target_invalid')
    expect(await readFile(target, 'utf8')).toBe(JSON.stringify(input))
  })
})
