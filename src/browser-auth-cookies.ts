import { AccessError } from './access.js'
import { CSRF_COOKIE, DEVICE_COOKIE, HttpError, SESSION_COOKIE } from './http-security.js'

export const HOST_SESSION_COOKIE = '__Host-dsh_ma_session'
export const HOST_CSRF_COOKIE = '__Host-dsh_ma_csrf'
/** Non-secret browser identity; the persistent device credential keeps its narrow renewal path. */
export const HOST_DEVICE_COOKIE = '__Host-dsh_ma_device_id'

const AUTH_COOKIE_NAMES = new Set([
  SESSION_COOKIE, DEVICE_COOKIE, CSRF_COOKIE,
  HOST_SESSION_COOKIE, HOST_CSRF_COOKIE, HOST_DEVICE_COOKIE,
])

/** Read only gateway authentication cookies, retaining distinct values from different scopes. */
export function browserAuthCookies(header: string | undefined): ReadonlyMap<string, readonly string[]> {
  if (header === undefined) return new Map()
  if (header.length > 8192) throw new HttpError(401, 'authentication_failed')
  const cookies = new Map<string, string[]>()
  for (const part of header.split(';')) {
    const equals = part.indexOf('=')
    if (equals <= 0) continue
    const name = part.slice(0, equals).trim()
    if (!AUTH_COOKIE_NAMES.has(name)) continue
    const values = cookies.get(name) ?? []
    cookies.set(name, values)
    const value = part.slice(equals + 1).trim()
    if (!/^[\w\-.~+/=]{1,512}$/u.test(value) || values.includes(value)) continue
    values.push(value)
  }
  return cookies
}

/** Select exactly one authenticated value; never let cookie order choose between valid identities. */
export function authenticatedCookie<T>(
  values: readonly string[],
  authenticate: (value: string) => T,
  accepts: (result: T) => boolean = () => true,
): { readonly value: string; readonly result: T } {
  let selected: { readonly value: string; readonly result: T } | undefined
  for (const value of values) {
    let result: T
    try {
      result = authenticate(value)
    } catch (error) {
      if (error instanceof AccessError && error.status === 401) continue
      throw error
    }
    if (!accepts(result)) continue
    if (selected !== undefined) throw new HttpError(401, 'authentication_failed')
    selected = { value, result }
  }
  if (selected === undefined) throw new HttpError(401, 'authentication_failed')
  return selected
}
