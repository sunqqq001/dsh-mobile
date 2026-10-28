import { Context } from '@deepseek-ai/cordis'
import type { CommandDefinition } from '@deepseek-ai/dsh-commands'
import type { WebRoute, WebServer } from '@deepseek-ai/dsh-host-webserver'
import { ChildProcess, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer, request as requestHttp } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { PassThrough } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Config, type PluginConfig } from '../src/config.js'
import { CpolarComponentManager } from '../src/cpolar-component.js'
import { MobileAccessGateway } from '../src/gateway.js'
import { apply, inject } from '../src/plugin.js'

vi.mock('node:child_process', async importOriginal => {
  const original = await importOriginal<typeof import('node:child_process')>()
  return { ...original, spawn: vi.fn() }
})

class ProviderChild extends ChildProcess {
  override exitCode: number | null = null
  override readonly stdin = new PassThrough()
  override readonly stdout = new PassThrough()
  override readonly stderr = new PassThrough()
  override readonly stdio: ChildProcessWithoutNullStreams['stdio'] = [this.stdin, this.stdout, this.stderr, undefined, undefined]

  establish(origin: string): void {
    this.stdout.write(`time="now" level=info msg="Tunnel established at ${origin}"\n`)
  }

  rejectReservation(): void {
    this.stderr.write('reserved subdomain is not available to this account\n')
    this.finish(1)
  }

  override kill(): boolean {
    if (this.exitCode !== null || this.signalCode !== null) return false
    this.finish(0)
    return true
  }

  private finish(code: number): void {
    this.exitCode = code
    this.stdin.destroy()
    this.stdout.destroy()
    this.stderr.destroy()
    setImmediate(() => { this.emit('close', code) })
  }
}

interface MountedPlugin {
  readonly route: WebRoute
  readonly component: CpolarComponentManager
}

interface ResponseBody {
  readonly status: number
  readonly body: string
}

const contexts: Context[] = []
const directories: string[] = []
const children: ProviderChild[] = []
const componentExecutables = new Set<string>()
const components: CpolarComponentManager[] = []

beforeEach(() => {
  vi.spyOn(CpolarComponentManager.prototype, 'initialize').mockImplementation(async function (this: CpolarComponentManager) {
    // Account provisioning and verified binary installation are separate checks;
    // this fixture supplies inert regular files at the real manager's owned paths.
    components.push(this)
    componentExecutables.add(this.executable)
    await Promise.all([
      mkdir(dirname(this.executable), { recursive: true }),
      mkdir(dirname(this.configFile), { recursive: true }),
    ])
    await Promise.all([
      writeFile(this.executable, 'inert composition fixture'),
      writeFile(this.configFile, 'authtoken: fixture-account-token\n'),
    ])
  })
  const originalStatus = CpolarComponentManager.prototype.status
  vi.spyOn(CpolarComponentManager.prototype, 'status').mockImplementation(function (this: CpolarComponentManager) {
    return { ...originalStatus.call(this), supported: true, installed: true, configured: true }
  })
  vi.spyOn(MobileAccessGateway.prototype, 'start')
  vi.mocked(spawn).mockImplementation((executable, args) => {
    if (!componentExecutables.has(executable)) throw new Error('fixture refused an unowned subprocess')
    if (!Array.isArray(args)) throw new Error('cpolar must receive an argv array')
    const child = new ProviderChild()
    children.push(child)
    return child
  })
})

afterEach(async () => {
  const disposed = await Promise.allSettled(contexts.splice(0).map(context => context.fiber.dispose()))
  for (const child of children.splice(0)) {
    if (child.exitCode !== null || child.signalCode !== null) continue
    const closed = new Promise<void>(resolve => { child.once('close', () => resolve()) })
    child.kill()
    await closed
  }
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
  components.splice(0)
  componentExecutables.clear()
  vi.restoreAllMocks()
  vi.mocked(spawn).mockReset()
  const failed = disposed.find(result => result.status === 'rejected')
  if (failed?.status === 'rejected') throw failed.reason
})

