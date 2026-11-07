// LZMA and .xz decoding (`@margoengine/decoders/xz`). Written from I. Pavlov's "LZMA specification" (the LZMA SDK's
// lzma-specification.txt, public domain, 2015) and L. Collin and I. Pavlov, "The .xz File Format" 1.2.1 (2024). The
// output buffer is the dictionary: a stream decodes whole, so nothing is copied out of a ring. VTK writes its LZMA blocks
// with these.
import { crc32 } from '../../shared/crc32.js';
import { decodeFailed, deviceUnsupported } from './errors.js';

/** Options of {@link decodeXz} and {@link decodeLzma}. */
export interface XzOptions {
  /** Largest output accepted, in bytes, so a small stream cannot fill memory. Default 2^30 (1 GiB). */
  maxBytes?: number;
}

const corrupt = (why: string) => decodeFailed(`LZMA stream is corrupt: ${why}`);

const BITS_MODEL = 11;
const TOP = 2 ** 24;
const START = 1 << (BITS_MODEL - 1);
const STATES = 12;
const POS_STATES_MAX = 16;
const LEN_LOW = 8;
const LEN_MID = 8;
const LEN_HIGH = 256;
const MATCH_MIN = 2;
const DIST_STATES = 4;
const END_MODEL = 14;
const FULL_DIST = 1 << (END_MODEL >> 1);
const ALIGN_BITS = 4;

/** The output so far: the dictionary of the matches that follow. */
class Output {
  data: Uint8Array;
  length = 0;
  /** Where the dictionary starts: a match cannot reach behind it. */
  floor = 0;
  readonly max: number;
  constructor(size: number, max: number) {
    this.max = max;
    this.data = new Uint8Array(Math.min(max, size));
  }
  room(bytes: number): void {
    const need = this.length + bytes;
    if (need <= this.data.length) return;
    if (need > this.max) throw decodeFailed(`LZMA output is over maxBytes (${this.max}); raise it to read this file`);
    const next = new Uint8Array(Math.min(this.max, Math.max(this.data.length * 2, need)));
    next.set(this.data.subarray(0, this.length));
    this.data = next;
  }
}

/** The range decoder: `code` and `range` as 32-bit values. */
class Range {
  range = 0;
  code = 0;
  at = 0;
  end = 0;
  readonly data: Uint8Array;
  constructor(data: Uint8Array) {
    this.data = data;
  }
  start(at: number, end: number): void {
    this.at = at;
    this.end = end;
    if (at + 5 > end) throw corrupt('a range coder has no start');
    if (this.data[this.at++] !== 0) throw corrupt('a range coder does not start with 0');
    this.range = 0xffffffff;
    this.code = 0;
    for (let i = 0; i < 4; i++) this.code = ((this.code << 8) | this.data[this.at++]) >>> 0;
    if (this.code === this.range) throw corrupt('a range coder starts out of range');
  }
  // After each bit, as the specification has it, so a chunk ends on its last byte.
  private normalize(): void {
    if (this.range < TOP) {
      if (this.at >= this.end) throw corrupt('it ends early');
      this.range = (this.range << 8) >>> 0;
      this.code = ((this.code << 8) | this.data[this.at++]) >>> 0;
    }
  }
  bit(probs: Uint16Array, i: number): number {
    const p = probs[i],
      bound = (this.range >>> BITS_MODEL) * p;
    let bit = 0;
    if (this.code < bound) {
      this.range = bound;
      probs[i] = p + (((1 << BITS_MODEL) - p) >>> 5);
    } else {
      this.code = (this.code - bound) >>> 0;
      this.range = (this.range - bound) >>> 0;
      probs[i] = p - (p >>> 5);
      bit = 1;
    }
    this.normalize();
    return bit;
  }
  direct(count: number): number {
    let value = 0;
    for (; count > 0; count--) {
      this.range >>>= 1;
      const take = this.code >= this.range;
      if (take) this.code = (this.code - this.range) >>> 0;
      this.normalize();
      value = ((value << 1) | +take) >>> 0;
    }
    return value;
  }
  tree(probs: Uint16Array, at: number, bits: number): number {
    let m = 1;
    for (let i = 0; i < bits; i++) m = (m << 1) + this.bit(probs, at + m);
    return m - (1 << bits);
  }
  reverse(probs: Uint16Array, at: number, bits: number): number {
    let m = 1,
      value = 0;
    for (let i = 0; i < bits; i++) {
      const bit = this.bit(probs, at + m);
      m = (m << 1) + bit;
      value |= bit << i;
    }
    return value;
  }
  /** A clean end: the code has come back to zero. */
  get finished(): boolean {
    return this.code === 0;
  }
}

