import { EventEmitter } from 'node:events'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { PassThrough } from 'node:stream'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { MobileAccessControlState, MobileAccessControlStore } from '../src/control.js'
import { FrpConfigStore } from '../src/frp-config.js'
import { FrpController, type FrpControllerOptions, type FrpDiscoveryProbeTarget } from '../src/frp.js'
import type { MobileAccessGateway } from '../src/gateway.js'

/**
 * The FRP self-check must compare the discovery advertisement against the
 * identity the FRP gateway itself advertises, never against the plugin-wide
 * LAN identity.
 *
 * In the self-signed ingress mode the gateway is pinned to the ingress CA
 * fingerprint (`frpIngressGatewayConfig` sets `instanceId: ingress.caFingerprint`),
 * which deliberately differs from the plugin instance id used for LAN pairing.
 * A self-check written against the plugin id therefore never matches and the
 * channel can only end in `frp_start_timeout`.
 */

const LAN_INSTANCE_ID = 'a'.repeat(64)
const INGRESS_INSTANCE_ID = 'f'.repeat(64)

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
})

class MemoryControlStore implements MobileAccessControlStore {
  state: MobileAccessControlState = { version: 1, enabled: false }

  async load(): Promise<MobileAccessControlState> { return this.state }
  async save(state: MobileAccessControlState): Promise<void> { this.state = state }
}

class FakeChild extends EventEmitter {
  readonly stdin = new PassThrough()
  readonly stdout = new PassThrough()
  readonly stderr = new PassThrough()
  exitCode: number | null = null

  kill(): boolean {
    if (this.exitCode !== null) return false
    this.exitCode = 0
    setImmediate(() => { this.emit('close', 0) })
    return true
  }
}

async function fixture(): Promise<{ executable: string; config: FrpConfigStore }> {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-mobile-frp-identity-'))
  temporaryDirectories.push(directory)
  const executable = join(directory, 'component', 'frpc.exe')
  await mkdir(dirname(executable), { recursive: true })
  await writeFile(executable, 'fake-frpc')
  const config = new FrpConfigStore(join(directory, 'config'))
  await config.initialize()
  await config.configure({
    serverAddress: 'frp.example.com',
    serverPort: 7000,
    token: '0123456789abcdef0123456789abcdef',
    publicOrigin: 'https://dsh.example.com',
  })
  return { executable, config }
}

/** Stand-in for a started gateway that carries the identity it advertises. */
function gateway(instanceId: string): MobileAccessGateway {
  return {
    address: () => ({ host: '127.0.0.1', port: 42123, origin: 'http://127.0.0.1:42123' }),
    config: { instanceId },
    close: vi.fn(async () => undefined),
  } as unknown as MobileAccessGateway
}

/** The self-signed entry only exists with `entryTls: 'self-signed'`. */
async function configureSelfSignedIngress(config: FrpConfigStore): Promise<void> {
  await config.configure({
    serverAddress: 'frp.example.com',
    serverPort: 7000,
    token: '0123456789abcdef0123456789abcdef',
    publicOrigin: 'https://1.2.3.4',
    mode: 'attach',
    entryTls: 'self-signed',
    publicPort: 33_080,
  })
}

function controllerOptions(
  executable: string,
  config: FrpConfigStore,
  overrides: Partial<FrpControllerOptions> & Pick<FrpControllerOptions, 'createGateway'>,
): FrpControllerOptions {
  return {
    store: new MemoryControlStore(),
    executable,
    config,
    instanceId: LAN_INSTANCE_ID,
    probeVhostExposure: async () => false,
    verifyConfig: async () => undefined,
    launchClient: () => new FakeChild() as unknown as ChildProcessWithoutNullStreams,
    startTimeoutMs: 500,
    retryIntervalMs: 1,
    ...overrides,
  }
}

