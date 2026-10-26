// Lossless WebP (VP8L) image decoder for the SOG splat format. Written from the public WebP Lossless Bitstream
// Specification (RFC 9649) and the RIFF container description; no other implementation was read.
import { MargoError } from '@margoengine/math/errors';

/** A decoded image: 8-bit RGBA, row-major, origin at the top left. */
export interface DecodedImage {
  width: number;
  height: number;
  /** 4 bytes per pixel (r, g, b, a), not premultiplied. */
  data: Uint8Array;
}

const fail = (why: string): never => {
  throw new RangeError(`Not a valid lossless WebP image: ${why}; re-export the SOG with lossless textures.`);
};

/** (dx, dy) pairs of the 120 short backward-reference distance codes. */
const NEIGHBOURS: readonly number[] = [
  0, 1, 1, 0, 1, 1, -1, 1, 0, 2, 2, 0, 1, 2, -1, 2, 2, 1, -2, 1, 2, 2, -2, 2, 0, 3, 3, 0, 1, 3, -1, 3, 3, 1, -3, 1, 2,
  3, -2, 3, 3, 2, -3, 2, 0, 4, 4, 0, 1, 4, -1, 4, 4, 1, -4, 1, 3, 3, -3, 3, 2, 4, -2, 4, 4, 2, -4, 2, 0, 5, 3, 4, -3, 4,
  4, 3, -4, 3, 5, 0, 1, 5, -1, 5, 5, 1, -5, 1, 2, 5, -2, 5, 5, 2, -5, 2, 4, 4, -4, 4, 3, 5, -3, 5, 5, 3, -5, 3, 0, 6, 6,
  0, 1, 6, -1, 6, 6, 1, -6, 1, 2, 6, -2, 6, 6, 2, -6, 2, 4, 5, -4, 5, 5, 4, -5, 4, 3, 6, -3, 6, 6, 3, -6, 3, 0, 7, 7, 0,
  1, 7, -1, 7, 5, 5, -5, 5, 7, 1, -7, 1, 4, 6, -4, 6, 6, 4, -6, 4, 2, 7, -2, 7, 7, 2, -7, 2, 3, 7, -3, 7, 7, 3, -7, 3,
  5, 6, -5, 6, 6, 5, -6, 5, 8, 0, 4, 7, -4, 7, 7, 4, -7, 4, 8, 1, 8, 2, 6, 6, -6, 6, 8, 3, 5, 7, -5, 7, 7, 5, -7, 5, 8,
  4, 6, 7, -6, 7, 7, 6, -7, 6, 8, 5, 7, 7, -7, 7, 8, 6, 8, 7,
];
const CODE_LENGTH_ORDER = [17, 18, 0, 1, 2, 3, 4, 5, 16, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15];

class Bits {
  private acc = 0;
  private have = 0;
  constructor(
    private readonly bytes: Uint8Array,
    private offset: number,
  ) {}
  /** Reads `n` (0..24) bits, least significant first. */
  read(n: number): number {
    while (this.have < n) {
      if (this.offset >= this.bytes.length) fail('the data ends early');
      this.acc += this.bytes[this.offset++] * 2 ** this.have;
      this.have += 8;
    }
    const value = n === 0 ? 0 : this.acc % 2 ** n;
    this.acc = Math.floor(this.acc / 2 ** n);
    this.have -= n;
    return value;
  }
}

/** Canonical prefix code, decoded one bit at a time (codes are read most significant bit first). */
class PrefixCode {
  private readonly count = new Uint32Array(16);
  private readonly symbols: Uint16Array;
  private readonly single: number;
  constructor(lengths: ArrayLike<number>) {
    let used = 0,
      last = 0;
    for (let s = 0; s < lengths.length; s++)
      if (lengths[s]) {
        this.count[lengths[s]]++;
        used++;
        last = s;
      }
    this.single = used === 1 ? last : -1;
    if (used === 0) fail('an empty prefix code');
    // Reject over- or under-subscribed codes (a single symbol is the zero-bit code).
    if (used > 1) {
      let left = 1;
      for (let len = 1; len < 16; len++) {
        left = left * 2 - this.count[len];
        if (left < 0) fail('an over-subscribed prefix code');
      }
      if (left !== 0) fail('an incomplete prefix code');
    }
    const offsets = new Uint32Array(17);
    for (let len = 1; len < 16; len++) offsets[len + 1] = offsets[len] + this.count[len];
    this.symbols = new Uint16Array(used);
    for (let s = 0; s < lengths.length; s++) if (lengths[s]) this.symbols[offsets[lengths[s]]++] = s;
  }
  decode(bits: Bits): number {
    if (this.single >= 0) return this.single;
    let code = 0,
      first = 0,
      index = 0;
    for (let len = 1; len < 16; len++) {
      code |= bits.read(1);
      const c = this.count[len];
      if (code - c < first) return this.symbols[index + (code - first)];
      index += c;
      first = (first + c) << 1;
      code <<= 1;
    }
    return fail('an invalid prefix code in the data');
  }
}