/** Length coder: choice, then a 3, 3 or 8-bit tree. */
class Lengths {
  readonly choice = new Uint16Array(2);
  readonly low = new Uint16Array(POS_STATES_MAX << 3);
  readonly mid = new Uint16Array(POS_STATES_MAX << 3);
  readonly high = new Uint16Array(LEN_HIGH);
  reset(): void {
    for (const probs of [this.choice, this.low, this.mid, this.high]) probs.fill(START);
  }
  read(rc: Range, posState: number): number {
    if (!rc.bit(this.choice, 0)) return rc.tree(this.low, posState << 3, 3);
    if (!rc.bit(this.choice, 1)) return LEN_LOW + rc.tree(this.mid, posState << 3, 3);
    return LEN_LOW + LEN_MID + rc.tree(this.high, 0, 8);
  }
}

/** Decoder state that outlives one LZMA2 chunk. */
class Lzma {
  lc = 0;
  lp = 0;
  pb = 0;
  state = 0;
  private rep0 = 0;
  private rep1 = 0;
  private rep2 = 0;
  private rep3 = 0;
  private literal = new Uint16Array(0);
  private readonly isMatch = new Uint16Array(STATES << 4);
  private readonly isRep = new Uint16Array(STATES);
  private readonly isRepG0 = new Uint16Array(STATES);
  private readonly isRepG1 = new Uint16Array(STATES);
  private readonly isRepG2 = new Uint16Array(STATES);
  private readonly isRep0Long = new Uint16Array(STATES << 4);
  private readonly slots = new Uint16Array(DIST_STATES << 6);
  private readonly special = new Uint16Array(1 + FULL_DIST - END_MODEL);
  private readonly align = new Uint16Array(1 << ALIGN_BITS);
  private readonly lengths = new Lengths();
  private readonly repLengths = new Lengths();
  /** Sets lc, lp and pb from the properties byte. */
  properties(byte: number): void {
    if (byte >= 9 * 5 * 5) throw corrupt('its properties are out of range');
    this.lc = byte % 9;
    const rest = Math.floor(byte / 9);
    this.lp = rest % 5;
    this.pb = Math.floor(rest / 5);
  }
  /** Back to the start of the model: the state reset of the specification. */
  reset(): void {
    const size = 0x300 << (this.lc + this.lp);
    if (this.literal.length !== size) this.literal = new Uint16Array(size);
    this.state = this.rep0 = this.rep1 = this.rep2 = this.rep3 = 0;
    for (const probs of [
      this.literal,
      this.isMatch,
      this.isRep,
      this.isRepG0,
      this.isRepG1,
      this.isRepG2,
      this.isRep0Long,
      this.slots,
      this.special,
      this.align,
    ])
      probs.fill(START);
    this.lengths.reset();
    this.repLengths.reset();
  }
  private readLiteral(rc: Range, out: Output): void {
    const { lc, lp, literal, state } = this,
      position = out.length - out.floor,
      previous = out.length > out.floor ? out.data[out.length - 1] : 0,
      base = 0x300 * (((position & ((1 << lp) - 1)) << lc) + (previous >>> (8 - lc)));
    let symbol = 1;
    if (state >= 7) {
      let match = out.data[out.length - this.rep0 - 1];
      do {
        const bit = (match >>> 7) & 1;
        match = (match << 1) & 0xff;
        const got = rc.bit(literal, base + ((1 + bit) << 8) + symbol);
        symbol = (symbol << 1) | got;
        if (bit !== got) break;
      } while (symbol < 0x100);
    }
    while (symbol < 0x100) symbol = (symbol << 1) | rc.bit(literal, base + symbol);
    out.data[out.length++] = symbol & 0xff;
  }
  private readDistance(rc: Range, length: number): number {
    const slot = rc.tree(this.slots, Math.min(length, DIST_STATES - 1) << 6, 6);
    if (slot < 4) return slot;
    const bits = (slot >>> 1) - 1;
    let distance = (2 | (slot & 1)) * 2 ** bits;
    if (slot < END_MODEL) distance += rc.reverse(this.special, distance - slot, bits);
    else distance += rc.direct(bits - ALIGN_BITS) * (1 << ALIGN_BITS) + rc.reverse(this.align, 0, ALIGN_BITS);
    return distance;
  }
  /**
   * Decodes until `limit` bytes are out, or to the end marker when `limit` is unknown (Infinity). True when the marker
   * ended the data.
   */
  run(rc: Range, out: Output, limit: number): boolean {
    const posMask = (1 << this.pb) - 1,
      stop = limit === Infinity ? Infinity : out.length + limit;
    for (;;) {
      if (out.length >= stop) return false;
      const posState = (out.length - out.floor) & posMask,
        at = (this.state << 4) + posState;
      if (!rc.bit(this.isMatch, at)) {
        if (this.state >= 7 && this.rep0 >= out.length - out.floor) throw corrupt('a match reaches before the start');
        out.room(1);
        this.readLiteral(rc, out);
        this.state = this.state < 4 ? 0 : this.state < 10 ? this.state - 3 : this.state - 6;
        continue;
      }
      let length: number;
      if (rc.bit(this.isRep, this.state)) {
        if (out.length === out.floor) throw corrupt('a match has nothing to copy');
        if (!rc.bit(this.isRepG0, this.state)) {
          if (!rc.bit(this.isRep0Long, at)) {
            this.state = this.state < 7 ? 9 : 11;
            if (this.rep0 >= out.length - out.floor) throw corrupt('a match reaches before the start');
            out.room(1);
            out.data[out.length] = out.data[out.length - this.rep0 - 1];
            out.length++;
            continue;
          }
        } else {
          let distance: number;
          if (!rc.bit(this.isRepG1, this.state)) distance = this.rep1;
          else {
            if (!rc.bit(this.isRepG2, this.state)) distance = this.rep2;
            else {
              distance = this.rep3;
              this.rep3 = this.rep2;
            }
            this.rep2 = this.rep1;
          }
          this.rep1 = this.rep0;
          this.rep0 = distance;
        }
        length = this.repLengths.read(rc, posState);
        this.state = this.state < 7 ? 8 : 11;
      } else {
        this.rep3 = this.rep2;
        this.rep2 = this.rep1;
        this.rep1 = this.rep0;
        length = this.lengths.read(rc, posState);
        this.state = this.state < 7 ? 7 : 10;
        this.rep0 = this.readDistance(rc, length);
        if (this.rep0 === 0xffffffff) return true;
      }
      if (this.rep0 >= out.length - out.floor) throw corrupt('a match reaches before the start');
      length += MATCH_MIN;
      if (out.length + length > stop) throw corrupt('a match runs past the end of its chunk');
      out.room(length);
      const { data } = out,
        from = out.length - this.rep0 - 1;
      for (let i = 0; i < length; i++) data[out.length + i] = data[from + i];
      out.length += length;
    }
  }
}