async function mount(config: Partial<PluginConfig>): Promise<MountedPlugin> {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-mobile-cpolar-composition-'))
  directories.push(directory)
  let route: WebRoute | undefined
  const context = new Context()
  contexts.push(context)
  context.provide('webServer', {
    port: 3080,
    register(candidate: WebRoute) {
      route = candidate
      return () => { if (route === candidate) route = undefined }
    },
  } as WebServer)
  context.provide('commands', {
    register(_command: CommandDefinition) { return () => undefined },
  } as never)
  context.provide('connection', {
    authenticatedUrl: (origin: string) => origin,
    requestRejection: () => undefined,
  } as never)
  await context.plugin({ Config, inject, apply }, {
    listenPort: 0,
    stateFile: join(directory, 'devices.json'),
    controlFile: join(directory, 'control.json'),
    customCssFile: join(directory, 'mobile.css'),
    customScriptFile: join(directory, 'mobile.js'),
    initiallyEnabled: false,
    tls: { mode: 'disabled' },
    ...config,
  }).await()
  const component = components.at(-1)
  if (route === undefined || component === undefined) throw new Error('plugin did not complete cpolar composition')
  return { route, component }
}

async function request(port: number, host: string, method: 'GET' | 'POST', path: string, body = ''): Promise<ResponseBody> {
  return new Promise((resolve, reject) => {
    const outgoing = requestHttp({
      hostname: '127.0.0.1', port, method, path, agent: false, timeout: 2_000,
      headers: {
        host,
        ...(method === 'POST' ? {
          origin: `http://${host}`, 'sec-fetch-site': 'same-origin',
          'content-type': 'application/json', 'content-length': Buffer.byteLength(body),
        } : {}),
      },
    }, response => {
        const chunks: Buffer[] = []
        response.on('data', chunk => chunks.push(Buffer.from(chunk)))
        response.once('error', reject)
        response.once('end', () => resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }))
    })
    outgoing.once('error', reject)
    outgoing.once('timeout', () => { outgoing.destroy(new Error('owned HTTP fixture timed out')) })
    outgoing.end(body)
  })
}

async function invoke(route: WebRoute, method: 'GET' | 'POST', path: string, body = ''): Promise<ResponseBody> {
  const server = createServer((incoming, response) => { void route.handler(incoming, response) })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve() })
  })
  const port = (server.address() as AddressInfo).port
  try { return await request(port, `127.0.0.1:${String(port)}`, method, path, body) }
  finally { await new Promise<void>(resolve => { server.close(() => resolve()) }) }
}

async function start(mounted: MountedPlugin): Promise<ProviderChild> {
  const selected = await invoke(mounted.route, 'POST', '/api/mobile-access/remote/provider', '{"provider":"cpolar"}')
  expect(selected.status).toBe(200)
  const started = await invoke(mounted.route, 'POST', '/api/mobile-access/remote/control', '{"running":true}')
  expect(started.status).toBe(200)
  expect(JSON.parse(started.body)).toMatchObject({ provider: 'cpolar', running: true, state: 'starting' })
  const child = children.at(-1)
  if (child === undefined) throw new Error('cpolar controller did not spawn')
  return child
}

