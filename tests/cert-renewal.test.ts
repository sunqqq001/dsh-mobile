import { X509Certificate } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer as createHttpsServer, type Server as HttpsServer } from 'node:https'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { generate } from 'selfsigned'
import { afterEach, describe, expect, it } from 'vitest'
import {
  CERT_EXPIRING_DAYS,
  evaluateCertificateLifetime,
  probeOriginCertificate,
  readCertificateRenewal,
} from '../src/cert-renewal.js'

const DAY = 24 * 60 * 60_000
const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

describe('entry certificate lifetime', () => {
  it('classifies ok, expiring, and expired against the two-day threshold', () => {
    const now = Date.parse('2026-01-01T00:00:00.000Z')
    expect(CERT_EXPIRING_DAYS).toBe(2)
    expect(evaluateCertificateLifetime(now + 30 * DAY, now)).toMatchObject({ state: 'ok', daysRemaining: 30 })
    expect(evaluateCertificateLifetime(now + 3 * DAY, now)).toMatchObject({ state: 'ok', daysRemaining: 3 })
    expect(evaluateCertificateLifetime(now + 2 * DAY, now)).toMatchObject({ state: 'expiring', daysRemaining: 2 })
    expect(evaluateCertificateLifetime(now + DAY / 2, now)).toMatchObject({ state: 'expiring', daysRemaining: 0 })
    expect(evaluateCertificateLifetime(now, now)).toMatchObject({ state: 'expired' })
    expect(evaluateCertificateLifetime(now - DAY, now)).toMatchObject({ state: 'expired', daysRemaining: -1 })
    expect(evaluateCertificateLifetime(Number.NaN, now)).toMatchObject({ state: 'unknown', errorCode: 'frp_attach_cert_unknown' })
  })

  it('reads a real certificate file and reports an unreadable one as unknown', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-mobile-cert-'))
    cleanups.push(async () => { await rm(directory, { recursive: true, force: true }) })
    const generated = await generate([{ name: 'commonName', value: 'dsh-mobile-test' }], {
      keyType: 'ec',
      curve: 'P-256',
      algorithm: 'sha256',
      notAfterDate: new Date(Date.now() + 100 * DAY),
      extensions: [
        { name: 'basicConstraints', cA: false, critical: true },
        { name: 'subjectAltName', altNames: [{ type: 7, ip: '1.2.3.4' }] },
      ],
    })
    const file = join(directory, 'server.pem')
    await writeFile(file, generated.cert)
    const status = await readCertificateRenewal(file)
    expect(status.state).toBe('ok')
    expect(status.notAfter).toBe(Date.parse(new X509Certificate(await readFile(file)).validTo))
    expect(status.subject).toContain('dsh-mobile-test')
    expect(await readCertificateRenewal(join(directory, 'missing.pem'))).toMatchObject({
      state: 'unknown',
      errorCode: 'frp_attach_cert_unknown',
    })
    expect(await readCertificateRenewal(file, Date.now() + 200 * DAY)).toMatchObject({ state: 'expired' })
  })

  it('probes a live TLS endpoint without trusting it', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-mobile-cert-probe-'))
    cleanups.push(async () => { await rm(directory, { recursive: true, force: true }) })
    const generated = await generate([{ name: 'commonName', value: 'dsh-mobile-probe' }], {
      keyType: 'ec',
      curve: 'P-256',
      algorithm: 'sha256',
      notAfterDate: new Date(Date.now() + DAY + DAY / 2),
      extensions: [
        { name: 'basicConstraints', cA: false, critical: true },
        { name: 'subjectAltName', altNames: [{ type: 7, ip: '127.0.0.1' }] },
      ],
    })
    const certFile = join(directory, 'server.pem')
    const keyFile = join(directory, 'server-key.pem')
    await Promise.all([writeFile(certFile, generated.cert), writeFile(keyFile, generated.private)])
    const server: HttpsServer = createHttpsServer({
      cert: await readFile(certFile),
      key: await readFile(keyFile),
    }, (_request, response) => { response.writeHead(204); response.end() })
    cleanups.push(async () => {
      await new Promise<void>(resolve => { server.close(() => { resolve() }) })
    })
    await new Promise<void>(resolve => { server.listen(0, '127.0.0.1', resolve) })
    const port = (server.address() as AddressInfo).port
    const status = await probeOriginCertificate('127.0.0.1', port)
    expect(status.state).toBe('expiring')
    expect(status.daysRemaining).toBe(1)
    // Nothing listening: the probe must report unknown instead of throwing.
    const closed = await probeOriginCertificate('127.0.0.1', 1, 300)
    expect(closed).toMatchObject({ state: 'unknown', errorCode: 'frp_attach_cert_unknown' })
  })
})