// More output formats. JPEG is written from ITU T.81 (baseline sequential, the Annex K tables) and JFIF; WebP from the
// RIFF container and the WebP Lossless Bitstream Specification. OpenEXR writing is @margoengine/environment's encoder,
// loaded on first use. Runs anywhere, with no node: imports.
import type { Engine } from '@margoengine/core';
import { engineRuntime } from '@margoengine/core/extension';
import type { HeadlessPixels, HeadlessReadOptions } from './index.js';
import { fault, rangeError, typeError } from '../../shared/errors.js';

function checkPixels({ width, height, data }: HeadlessPixels): void {
  if (data?.length !== width * height * 4) throw rangeError('Frame data does not match its size', 'headless');
}

// JPEG

/** Options of {@link encodeJPEG}. */
export interface JPEGOptions {
  /** 1 to 100. Default 90. */
  quality?: number;
  /** Colour resolution: `'420'` halves it each way, `'444'` keeps it all, for sharp coloured edges. Default `'420'`. */
  subsampling?: '420' | '444';
  /** JPEG has no alpha, so transparent pixels are laid over this RGB colour, 0 to 255. Default white. */
  background?: readonly [number, number, number];
}

const LUMA_QUANT = [
    16, 11, 10, 16, 24, 40, 51, 61, 12, 12, 14, 19, 26, 58, 60, 55, 14, 13, 16, 24, 40, 57, 69, 56, 14, 17, 22, 29, 51, 87,
    80, 62, 18, 22, 37, 56, 68, 109, 103, 77, 24, 35, 55, 64, 81, 104, 113, 92, 49, 64, 78, 87, 103, 121, 120, 101, 72, 92,
    95, 98, 112, 100, 103, 99,
  ],
  CHROMA_QUANT = [
    17, 18, 24, 47, 99, 99, 99, 99, 18, 21, 26, 66, 99, 99, 99, 99, 24, 26, 56, 99, 99, 99, 99, 99, 47, 66, 99, 99, 99, 99,
    99, 99, ...new Array<number>(32).fill(99),
  ],
  ZIGZAG = [
    0, 1, 8, 16, 9, 2, 3, 10, 17, 24, 32, 25, 18, 11, 4, 5, 12, 19, 26, 33, 40, 48, 41, 34, 27, 20, 13, 6, 7, 14, 21, 28, 35,
    42, 49, 56, 57, 50, 43, 36, 29, 22, 15, 23, 30, 37, 44, 51, 58, 59, 52, 45, 38, 31, 39, 46, 53, 60, 61, 54, 47, 55, 62,
    63,
  ],
  DC_VALUES = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
  DC_LUMA_BITS = [0, 1, 5, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0],
  DC_CHROMA_BITS = [0, 3, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0],
  AC_LUMA_BITS = [0, 2, 1, 3, 3, 2, 4, 3, 5, 5, 4, 4, 0, 0, 1, 0x7d],
  AC_CHROMA_BITS = [0, 2, 1, 2, 4, 4, 3, 4, 7, 5, 4, 4, 0, 1, 2, 0x77],
  hex = (text: string) => text.match(/../g)!.map((pair) => parseInt(pair, 16)),
  AC_LUMA_VALUES = hex(
    '0102030004110512213141061351610722711432819' +
      '1a1082342b1c11552d1f02433627282090a161718191a25262728292a3435363738393a434445464748494a' +
      '535455565758595a636465666768696a737475767778797a838485868788898a92939495969798999aa2a3' +
      'a4a5a6a7a8a9aab2b3b4b5b6b7b8b9bac2c3c4c5c6c7c8c9cad2d3d4d5d6d7d8d9dae1e2e3e4e5e6e7e8e9' +
      'eaf1f2f3f4f5f6f7f8f9fa',
  ),
  AC_CHROMA_VALUES = hex(
    '0001020311040521310612415107617113223281081442' +
      '91a1b1c109233352f0156272d10a162434e125f11718191a262728292a35363738393a434445464748494a' +
      '535455565758595a636465666768696a737475767778797a82838485868788898a92939495969798999aa2' +
      'a3a4a5a6a7a8a9aab2b3b4b5b6b7b8b9bac2c3c4c5c6c7c8c9cad2d3d4d5d6d7d8d9dae2e3e4e5e6e7e8e9' +
      'eaf2f3f4f5f6f7f8f9fa',
  );

