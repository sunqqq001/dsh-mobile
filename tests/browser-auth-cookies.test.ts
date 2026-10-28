import { describe, expect, it } from 'vitest'
import { AccessError } from '../src/access.js'
import { authenticatedCookie, browserAuthCookies, HOST_SESSION_COOKIE } from '../src/browser-auth-cookies.js'
import { HttpError, SESSION_COOKIE } from '../src/http-security.js'

describe('browser authentication cookie selection', () => {
  it('ignores unrelated duplicate, quoted, and percent-encoded cookies', () => {
    const cookies = browserAuthCookies(`analytics="quoted value"; analytics=older%20value; malformed; ${SESSION_COOKIE}=current`)
    expect(cookies.get(SESSION_COOKIE)).toEqual(['current'])
    expect(cookies.has('analytics')).toBe(false)
  })

  it('retains distinct values and ignores identical or malformed stale values', () => {
    const cookies = browserAuthCookies(`${SESSION_COOKIE}=stale; ${SESSION_COOKIE}=current; ${SESSION_COOKIE}=current; ${SESSION_COOKIE}=%bad`)
    expect(cookies.get(SESSION_COOKIE)).toEqual(['stale', 'current'])
    expect(browserAuthCookies(`${HOST_SESSION_COOKIE}=%bad`).has(HOST_SESSION_COOKIE)).toBe(true)
  })

  it('accepts the sole authenticated value in either cookie order', () => {
    const authenticate = (value: string): string => {
      if (value !== 'current') throw new AccessError(401, 'authentication_failed')
      return 'device-current'
    }
    expect(authenticatedCookie(['stale', 'current'], authenticate)).toEqual({ value: 'current', result: 'device-current' })
    expect(authenticatedCookie(['current', 'stale'], authenticate)).toEqual({ value: 'current', result: 'device-current' })
  })

  it('rejects multiple authenticated identities instead of trusting cookie order', () => {
    expect(() => authenticatedCookie(['first', 'second'], value => value)).toThrow(HttpError)
    expect(() => authenticatedCookie([], value => value)).toThrow(HttpError)
  })

  it('uses a device binding only after authenticating the credential', () => {
    const authenticate = (value: string): string => {
      if (value === 'forged') throw new AccessError(401, 'authentication_failed')
      return value
    }
    expect(authenticatedCookie(['old', 'current', 'forged'], authenticate, value => value === 'current')).toEqual({ value: 'current', result: 'current' })
    expect(() => authenticatedCookie(['forged'], authenticate, () => true)).toThrow(HttpError)
  })

  it('propagates operational failures and bounds the entire cookie header', () => {
    const failure = new Error('controller unavailable')
    expect(() => authenticatedCookie(['current'], () => { throw failure })).toThrow(failure)
    expect(() => browserAuthCookies('x'.repeat(8193))).toThrow(HttpError)
    expect(browserAuthCookies(undefined).size).toBe(0)
  })
})
