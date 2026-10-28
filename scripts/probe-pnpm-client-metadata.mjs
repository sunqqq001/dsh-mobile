/** Controlled pnpm import → file identity → actual DSH HMR revision observation in an owned store. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, realpath, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { createMobileProfile, launchDsh, removeTemporaryRoot, CLIENT_TIMEOUT_MS } from './mobile-boot-fixture.mjs'
import { installPackedBundle, packBundle } from './packed-profile.mjs'

const prefix = 'dsh-mobile-client-metadata-'
const runtimeInput = process.env.DSH_BOOT_SMOKE_BIN
const candidateInput = process.env.DSH_BOOT_SMOKE_MOBILE_TARBALL
assert(runtimeInput?.trim(), 'Metadata probe requires DSH_BOOT_SMOKE_BIN')
assert(candidateInput?.trim(), 'Metadata probe requires DSH_BOOT_SMOKE_MOBILE_TARBALL')
const runtime = resolve(runtimeInput)
const candidate = resolve(candidateInput)
for (const file of [runtime, candidate]) assert((await stat(file)).isFile(), 'Metadata probe requires regular runtime and candidate files')
const root = await mkdtemp(join(tmpdir(), prefix))
const source = fileURLToPath(new URL('..', import.meta.url))
const methods = ['auto', 'copy']
const results = []
const failures = []

async function fileState(file) {
  const [path, exact, numeric, bytes] = await Promise.all([
    realpath(file), stat(file, { bigint: true }), stat(file), readFile(file),
  ])
  return { path, device: String(exact.dev), inode: String(exact.ino), links: Number(exact.nlink),
    size: String(exact.size), mtimeMs: numeric.mtimeMs, ctimeMs: numeric.ctimeMs,
    mtimeNs: String(exact.mtimeNs), ctimeNs: String(exact.ctimeNs),
    sha256: createHash('sha256').update(bytes).digest('hex') }
}

async function installProbe(caseRoot, home) {
  const name = 'dsh-mobile-metadata-probe'
  const directory = join(caseRoot, name)
  await mkdir(join(directory, 'lib'), { recursive: true })
  await writeFile(join(directory, 'package.json'), JSON.stringify({ name, version: '1.0.0', type: 'module',
    main: './lib/index.mjs', exports: { '.': './lib/index.mjs', './package.json': './package.json' },
    dsh: { bundle: { patch: './cordis.patch.yml' } },
  }) + '\n')
  await writeFile(join(directory, 'cordis.patch.yml'), JSON.stringify([{ insert: [{ id: 'metadata-probe', name }] }]) + '\n')
  await writeFile(join(directory, 'lib', 'index.mjs'), `
export const inject=['clientModules','webServer'];
export function apply(ctx){
  const rebuilt=[];
  ctx.effect(()=>ctx.clientModules.onRebuilt((id,rev)=>rebuilt.push({id,rev})));
  ctx.effect(()=>ctx.webServer.register({kind:'exact',path:'/api/mobile-metadata-probe',handler:(_request,response)=>{
    const entry=ctx.clientModules.graph().entries.find(entry=>entry.id==='dsh-mobile');
    response.writeHead(200,{'Content-Type':'application/json'});
    response.end(JSON.stringify({entry,baseline:ctx.clientModules.artifactBaseline('dsh-mobile'),rebuilt}));
  }}));
}
`)
  await installPackedBundle(await packBundle(directory, caseRoot), join(home, 'profiles', 'web'), { dshBin: runtime })
}

async function probe(page) {
  const response = await page.evaluate(async () => {
    const result = await fetch('/api/mobile-metadata-probe', { cache: 'no-store', signal: AbortSignal.timeout(5000) })
    const text = await result.text()
    let body
    try { body = JSON.parse(text) } catch { body = text.slice(0, 300) }
    return { status: result.status, body }
  })
  if (response.status === 404) return undefined
  assert.equal(response.status, 200, `Owned metadata endpoint failed: ${JSON.stringify(response)}`)
  return response.body
}

async function until(predicate, failure, timeout = CLIENT_TIMEOUT_MS) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    const value = await predicate()
    if (value) return value
    await new Promise(next => setTimeout(next, 50))
  }
  throw new Error(failure())
}

async function resourceStatus(page, entry) {
  return page.evaluate(async url => {
    const response = await fetch(url, { cache: 'no-store', signal: AbortSignal.timeout(5000) })
    const body = await response.arrayBuffer()
    return { status: response.status, size: body.byteLength, contentType: response.headers.get('content-type'), cache: 'no-store' }
  }, entry.url)
}

try {
  for (const packageImportMethod of methods) {
    const caseRoot = join(root, packageImportMethod)
    const first = join(caseRoot, 'first'), second = join(caseRoot, 'second')
    const packageStoreDirectory = join(caseRoot, 'private-pnpm-store')
    const home = await createMobileProfile(first, { tarball: candidate, dshBin: runtime, packageStoreDirectory, packageImportMethod })
    await installProbe(caseRoot, home)
    const fileA = join(home, 'profiles', 'web', 'node_modules', 'dsh-mobile', 'lib', 'client.js')
    let dsh, browser
    const result = { packageImportMethod }
    try {
      dsh = launchDsh(first, home, runtime)
      browser = await chromium.launch({ headless: true })
      const page = await browser.newPage()
      await page.goto(await dsh.ready(), { waitUntil: 'domcontentloaded' })
      const initial = await until(async () => {
        const state = await probe(page)
        return state?.entry === undefined ? false : state
      }, () => `Owned metadata endpoint did not become ready\n${dsh.logs()}`)
      result.before = { file: await fileState(fileA), registry: initial, resource: await resourceStatus(page, initial.entry) }
      assert.equal(result.before.resource.status, 200, 'The baseline current-revision resource was not available before the controlled second import')
      console.log(JSON.stringify({ phase: 'first-profile-baseline', ...result }))

      // This is the single controlled transition. The two profiles use a store
      // allocated inside this probe, never the user's global pnpm store.
      const secondHome = await createMobileProfile(second, { tarball: candidate, dshBin: runtime, packageStoreDirectory, packageImportMethod })
      const fileB = join(secondHome, 'profiles', 'web', 'node_modules', 'dsh-mobile', 'lib', 'client.js')
      result.afterFiles = { first: await fileState(fileA), second: await fileState(fileB) }
      result.sharedIdentity = result.afterFiles.first.device === result.afterFiles.second.device
        && result.afterFiles.first.inode === result.afterFiles.second.inode
      assert.equal(result.before.file.sha256, result.afterFiles.first.sha256, 'The first installed client bytes changed')
      assert.equal(result.afterFiles.first.sha256, result.afterFiles.second.sha256, 'The two installed candidates have different client bytes')

      if (result.sharedIdentity && result.before.file.ctimeNs !== result.afterFiles.first.ctimeNs) {
        result.afterRegistry = await until(async () => {
          const state = await probe(page)
          return state?.entry.rev !== initial.entry.rev ? state : false
        }, () => `Shared-file metadata changed without an observed DSH revision change: ${JSON.stringify(result)}\n${dsh.logs()}`)
      } else result.afterRegistry = await probe(page)
      result.oldResource = await resourceStatus(page, initial.entry)
      result.currentResource = await resourceStatus(page, result.afterRegistry.entry)
      if (packageImportMethod === 'copy') {
        assert.equal(result.sharedIdentity, false, 'The copy control still shared an installed file identity')
        assert.equal(result.before.file.ctimeNs, result.afterFiles.first.ctimeNs, 'The copy control changed the first file metadata')
        assert.equal(initial.entry.rev, result.afterRegistry.entry.rev, 'The copy control rebuilt the unchanged first client')
        assert.equal(result.oldResource.status, 200, 'The copy control invalidated the original resource URL')
      }
      assert.equal(result.currentResource.status, 200, 'The actual current resource was unavailable')
      results.push(result)
      console.log(JSON.stringify({ phase: 'second-profile-import-observed', ...result }))
    } finally {
      if (browser !== undefined) await browser.close()
      if (dsh !== undefined) {
        const stopped = await dsh.close()
        if (stopped.forced || (stopped.code !== 0 && stopped.signal !== 'SIGTERM')) throw new Error(`Metadata probe did not stop quiescently: ${JSON.stringify(stopped)}`)
        console.log(JSON.stringify({ packageImportMethod, cleanup: stopped }))
      }
    }
  }
} catch (error) { failures.push(error) } finally {
  const directory = join(source, 'local', 'mobile-boot-diagnostics')
  await mkdir(directory, { recursive: true })
  const file = join(directory, `${root.split(/[\\/]/u).at(-1)}.json`)
  await writeFile(file, JSON.stringify({ runtime, candidate, results, error: failures[0]?.message }, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
  console.log(`Metadata probe evidence ${file}`)
  await removeTemporaryRoot(root, prefix).catch(error => failures.push(error))
}
if (failures.length === 1) throw failures[0]
if (failures.length > 1) throw new AggregateError(failures, 'Metadata probe and cleanup failed')
