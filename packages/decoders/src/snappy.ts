// Clean room from Google's Snappy compressed format description, 2011-10-05.
import { fault, rangeError } from '../../shared/errors.js';

/** Raw Snappy blocks, as used by Parquet. */
export interface SnappyOptions {
  /** Default 268435456 bytes. Checked before allocating. */
  readonly maxOutputSize?: number;
  readonly signal?: AbortSignal;
}
/** Decode a raw block, including its varint uncompressed-size prefix. */
export function decodeSnappy(input: Uint8Array, options: SnappyOptions = {}): Uint8Array {
  options.signal?.throwIfAborted();
  const limit = options.maxOutputSize ?? 268435456;
  if (!Number.isSafeInteger(limit) || limit < 0) throw rangeError('Snappy maxOutputSize must be a nonnegative safe integer; pass a byte limit', 'gltf-decoders');
  const bad = (): never => { throw fault('failed', 'Malformed or truncated Snappy block; supply a complete valid raw block', 'gltf-decoders'); };
  let at = 0, length = 0, shift = 0;
  for (;;) {
    if (at >= input.length || shift > 28) bad();
    const b = input[at++]; if (shift === 28 && b > 15) bad(); length += (b & 127) * 2 ** shift;
    if (!(b & 128)) break; shift += 7;
  }
  if (length > limit) throw rangeError(`Snappy decoded size ${length} exceeds maxOutputSize ${limit}; increase the limit or partition the source`, 'gltf-decoders');
  const out = new Uint8Array(length); let written = 0;
  const little = (bytes: number) => {
    if (at + bytes > input.length) bad(); let v = 0;
    for (let i = 0; i < bytes; i++) v += input[at++] * 2 ** (8 * i); return v;
  };
  while (at < input.length) {
    options.signal?.throwIfAborted();
    const tag = input[at++], kind = tag & 3;
    if (!kind) {
      let n = (tag >>> 2) + 1;
      if (n > 60) n = little(n - 60) + 1;
      if (at + n > input.length || written + n > out.length) bad();
      out.set(input.subarray(at, at + n), written); at += n; written += n;
    } else {
      const n = kind === 1 ? 4 + ((tag >>> 2) & 7) : 1 + (tag >>> 2);
      const offset = kind === 1 ? ((tag & 224) << 3) + little(1) : little(kind === 2 ? 2 : 4);
      if (!offset || offset > written || written + n > out.length) bad();
      for (let i = 0; i < n; i++) { out[written] = out[written - offset]; written++; }
    }
  }
  if (written !== out.length) bad(); return out;
}

/** Compression identifiers in columnar file formats. */
export type ColumnarCodec = 'none' | 'snappy' | 'gzip' | 'brotli' | 'zstd' | 'lz4' | 'lz4-frame';
/** Size-bounded, lazily loaded codecs for Arrow and Parquet pages. */
export async function decodeColumnarBlock(codec: ColumnarCodec, input: Uint8Array, size: number, options: SnappyOptions = {}): Promise<Uint8Array> {
  options.signal?.throwIfAborted();
  const limit = options.maxOutputSize ?? 268435456;
  if (!Number.isSafeInteger(size) || size < 0 || size > limit) throw rangeError('Columnar block exceeds its decoded size limit; pass a valid size and adequate maxOutputSize', 'gltf-decoders');
  let output: Uint8Array;
  switch (codec) {
    case 'none': output = input; break;
    case 'snappy': output = decodeSnappy(input, { ...options, maxOutputSize: size }); break;
    case 'zstd': output = await (await import('@margoengine/decoders/zstd')).decompressZstd(input, { maxOutputSize: size, signal: options.signal }); break;
    case 'brotli': output = (await import('@margoengine/decoders/brotli')).decodeBrotli(input, { maxBytes: size }); break;
    case 'lz4': output = (await import('@margoengine/decoders/lz4')).decodeLZ4Block(input, size, options); break;
    case 'lz4-frame': output = await (await import('@margoengine/decoders/lz4')).decodeLZ4(input, { ...options, maxOutputSize: size }); break;
    case 'gzip': {
      const reader = new Blob([input as Uint8Array<ArrayBuffer>]).stream().pipeThrough(new DecompressionStream('gzip')).getReader();
      output = new Uint8Array(size); let at = 0;
      try {
        for (;;) {
          options.signal?.throwIfAborted(); const { value, done } = await reader.read(); if (done) break;
          if (at + value.length > size) throw rangeError('Gzip columnar block exceeds its declared size; supply the correct decoded size', 'gltf-decoders');
          output.set(value, at); at += value.length;
        }
        if (at !== size) throw fault('failed', 'Gzip columnar block has the wrong decoded size; supply a complete block and correct decoded size', 'gltf-decoders');
      } finally { await reader.cancel(); reader.releaseLock(); }
      break;
    }
    default: throw fault('unsupported', `Unknown columnar codec ${String(codec)}; use a supported ColumnarCodec`, 'gltf-decoders');
  }
  options.signal?.throwIfAborted();
  if (output.length !== size) throw fault('failed', 'Columnar block has the wrong decoded size; supply a complete block and correct decoded size', 'gltf-decoders');
  return output;
}
