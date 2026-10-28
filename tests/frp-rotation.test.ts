import { X509Certificate } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { request as httpsRequest } from 'node:https'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { TLSSocket } from 'node:tls'
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import { parseGatewayConfig } from '../src/config.js'
import { parseFrpSettings } from '../src/frp-config.js'
import { ensureFrpIngressCertificate } from '../src/frp-ingress.js'
import { MobileAccessService } from '../src/extensions.js'
import { MobileAccessGateway } from '../src/gateway.js'
import { frpIngressGatewayConfig } from '../src/plugin.js'
import { MemoryDeviceStore } from '../src/storage.js'

const settings = parseFrpSettings({
  serverAddress: '1.2.3.4', serverPort: 7000,
  token: '0123456789abcdef0123456789abcdef',
  publicOrigin: 'https://1.2.3.4', mode: 'attach', entryTls: 'self-signed',
})

function presentedLeaf(port: number): Promise<X509Certificate> {
  return new Promise((resolve, reject) => {
    const request = httpsRequest({
      host: '127.0.0.1', port, path: '/mobile-access/health',
      headers: { host: '1.2.3.4:33080' }, rejectUnauthorized: false, agent: false,
    }, response => {
      response.resume()
      response.once('end', () => {
        if (leaf === undefined) reject(new Error('missing presented leaf'))
        else resolve(leaf)
      })
    })
    let leaf: X509Certificate | undefined
    request.once('socket', socket => {
      socket.once('secureConnect', () => { leaf = (socket as TLSSocket).getPeerX509Certificate() })
    })
    request.once('error', reject)
    request.end()
  })
}

describe('FRP ingress leaf rotation', () => {
  it('reloads a new leaf signed by the same pinned CA on a running gateway', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-mobile-frp-rotation-'))
    const stateFile = join(directory, 'devices.json')
    const context = new Context()
    let gateway: MobileAccessGateway | undefined
    try {
      const first = await ensureFrpIngressCertificate(settings, stateFile)
      const template = parseGatewayConfig({
        listenHost: '127.0.0.1', listenPort: 0,
        publicAuthorities: ['127.0.0.1'], allowedCidrs: ['127.0.0.0/8'],
        stateFile, tls: { mode: 'disabled' },
      })
      gateway = new MobileAccessGateway(
        frpIngressGatewayConfig(template, settings, stateFile, first),
        new MemoryDeviceStore(), new MobileAccessService(context),
      )
      await gateway.start()
      const original = await presentedLeaf(gateway.address().port)
      expect(original.fingerprint256).toBe(first.leaf.fingerprint256)

      const second = await ensureFrpIngressCertificate(
        settings, stateFile, Date.parse(first.leaf.validTo) - 12 * 60 * 60_000, first.caFingerprint,
      )
      expect(second.caFingerprint).toBe(first.caFingerprint)
      expect(second.leaf.fingerprint256).not.toBe(first.leaf.fingerprint256)
      await gateway.refreshProvidedTls()
      const rotated = await presentedLeaf(gateway.address().port)
      expect(rotated.fingerprint256).toBe(second.leaf.fingerprint256)
      expect(rotated.verify(first.ca.publicKey)).toBe(true)
    } finally {
      try { await gateway?.close() } finally {
        try { await context.fiber.dispose() } finally {
          await rm(directory, { recursive: true, force: true })
        }
      }
    }
  })
})
