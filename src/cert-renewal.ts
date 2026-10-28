import { X509Certificate } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { connect as connectTls } from 'node:tls'

/** Days left below which the entry certificate is reported as expiring. */
export const CERT_EXPIRING_DAYS = 2

const DAY_MS = 24 * 60 * 60_000

/** Read-only lifetime verdict for one certificate; never mutates or renews anything. */
export interface CertRenewalStatus {
  readonly state: 'ok' | 'expiring' | 'expired' | 'unknown'
  /** Unix milliseconds of `notAfter`. */
  readonly notAfter?: number
  readonly daysRemaining?: number
  readonly subject?: string
  readonly issuer?: string
  readonly errorCode?: string
}

/** Evaluate one `notAfter` timestamp against the current clock. */
export function evaluateCertificateLifetime(notAfter: number, now: number = Date.now()): CertRenewalStatus {
  if (!Number.isFinite(notAfter) || !Number.isFinite(now)) {
    return Object.freeze({ state: 'unknown' as const, errorCode: 'frp_attach_cert_unknown' })
  }
  const daysRemaining = Math.floor((notAfter - now) / DAY_MS)
  if (notAfter <= now) return Object.freeze({ state: 'expired' as const, notAfter, daysRemaining })
  if (daysRemaining <= CERT_EXPIRING_DAYS) return Object.freeze({ state: 'expiring' as const, notAfter, daysRemaining })
  return Object.freeze({ state: 'ok' as const, notAfter, daysRemaining })
}

function statusFromCertificate(certificate: X509Certificate, now: number): CertRenewalStatus {
  const notAfter = Date.parse(certificate.validTo)
  const lifetime = evaluateCertificateLifetime(notAfter, now)
  return Object.freeze({
    ...lifetime,
    subject: certificate.subject,
    issuer: certificate.issuer,
  })
}

/**
 * Read one PEM certificate from disk and report only its lifetime.
 *
 * A missing or unreadable file yields `unknown` with the stable
 * `frp_attach_cert_unknown` code so the panel can explain how to re-issue it.
 */
export async function readCertificateRenewal(file: string, now: number = Date.now()): Promise<CertRenewalStatus> {
  try {
    return statusFromCertificate(new X509Certificate(await readFile(file)), now)
  } catch {
    return Object.freeze({ state: 'unknown' as const, errorCode: 'frp_attach_cert_unknown' })
  }
}

/**
 * Ask a live TLS endpoint for its leaf certificate and report its lifetime.
 *
 * Verification is intentionally skipped: this is a read-only lifetime probe for
 * an endpoint whose trust anchor is already pinned elsewhere, and a self-signed
 * leaf is the expected answer for the passthrough entry.
 */
export async function probeOriginCertificate(
  host: string,
  port: number,
  timeoutMs = 5_000,
): Promise<CertRenewalStatus> {
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    return Object.freeze({ state: 'unknown' as const, errorCode: 'frp_attach_cert_unknown' })
  }
  return new Promise<CertRenewalStatus>((resolveProbe) => {
    let finished = false
    const socket = connectTls({ host, port, rejectUnauthorized: false, servername: undefined })
    const finish = (status: CertRenewalStatus): void => {
      if (finished) return
      finished = true
      clearTimeout(timer)
      socket.destroy()
      resolveProbe(status)
    }
    const timer = setTimeout(() => { finish(Object.freeze({ state: 'unknown' as const, errorCode: 'frp_attach_cert_unknown' })) }, timeoutMs)
    timer.unref()
    socket.once('secureConnect', () => {
      const certificate = socket.getPeerX509Certificate()
      finish(certificate === undefined
        ? Object.freeze({ state: 'unknown' as const, errorCode: 'frp_attach_cert_unknown' })
        : statusFromCertificate(certificate, Date.now()))
    })
    socket.once('error', () => { finish(Object.freeze({ state: 'unknown' as const, errorCode: 'frp_attach_cert_unknown' })) })
    socket.once('close', () => { finish(Object.freeze({ state: 'unknown' as const, errorCode: 'frp_attach_cert_unknown' })) })
  })
}