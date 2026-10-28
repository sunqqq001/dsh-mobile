import { describe, expect, it } from 'vitest'
import { CADDY_VERSION, CADDY_DNS_PLUGIN_VERSION } from '../src/caddy-component.js'

// Build scripts are native JS. A URL import keeps their pure validation helpers independent of TS output.
const scripts = await import(new URL('../scripts/caddy-component-build-inputs.mjs', import.meta.url).href)
const { CADDY_BUILD_LOCK: lock, caddyBuildEnvironment, verifyCaddyBuild, verifyCaddySources } = scripts

function build(platform = 'win32') {
  return { GoVersion: lock.toolchain, Main: { Path: 'caddy', Version: '(devel)' },
    Deps: [...['caddy', 'tencentcloud'].map(name => ({ Path: lock.sources[name].path,
      Version: lock.sources[name].version, Sum: lock.sources[name].sum })),
    { Path: 'golang.org/x/net', Version: lock.dependencies['golang.org/x/net'].version,
      Sum: lock.dependencies['golang.org/x/net'].sum }],
    Settings: Object.entries({ '-buildmode': 'exe', '-compiler': 'gc', '-trimpath': 'true', CGO_ENABLED: '0',
      GOOS: platform === 'win32' ? 'windows' : 'linux', GOARCH: 'amd64', GOAMD64: 'v1' })
      .map(([Key, Value]) => ({ Key, Value })),
  }
}

function sources() {
  return Object.fromEntries(Object.entries(lock.sources).map(([name, untyped]) => {
    const pin = untyped as { path: string; version: string; sum: string; revision: string }
    return [name, { Path: pin.path, Version: pin.version, Sum: pin.sum,
      Origin: { VCS: 'git', URL: 'https://' + pin.path.replace(/\/v[2-9][0-9]*$/u, ''),
        Ref: 'refs/tags/' + pin.version, Hash: pin.revision } }]
  }))
}

