/** Exercise the packed Mobile gateway with the reported community auth package, without a model request. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises'
import { request as requestHttp } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { installPackedBundle, packBundle, packedManifest } from './packed-profile.mjs'
import { completeSmoke, recordSmokeFailure } from './negative-control.mjs'
import {
  createMobileProfile, launchDsh, openPairing, pairMobilePage, removeTemporaryRoot,
  CLIENT_TIMEOUT_MS, sanitized,
} from './mobile-boot-fixture.mjs'

const AUTH_VERSION = '0.1.12'
const AUTH_TARBALL = 'https://registry.npmjs.org/dsh-web-startup-auth/-/dsh-web-startup-auth-0.1.12.tgz'
const AUTH_INTEGRITY = 'sha512-AwI/o3xPJolfibKhMgT9WI3Hkl3DhkFhdWpJIzFgiChosrh3uDKNkqhESl5efIVww+foji5ftOEzWdahKvWCcw=='
const repository = fileURLToPath(new URL('..', import.meta.url))
const dshBin = process.env.DSH_BOOT_SMOKE_BIN
if (dshBin === undefined || !isAbsolute(dshBin)) throw new Error('Provide an absolute DSH_BOOT_SMOKE_BIN for the isolated published DSH runtime')
const runtime = JSON.parse(await readFile(join(dirname(dirname(dshBin)), 'package.json'), 'utf8'))
assert.equal(runtime.name, '@deepseek-ai/dsh')
assert.equal(runtime.version, '0.2.0-rc.2', 'This smoke targets the exact DSH version reported in issue #230')
const prefix = 'dsh-mobile-upstream-auth-'
const root = await mkdtemp(join(tmpdir(), prefix))
let dsh
let browser
let failure

/** Fetch one fixed public package and verify its registry integrity before installation. */
async function authTarball() {
  const response = await fetch(AUTH_TARBALL, { redirect: 'error', signal: AbortSignal.timeout(60_000) })
  if (!response.ok) throw new Error(`Community auth package download failed: ${response.status}`)
  const bytes = Buffer.from(await response.arrayBuffer())
  assert(bytes.length > 0 && bytes.length < 8 * 1024 * 1024, 'Unexpected community auth archive size')
  assert.equal(`sha512-${createHash('sha512').update(bytes).digest('base64')}`, AUTH_INTEGRITY)
  const destination = join(root, `dsh-web-startup-auth-${AUTH_VERSION}.tgz`)
  await writeFile(destination, bytes, { flag: 'wx', mode: 0o600 })
  const manifest = await packedManifest(destination)
  assert.equal(manifest.name, 'dsh-web-startup-auth')
  assert.equal(manifest.version, AUTH_VERSION)
  return destination
}

/** Raw Node HTTP preserves omitted Fetch Metadata; Fetch itself may add sec-fetch-mode. */
async function exchangeProbe(url, mode) {
  assert.equal(url.hostname, '127.0.0.1')
  assert.equal(url.protocol, 'http:')
  return new Promise((resolveProbe, rejectProbe) => {
    const outgoing = requestHttp(url, {
      method: 'GET', agent: false,
      headers: { accept: 'text/html', ...(mode === undefined ? {} : { 'sec-fetch-mode': mode }) },
    }, response => {
      const chunks = []
      response.on('data', chunk => { chunks.push(Buffer.from(chunk)) })
      response.once('error', rejectProbe)
      response.once('end', () => {
        resolveProbe({ status: response.statusCode, cookie: response.headers['set-cookie'] !== undefined,
          bounce: /http-equiv="refresh"/iu.test(Buffer.concat(chunks).toString('utf8')) })
      })
    })
    outgoing.setTimeout(15_000, () => { outgoing.destroy(new Error('Owned upstream exchange probe timed out')) })
    outgoing.once('error', rejectProbe)
    outgoing.end()
  })
}

