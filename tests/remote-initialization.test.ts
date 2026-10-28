import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { JsonMobileAccessControlStore, type MobileAccessControlState } from '../src/control.js'
import { FunnelController } from '../src/funnel.js'
import { CpolarController } from '../src/cpolar.js'
import { CloudflaredController } from '../src/cloudflared.js'
import { FrpController } from '../src/frp.js'
import { FrpConfigStore } from '../src/frp-config.js'
import { ManagedOriginController } from '../src/managed-origin.js'
import { REMOTE_PROVIDERS, type RemoteProvider, type RemoteProviderController } from '../src/remote.js'

const roots: string[] = []
const controllers: RemoteProviderController[] = []
afterEach(async () => {
  for (const controller of controllers.splice(0)) await controller.close()
  vi.restoreAllMocks()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

function originChild(): RemoteProviderController {
  let enabled = false
  const status = () => ({ enabled, state: enabled ? 'ready' : 'off' })
  const setEnabled = vi.fn(async (value: boolean) => { enabled = value; return status() })
  return {
    initialize: vi.fn(async () => {}), gateway: () => undefined, status, setEnabled,
    reconnect: () => setEnabled(true), reset: () => setEnabled(false), close: vi.fn(async () => {}),
  }
}

function controllerFixture(provider: RemoteProvider, store: JsonMobileAccessControlStore, root: string): {
  controller: RemoteProviderController
  createGateway: ReturnType<typeof vi.fn<() => Promise<never>>>
  children: readonly RemoteProviderController[]
} {
  const createGateway = vi.fn(async () => { throw new Error('an inactive provider must not create a gateway') })
  const executable = join(root, 'not-installed-fixture-component')
  let controller: RemoteProviderController
  let children: readonly RemoteProviderController[] = []
  switch (provider) {
    case 'tailscale':
      controller = new FunnelController({ store, executable, stateDirectory: join(root, 'tailscale'), ownedRoot: root, hostname: 'fixture-node', createGateway })
      break
    case 'cpolar':
      controller = new CpolarController({ store, executable, configFile: join(root, 'cpolar.yml'), createGateway })
      break
    case 'cloudflared':
      controller = new CloudflaredController({ store, executable, tunnel: { settings: () => ({ version: 1, mode: 'quick' }) }, createGateway })
      break
    case 'frp':
      controller = new FrpController({ store, executable, config: new FrpConfigStore(join(root, 'frp-config')), instanceId: 'a'.repeat(64), createGateway })
      break
    case 'origin': {
      const external = originChild()
      const managed = originChild()
      children = [external, managed]
      controller = new ManagedOriginController({ store, modeStore: { load: async () => ({ version: 1, mode: 'external' }), save: async () => {} }, external, managed })
      break
    }
  }
  controllers.push(controller)
  return { controller, createGateway, children }
}

async function ownedStore(initiallyEnabled: boolean): Promise<{ store: JsonMobileAccessControlStore; root: string; file: string }> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-mobile-provider-initialization-'))
  roots.push(root)
  const file = join(root, 'control.json')
  return { store: new JsonMobileAccessControlStore(file, initiallyEnabled), root, file }
}

describe('fresh remote-provider initialization state', () => {
  it.each(REMOTE_PROVIDERS)('initializes %s from its freshly disabled store without a second read, then persists manual changes', async provider => {
    const { store, root, file } = await ownedStore(true)
    const prepared = await store.disableIfPresent()
    const load = vi.spyOn(store, 'load')
    const save = vi.spyOn(store, 'save')
    const { controller, createGateway, children } = controllerFixture(provider, store, root)
    await controller.initialize(prepared)
    expect(load).not.toHaveBeenCalled()
    expect(controller.status()).toMatchObject({ enabled: false, state: 'off' })
    expect(createGateway).not.toHaveBeenCalled()
    for (const child of children) {
      expect(child.initialize).toHaveBeenCalledOnce()
      expect(child.setEnabled).toHaveBeenCalledWith(false)
      expect(child.setEnabled).not.toHaveBeenCalledWith(true)
    }

    // Missing components may be unavailable, but the initialized switch must remain mutable and durable.
    await controller.setEnabled(true)
    expect(save).toHaveBeenCalledWith({ version: 1, enabled: true })
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({ version: 1, enabled: true })
    await controller.setEnabled(false)
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({ version: 1, enabled: false })
    expect(load).not.toHaveBeenCalled()
  })

  it.each(REMOTE_PROVIDERS)('still reads the durable preference for %s when no prepared state is supplied', async provider => {
    const { store, root } = await ownedStore(false)
    const disabled: MobileAccessControlState = { version: 1, enabled: false }
    await store.save(disabled)
    const load = vi.spyOn(store, 'load')
    const { controller, createGateway } = controllerFixture(provider, store, root)
    await controller.initialize()
    expect(load).toHaveBeenCalledOnce()
    expect(controller.status()).toMatchObject({ enabled: false, state: 'off' })
    expect(createGateway).not.toHaveBeenCalled()
  })
})
