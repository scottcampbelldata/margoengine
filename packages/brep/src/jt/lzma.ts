// LZMA decoder for JT 10 segments (the 7-Zip dictionary coder), written from the LZMA format: a binary range coder
// over adaptive 11-bit probabilities, literals coded per position and previous byte (and against the byte at the last
// match distance after a match), lengths in three tiers, distances by slot with direct and aligned low bits, four
// repeat distances and the 12-state history machine.

const corrupt = (what: string): never => {
  throw new TypeError(`Invalid JT file: corrupt LZMA data (${what})`);
};

const PROB_INIT = 1024,
  STATES = 12,
  POS_BITS_MAX = 4,
  END_POS_MODEL = 14,
  FULL_DISTANCES = 128,
  ALIGN_BITS = 4,
  MATCH_MIN = 2;

class RangeDecoder {
  range = 0xffffffff;
  code = 0;
  at: number;
  constructor(
    readonly input: Uint8Array,
    start: number,
  ) {
    if (input[start] !== 0) corrupt('range coder start byte');
    this.at = start + 1;
    for (let i = 0; i < 4; i++) this.code = this.code * 256 + this.byte();
    if (this.code === this.range) corrupt('range coder start code');
  }
  byte(): number {
    if (this.at >= this.input.length) corrupt('unexpected end');
    return this.input[this.at++];
  }
  normalize() {
    if (this.range < 0x1000000) {
      this.range *= 256;
      this.code = this.code * 256 + this.byte();
    }
  }
  bit(probs: Uint16Array, i: number): number {
    const p = probs[i],
      bound = (this.range >>> 11) * p;
    let bit: number;
    if (this.code < bound) {
      this.range = bound;
      probs[i] = p + ((2048 - p) >> 5);
      bit = 0;
    } else {
      this.range -= bound;
      this.code -= bound;
      probs[i] = p - (p >> 5);
      bit = 1;
    }
    this.normalize();
    return bit;
  }
  direct(n: number): number {
    let result = 0;
    for (let i = 0; i < n; i++) {
      this.range = this.range >>> 1;
      let bit = 0;
      if (this.code >= this.range) {
        this.code -= this.range;
        bit = 1;
      }
      result = result * 2 + bit;
      this.normalize();
    }
    return result;
  }
  /** `n` bits through the bit tree at `base` (1-based node index), most significant first. */
  tree(probs: Uint16Array, base: number, n: number): number {
    let m = 1;
    for (let i = 0; i < n; i++) m = (m << 1) | this.bit(probs, base + m);
    return m - (1 << n);
  }
  /** As {@link tree}, least significant bit first. */
  reverse(probs: Uint16Array, base: number, n: number): number {
    let m = 1,
      symbol = 0;
    for (let i = 0; i < n; i++) {
      const bit = this.bit(probs, base + m);
      m = (m << 1) | bit;
      symbol |= bit << i;
    }
    return symbol;
  }
}

/** A length coder: choice bits, then 3 low bits per position state, 3 middle bits per position state, or 8 high bits. */
class LengthDecoder {
  readonly probs: Uint16Array;
  constructor(readonly posStates: number) {
    // [choice, choice2] [low: posStates × 8] [mid: posStates × 8] [high: 256]
    this.probs = new Uint16Array(2 + posStates * 16 + 256).fill(PROB_INIT);
  }
  decode(rc: RangeDecoder, posState: number): number {
    const p = this.probs;
    if (rc.bit(p, 0) === 0) return rc.tree(p, 2 + posState * 8, 3);
    if (rc.bit(p, 1) === 0) return 8 + rc.tree(p, 2 + this.posStates * 8 + posState * 8, 3);
    return 16 + rc.tree(p, 2 + this.posStates * 16, 8);
  }
}