try {
  const mobileTarball = process.env.DSH_BOOT_SMOKE_MOBILE_TARBALL === undefined
    ? await packBundle(repository, root) : resolve(process.env.DSH_BOOT_SMOKE_MOBILE_TARBALL)
  const mobileManifest = await packedManifest(mobileTarball)
  assert.equal(mobileManifest.name, 'dsh-mobile')
  const home = await createMobileProfile(root, { tarball: mobileTarball, dshBin })
  const profile = join(home, 'profiles', 'web')
  await installPackedBundle(await authTarball(), profile, { dshBin })
  const authDirectory = await realpath(join(profile, 'node_modules', 'dsh-web-startup-auth'))
  const authRelative = relative(await realpath(root), authDirectory)
  assert(!isAbsolute(authRelative) && authRelative !== '..' && !authRelative.startsWith(`..${sep}`),
    'Installed community auth package is outside the owned profile')
  const installedAuth = JSON.parse(await readFile(join(authDirectory, 'package.json'), 'utf8'))
  assert.equal(installedAuth.version, AUTH_VERSION)
  dsh = launchDsh(root, home, dshBin)
  const launchUrl = new URL(await dsh.ready())
  const navigation = await exchangeProbe(launchUrl)
  assert.deepEqual(navigation, { status: 200, cookie: true, bounce: true },
    'Reported community navigation-bounce control was not observed')
  const nonNavigation = await exchangeProbe(launchUrl, 'same-origin')
  assert.deepEqual(nonNavigation, { status: 303, cookie: true, bounce: false },
    'Community non-navigation cookie exchange did not return its expected 303')

  browser = await chromium.launch({ headless: true })
  let prompts = 0
  const desktop = await browser.newPage({ locale: 'en-US' })
  await desktop.route('**/api/session/prompt', async route => { prompts += 1; await route.abort('blockedbyclient') })
  await desktop.goto(launchUrl.href, { waitUntil: 'domcontentloaded' })
  // The auth package's genuine bounce document has no root. Wait for DSH itself,
  // not a rewritten or invented replacement for that navigation.
  await desktop.locator('#root').waitFor({ state: 'attached', timeout: CLIENT_TIMEOUT_MS })
  const pairUrl = await openPairing(desktop, undefined, dsh.logs)
  const phone = await browser.newPage({ viewport: { width: 390, height: 844 }, locale: 'en-US', isMobile: true, hasTouch: true })
  let indexResponses = 0
  const failedAssets = []
  const leakedCookies = []
  await phone.route('**/api/session/prompt', async route => { prompts += 1; await route.abort('blockedbyclient') })
  phone.on('response', response => {
    const pathname = new URL(response.url()).pathname
    if (pathname === '/' && response.status() === 200) indexResponses += 1
    if ((pathname.startsWith('/plugins/') || pathname.startsWith('/assets/')) && response.status() >= 400) {
      failedAssets.push({ pathname, status: response.status() })
    }
    const cookie = response.headers()['set-cookie']
    if (cookie !== undefined && /(?:^|\n|,\s*)dsh-auth-/u.test(cookie)) leakedCookies.push(pathname)
  })
  const baseline = await pairMobilePage(phone, pairUrl, dsh.logs)
  assert.equal(await phone.evaluate(() => window.__DSH_MOBILE_FRONTEND__), 'dedicated')
  assert(indexResponses > 0, 'No authenticated Mobile index response reached the browser')
  assert.equal(new URL(baseline.socket.url()).pathname, '/api/remote.mux')
  assert.equal(baseline.socket.isClosed(), false)
  assert.deepEqual(failedAssets, [], 'A boot resource failed through the authenticated gateway')
  assert.deepEqual(leakedCookies, [], 'An upstream DSH authentication cookie escaped the gateway')
  assert((await phone.context().cookies()).every(cookie => !cookie.name.startsWith('dsh-auth-')),
    'The Mobile browser stored an upstream DSH authentication cookie')
  assert.equal(prompts, 0, 'The upstream authentication smoke attempted a model prompt')
  console.log(JSON.stringify({ dsh: runtime.version, plugin: mobileManifest.version, communityAuth: AUTH_VERSION,
    integrityVerified: true, navigation, nonNavigation, mobileIndex200: indexResponses,
    mountedDedicatedPage: true, workspaceBaseline: true, webSocketPath: '/api/remote.mux', prompts }))
  console.log('Packed community upstream-auth smoke passed: real navigation 200 bounce, internal 303 exchange, authenticated mobile boot and Workspace WebSocket baseline.')
} catch (error) {
  failure = new Error(`${sanitized(error instanceof Error ? error.stack ?? error.message : String(error))}\n${dsh?.logs() ?? ''}`)
} finally {
  const failures = failure === undefined ? [] : [failure]
  if (browser !== undefined) await browser.close().catch(error => { recordSmokeFailure(failures, error) })
  if (dsh !== undefined) {
    try {
      const stopped = await dsh.close()
      if (stopped.forced || (stopped.code !== 0 && stopped.signal !== 'SIGTERM')) {
        throw new Error(`Community upstream-auth fixture did not stop normally: ${sanitized(JSON.stringify(stopped))}`)
      }
    } catch (error) { recordSmokeFailure(failures, error) }
  }
  await removeTemporaryRoot(root, prefix).catch(error => { recordSmokeFailure(failures, error) })
  completeSmoke(failures)
}
