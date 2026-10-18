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
  if (input.length >= 18 && input[13] === 0) {
    const low = view.getUint32(5, true),
      high = view.getUint32(9, true),
      known = !(low === 0xffffffff && high === 0xffffffff),
      size = known ? high * 2 ** 32 + low : -1;
    if (!known || high < 256) {
      if (known && size > limit) corrupt(`unpacked size ${size} past ${limit} bytes`);
      return decodeLZMA(input, 13, lc, lp, pb, size, limit);
    }
  }
  return decodeLZMA(input, 5, lc, lp, pb, -1, limit);
}

function decodeLZMA(input: Uint8Array, start: number, lc: number, lp: number, pb: number, size: number, limit: number) {
  let out = new Uint8Array(size >= 0 ? size : Math.max(1 << 16, input.length * 4)),
    pos = 0;
  const grow = () => {
    if (out.length >= limit) corrupt(`output past ${limit} bytes`);
    const grown = new Uint8Array(Math.min(limit, out.length * 2));
    grown.set(out);
    out = grown;
  };
  const rc = new RangeDecoder(input, start),
    posStates = 1 << pb,
    literal = new Uint16Array(0x300 << (lc + lp)).fill(PROB_INIT),
    isMatch = new Uint16Array(STATES << POS_BITS_MAX).fill(PROB_INIT),
    isRep = new Uint16Array(STATES).fill(PROB_INIT),
    isRepG0 = new Uint16Array(STATES).fill(PROB_INIT),
    isRepG1 = new Uint16Array(STATES).fill(PROB_INIT),
    isRepG2 = new Uint16Array(STATES).fill(PROB_INIT),
    isRep0Long = new Uint16Array(STATES << POS_BITS_MAX).fill(PROB_INIT),
    posSlot = new Uint16Array(4 << 6).fill(PROB_INIT),
    posSpecial = new Uint16Array(1 + FULL_DISTANCES - END_POS_MODEL).fill(PROB_INIT),
    align = new Uint16Array(1 << ALIGN_BITS).fill(PROB_INIT),
    lengths = new LengthDecoder(posStates),
    repLengths = new LengthDecoder(posStates),
    pbMask = posStates - 1,
    lpMask = (1 << lp) - 1;
  let state = 0,
    rep0 = 0,
    rep1 = 0,
    rep2 = 0,
    rep3 = 0;
  const done = () => size >= 0 && pos >= size;
  while (!done()) {
    const posState = pos & pbMask;
    if (rc.bit(isMatch, (state << POS_BITS_MAX) + posState) === 0) {
      const previous = pos > 0 ? out[pos - 1] : 0,
        base = 0x300 * (((pos & lpMask) << lc) + (previous >> (8 - lc)));
      let symbol = 1;
      if (state >= 7) {
        if (rep0 >= pos) corrupt('match distance before start');
        let matchByte = out[pos - rep0 - 1];
        while (symbol < 0x100) {
          const matchBit = (matchByte >> 7) & 1;
          matchByte <<= 1;
          const bit = rc.bit(literal, base + ((1 + matchBit) << 8) + symbol);
          symbol = (symbol << 1) | bit;
          if (matchBit !== bit) break;
        }
      }
      while (symbol < 0x100) symbol = (symbol << 1) | rc.bit(literal, base + symbol);
      if (pos >= out.length) grow();
      out[pos++] = symbol - 0x100;
      state = state < 4 ? 0 : state < 10 ? state - 3 : state - 6;
      continue;
    }
    let length: number;
    if (rc.bit(isRep, state) === 0) {
      length = lengths.decode(rc, posState);
      state = state < 7 ? 7 : 10;
      const distance = decodeDistance(rc, posSlot, posSpecial, align, length);
      if (distance === 0xffffffff) break;
      rep3 = rep2;
      rep2 = rep1;
      rep1 = rep0;
      rep0 = distance;
    } else {
      if (pos === 0) corrupt('repeat before any data');
      if (rc.bit(isRepG0, state) === 0) {
        if (rc.bit(isRep0Long, (state << POS_BITS_MAX) + posState) === 0) {
          state = state < 7 ? 9 : 11;
          if (pos >= out.length) grow();
          out[pos] = out[pos - rep0 - 1];
          pos++;
          continue;
        }
      } else {
        let distance: number;
        if (rc.bit(isRepG1, state) === 0) distance = rep1;
        else {
          if (rc.bit(isRepG2, state) === 0) distance = rep2;
          else {
            distance = rep3;
            rep3 = rep2;
          }
          rep2 = rep1;
        }
        rep1 = rep0;
        rep0 = distance;
      }
      length = repLengths.decode(rc, posState);
      state = state < 7 ? 8 : 11;
    }
    length += MATCH_MIN;
    if (rep0 >= pos) corrupt('match distance before start');
    if (size >= 0 && pos + length > size) corrupt('match past the unpacked size');
    while (pos + length > out.length) grow();
    for (let k = 0; k < length; k++, pos++) out[pos] = out[pos - rep0 - 1];
  }
  if (size >= 0 && pos !== size) corrupt(`ended after ${pos} of ${size} bytes`);
  return out.subarray(0, pos);
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
