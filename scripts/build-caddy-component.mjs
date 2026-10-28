import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'
import { promisify } from 'node:util'

import { CADDY_BUILD_LOCK, caddyBuildEnvironment, verifyCaddySources, verifyCaddyBuild } from './caddy-component-build-inputs.mjs'

// This build produces private review artifacts only. Publication and production pins are separate steps.
const { core: CORE, dns: DNS, xcaddy: XCADDY, toolchain: TOOLCHAIN } = CADDY_BUILD_LOCK
const args = process.argv.slice(2)
const outputIndex = args.indexOf('--output-dir')
const requested = outputIndex === -1 ? undefined : args[outputIndex + 1]
if (args.length !== 2 || outputIndex !== 0 || requested === undefined || !isAbsolute(requested)) {
  throw new Error('Usage: node scripts/build-caddy-component.mjs --output-dir <new-absolute-directory>')
}
const output = resolve(requested)
await mkdir(output, { recursive: false, mode: 0o700 })
const work = await mkdtemp(join(output, '.build-'))
const tools = join(work, 'tools')
const temporary = join(work, 'tmp')
const cache = join(work, 'cache')
const modulesCache = join(work, 'modules')
await mkdir(tools); await mkdir(temporary); await mkdir(cache); await mkdir(modulesCache)
const binary = join(output, process.platform === 'win32' ? 'caddy.exe' : 'caddy')
const go = process.env.GO_BINARY ?? 'go'
const environment = caddyBuildEnvironment(process.env, { go, tools, temporary, cache, modules: modulesCache })
const run = promisify(execFile)
const command = async (file, argv, { cwd = work, env = environment } = {}) => (await run(file, argv, {
  cwd, env, windowsHide: true, timeout: 1_200_000, maxBuffer: 32 * 1024 * 1024,
})).stdout.trim()
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const licensePattern = /^(LICENSE|LICENCE|COPYING|NOTICE|PATENTS)(\..*)?$/i
try {
  const toolchain = await command(go, ['version'])
  if (!toolchain.startsWith('go version ' + TOOLCHAIN + ' ')) throw new Error('Go toolchain must be ' + TOOLCHAIN)
  const sources = {}
  for (const [name, pin] of Object.entries(CADDY_BUILD_LOCK.sources)) {
    sources[name] = JSON.parse(await command(go, ['mod', 'download', '-json', `${pin.path}@${pin.version}`]))
  }
  const sourceRevisions = verifyCaddySources(sources)
  await command(go, ['install', 'github.com/caddyserver/xcaddy/cmd/xcaddy@' + XCADDY])
  await command(join(tools, process.platform === 'win32' ? 'xcaddy.exe' : 'xcaddy'),
    ['build', CORE, '--with', 'github.com/caddy-dns/tencentcloud@' + DNS, '--output', binary],
    { env: { ...environment, XCADDY_SKIP_BUILD: '1' } })
  const retained = (await readdir(temporary, { withFileTypes: true }))
    .filter(entry => entry.isDirectory() && entry.name.startsWith('buildenv_'))
  if (retained.length !== 1) throw new Error('Missing unique xcaddy build environment')
  const staging = join(temporary, retained[0].name)
  // Pin the patched HTTP/2 module without new imports or module replacements.
  // Keep core and DNS versions explicit when resolving the updated dependency.
  await command(go, ['get', 'github.com/caddyserver/caddy/v2@' + CORE,
    'github.com/caddy-dns/tencentcloud@' + DNS,
    'golang.org/x/net@' + CADDY_BUILD_LOCK.dependencies['golang.org/x/net'].version], { cwd: staging })
  await command(go, ['mod', 'tidy'], { cwd: staging })
  await command(go, ['mod', 'verify'], { cwd: staging })
  await command(go, ['build', '-trimpath', '-buildvcs=false', '-o', binary], { cwd: staging })
  const build = JSON.parse(await command(go, ['version', '-m', '-json', binary]))
  // Diagnostic metadata is safe to inspect on a rejected build; never treat it as a passing manifest.
  await writeFile(join(output, 'go-build.json'), JSON.stringify(build, null, 2) + '\n')
  verifyCaddyBuild(build)
  const embedded = build.Deps
  const version = await command(binary, ['version'])
  const modules = await command(binary, ['list-modules', '--versions'])
  if (!version.startsWith(CORE + ' ') || !modules.includes('dns.providers.tencentcloud ' + DNS)
    || !modules.includes('Non-standard modules: 1')) throw new Error('Built Caddy version/modules do not match pins')
  const licenses = ['DSH Mobile optional managed Caddy - embedded dependency licenses', '', `Go: ${TOOLCHAIN}`, '']
  const dependencies = []
  for (const entry of embedded.sort((a, b) => a.Path.localeCompare(b.Path, 'en'))) {
    if (entry.Replace !== undefined || typeof entry.Path !== 'string' || typeof entry.Version !== 'string'
      || typeof entry.Sum !== 'string') throw new Error('Unpinned Go dependency in binary metadata')
    const metadata = JSON.parse(await command(go, ['mod', 'download', '-json', `${entry.Path}@${entry.Version}`]))
    if (metadata.Sum !== entry.Sum || typeof metadata.Dir !== 'string') throw new Error('Go module checksum changed')
    const files = (await readdir(metadata.Dir, { withFileTypes: true })).filter(item => item.isFile() && licensePattern.test(item.name))
    if (files.length === 0) throw new Error(`No top-level license in ${entry.Path}@${entry.Version}`)
    dependencies.push({ path: entry.Path, version: entry.Version, sum: entry.Sum, licenses: files.map(item => item.name) })
    for (const file of files) {
      const bytes = await readFile(join(metadata.Dir, file.name))
      if (bytes.length === 0 || bytes.length > 1024 * 1024 || bytes.includes(0)) throw new Error('Invalid dependency license file')
      licenses.push(`${entry.Path}@${entry.Version} / ${file.name}`, `SHA-256: ${sha(bytes)}`, '', bytes.toString('utf8').trimEnd(), '')
    }
  }
  const goroot = await command(go, ['env', 'GOROOT'])
  for (const name of ['LICENSE', 'PATENTS']) licenses.push(`Go ${TOOLCHAIN} / ${name}`, '', (await readFile(join(goroot, name), 'utf8')).trimEnd(), '')
  const bytes = await readFile(binary)
  const manifest = { version: CORE.slice(1), dnsPluginVersion: DNS, xcaddyVersion: XCADDY, goVersion: TOOLCHAIN,
    platform: process.platform, arch: process.arch, executableName: binary.split(/[\\/]/u).at(-1),
    downloadBytes: bytes.length, executableBytes: bytes.length, downloadSha256: sha(bytes), executableSha256: sha(bytes),
    sourceRevisions, sourceProvenanceVerified: true,
    buildLockSha256: sha(Buffer.from(JSON.stringify(CADDY_BUILD_LOCK))),
    dependencies, publication: 'not-published',
  }
  await writeFile(join(output, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n')
  await writeFile(join(output, 'version.txt'), version + '\n')
  await writeFile(join(output, 'modules.txt'), modules + '\n')
  await writeFile(join(output, 'go-build.json'), JSON.stringify(build, null, 2) + '\n')
  await writeFile(join(output, 'THIRD_PARTY_LICENSES.txt'), licenses.join('\n'))
  console.log(JSON.stringify({ output, version, bytes: bytes.length, sha256: sha(bytes), published: false }))
} finally {
  // Go extracts module directories read-only on POSIX; let Go remove its OWN private cache first.
  // GOMODCACHE is fixed to modulesCache beneath this atomically allocated work tree, never GOPATH.
  await command(go, ['clean', '-modcache'])
  await rm(work, { recursive: true, force: true })
}