/** Symbol to `[code, length]`, from a table's counts per length (T.81 Annex C). */
function huffmanCodes(bits: readonly number[], values: readonly number[]): [number, number][] {
  const codes: [number, number][] = [];
  let code = 0,
    at = 0;
  bits.forEach((count, i) => {
    for (let n = 0; n < count; n++) codes[values[at++]] = [code++, i + 1];
    code <<= 1;
  });
  return codes;
}

/** Bits, most significant first, with the 0 stuffed after each 0xff byte that T.81 asks for. */
class JPEGBits {
  bytes = new Uint8Array(1 << 16);
  length = 0;
  #buffer = 0;
  #count = 0;
  #push(byte: number): void {
    if (this.length === this.bytes.length) {
      const grown = new Uint8Array(this.bytes.length * 2);
      grown.set(this.bytes);
      this.bytes = grown;
    }
    this.bytes[this.length++] = byte;
  }
  write(value: number, size: number): void {
    for (let i = size - 1; i >= 0; i--) {
      this.#buffer = (this.#buffer << 1) | ((value >> i) & 1);
      if (++this.#count === 8) {
        this.#push(this.#buffer);
        if (this.#buffer === 0xff) this.#push(0);
        this.#buffer = 0;
        this.#count = 0;
      }
    }
  }
  /** Pads the last byte with ones. */
  finish(): void {
    while (this.#count) this.write(1, 1);
  }
}

const COSINES = new Float64Array(64);
for (let u = 0; u < 8; u++)
  for (let x = 0; x < 8; x++)
    COSINES[u * 8 + x] = (u ? 0.5 : Math.SQRT1_2 / 2) * Math.cos(((2 * x + 1) * u * Math.PI) / 16);

/** The 8 x 8 forward DCT, as two passes of the same matrix. */
function forwardDCT(block: Float64Array, scratch: Float64Array, out: Float64Array): void {
  for (let y = 0; y < 8; y++)
    for (let u = 0; u < 8; u++) {
      let sum = 0;
      for (let x = 0; x < 8; x++) sum += block[y * 8 + x] * COSINES[u * 8 + x];
      scratch[y * 8 + u] = sum;
    }
  for (let v = 0; v < 8; v++)
    for (let u = 0; u < 8; u++) {
      let sum = 0;
      for (let y = 0; y < 8; y++) sum += scratch[y * 8 + u] * COSINES[v * 8 + y];
      out[v * 8 + u] = sum;
    }
}

/** The bit count of a coefficient's magnitude, its T.81 category. */
const category = (value: number): number => (value ? 32 - Math.clz32(Math.abs(value)) : 0);

/** RGBA pixels as a baseline JPEG file. */
export function encodeJPEG(pixels: HeadlessPixels, options: JPEGOptions = {}): Uint8Array {
  const { quality = 90, subsampling = '420', background = [255, 255, 255] } = options;
  checkPixels(pixels);
  const { width, height, data } = pixels;
  if (!(quality >= 1 && quality <= 100)) throw rangeError('Invalid JPEG quality', 'headless');
  if (subsampling !== '420' && subsampling !== '444') throw typeError('JPEG subsampling: 420 or 444', 'headless');
  if (width > 65535 || height > 65535) throw rangeError('Image too large for this format', 'headless');
  // The scaling of the Annex K tables that JPEG tools share, so `quality` means what users expect.
  const scale = quality < 50 ? 5000 / quality : 200 - quality * 2,
    quantize = (table: readonly number[]) =>
      table.map((value) => Math.min(255, Math.max(1, Math.floor((value * scale + 50) / 100)))),
    lumaTable = quantize(LUMA_QUANT),
    chromaTable = quantize(CHROMA_QUANT),
    plane = width * height,
    luma = new Float32Array(plane),
    blue = new Float32Array(plane),
    red = new Float32Array(plane);
  for (let i = 0; i < plane; i++) {
    const alpha = data[i * 4 + 3] / 255,
      r = data[i * 4] * alpha + background[0] * (1 - alpha),
      g = data[i * 4 + 1] * alpha + background[1] * (1 - alpha),
      b = data[i * 4 + 2] * alpha + background[2] * (1 - alpha);
    // The JFIF matrix (full-range BT.601), level shifted by 128 for the DCT.
    luma[i] = 0.299 * r + 0.587 * g + 0.114 * b - 128;
    blue[i] = -0.168736 * r - 0.331264 * g + 0.5 * b;
    red[i] = 0.5 * r - 0.418688 * g - 0.081312 * b;
  }
  const out = new JPEGBits(),
    span = subsampling === '420' ? 2 : 1,
    tables = {
      luma: [huffmanCodes(DC_LUMA_BITS, DC_VALUES), huffmanCodes(AC_LUMA_BITS, AC_LUMA_VALUES)],
      chroma: [huffmanCodes(DC_CHROMA_BITS, DC_VALUES), huffmanCodes(AC_CHROMA_BITS, AC_CHROMA_VALUES)],
    },
    block = new Float64Array(64),
    scratch = new Float64Array(64),
    frequency = new Float64Array(64),
    previous = [0, 0, 0];

  /** Samples one block, averaging `step` x `step` pixels each and repeating the last row and column at the edges. */
  const load = (source: Float32Array, left: number, top: number, step: number) => {
    for (let y = 0; y < 8; y++)
      for (let x = 0; x < 8; x++) {
        let sum = 0;
        for (let dy = 0; dy < step; dy++) {
          const row = Math.min(height - 1, top + y * step + dy) * width;
          for (let dx = 0; dx < step; dx++) sum += source[row + Math.min(width - 1, left + x * step + dx)];
        }
        block[y * 8 + x] = sum / (step * step);
      }
  };
  const encodeBlock = (component: number, table: readonly number[], [dc, ac]: [number, number][][]) => {
    forwardDCT(block, scratch, frequency);
    const first = Math.round(frequency[0] / table[0]),
      delta = first - previous[component],
      size = category(delta);
    previous[component] = first;
    out.write(dc[size][0], dc[size][1]);
    if (size) out.write(delta < 0 ? delta + (1 << size) - 1 : delta, size);
    let zeros = 0;
    for (let k = 1; k < 64; k++) {
      const at = ZIGZAG[k],
        value = Math.round(frequency[at] / table[at]);
      if (!value) {
        zeros++;
        continue;
      }
      for (; zeros > 15; zeros -= 16) out.write(ac[0xf0][0], ac[0xf0][1]);
      const bits = category(value),
        symbol = ac[(zeros << 4) | bits];
      out.write(symbol[0], symbol[1]);
      out.write(value < 0 ? value + (1 << bits) - 1 : value, bits);
      zeros = 0;
    }
    if (zeros) out.write(ac[0][0], ac[0][1]);
  };
  const unit = 8 * span;
  for (let top = 0; top < height; top += unit)
    for (let left = 0; left < width; left += unit) {
      for (let y = 0; y < span; y++)
        for (let x = 0; x < span; x++) {
          load(luma, left + x * 8, top + y * 8, 1);
          encodeBlock(0, lumaTable, tables.luma);
        }
      load(blue, left, top, span);
      encodeBlock(1, chromaTable, tables.chroma);
      load(red, left, top, span);
      encodeBlock(2, chromaTable, tables.chroma);
    }
  out.finish();

  const segment = (marker: number, ...body: number[]) => [
      0xff,
      marker,
      (body.length + 2) >> 8,
      (body.length + 2) & 255,
      ...body,
    ],
    zigzagged = (table: readonly number[]) => ZIGZAG.map((at) => table[at]),
    head = [
      0xff,
      0xd8,
      ...segment(0xe0, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0), // JFIF 1.1, square pixels
      ...segment(0xdb, 0, ...zigzagged(lumaTable), 1, ...zigzagged(chromaTable)),
      ...segment(
        0xc0,
        8,
        height >> 8,
        height & 255,
        width >> 8,
        width & 255,
        3,
        1,
        (span << 4) | span,
        0,
        2,
        0x11,
        1,
        3,
        0x11,
        1,
      ),
      ...segment(
        0xc4,
        0x00,
        ...DC_LUMA_BITS,
        ...DC_VALUES,
        0x10,
        ...AC_LUMA_BITS,
        ...AC_LUMA_VALUES,
        0x01,
        ...DC_CHROMA_BITS,
        ...DC_VALUES,
        0x11,
        ...AC_CHROMA_BITS,
        ...AC_CHROMA_VALUES,
      ),
      ...segment(0xda, 3, 1, 0x00, 2, 0x11, 3, 0x11, 0, 63, 0),
    ],
    file = new Uint8Array(head.length + out.length + 2);
  file.set(head);
  file.set(out.bytes.subarray(0, out.length), head.length);
  file.set([0xff, 0xd9], head.length + out.length);
  return file;
}

// WebP

/** Options of {@link encodeWebP}. */
export interface WebPOptions {
  /** Unset: lossless, the same pixels back, anywhere. Set, 0 to 1: lossy, through the runtime's own encoder, which needs
   * `OffscreenCanvas` and WebP support, so a browser or worker. Default unset. */
  quality?: number;
}

/** Bits, least significant first, as VP8L stores them. */
class WebPBits {
  bytes = new Uint8Array(1 << 16);
  length = 0;
  #buffer = 0;
  #count = 0;
  /** Up to 24 bits. */
  write(value: number, size: number): void {
    this.#buffer |= value << this.#count;
    this.#count += size;
    while (this.#count >= 8) {
      if (this.length === this.bytes.length) {
        const grown = new Uint8Array(this.bytes.length * 2);
        grown.set(this.bytes);
        this.bytes = grown;
      }
      this.bytes[this.length++] = this.#buffer & 255;
      this.#buffer >>>= 8;
      this.#count -= 8;
    }
  }
  finish(): void {
    if (this.#count) this.write(0, 8 - this.#count);
  }
}

/** Code lengths for symbol counts, none over `limit`. When a tree runs too deep, rare counts are raised and it is rebuilt. */
function codeLengths(counts: ArrayLike<number>, limit: number): Uint8Array {
  const lengths = new Uint8Array(counts.length);
  for (let floor = 1; ; floor *= 2) {
    type Node = { weight: number; symbol: number; left?: Node; right?: Node };
    const queue: Node[] = [];
    for (let symbol = 0; symbol < counts.length; symbol++)
      if (counts[symbol]) queue.push({ weight: Math.max(counts[symbol], floor), symbol });
    queue.sort((a, b) => a.weight - b.weight);
    // Two sorted lines: the leaves, and the joined nodes, which come out in weight order.
    const joined: Node[] = [];
    let leaf = 0,
      node = 0;
    const next = () =>
      leaf < queue.length && (node >= joined.length || queue[leaf].weight <= joined[node].weight)
        ? queue[leaf++]
        : joined[node++];
    while (queue.length - leaf + joined.length - node > 1) {
      const left = next(),
        right = next();
      joined.push({ weight: left.weight + right.weight, symbol: -1, left, right });
    }
    const root = joined.at(-1);
    let deepest = 0;
    lengths.fill(0);
    const walk = (item: Node, depth: number) => {
      if (item.left) {
        walk(item.left, depth + 1);
        walk(item.right!, depth + 1);
      } else {
        lengths[item.symbol] = depth;
        if (depth > deepest) deepest = depth;
      }
    };
    if (root) walk(root, 0);
    if (deepest <= limit) return lengths;
  }
}

/** Canonical codes for lengths, bit-reversed because VP8L reads codes from the first bit of the stream. */
function canonicalCodes(lengths: Uint8Array): Uint16Array {
  const perLength = new Uint16Array(17),
    start = new Uint16Array(17),
    codes = new Uint16Array(lengths.length);
  for (const length of lengths) perLength[length]++;
  perLength[0] = 0;
  for (let length = 1; length <= 15; length++) start[length + 1] = (start[length] + perLength[length]) << 1;
  lengths.forEach((length, symbol) => {
    if (!length) return;
    let code = start[length]++,
      reversed = 0;
    for (let i = 0; i < length; i++, code >>= 1) reversed = (reversed << 1) | (code & 1);
    codes[symbol] = reversed;
  });
  return codes;
}

const LENGTH_CODE_ORDER = [17, 18, 0, 1, 2, 3, 4, 5, 16, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
  MOST_MATCH = 4096,
  MOST_DISTANCE = (1 << 20) - 121,
  LENGTH_SYMBOLS = 24,
  DISTANCE_SYMBOLS = 40,
  DISTANCE_OFFSET = 120, // Codes up to here name nearby pixels; a plain distance is coded above them.
  MIN_MATCH = 3,
  HASH_BITS = 16,
  PREDICTOR_BITS = 4;

/** Writes one prefix code's lengths and gives back its codes. */
function writePrefixCode(out: WebPBits, counts: Uint32Array): { lengths: Uint8Array; codes: Uint16Array } {
  const used: number[] = [];
  for (let symbol = 0; symbol < counts.length && used.length < 2; symbol++) if (counts[symbol]) used.push(symbol);
  if (used.length < 2) {
    // A simple code of one symbol costs nothing per use, and a normal code cannot have fewer than two.
    const symbol = used[0] ?? 0;
    out.write(1, 1);
    out.write(0, 1);
    out.write(symbol < 2 ? 0 : 1, 1);
    out.write(symbol, symbol < 2 ? 1 : 8);
    return { lengths: new Uint8Array(counts.length), codes: new Uint16Array(counts.length) };
  }
  const lengths = codeLengths(counts, 15),
    tokens: [number, number, number][] = []; // Symbol, extra bits value, extra bits size
  for (let i = 0; i < lengths.length; ) {
    let run = 1;
    if (lengths[i] === 0) {
      while (i + run < lengths.length && lengths[i + run] === 0 && run < 138) run++;
      if (run >= 11) tokens.push([18, run - 11, 7]);
      else if (run >= 3) tokens.push([17, run - 3, 3]);
      else {
        run = 1;
        tokens.push([0, 0, 0]);
      }
    } else tokens.push([lengths[i], 0, 0]);
    i += run;
  }
  const tally = new Uint32Array(19);
  for (const [symbol] of tokens) tally[symbol]++;
  // The code-length code must also have two symbols, so a lone one gets a partner it never uses.
  if (tally.filter(Boolean).length < 2) tally[tally[0] ? 1 : 0] = 1;
  const small = codeLengths(tally, 7),
    smallCodes = canonicalCodes(small);
  let count = 19;
  while (count > 4 && !small[LENGTH_CODE_ORDER[count - 1]]) count--;
  out.write(0, 1);
  out.write(count - 4, 4);
  for (let i = 0; i < count; i++) out.write(small[LENGTH_CODE_ORDER[i]], 3);
  out.write(0, 1); // Lengths for every symbol follow
  for (const [symbol, extra, size] of tokens) {
    out.write(smallCodes[symbol], small[symbol]);
    if (size) out.write(extra, size);
  }
  return { lengths, codes: canonicalCodes(lengths) };
}

/** A length or distance as VP8L's prefix symbol and extra bits. */
function prefix(value: number): [number, number, number] {
  const v = value - 1;
  if (v < 4) return [v, 0, 0];
  const top = 31 - Math.clz32(v),
    extra = top - 1;
  return [2 * top + ((v >> extra) & 1), extra, v & ((1 << extra) - 1)];
}

/** LZ77 and prefix coding of ARGB pixels: one image of the stream, with no color cache. */
function writeImage(out: WebPBits, argb: Uint32Array, top: boolean): void {
  out.write(0, 1); // No color cache
  if (top) out.write(0, 1); // One group of prefix codes
  // Tokens: a pixel is its index; a match is -(length), with its distance beside it.
  const lengthsOut: number[] = [],
    distances: number[] = [],
    heads = new Int32Array(1 << HASH_BITS).fill(-1),
    hash = (i: number) => (Math.imul(argb[i] ^ Math.imul(argb[i + 1], 0x9e3779b1), 0x85ebca6b) ^ argb[i + 2]) >>> (32 - HASH_BITS),
    size = argb.length,
    remember = (i: number) => {
      if (i + 2 < size) heads[hash(i) & ((1 << HASH_BITS) - 1)] = i;
    };
  for (let i = 0; i < size; ) {
    let length = 0,
      distance = 0;
    // The pixel before, then the last place these pixels were seen: flat areas and repeats are what renders have.
    const candidates = [i - 1, i + 2 < size ? heads[hash(i) & ((1 << HASH_BITS) - 1)] : -1];
    for (const from of candidates) {
      if (from < 0 || i - from > MOST_DISTANCE) continue;
      let run = 0;
      while (run < MOST_MATCH && i + run < size && argb[from + run] === argb[i + run]) run++;
      if (run > length) {
        length = run;
        distance = i - from;
      }
    }
    if (length >= MIN_MATCH) {
      lengthsOut.push(length);
      distances.push(distance);
      for (let k = 0; k < length; k++) remember(i + k);
      i += length;
    } else {
      lengthsOut.push(0);
      distances.push(i);
      remember(i);
      i++;
    }
  }
  const green = new Uint32Array(256 + LENGTH_SYMBOLS),
    red = new Uint32Array(256),
    blue = new Uint32Array(256),
    alpha = new Uint32Array(256),
    distance = new Uint32Array(DISTANCE_SYMBOLS);
  lengthsOut.forEach((length, token) => {
    if (length) {
      green[256 + prefix(length)[0]]++;
      distance[prefix(distances[token] + DISTANCE_OFFSET)[0]]++;
    } else {
      const pixel = argb[distances[token]];
      green[(pixel >>> 8) & 255]++;
      red[(pixel >>> 16) & 255]++;
      blue[pixel & 255]++;
      alpha[pixel >>> 24]++;
    }
  });
  const g = writePrefixCode(out, green),
    r = writePrefixCode(out, red),
    b = writePrefixCode(out, blue),
    a = writePrefixCode(out, alpha),
    d = writePrefixCode(out, distance);
  lengthsOut.forEach((length, token) => {
    if (length) {
      const [symbol, extra, bits] = prefix(length),
        [where, whereExtra, whereBits] = prefix(distances[token] + DISTANCE_OFFSET);
      out.write(g.codes[256 + symbol], g.lengths[256 + symbol]);
      if (extra) out.write(bits, extra);
      out.write(d.codes[where], d.lengths[where]);
      if (whereExtra) out.write(whereBits, whereExtra);
    } else {
      const pixel = argb[distances[token]],
        gv = (pixel >>> 8) & 255,
        rv = (pixel >>> 16) & 255,
        bv = pixel & 255,
        av = pixel >>> 24;
      out.write(g.codes[gv], g.lengths[gv]);
      out.write(r.codes[rv], r.lengths[rv]);
      out.write(b.codes[bv], b.lengths[bv]);
      out.write(a.codes[av], a.lengths[av]);
    }
  });
}

const channelsMinus = (a: number, b: number): number =>
  ((((a >>> 24) - (b >>> 24)) & 255) << 24) |
  ((((a >>> 16) - (b >>> 16)) & 255) << 16) |
  ((((a >>> 8) - (b >>> 8)) & 255) << 8) |
  (((a & 255) - (b & 255)) & 255);
const average = (a: number, b: number): number =>
  (((((a >>> 24) + (b >>> 24)) >> 1) & 255) << 24) |
  (((((a >>> 16 & 255) + (b >>> 16 & 255)) >> 1) & 255) << 16) |
  (((((a >>> 8 & 255) + (b >>> 8 & 255)) >> 1) & 255) << 8) |
  (((a & 255) + (b & 255)) >> 1);

const PREDICT_LEFT = 1,
  PREDICT_TOP = 2,
  PREDICT_AVERAGE = 7;

/** Replaces pixels with their residuals, choosing a predictor per block by the smallest sum of residuals. */
function predict(argb: Uint32Array, width: number, height: number): Uint32Array {
  const block = 1 << PREDICTOR_BITS,
    across = Math.ceil(width / block),
    down = Math.ceil(height / block),
    modes = new Uint32Array(across * down),
    source = argb.slice(),
    predicted = (mode: number, x: number, y: number): number => {
      const at = y * width + x;
      if (!x && !y) return 0xff000000;
      if (!y) return source[at - 1];
      if (!x) return source[at - width];
      const left = source[at - 1],
        up = source[at - width];
      return mode === PREDICT_LEFT ? left : mode === PREDICT_TOP ? up : average(left, up);
    },
    magnitude = (value: number) => {
      const small = (lane: number) => Math.min(lane, 256 - lane);
      return small(value >>> 24) + small((value >>> 16) & 255) + small((value >>> 8) & 255) + small(value & 255);
    };
  for (let by = 0; by < down; by++)
    for (let bx = 0; bx < across; bx++) {
      const right = Math.min(width, (bx + 1) * block),
        bottom = Math.min(height, (by + 1) * block);
      let best = PREDICT_LEFT,
        lowest = Infinity;
      for (const mode of [PREDICT_LEFT, PREDICT_TOP, PREDICT_AVERAGE]) {
        let cost = 0;
        for (let y = by * block; y < bottom; y++)
          for (let x = bx * block; x < right; x++)
            cost += magnitude(channelsMinus(source[y * width + x], predicted(mode, x, y)));
        if (cost < lowest) {
          lowest = cost;
          best = mode;
        }
      }
      modes[by * across + bx] = 0xff000000 | (best << 8);
      for (let y = by * block; y < bottom; y++)
        for (let x = bx * block; x < right; x++)
          argb[y * width + x] = channelsMinus(source[y * width + x], predicted(best, x, y)) >>> 0;
    }
  return modes;
}

/** RGBA pixels as a WebP file: lossless, or lossy where the runtime has an encoder. Images are at most 16,384 wide. */
export async function encodeWebP(pixels: HeadlessPixels, { quality }: WebPOptions = {}): Promise<Uint8Array> {
  checkPixels(pixels);
  const { width, height, data } = pixels;
  if (width > 16384 || height > 16384) throw rangeError('Image too large for this format', 'headless');
  if (quality !== undefined) {
    if (!(quality >= 0 && quality <= 1)) throw rangeError('Invalid WebP quality', 'headless');
    if (typeof OffscreenCanvas !== 'function') throw fault('unsupported', 'Lossy WebP needs OffscreenCanvas', 'headless');
    const canvas = new OffscreenCanvas(width, height);
    canvas
      .getContext('2d')!
      .putImageData(new ImageData(new Uint8ClampedArray(data), width, height), 0, 0);
    const blob = await canvas.convertToBlob({ type: 'image/webp', quality });
    // A runtime with no WebP encoder quietly gives a PNG.
    if (blob.type !== 'image/webp') throw fault('unsupported', 'This runtime cannot encode lossy WebP', 'headless');
    return new Uint8Array(await blob.arrayBuffer());
  }
  const argb = new Uint32Array(width * height);
  let opaque = true;
  for (let i = 0; i < argb.length; i++) {
    const r = data[i * 4],
      g = data[i * 4 + 1],
      b = data[i * 4 + 2],
      a = data[i * 4 + 3];
    if (a !== 255) opaque = false;
    // The subtract-green transform, done as the pixels are packed.
    argb[i] = ((a << 24) | (((r - g) & 255) << 16) | (g << 8) | ((b - g) & 255)) >>> 0;
  }
  const out = new WebPBits();
  out.write(0x2f, 8);
  out.write(width - 1, 14);
  out.write(height - 1, 14);
  out.write(opaque ? 0 : 1, 1);
  out.write(0, 3);
  out.write(1, 1); // A transform follows: subtract green
  out.write(2, 2);
  out.write(1, 1); // A transform follows: predictor
  out.write(0, 2);
  out.write(PREDICTOR_BITS - 2, 3);
  const modes = predict(argb, width, height);
  writeImage(out, modes, false);
  out.write(0, 1); // No more transforms
  writeImage(out, argb, true);
  out.finish();
  const padded = out.length + (out.length & 1),
    file = new Uint8Array(20 + padded),
    view = new DataView(file.buffer),
    tag = (text: string, at: number) => file.set([...text].map((c) => c.charCodeAt(0)), at);
  tag('RIFF', 0);
  view.setUint32(4, 12 + padded, true);
  tag('WEBP', 8);
  tag('VP8L', 12);
  view.setUint32(16, out.length, true);
  file.set(out.bytes.subarray(0, out.length), 20);
  return file;
}

// OpenEXR

/** Float RGBA pixels: linear light, straight or premultiplied as their source, top row first. */
export interface HDRPixels {
  width: number;
  height: number;
  data: Float32Array;
}

/** Options of {@link encodeEXR}. */
export interface EXROptions {
  /** Bits per sample in the file: `'half'` is what compositors expect, `'float'` keeps every bit. Default `'half'`. */
  type?: 'half' | 'float';
  /** Stops the encode; the promise rejects with the signal's reason. Default none. */
  signal?: AbortSignal;
}

/** The sRGB transfer undone: 8-bit display pixels as linear light, for an EXR of a tone-mapped frame. Alpha stays linear. */
export function linearPixels({ width, height, data }: HeadlessPixels): HDRPixels {
  const table = new Float32Array(256),
    out = new Float32Array(data.length);
  for (let i = 0; i < 256; i++) {
    const value = i / 255;
    table[i] = value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  }
  for (let i = 0; i < data.length; i += 4) {
    out[i] = table[data[i]];
    out[i + 1] = table[data[i + 1]];
    out[i + 2] = table[data[i + 2]];
    out[i + 3] = data[i + 3] / 255;
  }
  return { width, height, data: out };
}

/**
 * Float RGBA pixels as an uncompressed OpenEXR file, written by `@margoengine/environment/exr-write`, an optional peer
 * loaded on first use. Rejects with `Install @margoengine/environment` when it is missing.
 */
export async function encodeEXR({ width, height, data }: HDRPixels, { type = 'half', signal }: EXROptions = {}): Promise<Uint8Array> {
  if (!(data instanceof Float32Array) || data.length !== width * height * 4)
    throw rangeError('Frame data does not match its size', 'headless');
  if (type !== 'half' && type !== 'float') throw typeError('EXR type: half or float', 'headless');
  let writer: typeof import('@margoengine/environment/exr-write');
  try {
    writer = await import('@margoengine/environment/exr-write');
  } catch (error) {
    if ((error as { code?: string }).code === 'ERR_MODULE_NOT_FOUND')
      throw Object.assign(fault('state', 'Install @margoengine/environment', 'install'), { cause: error });
    throw error;
  }
  const kind = type === 'half' ? 'HALF' : 'FLOAT',
    channel = (name: string, offset: number) => ({ name, type: kind, data, offset, stride: 4 }) as const;
  return writer.encodeEXR(
    { width, height, channels: [channel('R', 0), channel('G', 1), channel('B', 2), channel('A', 3)] },
    { signal },
  );
}

/** One binary16 value from its bits. */
function halfToFloat(bits: number): number {
  const sign = bits & 0x8000 ? -1 : 1,
    exponent = (bits >> 10) & 31,
    mantissa = bits & 1023;
  if (exponent === 0) return sign * mantissa * 2 ** -24;
  if (exponent === 31) return mantissa ? NaN : sign * Infinity;
  return sign * (1 + mantissa / 1024) * 2 ** (exponent - 15);
}

const ROW_ALIGNMENT = 256,
  MAP_READ = 1,
  BUFFER_COPY_DST = 8;

/**
 * Reads a float texture to {@link HDRPixels}: `rgba16float` or `rgba32float`, with `COPY_SRC` usage, such as
 * `stack.sceneTexture` from `@margoengine/post/stack`, which holds the frame in linear light before tone mapping.
 */
export async function readTexture(
  engine: Engine,
  texture: GPUTexture,
  { signal }: HeadlessReadOptions = {},
): Promise<HDRPixels> {
  signal?.throwIfAborted();
  const device = engineRuntime(engine).gpu;
  if (!device) throw fault('unsupported', 'readPixels needs the WebGPU backend', 'headless');
  const { format, width, height } = texture;
  if (format !== 'rgba16float' && format !== 'rgba32float')
    throw fault('unsupported', 'readTexture reads rgba16float or rgba32float only', 'headless');
  const half = format === 'rgba16float',
    stride = width * (half ? 8 : 16),
    bytesPerRow = Math.ceil(stride / ROW_ALIGNMENT) * ROW_ALIGNMENT,
    buffer = device.createBuffer({
      label: 'headless float readback',
      size: bytesPerRow * height,
      usage: MAP_READ | BUFFER_COPY_DST,
    }),
    stop = () => buffer.destroy();
  signal?.addEventListener('abort', stop, { once: true });
  try {
    const encoder = device.createCommandEncoder();
    encoder.copyTextureToBuffer({ texture }, { buffer, bytesPerRow, rowsPerImage: height }, [width, height]);
    device.queue.submit([encoder.finish()]);
    await buffer.mapAsync(MAP_READ).catch((error: unknown) => {
      signal?.throwIfAborted();
      throw error;
    });
    const mapped = buffer.getMappedRange(),
      data = new Float32Array(width * height * 4),
      row = width * 4;
    for (let y = 0; y < height; y++)
      if (half) {
        const source = new Uint16Array(mapped, y * bytesPerRow, row);
        for (let i = 0; i < row; i++) data[y * row + i] = halfToFloat(source[i]);
      } else data.set(new Float32Array(mapped, y * bytesPerRow, row), y * row);
    return { width, height, data };
  } finally {
    signal?.removeEventListener('abort', stop);
    buffer.destroy();
  }
}
