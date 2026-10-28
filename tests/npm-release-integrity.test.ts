import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'

const helper: {
  verifyPublishedPlugin: (bytes: Uint8Array, metadata: object, version: string) => string
  checkPluginPublication: (bytes: Uint8Array, version: string, request: typeof fetch) => Promise<'published' | 'unpublished'>
} = await import(new URL('../scripts/check-npm-release-integrity.mjs', import.meta.url).href)
const bytes = Buffer.from('owned plugin candidate tarball')
const integrity = `sha512-${createHash('sha512').update(bytes).digest('base64')}`
const metadata = { name: 'dsh-mobile', version: '0.6.3', dist: { integrity } }

describe('immutable npm release reconciliation', () => {
  it('accepts the occupied version only when its integrity matches the candidate bytes', async () => {
    expect(helper.verifyPublishedPlugin(bytes, metadata, '0.6.3')).toBe(integrity)
    await expect(helper.checkPluginPublication(bytes, '0.6.3', async (url, options) => {
      expect(String(url)).toBe('https://registry.npmjs.org/dsh-mobile/0.6.3')
      expect(options?.redirect).toBe('error')
      return Response.json(metadata)
    })).resolves.toBe('published')
    expect(() => helper.verifyPublishedPlugin(Buffer.from('other candidate bytes'), metadata, '0.6.3')).toThrow('publication must stop')
    for (const record of [{ ...metadata, dist: {} }, { ...metadata, name: 'other' }, { ...metadata, version: '0.6.2' }]) {
      expect(() => helper.verifyPublishedPlugin(bytes, record, '0.6.3')).toThrow('publication must stop')
    }
  })
  it('allows publication only on 404 and cancels rejected response bodies', async () => {
    for (const status of [404, 401, 403, 429, 500]) {
      let cancelled = false
      const request: typeof fetch = async () => new Response(new ReadableStream({ cancel: () => { cancelled = true } }), { status })
      const result = helper.checkPluginPublication(bytes, '0.6.3', request)
      if (status === 404) await expect(result).resolves.toBe('unpublished')
      else await expect(result).rejects.toThrow('publication must stop')
      expect(cancelled).toBe(true)
    }
    await expect(helper.checkPluginPublication(bytes, '0.6.3', async () => { throw new Error('network failed') })).rejects.toThrow('network failed')
    await expect(helper.checkPluginPublication(bytes, '0.6.3', async () => new Response('not json'))).rejects.toThrow()
  })
})
