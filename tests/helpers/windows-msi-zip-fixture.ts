import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { crc32, deflateRawSync, inflateRawSync } from 'node:zlib'

/** Entry metadata for the controlled ZIP32/deflate fixtures; payloads contain real zero bytes. */
export interface WindowsMsiZipEntryFixture {
  readonly name: string
  readonly bytes: number
  readonly attributes?: number
}

const localBytes = 30
const centralBytes = 46
const endBytes = 22
const utf8 = 0x800
const deflate = 8
const dosDate = 0x21 // 1980-01-01, the first date represented by ZIP's DOS timestamp.
const maximumPayload = 33 * 1024 * 1024

function fixtureName(entry: WindowsMsiZipEntryFixture): Buffer {
  const name = Buffer.from(entry.name, 'utf8')
  assert(name.length > 0 && name.length <= 0xffff, 'ZIP fixture name length')
  assert(Number.isInteger(entry.bytes) && entry.bytes >= 0 && entry.bytes <= maximumPayload, 'ZIP fixture payload size')
  const attributes = entry.attributes ?? 0
  assert(Number.isInteger(attributes) && attributes >= -0x8000_0000 && attributes <= 0x7fff_ffff, 'ZIP fixture signed attributes')
  return name
}

/** Build only the ZIP32/UTF-8/deflate format needed by native MSI reader tests; names are never extracted here. */
export function createWindowsMsiZipFixture(entries: readonly WindowsMsiZipEntryFixture[]): Buffer {
  assert(entries.length > 0 && entries.length <= 129, 'ZIP fixture entry count')
  const local: Buffer[] = []; const central: Buffer[] = []
  let offset = 0
  for (const entry of entries) {
    const name = fixtureName(entry)
    const payload = Buffer.alloc(entry.bytes)
    const compressed = deflateRawSync(payload, { level: 1 })
    const checksum = crc32(payload)
    const header = Buffer.alloc(localBytes)
    header.writeUInt32LE(0x04034b50, 0); header.writeUInt16LE(20, 4)
    header.writeUInt16LE(utf8, 6); header.writeUInt16LE(deflate, 8); header.writeUInt16LE(dosDate, 12)
    header.writeUInt32LE(checksum, 14); header.writeUInt32LE(compressed.length, 18); header.writeUInt32LE(payload.length, 22)
    header.writeUInt16LE(name.length, 26)
    local.push(header, name, compressed)
    const record = Buffer.alloc(centralBytes)
    record.writeUInt32LE(0x02014b50, 0); record.writeUInt16LE(0x0314, 4); record.writeUInt16LE(20, 6)
    record.writeUInt16LE(utf8, 8); record.writeUInt16LE(deflate, 10); record.writeUInt16LE(dosDate, 14)
    record.writeUInt32LE(checksum, 16); record.writeUInt32LE(compressed.length, 20); record.writeUInt32LE(payload.length, 24)
    record.writeUInt16LE(name.length, 28); record.writeInt32LE(entry.attributes ?? 0, 38); record.writeUInt32LE(offset, 42)
    central.push(record, name)
    offset += header.length + name.length + compressed.length
  }
  const directory = Buffer.concat(central)
  const end = Buffer.alloc(endBytes)
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16)
  return Buffer.concat([...local, directory, end])
}

