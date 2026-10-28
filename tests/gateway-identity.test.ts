import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { parseGatewayConfig } from '../src/config.js'
import { withInstallationIdentity } from '../src/gateway-identity.js'
import { loadOrCreateInstallationId } from '../src/installation-id.js'

const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) {
    const target = resolve(root)
    if (dirname(target) !== resolve(tmpdir()) || !basename(target).startsWith('dsh-mobile-identity-policy-')) {
      throw new Error('unsafe identity fixture cleanup target')
    }
    await rm(target, { recursive: true, force: true })
  }
})

async function marker(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-mobile-identity-policy-'))
  roots.push(root)
  return join(root, 'installation-id')
}

const template = () => parseGatewayConfig({
  stateFile: join(tmpdir(), 'same-layout-on-separate-hosts', 'mobile-access', 'devices.json'),
  listenHost: '127.0.0.1', listenPort: 0, tls: { mode: 'disabled' },
})

describe('gateway installation identity', () => {
  it('separates public identities even when separate installations have the same legacy path identity', async () => {
    const firstMarker = await marker()
    const secondMarker = await marker()
    const firstTemplate = template()
    const secondTemplate = template()
    expect(firstTemplate.instanceId).toBe(secondTemplate.instanceId)
    const firstId = await loadOrCreateInstallationId(firstMarker)
    const secondId = await loadOrCreateInstallationId(secondMarker)
    const first = withInstallationIdentity(firstTemplate, firstId, false)
    const second = withInstallationIdentity(secondTemplate, secondId, false)
    expect(first.instanceId).not.toBe(second.instanceId)
    expect(first.legacyInstanceId).toBe(firstTemplate.instanceId)
    expect(second.legacyInstanceId).toBe(firstTemplate.instanceId)
    expect(withInstallationIdentity(template(), await loadOrCreateInstallationId(firstMarker), false).instanceId).toBe(first.instanceId)
  })

  it('keeps one confirmed identity under concurrent loads of the same installation', async () => {
    const file = await marker()
    const ids = await Promise.all(Array.from({ length: 8 }, () => loadOrCreateInstallationId(file)))
    expect(new Set(ids).size).toBe(1)
    expect(await readFile(file, 'utf8')).toBe(`${ids[0]}\n`)
  })

  it('retains certificate pins and explicit operator identities', () => {
    const base = template()
    const certificateBound = { ...base, pairingCaFile: join(tmpdir(), 'fixture-ca.pem'), instanceId: 'c'.repeat(64) }
    expect(withInstallationIdentity(certificateBound, 'a'.repeat(64), false)).toBe(certificateBound)
    expect(withInstallationIdentity(base, 'a'.repeat(64), true)).toBe(base)
  })
})
