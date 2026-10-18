// JT integer coding, from the JT File Format Reference 9.5: Int32 Compressed Data Packets Mk. 2 (8.1.2, used by JT 9
// meshes) with the arithmetic codec (8.2.3, Appendix C 3.2), the bit-length codec (as real files write it; the text
// leaves it part-defined) and the chopper, the residual predictors (Appendix C 1.3), and the lookup hash the format
// stores to check decoded data (Appendix D). Mk. 1 packets appear only in the JT B-rep, wireframe and ULP segments,
// which are not read; their decoder is in commit c91ebc0.
//
// This software reads the JT Data Format as described in the Siemens JT File Format Reference and ISO 14306. Copyright
// in the JT data structures and operators is owned by Siemens Product Lifecycle Management Software Inc. (Siemens
// Digital Industries Software) and they are used under the Siemens JT Data Format Reference Intellectual Property
// License Terms. US 8,019,788, US 2011/0199382 and corresponding foreign patents are licensed royalty-free under the
// Siemens JT Data Format Reference Patent Clarification Notice. JT and Parasolid are trademarks of Siemens; they are
// named here only to identify the format. This software is not endorsed by or affiliated with Siemens.
import { fail, type JTReader } from './file.js';

const NULL_CODEC = 0,
  BITLENGTH = 1,
  ARITHMETIC = 3,
  CHOPPER = 4,
  MOVE_TO_FRONT = 5,
  ESCAPE = -2;

/** Bits of a code text, the most significant bit of each U32 first; zeros past the end, as the decoders expect. */
class CodeBits {
  at = 0;
  constructor(readonly words: Uint32Array) {}
  bit(): number {
    const i = this.at++;
    return i >>> 5 < this.words.length ? (this.words[i >>> 5] >>> (31 - (i & 31))) & 1 : 0;
  }
  /** `n` (0 to 32) bits as an unsigned number. */
  bits(n: number): number {
    let v = 0;
    for (let i = 0; i < n; i++) v = v * 2 + this.bit();
    return v;
  }
}

/** Bit fields packed into bytes, most significant bit first (probability context tables). */
class ByteBits {
  private bit = 0;
  constructor(readonly r: JTReader) {}
  bits(n: number): number {
    let v = 0;
    for (let i = 0; i < n; i++) {
      if (this.r.at >= this.r.end) fail('probability contexts run past the data');
      v = v * 2 + ((this.r.bytes[this.r.at] >>> (7 - this.bit)) & 1);
      if (++this.bit === 8) {
        this.bit = 0;
        this.r.at++;
      }
    }
    return v;
  }
  /** Skips to the next byte boundary. */
  align() {
    if (this.bit) {
      this.bit = 0;
      this.r.at++;
    }
  }
}

/** One probability context table: entries in order with running counts. */
interface Context {
  readonly symbol: Int32Array;
  readonly count: Uint32Array;
  readonly cumulative: Uint32Array;
  readonly value: Int32Array;
  readonly next: Uint8Array;
  readonly total: number;
}

function context(n: number, read: (i: number) => [number, number, number, number]): Context {
  const symbol = new Int32Array(n),
    count = new Uint32Array(n),
    cumulative = new Uint32Array(n),
    value = new Int32Array(n),
    next = new Uint8Array(n);
  let total = 0;
  for (let i = 0; i < n; i++) {
    const [s, c, v, x] = read(i);
    symbol[i] = s;
    count[i] = c;
    cumulative[i] = total;
    value[i] = v;
    next[i] = x;
    total += c;
  }
  if (total === 0 || total > 0xffff) fail(`probability context total ${total}`);
  return { symbol, count, cumulative, value, next, total };
}

/** Int32 Probability Contexts Mk. 2: one table. */
function contexts2(r: JTReader): Context {
  const b = new ByteBits(r),
    entries = b.bits(16),
    symbolBits = b.bits(6),
    countBits = b.bits(6),
    valueBits = b.bits(6),
    min = b.bits(32) | 0;
  const table = context(entries, () => [b.bits(symbolBits) - 2, b.bits(countBits), (b.bits(valueBits) + min) | 0, 0]);
  b.align();
  return table;
}

/**
 * The JT 10 probability context (ISO 14306 13.1.1): U{16} entry count, U{6} occurrence count bits, U{7} value bits,
 * I{32} minimum value, then per entry an escape flag (U{1}), the count and the value less the minimum.
 */
