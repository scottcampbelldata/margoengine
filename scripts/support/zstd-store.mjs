// A Zstandard frame writer for tests on a Node whose node:zlib has no Zstandard (22.12, KB-NODE22-TESTS1): the input
// is stored in Raw_Blocks, so nothing is compressed, and every Zstandard decoder reads the frame. Written clean room
// from RFC 8878 (Y. Collet, M. Kucherawy, 2021, https://www.rfc-editor.org/rfc/rfc8878; 3.1.1 frames, 3.1.1.2
// blocks) and the xxHash specification (Y. Collet, XXH64, https://github.com/Cyan4973/xxHash/blob/dev/doc/xxhash_spec.md).
// A test of Huffman, FSE or match decoding needs compressed blocks: it takes a checked-in stream (zstdFixture in
// node-compat.mjs), never this writer.

/** The advanced parameters the writer reads, with zstd's own numbers (zlib.constants.ZSTD_c_* where Node has them). */
export const ZSTD_PARAMS = Object.freeze({
  ZSTD_c_compressionLevel: 100,
  ZSTD_c_windowLog: 101,
  ZSTD_c_contentSizeFlag: 200,
  ZSTD_c_checksumFlag: 201,
});

const MAX_BLOCK = 1 << 17,
  MASK = (1n << 64n) - 1n,
  P1 = 11400714785074694791n,
  P2 = 14029467366897019727n,
  P3 = 1609587929392839161n,
  P4 = 9650029242287828579n,
  P5 = 2870177450012600261n;
const rotl = (x, r) => ((x << r) | (x >> (64n - r))) & MASK;
const round = (acc, lane) => (rotl((acc + lane * P2) & MASK, 31n) * P1) & MASK;

/** XXH64 of `bytes` with seed 0, as a BigInt. */
export function xxh64(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength),
    length = bytes.length;
  let at = 0,
    h = P5;
  if (length >= 32) {
    const v = [(P1 + P2) & MASK, P2, 0n, (MASK + 1n - P1) & MASK];
    for (; at + 32 <= length; at += 32)
      for (let lane = 0; lane < 4; lane++) v[lane] = round(v[lane], view.getBigUint64(at + lane * 8, true));
    h = (rotl(v[0], 1n) + rotl(v[1], 7n) + rotl(v[2], 12n) + rotl(v[3], 18n)) & MASK;
    for (const lane of v) h = (((h ^ round(0n, lane)) * P1) & MASK) + P4;
  }
  h = (h + BigInt(length)) & MASK;
  for (; at + 8 <= length; at += 8) h = (rotl(h ^ round(0n, view.getBigUint64(at, true)), 27n) * P1 + P4) & MASK;
  if (at + 4 <= length) {
    h = (rotl(h ^ ((BigInt(view.getUint32(at, true)) * P1) & MASK), 23n) * P2 + P3) & MASK;
    at += 4;
  }
  for (; at < length; at++) h = (rotl(h ^ ((BigInt(bytes[at]) * P5) & MASK), 11n) * P1) & MASK;
  h = ((h ^ (h >> 33n)) * P2) & MASK;
  h = ((h ^ (h >> 29n)) * P3) & MASK;
  return h ^ (h >> 32n);
}

/**
 * One Zstandard frame that stores `input` (bytes or a string), with the call shape of zlib.zstdCompressSync.
 * `options.params` reads ZSTD_c_contentSizeFlag (default 1: the frame states its content size), ZSTD_c_checksumFlag
 * (default 0; 1 appends the XXH64 content checksum) and ZSTD_c_windowLog (10 to 31; default none, which gives a
 * single-segment frame when the content size is stated and a 128 KiB window otherwise). ZSTD_c_compressionLevel is
 * accepted and changes nothing. Blocks hold at most 128 KiB, or the window where that is smaller.
 * @throws TypeError for any other parameter, RangeError for a window log outside 10 to 31
 */
export function zstdStoreSync(input, options = {}) {
  const bytes = typeof input === 'string' ? Buffer.from(input) : toBytes(input),
    { params = {} } = options,
    known = new Set(Object.values(ZSTD_PARAMS).map(String));
  for (const key of Object.keys(params))
    if (!known.has(key))
      throw new TypeError(
        `The stored Zstandard writer has no parameter ${key}; use a checked-in stream (zstdFixture).`,
      );
  const sized = (params[ZSTD_PARAMS.ZSTD_c_contentSizeFlag] ?? 1) !== 0,
    checksum = (params[ZSTD_PARAMS.ZSTD_c_checksumFlag] ?? 0) !== 0,
    asked = params[ZSTD_PARAMS.ZSTD_c_windowLog] || undefined;
  if (asked !== undefined && !(Number.isInteger(asked) && asked >= 10 && asked <= 31))
    throw new RangeError(`ZSTD_c_windowLog must be a whole number from 10 to 31; got ${asked}.`);
  const single = sized && asked === undefined,
    windowLog = asked ?? 17,
    length = bytes.length;
  // Frame_Content_Size field: 1 byte (single segment only), 2 bytes holding size - 256, 4 bytes or 8 bytes.
  const field = !sized ? -1 : single && length < 256 ? 0 : single && length < 65792 ? 1 : length < 2 ** 32 ? 2 : 3;
  const header = [0x28, 0xb5, 0x2f, 0xfd, (Math.max(field, 0) << 6) | (single ? 0x20 : 0) | (checksum ? 4 : 0)];
  if (!single) header.push((windowLog - 10) << 3);
  if (field === 0) header.push(length);
  else if (field === 1) header.push((length - 256) & 255, (length - 256) >> 8);
  else if (field >= 2)
    for (let i = 0, n = BigInt(length); i < (field === 2 ? 4 : 8); i++, n >>= 8n) header.push(Number(n & 255n));
  const blockMax = Math.min(MAX_BLOCK, 2 ** windowLog),
    blocks = Math.max(1, Math.ceil(length / blockMax)),
    out = Buffer.alloc(header.length + blocks * 3 + length + (checksum ? 4 : 0));
  out.set(header);
  let to = header.length;
  for (let block = 0, at = 0; block < blocks; block++) {
    const size = Math.min(blockMax, length - at);
    // Block_Header, little-endian: Last_Block (1 bit), Block_Type (2 bits, 0 = Raw_Block), Block_Size (21 bits).
    to = out.writeUIntLE((size << 3) | (block === blocks - 1 ? 1 : 0), to, 3);
    out.set(bytes.subarray(at, at + size), to);
    to += size;
    at += size;
  }
  if (checksum) out.writeUInt32LE(Number(xxh64(bytes) & 0xffffffffn), to);
  return out;
}

function toBytes(input) {
  if (ArrayBuffer.isView(input)) return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  if (input instanceof ArrayBuffer) return new Uint8Array(input);
  throw new TypeError('Expected the data to store as a string, an ArrayBuffer or a view of one');
}
