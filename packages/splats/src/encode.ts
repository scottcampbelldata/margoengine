// SPZ and SOG writers, so an edited capture ships small. Written from the same public format descriptions the readers
// follow (Niantic Spatial's SPZ documentation; PlayCanvas's SOG versions 2/3 documentation) and the ZIP format
// description (PKWARE APPNOTE, stored entries), with the shared ISO 3309 CRC-32; no other implementation was read.
// Both start from the stored Gaussian attributes (`attributesFromSplats`: axis scales and rotation by
// eigen-decomposition, display colour), so what the readers decode is the cloud up to each format's quantisation.
import type { SplatData } from './data.js';
import { attributesFromSplats } from './ply.js';
import { crc32 } from '../../shared/crc32.js';
import { encodeWebpLossless } from './webp.js';

/** Options for {@link encodeSpz}. */
export interface EncodeSpzOptions {
  /**
   * Fractional bits of the 24-bit fixed-point positions (the step is 2^-bits). Default: the most that fit the cloud's
   * largest coordinate, up to 16 (12, the format's usual value, holds coordinates to 2,048).
   */
  fractionalBits?: number;
  /** Sets the header's antialiased flag (bit 0 of byte 14), for clouds trained with an anti-aliasing filter. */
  antialiased?: boolean;
}

const DEGREE: Record<number, number> = { 0: 0, 3: 1, 8: 2, 15: 3 };

/**
 * Encodes a cloud as an SPZ file (version 3: a gzip stream of a 16-byte header and the attributes), which `parseSpz`
 * and SPZ version 3 readers decode. Positions are 24-bit fixed point, opacity, colour and log scale one byte each,
 * rotations the smallest-three 10-bit packing and spherical harmonics one signed byte per coefficient.
 * @throws RangeError when `data` fails `validateSplats`, a coordinate does not fit 24-bit fixed point at the chosen
 * fractional bits, or `fractionalBits` is not 0 to 23; MargoError `'unsupported'` without `CompressionStream`.
 * @example
 * const bytes = await encodeSpz(await cloud.read());
 */
export async function encodeSpz(data: SplatData, options: EncodeSpzOptions = {}): Promise<Uint8Array<ArrayBuffer>> {
  const raw = attributesFromSplats(data),
    n = raw.count,
    rest = raw.rest ? raw.rest.length / n : 0;
  if (rest > 45 || raw.alphas.some((a) => a > 1))
    throw new RangeError('SPZ v3 stores SH through degree 3 and opacity through 1; use SOG for this cloud');
  let largest = 0;
  for (const v of raw.positions) largest = Math.max(largest, Math.abs(v));
  const limit = 2 ** 23 - 1,
    bits = options.fractionalBits ?? Math.max(0, Math.min(16, Math.floor(Math.log2(limit / Math.max(largest, 1e-30)))));
  if (!Number.isInteger(bits) || bits < 0 || bits > 23)
    throw new RangeError('SPZ fractionalBits must be an integer from 0 to 23; pass a smaller value');
  if (Math.round(largest * 2 ** bits) > limit)
    throw new RangeError(
      `A coordinate of ${largest} does not fit SPZ positions at ${bits} fractional bits; use fewer bits`,
    );
  const body = new Uint8Array(16 + n * (9 + 1 + 3 + 3 + 4 + rest)),
    view = new DataView(body.buffer),
    byte = (v: number) => Math.min(255, Math.max(0, Math.round(v)));
  view.setUint32(0, 0x5053474e, true);
  view.setUint32(4, 3, true);
  view.setUint32(8, n, true);
  body[12] = DEGREE[rest / 3];
  body[13] = bits;
  body[14] = options.antialiased ? 1 : 0;
  const alphaAt = 16 + n * 9,
    colorAt = alphaAt + n,
    scaleAt = colorAt + n * 3,
    rotationAt = scaleAt + n * 3,
    shAt = rotationAt + n * 4;
  for (let i = 0; i < n; i++) {
    for (let a = 0; a < 3; a++) {
      const fixed = Math.round(raw.positions[i * 3 + a] * 2 ** bits) & 0xffffff,
        p = 16 + i * 9 + a * 3;
      body[p] = fixed & 255;
      body[p + 1] = (fixed >> 8) & 255;
      body[p + 2] = fixed >> 16;
      body[colorAt + i * 3 + a] = byte((raw.dc[i * 3 + a] * 0.15 + 0.5) * 255);
      body[scaleAt + i * 3 + a] = byte((raw.logScales[i * 3 + a] + 10) * 16);
    }
    body[alphaAt + i] = byte(raw.alphas[i] * 255);
    view.setUint32(rotationAt + i * 4, smallestThree(raw.rotations, i), true);
    for (let k = 0; k < rest; k++) body[shAt + i * rest + k] = byte(raw.rest![i * rest + k] * 128 + 128);
  }
  return compress(body);
}

