import { spawnSync } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const helperUrl = new URL('../scripts/negative-control.mjs', import.meta.url)
const helper: {
  recordSmokeFailure: (failures: Error[], error: unknown) => void
  completeSmoke: (failures: readonly Error[], marker?: string, observed?: boolean, emit?: (text: string) => void) => void
  verifyNegativeControlLog: (log: string, marker: string) => void
} = await import(helperUrl.href)
const marker = 'Owned negative control detected'

describe('negative smoke completion', () => {
  it('requires an observed failure and confirmed cleanup instead of a marker in an aggregate stack', () => {
    const receipt: string[] = []
    const original = new Error(marker + ': old early marker')
    expect(() => helper.completeSmoke([original], marker, true, text => receipt.push(text))).toThrow(marker)
    expect(receipt).toEqual(['DSH_MOBILE_EXPECTED_FAILURE: ' + marker])
    receipt.length = 0
    for (const error of [new Error('browser close failed'), new Error('temporary profile removal failed')]) {
      const failures: Error[] = []
      helper.recordSmokeFailure(failures, new AggregateError([original, new AggregateError([error])]))
      expect(failures).toHaveLength(2)
      expect(() => helper.completeSmoke(failures, marker, true, text => receipt.push(text))).toThrow('cleanup failed')
    }
    expect(() => helper.completeSmoke([original], marker, false, text => receipt.push(text))).toThrow()
    expect(() => helper.completeSmoke([], marker, true, text => receipt.push(text))).toThrow('did not observe')
    expect(receipt).toEqual([])
    expect(() => helper.verifyNegativeControlLog(String(new AggregateError([original, new Error('cleanup failed')])), marker)).toThrow('confirmed cleanup')
  })

  it('runs the CI log validator against real CLI failures with and without cleanup errors', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-mobile-negative-receipt-'))
    try {
      for (const mode of ['expected', 'cleanup-failed', 'unobserved']) {
        const source = `import { completeSmoke, recordSmokeFailure } from ${JSON.stringify(helperUrl.href)};
const failures = [];
recordSmokeFailure(failures, ${mode === 'cleanup-failed'
          ? `new AggregateError([new Error(${JSON.stringify(marker)}), new Error('owned cleanup failed')])`
          : `new Error(${JSON.stringify(marker)})`});
completeSmoke(failures, ${JSON.stringify(marker)}, ${mode !== 'unobserved'});`
        const result = spawnSync(process.execPath, ['--input-type=module', '-e', source], { encoding: 'utf8', timeout: 10_000, windowsHide: true })
        if (result.error !== undefined) throw result.error
        expect(result.signal).toBeNull()
        expect(result.status).toBe(1)
        const log = join(root, mode + '.log')
        await writeFile(log, result.stdout + result.stderr)
        const checked = spawnSync(process.execPath, [fileURLToPath(helperUrl), log, marker], { encoding: 'utf8', timeout: 10_000, windowsHide: true })
        if (checked.error !== undefined) throw checked.error
        expect(checked.signal).toBeNull()
        expect(checked.status, mode).toBe(mode === 'expected' ? 0 : 1)
      }
    } finally { await rm(root, { recursive: true, force: true }) }
  })

  it('wires all three legacy negative lanes to completion receipts', async () => {
    const boot = await readFile(new URL('../scripts/smoke-dsh-mobile-boot.mjs', import.meta.url), 'utf8')
    const scroll = await readFile(new URL('../scripts/smoke-conversation-scroll.mjs', import.meta.url), 'utf8')
    const ci = await readFile(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8')
    expect(boot).toContain('completeSmoke(failures, marker,')
    expect(scroll).toContain('completeSmoke(failures, negativeControl ?')
    for (const log of ['compat-negative.log', 'scroll-negative.log', 'companion-negative.log']) {
      expect(ci).toContain(`node scripts/negative-control.mjs "$RUNNER_TEMP/${log}"`)
    }
  })
})
