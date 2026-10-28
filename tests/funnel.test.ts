import { describe, expect, it } from 'vitest'
import { parseFunnelEvent } from '../src/funnel.js'

describe('Funnel sidecar protocol', () => {
  it('accepts only the two official Funnel setup actions', () => {
    expect(parseFunnelEvent(JSON.stringify({
      version: 1,
      type: 'error',
      code: 'funnel_permission_required',
      url: 'https://tailscale.com/s/no-funnel',
    }))).toEqual({
      version: 1,
      type: 'error',
      code: 'funnel_permission_required',
      url: 'https://tailscale.com/s/no-funnel',
    })

    expect(() => parseFunnelEvent(JSON.stringify({
      version: 1,
      type: 'error',
      code: 'funnel_permission_required',
      url: 'https://example.com/enable',
    }))).toThrow('invalid_sidecar_protocol')

    expect(parseFunnelEvent(JSON.stringify({
      version: 1,
      type: 'error',
      code: 'funnel_https_required',
      url: 'https://login.tailscale.com/admin/feature/funnel?node=node-1',
    }))).toEqual({
      version: 1,
      type: 'error',
      code: 'funnel_https_required',
      url: 'https://login.tailscale.com/admin/feature/funnel?node=node-1',
    })
  })

  it('keeps ordinary sidecar failures free of setup links', () => {
    expect(parseFunnelEvent(JSON.stringify({
      version: 1,
      type: 'error',
      code: 'funnel_start_failed',
    }))).toEqual({ version: 1, type: 'error', code: 'funnel_start_failed' })
  })
})
