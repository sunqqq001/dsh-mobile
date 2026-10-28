import { createPrivateKey, X509Certificate } from 'node:crypto'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ensureManagedCa, issueServerCertificate } from '../src/managed-setup.js'

const fault = vi.hoisted(() => ({ destination: '', enabled: false, cleanupFailure: false }))
vi.mock('node:fs/promises', async () => {
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
  return {
    ...actual,
    rename: async (source: string, destination: string): Promise<void> => {
      if (fault.enabled && destination === fault.destination) {
        fault.enabled = false
        throw Object.assign(new Error('injected key promotion failure'), { code: 'EPERM' })
      }
      await actual.rename(source, destination)
    },
    rm: async (...args: Parameters<typeof actual.rm>): Promise<void> => {
      if (fault.cleanupFailure && String(args[0]).includes('.server-key.pem.') && String(args[0]).endsWith('.tmp')) {
        fault.cleanupFailure = false
        throw new Error('injected temporary cleanup failure')
      }
      await actual.rm(...args)
    },
  }
})

const roots: string[] = []
afterEach(async () => {
  fault.enabled = false
  fault.destination = ''
  fault.cleanupFailure = false
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-mobile-cert-pair-'))
  roots.push(root)
  const files = { mode: 'managed' as const, caCertFile: join(root, 'ca.pem'), caKeyFile: join(root, 'ca-key.pem'), certFile: join(root, 'server.pem'), keyFile: join(root, 'server-key.pem') }
  const ca = await ensureManagedCa(files)
  return { root, files, ca }
}

describe('managed server certificate publication', () => {
  it('retains the original promotion error when temporary cleanup also fails', async () => {
    const { files } = await fixture()
    await issueServerCertificate(files, { commonName: 'original', ipAddresses: ['1.2.3.4'] }, files)
    const oldCert = await readFile(files.certFile)
    const oldKey = await readFile(files.keyFile)
    fault.destination = files.keyFile
    fault.enabled = true
    fault.cleanupFailure = true
    const failure = await issueServerCertificate(files, { commonName: 'replacement', ipAddresses: ['8.8.8.8'] }, files).catch(error => error)
    expect(failure).toBeInstanceOf(AggregateError)
    expect(failure.errors.map((error: Error) => error.message)).toEqual([
      'injected key promotion failure', 'injected temporary cleanup failure',
    ])
    expect(await readFile(files.certFile)).toEqual(oldCert)
    expect(await readFile(files.keyFile)).toEqual(oldKey)
  })

  it('restores the old pair if the second file cannot be promoted', async () => {
    const { root, files, ca } = await fixture()
    await issueServerCertificate(files, { commonName: 'original', ipAddresses: ['1.2.3.4'] }, files)
    const oldCert = await readFile(files.certFile)
    const oldKey = await readFile(files.keyFile)
    fault.destination = files.keyFile
    fault.enabled = true
    await expect(issueServerCertificate(files, { commonName: 'replacement', ipAddresses: ['8.8.8.8'] }, files))
      .rejects.toThrow('injected key promotion failure')
    expect(await readFile(files.certFile)).toEqual(oldCert)
    expect(await readFile(files.keyFile)).toEqual(oldKey)
    const certificate = new X509Certificate(await readFile(files.certFile))
    expect(certificate.checkPrivateKey(createPrivateKey(await readFile(files.keyFile)))).toBe(true)
    expect(certificate.verify(ca.publicKey)).toBe(true)
    expect((await readdir(root)).filter(name => name.endsWith('.tmp'))).toEqual([])
    await issueServerCertificate(files, { commonName: 'retry', ipAddresses: ['8.8.8.8'] }, files)
    expect(new X509Certificate(await readFile(files.certFile)).subjectAltName).toContain('IP Address:8.8.8.8')
  })

  it('withdraws the first file after an interrupted initial installation and allows retry', async () => {
    const { root, files, ca } = await fixture()
    fault.destination = files.keyFile
    fault.enabled = true
    await expect(issueServerCertificate(files, { commonName: 'initial', ipAddresses: ['1.2.3.4'] }, files))
      .rejects.toThrow('injected key promotion failure')
    await expect(readFile(files.certFile)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(readFile(files.keyFile)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(new X509Certificate(await readFile(files.caCertFile)).fingerprint256).toBe(ca.fingerprint256)
    expect((await readdir(root)).filter(name => name.endsWith('.tmp'))).toEqual([])
    await issueServerCertificate(files, { commonName: 'retry', ipAddresses: ['1.2.3.4'] }, files)
    const certificate = new X509Certificate(await readFile(files.certFile))
    expect(certificate.checkPrivateKey(createPrivateKey(await readFile(files.keyFile)))).toBe(true)
  })
})
