/**
 * Browser-safe IP literal classification.
 *
 * `node:net` cannot be imported from the browser Client face, so the pure
 * predicate lives here instead. Semantics are deliberately identical to
 * `net.isIP`: strict dotted-quad IPv4 (no leading zeros, no signs, no
 * whitespace), IPv6 with at most one `::`, at most four hex digits per group,
 * an optional dotted-quad tail in the final position, and an optional
 * non-empty zone id after a single `%`.
 *
 * This module is dependency-free and side-effect-free on purpose: it is the
 * single classification source shared by every face of the plugin — the Node
 * side (`config.ts`, `cloudflared-tunnel.ts`, `origin-proxy-config.ts`,
 * `vps-deploy.ts`, `gateway.ts`, `network.ts`, `frp-config.ts`) and the browser
 * Client face that cannot reach `node:net` — so both classify a given literal
 * identically. Callers rely on the strict reading above and never post-process
 * the literal afterwards, so changing the accept/reject boundary here changes
 * it everywhere, which is the intended contract.
 */

/** Strict dotted-quad IPv4: POSIX `inet_pton` rules, so `01.1.1.1` is rejected. */
function isStrictIpv4(value: string): boolean {
  const parts = value.split('.')
  if (parts.length !== 4) return false
  for (const part of parts) {
    if (!/^(?:0|[1-9][0-9]{0,2})$/u.test(part)) return false
    if (Number(part) > 255) return false
  }
  return true
}

/**
 * Count the 16-bit groups one side of an IPv6 address occupies.
 *
 * A dotted-quad tail counts as two groups and is accepted only where the caller
 * allows it — that is, only in the final label of the whole address.
 *
 * @returns the group count, or `-1` when any label is malformed.
 */
function countIpv6Groups(labels: readonly string[], allowDottedQuad: boolean): number {
  let groups = 0
  for (let index = 0; index < labels.length; index += 1) {
    const label = labels[index] as string
    if (label.includes('.')) {
      if (index !== labels.length - 1 || !allowDottedQuad || !isStrictIpv4(label)) return -1
      groups += 2
      continue
    }
    if (!/^[\da-f]{1,4}$/iu.test(label)) return -1
    groups += 1
  }
  return groups
}

/**
 * Classify an IP literal.
 *
 * @param value - candidate address; non-strings are never an IP.
 * @returns `4` for IPv4, `6` for IPv6, `0` when the value is neither.
 */
export function isIP(value: unknown): 0 | 4 | 6 {
  if (typeof value !== 'string') return 0
  if (isStrictIpv4(value)) return 4
  let text = value
  const zone = text.indexOf('%')
  if (zone !== -1) {
    const suffix = text.slice(zone + 1)
    if (suffix.length === 0 || suffix.includes('%')) return 0
    text = text.slice(0, zone)
  }
  if (text.length === 0) return 0
  const halves = text.split('::')
  if (halves.length > 2) return 0
  if (halves.length === 1) {
    return countIpv6Groups(text.split(':'), true) === 8 ? 6 : 0
  }
  const leftText = halves[0] as string
  const rightText = halves[1] as string
  const left = leftText === '' ? [] : leftText.split(':')
  const right = rightText === '' ? [] : rightText.split(':')
  // `::` must stand for at least one group, and a dotted-quad tail is valid only
  // in the final label of the final non-empty side — so `1.2.3.4::` is rejected.
  const leftGroups = countIpv6Groups(left, false)
  const rightGroups = countIpv6Groups(right, right.length > 0)
  if (leftGroups < 0 || rightGroups < 0) return 0
  return leftGroups + rightGroups >= 8 ? 0 : 6
}