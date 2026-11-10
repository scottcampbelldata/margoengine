/// <reference lib="esnext.disposable" preserve="true" />
import type { EngineKernel } from '@margoengine/core';
import { Splats } from './index.js';
import { parseSplat, type SplatData } from './data.js';
import { parsePly } from './ply.js';
import { decodeSpzBody } from './spz.js';

/** Byte source with backpressure. A response's body can be passed directly. */
export type SplatByteStream = ReadableStream<Uint8Array> | AsyncIterable<Uint8Array>;
/** Streaming decoder options. */
export interface ProgressiveSplatOptions {
  /** Container, required because raw splat records have no magic. */
  format: 'ply' | 'splat' | 'spz';
  /** Maximum records per emitted batch. Default 16,384. */
  batchSize?: number;
  /** Required for raw splat; PLY and SPZ read their count from the header. */
  count?: number;
  /** Cancels pending reads, decompression and upload. */
  signal?: AbortSignal;
}
/** A drawable batch. SPZ's final batch replaces its base-colour preview with full SH. */
export interface ProgressiveSplatBatch {
  /** Pool offset to replace. */
  first: number;
  /** Total capture count from its header or options. */
  total: number;
  /** Largest opacity-weighted covariance volume first within this available batch. */
  data: SplatData;
}

// Amortized linear appends, not a concatenation of the whole capture at every network packet.
class Bytes {
  bytes = new Uint8Array(4096);
  length = 0;
  append(chunk: Uint8Array) {
    if (!(chunk instanceof Uint8Array)) throw new TypeError('Stream chunks must be Uint8Array; pass response.body');
    if (this.length + chunk.length > this.bytes.length) {
      const next = new Uint8Array(Math.max(this.length + chunk.length, this.bytes.length * 2));
      next.set(this.bytes.subarray(0, this.length));
      this.bytes = next;
    }
    this.bytes.set(chunk, this.length);
    this.length += chunk.length;
  }
  get view() {
    return this.bytes.subarray(0, this.length);
  }
}

async function* chunks(source: SplatByteStream, signal?: AbortSignal): AsyncGenerator<Uint8Array> {
  signal?.throwIfAborted();
  if (source instanceof ReadableStream) {
    const reader = source.getReader();
    const abort = () => {
      void reader.cancel(signal?.reason);
    };
    signal?.addEventListener('abort', abort, { once: true });
    let ended = false;
    try {
      for (;;) {
        const next = await reader.read();
        signal?.throwIfAborted();
        if (next.done) {
          ended = true;
          break;
        }
        yield next.value;
      }
    } finally {
      signal?.removeEventListener('abort', abort);
      if (!ended) await reader.cancel();
      reader.releaseLock();
    }
  } else {
    for await (const chunk of source) {
      signal?.throwIfAborted();
      yield chunk;
    }
  }
}

/** Reorders available records by opacity-weighted volume, retaining all attributes and stable ties. */
function coarse(data: SplatData): SplatData {
  const n = data.positions.length / 3,
    c = data.covariances;
  const score = (i: number) => {
    const a = i * 6;
    return (
      data.colors[i * 4 + 3] *
      Math.sqrt(
        Math.max(
          0,
          c[a] * (c[a + 3] * c[a + 5] - c[a + 4] ** 2) -
            c[a + 1] * (c[a + 1] * c[a + 5] - c[a + 2] * c[a + 4]) +
            c[a + 2] * (c[a + 1] * c[a + 4] - c[a + 2] * c[a + 3]),
        ),
      )
    );
  };
  const scores = Array.from({ length: n }, (_, i) => score(i));
  const order = Array.from({ length: n }, (_, i) => i).sort((a, b) => scores[b] - scores[a]);
  const copy = (array: Float32Array, width: number) => {
    const out = new Float32Array(array.length);
    for (let i = 0; i < n; i++) out.set(array.subarray(order[i] * width, (order[i] + 1) * width), i * width);
    return out;
  };
  return {
    positions: copy(data.positions, 3),
    covariances: copy(c, 6),
    colors: copy(data.colors, 4),
    ...(data.sphericalHarmonics
      ? { sphericalHarmonics: copy(data.sphericalHarmonics, data.sphericalHarmonics.length / n) }
      : {}),
  };
}

