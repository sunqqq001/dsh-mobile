import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { listComputerImages, readComputerImage, resolveComputerImagePath } from '../src/computer-images.js'

describe('authenticated computer image browser', () => {
  it('lists directories and supported images while omitting other files', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-mobile-images-'))
    await Promise.all([
      mkdir(join(root, 'album')),
      writeFile(join(root, 'photo.PNG'), 'png'),
      writeFile(join(root, 'notes.txt'), 'text'),
    ])
    await expect(listComputerImages(root)).resolves.toMatchObject({
      path: root,
      entries: [
        { kind: 'directory', name: 'album' },
        { kind: 'image', name: 'photo.PNG' },
      ],
      truncated: false,
    })
  })

  it('reads supported regular images and rejects relative or non-image paths', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-mobile-image-'))
    const image = join(root, 'photo.webp')
    await writeFile(image, 'webp')
    await expect(readComputerImage(image)).resolves.toMatchObject({ contentType: 'image/webp', name: 'photo.webp' })
    expect(() => resolveComputerImagePath('relative.png')).toThrow(/bad_path/)
    await expect(readComputerImage(join(root, 'notes.txt'))).rejects.toThrow(/unsupported_file_type/)
  })

  it('stops directory and file reads when device authorization is revoked', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-mobile-image-abort-'))
    const image = join(root, 'photo.png')
    await writeFile(image, 'png')
    const controller = new AbortController()
    controller.abort(new Error('device_revoked'))
    await expect(listComputerImages(root, controller.signal)).rejects.toThrow('device_revoked')
    await expect(readComputerImage(image, controller.signal)).rejects.toThrow('device_revoked')
  })
})
