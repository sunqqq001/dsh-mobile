import { mkdtemp, readFile, rename, symlink, writeFile } from 'node:fs/promises'
import { createRequire, syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

interface CaptureOptions { overwrite: boolean; outputDir?: string; tarball?: string }
const captureUrl = new URL('../scripts/capture-mobile-screenshots.mjs', import.meta.url)
const capture: {
  parseCaptureOptions: (args: string[]) => CaptureOptions
  prepareCaptureOutput: (options: CaptureOptions) => Promise<string>
  writeCapture: (path: string, bytes: Buffer, overwrite: boolean) => Promise<void>
  screenshotMobilePage: (page: object) => Promise<Buffer>
} = await import(captureUrl.href)
const fixtureUrl = new URL('../scripts/mobile-boot-fixture.mjs', import.meta.url)
const { removeTemporaryRoot }: { removeTemporaryRoot: (root: string, prefix: string) => Promise<void> } = await import(fixtureUrl.href)
const roots: Array<{ root: string; prefix: string }> = []

afterEach(async () => { for (const owned of roots.splice(0)) await removeTemporaryRoot(owned.root, owned.prefix) })

async function outputDirectory(): Promise<string> {
  const prefix = 'dsh-mobile-capture-output-test-'
  const root = await mkdtemp(join(tmpdir(), prefix))
  roots.push({ root, prefix })
  return root
}

describe('Mobile screenshot output', () => {
  it('rejects missing, repeated, and unsupported options before capture', () => {
    expect(() => capture.parseCaptureOptions(['--out'])).toThrow('--out requires a value')
    expect(() => capture.parseCaptureOptions(['--out', '--tarball', 'bundle.tgz'])).toThrow('--out requires a value')
    expect(() => capture.parseCaptureOptions(['--overwrite', '--overwrite'])).toThrow('Repeated option')
    expect(() => capture.parseCaptureOptions(['--anything'])).toThrow('Unsupported option')
    expect(capture.parseCaptureOptions(['--out', 'shots', '--overwrite'])).toMatchObject({ overwrite: true })
  })

  it('allocates a fresh default directory for each capture', async () => {
    const first = await capture.prepareCaptureOutput({ overwrite: false })
    roots.push({ root: first, prefix: 'dsh-mobile-screenshots-' })
    const second = await capture.prepareCaptureOutput({ overwrite: false })
    roots.push({ root: second, prefix: 'dsh-mobile-screenshots-' })
    expect(first).not.toBe(second)
  })

  it('preserves existing images unless overwrite is explicit', async () => {
    const outputDir = await outputDirectory()
    const image = join(outputDir, 'mobile-shell-01-pairing.png')
    await writeFile(image, 'previous image')
    await expect(capture.prepareCaptureOutput({ outputDir, overwrite: false })).rejects.toThrow('already exists')
    await expect(capture.writeCapture(image, Buffer.from('new image'), false)).rejects.toThrow('already exists')
    expect(await readFile(image, 'utf8')).toBe('previous image')
    await capture.prepareCaptureOutput({ outputDir, overwrite: true })
    await capture.writeCapture(image, Buffer.from('new image'), true)
    expect(await readFile(image, 'utf8')).toBe('new image')
  })

  it('keeps the temporary pairing field out of screenshot pixels', async () => {
    const locator = { selector: '#pair-token' }
    const screenshot = vi.fn(async () => Buffer.from('png'))
    const page = { evaluate: vi.fn(async () => {}), locator: vi.fn(() => locator), screenshot }
    await capture.screenshotMobilePage(page)
    expect(page.locator).toHaveBeenCalledWith('#pair-token')
    expect(screenshot).toHaveBeenCalledWith({ animations: 'disabled', mask: [locator], maskColor: '#e2e8f0' })
  })

  it('rejects a linked output even with explicit overwrite', async () => {
    const outputDir = await outputDirectory()
    const outside = await outputDirectory()
    const kept = join(outside, 'kept.txt')
    await writeFile(kept, 'outside data')
    const image = join(outputDir, 'mobile-shell-01-pairing.png')
    await symlink(outside, image, process.platform === 'win32' ? 'junction' : 'dir')
    await expect(capture.writeCapture(image, Buffer.from('replacement'), true)).rejects.toThrow('not a regular file')
    expect(await readFile(kept, 'utf8')).toBe('outside data')
  })

  it('preserves a file replaced between the ownership check and open', async () => {
    const outputDir = await outputDirectory()
    const image = join(outputDir, 'mobile-shell-01-pairing.png')
    const previous = join(outputDir, 'previous.png')
    await writeFile(image, 'previous image')
    const filesystem: typeof import('node:fs/promises') = createRequire(import.meta.url)('node:fs/promises')
    const originalOpen = filesystem.open
    filesystem.open = async (path, flags, mode) => {
      if (path === image) {
        await rename(image, previous)
        await writeFile(image, 'concurrent image')
      }
      return originalOpen(path, flags, mode)
    }
    syncBuiltinESMExports()
    try {
      await expect(capture.writeCapture(image, Buffer.from('replacement'), true)).rejects.toThrow('changed before overwrite')
    } finally {
      filesystem.open = originalOpen
      syncBuiltinESMExports()
    }
    expect(await readFile(image, 'utf8')).toBe('concurrent image')
    expect(await readFile(previous, 'utf8')).toBe('previous image')
  })
})
