import { readFile } from 'node:fs/promises'
import { isBuiltin } from 'node:module'
import { pathToFileURL } from 'node:url'

/**
 * Refuse imports the browser's DSH module loader cannot supply.
 * @param source - generated client bundle.
 * @param runtimeDependencies - packages shipped as npm runtime dependencies, not DSH client providers.
 * @returns nothing; throws for Node builtins or unbundled runtime package imports.
 */
export function checkClientBundleImports(source, runtimeDependencies = []) {
  const imports = [...source.matchAll(/\brequire\s*\(\s*(['"])([^'"]+)\1\s*\)/gu)].map(match => match[2])
  const builtins = imports.filter(specifier => isBuiltin(specifier))
  if (builtins.length > 0) {
    throw new Error(`Browser client bundle imports Node builtins: ${[...new Set(builtins)].join(', ')}`)
  }
  const unbundled = imports.filter(specifier => runtimeDependencies.some(name => specifier === name || specifier.startsWith(name + '/')))
  if (unbundled.length > 0) {
    throw new Error(`Browser client runtime dependencies must be bundled: ${[...new Set(unbundled)].join(', ')}`)
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
  checkClientBundleImports(await readFile(new URL('../lib/client.js', import.meta.url), 'utf8'), Object.keys(manifest.dependencies ?? {}))
}