/** The LZMA decoder's state: output (the dictionary), adaptive probabilities, the history state and repeat distances. */
class Lzma {
  out: Uint8Array;
  pos = 0;
  /** Where the dictionary last restarted: no match reaches before it. */
  base = 0;
  private lc = 0;
  private lp = 0;
  private pb = 0;
  private literal = new Uint16Array(0);
  private readonly isMatch = new Uint16Array(STATES << POS_BITS_MAX);
  private readonly isRep = new Uint16Array(STATES);
  private readonly isRepG0 = new Uint16Array(STATES);
  private readonly isRepG1 = new Uint16Array(STATES);
  private readonly isRepG2 = new Uint16Array(STATES);
  private readonly isRep0Long = new Uint16Array(STATES << POS_BITS_MAX);
  private readonly posSlot = new Uint16Array(4 << 6);
  private readonly posSpecial = new Uint16Array(1 + FULL_DISTANCES - END_POS_MODEL);
  private readonly align = new Uint16Array(1 << ALIGN_BITS);
  private lengths = new LengthDecoder(1);
  private repLengths = new LengthDecoder(1);
  private state = 0;
  private rep0 = 0;
  private rep1 = 0;
  private rep2 = 0;
  private rep3 = 0;

  constructor(
    capacity: number,
    private readonly limit: number,
  ) {
    this.out = new Uint8Array(Math.max(1024, Math.min(capacity, limit)));
  }
  private room(n: number) {
    if (this.pos + n <= this.out.length) return;
    if (this.pos + n > this.limit) corrupt(`output past ${this.limit} bytes`);
    const grown = new Uint8Array(Math.min(this.limit, Math.max(this.out.length * 2, this.pos + n)));
    grown.set(this.out.subarray(0, this.pos));
    this.out = grown;
  }
  /** New literal, position and length settings (lc, lp, pb), with a state reset. */
  properties(lc: number, lp: number, pb: number) {
    if (lc > 8 || lp > 4 || pb > 4) corrupt('bad properties');
    this.lc = lc;
    this.lp = lp;
    this.pb = pb;
    this.literal = new Uint16Array(0x300 << (lc + lp));
    this.lengths = new LengthDecoder(1 << pb);
    this.repLengths = new LengthDecoder(1 << pb);
    this.reset();
  }
  /** Probabilities back to even, history state and repeat distances to 0. */
  reset() {
    for (const p of [this.literal, this.isMatch, this.isRep, this.isRepG0, this.isRepG1, this.isRepG2, this.isRep0Long])
      p.fill(PROB_INIT);
    for (const p of [this.posSlot, this.posSpecial, this.align, this.lengths.probs, this.repLengths.probs])
      p.fill(PROB_INIT);
    this.state = this.rep0 = this.rep1 = this.rep2 = this.rep3 = 0;
  }
  /** Bytes stored as they are (an LZMA2 uncompressed chunk). */
  copy(bytes: Uint8Array) {
    this.room(bytes.length);
    this.out.set(bytes, this.pos);
    this.pos += bytes.length;
  }
  /** Decodes until the output reaches `end`, or an end marker when `end` is negative. */
  run(rc: RangeDecoder, end: number) {
    const pbMask = (1 << this.pb) - 1,
      lpMask = (1 << this.lp) - 1,
      lc = this.lc,
      literal = this.literal;
    if (end >= 0) this.room(end - this.pos);
    while (end < 0 || this.pos < end) {
      const pos = this.pos,
        posState = pos & pbMask,
        state = this.state;
      if (rc.bit(this.isMatch, (state << POS_BITS_MAX) + posState) === 0) {
        const previous = pos > this.base ? this.out[pos - 1] : 0,
          base = 0x300 * (((pos & lpMask) << lc) + (previous >> (8 - lc)));
        let symbol = 1;
        if (state >= 7) {
          if (this.rep0 >= pos - this.base) corrupt('match distance before start');
          let matchByte = this.out[pos - this.rep0 - 1];
          while (symbol < 0x100) {
            const matchBit = (matchByte >> 7) & 1;
            matchByte <<= 1;
            const bit = rc.bit(literal, base + ((1 + matchBit) << 8) + symbol);
            symbol = (symbol << 1) | bit;
            if (matchBit !== bit) break;
          }
        }
        while (symbol < 0x100) symbol = (symbol << 1) | rc.bit(literal, base + symbol);
        this.room(1);
        this.out[this.pos++] = symbol - 0x100;
        this.state = state < 4 ? 0 : state < 10 ? state - 3 : state - 6;
        continue;
      }
      let length: number;
      if (rc.bit(this.isRep, state) === 0) {
        length = this.lengths.decode(rc, posState);
        this.state = state < 7 ? 7 : 10;
        const distance = decodeDistance(rc, this.posSlot, this.posSpecial, this.align, length);
        if (distance === 0xffffffff) {
          if (end >= 0 && this.pos !== end) corrupt('end marker before the unpacked size');
          return;
        }
        this.rep3 = this.rep2;
        this.rep2 = this.rep1;
        this.rep1 = this.rep0;
        this.rep0 = distance;
      } else {
        if (pos === this.base) corrupt('repeat before any data');
        if (rc.bit(this.isRepG0, state) === 0) {
          if (rc.bit(this.isRep0Long, (state << POS_BITS_MAX) + posState) === 0) {
            this.state = state < 7 ? 9 : 11;
            this.room(1);
            this.out[pos] = this.out[pos - this.rep0 - 1];
            this.pos++;
            continue;
          }
        } else {
          let distance: number;
          if (rc.bit(this.isRepG1, state) === 0) distance = this.rep1;
          else {
            if (rc.bit(this.isRepG2, state) === 0) distance = this.rep2;
            else {
              distance = this.rep3;
              this.rep3 = this.rep2;
            }
            this.rep2 = this.rep1;
          }
          this.rep1 = this.rep0;
          this.rep0 = distance;
        }
        length = this.repLengths.decode(rc, posState);
        this.state = state < 7 ? 8 : 11;
      }
      length += MATCH_MIN;
      if (this.rep0 >= pos - this.base) corrupt('match distance before start');
      if (end >= 0 && pos + length > end) corrupt('match past the unpacked size');
      this.room(length);
      const out = this.out,
        back = this.rep0 + 1;
      for (let k = 0; k < length; k++) out[pos + k] = out[pos + k - back];
      this.pos = pos + length;
    }
  }
}

