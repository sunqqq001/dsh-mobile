import { execFile as execFileCallback } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const execFile = promisify(execFileCallback)
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const source = resolve(root, 'native/funnel-host')
const outputDirectory = resolve(root, 'bin')
const workspaceGo = resolve(root, '../go/bin/go.exe')
const go = process.env.GO_BINARY || (process.platform === 'win32' && existsSync(workspaceGo) ? workspaceGo : 'go')

/** Every Funnel sidecar shipped in the npm package, built reproducibly from the same source. */
const targets = [
  { goos: 'windows', goarch: 'amd64', file: 'dsh-mobile-funnel-win32-x64.exe', header: 'MZ' },
  { goos: 'linux', goarch: 'amd64', file: 'dsh-mobile-funnel-linux-x64', header: 'ELF' },
  { goos: 'linux', goarch: 'arm64', file: 'dsh-mobile-funnel-linux-arm64', header: 'ELF' },
]

await mkdir(outputDirectory, { recursive: true })
for (const target of targets) {
  const output = resolve(outputDirectory, target.file)
  await execFile(go, [
    'build',
    '-trimpath',
    '-buildvcs=false',
    // Omit build-cache action IDs; retain module metadata for license verification.
    '-ldflags=-s -w -buildid=',
    '-o',
    output,
    '.',
  ], {
    cwd: source,
    env: { ...process.env, CGO_ENABLED: '0', GOOS: target.goos, GOARCH: target.goarch },
    windowsHide: true,
  })
  const magic = (await readFile(output)).subarray(0, 4)
  const header = target.header === 'MZ'
    ? magic.subarray(0, 2).toString('ascii')
    : magic[0] === 0x7f && magic.subarray(1, 4).toString('ascii') === 'ELF' ? 'ELF' : 'unknown'
  if (header !== target.header) throw new Error(`funnel host build did not produce a ${target.header} binary: ${output}`)
  console.log(`built ${output}`)
}
