import { EventEmitter } from 'node:events'
import { describe, expect, it } from 'vitest'

const helperUrl = new URL('../scripts/mobile-boot-diagnostics.mjs', import.meta.url)
const fixture: {
  buildMobileBootDiagnostics: (page: object, observations: object) => {
    page: string
    scripts: Array<{ status: number; entries: string[]; path: string; batch?: string }>
    errors: Array<{ source: string; message: string }>
    requestFailures: object[]
  }
  observeMobileBootDiagnostics: (page: object) => {
    snapshot: () => Promise<{ errors: Array<{ source: string; message: string }>; scripts: object[] }>
    dispose: () => void
  }
  summarizeMobileBootDiagnostics: (diagnostics: object) => {
    reportedModules: string[]
    scripts: Array<{ status: number; entries: string[] }>
    requestFailures: object[]
  }
  finishNegativeControl: (failures: readonly Error[], marker: string, observed: boolean) => Error | undefined
} = await import(helperUrl.href)

const id = 'owned-diagnostics-client'
const page = {
  pageUrl: 'http://127.0.0.1:45001/?token=launch-secret',
  boot: ['Failed to load plugins owned-diagnostics-client /pair#token=pair-secret&instance=fixture'],
  entries: [{ id, url: '/plugins/??owned-diagnostics-client/client.js&rev=fixture' }],
  batches: [{ url: '/mobile-access/mobile-boot/fixture/application.js', phase: 'application', entries: [id] }],
}