/**
 * Decodes an LZMA stream: properties byte and dictionary size, then the unpacked size (all ones when unknown, the
 * "alone" format) or straight into the coded data with an end marker. The range coder's first byte is always 0, which
 * tells the two apart. Throws a TypeError for malformed data or output past `limit` bytes.
 */
export function inflateLZMA(input: Uint8Array, limit = 1 << 30): Uint8Array {
  if (input.length < 10) corrupt('too short');
  let d = input[0];
  if (d >= 9 * 5 * 5) corrupt('bad properties');
  const lc = d % 9;
  d = (d / 9) | 0;
  const lp = d % 5,
    pb = (d / 5) | 0;
  const view = new DataView(input.buffer, input.byteOffset, input.byteLength);
  let start = 5,
    size = -1;
  if (input.length >= 18 && input[13] === 0) {
    const low = view.getUint32(5, true),
      high = view.getUint32(9, true),
      known = !(low === 0xffffffff && high === 0xffffffff);
    if (!known || high < 256) {
      start = 13;
      size = known ? high * 2 ** 32 + low : -1;
      if (size > limit) corrupt(`unpacked size ${size} past ${limit} bytes`);
    }
  }
  const lz = new Lzma(size >= 0 ? size : input.length * 4, limit);
  lz.properties(lc, lp, pb);
  lz.run(new RangeDecoder(input, start), size);
  return lz.out.subarray(0, lz.pos);
}

const XZ_MAGIC = [0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00];

/** Whether `input` starts with the XZ container's magic bytes. */
export const isXZ = (input: Uint8Array): boolean => XZ_MAGIC.every((b, i) => input[i] === b);

/**
 * Decodes an XZ container (the .xz format: stream header, blocks of LZMA2 data each with its check, index, footer;
 * checks are not verified) holding LZMA2 chunks: uncompressed chunks, and LZMA chunks that may reset the dictionary,
 * the state or the literal and position settings, each range-coded on its own. Throws a TypeError for malformed data,
 * a filter other than LZMA2 alone, or output past `limit` bytes.
 */
