import { describe, expect, it } from 'vitest'
import { matchesIfNoneMatch, weakenEntityTag } from '../src/http-cache.js'

describe('HTTP entity tags', () => {
  it.each([
    '"current"', 'W/"current"', ' "old", W/"current" ', '*', '\t*\t',
    ', , "old", W/"current", ,', '"current", "other"',
  ])('matches an existing representation with %s', field => {
    expect(matchesIfNoneMatch(field, '"current"')).toBe(true)
    expect(matchesIfNoneMatch(field, 'W/"current"')).toBe(true)
  })

  it.each([
    undefined, '', '"other"', 'current', 'w/"current"', '* , "current"',
    '"current", *', '"current" junk', '"current" "other"', '"current", malformed',
    '"current", W/"unfinished', '"current", "contains a space"', '"Current"',
  ])('does not match an absent, different or invalid field %s', field => {
    expect(matchesIfNoneMatch(field, '"current"')).toBe(false)
  })

  it('keeps commas and backslashes inside an opaque tag literal', () => {
    expect(matchesIfNoneMatch('"other", W/"a,b\\c"', '"a,b\\c"')).toBe(true)
    expect(matchesIfNoneMatch('W/"a,b\\c"', '"a,bc"')).toBe(false)
    expect(matchesIfNoneMatch('""', '""')).toBe(true)
    expect(matchesIfNoneMatch('*', 'not-an-entity-tag')).toBe(false)
  })

  it.each([
    ['"current"', 'W/"current"'], ['W/"current"', 'W/"current"'],
    ['\t"a,b" ', 'W/"a,b"'], ['""', 'W/""'],
    [undefined, undefined], ['current', undefined], ['w/"current"', undefined],
    ['"current", "other"', undefined], ['"bad space"', undefined],
  ])('weakens only a valid entity tag %s', (etag, expected) => {
    expect(weakenEntityTag(etag)).toBe(expected)
  })
})