async function* spzBytes(source: SplatByteStream, signal?: AbortSignal): AsyncGenerator<Uint8Array> {
  const iterator = chunks(source, signal)[Symbol.asyncIterator]();
  const prefix = new Bytes();
  try {
    while (prefix.length < 2) {
      const next = await iterator.next();
      if (next.done) throw new RangeError('SPZ header is truncated; download the complete file');
      prefix.append(next.value);
    }
    if (prefix.bytes[0] === 31 && prefix.bytes[1] === 139) {
      let initial = true;
      const stream = new ReadableStream<BufferSource>({
        async pull(controller) {
          if (initial) {
            initial = false;
            controller.enqueue(prefix.view.slice());
            return;
          }
          const next = await iterator.next();
          if (next.done) controller.close();
          else controller.enqueue(next.value.slice());
        },
        async cancel() {
          await iterator.return?.(undefined);
        },
      }).pipeThrough(new DecompressionStream('gzip'));
      yield* chunks(stream, signal);
      return;
    }
    const fill = async (size: number) => {
      while (prefix.length < size) {
        const next = await iterator.next();
        if (next.done) throw new RangeError('SPZ attribute is truncated; download the complete file');
        prefix.append(next.value);
      }
    };
    await fill(32);
    const v = () => new DataView(prefix.bytes.buffer);
    if (v().getUint32(0, true) !== 0x5053474e || v().getUint32(4, true) !== 4)
      throw new RangeError('Unknown SPZ header; export SPZ version 2, 3 or 4');
    const streams = prefix.bytes[15],
      toc = v().getUint32(16, true),
      n = v().getUint32(8, true),
      degree = prefix.bytes[12];
    if (toc < 32 || toc > 65536 || n < 1 || n > 3_000_000 || degree > 3 || streams < (degree ? 6 : 5))
      throw new RangeError('Invalid SPZ table of contents; check the capture header');
    await fill(toc + streams * 16);
    yield prefix.bytes.slice(0, 16);
    const expected = [n * 9, n, n * 3, n * 3, n * 4, n * [0, 9, 24, 45][degree]];
    let at = toc + streams * 16;
    const { decompressZstd } = await import('../../shared/zstd.js');
    for (let i = 0; i < streams; i++) {
      const size = Number(v().getBigUint64(toc + i * 16, true)),
        out = Number(v().getBigUint64(toc + i * 16 + 8, true));
      if (
        !Number.isSafeInteger(size) ||
        size < 1 ||
        size > 1_000_000_000 ||
        (i < (degree ? 6 : 5) && out !== expected[i])
      )
        throw new RangeError('Invalid SPZ stream size; check the capture table of contents');
      await fill(at + size);
      if (i < (degree ? 6 : 5)) {
        const decoded = await decompressZstd(prefix.bytes.subarray(at, at + size), {
          signal,
          maxOutputSize: out,
          maxWindowSize: Math.max(out, 1 << 27),
        });
        if (decoded.length !== out) throw new RangeError('SPZ attribute size differs from its header; check the file');
        yield decoded;
      }
      at += size;
    }
  } finally {
    await iterator.return?.(undefined);
  }
}

/**
 * Decodes and yields complete records as bytes arrive. Sorting is coarse first among currently available records;
 * records not received cannot be prioritised without a server-side ordering. SPZ previews start as soon as their
 * rotation records arrive, before SH and the gzip trailer; final replacement restores full SH precision.
 */