describe('FRP self-check identity', () => {
  it('probes the identity advertised by its own gateway, not the plugin identity', async () => {
    const { executable, config } = await fixture()
    await configureSelfSignedIngress(config)
    const activeGateway = gateway(INGRESS_INSTANCE_ID)
    const createGateway = vi.fn(async () => activeGateway)
    // Mirrors `defaultProbeDiscovery`: the endpoint advertises the ingress CA
    // fingerprint, so any other expected id is an immediate mismatch.
    const probeDiscovery = vi.fn(async (_target: FrpDiscoveryProbeTarget, expectedInstanceId: string) => {
      if (expectedInstanceId !== INGRESS_INSTANCE_ID) throw new Error('frp_discovery_mismatch')
      return true
    })
    const controller = new FrpController(controllerOptions(executable, config, {
      createGateway,
      probeDiscovery,
    }))

    await controller.initialize()
    await controller.setEnabled(true)

    // The self-signed entry is dialled on its public TCP port, never on 443.
    expect(probeDiscovery).toHaveBeenCalledWith(
      { origin: 'https://1.2.3.4:33080' },
      INGRESS_INSTANCE_ID,
      expect.any(AbortSignal),
    )
    await vi.waitFor(() => {
      expect(controller.status()).toEqual({ enabled: true, state: 'ready', origin: 'https://1.2.3.4:33080' })
    })
    expect(createGateway).toHaveBeenCalledWith('https://1.2.3.4', expect.objectContaining({ entryTls: 'self-signed' }))
    await controller.close()
  })

  it('checks the self-signed leaf while ready without replacing the paired gateway', async () => {
    const { executable, config } = await fixture()
    await configureSelfSignedIngress(config)
    const activeGateway = gateway(INGRESS_INSTANCE_ID)
    const maintainIngressCertificate = vi.fn(async () => undefined)
    const controller = new FrpController(controllerOptions(executable, config, {
      createGateway: async () => activeGateway,
      probeDiscovery: async () => true,
      maintainIngressCertificate,
      ingressCertificateCheckMs: 20,
    }))
    try {
      await controller.initialize()
      await controller.setEnabled(true)
      await vi.waitFor(() => { expect(maintainIngressCertificate).toHaveBeenCalled() })
      expect(maintainIngressCertificate).toHaveBeenCalledWith(
        expect.objectContaining({ entryTls: 'self-signed' }), activeGateway,
      )
      expect(controller.status()).toMatchObject({ state: 'ready', origin: 'https://1.2.3.4:33080' })
      expect(activeGateway.close).not.toHaveBeenCalled()
    } finally {
      await controller.close()
    }
  })

  it('stops the tunnel with a stable error when the ingress CA expires in a running process', async () => {
    const { executable, config } = await fixture()
    await configureSelfSignedIngress(config)
    const activeGateway = gateway(INGRESS_INSTANCE_ID)
    const controller = new FrpController(controllerOptions(executable, config, {
      createGateway: async () => activeGateway,
      probeDiscovery: async () => true,
      maintainIngressCertificate: async () => { throw new Error('frp_ingress_ca_expired') },
      ingressCertificateCheckMs: 20,
    }))
    try {
      await controller.initialize()
      await controller.setEnabled(true)
      await vi.waitFor(() => {
        expect(controller.status()).toEqual({ enabled: true, state: 'error', errorCode: 'frp_ingress_ca_expired' })
      })
      expect(activeGateway.close).toHaveBeenCalledOnce()
    } finally {
      await controller.close()
    }
  })

  it('times out with frp_start_timeout when the probe never succeeds', async () => {
    const { executable, config } = await fixture()
    await configureSelfSignedIngress(config)
    const activeGateway = gateway(INGRESS_INSTANCE_ID)
    const probeDiscovery = vi.fn(async () => false)
    const controller = new FrpController(controllerOptions(executable, config, {
      createGateway: async () => activeGateway,
      probeDiscovery,
      startTimeoutMs: 60,
      retryIntervalMs: 1,
    }))

    await controller.initialize()
    await controller.setEnabled(true)

    await vi.waitFor(() => {
      expect(controller.status()).toEqual({
        enabled: true,
        state: 'error',
        errorCode: 'frp_start_timeout',
      })
    })
    expect(activeGateway.close).toHaveBeenCalled()
    await controller.close()
  })

  it('still fails immediately when the public entry advertises an unknown identity', async () => {
    const { executable, config } = await fixture()
    await configureSelfSignedIngress(config)
    const probeDiscovery = vi.fn(async (_target: FrpDiscoveryProbeTarget, expectedInstanceId: string) => {
      // A replaced/renewed ingress certificate would advertise a third identity.
      if (expectedInstanceId === INGRESS_INSTANCE_ID) throw new Error('frp_discovery_mismatch')
      return true
    })
    const controller = new FrpController(controllerOptions(executable, config, {
      createGateway: async () => gateway(INGRESS_INSTANCE_ID),
      probeDiscovery,
    }))

    await controller.initialize()
    await controller.setEnabled(true)

    await vi.waitFor(() => {
      expect(controller.status()).toEqual({
        enabled: true,
        state: 'error',
        errorCode: 'frp_discovery_mismatch',
      })
    })
    await controller.close()
  })

  it('keeps the public-CA path comparing against the plugin identity', async () => {
    const { executable, config } = await fixture()
    const activeGateway = gateway(LAN_INSTANCE_ID)
    const probeVhostExposure = vi.fn(async () => false)
    const probeDiscovery = vi.fn(async (_target: FrpDiscoveryProbeTarget, expectedInstanceId: string) => {
      if (expectedInstanceId !== LAN_INSTANCE_ID) throw new Error('frp_discovery_mismatch')
      return true
    })
    const controller = new FrpController(controllerOptions(executable, config, {
      createGateway: async () => activeGateway,
      probeVhostExposure,
      probeDiscovery,
    }))

    await controller.initialize()
    await controller.setEnabled(true)

    expect(probeVhostExposure).toHaveBeenCalledWith('frp.example.com', 7080)
    expect(probeDiscovery).toHaveBeenCalledWith(
      { origin: 'https://dsh.example.com' },
      LAN_INSTANCE_ID,
      expect.any(AbortSignal),
    )
    await vi.waitFor(() => { expect(controller.status().state).toBe('ready') })
    await controller.close()
  })
})