function contexts3(r: JTReader): Context {
  const b = new ByteBits(r),
    entries = b.bits(16),
    countBits = b.bits(6),
    valueBits = b.bits(7),
    min = b.bits(32) | 0;
  const table = context(entries, () => [b.bits(1) ? ESCAPE : 0, b.bits(countBits), (b.bits(valueBits) + min) | 0, 0]);
  b.align();
  return table;
}

/**
 * Arithmetic decoding (a 16-bit range coder with underflow bits) of `symbols` symbols through the context tables; an
 * escape symbol in table 0 takes the next out-of-band value.
 */
function arithmetic(words: Uint32Array, tables: Context[], symbols: number, oob: Int32Array): Int32Array {
  const b = new CodeBits(words),
    out: number[] = [];
  let code = b.bits(16),
    low = 0,
    high = 0xffff,
    table = 0,
    o = 0;
  for (let n = 0; n < symbols; n++) {
    const c = tables[table] ?? fail(`probability context ${table} does not exist`),
      scaled = Math.floor((((code - low + 1) * c.total - 1) >>> 0) / (high - low + 1)) & 0xffff;
    // The entry whose running count range holds the scaled code.
    let lo = 0,
      hi = c.count.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >>> 1;
      if (c.cumulative[mid] <= scaled) lo = mid;
      else hi = mid - 1;
    }
    if (scaled >= c.cumulative[lo] + c.count[lo]) fail('arithmetic code outside its context');
    const range = high - low + 1;
    high = (low + Math.floor((range * (c.cumulative[lo] + c.count[lo])) / c.total) - 1) & 0xffff;
    low = (low + Math.floor((range * c.cumulative[lo]) / c.total)) & 0xffff;
    for (;;) {
      if (~(high ^ low) & 0x8000) {
        // Top bits agree: shift them out.
      } else if (low & 0x4000 && !(high & 0x4000)) {
        code ^= 0x4000;
        low &= 0x3fff;
        high |= 0x4000;
      } else break;
      low = (low << 1) & 0xffff;
      high = ((high << 1) | 1) & 0xffff;
      code = ((code << 1) | b.bit()) & 0xffff;
    }
    if (c.symbol[lo] === ESCAPE) {
      if (table === 0) {
        if (o >= oob.length) fail('more escapes than out-of-band values');
        out.push(oob[o++]);
      }
    } else out.push(c.value[lo]);
    table = c.next[lo];
  }
  return Int32Array.from(out);
}

/**
 * Reads an Int32 Compressed Data Packet: Mk. 2 (JT 9.5 8.1.2), or with `jt10` the third generation (ISO 14306 13.1.1),
 * which adds the move-to-front codec, marks the escape entry of its context with a flag, and gives the out-of-band
 * packet only when the context has an escape entry.
 */
export function int32Packet(r: JTReader, jt10: boolean, depth = 0): Int32Array {
  if (depth > 8) fail('Int32 packets nested too deep');
  const count = r.i32();
  if (count < 0) fail(`Int32 packet of ${count} values`);
  if (count === 0) return new Int32Array(0);
  const codec = r.u8(),
    nested = () => int32Packet(r, jt10, depth + 1);
  if (codec === CHOPPER) {
    const chop = r.u8();
    if (chop === 0) {
      const values = nested();
      if (values.length !== count) fail(`chopped packet holds ${values.length} of ${count} values`);
      return values;
    }
    const bias = r.i32(),
      span = r.u8();
    if (chop > span || span > 32) fail(`chopper ${chop} of ${span} bits`);
    const msb = nested(),
      lsb = nested();
    if (msb.length !== count || lsb.length !== count) fail('chopped fields of different lengths');
    const out = new Int32Array(count),
      shift = span - chop;
    for (let i = 0; i < count; i++) out[i] = ((lsb[i] | (shift >= 32 ? 0 : msb[i] << shift)) + bias) | 0;
    return out;
  }
  if (codec === MOVE_TO_FRONT && jt10) return moveToFront(nested(), nested(), count);
  // The code text's length in bits, then its words: the files carry no separate word count.
  const bits = r.i32();
  if (bits < 0 || bits > r.left * 8) fail(`Int32 packet code text of ${bits} bits at byte ${r.at - 4}`);
  const words = new Uint32Array(Math.ceil(bits / 32));
  for (let i = 0; i < words.length; i++) words[i] = r.u32();
  if (codec === NULL_CODEC) {
    if (words.length < count) fail(`null-coded packet holds ${words.length} of ${count} values`);
    return new Int32Array(words.buffer, words.byteOffset, count);
  }
  if (codec === ARITHMETIC) {
    const table = jt10 ? contexts3(r) : contexts2(r),
      oob = !jt10 || table.symbol.includes(ESCAPE) ? nested() : new Int32Array(0),
      values = bits === 0 && oob.length === count ? oob : arithmetic(words, [table], count, oob);
    if (values.length !== count) fail(`Int32 packet decoded ${values.length} of ${count} values`);
    return values;
  }
  if (codec === BITLENGTH) return bitLength2(words, bits, count, jt10);
  return fail(`Int32 packet codec ${codec}`);
}

