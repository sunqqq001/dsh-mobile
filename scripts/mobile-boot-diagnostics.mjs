/** Credential-free browser boot evidence, including successful downloads whose execution failed. */
import { lstat, mkdir, realpath, writeFile } from 'node:fs/promises'
import { isAbsolute, join, relative, sep } from 'node:path'

const CREDENTIAL_PARAMETER = /^(token|key|access_token|deviceToken|password)$/iu

/** Redact credentials without truncating the diagnostic object's structure. */
function redactedText(value) {
  return String(value)
    .replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/?#"'<>]*@/giu, '$1')
    .replace(/([?&#])([^=\s&#"'<>]+)=([^\s&#"'<>]+)/gu, (match, separator, encodedName) => {
      let name
      try { name = decodeURIComponent(encodedName) } catch (_error) { return match }
      return CREDENTIAL_PARAMETER.test(name) ? `${separator}${encodedName}=<redacted>` : match
    })
}

/**
 * Retain the requested script resource and revision, not launch or pairing credentials.
 * @param input - absolute or document-relative resource URL.
 * @param base - document URL used only for relative resources.
 * @returns sanitized absolute URL and pathname/search.
 */
export function diagnosticResource(input, base) {
  const url = new URL(input, base)
  url.username = ''
  url.password = ''
  for (const name of [...url.searchParams.keys()]) {
    if (CREDENTIAL_PARAMETER.test(name)) url.searchParams.set(name, '<redacted>')
  }
  url.hash = ''
  return { url: url.href, path: `${url.pathname}${url.search}` }
}

/**
 * Join observed script responses to the actual page's entry and batch descriptors.
 * @param pageState - boot text, document URL and injected boot graph, read from the failing page.
 * @param observed - script responses, failed requests and browser errors observed before boot.
 * @returns credential-free evidence; HTTP status and execution failure stay distinct.
 */
export function buildMobileBootDiagnostics(pageState, observed) {
  const base = pageState.pageUrl
  const batches = (pageState.batches ?? []).map(batch => ({
    ...diagnosticResource(batch.url, base), phase: batch.phase, entries: [...batch.entries],
  }))
  const entries = (pageState.entries ?? []).map(entry => ({ id: entry.id, ...diagnosticResource(entry.url, base) }))
  const resources = new Map()
  for (const batch of batches) resources.set(batch.path, { entries: batch.entries, batch: batch.path, phase: batch.phase })
  for (const entry of entries) {
    if (!resources.has(entry.path)) resources.set(entry.path, { entries: [entry.id] })
  }
  return {
    page: diagnosticResource(base).url,
    boot: pageState.boot.map(redactedText),
    entries,
    batches,
    scripts: observed.scripts.map(script => {
      const resource = diagnosticResource(script.url, base)
      return { ...resource, status: script.status, contentType: script.contentType,
        ...(resources.get(resource.path) ?? { entries: [] }) }
    }),
    requestFailures: observed.requestFailures.map(request => ({
      ...diagnosticResource(request.url, base), failure: redactedText(request.failure),
    })),
    errors: observed.errors.map(error => ({
      source: error.source, message: redactedText(error.message),
      ...(error.stack === undefined ? {} : { stack: redactedText(error.stack) }),
      ...(error.url === undefined || error.url === '' ? {} : diagnosticResource(error.url, base)),
      ...(error.line === undefined ? {} : { line: error.line, column: error.column }),
    })),
  }
}

/**
 * Put resource-level failures before repetitive dependency-cascade messages.
 * @param diagnostics - complete credential-free browser evidence.
 * @returns bounded root summary; the full record remains available separately.
 */
export function summarizeMobileBootDiagnostics(diagnostics) {
  const reportedModules = [...new Set(diagnostics.boot.flatMap(text =>
    [...text.matchAll(/could not load "([^"]+)"/gu)].map(match => match[1])))]
  const requestFailures = diagnostics.requestFailures.map(request => ({ ...request,
    entries: diagnostics.scripts.find(script => script.path === request.path)?.entries
      ?? diagnostics.entries.filter(entry => entry.path === request.path).map(entry => entry.id),
  }))
  return {
    page: diagnostics.page,
    reportedModules,
    scripts: diagnostics.scripts.filter(script => script.status >= 400
      || script.entries.some(id => reportedModules.includes(id))),
    requestFailures,
    firstPageError: diagnostics.errors.find(error => error.source === 'pageerror'),
    consoleErrors: diagnostics.errors.filter(error => error.source === 'console').slice(0, 8)
      .map(error => ({ ...error, message: error.message.slice(0, 1500) })),
  }
}

/**
 * Classify an observed regression only after acceptance and every owned cleanup settle.
 * @param failures - Original acceptance failure followed by any persistence or cleanup failures.
 * @param marker - Expected negative-control marker owned by the calling fixture.
 * @param observed - Whether the intended regression was independently observed.
 * @returns A marked failure only when no other operation failed, or undefined.
 */
export function finishNegativeControl(failures, marker, observed) {
  return observed && failures.length === 1 ? new Error(`${marker}: ${failures[0].message}`) : undefined
}

/**
 * Preserve complete failure metadata in a new owner-named local JSON file before temporary cleanup.
 * @param source - repository directory owning the local evidence folder.
 * @param namespace - basename of the owned temporary root.
 * @param evidence - credential-free diagnostic record.
 * @returns absolute filename; existing files and linked output folders are refused.
 */
export async function writeMobileBootEvidence(source, namespace, evidence) {
  if (!/^dsh-mobile-recovery-smoke-[A-Za-z0-9]+$/u.test(namespace)) throw new Error('Boot evidence namespace is not an owned recovery fixture')
  const local = join(source, 'local')
  const directory = join(local, 'mobile-boot-diagnostics')
  for (const path of [local, directory]) {
    const metadata = await lstat(path).catch(error => {
      if (error.code === 'ENOENT') return undefined
      throw error
    })
    if (metadata?.isSymbolicLink() || (metadata !== undefined && !metadata.isDirectory())) {
      throw new Error('Boot evidence output folder is linked or is not a directory')
    }
  }
  await mkdir(directory, { recursive: true })
  const distance = relative(await realpath(source), await realpath(directory))
  if (isAbsolute(distance) || distance === '..' || distance.startsWith(`..${sep}`)) {
    throw new Error('Boot evidence output folder is outside the owned repository')
  }
  const file = join(directory, `${namespace}.json`)
  await writeFile(file, `${JSON.stringify(evidence, null, 2)}\n`, { flag: 'wx', mode: 0o600 })
  return file
}

/**
 * Start observation before pairing; snapshots capture data before Browser teardown.
 * @param page - the owned Playwright page.
 * @returns asynchronous snapshot reader and exact listener disposer.
 */
export function observeMobileBootDiagnostics(page) {
  const observed = { scripts: [], requestFailures: [], errors: [] }
  const response = result => {
    if (result.request().resourceType() !== 'script') return
    observed.scripts.push({ url: result.url(), status: result.status(), contentType: result.headers()['content-type'] })
  }
  const failed = request => {
    if (request.resourceType() === 'script') observed.requestFailures.push({ url: request.url(), failure: request.failure()?.errorText ?? 'unknown request failure' })
  }
  const pageError = error => { observed.errors.push({ source: 'pageerror', message: error.message, stack: error.stack }) }
  const consoleError = message => {
    if (message.type() !== 'error') return
    const location = message.location()
    observed.errors.push({ source: 'console', message: message.text(), url: location.url,
      line: location.lineNumber, column: location.columnNumber })
  }
  page.on('response', response)
  page.on('requestfailed', failed)
  page.on('pageerror', pageError)
  page.on('console', consoleError)
  return {
    snapshot: async () => {
      const pageState = await page.evaluate(() => ({
        pageUrl: location.href,
        boot: Array.from(document.querySelectorAll('[data-dsh-boot]'), node => node.textContent ?? ''),
        entries: (window.__DSH_BOOT__?.entries ?? []).map(({ id, url }) => ({ id, url })),
        batches: (window.__DSH_BOOT__?.batches ?? []).map(({ url, phase, entries }) => ({ url, phase, entries })),
      }))
      return buildMobileBootDiagnostics(pageState, observed)
    },
    dispose: () => {
      page.off('response', response)
      page.off('requestfailed', failed)
      page.off('pageerror', pageError)
      page.off('console', consoleError)
    },
  }
}
