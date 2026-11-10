// Original bounded decoders from the LZ4 block and Blosc1 buffer specifications.
import { fault, rangeError } from '../../shared/errors.js';

const broken = (why: string) => rangeError(`Cloud codec: ${why}; check the compressed chunk`, 'sciviz');

// FastLZ-derived BloscLZ byte instructions: literal runs, short matches, extended lengths and far offsets.
function bloscLZ(input: Uint8Array, size: number): Uint8Array {
  const out = new Uint8Array(size);
  let p = 0,
    w = 0;
  const byte = () => {
    if (p >= input.length) throw broken('truncated BloscLZ instruction');
    return input[p++];
  };
  while (p < input.length) {
    const control = byte() & (p === 1 ? 31 : 255),
      tag = control >>> 5;
    if (!tag) {
      const n = (control & 31) + 1;
      if (p + n > input.length || w + n > size) throw broken('BloscLZ literal bounds');
      out.set(input.subarray(p, p + n), w);
      p += n;
      w += n;
    } else {
      let length = tag + 2;
      if (tag === 7) {
        let extra;
        do {
          extra = byte();
          length += extra;
          if (length > size) throw broken('BloscLZ match exceeds output');
        } while (extra === 255);
      }
      const low = byte();
      let distance = (control & 31) * 256 + low + 1;
      if (low === 255 && (control & 31) === 31) distance = byte() * 256 + byte() + 8192;
      if (distance > w || w + length > size) throw broken('BloscLZ match bounds');
      for (let k = 0; k < length; k++, w++) out[w] = out[w - distance];
    }
  }
  if (w !== size) throw broken('BloscLZ output size differs');
  return out;
}

/** Decodes a raw LZ4 block of exactly size bytes. Overlapping matches are expanded in order. */
export function decodeLZ4(input: Uint8Array, size: number): Uint8Array {
  if (!Number.isSafeInteger(size) || size < 0 || size > 2 ** 29) throw broken('invalid output bound');
  const out = new Uint8Array(size);
  let p = 0,
    w = 0;
  const extended = (base: number) => {
    if (base !== 15) return base;
    let more = 255,
      n = base;
    while (more === 255) {
      if (p === input.length) throw broken('truncated LZ4 length');
      more = input[p++];
      n += more;
      if (n > size) throw broken('LZ4 length exceeds output');
    }
    return n;
  };
  while (p < input.length) {
    const token = input[p++],
      literals = extended(token >>> 4);
    if (p + literals > input.length || w + literals > size) throw broken('LZ4 literal bounds');
    out.set(input.subarray(p, p + literals), w);
    p += literals;
    w += literals;
    if (p === input.length) break;
    if (p + 2 > input.length) throw broken('truncated LZ4 offset');
    const distance = input[p] | (input[p + 1] << 8);
    p += 2;
    const count = extended(token & 15) + 4;
    if (!distance || distance > w || w + count > size) throw broken('LZ4 match bounds');
    for (let i = 0; i < count; i++, w++) out[w] = out[w - distance];
  }
  if (w !== size) throw broken('LZ4 output length differs');
  return out;
}

async function inflate(input: Uint8Array, format: 'gzip' | 'deflate', max: number): Promise<Uint8Array> {
  const stream = new Blob([input.slice()]).stream().pipeThrough(new DecompressionStream(format));
  const reader = stream.getReader(),
    parts: Uint8Array[] = [];
  let n = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      n += part.value.length;
      if (n > max) throw broken('inflated output exceeds bound');
      parts.push(part.value);
    }
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }
  const out = new Uint8Array(n);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

/** Byte-oriented chunk codec. Zstd reuses Margo's clean-room RFC 8878 decoder lazily. */
export async function decodeCloudCodec(
  name: string,
  bytes: Uint8Array,
  maxBytes: number,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  signal?.throwIfAborted();
  let out: Uint8Array;
  if (name === 'raw' || name === 'bytes') out = bytes;
  else if (name === 'gzip' || name === 'zlib')
    out = await inflate(bytes, name === 'gzip' ? 'gzip' : 'deflate', maxBytes);
  else if (name === 'zstd') {
    const { decompressZstd } = await import('../../shared/zstd.js');
    out = await decompressZstd(bytes, { maxOutputSize: maxBytes, signal });
  } else if (name === 'lz4') {
    if (bytes.length < 4) throw broken('missing LZ4 output size');
    const n = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0, true);
    if (n > maxBytes) throw broken('LZ4 output exceeds bound');
    out = decodeLZ4(bytes.subarray(4), n);
  } else if (name === 'blosc') out = await decodeBlosc(bytes, maxBytes, signal);
  else throw fault('unsupported', `Cloud codec ${name} is not registered; select a supported codec`, 'sciviz');
  signal?.throwIfAborted();
  if (out.length > maxBytes) throw broken('decoded output exceeds bound');
  return out;
}

