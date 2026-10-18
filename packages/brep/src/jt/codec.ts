// JT integer coding, from the JT File Format Reference 9.5: Int32 Compressed Data Packets Mk. 2 (8.1.2, used by JT 9
// meshes) with the arithmetic codec (8.2.3, Appendix C 3.2) and the chopper, the residual predictors (Appendix C 1.3),
// and the lookup hash the format stores to check decoded data (Appendix D). Mk. 1 packets, with the bit-length codec,
// appear only in the JT B-rep, wireframe and ULP segments, which are not read; their decoder is in commit 2c41f76.
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

/** Reads an Int32 Compressed Data Packet Mk. 2 (JT 9.5 8.1.2). */
export function int32Packet2(r: JTReader, depth = 0): Int32Array {
  if (depth > 8) fail('Int32 Mk. 2 packets nested too deep');
  const count = r.i32();
  if (count < 0) fail(`Int32 Mk. 2 packet of ${count} values`);
  if (count === 0) return new Int32Array(0);
  const codec = r.u8();
  if (codec === CHOPPER) {
    const chop = r.u8();
    if (chop === 0) {
      const values = int32Packet2(r, depth + 1);
      if (values.length !== count) fail(`chopped packet holds ${values.length} of ${count} values`);
      return values;
    }
    const bias = r.i32(),
      span = r.u8();
    if (chop > span || span > 32) fail(`chopper ${chop} of ${span} bits`);
    const msb = int32Packet2(r, depth + 1),
      lsb = int32Packet2(r, depth + 1);
    if (msb.length !== count || lsb.length !== count) fail('chopped fields of different lengths');
    const out = new Int32Array(count),
      shift = span - chop;
    for (let i = 0; i < count; i++) out[i] = ((lsb[i] | (shift >= 32 ? 0 : msb[i] << shift)) + bias) | 0;
    return out;
  }
  const bits = r.i32(),
    words = r.vecU32();
  if (codec === NULL_CODEC) {
    if (words.length < count) fail(`null-coded packet holds ${words.length} of ${count} values`);
    return new Int32Array(words.buffer, words.byteOffset, count);
  }
  if (codec === ARITHMETIC) {
    const table = contexts2(r),
      oob = int32Packet2(r, depth + 1),
      values = bits === 0 && oob.length === count ? oob : arithmetic(words, [table], count, oob);
    if (values.length !== count) fail(`Int32 Mk. 2 packet decoded ${values.length} of ${count} values`);
    return values;
  }
  if (codec === BITLENGTH)
    throw new RangeError(
      'JT bit-length Mk. 2 coding is not supported yet (the published text leaves part of it undefined); the file needs another JT exporter or version',
    );
  return fail(`Int32 Mk. 2 packet codec ${codec}`);
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
 * The format's hash of 32-bit words (Appendix D `hash32`): Jenkins' hash of the words' little-endian bytes, taken three
 * words at a time, with the byte length folded in.
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
  s[2] += n * 4;
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
