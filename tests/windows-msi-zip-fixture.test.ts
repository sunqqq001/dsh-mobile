import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { crc32, deflateRawSync, inflateRawSync } from 'node:zlib'
import { afterEach, describe, expect, it } from 'vitest'
import { createWindowsMsiZipFixture, verifyWindowsMsiZipFixture, writeWindowsMsiZipFixture } from './helpers/windows-msi-zip-fixture.js'

const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })
const entries = [{ name: '中文 空格/fixture.msi', bytes: 4, attributes: -1_610_612_736 }]
const centralOffset = (zip: Buffer) => zip.readUInt32LE(zip.length - 6)
const payloadOffset = (zip: Buffer) => 30 + zip.readUInt16LE(26)

describe('controlled native-MSI ZIP fixture', () => {
  it('preserves UTF-8 metadata, duplicate names, and signed Unix/DOS external attributes', () => {
    const input = [...entries, { name: 'installer.msi', bytes: 0, attributes: 0x400 }, { name: 'installer.msi', bytes: 4, attributes: -1 }]
    const zip = createWindowsMsiZipFixture(input)
    expect(() => verifyWindowsMsiZipFixture(zip, input)).not.toThrow()
    expect(zip.readUInt16LE(6)).toBe(0x800)
    expect(zip.readUInt16LE(8)).toBe(8)
    expect(zip.subarray(30, payloadOffset(zip)).toString('utf8')).toBe(entries[0]!.name)
    const central = centralOffset(zip)
    expect(zip.readInt32LE(central + 38)).toBe(-1_610_612_736)
    expect(zip.readUInt32LE(central + 38)).toBe(0xa000_0000)
    const second = central + 46 + Buffer.byteLength(entries[0]!.name)
    expect(zip.readInt32LE(second + 38)).toBe(0x400)
    const third = second + 46 + Buffer.byteLength('installer.msi')
    expect(zip.readInt32LE(third + 38)).toBe(-1)
  })

  it('carries all 129 entries rather than substituting a malformed directory count', () => {
    const input = Array.from({ length: 129 }, (_, index) => ({ name: `entry-${index}.msi`, bytes: index === 0 ? 4 : 0 }))
    const zip = createWindowsMsiZipFixture(input)
    verifyWindowsMsiZipFixture(zip, input)
    expect(zip.readUInt16LE(zip.length - 14)).toBe(129)
    expect(zip.readUInt16LE(zip.length - 12)).toBe(129)
  })

  it('stores a genuine deflated 33 MiB zero payload in a small ZIP', () => {
    const bytes = 33 * 1024 * 1024
    const input = [{ name: 'installer.msi', bytes }]
    const zip = createWindowsMsiZipFixture(input)
    verifyWindowsMsiZipFixture(zip, input)
    expect(zip.length).toBeLessThan(1024 * 1024)
    expect(zip.readUInt32LE(22)).toBe(bytes)
    const payload = inflateRawSync(zip.subarray(payloadOffset(zip), centralOffset(zip)))
    expect(payload.length).toBe(bytes)
    expect(payload.every(byte => byte === 0)).toBe(true)
    expect(crc32(payload)).toBe(zip.readUInt32LE(14))
  })

  it.each([
    ['local signature', (zip: Buffer) => zip.writeUInt32LE(0, 0)],
    ['local flags', (zip: Buffer) => zip.writeUInt16LE(0, 6)],
    ['local compression', (zip: Buffer) => zip.writeUInt16LE(0, 8)],
    ['local name', (zip: Buffer) => { zip[30] = 0 }],
    ['local bytes', (zip: Buffer) => zip.writeUInt32LE(3, 22)],
    ['central signature', (zip: Buffer) => zip.writeUInt32LE(0, centralOffset(zip))],
    ['central attributes', (zip: Buffer) => zip.writeInt32LE(0, centralOffset(zip) + 38)],
    ['central local offset', (zip: Buffer) => zip.writeUInt32LE(1, centralOffset(zip) + 42)],
    ['central name', (zip: Buffer) => { zip[centralOffset(zip) + 46] = 0 }],
    ['end signature', (zip: Buffer) => zip.writeUInt32LE(0, zip.length - 22)],
    ['end count', (zip: Buffer) => zip.writeUInt16LE(2, zip.length - 12)],
    ['directory size', (zip: Buffer) => zip.writeUInt32LE(0, zip.length - 10)],
    ['directory offset', (zip: Buffer) => zip.writeUInt32LE(0, zip.length - 6)],
    ['deflate bytes', (zip: Buffer) => zip.fill(0xff, payloadOffset(zip), centralOffset(zip))],
    ['matching but false CRCs', (zip: Buffer) => { zip.writeUInt32LE(0, 14); zip.writeUInt32LE(0, centralOffset(zip) + 16) }],
  ] as const)('rejects tampered %s in the actual archive bytes', (_name, mutate) => {
    const zip = createWindowsMsiZipFixture(entries)
    mutate(zip)
    expect(() => verifyWindowsMsiZipFixture(zip, entries)).toThrow()
  })

  it('rejects declared size without the corresponding real decompressed payload', () => {
    const zip = createWindowsMsiZipFixture(entries)
    const declared = 33 * 1024 * 1024
    zip.writeUInt32LE(declared, 22); zip.writeUInt32LE(declared, centralOffset(zip) + 24)
    expect(() => verifyWindowsMsiZipFixture(zip, [{ ...entries[0]!, bytes: declared }])).toThrow('real zero payload mismatch')
  })

  it('rejects nonzero payloads even with matching lengths, valid deflate, and CRCs', () => {
    const zip = createWindowsMsiZipFixture(entries)
    const payload = Buffer.alloc(4, 1)
    const compressed = deflateRawSync(payload, { level: 1 })
    expect(compressed.length).toBe(zip.readUInt32LE(18))
    compressed.copy(zip, payloadOffset(zip))
    zip.writeUInt32LE(crc32(payload), 14); zip.writeUInt32LE(crc32(payload), centralOffset(zip) + 16)
    expect(() => verifyWindowsMsiZipFixture(zip, entries)).toThrow('real zero payload mismatch')
  })

  it('creates through Unicode paths exclusively and reads back the persisted bytes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-mobile-zip-fixture-')); roots.push(root)
    const archive = join(root, '只读 包.zip')
    await writeWindowsMsiZipFixture(archive, entries)
    const before = await readFile(archive)
    verifyWindowsMsiZipFixture(before, entries)
    await expect(writeWindowsMsiZipFixture(archive, [{ name: 'other.msi', bytes: 0 }])).rejects.toMatchObject({ code: 'EEXIST' })
    expect(await readFile(archive)).toEqual(before)
    await writeFile(archive, before.subarray(0, 10))
    const corrupted = await readFile(archive)
    expect(() => verifyWindowsMsiZipFixture(corrupted, entries)).toThrow('end record missing')
  })
})
