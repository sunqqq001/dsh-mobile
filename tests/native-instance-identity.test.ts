import { createHash, X509Certificate } from 'node:crypto'
import { request as requestHttps } from 'node:https'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { parseGatewayConfig, type ResolvedGatewayConfig } from '../src/config.js'
import { MobileAccessGateway } from '../src/gateway.js'
import { withInstallationIdentity } from '../src/gateway-identity.js'
import { loadOrCreateInstallationId } from '../src/installation-id.js'
import { JsonDeviceStore } from '../src/storage.js'
import { createTestTlsChain } from './tls-fixtures.js'

const roots: string[] = []
const gateways: MobileAccessGateway[] = []
const legacyId = 'c'.repeat(64)
const oldToken = 'L'.repeat(43)
const oldDevice = 'd'.repeat(32)
afterEach(async () => {
  for (const gateway of gateways.splice(0).reverse()) await gateway.close()
  for (const root of roots.splice(0)) {
    const target = resolve(root)
    if (dirname(target) !== resolve(tmpdir()) || !basename(target).startsWith('dsh-mobile-native-identity-')) {
      throw new Error('unsafe native identity fixture cleanup target')
    }
    await rm(target, { recursive: true, force: true })
  }
})

async function installation(legacy = false): Promise<{ root: string; config: ResolvedGatewayConfig }> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-mobile-native-identity-'))
  roots.push(root)
  const stateFile = join(root, 'devices.json')
  if (legacy) {
    const now = Date.now()
    await writeFile(stateFile, JSON.stringify({ version: 1, devices: [{ id: oldDevice, label: 'Existing phone',
      tokenDigest: createHash('sha256').update(oldToken).digest('hex'), createdAt: now - 1000,
      lastSeenAt: now - 1000, expiresAt: now + 3_600_000 }] }))
  }
  const template = { ...parseGatewayConfig({ stateFile, listenHost: '127.0.0.1', listenPort: 0,
    tls: { mode: 'disabled' }, discovery: false }), instanceId: legacyId, publicTls: true }
  const config = withInstallationIdentity(template, await loadOrCreateInstallationId(join(root, 'installation-id')), false)
  return { root, config }
}

async function start(config: ResolvedGatewayConfig): Promise<MobileAccessGateway> {
  const gateway = new MobileAccessGateway(config, new JsonDeviceStore(config.stateFile))
  gateways.push(gateway)
  await gateway.start()
  return gateway
}

async function request(gateway: MobileAccessGateway, path: string, data?: Record<string, string>): Promise<{ status: number; body: Record<string, unknown> }> {
  const origin = new URL(gateway.address().origin)
  const response = await fetch(`http://127.0.0.1:${gateway.address().port}${path}`, {
    method: data === undefined ? 'GET' : 'POST',
    headers: { host: origin.host, origin: origin.origin, 'content-type': 'application/json' },
    ...(data === undefined ? {} : { body: JSON.stringify(data) }),
    signal: AbortSignal.timeout(5000),
  })
  const body: unknown = await response.json()
  if (typeof body !== 'object' || body === null || Array.isArray(body)) throw new Error('Expected an object response')
  return { status: response.status, body: body as Record<string, unknown> }
}

function stringField(body: Record<string, unknown>, field: string): string {
  const value = body[field]
  if (typeof value !== 'string') throw new Error(`Expected string field ${field}`)
  return value
}

async function pair(gateway: MobileAccessGateway): Promise<Record<string, unknown>> {
  const opened = await gateway.access.openPairing()
  const response = await request(gateway, '/mobile-access/auth/native-pair', { token: opened.token, label: 'Owned test phone' })
  expect(response.status).toBe(201)
  expect(Object.keys(response.body).sort()).toEqual(['csrfToken', 'deviceExpiresAt', 'deviceId', 'deviceToken', 'instanceId', 'sessionExpiresAt', 'sessionToken'])
  expect(response.body.instanceId).toBe(gateway.config.instanceId)
  return response.body
}

async function checkCredential(gateway: MobileAccessGateway, token: string, expectedId: string): Promise<void> {
  const probe = await request(gateway, '/mobile-access/auth/native-probe', { deviceToken: token })
  expect(probe.status).toBe(200)
  expect(Object.keys(probe.body).sort()).toEqual(['deviceExpiresAt', 'deviceId', 'instanceId'])
  expect(probe.body.instanceId).toBe(expectedId)
  const renewal = await request(gateway, '/mobile-access/auth/native-renew', { deviceToken: token })
  expect(renewal.status).toBe(200)
  expect(Object.keys(renewal.body).sort()).toEqual(['csrfToken', 'deviceId', 'instanceId', 'sessionExpiresAt', 'sessionToken'])
  expect(renewal.body.instanceId).toBe(expectedId)
}

