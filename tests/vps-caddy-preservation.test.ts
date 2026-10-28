import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, win32 } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { parseFrpSettings } from '../src/frp-config.js'
import { createVpsUninstallScript, vpsDeploymentScriptForTesting } from '../src/vps-deploy.js'

function shell(): string {
  if (process.platform !== 'win32') return 'sh'
  const git = spawnSync('git', ['--exec-path'], { encoding: 'utf8', timeout: 10_000, windowsHide: true })
  if (git.error !== undefined) throw git.error
  if (git.status !== 0 || !win32.isAbsolute(git.stdout.trim())) throw new Error('Git for Windows did not identify its Bash installation')
  const candidate = win32.resolve(git.stdout.trim(), '../../../bin/bash.exe')
  if (!existsSync(candidate)) throw new Error('Git for Windows Bash is unavailable')
  return candidate
}
const executable = shell()
const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })

const settings = parseFrpSettings({ serverAddress: 'frp.example.com', serverPort: 7000,
  token: '0123456789abcdef0123456789abcdef', publicOrigin: 'https://dsh.example.com' })

async function runConfigSection(action: 'deploy' | 'uninstall', content: string) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-mobile-caddy-preserve-'))
  roots.push(root)
  const file = join(root, 'Caddyfile')
  expect(resolve(file).startsWith(`${resolve(root)}${process.platform === 'win32' ? '\\' : '/'}`)).toBe(true)
  await writeFile(file, content)
  const generated = action === 'deploy' ? vpsDeploymentScriptForTesting(settings) : createVpsUninstallScript({ serverPort: 7000 })
  const start = action === 'deploy' ? generated.indexOf('caddy_import=') : generated.indexOf("if grep -Eq '^[[:space:]]*import")
  const end = action === 'deploy' ? generated.indexOf('\narch="$(uname -m)"') : generated.indexOf('\nif command -v ufw')
  expect(start).toBeGreaterThan(0)
  expect(end).toBeGreaterThan(start)
  const fixtureRoot = root.replaceAll('\\', '/')
  const body = generated.slice(start, end).replaceAll('/etc/caddy', fixtureRoot)
  const result = spawnSync(executable, ['-s'], { input: `set -eu\nfail() { echo "$1" >&2; exit 1; }\ncheck() { echo "$*"; }\ncaddy() { return 0; }\nsystemctl() { return 0; }\n${body}`, env: Object.fromEntries(Object.entries(process.env).filter(([key]) => !['BASH_ENV', 'ENV'].includes(key.toUpperCase()))), encoding: 'utf8', timeout: 10000, windowsHide: true })
  expect(result.error).toBeUndefined()
  return { result, content: await readFile(file, 'utf8'), root }
}

describe('generated Caddy configuration preservation', () => {
  it.each([
    ':80 {\n\troot * /usr/share/caddy\n\tfile_server\n}\n\nexample.com {\n\treverse_proxy 127.0.0.1:9000\n}\n',
    '# Managed by DSH Mobile\ndsh.example.com {\n reverse_proxy 127.0.0.1:7080\n}\nexample.com {\n reverse_proxy 127.0.0.1:9000\n}\n',
  ])('refuses to replace unknown existing sites even when stock features or a legacy marker match', async content => {
    const actual = await runConfigSection('deploy', content)
    expect(actual.result.status).toBe(1)
    expect(actual.result.stderr).toContain('已有 Caddyfile')
    expect(actual.content).toBe(content)
  })

  it('preserves legacy tagged user sites during uninstall', async () => {
    const content = '# Managed by DSH Mobile\ndsh.example.com {\n reverse_proxy 127.0.0.1:7080\n}\nexample.com {\n reverse_proxy 127.0.0.1:9000\n}\n'
    const actual = await runConfigSection('uninstall', content)
    expect(actual.result.status).toBe(0)
    expect(actual.result.stdout).toContain('caddy warning')
    expect(actual.content).toBe(content)
  })

  it('deduplicates only its import and retains user site bytes on redeploy', async () => {
    // The fixture rewrites the generated path, so its existing import uses that path too.
    const first = await runConfigSection('deploy', '')
    const userSite = 'example.com {\n reverse_proxy 127.0.0.1:9000\n}\n'
    const content = `${first.content}${userSite}${first.content}`
    const generated = vpsDeploymentScriptForTesting(settings)
    const body = generated.slice(generated.indexOf('caddy_import='), generated.indexOf('\narch="$(uname -m)"')).replaceAll('/etc/caddy', first.root.replaceAll('\\', '/'))
    await writeFile(join(first.root, 'Caddyfile'), content)
    const result = spawnSync(executable!, ['-s'], { input: `set -eu\nfail() { exit 1; }\n${body}`, encoding: 'utf8', timeout: 10000, windowsHide: true })
    expect(result.status).toBe(0)
    expect(await readFile(join(first.root, 'Caddyfile'), 'utf8')).toBe(`${first.content}${userSite}`)
  })
})
