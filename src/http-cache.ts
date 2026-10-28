/** Entity-tag handling for authenticated GET and HEAD cache validation. */

const ENTITY_TAG = /^[\t ]*(?:W\/)?("[\x21\x23-\x7e\x80-\xff]*")[\t ]*$/u
const ENTITY_TAG_LIST_ITEM = /(?:W\/)?"[\x21\x23-\x7e\x80-\xff]*"/gu

/**
 * Compare a GET or HEAD If-None-Match field with an existing representation.
 * Invalid fields do not match; empty list elements are ignored per HTTP list syntax.
 * @param field - The received conditional request field.
 * @param etag - The selected representation's valid entity tag.
 * @returns Whether the representation is unchanged under weak comparison.
 */
export function matchesIfNoneMatch(field: string | undefined, etag: string): boolean {
  if (field === undefined) return false
  const current = ENTITY_TAG.exec(etag)?.[1]
  if (current === undefined) return false
  if (/^[\t ]*\*[\t ]*$/u.test(field)) return true
  let cursor = 0
  let count = 0
  let matches = false
  for (const item of field.matchAll(ENTITY_TAG_LIST_ITEM)) {
    const gap = field.slice(cursor, item.index)
    if (!(count === 0 ? /^[\t ,]*$/u : /^[\t ]*,[\t ,]*$/u).test(gap)) return false
    const opaque = item[0].startsWith('W/') ? item[0].slice(2) : item[0]
    if (opaque === current) matches = true
    cursor = item.index + item[0].length
    count++
  }
  return count > 0 && /^[\t ,]*$/u.test(field.slice(cursor)) && matches
}

/**
 * Keep an upstream validator usable after lossless content encoding changes.
 * @param etag - An upstream entity tag, if supplied.
 * @returns A weak quoted entity tag, or undefined for an absent or invalid tag.
 */
export function weakenEntityTag(etag: string | undefined): string | undefined {
  const opaque = etag === undefined ? undefined : ENTITY_TAG.exec(etag)?.[1]
  return opaque === undefined ? undefined : `W/${opaque}`
}
