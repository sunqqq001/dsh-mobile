import { AUTH_PREFIX } from './http-security.js'

export const MOBILE_COMPAT_PATH = `${AUTH_PREFIX}/compat.js`

/**
 * Read one attribute out of a tag body.
 *
 * A plain `/\snonce\s*=/` search can be fooled by a value that merely contains the
 * text, and cannot tell a double-quoted attribute from a single-quoted one. Walking
 * `name=value` pairs consumes each quoted value whole, so the attribute that is
 * actually present is the one returned.
 */
function attributeValue(tag: string, name: string): string | undefined {
  const pattern = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*("[^"]*"|'[^']*')/gu
  for (const match of tag.matchAll(pattern)) {
    const attribute = match[1]
    const raw = match[2]
    if (attribute === undefined || raw === undefined) continue
    if (attribute.toLowerCase() === name) return raw.slice(1, -1)
  }
  return undefined
}

/** Character ranges covered by an HTML comment, where markup is inert text. */
function commentRanges(html: string): readonly (readonly [number, number])[] {
  return [...html.matchAll(/<!--[\s\S]*?-->/gu)].map(match => [match.index, match.index + match[0].length] as const)
}

/** Mark an authenticated Gateway document without changing its layout, transport or module selection. */
export function ensureMobileGatewayMarker(html: string): string {
  const comments = commentRanges(html)
  const first = [...html.matchAll(/<script\b[^>]*>/giu)].find(match => !comments.some(([start, end]) => match.index >= start && match.index < end))
  if (first === undefined) return html
  return `${html.slice(0, first.index)}<meta name="dsh-mobile-gateway" content="authenticated">${html.slice(first.index)}`
}

/**
 * Load the compatibility bundle synchronously, before the first DSH script.
 *
 * Returns the HTML unchanged when there is no executable script to anchor to.
 * The bundle supplies missing browser APIs before the page's scripts execute.
 */
export function ensureMobileCompatibility(html: string): string {
  const comments = commentRanges(html)
  const isInert = (at: number): boolean => comments.some(([start, end]) => at >= start && at < end)
  // Markup inside a comment never executes, so anchoring to it would inject the
  // bundle into inert text and silently skip the fix.
  const scripts = [...html.matchAll(/<script\b[^>]*>/giu)].filter(match => !isInert(match.index))
  if (scripts.length === 0) return html
  if (scripts.some(match => attributeValue(match[0], 'src') === MOBILE_COMPAT_PATH)) return html
  const first = scripts[0]
  if (first === undefined) return html
  // Keep any upstream CSP nonce; do not move execution ahead of preceding CSP meta tags.
  const nonce = attributeValue(first[0], 'nonce')?.replace(/["'<>\s]/gu, '') ?? ''
  const attribute = nonce === '' ? '' : ` nonce="${nonce}"`
  const script = `<script src="${MOBILE_COMPAT_PATH}"${attribute}></script>`
  return `${html.slice(0, first.index)}${script}${html.slice(first.index)}`
}
