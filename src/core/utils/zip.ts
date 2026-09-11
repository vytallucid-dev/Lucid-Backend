/**
 * Minimal ZIP reader for single-file archives, built on Node's own zlib.
 *
 * WHY HAND-ROLLED
 * ---------------
 * The only archive this codebase needs to read is the BIS policy-rate bulk file
 * (`WS_CBPOL_csv_col.zip`), which is a single deflate-compressed CSV. Pulling a
 * zip dependency into the build for one file was not worth it. The precedent is
 * `nse.client.ts`, which already does raw `zlib.gunzip` on a compressed
 * response.
 *
 * WHY IT READS THE CENTRAL DIRECTORY RATHER THAN THE LOCAL HEADER
 * ---------------------------------------------------------------
 * The BIS archive sets general-purpose bit 3 (its flag word is 0x808), which
 * means "sizes and CRC are not in the local file header — they follow the
 * compressed data in a data descriptor". So the local header's compressed-size
 * field is zero and cannot be used to bound the deflate stream.
 *
 * The CENTRAL DIRECTORY always carries correct sizes regardless of that flag, so
 * this reader locates the end-of-central-directory record, walks to the central
 * directory entry, and takes the compressed size and local-header offset from
 * there. That is exact: no guessing, no reliance on `inflateRaw` politely
 * stopping at the end of the stream, and no trailing-byte ambiguity.
 *
 * SCOPE: deliberately not a general ZIP library. It handles stored (method 0)
 * and deflate (method 8), no encryption, no ZIP64, no multi-disk. Anything else
 * throws with a clear message rather than returning wrong bytes.
 */
import zlib from 'node:zlib';

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;
/** EOCD is 22 bytes plus a comment of up to 65535. */
const MAX_EOCD_SCAN = 22 + 0xffff;

export interface ZipEntry {
  name: string;
  compressedSize: number;
  uncompressedSize: number;
  compressionMethod: number;
  localHeaderOffset: number;
}

function findEocdOffset(buf: Buffer): number {
  const from = Math.max(0, buf.length - MAX_EOCD_SCAN);
  for (let i = buf.length - 22; i >= from; i -= 1) {
    if (buf.readUInt32LE(i) === EOCD_SIGNATURE) return i;
  }
  throw new Error('ZIP: end-of-central-directory record not found (not a zip file?)');
}

/** Every entry in the archive, read from the central directory. */
export function listZipEntries(buf: Buffer): ZipEntry[] {
  const eocd = findEocdOffset(buf);
  const entryCount = buf.readUInt16LE(eocd + 10);
  let offset = buf.readUInt32LE(eocd + 16);

  if (offset === 0xffffffff) {
    throw new Error('ZIP: ZIP64 archives are not supported');
  }

  const entries: ZipEntry[] = [];
  for (let i = 0; i < entryCount; i += 1) {
    if (buf.readUInt32LE(offset) !== CENTRAL_SIGNATURE) {
      throw new Error(`ZIP: bad central directory signature at entry ${i}`);
    }
    const compressionMethod = buf.readUInt16LE(offset + 10);
    const compressedSize = buf.readUInt32LE(offset + 20);
    const uncompressedSize = buf.readUInt32LE(offset + 24);
    const nameLen = buf.readUInt16LE(offset + 28);
    const extraLen = buf.readUInt16LE(offset + 30);
    const commentLen = buf.readUInt16LE(offset + 32);
    const localHeaderOffset = buf.readUInt32LE(offset + 42);
    const name = buf.subarray(offset + 46, offset + 46 + nameLen).toString('utf8');

    entries.push({ name, compressedSize, uncompressedSize, compressionMethod, localHeaderOffset });
    offset += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

/** Decompress one entry to a Buffer. */
export function readZipEntry(buf: Buffer, entry: ZipEntry): Buffer {
  if (buf.readUInt32LE(entry.localHeaderOffset) !== LOCAL_SIGNATURE) {
    throw new Error(`ZIP: bad local header signature for "${entry.name}"`);
  }
  // The local header's own name/extra lengths can differ from the central
  // directory's, so they must be read from the local header itself.
  const nameLen = buf.readUInt16LE(entry.localHeaderOffset + 26);
  const extraLen = buf.readUInt16LE(entry.localHeaderOffset + 28);
  const dataStart = entry.localHeaderOffset + 30 + nameLen + extraLen;
  const data = buf.subarray(dataStart, dataStart + entry.compressedSize);

  if (entry.compressionMethod === 0) return Buffer.from(data);
  if (entry.compressionMethod === 8) return zlib.inflateRawSync(data);
  throw new Error(
    `ZIP: unsupported compression method ${entry.compressionMethod} for "${entry.name}"`,
  );
}

/**
 * Convenience for the single-file case: decompress the only entry, or the only
 * entry whose name matches `predicate`.
 */
export function readSingleZipEntry(
  buf: Buffer,
  predicate?: (name: string) => boolean,
): { name: string; content: Buffer } {
  const all = listZipEntries(buf);
  const candidates = predicate ? all.filter((e) => predicate(e.name)) : all;
  if (candidates.length === 0) {
    throw new Error(
      `ZIP: no matching entry (archive holds: ${all.map((e) => e.name).join(', ') || 'nothing'})`,
    );
  }
  if (candidates.length > 1) {
    throw new Error(`ZIP: expected one entry, found ${candidates.length}: ${candidates.map((e) => e.name).join(', ')}`);
  }
  return { name: candidates[0].name, content: readZipEntry(buf, candidates[0]) };
}