function readCode(bits: Bits, alphabet: number): PrefixCode {
  const lengths = new Uint8Array(alphabet);
  if (bits.read(1)) {
    const two = bits.read(1),
      first = bits.read(1) ? bits.read(8) : bits.read(1);
    if (first >= alphabet) fail('a symbol outside its alphabet');
    lengths[first] = 1;
    if (two) {
      const second = bits.read(8);
      if (second >= alphabet) fail('a symbol outside its alphabet');
      if (second === first) fail('a simple code that repeats a symbol');
      lengths[second] = 1;
    }
    return new PrefixCode(lengths);
  }
  const meta = new Uint8Array(19),
    n = 4 + bits.read(4);
  for (let i = 0; i < n; i++) meta[CODE_LENGTH_ORDER[i]] = bits.read(3);
  const metaCode = new PrefixCode(meta);
  let maxSymbol = alphabet;
  if (bits.read(1)) {
    maxSymbol = 2 + bits.read(2 + 2 * bits.read(3));
    if (maxSymbol > alphabet) fail('a code-length run longer than the alphabet');
  }
  let symbol = 0,
    previous = 8;
  while (symbol < alphabet) {
    if (maxSymbol-- === 0) break;
    const len = metaCode.decode(bits);
    if (len < 16) {
      lengths[symbol++] = len;
      if (len) previous = len;
      continue;
    }
    const repeat = len === 16 ? 3 + bits.read(2) : len === 17 ? 3 + bits.read(3) : 11 + bits.read(7),
      value = len === 16 ? previous : 0;
    if (symbol + repeat > alphabet) fail('a code-length repeat past the alphabet');
    for (let i = 0; i < repeat; i++) lengths[symbol++] = value;
  }
  return new PrefixCode(lengths);
}

const copyDistance = (bits: Bits, prefix: number): number => {
  if (prefix < 4) return prefix + 1;
  const extra = (prefix - 2) >> 1;
  return ((2 + (prefix & 1)) << extra) + bits.read(extra) + 1;
};

/** Decodes one entropy-coded image of `width x height` ARGB pixels (packed 0xAARRGGBB). */
function readImage(bits: Bits, width: number, height: number, isMain: boolean): Uint32Array {
  let cacheBits = 0;
  if (bits.read(1)) {
    cacheBits = bits.read(4);
    if (cacheBits < 1 || cacheBits > 11) fail('a colour cache size outside 1..11 bits');
  }
  let prefixBits = 0,
    prefixMap: Uint32Array | undefined,
    groups = 1;
  if (isMain && bits.read(1)) {
    prefixBits = bits.read(3) + 2;
    const map = readImage(bits, Math.ceil(width / (1 << prefixBits)), Math.ceil(height / (1 << prefixBits)), false);
    prefixMap = new Uint32Array(map.length);
    for (let i = 0; i < map.length; i++) {
      prefixMap[i] = (map[i] >>> 8) & 0xffff;
      groups = Math.max(groups, prefixMap[i] + 1);
    }
  }
  const cacheSize = cacheBits ? 1 << cacheBits : 0,
    codes: PrefixCode[][] = [];
  for (let g = 0; g < groups; g++)
    codes.push([
      readCode(bits, 256 + 24 + cacheSize),
      readCode(bits, 256),
      readCode(bits, 256),
      readCode(bits, 256),
      readCode(bits, 40),
    ]);
  const out = new Uint32Array(width * height),
    cache = cacheBits ? new Uint32Array(cacheSize) : undefined,
    shift = 32 - cacheBits;
  let at = 0,
    cached = 0;
  const flush = () => {
    if (!cache) return;
    for (; cached < at; cached++) cache[Math.imul(0x1e35a7bd, out[cached]) >>> shift] = out[cached];
  };
  while (at < out.length) {
    const x = at % width,
      y = (at - x) / width,
      group = prefixMap
        ? codes[prefixMap[(y >> prefixBits) * Math.ceil(width / (1 << prefixBits)) + (x >> prefixBits)]]
        : codes[0];
    if (!group) fail('a pixel that names a missing prefix group');
    const s = group[0].decode(bits);
    if (s < 256) {
      const r = group[1].decode(bits),
        b = group[2].decode(bits),
        a = group[3].decode(bits);
      out[at++] = ((a << 24) | (r << 16) | (s << 8) | b) >>> 0;
    } else if (s < 280) {
      const length = copyDistance(bits, s - 256),
        code = copyDistance(bits, group[4].decode(bits));
      let distance: number;
      if (code > 120) distance = code - 120;
      else {
        distance = NEIGHBOURS[(code - 1) * 2] + NEIGHBOURS[(code - 1) * 2 + 1] * width;
        if (distance < 1) distance = 1;
      }
      if (distance > at || at + length > out.length) fail('a backward reference outside the image');
      for (let i = 0; i < length; i++, at++) out[at] = out[at - distance];
    } else {
      if (!cache) fail('a colour-cache symbol with no cache');
      flush();
      out[at++] = cache![s - 280];
    }
    flush();
  }
  return out;
}