/** Blosc1 buffers: memcpy, split/unsplit LZ4, zlib and zstd, byte shuffle and bit shuffle. */
export async function decodeBlosc(
  input: Uint8Array,
  maxBytes = 64 * 1024 * 1024,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  if (input.length < 16) throw broken('truncated Blosc header');
  const v = new DataView(input.buffer, input.byteOffset, input.byteLength),
    flags = input[2],
    type = input[3];
  const n = v.getUint32(4, true),
    block = v.getUint32(8, true),
    packed = v.getUint32(12, true);
  if (input[0] > 2 || input[0] < 1 || (flags & 5) === 5 || flags & 8)
    throw fault(
      'unsupported',
      'Cloud Blosc requires the standard Blosc1 header and shuffle filters; transcode the chunk',
      'sciviz',
    );
  if (!type || !block || n > maxBytes || packed !== input.length || block > Math.max(n, 1))
    throw broken('invalid Blosc sizes');
  if (flags & 2) {
    if (packed !== 16 + n) throw broken('invalid Blosc memcpy length');
    return input.slice(16);
  }
  const blocks = Math.ceil(n / block),
    out = new Uint8Array(n),
    codec = flags >>> 5;
  if (16 + blocks * 4 > packed) throw broken('truncated Blosc block table');
  if (![0, 1, 3, 4].includes(codec))
    throw fault('unsupported', `Blosc compressor ${codec} is not supported; use blosclz, lz4, zlib or zstd`, 'sciviz');
  for (let b = 0; b < blocks; b++) {
    signal?.throwIfAborted();
    const length = Math.min(block, n - b * block),
      splits = flags & 16 || length !== block ? 1 : type;
    if (length % splits) throw broken('Blosc split does not divide its block');
    const scratch = new Uint8Array(length),
      part = length / splits;
    let at = v.getUint32(16 + b * 4, true);
    if (at < 16 + blocks * 4) throw broken('Blosc block overlaps its header');
    for (let s = 0; s < splits; s++) {
      if (at + 4 > packed) throw broken('truncated Blosc stream length');
      const count = v.getUint32(at, true);
      at += 4;
      if (at + count > packed) throw broken('truncated Blosc stream');
      const encoded = input.subarray(at, at + count);
      const decoded =
        count === part
          ? encoded
          : codec === 0
            ? bloscLZ(encoded, part)
            : codec === 1
              ? decodeLZ4(encoded, part)
              : await decodeCloudCodec(codec === 3 ? 'zlib' : 'zstd', encoded, part, signal);
      if (decoded.length !== part) throw broken('Blosc stream length differs');
      scratch.set(decoded, s * part);
      at += count;
    }
    const target = out.subarray(b * block, b * block + length);
    if (flags & 4 && length % (type * 8) === 0) {
      // Blosc1 bit transpose applies only when the entire block is a multiple of eight elements.
      const elements = Math.floor(length / type / 8) * 8,
        whole = elements * type;
      for (let byte = 0; byte < type; byte++)
        for (let bit = 0; bit < 8; bit++)
          for (let e = 0; e < elements; e++)
            target[e * type + byte] |=
              ((scratch[(byte * 8 + bit) * (elements / 8) + (e >>> 3)] >>> (e & 7)) & 1) << bit;
      target.set(scratch.subarray(whole), whole);
    } else if (flags & 1) {
      const elements = Math.floor(length / type),
        whole = elements * type;
      for (let byte = 0; byte < type; byte++)
        for (let e = 0; e < elements; e++) target[e * type + byte] = scratch[byte * elements + e];
      target.set(scratch.subarray(whole), whole);
    } else target.set(scratch);
  }
  return out;
}

/** CRC32C for the Zarr shard index and payload checksum codec. */
export function cloudCRC32C(input: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of input) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0x82f63b78 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