/** A stream of LZMA2 chunks from `at`, which ends at a control byte of 0. Returns where it stopped. */
function readLzma2(input: Uint8Array, at: number, end: number, out: Output): number {
  const lzma = new Lzma(),
    rc = new Range(input);
  let needDictionary = true,
    needProperties = true,
    needState = true;
  for (;;) {
    if (at >= end) throw corrupt('it ends early');
    const control = input[at++];
    if (!control) return at;
    if (control >= 0xe0 || control === 1) {
      out.floor = out.length;
      needDictionary = false;
    } else if (needDictionary) throw corrupt('its first chunk does not reset the dictionary');
    if (control < 0x80) {
      if (control > 2) throw corrupt('a chunk has an unknown control byte');
      if (at + 2 > end) throw corrupt('it ends early');
      const size = ((input[at] << 8) | input[at + 1]) + 1;
      at += 2;
      if (at + size > end) throw corrupt('it ends early');
      out.room(size);
      out.data.set(input.subarray(at, at + size), out.length);
      out.length += size;
      at += size;
      continue;
    }
    if (at + 4 > end) throw corrupt('it ends early');
    const size = (((control & 0x1f) << 16) | (input[at] << 8) | input[at + 1]) + 1,
      packed = ((input[at + 2] << 8) | input[at + 3]) + 1,
      reset = (control >>> 5) & 3;
    at += 4;
    if (reset >= 2) {
      if (at >= end) throw corrupt('it ends early');
      lzma.properties(input[at++]);
      if (lzma.lc + lzma.lp > 4) throw corrupt('its properties are out of range');
      needProperties = false;
    } else if (needProperties) throw corrupt('a chunk has no properties');
    if (reset >= 1) {
      lzma.reset();
      needState = false;
    } else if (needState) throw corrupt('a chunk has no state');
    if (at + packed > end) throw corrupt('it ends early');
    rc.start(at, at + packed);
    lzma.run(rc, out, size);
    if (rc.at !== at + packed || !rc.finished) throw corrupt('a chunk does not end where it says');
    at += packed;
  }
}

