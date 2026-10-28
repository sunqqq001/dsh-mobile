import { describe, expect, it } from 'vitest'
import { resolveFrpEntryProbe, type FrpSettings } from '../src/frp-config.js'

const settings: FrpSettings = {
  version: 1, serverAddress: 'frps.example.com', serverPort: 7000,
  token: 'test-token-not-used-in-probe', publicOrigin: 'https://dsh.example.com',
}

describe('FRP public entry probe', () => {
  it('uses the public HTTPS hostname and default port, not the TCP passthrough default', () => {
    expect(resolveFrpEntryProbe({ ...settings, publicPort: 33080 })).toEqual({ host: 'dsh.example.com', port: 443 })
  })
  it('ignores a saved passthrough port when the public certificate entry uses HTTPS', () => {
    expect(resolveFrpEntryProbe({ ...settings, publicOrigin: 'https://8.8.8.8:443', entryTls: 'public-ip-cert', publicPort: 33443 }))
      .toEqual({ host: '8.8.8.8', port: 443 })
  })
  it('uses the effective self-signed passthrough port with the entry hostname', () => {
    expect(resolveFrpEntryProbe({ ...settings, publicOrigin: 'https://8.8.8.8', entryTls: 'self-signed' }))
      .toEqual({ host: '8.8.8.8', port: 33080 })
    expect(resolveFrpEntryProbe({ ...settings, publicOrigin: 'https://8.8.8.8', entryTls: 'self-signed', publicPort: 33443 }))
      .toEqual({ host: '8.8.8.8', port: 33443 })
  })
})