/**
 * The move-to-front codec: an offset into a window of the 16 latest values (the value moves to the front), or -1 for
 * the next new value, which enters at the front.
 */
function moveToFront(values: Int32Array, offsets: Int32Array, count: number): Int32Array {
  if (offsets.length !== count) fail(`move-to-front packet of ${offsets.length} offsets for ${count} values`);
  const out = new Int32Array(count),
    window: number[] = [];
  let next = 0;
  for (let i = 0; i < count; i++) {
    const o = offsets[i];
    let v: number;
    if (o < 0) {
      if (next >= values.length) fail('move-to-front offsets ask for more values than the packet holds');
      v = values[next++];
    } else {
      if (o >= window.length) fail(`move-to-front offset ${o} past a window of ${window.length}`);
      v = window[o];
      window.splice(o, 1);
    }
    window.unshift(v);
    if (window.length > 16) window.pop();
    out[i] = v;
  }
  return out;
}

/** Bits needed for `x` as an unsigned number. */
const bitsize = (x: number) => 32 - Math.clz32(x);

/**
 * Bit-length decoding, as real files write it (the JT 9.5 text leaves it undefined and the JT 10 text part-defined).
 * A tag bit picks the scheme. Fixed width (0): the minimum and maximum, then each value less the minimum in
 * bitsize(max - min) bits. Variable width (1): the mean, then blocks of a signed width change (repeated while it is at
 * either end of its range), a run length and the run's values less the mean, signed, in the current width. JT 9.5
 * stores the minimum and maximum as their bit counts (U{6} each) and then the two values, and the mean as an I32
 * followed by the bits of a width change and of a run length (U{3} each, 4 and 4 in the files seen); JT 10 stores each
 * of those values in 4-bit groups, low group first, each followed by a bit that says another follows, sign-extended,
 * and always uses 4-bit width changes and run lengths.
 */
function bitLength2(words: Uint32Array, bits: number, count: number, jt10: boolean): Int32Array {
  const b = new CodeBits(words),
    out = new Int32Array(count),
    signed = (n: number) => (n === 0 ? 0 : n >= 32 ? b.bits(32) | 0 : (b.bits(n) << (32 - n)) >> (32 - n)),
    nibbles = () => {
      let v = 0,
        n = 0;
      do {
        v = (v | (b.bits(4) << n)) >>> 0;
        n += 4;
      } while (b.bit() && n < 32);
      return n >= 32 ? v | 0 : (v << (32 - n)) >> (32 - n);
    };
  if (b.bit() === 0) {
    const minBits = jt10 ? 0 : b.bits(6),
      maxBits = jt10 ? 0 : b.bits(6),
      min = jt10 ? nibbles() : signed(minBits),
      max = jt10 ? nibbles() : signed(maxBits),
      width = bitsize((max - min) >>> 0);
    for (let i = 0; i < count; i++) out[i] = (b.bits(width) + min) | 0;
  } else {
    const mean = jt10 ? nibbles() : signed(32),
      deltaBits = jt10 ? 4 : b.bits(3),
      runBits = jt10 ? 4 : b.bits(3),
      up = 2 ** (deltaBits - 1) - 1,
      down = -(2 ** (deltaBits - 1));
    if (deltaBits === 0 || runBits === 0) fail(`bit-length blocks of ${deltaBits} and ${runBits} bits`);
    let width = 0;
    for (let i = 0; i < count; ) {
      let delta: number;
      do {
        delta = signed(deltaBits);
        width += delta;
      } while (delta === up || delta === down);
      if (width < 0 || width > 32) fail(`bit-length field width ${width}`);
      if (b.at > bits) fail(`bit-length code text of ${bits} bits holds ${i} of ${count} values`);
      const run = b.bits(runBits);
      for (let k = 0; k < run && i < count; k++, i++) out[i] = (signed(width) + mean) | 0;
    }
  }
  if (b.at > bits) fail(`bit-length code text of ${bits} bits read to bit ${b.at}`);
  return out;
}