/**
 * Decodes the `.lzma` file form: properties, dictionary size, a 64-bit output size or all ones, then the data, which ends
 * at the size or at an end marker.
 * @throws MargoError `'failed'` for a corrupt or short stream, or one past `maxBytes`.
 */
export function decodeLzma(input: Uint8Array, options: XzOptions = {}): Uint8Array {
  const maxBytes = options.maxBytes ?? 2 ** 30;
  if (input.length < 13 + 5) throw corrupt('it ends early');
  const lzma = new Lzma();
  lzma.properties(input[0]);
  // All ones means no size is given.
  let known = false,
    size = 0;
  for (let i = 12; i >= 5; i--) {
    known ||= input[i] !== 0xff;
    size = size * 256 + input[i];
  }
  if (known && size > maxBytes) throw decodeFailed(`LZMA output is over maxBytes (${maxBytes}); raise it to read this file`);
  const out = new Output(known ? Math.max(size, 1) : Math.max(1024, input.length * 4), maxBytes),
    rc = new Range(input);
  rc.start(13, input.length);
  lzma.reset();
  const marked = lzma.run(rc, out, known ? size : Infinity);
  if (!marked && !rc.finished) throw corrupt('it does not end cleanly');
  return out.data.subarray(0, out.length);
}

/** CRC64 of .xz (ECMA-182, reflected) as two 32-bit halves, one table each. */
const crc64Tables = /* @__PURE__ */ (() => {
  const low = new Uint32Array(256),
    high = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let l = i,
      h = 0;
    for (let k = 0; k < 8; k++) {
      const odd = l & 1;
      l = ((l >>> 1) | (h << 31)) >>> 0;
      h >>>= 1;
      if (odd) {
        l = (l ^ 0xd7870f42) >>> 0;
        h = (h ^ 0xc96c5795) >>> 0;
      }
    }
    low[i] = l;
    high[i] = h;
  }
  return { low, high };
})();
function crc64Matches(data: Uint8Array, from: number, to: number, input: Uint8Array, at: number): boolean {
  const { low, high } = crc64Tables;
  let l = 0xffffffff,
    h = 0xffffffff;
  for (let i = from; i < to; i++) {
    const t = (l ^ data[i]) & 0xff;
    l = (((l >>> 8) | (h << 24)) ^ low[t]) >>> 0;
    h = ((h >>> 8) ^ high[t]) >>> 0;
  }
  return ~l >>> 0 === u32(input, at) && ~h >>> 0 === u32(input, at + 4);
}