const average2 = (a: number, b: number): number => ((((a ^ b) & 0xfefefefe) >>> 1) + (a & b)) >>> 0;
const clamp = (v: number): number => (v < 0 ? 0 : v > 255 ? 255 : v);
const channel = (p: number, shift: number): number => (p >>> shift) & 255;

function predict(mode: number, out: Uint32Array, at: number, width: number): number {
  const left = out[at - 1],
    top = out[at - width],
    topRight = out[at - width + 1],
    topLeft = out[at - width - 1];
  switch (mode) {
    case 1:
      return left;
    case 2:
      return top;
    case 3:
      return topRight;
    case 4:
      return topLeft;
    case 5:
      return average2(average2(left, topRight), top);
    case 6:
      return average2(left, topLeft);
    case 7:
      return average2(left, top);
    case 8:
      return average2(topLeft, top);
    case 9:
      return average2(top, topRight);
    case 10:
      return average2(average2(left, topLeft), average2(top, topRight));
    case 11: {
      let pl = 0,
        pt = 0;
      for (let s = 0; s < 32; s += 8) {
        const p = channel(left, s) + channel(top, s) - channel(topLeft, s);
        pl += Math.abs(p - channel(left, s));
        pt += Math.abs(p - channel(top, s));
      }
      return pl < pt ? left : top;
    }
    case 12: {
      let r = 0;
      for (let s = 0; s < 32; s += 8) r += clamp(channel(left, s) + channel(top, s) - channel(topLeft, s)) * 2 ** s;
      return r >>> 0;
    }
    case 13: {
      const a = average2(left, top);
      let r = 0;
      for (let s = 0; s < 32; s += 8)
        r += clamp(channel(a, s) + Math.trunc((channel(a, s) - channel(topLeft, s)) / 2)) * 2 ** s;
      return r >>> 0;
    }
    default:
      return 0xff000000;
  }
}

const addPixels = (a: number, b: number): number =>
  (((((a & 0xff00ff00) >>> 0) + ((b & 0xff00ff00) >>> 0)) & 0xff00ff00) |
    (((a & 0x00ff00ff) + (b & 0x00ff00ff)) & 0x00ff00ff)) >>>
  0;
const delta = (t: number, c: number): number => (((t << 24) >> 24) * ((c << 24) >> 24)) >> 5;

/**
 * Decodes a lossless WebP file (RIFF `WEBP` with a `VP8L` chunk) to RGBA bytes.
 * @throws RangeError for damaged data or a file without a VP8L chunk; MargoError `unsupported` for a lossy (VP8) image.
 */
