/** Exercise the built Windows cpolar installer without running MSI actions or cpolar. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

assert.equal(process.platform, 'win32', 'This smoke requires native Windows tools')
const args = process.argv.slice(2)
assert(args.length === 0 || args.length === 2 && args[0] === '--archive', 'Usage: smoke-cpolar-component.mjs [--archive <pinned-official-zip>]')
const repository = process.env.DSH_BOOT_SMOKE_MOBILE_ROOT === undefined
  ? fileURLToPath(new URL('..', import.meta.url)) : resolve(process.env.DSH_BOOT_SMOKE_MOBILE_ROOT)
const { CpolarComponentManager, CPOLAR_COMPONENT_RELEASE } = await import(pathToFileURL(join(repository, 'lib/index.mjs')).href)
const source = args.length === 0 ? undefined : await readFile(resolve(args[1]))
const digest = bytes => createHash('sha256').update(bytes).digest('hex')
if (source !== undefined) {
  assert.equal(source.length, CPOLAR_COMPONENT_RELEASE.downloadBytes)
  assert.equal(digest(source), CPOLAR_COMPONENT_RELEASE.downloadSha256)
}
const root = await mkdtemp(join(tmpdir(), 'dsh-mobile-cpolar-smoke-'))
try {
  await chmod(root, 0o700)
  const stateDirectory = join(root, '中文 空格')
  await mkdir(stateDirectory)
  const sentinel = join(stateDirectory, 'unrelated.txt')
  await writeFile(sentinel, 'unchanged', { flag: 'wx' })
  const options = { stateDirectory, ...(source === undefined ? {} : { fetchArtifact: async url => {
    assert.equal(url, CPOLAR_COMPONENT_RELEASE.downloadUrl)
    return source
  } }) }
  const manager = new CpolarComponentManager(options)
  await manager.initialize()
  assert.equal(manager.status().installed, false)
  assert.equal((await manager.install()).installed, true)
  const info = await lstat(manager.executable)
  assert(info.isFile() && !info.isSymbolicLink())
  assert.equal(info.size, CPOLAR_COMPONENT_RELEASE.executableBytes)
  assert.equal(digest(await readFile(manager.executable)), CPOLAR_COMPONENT_RELEASE.executableSha256)
  assert.deepEqual(await readdir(manager.componentStorage), ['cpolar.exe'])
  assert.deepEqual(await readdir(join(stateDirectory, 'staging', 'cpolar')), [])
  const restarted = new CpolarComponentManager(options)
  await restarted.initialize()
  assert.equal(restarted.status().installed, true)
  assert.equal(restarted.status().configured, false)
  await restarted.purge()
  for (const directory of [manager.componentRoot, manager.stateRoot, manager.logRoot, join(stateDirectory, 'staging', 'cpolar')]) {
    await assert.rejects(lstat(directory), { code: 'ENOENT' })
  }
  assert.equal(await readFile(sentinel, 'utf8'), 'unchanged')
  console.log('Built Windows cpolar passed pinned ZIP/MSI/CAB extraction, executable verification, fresh initialization and owned cleanup through Unicode/space paths. No installer action or downloaded executable was run.')
} finally {
  assert.equal(dirname(root), resolve(tmpdir()))
  assert(basename(root).startsWith('dsh-mobile-cpolar-smoke-'))
  const info = await lstat(root)
  assert(info.isDirectory() && !info.isSymbolicLink())
  await rm(root, { recursive: true, force: true })
}
