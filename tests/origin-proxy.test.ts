import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { MobileAccessControlState, MobileAccessControlStore } from '../src/control.js'
import type { MobileAccessGateway } from '../src/gateway.js'
import { OriginConfigStore } from '../src/origin-proxy-config.js'
import { OriginController, type OriginStatus } from '../src/origin-proxy.js'

const directories: string[] = []
const controllers: OriginController[] = []
afterEach(async () => {
  await Promise.all(controllers.splice(0).map(controller => controller.close()))
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
  vi.unstubAllGlobals()
})
class MemoryStore implements MobileAccessControlStore {
  state: MobileAccessControlState = { version: 1, enabled: false }
  async load(): Promise<MobileAccessControlState> { return this.state }
  async save(state: MobileAccessControlState): Promise<void> { this.state = state }
}
function gateway(port = 41234): MobileAccessGateway {
  return {
    address: () => ({ host: '127.0.0.1', port, origin: 'https://phone.example.com:8815' }),
    close: vi.fn(async () => undefined),
  } as unknown as MobileAccessGateway
}
async function fixture(configured = true, createGateway = vi.fn(async () => gateway())) {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-mobile-origin-'))
  directories.push(directory)
  const config = new OriginConfigStore(join(directory, 'origin', 'config'))
  await config.initialize()
  if (configured) await config.configure({ publicOrigin: 'https://phone.example.com:8815' })
  const store = new MemoryStore()
  const statuses: OriginStatus[] = []
  const controller = new OriginController({ store, config, createGateway, onStatus: status => statuses.push(status) })
  controllers.push(controller)
  return { controller, config, store, statuses, createGateway }
}

describe('self-hosted HTTP origin lifecycle', () => {
  it('owns only a gateway, preserving external HTTPS and reporting the actual backend port', async () => {
    const fetch = vi.fn()
    vi.stubGlobal('fetch', fetch)
    const { controller, createGateway, statuses, store } = await fixture()
    await controller.initialize()
    expect(createGateway).not.toHaveBeenCalled()
    await controller.setEnabled(true)
    expect(controller.status()).toEqual({ enabled: true, state: 'ready', origin: 'https://phone.example.com:8815', backendOrigin: 'http://127.0.0.1:41234' })
    expect(statuses.map(status => status.state)).toEqual(['off', 'starting', 'ready'])
    expect(store.state.enabled).toBe(true)
    expect(fetch).not.toHaveBeenCalled()
    const active = controller.gateway()!
    await controller.setEnabled(false)
    expect(active.close).toHaveBeenCalledOnce()
    expect(controller.gateway()).toBeUndefined()
    expect(controller.status()).toEqual({ enabled: false, state: 'off' })
  })

  it('restores a saved enabled switch without a tunnel component', async () => {
    const { controller, store } = await fixture()
    store.state = { version: 1, enabled: true }
    await controller.initialize()
    expect(controller.status().state).toBe('ready')
    await controller.close()
    expect(store.state.enabled).toBe(true)
    expect(controller.gateway()).toBeUndefined()
    await expect(controller.reconnect()).rejects.toThrow('origin_controller_unavailable')
  })

  it('does not open a listener before settings are configured', async () => {
    const { controller, createGateway } = await fixture(false)
    await controller.initialize()
    await controller.setEnabled(true)
    expect(controller.status()).toEqual({ enabled: true, state: 'unavailable', errorCode: 'origin_config_missing' })
    expect(createGateway).not.toHaveBeenCalled()
  })

  it.each([
    ['EADDRINUSE', 'origin_listen_port_in_use'],
    ['EADDRNOTAVAIL', 'origin_listen_address_unavailable'],
    ['UNEXPECTED', 'origin_gateway_start_failed'],
  ])('reports safe bind failure %s and can retry', async (code, errorCode) => {
    const createGateway = vi.fn(async () => gateway())
    createGateway.mockRejectedValueOnce(Object.assign(new Error('private details'), { code }))
    const { controller } = await fixture(true, createGateway)
    await controller.initialize()
    await controller.setEnabled(true)
    expect(controller.status()).toMatchObject({ enabled: true, state: 'error', errorCode })
    expect(JSON.stringify(controller.status())).not.toContain('private details')
    expect(controller.gateway()).toBeUndefined()
    await controller.setEnabled(true)
    expect(controller.status().state).toBe('ready')
  })

  it('serializes reconnect and disable without leaving a stale listener', async () => {
    const created: MobileAccessGateway[] = []
    const createGateway = vi.fn(async () => { const active = gateway(); created.push(active); return active })
    const { controller } = await fixture(true, createGateway)
    await controller.initialize()
    await controller.setEnabled(true)
    await Promise.all([controller.reconnect(), controller.setEnabled(false)])
    expect(created).toHaveLength(2)
    for (const active of created) expect(active.close).toHaveBeenCalledOnce()
    expect(controller.status().state).toBe('off')
    expect(controller.gateway()).toBeUndefined()
  })

  it('closes a late start when disposal happens while the factory is pending', async () => {
    let release!: (value: MobileAccessGateway) => void
    const pending = new Promise<MobileAccessGateway>(resolve => { release = resolve })
    const createGateway = vi.fn(() => pending)
    const { controller, statuses } = await fixture(true, createGateway)
    await controller.initialize()
    const enabling = controller.setEnabled(true)
    await vi.waitFor(() => { expect(createGateway).toHaveBeenCalledOnce() })
    const closing = controller.close()
    const active = gateway()
    release(active)
    await Promise.all([enabling, closing])
    expect(active.close).toHaveBeenCalledOnce()
    expect(controller.gateway()).toBeUndefined()
    expect(statuses.some(status => status.state === 'ready')).toBe(false)
  })

  it('retains ownership after a close failure and keeps the operation queue usable', async () => {
    const active = gateway()
    vi.mocked(active.close).mockRejectedValueOnce(new Error('close failed'))
    const { controller } = await fixture(true, vi.fn(async () => active))
    await controller.initialize()
    await controller.setEnabled(true)
    await expect(controller.setEnabled(false)).rejects.toThrow('close failed')
    expect(controller.gateway()).toBe(active)
    await controller.setEnabled(false)
    expect(controller.gateway()).toBeUndefined()
    expect(controller.status().state).toBe('off')
  })

  it('reports non-Error factory failures without breaking the lifecycle queue', async () => {
    const createGateway = vi.fn(async () => gateway()).mockRejectedValueOnce(null)
    const { controller } = await fixture(true, createGateway)
    await controller.initialize()
    await controller.setEnabled(true)
    expect(controller.status()).toMatchObject({ enabled: true, state: 'error', errorCode: 'origin_gateway_start_failed' })
    await controller.reconnect()
    expect(controller.status().state).toBe('ready')
  })

  it('does not claim a closed listener is ready when disabling cannot be persisted', async () => {
    const { controller, store } = await fixture()
    await controller.initialize()
    await controller.setEnabled(true)
    vi.spyOn(store, 'save').mockRejectedValueOnce(new Error('disk unavailable'))
    await expect(controller.setEnabled(false)).rejects.toThrow('disk unavailable')
    expect(controller.gateway()).toBeUndefined()
    expect(controller.status()).toEqual({ enabled: true, state: 'off' })
    await controller.setEnabled(false)
    expect(controller.status()).toEqual({ enabled: false, state: 'off' })
  })

  it('resets the switch without purging saved settings', async () => {
    const { controller, config, store } = await fixture()
    await controller.initialize()
    await controller.setEnabled(true)
    await controller.reset()
    expect(store.state.enabled).toBe(false)
    expect(config.status().configured).toBe(true)
  })
})
