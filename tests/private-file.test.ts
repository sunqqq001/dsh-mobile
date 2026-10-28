import { execFile as execFileCallback } from 'node:child_process'
import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'
import { restrictPrivateFile } from '../src/private-file.js'

const execFile = promisify(execFileCallback)

describe('private file permissions', () => {
  it('keeps the file readable while removing inherited Windows access', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-mobile-private-'))
    const file = join(directory, 'secret.json')
    await writeFile(file, '{"secret":true}\n')
    await restrictPrivateFile(file)
    await expect(readFile(file, 'utf8')).resolves.toContain('secret')

    if (process.platform === 'win32') {
      const { stdout } = await execFile('icacls.exe', [file], { encoding: 'utf8', windowsHide: true })
      expect(stdout).not.toContain('(I)')
      expect(stdout).not.toMatch(/Everyone|Authenticated Users|BUILTIN\\Users|CodexSandboxUsers/iu)
    } else {
      expect((await stat(file)).mode & 0o777).toBe(0o600)
    }
  })
})
