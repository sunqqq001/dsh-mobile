import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

describe('DeepSeek Harness compatibility', () => {
  it('retains host peer names without blocking new DSH versions', async () => {
    const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
    const lock = JSON.parse(await readFile(new URL('../package-lock.json', import.meta.url), 'utf8'))
    expect(lock.packages[''].peerDependencies).toEqual(manifest.peerDependencies)
    const hostPeers = Object.entries(manifest.peerDependencies)
      .filter(([name]) => name.startsWith('@deepseek-ai/dsh-'))
    expect(hostPeers.map(([name]) => name).sort()).toEqual([
      '@deepseek-ai/dsh-client-connection',
      '@deepseek-ai/dsh-commands',
      '@deepseek-ai/dsh-host-webserver',
      '@deepseek-ai/dsh-llm',
    ])
    for (const [name, range] of hostPeers) {
      expect(range).toBe('*')
      expect(manifest.peerDependenciesMeta[name]?.optional).toBe(true)
    }
  })

  it('does not reject the host by its package version during startup', async () => {
    const source = await readFile(new URL('../src/plugin.ts', import.meta.url), 'utf8')
    expect(source).not.toMatch(/assertSupportedDshVersion|SUPPORTED_DSH_VERSIONS/u)
  })
})
