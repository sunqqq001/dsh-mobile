import type { IncomingMessage, ServerResponse } from 'node:http'
import { describe, expect, it } from 'vitest'
import { HttpError, assertLocalAdminTrust, setSecurityHeaders } from '../src/http-security.js'
import { DESKTOP_ADMIN_HEADER, DESKTOP_ADMIN_MARKER } from '../src/local-admin-host.js'

const GATEWAY_POLICY = 'camera=(), microphone=(), geolocation=(), payment=(), usb=()'
const PROXIED_POLICY = 'camera=(), microphone=(self), geolocation=(), payment=(), usb=()'

function fakeResponse(): { readonly headers: Record<string, string>; readonly response: ServerResponse } {
  const headers: Record<string, string> = {}
  const response = {
    setHeader: (name: string, value: string) => {
      headers[name] = value
    },
  } as unknown as ServerResponse
  return { headers, response }
}

describe('setSecurityHeaders', () => {
  it('keeps the microphone on the proxied GUI document alone', () => {
    const gateway = fakeResponse()
    setSecurityHeaders(gateway.response, false)
    expect(gateway.headers['Permissions-Policy']).toBe(GATEWAY_POLICY)

    const proxied = fakeResponse()
    setSecurityHeaders(proxied.response, false, 'proxied')
    // Voice input records through getUserMedia; `microphone=()` refuses it before any prompt.
    expect(proxied.headers['Permissions-Policy']).toBe(PROXIED_POLICY)
    expect(proxied.headers['Permissions-Policy']).toContain('camera=()')
  })
})

function fakeRequest(init: {
  readonly remoteAddress?: string | undefined
  readonly host?: string
  readonly origin?: string
  readonly site?: string
  readonly desktopMarker?: string | readonly string[]
}): IncomingMessage {
  const headers: Record<string, string | readonly string[]> = {}
  if (init.host !== undefined) headers.host = init.host
  if (init.origin !== undefined) headers.origin = init.origin
  if (init.site !== undefined) headers['sec-fetch-site'] = init.site
  if (init.desktopMarker !== undefined) headers[DESKTOP_ADMIN_HEADER] = init.desktopMarker
  return {
    socket: {
      remoteAddress: Object.hasOwn(init, 'remoteAddress') ? init.remoteAddress : '127.0.0.1',
    },
    headers,
  } as IncomingMessage
}

function reject(init: Parameters<typeof fakeRequest>[0], requireOrigin = false, authenticateDesktop = () => false): void {
  expect(() => assertLocalAdminTrust(fakeRequest(init), requireOrigin, authenticateDesktop)).toThrow(HttpError)
  try {
    assertLocalAdminTrust(fakeRequest(init), requireOrigin, authenticateDesktop)
  } catch (error) {
    expect(error).toMatchObject({ status: 403, code: 'forbidden' })
  }
}