/**
 * The SPZ rotation word: bits 31-30 name the largest of (x, y, z, w), made positive; the other three follow as 10-bit
 * sign and magnitude (of sqrt(1/2)), the highest-index component in the lowest bits.
 */
function smallestThree(rotations: Float32Array, i: number): number {
  const [w, x, y, z] = rotations.subarray(i * 4, i * 4 + 4),
    length = Math.hypot(w, x, y, z),
    q = [x / length, y / length, z / length, w / length];
  let largest = 0;
  for (let k = 1; k < 4; k++) if (Math.abs(q[k]) > Math.abs(q[largest])) largest = k;
  const sign = q[largest] < 0 ? -1 : 1;
  let packed = 0;
  for (let k = 0; k < 4; k++) {
    if (k === largest) continue;
    const v = q[k] * sign,
      magnitude = Math.min(511, Math.round((Math.abs(v) / Math.SQRT1_2) * 511));
    packed = (packed << 10) | ((v < 0 ? 1 : 0) << 9) | magnitude;
  }
  return ((largest << 30) | packed) >>> 0;
}

async function compress(bytes: Uint8Array): Promise<Uint8Array<ArrayBuffer>> {
  if (typeof CompressionStream === 'undefined') {
    const { MargoError } = await import('@margoengine/math/errors');
    throw new MargoError('unsupported', 'This runtime has no CompressionStream; use a current browser or Node 18+.');
  }
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new CompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/**
 * A 256-entry codebook for `values` and the nearest entry of each value: each distinct value (up to float rounding)
 * its own entry when there are at most 256, else 1D k-means started at the quantiles. Entries are increasing.
 */
export function codebook(values: Float32Array): { book: number[]; index: Uint8Array } {
  const sorted = Float32Array.from(values).sort(),
    m = sorted.length,
    // Values that differ only by float rounding (a cloud decoded from a codebook format) form one group; when the
    // groups fit, each gets its own entry, so a re-encoded SOG keeps its values instead of merging rare ones.
    groups: number[] = [];
  for (let i = 0, start = 0; i < m; i++)
    if (i === m - 1 || sorted[i + 1] - sorted[start] > 1e-6 * Math.max(Math.abs(sorted[start]), 1e-3)) {
      if (groups.length > 256) break;
      let sum = 0;
      for (let k = start; k <= i; k++) sum += sorted[k];
      groups.push(sum / (i - start + 1));
      start = i + 1;
    }
  const exact = groups.length <= 256,
    book = exact
      ? Array.from({ length: 256 }, (_, k) => groups[Math.min(k, groups.length - 1)])
      : Array.from({ length: 256 }, (_, k) => sorted[Math.min(m - 1, Math.floor(((k + 0.5) * m) / 256))]);
  // Lloyd's iterations over the sorted values: each value goes to its nearest entry; each entry moves to its mean.
  for (let round = 0; round < (exact ? 0 : 8); round++) {
    const sum = new Float64Array(256),
      count = new Uint32Array(256);
    for (let i = 0, k = 0; i < m; i++) {
      while (k < 255 && sorted[i] - book[k] > book[k + 1] - sorted[i]) k++;
      sum[k] += sorted[i];
      count[k]++;
    }
    for (let k = 0; k < 256; k++) if (count[k]) book[k] = sum[k] / count[k];
    book.sort((a, b) => a - b);
  }
  const index = new Uint8Array(values.length);
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    let lo = 0,
      hi = 255;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (book[mid] <= v) lo = mid;
      else hi = mid - 1;
    }
    index[i] = lo < 255 && book[lo + 1] - v < v - book[lo] ? lo + 1 : lo;
  }
  return { book: book.map((v) => Math.fround(v)), index };
}

/**
 * Encodes a cloud as a bundled SOG scene (a ZIP of `meta.json` and lossless WebP textures), which
 * `parseSog` decodes. Version 3 is selected for degree 4 or opacity above 1; otherwise version 2. Positions are 16-bit after a log transform within the cloud's bounds;
 * log scales and base colours are 256-entry codebooks; rotations are the smallest-three in bytes; opacity is a byte;
 * spherical harmonic bands are a palette of up to 65,536 entries (each splat's own when the cloud has at most that
 * many, else groups along the bands' principal axis) quantised with a 256-entry codebook.
 * @throws RangeError when `data` fails `validateSplats`.
 * @example
 * const bytes = await encodeSog(await cloud.read());
 */
