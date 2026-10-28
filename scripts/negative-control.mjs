/** Completion receipts are emitted only after the expected failure and every owned cleanup settle. */
import { readFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { finishNegativeControl } from './mobile-boot-diagnostics.mjs'

const receiptPrefix = 'DSH_MOBILE_EXPECTED_FAILURE: '

/**
 * Keep acceptance and cleanup failures distinct when a nested fixture aggregates them.
 * @param failures - failure collection owned by the calling fixture.
 * @param error - failure or nested AggregateError.
 * @returns nothing.
 */
export function recordSmokeFailure(failures, error) {
  if (error instanceof AggregateError && error.errors.length > 0) {
    for (const nested of error.errors) recordSmokeFailure(failures, nested)
  } else failures.push(error instanceof Error ? error : new Error(String(error)))
}

/**
 * End a smoke fixture after cleanup and emit a receipt only for its observed negative case.
 * @param failures - acceptance and cleanup failures.
 * @param marker - negative case name, or undefined for ordinary acceptance.
 * @param observed - whether the deliberate condition was independently observed.
 * @param emit - output callback for the final completion receipt.
 * @returns nothing; throws when acceptance fails.
 */
export function completeSmoke(failures, marker, observed, emit = console.log) {
  const expected = marker === undefined ? undefined : finishNegativeControl(failures, marker, observed)
  if (expected !== undefined) {
    emit(receiptPrefix + marker)
    throw expected
  }
  if (failures.length === 1) throw failures[0]
  if (failures.length > 1) throw new AggregateError(failures, 'Smoke acceptance and cleanup failed')
  if (marker !== undefined) throw new Error('Negative control did not observe its deliberate failure')
}

/**
 * Require the exact final receipt rather than an early marker embedded in an error stack.
 * @param log - completed fixture output.
 * @param marker - expected negative case name.
 * @returns nothing; throws if the completion receipt is absent or duplicated.
 */
export function verifyNegativeControlLog(log, marker) {
  if (log.split(/\r?\n/u).filter(line => line === receiptPrefix + marker).length !== 1) {
    throw new Error('Negative control did not finish with confirmed cleanup')
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [file, marker, ...extra] = process.argv.slice(2)
  if (file === undefined || marker === undefined || extra.length !== 0) throw new Error('Expected negative-control log and marker')
  verifyNegativeControlLog(await readFile(file, 'utf8'), marker)
}