export function inflateXZ(input: Uint8Array, limit = 1 << 30): Uint8Array {
  if (input.length < 24 || !isXZ(input)) corrupt('no XZ stream header');
  const check = input[7] & 15,
    checkSize = check === 0 ? 0 : 4 << Math.floor((check - 1) / 3),
    lz = new Lzma(input.length * 4, limit);
  let at = 12;
  const varint = () => {
    let v = 0;
    for (let shift = 0; shift < 63; shift += 7) {
      if (at >= input.length) corrupt('unexpected end');
      const b = input[at++];
      v += (b & 0x7f) * 2 ** shift;
      if (!(b & 0x80)) return v;
    }
    return corrupt('integer too long');
  };
  for (;;) {
    if (at >= input.length) corrupt('unexpected end');
    if (input[at] === 0) break; // the index follows the last block
    const blockStart = at,
      headerEnd = at + (input[at] + 1) * 4,
      flags = input[at + 1];
    at += 2;
    if (flags & 0x40) varint(); // compressed size
    if (flags & 0x80) varint(); // uncompressed size
    const filters = (flags & 3) + 1;
    for (let i = 0; i < filters; i++) {
      const id = varint(),
        size = varint();
      if (id !== 0x21 || filters !== 1) corrupt(`XZ filter ${id.toString(16)} (only LZMA2 alone is read)`);
      at += size;
    }
    at = headerEnd;
    let needProperties = true;
    for (;;) {
      if (at >= input.length) corrupt('unexpected end');
      const control = input[at++];
      if (control === 0) break;
      if (control === 1 || control === 2) {
        if (control === 1) lz.base = lz.pos;
        const size = ((input[at] << 8) | input[at + 1]) + 1;
        at += 2;
        if (at + size > input.length) corrupt('chunk past the end');
        lz.copy(input.subarray(at, at + size));
        at += size;
        continue;
      }
      if (control < 0x80) corrupt(`LZMA2 control byte ${control}`);
      const unpacked = (control & 0x1f) * 65536 + ((input[at] << 8) | input[at + 1]) + 1,
        packed = ((input[at + 2] << 8) | input[at + 3]) + 1,
        reset = (control >> 5) & 3;
      at += 4;
      if (reset === 3) lz.base = lz.pos;
      if (reset >= 2) {
        let d = input[at++];
        if (d >= 9 * 5 * 5) corrupt('bad properties');
        const lc = d % 9;
        d = (d / 9) | 0;
        if (lc + (d % 5) > 4) corrupt('LZMA2 literal settings over 4 bits');
        lz.properties(lc, d % 5, (d / 5) | 0);
        needProperties = false;
      } else if (needProperties) corrupt('LZMA2 chunk before its properties');
      else if (reset === 1) lz.reset();
      if (at + packed > input.length) corrupt('chunk past the end');
      lz.run(new RangeDecoder(input.subarray(at, at + packed), 0), lz.pos + unpacked);
      at += packed;
    }
    // Block padding to a multiple of four bytes, then the check.
    at += (4 - ((at - blockStart) % 4)) % 4;
    at += checkSize;
  }
  return lz.out.subarray(0, lz.pos);
}

function decodeDistance(
  rc: RangeDecoder,
  posSlot: Uint16Array,
  posSpecial: Uint16Array,
  align: Uint16Array,
  length: number,
): number {
  const slot = rc.tree(posSlot, Math.min(length, 3) << 6, 6);
  if (slot < 4) return slot;
  const directBits = (slot >> 1) - 1;
  let distance = (2 + (slot & 1)) * 2 ** directBits;
  if (slot < END_POS_MODEL) return distance + rc.reverse(posSpecial, distance - slot, directBits);
  distance += rc.direct(directBits - ALIGN_BITS) * (1 << ALIGN_BITS);
  return distance + rc.reverse(align, 0, ALIGN_BITS);
}
