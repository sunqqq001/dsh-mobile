import { describe, expect, it } from 'vitest'
import { FRP_ATTACH_SELF_SIGNED_DECLARATION, createFrpAttachTemplateParts } from '../src/frp-attach.js'
import { parseFrpSettings } from '../src/frp-config.js'

const TOKEN = '0123456789abcdef0123456789abcdef'

const selfSigned = () => parseFrpSettings({
  serverAddress: '1.2.3.4', serverPort: 7000, token: TOKEN, publicOrigin: 'https://1.2.3.4',
  mode: 'attach', entryTls: 'self-signed',
})

const publicCert = () => parseFrpSettings({
  serverAddress: '1.2.3.4', serverPort: 7000, token: TOKEN, publicOrigin: 'https://1.2.3.4',
  mode: 'attach', vhostHttpPort: 8080,
})

/**
 * Drop the negated declaration before scanning.
 *
 * The passthrough runbook legitimately names Caddy in the sentence that says it
 * does *not* use it, so a plain case-insensitive scan would fail on wording
 * rather than on a leaked artefact — and the previous `not.toContain('caddy')`
 * check only passed because that sentence capitalises the noun.
 */
const withoutDeclaration = (text: string): string => text.split(FRP_ATTACH_SELF_SIGNED_DECLARATION).join('')

describe('attach VPS half ships no Caddy or frps-install artefact', () => {
  it('keeps the self-signed passthrough free of any Caddy artefact, case-insensitively', () => {
    const { vps } = createFrpAttachTemplateParts(selfSigned())
    expect(vps).toContain(FRP_ATTACH_SELF_SIGNED_DECLARATION)
    expect(withoutDeclaration(vps)).not.toMatch(/caddy/iu)
    expect(withoutDeclaration(vps)).not.toMatch(/certbot|vhostHTTPPort|reverse_proxy/iu)
  })

  it('still ships the Caddy snippet in the public-IP certificate entry', () => {
    const { vps } = createFrpAttachTemplateParts(publicCert())
    expect(vps).toMatch(/\/etc\/caddy\/dsh-mobile-dsh\.caddy/u)
    expect(vps).toContain('reverse_proxy 127.0.0.1:8080')
  })
})