describe('native installation identity HTTP compatibility', () => {
  it('keeps a served CA fingerprint even when the shared device was paired on a public entry', async () => {
    const installed = await installation()
    const publicGateway = await start(installed.config)
    const publicPair = await pair(publicGateway)
    const token = stringField(publicPair, 'deviceToken')
    await publicGateway.close()
    const chain = createTestTlsChain()
    const certFile = join(installed.root, 'server.pem')
    const keyFile = join(installed.root, 'server-key.pem')
    const caFile = join(installed.root, 'ca.pem')
    await writeFile(certFile, chain.leafCert + chain.intermediateCert)
    await writeFile(keyFile, chain.leafKey)
    await writeFile(caFile, chain.rootCert)
    const caId = new X509Certificate(chain.rootCert).fingerprint256.replaceAll(':', '').toLowerCase()
    const caGateway = await start({ ...installed.config, instanceId: caId, pairingCaFile: caFile,
      tls: { mode: 'provided', certFile, keyFile } })
    const pinnedRequest = async (action: string): Promise<Record<string, unknown>> => {
      const origin = new URL(caGateway.address().origin)
      const body = JSON.stringify({ deviceToken: token })
      return new Promise((resolve, reject) => {
        const outgoing = requestHttps({ hostname: '127.0.0.1', port: caGateway.address().port,
          path: `/mobile-access/auth/${action}`, method: 'POST', ca: chain.rootCert, agent: false,
          headers: { host: origin.host, origin: origin.origin, 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } }, response => {
          const chunks: Buffer[] = []
          response.on('data', chunk => { chunks.push(Buffer.from(chunk)) })
          response.once('error', reject)
          response.once('end', () => {
            try { expect(response.statusCode).toBe(200); resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>) }
            catch (error) { reject(error) }
          })
        })
        outgoing.setTimeout(5000, () => { outgoing.destroy(new Error('Pinned identity request timed out')) })
        outgoing.once('error', reject)
        outgoing.end(body)
      })
    }
    expect((await pinnedRequest('native-renew')).instanceId).toBe(caId)
    expect((await pinnedRequest('native-probe')).instanceId).toBe(caId)
    await caGateway.close()
    const reopened = await start(installed.config)
    await checkCredential(reopened, token, installed.config.instanceId)
  })

  it('advertises distinct identities for independent installs with the same legacy identity', async () => {
    const first = await start((await installation()).config)
    const second = await start((await installation()).config)
    const firstDiscovery = await request(first, '/mobile-access/discovery')
    const secondDiscovery = await request(second, '/mobile-access/discovery')
    expect(firstDiscovery.status).toBe(200)
    expect(secondDiscovery.status).toBe(200)
    expect(firstDiscovery.body.instanceId).not.toBe(secondDiscovery.body.instanceId)
    const firstPair = await pair(first)
    const secondPair = await pair(second)
    expect(firstPair.instanceId).not.toBe(secondPair.instanceId)
    await checkCredential(first, stringField(firstPair, 'deviceToken'), first.config.instanceId)
    await checkCredential(second, stringField(secondPair, 'deviceToken'), second.config.instanceId)
  })

  it('preserves legacy credentials beside new pairings through persistence and gateway restart', async () => {
    const installed = await installation(true)
    const first = await start(installed.config)
    await checkCredential(first, oldToken, legacyId)
    const fresh = await pair(first)
    const freshToken = stringField(fresh, 'deviceToken')
    await checkCredential(first, freshToken, installed.config.instanceId)
    const persisted: unknown = JSON.parse(await readFile(installed.config.stateFile, 'utf8'))
    expect(persisted).toMatchObject({ version: 2, devices: [
      { id: oldDevice }, { nativeInstanceId: installed.config.instanceId },
    ] })
    await first.close()
    const second = await start(installed.config)
    await checkCredential(second, oldToken, legacyId)
    await checkCredential(second, freshToken, installed.config.instanceId)
    await second.close()
    const changed = await start({ ...installed.config, instanceId: 'e'.repeat(64), legacyInstanceId: 'f'.repeat(64) })
    await checkCredential(changed, freshToken, installed.config.instanceId)
    await changed.access.revokeDevice(stringField(fresh, 'deviceId'))
    const revoked = await request(changed, '/mobile-access/auth/native-renew', { deviceToken: freshToken })
    expect(revoked.status).toBe(401)
    expect(revoked.body).toEqual({ error: 'authentication_failed' })
    const unknown = await request(changed, '/mobile-access/auth/native-probe', { deviceToken: 'U'.repeat(43), instanceId: legacyId })
    expect(unknown.status).toBe(401)
    expect(unknown.body).toEqual({ error: 'authentication_failed' })
  })
})
