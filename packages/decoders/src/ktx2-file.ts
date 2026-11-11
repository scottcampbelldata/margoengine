// The KTX 2.0 header and level index (KTX 2.0 specification, section 3), read without the transcoder. Worker jobs check
// a file with it before Basis sees the bytes; the native, streaming and GPU paths read levels from it.

import { decodeFailed } from './errors.js';

/** One entry of a KTX2 level index: where a mip level's bytes sit in the file. */
export interface KTX2Level {
  offset: number;
  /** Bytes stored in the file. */
  length: number;
  /** Bytes after supercompression is undone. */
  uncompressedLength: number;
}

/** The fields of a KTX2 header and its level index. `levels[0]` is the largest mip. */
export interface KTX2Index {
  /** 0 for Basis Universal payloads, otherwise the Vulkan format of the stored texels. */
  vkFormat: number;
  width: number;
  height: number;
  /** 0 for 1D and 2D textures. */
  depth: number;
  /** 0 when the file is not an array. */
  layerCount: number;
  faceCount: number;
  /** 0 none, 1 BasisLZ, 2 Zstandard, 3 zlib. */
  supercompression: number;
  dfd: { offset: number; length: number };
  keyValues: { offset: number; length: number };
  globalData: { offset: number; length: number };
  levels: KTX2Level[];
}

/** VK_FORMAT_ASTC_4x4_SFLOAT_BLOCK, the vkFormat of UASTC HDR 4x4 files. */
export const ASTC_4X4_SFLOAT = 1000066000;

const IDENTIFIER = [0xab, 0x4b, 0x54, 0x58, 0x20, 0x32, 0x30, 0xbb, 0x0d, 0x0a, 0x1a, 0x0a];

/**
 * Reads and checks the KTX 2.0 header and level index: the level count fits the size, and every byte range the index
 * declares (levels, DFD, key/value data, supercompression global data) lies inside the file. `bytes` may be the head of
 * a longer file when `fileLength` says how long the file is.
 *
 * @throws TypeError `KTX2: invalid file (...)` on a truncated or corrupted file.
 */
export function readKTX2Index(bytes: Uint8Array, fileLength = bytes.length): KTX2Index {
  const fail = (what: string): never => {
    throw new TypeError(`KTX2: invalid file (${what}); pass an unmodified .ktx2 file`);
  };
  if (bytes.length < 80) fail('truncated header');
  if (IDENTIFIER.some((b, i) => bytes[i] !== b)) fail('not KTX 2.0');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength),
    u32 = (at: number) => view.getUint32(at, true),
    // 64-bit offsets and lengths: a high word means past 4 GiB, outside any file this can be given.
    u64 = (at: number) => (u32(at + 4) ? Number.POSITIVE_INFINITY : u32(at)),
    inside = (offset: number, length: number) => offset + length <= fileLength;
  const count = Math.max(1, u32(40)),
    size = Math.max(u32(20), u32(24), 1);
  if (count > 1 + Math.floor(Math.log2(size))) fail('level count');
  if (80 + count * 24 > bytes.length) fail('truncated level index');
  const levels: KTX2Level[] = [];
  for (let i = 0, at = 80; i < count; i++, at += 24) {
    if (!inside(u64(at), u64(at + 8))) fail(`level ${i} out of bounds`);
    levels.push({ offset: u64(at), length: u64(at + 8), uncompressedLength: u64(at + 16) });
  }
  // Zstandard-supercompressed levels (UASTC) inflate to the level's 16-byte 4x4 blocks: a larger declared size made the
  // transcoder read past its buffer (a Wasm trap, or stale memory read as texels).
  if (u32(44) === 2 && (!u32(12) || u32(12) === ASTC_4X4_SFLOAT))
    for (let i = 0; i < count; i++) {
      const blocks =
        Math.ceil(Math.max(1, u32(20) >> i) / 4) *
        Math.ceil(Math.max(1, u32(24) >> i) / 4) *
        Math.max(1, u32(28) >> i) *
        Math.max(1, u32(32)) *
        u32(36);
      if (levels[i].uncompressedLength > blocks * 16) fail(`level ${i} size`);
    }
  if (!inside(u32(48), u32(52)) || !inside(u32(56), u32(60)) || !inside(u64(64), u64(72))) fail('index out of bounds');
  return {
    vkFormat: u32(12),
    width: u32(20),
    height: u32(24),
    depth: u32(28),
    layerCount: u32(32),
    faceCount: u32(36),
    supercompression: u32(44),
    dfd: { offset: u32(48), length: u32(52) },
    keyValues: { offset: u32(56), length: u32(60) },
    globalData: { offset: u64(64), length: u64(72) },
    levels,
  };
}

/** A level's bytes with zlib or Zstandard undone; the code for either loads on first use. */
export async function levelData(bytes: Uint8Array, index: KTX2Index, level: number, signal?: AbortSignal): Promise<Uint8Array> {
  const { offset, length, uncompressedLength } = index.levels[level],
    stored = bytes.subarray(offset, offset + length);
  if (index.supercompression === 0) return stored;
  if (index.supercompression === 3) {
    const { inflateZlib } = await import('./ktx2-inflate.js');
    // The declared size is the file's word: grow toward it as the stream really inflates, rather than allocate it up
    // front (a 2 KB file declaring 4 GiB failed with an uncoded allocation error), then hold the stream to it.
    const data = inflateZlib(stored, { limit: uncompressedLength, limitHint: 'the level is larger than its declared size' });
    if (data.length !== uncompressedLength)
      throw decodeFailed(`KTX2: level ${level} inflates to ${data.length} bytes, not the ${uncompressedLength} it declares`);
    return data;
  }
  if (index.supercompression === 2) {
    const { decompressZstd } = await import('../../shared/zstd.js');
    return decompressZstd(stored, { signal, maxOutputSize: uncompressedLength });
  }
  throw decodeFailed(`KTX2: supercompression scheme ${index.supercompression} on a vkFormat file; re-encode the file`);
}
