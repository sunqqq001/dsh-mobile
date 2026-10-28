import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { chmod, copyFile, lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const args = process.argv.slice(2)
assert.ok(args.length === 0 || args.length === 2 && args[0] === '--archive-dir', 'Usage: smoke-cloudflared-component.mjs [--archive-dir <official-archive-directory>]')
const archiveDirectory = args.length === 0 ? undefined : resolve(args[1])
const mobileRoot = process.env.DSH_BOOT_SMOKE_MOBILE_ROOT === undefined
  ? fileURLToPath(new URL('..', import.meta.url)) : resolve(process.env.DSH_BOOT_SMOKE_MOBILE_ROOT)
const { CLOUDFLARED_COMPONENT_RELEASES, CloudflaredComponentManager } = await import(pathToFileURL(join(mobileRoot, 'lib/index.mjs')).href)
assert.ok(CLOUDFLARED_COMPONENT_RELEASES, 'Build the current Cloudflared component before running this smoke')
const temporaryRoot = await mkdtemp(join(tmpdir(), 'dsh-mobile-cloudflared-smoke-'))
let cases = 0

async function digest(file) {
  return createHash('sha256').update(await readFile(file)).digest('hex')
}

async function verifyExecutable(manager, release) {
  const metadata = await lstat(manager.executable)
  assert.equal(metadata.isFile(), true)
  assert.equal(metadata.isSymbolicLink(), false)
  assert.equal(metadata.size, release.executableBytes)
  assert.equal(await digest(manager.executable), release.executableSha256)
  if (process.platform !== 'win32') assert.equal(metadata.mode & 0o777, 0o700)
}

async function offlineArchive(release) {
  const officialName = basename(new URL(release.downloadUrl).pathname)
  const shortName = `${release.arch === 'x64' ? 'amd64' : release.arch}.tgz`
  for (const name of [officialName, shortName]) {
    try {
      return await readFile(join(archiveDirectory, name))
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
  }
  throw new Error(`Official archive is missing: ${officialName}`)
}

try {
  await chmod(temporaryRoot, 0o700)
  for (const arch of ['x64', 'arm64']) {
    const target = `darwin-${arch}`
    const release = CLOUDFLARED_COMPONENT_RELEASES[target]
    assert.ok(release?.archive, `Missing pinned macOS archive for ${target}`)
    const stateDirectory = join(temporaryRoot, target)
    await mkdir(stateDirectory, { mode: 0o700 })
    const sentinel = join(stateDirectory, 'unrelated-state.txt')
    await writeFile(sentinel, 'keep unrelated state', { flag: 'wx', mode: 0o600 })
    const options = {
      stateDirectory, platform: 'darwin', arch,
      ...(archiveDirectory === undefined ? {} : {
        fetchArtifact: async url => {
          assert.equal(url, release.downloadUrl)
          return offlineArchive(release)
        },
      }),
    }
    const manager = new CloudflaredComponentManager(options)
    await manager.initialize()
    assert.equal(manager.status().installed, false)
    assert.equal(manager.status().supported, true)
    const installed = await manager.install()
    assert.equal(installed.installed, true)
    assert.equal(installed.errorCode, undefined)
    assert.equal(installed.downloadBytes, release.downloadBytes)
    assert.equal(installed.installedBytes, release.executableBytes)
    await verifyExecutable(manager, release)
    assert.deepEqual(await readdir(join(stateDirectory, 'staging', 'cloudflared')), [])
    assert.deepEqual(await readdir(manager.componentRoot), [release.version])
    cases++

    const fresh = new CloudflaredComponentManager(options)
    await fresh.initialize()
    assert.equal(fresh.status().installed, true)
    assert.equal(fresh.status().errorCode, undefined)
    await verifyExecutable(fresh, release)
    cases++

    const verifiedCopy = join(stateDirectory, 'verified-copy')
    await copyFile(fresh.executable, verifiedCopy)
    const tampered = await readFile(fresh.executable)
    tampered[0] ^= 1
    await writeFile(fresh.executable, tampered)
    await fresh.initialize()
    assert.equal(fresh.status().installed, false)
    assert.equal(fresh.status().errorCode, 'cloudflared_component_invalid')
    await copyFile(verifiedCopy, fresh.executable)
    await chmod(fresh.executable, 0o700)
    await fresh.initialize()
    assert.equal(fresh.status().installed, true)
    assert.equal(fresh.status().errorCode, undefined)
    await verifyExecutable(fresh, release)
    cases++

    const purged = await fresh.purge()
    assert.equal(purged.installed, false)
    assert.equal(purged.errorCode, undefined)
    for (const directory of [fresh.componentRoot, fresh.stateRoot, fresh.logRoot, join(stateDirectory, 'staging', 'cloudflared')]) {
      await assert.rejects(lstat(directory), { code: 'ENOENT' })
    }
    assert.equal(await readFile(sentinel, 'utf8'), 'keep unrelated state')
    assert.equal(await digest(verifiedCopy), release.executableSha256)
    cases++
    console.log(`cloudflared ${target}: pinned archive install, fresh initialization, tamper recovery, and purge passed.`)
  }
  console.log(`Cloudflared component smoke passed (${cases} scenarios; downloaded binaries were not executed).`)
} finally {
  assert.equal(dirname(temporaryRoot), resolve(tmpdir()))
  assert.equal(basename(temporaryRoot).startsWith('dsh-mobile-cloudflared-smoke-'), true)
  const metadata = await lstat(temporaryRoot)
  assert.equal(metadata.isDirectory() && !metadata.isSymbolicLink(), true)
  await rm(temporaryRoot, { recursive: true, force: true })
}
