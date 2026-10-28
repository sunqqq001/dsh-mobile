/** Browser-safe desktop-admin Host checks. Do not import Node APIs here. */

export const DESKTOP_ADMIN_HEADER = 'x-dsh-mobile-desktop-admin'
export const DESKTOP_ADMIN_MARKER = 'dsh-app://app'

/** Add the forwarded Desktop marker only to this plugin's mutating admin requests. */
export function localAdminRequestHeaders(
  init: RequestInit | undefined,
  location: Pick<Location, 'hostname' | 'protocol'>,
): Headers {
  const headers = new Headers(init?.headers)
  if (!headers.has('content-type')) headers.set('content-type', 'application/json')
  headers.delete(DESKTOP_ADMIN_HEADER)
  if (init?.method?.toUpperCase() === 'POST' && location.protocol === 'dsh-app:' && location.hostname === 'app') {
    headers.set(DESKTOP_ADMIN_HEADER, DESKTOP_ADMIN_MARKER)
  }
  return headers
}

function unwrapBrackets(hostname: string): string {
  return hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname
}

function parseIpv4(hostname: string): readonly [number, number, number, number] | undefined {
  const parts = hostname.split('.')
  if (parts.length !== 4) return undefined
  const octets: number[] = []
  for (const part of parts) {
    if (!/^(?:0|[1-9]\d{0,2})$/u.test(part)) return undefined
    const value = Number(part)
    if (value > 255) return undefined
    octets.push(value)
  }
  return octets as [number, number, number, number]
}

function isLoopbackIpv4(octets: readonly [number, number, number, number]): boolean {
  return octets[0] === 127
}

function isPrivateIpv4(octets: readonly [number, number, number, number]): boolean {
  return octets[0] === 10
    || (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31)
    || (octets[0] === 192 && octets[1] === 168)
}

function isLinkLocalIpv4(octets: readonly [number, number, number, number]): boolean {
  return octets[0] === 169 && octets[1] === 254
}

/**
 * Hostnames that may appear on the DSH desktop admin surface.
 * Loopback, RFC1918, and IPv4 link-local are accepted. Public IPs,
 * CGNAT, and arbitrary DNS names stay rejected so DNS rebinding
 * cannot reach `/api/mobile-access`.
 */
export function isLocalAdminHostname(hostname: string): boolean {
  const host = unwrapBrackets(hostname).trim().toLowerCase()
  if (host === 'localhost' || host === '::1') return true
  const octets = parseIpv4(host)
  if (octets === undefined) return false
  return isLoopbackIpv4(octets) || isPrivateIpv4(octets) || isLinkLocalIpv4(octets)
}

/**
 * Whether the current browser document should mount the desktop Mobile access
 * control. Dedicated Mobile HTTPS (the phone surface) stays native even when
 * the Host is a private LAN address. DSH Desktop (dsh-app://app) has neither,
 * so its protocol gated on the fixed hostname "app" counts too.
 */
export function isDesktopAdminSurface(
  hostname: string,
  search = '',
  frontend?: string,
  protocol = '',
): boolean {
  const query = search.startsWith('?') ? search.slice(1) : search
  return (protocol === 'dsh-app:' ? hostname === 'app' : (protocol === '' || protocol === 'http:' || protocol === 'https:') && isLocalAdminHostname(hostname))
    && frontend !== 'dedicated'
    && !new URLSearchParams(query).has('dsh-mobile-preview')
}
