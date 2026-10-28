import { expect, it } from 'vitest'

it('compares bounded native-like bytes without rendering individual byte entries', () => {
  const original = Buffer.alloc(4 * 1024 * 1024, 7)
  const copy = Buffer.from(original)
  expect(copy.equals(original)).toBe(true)
  copy[copy.length - 1] = 8
  expect(copy.equals(original)).toBe(false)
})