/** Residual predictors (Appendix C 1.3). */
export const Predictor = {
  Lag1: 0,
  Lag2: 1,
  Stride1: 2,
  Stride2: 3,
  StripIndex: 4,
  Ramp: 5,
  Xor1: 6,
  Xor2: 7,
  None: 8,
} as const;
export type Predictor = (typeof Predictor)[keyof typeof Predictor];

/** Rebuilds values from predictor residuals: the first four are primers, the rest residual plus (or xor) prediction. */
export function unpack(residuals: Int32Array, predictor: Predictor): Int32Array {
  if (predictor === Predictor.None) return residuals;
  const v = new Int32Array(residuals.length);
  for (let i = 0; i < v.length; i++) {
    if (i < 4) {
      v[i] = residuals[i];
      continue;
    }
    const v1 = v[i - 1],
      v2 = v[i - 2],
      v4 = v[i - 4];
    let p: number;
    switch (predictor) {
      case Predictor.Lag2:
      case Predictor.Xor2:
        p = v2;
        break;
      case Predictor.Stride1:
        p = v1 + (v1 - v2);
        break;
      case Predictor.Stride2:
        p = v2 + (v2 - v4);
        break;
      case Predictor.StripIndex:
        p = v2 - v4 < 8 && v2 - v4 > -8 ? v2 + (v2 - v4) : v2 + 2;
        break;
      case Predictor.Ramp:
        p = i;
        break;
      default:
        p = v1;
    }
    v[i] = predictor === Predictor.Xor1 || predictor === Predictor.Xor2 ? residuals[i] ^ p : (residuals[i] + p) | 0;
  }
  return v;
}

/** Bob Jenkins' 1996 mix of three 32-bit values (Appendix D). */
function mix(s: Uint32Array) {
  let [a, b, c] = s;
  a = ((a - b - c) ^ (c >>> 13)) >>> 0;
  b = ((b - c - a) ^ (a << 8)) >>> 0;
  c = ((c - a - b) ^ (b >>> 13)) >>> 0;
  a = ((a - b - c) ^ (c >>> 12)) >>> 0;
  b = ((b - c - a) ^ (a << 16)) >>> 0;
  c = ((c - a - b) ^ (b >>> 5)) >>> 0;
  a = ((a - b - c) ^ (c >>> 3)) >>> 0;
  b = ((b - c - a) ^ (a << 10)) >>> 0;
  c = ((c - a - b) ^ (b >>> 15)) >>> 0;
  s[0] = a;
  s[1] = b;
  s[2] = c;
}

/**
 * The format's hash of 32-bit words (Appendix D `hash32`, Jenkins' `hash2`): the words taken three at a time, then
 * the length folded in, counted in words as real files do.
 */
export function hash32(words: ArrayLike<number>, seed: number): number {
  const s = new Uint32Array([0x9e3779b9, 0x9e3779b9, seed]),
    n = words.length;
  let k = 0;
  for (; n - k >= 3; k += 3) {
    s[0] += words[k];
    s[1] += words[k + 1];
    s[2] += words[k + 2];
    mix(s);
  }
  s[2] += n;
  if (n - k === 2) s[1] += words[k + 1];
  if (n - k >= 1) s[0] += words[k];
  mix(s);
  return s[2];
}

/** The format's hash of 16-bit values (Appendix D `hash16`): two to a word, the length counted in values. */
export function hash16(values: ArrayLike<number>, seed: number): number {
  const s = new Uint32Array([0x9e3779b9, 0x9e3779b9, seed]),
    n = values.length,
    v = (i: number) => values[i] & 0xffff;
  let k = 0;
  for (; n - k >= 6; k += 6) {
    s[0] += v(k) + v(k + 1) * 65536;
    s[1] += v(k + 2) + v(k + 3) * 65536;
    s[2] += v(k + 4) + v(k + 5) * 65536;
    mix(s);
  }
  s[2] += n;
  const left = n - k;
  if (left >= 5) s[2] += v(k + 4) * 65536;
  if (left >= 4) s[1] += v(k + 3) * 65536;
  if (left >= 3) s[1] += v(k + 2);
  if (left >= 2) s[0] += v(k + 1) * 65536;
  if (left >= 1) s[0] += v(k);
  mix(s);
  return s[2];
}
