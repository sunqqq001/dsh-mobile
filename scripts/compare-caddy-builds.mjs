import { lstat, realpath, writeFile } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { buildLockSha256, readArtifact } from './caddy-component-artifacts.mjs'

const args = process.argv.slice(2)
if (args.length !== 6 || args[0] !== '--first' || args[2] !== '--second' || args[4] !== '--target'
  || !isAbsolute(args[1]) || !isAbsolute(args[3])) {
  throw new Error('Usage: node scripts/compare-caddy-builds.mjs --first <absolute-dir> --second <absolute-dir> --target <platform-arch>')
}
for (const path of [args[1], args[3]]) {
  const entry = await lstat(path)
  if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error('Invalid Caddy artifact directory')
}
const [firstPath, secondPath] = await Promise.all([realpath(args[1]), realpath(args[3])])
if (firstPath === secondPath) throw new Error('Independent Caddy build directories required')
const first = await readArtifact(firstPath, args[5])
const second = await readArtifact(secondPath, args[5])
if (first.manifest.executableBytes !== second.manifest.executableBytes
  || first.manifest.executableSha256 !== second.manifest.executableSha256) throw new Error('Independent Caddy binary builds differ')
const proof = { schemaVersion: 1, target: args[5], independentBuilds: 2, buildLockSha256: buildLockSha256(),
  bytes: first.manifest.executableBytes, firstSha256: first.manifest.executableSha256, secondSha256: second.manifest.executableSha256 }
// Only append a new report to the explicitly selected build; never overwrite previous evidence.
await writeFile(join(firstPath, 'reproducibility.json'), JSON.stringify(proof, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
console.log(JSON.stringify(proof))