describe('loader cpolar options through the resident plugin', () => {
  it.each([
    ['omitted', {}],
    ['empty', { cpolarSubdomain: '', cpolarRegion: '' }],
    ['blank', { cpolarSubdomain: '  \t ', cpolarRegion: '  \t ' }],
  ] as const)('keeps provider-selected defaults for %s configuration', async (_label, config) => {
    const mounted = await mount(config)
    await start(mounted)
    expect(spawn).toHaveBeenCalledOnce()
    const [executable, args, options] = vi.mocked(spawn).mock.calls[0]!
    expect(executable).toBe(mounted.component.executable)
    expect(args).toEqual([
      'http', `-config=${mounted.component.configFile}`, '-inspect-addr=false', '-redirect-https=true',
      '-log=stdout', '-log-level=INFO', expect.stringMatching(/^\d+$/u),
    ])
    expect(options).toMatchObject({ shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
    expect(MobileAccessGateway.prototype.start).not.toHaveBeenCalled()
  })

  it('passes trimmed reserved settings to spawn and trusts the provider-established HTTPS origin', async () => {
    const mounted = await mount({ cpolarSubdomain: ' reserved ', cpolarRegion: ' cn_vip ' })
    const child = await start(mounted)
    const argv = vi.mocked(spawn).mock.calls[0]![1]
    expect(argv).toEqual([
      'http', `-config=${mounted.component.configFile}`, '-subdomain=reserved', '-region=cn_vip',
      '-inspect-addr=false', '-redirect-https=true', '-log=stdout', '-log-level=INFO', expect.stringMatching(/^\d+$/u),
    ])
    const providerOrigin = 'https://provider-confirmed.vip.cpolar.cn'
    child.establish(providerOrigin)
    await expect.poll(async () => JSON.parse((await invoke(mounted.route, 'GET', '/api/mobile-access/remote/control')).body))
      .toMatchObject({ provider: 'cpolar', running: true, state: 'ready', origin: providerOrigin })
    expect(MobileAccessGateway.prototype.start).toHaveBeenCalledOnce()
    const remoteStatus = await invoke(mounted.route, 'GET', '/api/mobile-access/remote/status')
    expect(remoteStatus.status).toBe(200)
    const payload = JSON.parse(remoteStatus.body) as { gateway: { origin: string; host: string; port: number } }
    expect(payload.gateway).toMatchObject({ origin: providerOrigin, host: '127.0.0.1' })
    expect(payload.gateway.port).toBe(Number((argv as string[]).at(-1)))
    const health = await request(payload.gateway.port, new URL(providerOrigin).host, 'GET', '/mobile-access/health')
    expect(health.status).toBe(200)
    expect(JSON.parse(health.body)).toEqual({ ok: true })
    const pairing = await invoke(mounted.route, 'POST', '/api/mobile-access/remote/pairing/open', '{}')
    expect(pairing.status).toBe(201)
    const links = JSON.parse(pairing.body) as { pairUrl: string; appPairUrl: string }
    expect(new URL(links.pairUrl).origin).toBe(providerOrigin)
    expect(new URL(links.appPairUrl).origin).toBe(providerOrigin)
  })

  it.each([
    [{ cpolarSubdomain: '-leading' }, 'cpolar subdomain is invalid'],
    [{ cpolarSubdomain: 'https://reserved.cpolar.cn' }, 'cpolar subdomain is invalid'],
    [{ cpolarSubdomain: 'a'.repeat(64) }, 'cpolar subdomain is invalid'],
    [{ cpolarRegion: 'CN_VIP' }, 'cpolar region is invalid'],
    [{ cpolarRegion: 'cn-vip' }, 'cpolar region is invalid'],
  ] as const)('rejects invalid nonempty loader settings before any process or gateway: %j', async (config, message) => {
    await expect(mount(config)).rejects.toThrow(message)
    expect(spawn).not.toHaveBeenCalled()
    expect(MobileAccessGateway.prototype.start).not.toHaveBeenCalled()
  })

  it('does not synthesize a gateway or pairing address when the account rejects a reserved name', async () => {
    const mounted = await mount({ cpolarSubdomain: 'reserved', cpolarRegion: 'cn_vip' })
    const child = await start(mounted)
    expect(vi.mocked(spawn).mock.calls[0]![1]).toContain('-subdomain=reserved')
    child.rejectReservation()
    await expect.poll(async () => JSON.parse((await invoke(mounted.route, 'GET', '/api/mobile-access/remote/control')).body))
      .toMatchObject({ provider: 'cpolar', running: true, state: 'error', errorCode: 'cpolar_exited' })
    const status = await invoke(mounted.route, 'GET', '/api/mobile-access/remote/control')
    expect(JSON.parse(status.body)).not.toHaveProperty('origin')
    expect(MobileAccessGateway.prototype.start).not.toHaveBeenCalled()
    const pairing = await invoke(mounted.route, 'POST', '/api/mobile-access/remote/pairing/open', '{}')
    expect(pairing.status).toBe(409)
    expect(JSON.parse(pairing.body)).toEqual({ error: 'gateway_stopped' })
  })
})