describe('pinned native Caddy build inputs', () => {
  it('matches the runtime core and DNS module pins', () => {
    expect(lock.core).toBe('v' + CADDY_VERSION)
    expect(lock.dns).toBe(CADDY_DNS_PLUGIN_VERSION)
    expect(lock.toolchain).toBe('go1.26.9')
    expect(lock.dependencies['golang.org/x/net']).toEqual({ version: 'v0.60.0',
      sum: 'h1:79p50tfZlm0J9YfoDsSi639qSXNGVwEzOPLCxM2FsYU=' })
  })
  it('binds xcaddy to exactly the selected compiler and strips ambient overrides/secrets', () => {
    const environment = caddyBuildEnvironment({ Path: 'trusted-path', SystemRoot: 'windows', GOPATH: 'cache-path',
      GOROOT: 'wrong-go', GOCACHE: 'denied-cache', GOMODCACHE: 'untrusted-modules', GoMoDcAcHe: 'mixed-untrusted-modules', GoPaTh: 'mixed-gopath', GOFLAGS: '-race', GOTOOLCHAIN: 'auto', GOOS: 'linux',
      GOARCH: 'arm64', XCADDY_WHICH_GO: 'other-go', XCADDY_GO_BUILD_FLAGS: '-tags=custom',
      XCADDY_SETCAP: '1', GOSUMDB: 'off', GITHUB_TOKEN: 'not-for-build', TENCENTCLOUD_SECRET_KEY: 'not-for-build' },
    { go: 'pinned-go', tools: 'tools', temporary: 'temporary', cache: 'private-cache', modules: 'private-modules', platform: 'win32', arch: 'x64' })
    expect(environment).toMatchObject({ Path: 'trusted-path', SystemRoot: 'windows', GOPATH: 'cache-path',
      GOCACHE: 'private-cache', GOMODCACHE: 'private-modules', GOENV: 'off', GOFLAGS: '', GOTOOLCHAIN: 'local', GOOS: 'windows', GOARCH: 'amd64',
      GOAMD64: 'v1', XCADDY_WHICH_GO: 'pinned-go', XCADDY_GO_BUILD_FLAGS: '-trimpath -buildvcs=false',
      XCADDY_SETCAP: '0', GOSUMDB: 'sum.golang.org' })
    expect(environment).not.toHaveProperty('GoMoDcAcHe')
    expect(environment.GoPaTh).toBe('mixed-gopath') // SumDB state may be reused, never extracted module sources.
    expect(environment).not.toHaveProperty('GOROOT')
    expect(environment).not.toHaveProperty('GITHUB_TOKEN')
    expect(environment).not.toHaveProperty('TENCENTCLOUD_SECRET_KEY')
  })
  it('never falls back to a shared module cache when the private directory is missing', () => {
    expect(() => caddyBuildEnvironment({ GOMODCACHE: 'untrusted' }, { go: 'go', tools: 'tools',
      temporary: 'temp', cache: 'cache', platform: 'win32', arch: 'x64' })).toThrow('Private Caddy module cache is required')
  })
  it.each(['darwin', 'freebsd'])('does not pretend an unreviewed %s target is supported', platform => {
    expect(() => caddyBuildEnvironment({}, { go: 'go', tools: 'tools', temporary: 'temp', cache: 'cache', platform, arch: 'x64' })).toThrow('not reviewed')
  })
  it('rejects unreviewed architecture rather than silently cross-compiling', () => {
    expect(() => caddyBuildEnvironment({}, { go: 'go', tools: 'tools', temporary: 'temp', cache: 'cache', platform: 'linux', arch: 'arm64' })).toThrow('not reviewed')
  })
  it.each(['win32', 'linux'])('accepts the exact %s native settings and frozen dependencies', platform => {
    expect(() => verifyCaddyBuild(build(platform), platform, 'x64')).not.toThrow()
  })
  it('rejects an outer compiler check that hides a different inner compiler', () => {
    expect(() => verifyCaddyBuild({ ...build(), GoVersion: 'go1.27.0' }, 'win32', 'x64')).toThrow('metadata changed')
  })
  it('rejects the pre-security-patch HTTP/2 dependency in an otherwise pinned build', () => {
    const original = build()
    expect(() => verifyCaddyBuild({ ...original, Deps: original.Deps.map(item => item.Path === 'golang.org/x/net'
      ? { ...item, Version: 'v0.59.0', Sum: 'h1:5zfYln+w5XCxwrnMMJPufRgNoXEaGxl0wo5GqPXyues=' } : item) },
    'win32', 'x64')).toThrow('lock mismatch: golang.org/x/net')
  })
  it('rejects extra build flags, wrong native settings, replacement and unpinned dependencies', () => {
    const original = build()
    expect(() => verifyCaddyBuild({ ...original, Settings: [...original.Settings, { Key: '-tags', Value: 'custom' }] }, 'win32', 'x64')).toThrow('settings changed')
    expect(() => verifyCaddyBuild(original, 'linux', 'x64')).toThrow('settings changed')
    expect(() => verifyCaddyBuild({ ...original, Deps: [...original.Deps, { Path: 'example.com/unreviewed', Version: 'v1.0.0', Sum: 'h1:fixture' }] }, 'win32', 'x64')).toThrow('lock mismatch')
    expect(() => verifyCaddyBuild({ ...original, Deps: [...original.Deps, { Path: '__proto__' }] }, 'win32', 'x64')).toThrow('lock mismatch')
    expect(() => verifyCaddyBuild({ ...original, Deps: original.Deps.map(item => ({ ...item, Replace: { Path: 'local' } })) }, 'win32', 'x64')).toThrow('lock mismatch')
    expect(() => verifyCaddyBuild({ ...original, Deps: original.Deps.map(item => ({ ...item, Sum: 'h1:changed' })) }, 'win32', 'x64')).toThrow('lock mismatch')
  })
  it('rejects duplicate and missing required modules', () => {
    const original = build()
    expect(() => verifyCaddyBuild({ ...original, Deps: [...original.Deps, original.Deps[0]] }, 'win32', 'x64')).toThrow('lock mismatch')
    expect(() => verifyCaddyBuild({ ...original, Deps: original.Deps.slice(0, 1) }, 'win32', 'x64')).toThrow('module missing')
  })
  it('checks actual source version, checksum, Git revision, repository and tag metadata', () => {
    const original = sources()
    expect(verifyCaddySources(original)).toEqual(Object.fromEntries(Object.entries(lock.sources)
      .map(([name, pin]) => [name, (pin as { revision: string }).revision])))
    for (const override of [{ Version: 'v2.11.6' }, { Sum: 'h1:changed' },
      { Origin: { ...original.caddy!.Origin, Hash: 'a'.repeat(40) } },
      { Origin: { ...original.caddy!.Origin, URL: 'https://example.com/other' } },
      { Origin: { ...original.caddy!.Origin, Ref: 'refs/heads/main' } }]) {
      expect(() => verifyCaddySources({ ...original, caddy: { ...original.caddy, ...override } })).toThrow('provenance changed')
    }
  })
})