export async function encodeSog(data: SplatData): Promise<Uint8Array<ArrayBuffer>> {
  const raw = attributesFromSplats(data),
    n = raw.count,
    v3 = (raw.rest?.length ?? 0) / n === 72 || raw.alphas.some((a) => a > 1),
    width = Math.ceil(Math.sqrt(n)),
    height = Math.ceil(n / width),
    texture = () => new Uint8Array(width * height * 4).fill(255),
    low = texture(),
    high = texture(),
    scales = texture(),
    quats = texture(),
    sh0 = texture(),
    mins = [Infinity, Infinity, Infinity],
    maxs = [-Infinity, -Infinity, -Infinity],
    logged = raw.positions.map((v) => Math.sign(v) * Math.log(Math.abs(v) + 1));
  for (let i = 0; i < n * 3; i++) {
    mins[i % 3] = Math.min(mins[i % 3], logged[i]);
    maxs[i % 3] = Math.max(maxs[i % 3], logged[i]);
  }
  const scaleBook = codebook(raw.logScales),
    dcBook = codebook(raw.dc);
  for (let i = 0; i < n; i++) {
    const p = i * 4;
    for (let a = 0; a < 3; a++) {
      const span = maxs[a] - mins[a],
        q = span > 0 ? Math.round(((logged[i * 3 + a] - mins[a]) / span) * 65535) : 0;
      low[p + a] = q & 255;
      high[p + a] = q >> 8;
      scales[p + a] = scaleBook.index[i * 3 + a];
      sh0[p + a] = dcBook.index[i * 3 + a];
    }
    sh0[p + 3] = v3 ? Math.round(204 * Math.sqrt(raw.alphas[i])) : Math.round(raw.alphas[i] * 255);
    // (w, x, y, z): the largest made positive and omitted (mode 252 + its index), the other three in order.
    const q = raw.rotations.subarray(i * 4, i * 4 + 4),
      length = Math.hypot(q[0], q[1], q[2], q[3]);
    if (v3) {
      const sign = q[0] < 0 ? -1 : 1,
        magnitude = Math.hypot(q[1], q[2], q[3]),
        k = magnitude > 1e-10 ? (((2 / Math.PI) * Math.atan2(magnitude, q[0] * sign)) / magnitude) * sign : 0;
      low[p + 3] = Math.round(q[1] * k * 127 + 128);
      high[p + 3] = Math.round(q[2] * k * 127 + 128);
      scales[p + 3] = Math.round(q[3] * k * 127 + 128);
      continue;
    }
    let mode = 0;
    for (let k = 1; k < 4; k++) if (Math.abs(q[k]) > Math.abs(q[mode])) mode = k;
    const sign = q[mode] < 0 ? -1 : 1;
    for (let k = 0, at = 0; k < 4; k++)
      if (k !== mode) quats[p + at++] = Math.round(((q[k] * sign) / length / Math.SQRT1_2 + 1) * 127.5);
    quats[p + 3] = 252 + mode;
  }
  const meta: Record<string, unknown> = {
      version: v3 ? 3 : 2,
      count: n,
      means: { mins, maxs, files: ['means_l.webp', 'means_u.webp'] },
      scales: { codebook: scaleBook.book, files: ['scales.webp'] },
      ...(!v3 ? { quats: { files: ['quats.webp'] } } : {}),
      ...(v3 ? { opacity: { max: raw.alphas.reduce((a, b) => Math.max(a, b), 0) } } : {}),
      sh0: { codebook: dcBook.book, files: ['sh0.webp'] },
    },
    files: Array<[string, Uint8Array]> = [
      ['means_l.webp', encodeWebpLossless(low, width, height)],
      ['means_u.webp', encodeWebpLossless(high, width, height)],
      ['scales.webp', encodeWebpLossless(scales, width, height)],
      ['sh0.webp', encodeWebpLossless(sh0, width, height)],
    ];
  if (!v3) files.push(['quats.webp', encodeWebpLossless(quats, width, height)]);
  if (raw.rest) {
    const coefficients = raw.rest.length / n / 3,
      { centroids, labels, count } = palette(raw.rest, n, coefficients * 3),
      book = codebook(centroids),
      rows = Math.ceil(count / 64),
      table = new Uint8Array(64 * coefficients * rows * 4).fill(255),
      labelTexture = texture();
    for (let e = 0; e < count; e++)
      for (let c = 0; c < coefficients; c++)
        for (let ch = 0; ch < 3; ch++)
          table[((e >> 6) * 64 * coefficients + (e & 63) * coefficients + c) * 4 + ch] =
            book.index[(e * coefficients + c) * 3 + ch];
    for (let i = 0; i < n; i++) {
      labelTexture[i * 4] = labels[i] & 255;
      labelTexture[i * 4 + 1] = labels[i] >> 8;
      labelTexture[i * 4 + 2] = 0;
    }
    meta.shN = {
      count,
      bands: coefficients === 24 ? 4 : DEGREE[coefficients],
      codebook: book.book,
      files: ['shN_centroids.webp', 'shN_labels.webp'],
    };
    files.push(['shN_centroids.webp', encodeWebpLossless(table, 64 * coefficients, rows)]);
    files.push(['shN_labels.webp', encodeWebpLossless(labelTexture, width, height)]);
  }
  files.unshift(['meta.json', new TextEncoder().encode(JSON.stringify(meta))]);
  return zip(files);
}