export async function* readSplatsProgressive(
  source: SplatByteStream,
  options: ProgressiveSplatOptions,
): AsyncGenerator<ProgressiveSplatBatch> {
  const { format, signal } = options,
    batch = options.batchSize ?? 16384;
  if (!Number.isInteger(batch) || batch < 1) throw new RangeError('batchSize must be a positive integer; use 16384');
  if (!['ply', 'splat', 'spz'].includes(format)) throw new RangeError('Choose ply, splat or spz as the stream format');
  let total = options.count ?? 0,
    emitted = 0,
    header = '',
    body = 0,
    stride = 32,
    ascii = false,
    coefficients = 0,
    width = 0,
    finished = false;
  const bytes = new Bytes();
  const input = format === 'spz' ? spzBytes(source, signal) : chunks(source, signal);
  async function* ending() {
    yield* input;
    finished = true;
    yield new Uint8Array(0);
  }
  for await (const chunk of ending()) {
    signal?.throwIfAborted();
    bytes.append(chunk);
    if (format === 'ply' && !header) {
      const text = new TextDecoder().decode(bytes.view.subarray(0, 65536));
      const end =
        text.indexOf('end_header\n') >= 0
          ? text.indexOf('end_header\n') + 11
          : text.indexOf('end_header\r\n') >= 0
            ? text.indexOf('end_header\r\n') + 12
            : 0;
      if (!end) {
        if (bytes.length >= 65536) throw new RangeError('PLY header exceeds 64 KiB; check the file');
        continue;
      }
      header = text.slice(0, end);
      body = end;
      total = Number(/element vertex (\d+)/.exec(header)?.[1]);
      ascii = header.includes('format ascii ');
      if (!ascii && !header.includes('format binary_little_endian '))
        throw new RangeError('Choose little-endian or ASCII Gaussian PLY for streaming');
      const sizes: Record<string, number> = {
        char: 1,
        uchar: 1,
        int8: 1,
        uint8: 1,
        short: 2,
        ushort: 2,
        int16: 2,
        uint16: 2,
        int: 4,
        uint: 4,
        int32: 4,
        uint32: 4,
        float: 4,
        float32: 4,
        double: 8,
        float64: 8,
      };
      let vertex = false;
      stride = 0;
      for (const line of header.split(/\r?\n/)) {
        const w = line.split(/\s+/);
        if (w[0] === 'element') {
          vertex = w[1] === 'vertex';
          if (!vertex)
            throw new RangeError('Stream standard vertex-only Gaussian PLY; use the formats reader for packed files');
        }
        if (vertex && w[0] === 'property') {
          if (!sizes[w[1]]) throw new RangeError('Use scalar PLY properties for streaming');
          stride += sizes[w[1]];
          width++;
        }
      }
    }
    if (format === 'spz') {
      if (bytes.length < 16) continue;
      const v = new DataView(bytes.bytes.buffer),
        version = v.getUint32(4, true);
      total = v.getUint32(8, true);
      coefficients = [0, 4, 9, 16][bytes.bytes[12]];
      if (![2, 3, 4].includes(version) || coefficients === undefined)
        throw new RangeError('Use SPZ version 2 to 4 with SH degree 0 to 3');
      stride = version === 2 ? 3 : 4;
      body = 16 + total * 16; // positions, alpha, dc, scales precede rotations.
    }
    if (!Number.isInteger(total) || total < 1 || total > 3_000_000)
      throw new RangeError('Set a capture count of 1 to 3,000,000 splats');
    const asciiText = ascii ? new TextDecoder().decode(bytes.view.subarray(body)) : '';
    const asciiValues = asciiText.trim() ? asciiText.trim().split(/\s+/) : [];
    if (ascii && !finished && !/\s$/.test(asciiText)) asciiValues.pop();
    const available = Math.min(
      total,
      ascii ? Math.floor(asciiValues.length / width) : Math.max(0, Math.floor((bytes.length - body) / stride)),
    );
    while (emitted < available) {
      const n = Math.min(batch, available - emitted);
      let data: SplatData;
      if (format === 'spz') {
        const compact = new Uint8Array(16 + n * (16 + stride));
        compact.set(bytes.view.subarray(0, 16));
        new DataView(compact.buffer).setUint32(8, n, true);
        compact[12] = 0;
        let from = 16,
          to = 16;
        for (const width of [9, 1, 3, 3, stride]) {
          compact.set(bytes.view.subarray(from + emitted * width, from + (emitted + n) * width), to);
          from += total * width;
          to += n * width;
        }
        data = decodeSpzBody(compact, bytes.bytes[4] === 4 ? 4 : 3);
        if (coefficients) {
          data.sphericalHarmonics = new Float32Array(n * coefficients * 3);
          for (let i = 0; i < n; i++)
            for (let c = 0; c < 3; c++)
              data.sphericalHarmonics[i * coefficients * 3 + c] = (data.colors[i * 4 + c] - 0.5) / 0.2820947918;
        }
      } else if (format === 'splat') data = parseSplat(bytes.view.subarray(emitted * 32, (emitted + n) * 32));
      else {
        const h = new TextEncoder().encode(header.replace(/element vertex \d+/, `element vertex ${n}`));
        const b = ascii
          ? new TextEncoder().encode(asciiValues.slice(emitted * width, (emitted + n) * width).join(' '))
          : bytes.view.subarray(body + emitted * stride, body + (emitted + n) * stride);
        const file = new Uint8Array(h.length + b.length);
        file.set(h);
        file.set(b, h.length);
        data = parsePly(file);
      }
      yield { first: emitted, total, data: coarse(data) };
      emitted += n;
    }
  }
  signal?.throwIfAborted();
  if (format === 'spz') {
    const data = decodeSpzBody(bytes.view, bytes.bytes[4] === 4 ? 4 : 3);
    yield { first: 0, total, data: coarse(data) };
  } else if (emitted !== total || (!ascii && bytes.length !== body + total * stride)) {
    throw new RangeError('Splat stream is truncated or has extra records; check its declared count');
  }
}

/**
 * Uploads batches to a reserved cloud. Call engine.start() before awaiting this function to see streaming frames.
 * The returned cloud remains attached; on failure the incomplete cloud is disposed. No callback or global state.
 */
export async function loadProgressiveSplats(
  engine: EngineKernel,
  source: SplatByteStream,
  options: ProgressiveSplatOptions,
): Promise<Splats> {
  let cloud: Splats | undefined;
  try {
    for await (const packet of readSplatsProgressive(source, options)) {
      if (!cloud) {
        cloud = Splats.reserve(
          packet.total,
          packet.data.sphericalHarmonics ? packet.data.sphericalHarmonics.length / packet.data.positions.length : 0,
        );
        engine.use(cloud);
      }
      cloud.write(packet.first, packet.data);
    }
    if (!cloud) throw new RangeError('The stream contains no splats; check the capture');
    return cloud;
  } catch (error) {
    cloud?.dispose();
    throw error;
  }
}
