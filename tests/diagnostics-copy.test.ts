import { describe, expect, it } from 'vitest'
import { localizedDiagnosticEntryCopy } from '../src/client.js'
import { DIAGNOSTIC_REASON_MESSAGES, MOBILE_CONTROL_MESSAGES } from '../src/client-messages.js'

describe.each(['en', 'it', 'zh'] as const)('diagnostic copy (%s)', locale => {
  const messages = MOBILE_CONTROL_MESSAGES[locale] as Record<string, string>
  const controllerEntry = (controllerCode: unknown) => ({
    reason: 'remote-controller-error',
    facts: { provider: 'tailscale', controllerCode },
  })

  it.each(['sidecar_exited', 'some_unknown_future_code', 'constructor'])('retains the raw %s code in the detail', code => {
    const copy = localizedDiagnosticEntryCopy(controllerEntry(code), locale)
    expect(copy.detail).toBe(DIAGNOSTIC_REASON_MESSAGES[locale]['remote-controller-error'][0]
      .replace('{provider}', 'Tailscale Funnel').replace('{controllerCode}', code))
    expect(copy.action).toBe(code === 'sidecar_exited'
      ? messages.controlChannelFailed
      : DIAGNOSTIC_REASON_MESSAGES[locale]['remote-controller-error'][1])
  })

  it('keeps authorization guidance separate from the controller code', () => {
    const copy = localizedDiagnosticEntryCopy(controllerEntry('funnel_https_required'), locale)
    expect(copy.detail).toContain('funnel_https_required')
    expect(copy.detail).not.toContain(messages.funnelHttps!)
    expect(copy.detail).not.toMatch(/\.\.|。。/u)
    expect(copy.action).toBe(messages.funnelHttps)
  })

  it('retains friendly explanations for codes without a specific diagnostic action', () => {
    const copy = localizedDiagnosticEntryCopy({
      reason: 'remote-controller-error',
      facts: { provider: 'cloudflared', controllerCode: 'cloudflared_invalid_output' },
    }, locale)
    expect(copy.detail).toContain('cloudflared_invalid_output')
    expect(copy.action).toBe(messages.cloudflaredOutputInvalid)
  })

  it.each([undefined, null, {}, { controllerCode: '' }, { controllerCode: 42 }, 'invalid'])('uses a localized failure when controller facts are missing (%j)', facts => {
    const copy = localizedDiagnosticEntryCopy({ reason: 'remote-controller-error', facts }, locale)
    expect(copy.detail).toBe(messages.remoteError)
    expect(copy.action).toBe(DIAGNOSTIC_REASON_MESSAGES[locale]['remote-controller-error'][1])
  })

  it('retains Host copy for unrecognized diagnostic reasons', () => {
    for (const reason of ['new-diagnostic-reason', 'constructor']) {
      expect(localizedDiagnosticEntryCopy({ reason, detail: 'Host detail', action: 'Host action' }, locale))
        .toMatchObject({ detail: 'Host detail', action: 'Host action' })
    }
  })

  it('retains versions and proxy-specific copy for unrelated diagnostic entries', () => {
    const versions = { plugin: '1.2.3', dsh: '4.5.6', minimumAndroidApp: '7.8.9' }
    expect(localizedDiagnosticEntryCopy({ reason: 'versions-current' }, locale, versions).detail)
      .toBe(`${DIAGNOSTIC_REASON_MESSAGES[locale]['versions-current'][0]} plugin 1.2.3, DSH 4.5.6, Android 7.8.9.`)
    expect(localizedDiagnosticEntryCopy({ reason: 'versions-current' }, locale, { plugin: '1.2.3' }).detail)
      .toBe(DIAGNOSTIC_REASON_MESSAGES[locale]['versions-current'][0])
    const proxyCopy = localizedDiagnosticEntryCopy({ reason: 'remote-ready', facts: {
      provider: 'origin', viaProxy: true, latencyMs: 123, endpointSuffix: 'example.com',
    } }, locale)
    expect(proxyCopy.detail).toBe(DIAGNOSTIC_REASON_MESSAGES[locale]['remote-ready-via-proxy'][0]
      .replace('{provider}', messages.originName!).replace('{latencyMs}', '123').replace('{endpointSuffix}', 'example.com'))
    expect(proxyCopy.action).toBe(DIAGNOSTIC_REASON_MESSAGES[locale]['remote-ready-via-proxy'][1])
  })
})