export function decodeWebpLossless(input: Uint8Array): DecodedImage {
  const view = new DataView(input.buffer, input.byteOffset, input.byteLength);
  if (input.length < 20 || view.getUint32(0, true) !== 0x46464952 || view.getUint32(8, true) !== 0x50424557)
    fail('missing the RIFF WEBP header');
  let at = 12,
    start = -1,
    size = 0;
  while (at + 8 <= input.length) {
    const tag = view.getUint32(at, true),
      length = view.getUint32(at + 4, true);
    if (tag === 0x4c385056) {
      start = at + 8;
      size = length;
      break;
    }
    if (tag === 0x20385056)
      throw new MargoError(
        'unsupported',
        'This WebP is lossy (VP8); SOG textures must be lossless, re-export the SOG.',
      );
    at += 8 + length + (length & 1);
  }
  if (start < 0 || start + size > input.length) fail('no VP8L chunk');
  const bits = new Bits(input.subarray(0, start + size), start);
  if (bits.read(8) !== 0x2f) fail('a bad VP8L signature');
  const width = bits.read(14) + 1,
    height = bits.read(14) + 1;
  bits.read(1); // alpha_is_used: a hint only
  if (bits.read(3) !== 0) fail('an unknown VP8L version');
  type Transform = { type: number; bits: number; width: number; data: Uint32Array };
  const transforms: Transform[] = [],
    seen = new Set<number>();
  let xsize = width;
  while (bits.read(1)) {
    const type = bits.read(2);
    if (seen.has(type)) fail('a repeated transform');
    seen.add(type);
    const t: Transform = { type, bits: 0, width: xsize, data: new Uint32Array(0) };
    if (type === 0 || type === 1) {
      t.bits = bits.read(3) + 2;
      t.data = readImage(bits, Math.ceil(xsize / (1 << t.bits)), Math.ceil(height / (1 << t.bits)), false);
    } else if (type === 3) {
      const n = bits.read(8) + 1,
        table = readImage(bits, n, 1, false);
      for (let i = 1; i < n; i++) table[i] = addPixels(table[i], table[i - 1]);
      t.data = table;
      t.bits = n <= 2 ? 3 : n <= 4 ? 2 : n <= 16 ? 1 : 0;
      xsize = Math.ceil(xsize / (1 << t.bits));
    }
    transforms.push(t);
  }
  let pixels = readImage(bits, xsize, height, true);
  for (let k = transforms.length - 1; k >= 0; k--) {
    const t = transforms[k];
    if (t.type === 2) {
      for (let i = 0; i < pixels.length; i++) {
        const p = pixels[i],
          g = (p >>> 8) & 255;
        pixels[i] = ((p & 0xff00ff00) | (((((p >>> 16) & 255) + g) & 255) << 16) | (((p & 255) + g) & 255)) >>> 0;
      }
    } else if (t.type === 1) {
      const per = Math.ceil(t.width / (1 << t.bits));
      for (let y = 0; y < height; y++)
        for (let x = 0; x < t.width; x++) {
          const m = t.data[(y >> t.bits) * per + (x >> t.bits)],
            i = y * t.width + x,
            p = pixels[i],
            g = (p >>> 8) & 255;
          let r = (p >>> 16) & 255,
            b = p & 255;
          r = (r + delta(m & 255, g)) & 255;
          b = (b + delta((m >>> 8) & 255, g) + delta((m >>> 16) & 255, r)) & 255;
          pixels[i] = ((p & 0xff00ff00) | (r << 16) | b) >>> 0;
        }
    } else if (t.type === 0) {
      const per = Math.ceil(t.width / (1 << t.bits)),
        w = t.width;
      for (let y = 0; y < height; y++)
        for (let x = 0; x < w; x++) {
          const i = y * w + x;
          let p: number;
          if (y === 0) p = x === 0 ? 0xff000000 : pixels[i - 1];
          else if (x === 0) p = pixels[i - w];
          else p = predict((t.data[(y >> t.bits) * per + (x >> t.bits)] >>> 8) & 15, pixels, i, w);
          pixels[i] = addPixels(pixels[i], p);
        }
    } else {
      const bitsPer = 8 >> t.bits,
        mask = (1 << bitsPer) - 1,
        out = new Uint32Array(t.width * height),
        table = t.data,
        packedWidth = Math.ceil(t.width / (1 << t.bits));
      for (let y = 0; y < height; y++)
        for (let x = 0; x < t.width; x++) {
          const g = (pixels[y * packedWidth + (x >> t.bits)] >>> 8) & 255,
            index = t.bits ? (g >> ((x & ((1 << t.bits) - 1)) * bitsPer)) & mask : g;
          out[y * t.width + x] = index < table.length ? table[index] : 0;
        }
      pixels = out;
    }
  }
  const data = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    const p = pixels[i];
    data[i * 4] = (p >>> 16) & 255;
    data[i * 4 + 1] = (p >>> 8) & 255;
    data[i * 4 + 2] = p & 255;
    data[i * 4 + 3] = p >>> 24;
  }
  return { width, height, data };
}