/** Read actual fixture bytes back, requiring complete records, matching metadata, and genuine bounded deflated payloads. */
export function verifyWindowsMsiZipFixture(zip: Buffer, entries: readonly WindowsMsiZipEntryFixture[]): void {
  assert(entries.length > 0 && entries.length <= 129, 'ZIP fixture entry count')
  assert(zip.length >= endBytes, 'ZIP fixture end record missing')
  const end = zip.subarray(zip.length - endBytes)
  assert(end.readUInt32LE(0) === 0x06054b50 && end.readUInt16LE(4) === 0 && end.readUInt16LE(6) === 0
    && end.readUInt16LE(8) === entries.length && end.readUInt16LE(10) === entries.length
    && end.readUInt16LE(20) === 0, 'ZIP fixture end record mismatch')
  const directoryOffset = end.readUInt32LE(16)
  const directorySize = end.readUInt32LE(12)
  assert(directoryOffset + directorySize === zip.length - endBytes, 'ZIP fixture central directory range')
  let centralOffset = directoryOffset
  let localOffset = 0
  for (const entry of entries) {
    const name = fixtureName(entry)
    assert(centralOffset + centralBytes <= zip.length - endBytes, 'ZIP fixture central header truncated')
    const record = zip.subarray(centralOffset, centralOffset + centralBytes)
    assert(record.readUInt32LE(0) === 0x02014b50 && record.readUInt16LE(4) === 0x0314 && record.readUInt16LE(6) === 20
      && record.readUInt16LE(8) === utf8 && record.readUInt16LE(10) === deflate && record.readUInt16LE(12) === 0
      && record.readUInt16LE(14) === dosDate, 'ZIP fixture central header mismatch')
    assert(record.readUInt32LE(24) === entry.bytes && record.readUInt16LE(28) === name.length
      && record.readUInt16LE(30) === 0 && record.readUInt16LE(32) === 0 && record.readUInt16LE(34) === 0
      && record.readUInt16LE(36) === 0 && record.readInt32LE(38) === (entry.attributes ?? 0)
      && record.readUInt32LE(42) === localOffset, 'ZIP fixture central metadata mismatch')
    assert(zip.subarray(centralOffset + centralBytes, centralOffset + centralBytes + name.length).equals(name), 'ZIP fixture central name mismatch')
    centralOffset += centralBytes + name.length
    assert(localOffset + localBytes <= directoryOffset, 'ZIP fixture local header truncated')
    const header = zip.subarray(localOffset, localOffset + localBytes)
    assert(header.readUInt32LE(0) === 0x04034b50 && header.readUInt16LE(4) === 20 && header.readUInt16LE(6) === utf8
      && header.readUInt16LE(8) === deflate && header.readUInt16LE(10) === 0 && header.readUInt16LE(12) === dosDate
      && header.readUInt32LE(14) === record.readUInt32LE(16) && header.readUInt32LE(18) === record.readUInt32LE(20)
      && header.readUInt32LE(22) === entry.bytes && header.readUInt16LE(26) === name.length
      && header.readUInt16LE(28) === 0, 'ZIP fixture local header mismatch')
    const nameOffset = localOffset + localBytes
    assert(zip.subarray(nameOffset, nameOffset + name.length).equals(name), 'ZIP fixture local name mismatch')
    const payloadOffset = nameOffset + name.length
    const payloadEnd = payloadOffset + header.readUInt32LE(18)
    assert(payloadEnd <= directoryOffset, 'ZIP fixture compressed payload range')
    let payload: Buffer
    try { payload = inflateRawSync(zip.subarray(payloadOffset, payloadEnd), { maxOutputLength: entry.bytes + 1 }) }
    catch (error) { throw new Error('ZIP fixture deflate payload invalid', { cause: error }) }
    assert(payload.length === entry.bytes && payload.every(byte => byte === 0), 'ZIP fixture real zero payload mismatch')
    assert(crc32(payload) === record.readUInt32LE(16), 'ZIP fixture payload CRC mismatch')
    localOffset = payloadEnd
  }
  assert(centralOffset === directoryOffset + directorySize && localOffset === directoryOffset, 'ZIP fixture record layout mismatch')
}

/** Create a new owned fixture path exclusively, then verify the persisted ZIP; existing archives are never overwritten. */
export async function writeWindowsMsiZipFixture(archive: string, entries: readonly WindowsMsiZipEntryFixture[]): Promise<void> {
  await writeFile(archive, createWindowsMsiZipFixture(entries), { flag: 'wx' })
  verifyWindowsMsiZipFixture(await readFile(archive), entries)
}