describe('Mobile boot diagnostics', () => {
  it.each([false, true])('marks only one original failure after observation is %s', observed => {
    const failure = new Error('Owned original fixture failure')
    const marker = 'Owned negative control detected'
    expect(fixture.finishNegativeControl([], marker, observed)).toBeUndefined()
    const classified = fixture.finishNegativeControl([failure], marker, observed)
    if (observed) expect(classified?.message).toBe(`${marker}: ${failure.message}`)
    else expect(classified).toBeUndefined()
    for (const additional of ['Owned browser cleanup failed', 'Owned evidence persistence failed']) {
      expect(fixture.finishNegativeControl([failure, new Error(additional)], marker, observed)).toBeUndefined()
    }
  })

  it('withdraws every observer so late page events cannot change another snapshot', async () => {
    class OwnedPage extends EventEmitter {
      evaluate(): Promise<typeof page> { return Promise.resolve(page) }
    }
    const owned = new OwnedPage()
    const observation = fixture.observeMobileBootDiagnostics(owned)
    owned.emit('pageerror', new Error('owned initial module failure'))
    const initial = await observation.snapshot()
    expect(initial.errors).toMatchObject([{ source: 'pageerror', message: 'owned initial module failure' }])
    observation.dispose()
    for (const name of ['pageerror', 'console', 'response', 'requestfailed']) expect(owned.listenerCount(name)).toBe(0)
    owned.emit('pageerror', new Error('late failure after disposal'))
    expect(await observation.snapshot()).toEqual(initial)
  })

  it('distinguishes a successful mapped batch response from its execution error', () => {
    const result = fixture.buildMobileBootDiagnostics(page, {
      scripts: [{ url: 'http://127.0.0.1:45001/mobile-access/mobile-boot/fixture/application.js', status: 200, contentType: 'text/javascript' }],
      requestFailures: [],
      errors: [{ source: 'pageerror', message: 'owned-diagnostics-client top-level evaluation failed',
        stack: 'Error at http://127.0.0.1:45001/mobile-access/mobile-boot/fixture/application.js:1:1' }],
    })
    expect(result.scripts).toEqual([expect.objectContaining({ status: 200, entries: [id],
      batch: '/mobile-access/mobile-boot/fixture/application.js' })])
    expect(result.errors[0]).toMatchObject({ source: 'pageerror', message: 'owned-diagnostics-client top-level evaluation failed' })
    expect(result.requestFailures).toEqual([])
    expect(JSON.stringify(result)).not.toContain('launch-secret')
    expect(JSON.stringify(result)).not.toContain('pair-secret')
  })

  it('keeps the first failed resource visible when many boot entries repeat its dependency error', () => {
    const result = fixture.buildMobileBootDiagnostics({ ...page,
      boot: [Array.from({ length: 62 }, () => 'dependency failed: could not load "owned-diagnostics-client"').join('\n')],
    }, {
      scripts: [{ url: 'http://127.0.0.1:45001/plugins/??owned-diagnostics-client/client.js&rev=fixture', status: 429 }],
      requestFailures: [{ url: 'http://127.0.0.1:45001/plugins/??owned-diagnostics-client/client.js&rev=fixture', failure: 'net::ERR_ABORTED' }],
      errors: [],
    })
    const summary = fixture.summarizeMobileBootDiagnostics(result)
    expect(summary.reportedModules).toEqual([id])
    expect(summary.scripts).toMatchObject([{ status: 429, entries: [id] }])
    expect(summary.requestFailures).toMatchObject([{ entries: [id], failure: 'net::ERR_ABORTED' }])
    expect(JSON.stringify(summary).length).toBeLessThan(2000)
  })

  it('maps the actual single-resource fallback without treating its 404 as execution failure', () => {
    const result = fixture.buildMobileBootDiagnostics(page, {
      scripts: [{ url: 'http://127.0.0.1:45001/plugins/??owned-diagnostics-client/client.js&rev=fixture', status: 404 }],
      requestFailures: [{ url: 'http://127.0.0.1:45001/plugins/missing.js?key=resource-secret', failure: 'net::ERR_FAILED' }],
      errors: [],
    })
    expect(result.scripts[0]).toMatchObject({ status: 404, entries: [id] })
    expect(result.errors).toEqual([])
    expect(JSON.stringify(result)).not.toContain('resource-secret')
  })

  it('preserves unmapped script failures and removes URL credentials and error tokens', () => {
    const result = fixture.buildMobileBootDiagnostics(page, {
      scripts: [{ url: 'http://username:password@127.0.0.1:45001/other.js?access_token=script-secret', status: 502 }],
      requestFailures: [],
      errors: [{ source: 'console', message: 'request /other.js?token=error-secret failed', url: '/other.js?deviceToken=device-secret' }],
    })
    expect(result.scripts[0]).toMatchObject({ status: 502, entries: [] })
    const output = JSON.stringify(result)
    for (const secret of ['username', 'password@', 'script-secret', 'error-secret', 'device-secret']) expect(output).not.toContain(secret)
    expect(result.page).toContain('127.0.0.1:45001')
  })

  it('removes authority credentials and encoded query keys from message, stack and boot text', () => {
    const result = fixture.buildMobileBootDiagnostics({ ...page,
      boot: ['Could not load http://boot-user:boot-password@127.0.0.1:45001/client.js?%74oken=boot-secret&rev=fixture'],
    }, {
      scripts: [], requestFailures: [], errors: [{
        source: 'pageerror',
        message: 'Failed https://message-user:message-password@127.0.0.1:45001/client.js?%61ccess_token=message-secret&rev=fixture',
        stack: 'Error\n at https://stack-user:stack-password@127.0.0.1:45001/client.js?%64eviceToken=stack-secret&rev=fixture:1:2\n request /relative.js?%70assword=relative-secret&rev=relative #token=fragment-secret',
      }],
    })
    const output = JSON.stringify(result)
    for (const secret of ['boot-user', 'boot-password', 'boot-secret', 'message-user', 'message-password',
      'message-secret', 'stack-user', 'stack-password', 'stack-secret', 'relative-secret', 'fragment-secret']) {
      expect(output).not.toContain(secret)
    }
    expect(output).toContain('rev=fixture')
    expect(output).toContain('rev=relative')
    expect(output).toContain('fixture:1:2')
    expect(result.errors[0]).toMatchObject({ source: 'pageerror' })
  })

  it('redacts credentials in invalid URL text and leaves nonsensitive query metadata intact', () => {
    const result = fixture.buildMobileBootDiagnostics(page, {
      scripts: [], requestFailures: [], errors: [{ source: 'console',
        message: 'Invalid http://invalid-user:invalid-password@[]/client.js?token=invalid-secret&rev=current /relative.js?key=plain-secret&module=fixture',
      }],
    })
    const output = JSON.stringify(result)
    for (const secret of ['invalid-user', 'invalid-password', 'invalid-secret', 'plain-secret']) expect(output).not.toContain(secret)
    expect(output).toContain('rev=current')
    expect(output).toContain('module=fixture')
  })
})