/** The first 32 bits of the fraction of `root(prime)`: how FIPS 180-4 sections 4.2.2 and 5.3.3 define SHA-256's constants. */
function shaConstants(count: number, root: (n: number) => number): Int32Array {
  const out = new Int32Array(count);
  for (let n = 2, found = 0; found < count; n++) {
    let prime = true;
    for (let d = 2; d * d <= n; d++) if (n % d === 0) prime = false;
    if (!prime) continue;
    const value = root(n);
    out[found++] = Math.floor((value - Math.floor(value)) * 2 ** 32) | 0;
  }
  return out;
}
const rotate = (x: number, n: number): number => (x >>> n) | (x << (32 - n));
/** SHA-256 (FIPS 180-4) of `data[from, to)`, against the 32 bytes at `input[at]`. */
function sha256Matches(data: Uint8Array, from: number, to: number, input: Uint8Array, at: number): boolean {
  const k = shaConstants(64, Math.cbrt),
    hash = shaConstants(8, Math.sqrt),
    size = to - from,
    whole = size - (size % 64),
    tail = new Uint8Array(size - whole < 56 ? 64 : 128),
    w = new Int32Array(64),
    block = (bytes: Uint8Array, start: number) => {
      for (let i = 0; i < 16; i++) {
        const p = start + i * 4;
        w[i] = (bytes[p] << 24) | (bytes[p + 1] << 16) | (bytes[p + 2] << 8) | bytes[p + 3];
      }
      for (let i = 16; i < 64; i++) {
        const x = w[i - 15],
          y = w[i - 2];
        w[i] =
          (rotate(x, 7) ^ rotate(x, 18) ^ (x >>> 3)) + w[i - 16] + w[i - 7] + (rotate(y, 17) ^ rotate(y, 19) ^ (y >>> 10));
      }
      let [a, b, c, d, e, f, g, h] = hash;
      for (let i = 0; i < 64; i++) {
        const one = (h + (rotate(e, 6) ^ rotate(e, 11) ^ rotate(e, 25)) + ((e & f) ^ (~e & g)) + k[i] + w[i]) | 0,
          two = ((rotate(a, 2) ^ rotate(a, 13) ^ rotate(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) | 0;
        h = g;
        g = f;
        f = e;
        e = (d + one) | 0;
        d = c;
        c = b;
        b = a;
        a = (one + two) | 0;
      }
      [a, b, c, d, e, f, g, h].forEach((value, i) => (hash[i] += value));
    };
  for (let i = 0; i < whole; i += 64) block(data, from + i);
  tail.set(data.subarray(from + whole, to));
  tail[size - whole] = 0x80;
  const bits = size * 8;
  for (let i = 0; i < 8; i++) tail[tail.length - 1 - i] = Math.floor(bits / 2 ** (8 * i)) & 0xff;
  for (let i = 0; i < tail.length; i += 64) block(tail, i);
  for (let i = 0; i < 32; i++) if (((hash[i >> 2] >>> (24 - 8 * (i & 3))) & 0xff) !== input[at + i]) return false;
  return true;
}

const u32 = (d: Uint8Array, at: number): number => (d[at] | (d[at + 1] << 8) | (d[at + 2] << 16) | (d[at + 3] << 24)) >>> 0;
const CHECK_SIZES = [0, 4, 4, 4, 8, 8, 8, 16, 16, 16, 32, 32, 32, 64, 64, 64];
const MAGIC = [0xfd, 0x37, 0x7a, 0x58, 0x5a, 0];

/**
 * Decodes an `.xz` stream, or several in a row with padding between, and checks all the file holds: the CRC32 of the
 * headers, and each block's own CRC32, CRC64 or SHA-256. Only the LZMA2 filter is read.
 * @throws MargoError `'failed'` for a corrupt or short stream or one past `maxBytes`, `'unsupported'` for another filter.
 */
export function decodeXz(input: Uint8Array, options: XzOptions = {}): Uint8Array {
  const out = new Output(Math.max(1024, input.length * 4), options.maxBytes ?? 2 ** 30);
  let at = 0;
  const varint = () => {
    let value = 0,
      scale = 1;
    for (let i = 0; i < 9; i++) {
      if (at >= input.length) throw corrupt('it ends early');
      const byte = input[at++];
      value += (byte & 0x7f) * scale;
      if (byte < 0x80) return value;
      scale *= 128;
    }
    throw corrupt('a number is too long');
  };
  do {
    if (at + 12 > input.length || MAGIC.some((byte, i) => input[at + i] !== byte)) throw corrupt('it has no xz header');
    if (input[at + 6] !== 0 || input[at + 7] > 15) throw corrupt('its stream flags are unknown');
    if (crc32(input.subarray(at + 6, at + 8)) !== u32(input, at + 8)) throw corrupt('its header fails its CRC');
    const check = input[at + 7],
      size = CHECK_SIZES[check];
    at += 12;
    for (;;) {
      if (at >= input.length) throw corrupt('it ends early');
      const head = at;
      if (!input[at]) break;
      const headerSize = (input[at++] + 1) * 4;
      if (head + headerSize > input.length) throw corrupt('it ends early');
      if (crc32(input.subarray(head, head + headerSize - 4)) !== u32(input, head + headerSize - 4))
        throw corrupt('a block header fails its CRC');
      const flags = input[at++],
        filters = (flags & 3) + 1;
      if (flags & 0x3c) throw corrupt('a block header has unknown flags');
      if (flags & 0x40) varint();
      if (flags & 0x80) varint();
      for (let i = 0; i < filters; i++) {
        const id = varint(),
          bytes = varint();
        if (id !== 0x21 || i !== filters - 1 || filters > 1)
          throw deviceUnsupported(`xz filter 0x${id.toString(16)} is not read; only LZMA2 is`);
        at += bytes;
      }
      at = head + headerSize;
      const first = out.length,
        start = at;
      out.floor = out.length;
      at = readLzma2(input, at, input.length, out);
      while ((at - start) % 4) if (input[at++]) throw corrupt('block padding is not zero');
      if (at + size > input.length) throw corrupt('it ends early');
      if (
        (check === 1 && crc32(out.data.subarray(first, out.length)) !== u32(input, at)) ||
        (check === 4 && !crc64Matches(out.data, first, out.length, input, at)) ||
        (check === 10 && !sha256Matches(out.data, first, out.length, input, at))
      )
        throw corrupt('a block fails its check');
      at += size;
    }
    // The index repeats sizes already checked by decoding: its own CRC and the footer are what is read here.
    const index = at++,
      records = varint();
    for (let i = 0; i < records * 2; i++) varint();
    while ((at - index) % 4) if (input[at++]) throw corrupt('index padding is not zero');
    if (at + 4 + 12 > input.length) throw corrupt('it ends early');
    if (crc32(input.subarray(index, at)) !== u32(input, at)) throw corrupt('its index fails its CRC');
    at += 4;
    if (input[at + 10] !== 0x59 || input[at + 11] !== 0x5a) throw corrupt('it has no xz footer');
    if (crc32(input.subarray(at + 4, at + 10)) !== u32(input, at)) throw corrupt('its footer fails its CRC');
    at += 12;
    while (at + 4 <= input.length && !u32(input, at)) at += 4;
  } while (at < input.length);
  return out.data.subarray(0, out.length);
}
