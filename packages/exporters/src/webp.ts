// Lossless WebP encoder, written from the WebP Lossless Bitstream Specification (RFC 9649) and the WebP Container
// Specification. Images of at most 256 colours use the colour-indexing transform; others subtract green and predict.
// Pixels then go through LZ77 with a hash chain and canonical prefix codes built from their histograms. Lossy WebP is
// the browser's route: `OffscreenCanvas.convertToBlob({type: 'image/webp', quality})`.
import { checkCount, checked, type FrameSource, type Pixels } from './frames.js';
import { canonicalCodes, codeLengths } from './prefix-codes.js';

const MAX_SIDE = 16384,
  // The largest plain distance: prefix code 39 holds 2^20, and codes up to 120 are the neighbourhood table.
  MAX_DISTANCE = 1048456,
  MAX_COPY = 4096,
  MIN_COPY = 3,
  CHAIN_TRIES = 32,
  HASH_BITS = 16,
  // Blocks of 16 x 16 pixels for the predictor modes, as 2 + the 3 bits the stream stores.
  BLOCK_BITS = 4,
  CODE_LENGTH_ORDER = [17, 18, 0, 1, 2, 3, 4, 5, 16, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
  // Left, top, average of both, select, clamp-add-subtract-full: the modes that read no pixel past the current column.
  MODES = [1, 2, 7, 11, 12];

class BitWriter {
  bytes = new Uint8Array(1 << 16);
  at = 0;
  private acc = 0;
  private have = 0;
  /** Writes the low `n` (0..24) bits of `value`, least significant first. */
  put(value: number, n: number): void {
    this.acc |= value << this.have;
    this.have += n;
    if (this.at + 4 > this.bytes.length) {
      const grown = new Uint8Array(this.bytes.length * 2);
      grown.set(this.bytes);
      this.bytes = grown;
    }
    for (; this.have >= 8; this.have -= 8, this.acc >>>= 8) this.bytes[this.at++] = this.acc & 255;
  }
  finish(): Uint8Array {
    if (this.have) this.put(0, 8 - this.have);
    return this.bytes.subarray(0, this.at);
  }
}

interface Code {
  lengths: Uint8Array;
  codes: Uint16Array;
}

// Writes the code for a histogram and returns it for the pixel data.
function writeCode(out: BitWriter, counts: Uint32Array): Code {
  const used: number[] = [];
  for (let s = 0; s < counts.length; s++) if (counts[s]) used.push(s);
  if (used.length <= 2 && used.every((symbol) => symbol < 256)) {
    // A simple code: one symbol costs no bits in the data, two cost one bit each.
    const first = used[0] ?? 0,
      lengths = new Uint8Array(counts.length);
    out.put(1, 1);
    out.put(used.length === 2 ? 1 : 0, 1);
    out.put(first < 2 ? 0 : 1, 1);
    out.put(first, first < 2 ? 1 : 8);
    if (used.length === 2) {
      out.put(used[1], 8);
      lengths[first] = lengths[used[1]] = 1;
    }
    return { lengths, codes: canonicalCodes(lengths) };
  }
  const lengths = codeLengths(counts, 15),
    tokens: number[][] = [];
  let previous = 8;
  for (let s = 0; s < lengths.length; ) {
    const value = lengths[s];
    let run = 1;
    while (s + run < lengths.length && lengths[s + run] === value) run++;
    s += run;
    if (!value)
      while (run) {
        if (run < 3) {
          tokens.push([0, 0, 0]);
          run--;
        } else if (run < 11) {
          tokens.push([17, run - 3, 3]);
          run = 0;
        } else {
          const take = Math.min(run, 138);
          tokens.push([18, take - 11, 7]);
          run -= take;
        }
      }
    else {
      if (value !== previous) {
        tokens.push([value, 0, 0]);
        run--;
        previous = value;
      }
      while (run >= 3) {
        const take = Math.min(run, 6);
        tokens.push([16, take - 3, 2]);
        run -= take;
      }
      for (; run; run--) tokens.push([value, 0, 0]);
    }
  }
  const metaCounts = new Uint32Array(19);
  for (const [symbol] of tokens) metaCounts[symbol]++;
  // A code of one symbol would cost no bits; keep it a complete two-symbol code that a decoder reads plainly.
  if (metaCounts.filter(Boolean).length < 2) metaCounts[metaCounts[0] ? 1 : 0] = 1;
  const metaLengths = codeLengths(metaCounts, 7),
    metaCodes = canonicalCodes(metaLengths);
  let stored = 19;
  while (stored > 4 && !metaLengths[CODE_LENGTH_ORDER[stored - 1]]) stored--;
  out.put(0, 1);
  out.put(stored - 4, 4);
  for (let i = 0; i < stored; i++) out.put(metaLengths[CODE_LENGTH_ORDER[i]], 3);
  out.put(0, 1); // every symbol of the alphabet is listed
  for (const [symbol, extra, bits] of tokens) {
    out.put(metaCodes[symbol], metaLengths[symbol]);
    out.put(extra, bits);
  }
  return { lengths, codes: canonicalCodes(lengths) };
}

// Prefix coding of a copy length or distance >= 1, packed as code | extra bits << 6 | extra value << 12.
function prefixed(value: number): number {
  if (value <= 4) return value - 1;
  const v = value - 1,
    high = 31 - Math.clz32(v),
    extra = high - 1;
  return (2 * high + ((v >> extra) & 1)) | (extra << 6) | ((v & ((1 << extra) - 1)) * 4096);
}

// One entropy-coded image: LZ77 tokens, the five histograms, their codes, then the data.
function writeImage(out: BitWriter, argb: Uint32Array, width: number, main: boolean): void {
  out.put(0, 1); // no colour cache
  if (main) out.put(0, 1); // one group of prefix codes
  const n = argb.length,
    // Each token is a literal pixel (`distance` 0) or a copy of `value` pixels.
    values = new Uint32Array(n),
    distances = new Uint32Array(n),
    head = new Int32Array(1 << HASH_BITS).fill(-1),
    chain = new Int32Array(n),
    hash = (i: number): number =>
      Math.imul(Math.imul(argb[i], 0x1e35a7bd) ^ argb[i + 1], 0x9e3779b1) >>> (32 - HASH_BITS),
    insert = (i: number): void => {
      if (i + 1 < n) {
        const h = hash(i);
        chain[i] = head[h];
        head[h] = i;
      }
    };
  let tokens = 0;
  for (let i = 0; i < n; ) {
    const longest = Math.min(MAX_COPY, n - i);
    let best = 0,
      bestDistance = 0;
    const consider = (distance: number): void => {
      if (distance > i || distance > MAX_DISTANCE) return;
      let length = 0;
      while (length < longest && argb[i - distance + length] === argb[i + length]) length++;
      if (length > best) [best, bestDistance] = [length, distance];
    };
    // The two distances with free codes go first, so a chain match must be strictly longer to replace them.
    consider(width);
    consider(1);
    if (i + 1 < n && best < longest) {
      let candidate = head[hash(i)];
      for (let tries = CHAIN_TRIES; candidate >= 0 && tries && best < longest; tries--, candidate = chain[candidate])
        consider(i - candidate);
    }
    if (best >= MIN_COPY) {
      values[tokens] = best;
      distances[tokens++] = bestDistance;
      for (const end = i + best; i < end; i++) insert(i);
    } else {
      values[tokens++] = argb[i];
      insert(i++);
    }
  }
  const green = new Uint32Array(256 + 24),
    red = new Uint32Array(256),
    blue = new Uint32Array(256),
    alpha = new Uint32Array(256),
    distance = new Uint32Array(40),
    codeOf = (d: number): number => (d === 1 ? 2 : d === width ? 1 : d + 120);
  for (let t = 0; t < tokens; t++) {
    const value = values[t];
    if (distances[t]) {
      green[256 + (prefixed(value) & 63)]++;
      distance[prefixed(codeOf(distances[t])) & 63]++;
    } else {
      green[(value >>> 8) & 255]++;
      red[(value >>> 16) & 255]++;
      blue[value & 255]++;
      alpha[value >>> 24]++;
    }
  }
  const G = writeCode(out, green),
    R = writeCode(out, red),
    B = writeCode(out, blue),
    A = writeCode(out, alpha),
    D = writeCode(out, distance),
    symbol = (code: Code, s: number): void => out.put(code.codes[s], code.lengths[s]),
    extra = (packed: number): void => out.put(Math.floor(packed / 4096), (packed >> 6) & 31);
  for (let t = 0; t < tokens; t++) {
    const value = values[t];
    if (distances[t]) {
      const length = prefixed(value),
        far = prefixed(codeOf(distances[t]));
      symbol(G, 256 + (length & 63));
      extra(length);
      symbol(D, far & 63);
      extra(far);
    } else {
      symbol(G, (value >>> 8) & 255);
      symbol(R, (value >>> 16) & 255);
      symbol(B, value & 255);
      symbol(A, value >>> 24);
    }
  }
}

const channelwise = (a: number, b: number, f: (x: number, y: number) => number): number => {
  let out = 0;
  for (let s = 0; s < 32; s += 8) out += (f((a >>> s) & 255, (b >>> s) & 255) & 255) * 2 ** s;
  return out;
};
const subtract = (a: number, b: number): number => channelwise(a, b, (x, y) => x - y);
const average = (a: number, b: number): number => channelwise(a, b, (x, y) => (x + y) >> 1);

function predict(mode: number, argb: Uint32Array, i: number, width: number): number {
  const left = argb[i - 1],
    top = argb[i - width];
  if (mode === 1) return left;
  if (mode === 2) return top;
  if (mode === 7) return average(left, top);
  const corner = argb[i - width - 1];
  let toLeft = 0,
    toTop = 0,
    full = 0;
  for (let s = 0; s < 32; s += 8) {
    const l = (left >>> s) & 255,
      t = (top >>> s) & 255,
      p = l + t - ((corner >>> s) & 255);
    toLeft += Math.abs(p - l);
    toTop += Math.abs(p - t);
    full += Math.min(255, Math.max(0, p)) * 2 ** s;
  }
  return mode === 12 ? full : toLeft < toTop ? left : top;
}

function writePredictor(out: BitWriter, argb: Uint32Array, width: number, height: number): Uint32Array {
  const size = 1 << BLOCK_BITS,
    columns = Math.ceil(width / size),
    rows = Math.ceil(height / size),
    modes = new Uint32Array(columns * rows),
    residuals = new Uint32Array(argb.length);
  for (let row = 0; row < rows; row++)
    for (let column = 0; column < columns; column++) {
      const y0 = row * size,
        x0 = column * size;
      let chosen = MODES[0],
        lowest = Infinity;
      for (const mode of MODES) {
        let cost = 0;
        for (let y = Math.max(y0, 1); y < Math.min(y0 + size, height); y++)
          for (let x = Math.max(x0, 1); x < Math.min(x0 + size, width); x++) {
            const i = y * width + x,
              residual = subtract(argb[i], predict(mode, argb, i, width));
            for (let s = 0; s < 32; s += 8) {
              const byte = (residual >>> s) & 255;
              cost += Math.min(byte, 256 - byte);
            }
          }
        if (cost < lowest) [lowest, chosen] = [cost, mode];
      }
      modes[row * columns + column] = (0xff000000 | (chosen << 8)) >>> 0;
      for (let y = y0; y < Math.min(y0 + size, height); y++)
        for (let x = x0; x < Math.min(x0 + size, width); x++) {
          const i = y * width + x,
            // The stream's fixed rules for the first row and column; the top-left corner predicts opaque black.
            p = y ? (x ? predict(chosen, argb, i, width) : argb[i - width]) : x ? argb[i - 1] : 0xff000000;
          residuals[i] = subtract(argb[i], p);
        }
    }
  out.put(1, 1);
  out.put(0, 2);
  out.put(BLOCK_BITS - 2, 3);
  writeImage(out, modes, columns, false);
  return residuals;
}

function vp8l({ data, width, height }: Pixels): Uint8Array {
  if (width > MAX_SIDE || height > MAX_SIDE)
    throw new RangeError(`WebP image ${width}x${height} is too large; encode at most ${MAX_SIDE} pixels per side`);
  const out = new BitWriter(),
    n = width * height,
    argb = new Uint32Array(n),
    colours = new Set<number>();
  let opaque = true;
  for (let i = 0; i < n; i++) {
    const a = data[i * 4 + 3];
    if (a !== 255) opaque = false;
    argb[i] = ((a << 24) | (data[i * 4] << 16) | (data[i * 4 + 1] << 8) | data[i * 4 + 2]) >>> 0;
    if (colours.size <= 256) colours.add(argb[i]);
  }
  out.put(0x2f, 8);
  out.put(width - 1, 14);
  out.put(height - 1, 14);
  out.put(opaque ? 0 : 1, 1);
  out.put(0, 3);
  if (colours.size <= 256) {
    // Colour indexing: the table is stored as differences, the image as indices in green, packed when they are small.
    const table = [...colours].sort((a, b) => a - b),
      index = new Map(table.map((colour, i) => [colour, i])),
      deltas = Uint32Array.from(table, (colour, i) => (i ? subtract(colour, table[i - 1]) : colour)),
      count = table.length,
      shift = count <= 2 ? 3 : count <= 4 ? 2 : count <= 16 ? 1 : 0,
      bits = 8 >> shift,
      packedWidth = Math.ceil(width / (1 << shift)),
      packed = new Uint32Array(packedWidth * height).fill(0xff000000);
    for (let y = 0; y < height; y++)
      for (let x = 0; x < width; x++) {
        const at = y * packedWidth + (x >> shift);
        packed[at] = (packed[at] | (index.get(argb[y * width + x])! << (8 + (x & ((1 << shift) - 1)) * bits))) >>> 0;
      }
    out.put(1, 1);
    out.put(3, 2);
    out.put(count - 1, 8);
    writeImage(out, deltas, count, false);
    out.put(0, 1);
    writeImage(out, packed, packedWidth, true);
  } else {
    out.put(1, 1);
    out.put(2, 2);
    for (let i = 0; i < n; i++) {
      const p = argb[i],
        g = (p >>> 8) & 255;
      argb[i] = ((p & 0xff00ff00) | ((((p >>> 16) - g) & 255) << 16) | ((p - g) & 255)) >>> 0;
    }
    const residuals = writePredictor(out, argb, width, height);
    out.put(0, 1);
    writeImage(out, residuals, width, true);
  }
  return out.finish();
}

const ascii = (text: string): number[] => Array.from(text, (c) => c.charCodeAt(0));
const uint24 = (value: number): number[] => [value & 255, (value >> 8) & 255, value >> 16];
const uint32 = (value: number): number[] => [value & 255, (value >> 8) & 255, (value >> 16) & 255, value >>> 24];

// A RIFF chunk, padded to an even size; the padding is not counted in its length.
function chunk(tag: string, ...bodies: (Uint8Array | number[])[]): Uint8Array {
  const size = bodies.reduce((sum, body) => sum + body.length, 0),
    out = new Uint8Array(8 + size + (size & 1));
  out.set(ascii(tag));
  out.set(uint32(size), 4);
  let at = 8;
  for (const body of bodies) {
    out.set(body, at);
    at += body.length;
  }
  return out;
}
function riff(...chunks: Uint8Array[]): Uint8Array {
  const size = chunks.reduce((sum, part) => sum + part.length, 4);
  if (size > 0xfffffffe) throw new RangeError(`WebP file of ${size} bytes is too large for RIFF; encode fewer pixels`);
  const out = new Uint8Array(8 + size);
  out.set(ascii('RIFF'));
  out.set(uint32(size), 4);
  out.set(ascii('WEBP'), 8);
  let at = 12;
  for (const part of chunks) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

/**
 * Lossless WebP (VP8L) of `pixels`, pixel-exact, the colour under transparent pixels included; runs anywhere, Node
 * included. Lossy WebP is the browser's route: `OffscreenCanvas.convertToBlob({type: 'image/webp', quality})`.
 * @example
 * ```ts
 * import {encodeWebP} from 'margoengine/exporters/webp';
 * const file: Uint8Array = await encodeWebP({data: new Uint8Array([255, 0, 0, 255]), width: 1, height: 1});
 * ```
 * @throws RangeError for a side above 16384 or pixels that do not match their size. TypeError for other pixel data.
 */
export async function encodeWebP(pixels: Pixels): Promise<Uint8Array> {
  return riff(chunk('VP8L', vp8l(checked(pixels))));
}

/** Options for {@link encodeAnimatedWebP}. */
export interface AnimatedWebPOptions {
  /**
   * Frames per second, from 1000/16777215 to 1000. Durations are whole milliseconds rounded cumulatively, so the total
   * stays exact to the millisecond. Default 30.
   */
  fps?: number;
  /** How many times the animation plays, up to 65535; 0 loops forever. Default 0. */
  loops?: number;
}

/**
 * Animated lossless WebP (VP8X, ANIM and one ANMF per frame): one frame per `frame(index)`, all the same size. Each
 * frame replaces the one before it, alpha included, so a cut-out sprite never shows the frame under it.
 * @example
 * ```ts
 * import {encodeAnimatedWebP} from 'margoengine/exporters/webp';
 * const red = {data: new Uint8Array([255, 0, 0, 255]), width: 1, height: 1};
 * const clear = {data: new Uint8Array(4), width: 1, height: 1};
 * const file: Uint8Array = await encodeAnimatedWebP(2, (i) => (i ? clear : red), {fps: 12});
 * ```
 * @throws RangeError for a count that is not a whole number >= 1, fps or loops out of range, or frames of different
 * sizes or above 16384 pixels per side. TypeError for other pixel data.
 */
export async function encodeAnimatedWebP(
  count: number,
  frame: FrameSource,
  { fps = 30, loops = 0 }: AnimatedWebPOptions = {},
): Promise<Uint8Array> {
  checkCount(count);
  if (!(fps >= 1000 / 16777215 && fps <= 1000))
    throw new RangeError(`WebP fps ${fps} is outside 1000/16777215..1000; pass a frame rate those durations can hold`);
  if (!(Number.isInteger(loops) && loops >= 0 && loops <= 65535))
    throw new RangeError(`WebP loops ${loops} is invalid; pass a whole number from 0 (forever) to 65535`);
  const frames: Uint8Array[] = [];
  let width = 0,
    height = 0,
    alpha = false;
  for (let index = 0; index < count; index++) {
    const pixels = checked(await frame(index));
    if (!index) ({ width, height } = pixels);
    else if (pixels.width !== width || pixels.height !== height)
      throw new RangeError(
        `WebP frame ${index} is ${pixels.width}x${pixels.height}, not ${width}x${height}; capture every frame at one size`,
      );
    for (let i = 3; i < pixels.data.length && !alpha; i += 4) alpha = pixels.data[i] !== 255;
    const duration = Math.round(((index + 1) * 1000) / fps) - Math.round((index * 1000) / fps);
    frames.push(
      chunk(
        'ANMF',
        // At (0, 0), the canvas size, the duration, then flags: do not blend, do not dispose.
        [...uint24(0), ...uint24(0), ...uint24(width - 1), ...uint24(height - 1), ...uint24(duration), 2],
        chunk('VP8L', vp8l(pixels)),
      ),
    );
  }
  return riff(
    chunk('VP8X', [(alpha ? 0x10 : 0) | 2, 0, 0, 0, ...uint24(width - 1), ...uint24(height - 1)]),
    chunk('ANIM', [0, 0, 0, 0, loops & 255, loops >> 8]),
    ...frames,
  );
}
