import { randomBytes } from 'node:crypto'
import { link, lstat, open, readFile, unlink } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { assertManagedParents, ensureManagedDirectory } from './managed-files.js'
import { restrictPrivateFile } from './private-file.js'

const INSTALLATION_ID_PATTERN = /^[a-f0-9]{64}\n$/u
const INSTALLATION_ID_BYTES = 65

async function readInstallationId(file: string): Promise<string> {
  const entry = await lstat(file)
  if (!entry.isFile() || entry.isSymbolicLink() || entry.size !== INSTALLATION_ID_BYTES) {
    throw new Error('installation_id_invalid')
  }
  const contents = await readFile(file, 'utf8')
  if (!INSTALLATION_ID_PATTERN.test(contents)) throw new Error('installation_id_invalid')
  await restrictPrivateFile(file)
  return contents.slice(0, -1)
}

/** Keep one random plugin identity across setup changes, restarts, and FRP resets; creation requires hard-link support in the state directory. */
export async function loadOrCreateInstallationId(file: string): Promise<string> {
  if (!isAbsolute(file)) throw new Error('installation ID path must be absolute')
  const target = resolve(file)
  const directory = dirname(target)
  await ensureManagedDirectory(directory, directory, 'installation_id')
  try {
    return await readInstallationId(target)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  const temporary = join(directory, `.${basename(target)}.${randomBytes(12).toString('hex')}.tmp`)
  let created = false
  let failure: unknown
  try {
    await assertManagedParents(directory, temporary, 'installation_id')
    const handle = await open(temporary, 'wx', 0o600)
    created = true
    let writeFailure: unknown
    try {
      await handle.writeFile(`${randomBytes(32).toString('hex')}\n`, 'utf8')
    } catch (error) {
      writeFailure = error
      throw error
    } finally {
      try {
        await handle.close()
      } catch (closeError) {
        if (writeFailure !== undefined) throw new AggregateError([writeFailure, closeError], 'installation ID candidate write and close failed')
        throw closeError
      }
    }
    await restrictPrivateFile(temporary)
    await assertManagedParents(directory, target, 'installation_id')
    try {
      await link(temporary, target)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
        throw new Error('installation ID publication failed; the state filesystem must support hard links', { cause: error })
      }
    }
    return await readInstallationId(target)
  } catch (error) {
    failure = error
    throw error
  } finally {
    if (created) {
      try {
        await assertManagedParents(directory, temporary, 'installation_id')
        await unlink(temporary)
      } catch (cleanupError) {
        if (failure !== undefined) throw new AggregateError([failure, cleanupError], 'installation ID publication and temporary cleanup failed')
        throw cleanupError
      }
    }
  }
}
