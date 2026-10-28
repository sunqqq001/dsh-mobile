/** Load the packed cpolar guide through DSH's real profile config replacement. */
import assert from 'node:assert/strict'
import { access, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { createMobileProfile, launchDsh, removeTemporaryRoot } from './mobile-boot-fixture.mjs'
import { packedManifest } from './packed-profile.mjs'

const requiredPath = name => {
  const value = process.env[name]
  if (value === undefined || value.trim() === '') throw new Error(`Set ${name} to the exact artifact being tested`)
  return resolve(value)
}
const dshBin = requiredPath('DSH_BOOT_SMOKE_BIN')
const tarball = requiredPath('DSH_BOOT_SMOKE_MOBILE_TARBALL')
await Promise.all([access(dshBin), access(tarball)])
const runtime = JSON.parse(await readFile(join(dirname(dirname(dshBin)), 'package.json'), 'utf8'))
assert.equal(runtime.name, '@deepseek-ai/dsh')
const candidate = await packedManifest(tarball)
assert.equal(candidate.name, 'dsh-mobile')
const prefix = 'dsh-mobile-cpolar-config-smoke-'
const root = await mkdtemp(join(tmpdir(), prefix))
let owner
let failure
let negativeObservation

/** Return the one literal config example shipped to users, not a rebuilt fixture. */
function guideConfig(markdown) {
  const examples = [...markdown.matchAll(/```yaml\r?\n([\s\S]*?)\r?\n```/gu)]
  assert.equal(examples.length, 1, 'The guide must have one complete profile override example')
  const config = examples[0][1].replace(/\r\n/gu, '\n') + '\n'
  assert.match(config, /stateFile: !!js dshHomePath\(/u)
  assert.match(config, /controlFile: !!js dshHomePath\(/u)
  assert.match(config, /initiallyEnabled: false/u)
  assert.match(config, /cpolarSubdomain: your-reserved-name/u)
  assert.match(config, /cpolarRegion: cn_vip/u)
  return config
}

/** Exchange the fixture's real launch token without logging either it or its Cookie. */
async function authenticate(baseUrl) {
  const exchange = await fetch(baseUrl, { redirect: 'manual', signal: AbortSignal.timeout(10_000) })
  assert.equal(exchange.status, 303, 'DSH must exchange the launch token through its stock index handler')
  const cookies = exchange.headers.getSetCookie()
  assert.equal(cookies.length, 1, 'DSH must issue one browser-session Cookie')
  await exchange.arrayBuffer()
  return { origin: new URL(baseUrl).origin, cookie: cookies[0].split(';', 1)[0] }
}

/** Read an actual registered plugin route on the owned DSH listener. */
async function control(session, route) {
  const response = await fetch(`${session.origin}/api/mobile-access/${route}`, {
    headers: { cookie: session.cookie }, redirect: 'manual', signal: AbortSignal.timeout(10_000),
  })
  const text = await response.text()
  return { status: response.status, contentType: response.headers.get('content-type'), text }
}

/** Require the deliberately incomplete config's loader failure, not another boot error. */
function assertMissingConfig(logs) {
  assert.match(logs, /mobile-access[\s\S]*dsh-mobile|dsh-mobile[\s\S]*mobile-access/u)
  assert.match(logs, /invalid config/u)
  assert.match(logs, /\$\.stateFile missing required value \(at stateFile\)/u)
}

/** Await owned process shutdown before rewriting its profile or deleting resources. */
async function stopDsh() {
  if (owner === undefined) return
  const active = owner
  owner = undefined
  const result = await active.close()
  assert.equal(result.forced, false, 'The owned DSH process must close before fixture cleanup')
}

try {
  const home = await createMobileProfile(root, {
    tarball, dshBin, packageStoreDirectory: join(root, 'pnpm-store'),
  })
  const profile = join(home, 'profiles', 'web')
  const installed = join(profile, 'node_modules', 'dsh-mobile')
  const zh = guideConfig(await readFile(join(installed, 'docs', 'CPOLAR_SUBDOMAIN.md'), 'utf8'))
  const en = guideConfig(await readFile(join(installed, 'docs', 'CPOLAR_SUBDOMAIN.en.md'), 'utf8'))
  assert.equal(zh, en, 'Chinese and English guides must execute the same complete config')
  const patchFile = join(profile, 'cordis.patch.yml')
  await writeFile(patchFile, zh)
  owner = launchDsh(root, home, dshBin)
  const session = await authenticate(await owner.ready())
  const lan = await control(session, 'lan/control')
  assert.equal(lan.status, 200, `Complete guide config must register Mobile: status=${lan.status}\n${owner.logs()}`)
  assert.match(lan.contentType ?? '', /application\/json/u)
  const lanState = JSON.parse(lan.text)
  assert.equal(lanState.running, false, 'The literal guide config must not start a LAN listener')
  assert.equal(lanState.origin, undefined)
  const remote = await control(session, 'remote/control')
  assert.equal(remote.status, 200, `Complete guide config must initialize remote controllers\n${owner.logs()}`)
  const remoteState = JSON.parse(remote.text)
  assert.equal(remoteState.running, false, 'The smoke must not connect cpolar or another provider')
  assert.equal(remoteState.origin, undefined)
  assert.ok(!owner.logs().includes('did not activate mobile-access'), 'The complete guide must activate its plugin entry')
  await stopDsh()

  // This is the original two-field example: DSH replaces config, not its keys.
  await writeFile(patchFile, '- id: mobile-access\n  name: dsh-mobile\n  config:\n    cpolarSubdomain: your-reserved-name\n    cpolarRegion: cn_vip\n')
  owner = launchDsh(root, home, dshBin)
  let negativeUrl
  try {
    negativeUrl = await owner.ready()
  } catch (error) {
    assert.match(String(error), /DSH exited before readiness/u, 'A timeout is not a missing-config observation')
    assertMissingConfig(owner.logs())
    negativeObservation = 'required config rejected before application readiness'
  }
  if (negativeUrl !== undefined) {
    const rejected = await control(await authenticate(negativeUrl), 'lan/control')
    assert.equal(rejected.status, 404, 'Rejected Mobile config must not retain its previous admin route')
    assertMissingConfig(owner.logs())
    negativeObservation = 'required config rejected; Mobile admin route absent'
  }
} catch (error) {
  failure = error
}

const failures = failure === undefined ? [] : [failure]
try { await stopDsh() } catch (error) { failures.push(error) }
try { await removeTemporaryRoot(root, prefix) } catch (error) { failures.push(error) }
if (failures.length > 0) throw new AggregateError(failures, 'Packed cpolar config smoke failed')
console.log(`Packed cpolar guide passed: Mobile ${candidate.version}, DSH ${runtime.version}; literal bilingual YAML and !!js; inactive LAN/remote; ${negativeObservation}; owned cleanup completed`)
