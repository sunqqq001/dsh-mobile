import { readFile } from 'node:fs/promises'

/** Reviewed source/toolchain inputs; unknown compiled dependencies fail closed. */
export const CADDY_BUILD_LOCK = JSON.parse(await readFile(new URL('./caddy-component-lock.json', import.meta.url), 'utf8'))

/** Use one compiler for the outer build and xcaddy, without ambient build overrides or API secrets. */
export function caddyBuildEnvironment(base, { go, tools, temporary, cache, modules, platform = process.platform, arch = process.arch }) {
  if (!['win32', 'linux'].includes(platform) || arch !== 'x64') throw new Error('Caddy component target is not reviewed')
  const allowed = new Set(['PATH', 'SYSTEMROOT', 'WINDIR', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA',
    'LANG', 'LC_ALL', 'GOPATH', 'GOPROXY', 'HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY', 'SSL_CERT_FILE', 'SSL_CERT_DIR'])
  if (typeof modules !== 'string' || modules.length === 0) throw new Error('Private Caddy module cache is required')
  const environment = Object.fromEntries(Object.entries(base).filter(([key]) => allowed.has(key.toUpperCase())))
  return { ...environment, GOBIN: tools, GOTOOLCHAIN: 'local', CGO_ENABLED: '0', GOCACHE: cache, GOMODCACHE: modules,
    GOENV: 'off', GOWORK: 'off', GOFLAGS: '', GOEXPERIMENT: '', GOAMD64: 'v1',
    GOSUMDB: 'sum.golang.org', GOPRIVATE: '', GONOSUMDB: '', GONOPROXY: '', GOINSECURE: '',
    GOOS: platform === 'win32' ? 'windows' : 'linux', GOARCH: 'amd64',
    TMPDIR: temporary, TEMP: temporary, TMP: temporary, XCADDY_WHICH_GO: go,
    XCADDY_GO_BUILD_FLAGS: '-trimpath -buildvcs=false', XCADDY_GO_MOD_FLAGS: '',
    XCADDY_SKIP_CLEANUP: '1', XCADDY_SETCAP: '0',
  }
}

/** Verify actual Go proxy origin metadata, not a hardcoded claim appended after compilation. */
export function verifyCaddySources(downloads, lock = CADDY_BUILD_LOCK) {
  if (lock.core !== lock.sources.caddy.version || lock.dns !== lock.sources.tencentcloud.version
    || lock.xcaddy !== lock.sources.xcaddy.version) throw new Error('Caddy source pin binding changed')
  const revisions = {}
  for (const [name, pin] of Object.entries(lock.sources)) {
    const actual = downloads[name]
    if (actual?.Path !== pin.path || actual.Version !== pin.version || actual.Sum !== pin.sum
      || actual.Origin?.VCS !== 'git' || actual.Origin.Hash !== pin.revision
      || actual.Origin.Ref !== 'refs/tags/' + pin.version
      || actual.Origin.URL !== 'https://' + pin.path.replace(/\/v[2-9][0-9]*$/u, '')) {
      throw new Error('Caddy source provenance changed: ' + name)
    }
    revisions[name] = actual.Origin.Hash
  }
  return revisions
}

/** Reject dependency, architecture, toolchain, replacement and build-flag drift before execution. */
export function verifyCaddyBuild(build, platform = process.platform, arch = process.arch, lock = CADDY_BUILD_LOCK) {
  if (!['win32', 'linux'].includes(platform) || arch !== 'x64' || build?.GoVersion !== lock.toolchain
    || build.Main?.Path !== 'caddy' || build.Main.Replace !== undefined
    || !Array.isArray(build.Deps) || build.Deps.length === 0) throw new Error('Caddy build metadata changed')
  const expected = { '-buildmode': 'exe', '-compiler': 'gc', '-trimpath': 'true', CGO_ENABLED: '0',
    GOOS: platform === 'win32' ? 'windows' : 'linux', GOARCH: 'amd64', GOAMD64: 'v1' }
  const settings = Object.fromEntries((build.Settings ?? []).map(item => [item.Key, item.Value]))
  if (Object.keys(settings).length !== Object.keys(expected).length
    || Object.entries(expected).some(([key, value]) => settings[key] !== value)) throw new Error('Caddy build settings changed')
  const seen = new Set()
  for (const entry of build.Deps) {
    const pin = typeof entry?.Path === 'string' && Object.hasOwn(lock.dependencies, entry.Path)
      ? lock.dependencies[entry.Path] : undefined
    if (entry.Replace !== undefined || seen.has(entry.Path) || pin === undefined
      || entry.Version !== pin.version || entry.Sum !== pin.sum) throw new Error('Caddy dependency lock mismatch: ' + entry.Path)
    seen.add(entry.Path)
  }
  for (const name of ['caddy', 'tencentcloud']) {
    const source = lock.sources[name]
    const compiled = build.Deps.find(entry => entry.Path === source.path)
    if (compiled === undefined) throw new Error('Caddy required module missing: ' + name)
    if (compiled.Version !== source.version || compiled.Sum !== source.sum) throw new Error('Caddy compiled source binding changed: ' + name)
  }
}