describe('assertLocalAdminTrust', () => {
  it('keeps loopback Host and TCP peer working', () => {
    expect(() => assertLocalAdminTrust(fakeRequest({ host: '127.0.0.1:8787' }), false)).not.toThrow()
    expect(() => assertLocalAdminTrust(fakeRequest({ host: 'localhost:8787' }), false)).not.toThrow()
    expect(() => assertLocalAdminTrust(fakeRequest({ host: '[::1]:8787' }), false)).not.toThrow()
  })

  it('accepts RFC1918 and IPv4 link-local Host values when the TCP peer is loopback', () => {
    expect(() => assertLocalAdminTrust(fakeRequest({
      remoteAddress: '127.0.0.1',
      host: '192.168.50.23:8080',
    }), false)).not.toThrow()
    expect(() => assertLocalAdminTrust(fakeRequest({
      remoteAddress: '::1',
      host: '10.0.0.8:8080',
      origin: 'http://10.0.0.8:8080',
      site: 'same-origin',
    }), true)).not.toThrow()
    expect(() => assertLocalAdminTrust(fakeRequest({
      remoteAddress: '::ffff:127.0.0.1',
      host: '172.16.1.9:8080',
    }), false)).not.toThrow()
    expect(() => assertLocalAdminTrust(fakeRequest({
      remoteAddress: '127.0.0.1',
      host: '169.254.12.4:8080',
    }), false)).not.toThrow()
  })

  it('still rejects DNS rebinding, public, and CGNAT Host values', () => {
    reject({ host: 'evil.example' })
    reject({ host: 'dsh.example.com:8080' })
    reject({ host: '8.8.8.8:8080' })
    reject({ host: '100.64.1.8:8080' })
    reject({ host: '203.0.113.10:8080' })
  })

  it('still requires a loopback TCP peer', () => {
    reject({ remoteAddress: '192.168.50.23', host: '192.168.50.23:8080' })
    reject({ remoteAddress: '192.168.50.23', host: 'localhost:8080' })
    reject({ remoteAddress: '10.0.0.8', host: '127.0.0.1:8080' })
    reject({ remoteAddress: '::ffff:192.168.50.23', host: '192.168.50.23:8080' })
    reject({ remoteAddress: undefined, host: '127.0.0.1:8080' })
  })

  it('rejects a mismatched or non-http Origin even on a private Host', () => {
    reject({
      host: '192.168.50.23:8080',
      origin: 'http://127.0.0.1:8080',
    })
    reject({
      host: '192.168.50.23:8080',
      origin: 'ftp://192.168.50.23:8080',
    })
    reject({
      host: '192.168.50.23:8080',
      origin: 'http://evil.example',
    })
  })

  it('allows https Origin when the Host authority matches, for TLS-terminating reverse proxies', () => {
    expect(() => assertLocalAdminTrust(fakeRequest({
      host: '192.168.50.23:8080',
      origin: 'https://192.168.50.23:8080',
    }), false)).not.toThrow()
  })

  it('requires a same-origin browser Origin on mutating requests when Sec-Fetch-Site is present', () => {
    reject({
      host: '192.168.50.23:8080',
      site: 'same-origin',
    }, true)
    reject({
      host: '192.168.50.23:8080',
      origin: 'http://192.168.50.23:8080',
      site: 'cross-site',
    }, true)
    expect(() => assertLocalAdminTrust(fakeRequest({
      host: '192.168.50.23:8080',
      origin: 'http://192.168.50.23:8080',
      site: 'same-origin',
    }), true)).not.toThrow()
  })

  it('rejects a desktop-shell Origin without the forwarded request marker', () => {
    reject({ host: '127.0.0.1:8080', origin: 'dsh-app://app' }, true)
  })

  it('accepts only marked Origin-less Desktop forwards on mutating requests', () => {
    expect(() => assertLocalAdminTrust(fakeRequest({
      host: '127.0.0.1:8080',
      desktopMarker: DESKTOP_ADMIN_MARKER,
    }), true, () => true)).not.toThrow()
    reject({ host: '127.0.0.1:8080' }, true)
    reject({ host: '127.0.0.1:8080', desktopMarker: DESKTOP_ADMIN_MARKER }, true)
    reject({ host: '127.0.0.1:8080', desktopMarker: 'dsh-app://other' }, true)
    reject({ host: '127.0.0.1:8080', desktopMarker: [DESKTOP_ADMIN_MARKER, DESKTOP_ADMIN_MARKER] }, true)
  })

  it('keeps the marker from overriding browser Origin, Fetch Metadata, TCP peer, or Host', () => {
    reject({ host: '127.0.0.1:8080', desktopMarker: DESKTOP_ADMIN_MARKER, site: 'same-origin' }, true, () => true)
    reject({ host: '127.0.0.1:8080', desktopMarker: DESKTOP_ADMIN_MARKER, site: 'cross-site' }, true, () => true)
    reject({ host: '127.0.0.1:8080', desktopMarker: DESKTOP_ADMIN_MARKER, origin: 'http://evil.example' }, true, () => true)
    reject({ host: '127.0.0.1:8080', desktopMarker: DESKTOP_ADMIN_MARKER, origin: 'dsh-app://app' }, true, () => true)
    reject({ host: 'evil.example:8080', desktopMarker: DESKTOP_ADMIN_MARKER }, true, () => true)
    reject({ remoteAddress: '192.168.50.23', host: '127.0.0.1:8080', desktopMarker: DESKTOP_ADMIN_MARKER }, true, () => true)
  })

  it('keeps an unmarked Origin-less and Fetch-Metadata-less POST forbidden', () => {
    reject({ host: '192.168.50.23:8080' }, true)
  })

  it('still rejects Origin-less mutating requests that carry Fetch Metadata', () => {
    reject({
      host: '192.168.50.23:8080',
      site: 'same-origin',
    }, true)
  })
})