/**
 * Up to 65,536 palette entries of `size` floats for the SH bands of `n` splats, and each splat's entry: the splat's
 * own bands when `n` fits, else the means of 65,536 equal groups of splats ordered along the bands' principal axis
 * (power iteration on the covariance of the bands).
 */
function palette(
  rest: Float32Array,
  n: number,
  size: number,
): { centroids: Float32Array; labels: Uint16Array; count: number } {
  const labels = new Uint16Array(n);
  if (n <= 65536) {
    for (let i = 0; i < n; i++) labels[i] = i;
    return { centroids: rest, labels, count: n };
  }
  const mean = new Float64Array(size);
  for (let i = 0; i < n; i++) for (let k = 0; k < size; k++) mean[k] += rest[i * size + k] / n;
  let axis = new Float64Array(size).fill(1 / Math.sqrt(size));
  for (let round = 0; round < 8; round++) {
    const next = new Float64Array(size);
    for (let i = 0; i < n; i++) {
      let t = 0;
      for (let k = 0; k < size; k++) t += (rest[i * size + k] - mean[k]) * axis[k];
      for (let k = 0; k < size; k++) next[k] += t * (rest[i * size + k] - mean[k]);
    }
    const length = Math.hypot(...next) || 1;
    axis = next.map((v) => v / length);
  }
  const key = new Float32Array(n);
  for (let i = 0; i < n; i++) for (let k = 0; k < size; k++) key[i] += rest[i * size + k] * axis[k];
  const order = Uint32Array.from({ length: n }, (_, i) => i).sort((a, b) => key[a] - key[b]),
    count = 65536,
    centroids = new Float32Array(count * size),
    members = new Uint32Array(count);
  for (let r = 0; r < n; r++) {
    const i = order[r],
      e = Math.floor((r * count) / n);
    labels[i] = e;
    members[e]++;
    for (let k = 0; k < size; k++) centroids[e * size + k] += rest[i * size + k];
  }
  for (let e = 0; e < count; e++) for (let k = 0; k < size; k++) centroids[e * size + k] /= members[e] || 1;
  return { centroids, labels, count };
}

/** A ZIP archive of stored entries (the WebP textures are compressed already). */
function zip(files: Array<[string, Uint8Array]>): Uint8Array<ArrayBuffer> {
  const encoder = new TextEncoder(),
    names = files.map(([name]) => encoder.encode(name)),
    size = files.reduce((s, [, d], i) => s + 30 + names[i].length + d.length + 46 + names[i].length, 22),
    out = new Uint8Array(size),
    view = new DataView(out.buffer),
    offsets: number[] = [],
    crcs: number[] = [];
  let at = 0;
  files.forEach(([, data], i) => {
    crcs.push(crc32(data));
    offsets.push(at);
    view.setUint32(at, 0x04034b50, true);
    view.setUint16(at + 4, 20, true);
    view.setUint32(at + 14, crcs[i], true);
    view.setUint32(at + 18, data.length, true);
    view.setUint32(at + 22, data.length, true);
    view.setUint16(at + 26, names[i].length, true);
    out.set(names[i], at + 30);
    out.set(data, at + 30 + names[i].length);
    at += 30 + names[i].length + data.length;
  });
  const directory = at;
  files.forEach(([, data], i) => {
    view.setUint32(at, 0x02014b50, true);
    view.setUint16(at + 4, 20, true);
    view.setUint16(at + 6, 20, true);
    view.setUint32(at + 16, crcs[i], true);
    view.setUint32(at + 20, data.length, true);
    view.setUint32(at + 24, data.length, true);
    view.setUint16(at + 28, names[i].length, true);
    view.setUint32(at + 42, offsets[i], true);
    out.set(names[i], at + 46);
    at += 46 + names[i].length;
  });
  view.setUint32(at, 0x06054b50, true);
  view.setUint16(at + 8, files.length, true);
  view.setUint16(at + 10, files.length, true);
  view.setUint32(at + 12, at - directory, true);
  view.setUint32(at + 16, directory, true);
  return out;
}
