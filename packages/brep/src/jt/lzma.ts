// LZMA decoding for JT 10 and 10.5 segments, written from Igor Pavlov's LZMA specification (the range decoder, the
// adaptive bit probabilities, literal and matched-literal coding, the length coder, distance slots with aligned bits,
// the four repeat distances, the 12-state machine and the end marker), from Lasse Collin's .xz file format document
// (stream header, block header, multibyte integers, filter flags, padding and check sizes), and from the LZMA2 chunk
// framing that xz and 7-Zip write. JT 10 stores a .lzma stream (13-byte header) or a bare 5-byte header; JT 10.5 wraps
// LZMA2 chunks in an XZ stream.
//
// The whole output serves as the dictionary, so there is no circular window: the dictionary size in the headers is read
// and ignored, and a distance reaching before byte 0 (or the last LZMA2 dictionary reset) is corrupt data.

/** Why decoding failed, as the TypeError every malformed stream throws. */
const corrupt = (what: string): never => {
  throw new TypeError(`Invalid JT file: corrupt LZMA data (${what})`);
};

// The 11-bit probability model: a probability of a 0 bit out of 2048, starting at one half, moving 1/32 of the way
// towards each decoded bit.
const PROB_ONE = 2048;
const PROB_HALF = 1024;
const ADAPT_SHIFT = 5;
/** The range is renormalised (one more input byte shifted in) whenever it falls below 2^24. */
const RANGE_FLOOR = 0x1000000;
/** The distance value that marks the end of the stream instead of a match. */
const END_MARKER = 0xffffffff;
const STATES = 12;
/** Probabilities indexed by (state, position state): 12 states × up to 2^4 position states. */
const STATE_POS = STATES << 4;
/** Distance slots from this one on code their middle bits directly and their low 4 bits through the aligned tree. */
const FIRST_ALIGNED_SLOT = 14;
const ALIGN_BITS = 4;
/** Literal probabilities per (previous byte, position) context: 0x100 plain, then 0x200 for the matched form. */
const LITERAL_CONTEXT = 0x300;

// The length coder, one for matches and one for repeats: a choice bit (lengths 0-7 from a 3-bit tree per position
// state), a second choice bit (8-15 from another such tree) or an 8-bit tree (16-271). The minimum match is 2.
const LEN_CHOICE = 0;
const LEN_CHOICE2 = 1;
const LEN_LOW = 2;
const LEN_MID = LEN_LOW + (16 << 3);
const LEN_HIGH = LEN_MID + (16 << 3);
const LEN_SIZE = LEN_HIGH + 256;
const MIN_MATCH = 2;

// Offsets of every fixed-size probability group in one table. The extra-bit trees of slots 4-13 sit back to back, each
// with 2^bits entries (the root at index 1, so entry 0 is unused).
const SLOT_EXTRA_AT: number[] = [];
let slotExtraSize = 0;
for (let slot = 4; slot < FIRST_ALIGNED_SLOT; slot++) {
  SLOT_EXTRA_AT[slot] = slotExtraSize;
  slotExtraSize += 1 << ((slot >> 1) - 1);
}
const P_IS_MATCH = 0;
const P_IS_REP = P_IS_MATCH + STATE_POS;
const P_REP_G0 = P_IS_REP + STATES;
const P_REP_G1 = P_REP_G0 + STATES;
const P_REP_G2 = P_REP_G1 + STATES;
const P_REP0_LONG = P_REP_G2 + STATES;
/** Four 6-bit slot trees, chosen by min(length − 2, 3). */
const P_SLOT = P_REP0_LONG + STATE_POS;
const P_SLOT_EXTRA = P_SLOT + 4 * 64;
const P_ALIGN = P_SLOT_EXTRA + slotExtraSize;
const P_MATCH_LEN = P_ALIGN + (1 << ALIGN_BITS);
const P_REP_LEN = P_MATCH_LEN + LEN_SIZE;
const P_TOTAL = P_REP_LEN + LEN_SIZE;

// The state after each kind of symbol. States 0-6 follow a literal, 7-11 a match or repeat; the matched-literal form
// applies from 7 on.
const AFTER_LITERAL = Uint8Array.from({ length: STATES }, (_, s) => (s < 4 ? 0 : s < 10 ? s - 3 : s - 6));
const AFTER_MATCH = (s: number) => (s < 7 ? 7 : 10);
const AFTER_REP = (s: number) => (s < 7 ? 8 : 11);
const AFTER_SHORT_REP = (s: number) => (s < 7 ? 9 : 11);

/**
 * The growing output, which is also the dictionary. Its capacity doubles on demand (Margo's choice: amortised
 * linear copying) up to `limit`.
 */
class Output {
  bytes: Uint8Array;
  length = 0;
  /** Where the current dictionary starts: 0, or the output length at the last LZMA2 dictionary reset. */
  base = 0;
  readonly limit: number;
  constructor(capacity: number, limit: number) {
    this.bytes = new Uint8Array(capacity);
    this.limit = limit;
  }
  /** Makes room for `count` more bytes. */
  reserve(count: number): void {
    const need = this.length + count;
    if (need <= this.bytes.length) return;
    if (need > this.limit) corrupt(`output past ${this.limit} bytes`);
    const grown = new Uint8Array(Math.min(this.limit, Math.max(need, this.bytes.length * 2)));
    grown.set(this.bytes.subarray(0, this.length));
    this.bytes = grown;
  }
  result(): Uint8Array {
    return this.bytes.subarray(0, this.length);
  }
}

/** Starting capacity: the known size, else a few times the input, but at least 1 KiB and at most `limit`. */
const startCapacity = (inputLength: number, limit: number): number => Math.min(limit, Math.max(1024, inputLength * 4));

/** The arithmetic (range) decoder over `src[at, end)`. */
class RangeDecoder {
  private range = 0xffffffff;
  private code = 0;
  private readonly src: Uint8Array;
  private at: number;
  private readonly end: number;
  constructor(src: Uint8Array, at: number, end: number) {
    this.src = src;
    this.at = at;
    this.end = end;
    if (this.next() !== 0) corrupt('range coder start byte');
    for (let i = 0; i < 4; i++) this.code = ((this.code << 8) | this.next()) >>> 0;
    if (this.code === this.range) corrupt('range coder start code');
  }
  private next(): number {
    if (this.at >= this.end) corrupt('unexpected end');
    return this.src[this.at++];
  }
  /** One bit with the adaptive probability `p[i]`, which is updated. */
  bit(p: Uint16Array, i: number): number {
    const prob = p[i],
      split = (this.range >>> 11) * prob;
    let bit: number;
    if (this.code < split) {
      this.range = split;
      p[i] = prob + ((PROB_ONE - prob) >> ADAPT_SHIFT);
      bit = 0;
    } else {
      this.range -= split;
      this.code -= split;
      p[i] = prob - (prob >> ADAPT_SHIFT);
      bit = 1;
    }
    if (this.range < RANGE_FLOOR) {
      this.range = (this.range * 256) >>> 0;
      this.code = ((this.code << 8) | this.next()) >>> 0;
    }
    return bit;
  }
  /** `count` bits at a fixed probability of one half, most significant first. */
  direct(count: number): number {
    let value = 0;
    for (let i = 0; i < count; i++) {
      this.range >>>= 1;
      let bit = 0;
      if (this.code >= this.range) {
        this.code -= this.range;
        bit = 1;
      }
      value = value * 2 + bit;
      if (this.range < RANGE_FLOOR) {
        this.range = (this.range * 256) >>> 0;
        this.code = ((this.code << 8) | this.next()) >>> 0;
      }
    }
    return value;
  }
  /** A `bits`-wide symbol from the binary tree rooted at `p[at + 1]`, most significant bit first. */
  tree(p: Uint16Array, at: number, bits: number): number {
    let node = 1;
    for (let i = 0; i < bits; i++) node = (node << 1) | this.bit(p, at + node);
    return node - (1 << bits);
  }
  /** As `tree`, but the bits come least significant first. */
  treeReverse(p: Uint16Array, at: number, bits: number): number {
    let node = 1,
      value = 0;
    for (let i = 0; i < bits; i++) {
      const b = this.bit(p, at + node);
      node = (node << 1) | b;
      value |= b << i;
    }
    return value;
  }
}

/** The adaptive model: settings, probabilities, state and repeat distances, which LZMA2 keeps across chunks. */
class Model {
  lc = 0;
  lp = 0;
  pb = 0;
  readonly probs = new Uint16Array(P_TOTAL);
  literals = new Uint16Array(0);
  state = 0;
  /** The four most recent distances, minus one, newest first. */
  readonly reps = [0, 0, 0, 0];

  /** Sets lc / lp / pb from a properties byte (values 225 and up are corrupt). */
  configure(byte: number): void {
    if (byte >= 9 * 5 * 5) corrupt('bad properties');
    this.lc = byte % 9;
    this.lp = Math.floor(byte / 9) % 5;
    this.pb = Math.floor(byte / 45);
    const size = LITERAL_CONTEXT << (this.lc + this.lp);
    if (this.literals.length !== size) this.literals = new Uint16Array(size);
  }

  /** Back to the starting probabilities, state 0 and zero repeat distances. */
  reset(): void {
    this.probs.fill(PROB_HALF);
    this.literals.fill(PROB_HALF);
    this.state = 0;
    this.reps.fill(0);
  }

  private length(rc: RangeDecoder, at: number, posState: number): number {
    const p = this.probs;
    if (rc.bit(p, at + LEN_CHOICE) === 0) return rc.tree(p, at + LEN_LOW + (posState << 3) - 1, 3);
    if (rc.bit(p, at + LEN_CHOICE2) === 0) return 8 + rc.tree(p, at + LEN_MID + (posState << 3) - 1, 3);
    return 16 + rc.tree(p, at + LEN_HIGH - 1, 8);
  }

  /** The distance (minus one) of a new match whose length minus 2 is `len`, or END_MARKER. */
  private distance(rc: RangeDecoder, len: number): number {
    const p = this.probs,
      slot = rc.tree(p, P_SLOT + Math.min(len, 3) * 64 - 1, 6);
    if (slot < 4) return slot;
    const bits = (slot >> 1) - 1,
      top = (2 | (slot & 1)) * 2 ** bits;
    if (slot < FIRST_ALIGNED_SLOT) return top + rc.treeReverse(p, P_SLOT_EXTRA + SLOT_EXTRA_AT[slot] - 1, bits);
    return top + rc.direct(bits - ALIGN_BITS) * 16 + rc.treeReverse(p, P_ALIGN - 1, ALIGN_BITS);
  }

  /**
   * Decodes symbols into `out` until it holds `stop` bytes (a known size) or, with `stop` undefined, until the end
   * marker. Returns whether it ended on the end marker.
   */
  run(rc: RangeDecoder, out: Output, stop: number | undefined): boolean {
    const p = this.probs,
      lit = this.literals,
      reps = this.reps,
      posMask = (1 << this.pb) - 1,
      lpMask = (1 << this.lp) - 1,
      lc = this.lc;
    let state = this.state;
    try {
      while (stop === undefined || out.length < stop) {
        const pos = out.length - out.base,
          posState = pos & posMask;
        if (rc.bit(p, P_IS_MATCH + (state << 4) + posState) === 0) {
          // A literal, coded in the context of the previous byte's top lc bits and the position's low lp bits.
          const prev = pos > 0 ? out.bytes[out.length - 1] : 0,
            at = LITERAL_CONTEXT * (((pos & lpMask) << lc) + (prev >> (8 - lc)));
          let symbol = 1;
          if (state >= 7) {
            // Matched literal: follow the byte at rep0 bit by bit until the first bit that differs from it.
            if (reps[0] >= pos) corrupt('match distance before start');
            let guide = out.bytes[out.length - reps[0] - 1];
            while (symbol < 0x100) {
              const g = (guide >> 7) & 1;
              guide <<= 1;
              const b = rc.bit(lit, at + ((1 + g) << 8) + symbol);
              symbol = (symbol << 1) | b;
              if (b !== g) break;
            }
          }
          while (symbol < 0x100) symbol = (symbol << 1) | rc.bit(lit, at + symbol);
          out.reserve(1);
          out.bytes[out.length++] = symbol & 0xff;
          state = AFTER_LITERAL[state];
          continue;
        }
        let len: number;
        if (rc.bit(p, P_IS_REP + state) === 0) {
          // A new match: the length, then the distance, which pushes the repeat distances back.
          len = this.length(rc, P_MATCH_LEN, posState);
          const dist = this.distance(rc, len);
          if (dist === END_MARKER) {
            if (stop !== undefined) corrupt('end marker before the unpacked size');
            return true;
          }
          reps[3] = reps[2];
          reps[2] = reps[1];
          reps[1] = reps[0];
          reps[0] = dist;
          state = AFTER_MATCH(state);
        } else {
          if (pos === 0) corrupt('repeat before any data');
          if (rc.bit(p, P_REP_G0 + state) === 0) {
            if (rc.bit(p, P_REP0_LONG + (state << 4) + posState) === 0) {
              // Short repeat: the one byte at rep0.
              if (reps[0] >= pos) corrupt('match distance before start');
              out.reserve(1);
              out.bytes[out.length] = out.bytes[out.length - reps[0] - 1];
              out.length++;
              state = AFTER_SHORT_REP(state);
              continue;
            }
          } else {
            // rep1, rep2 or rep3 moves to the front.
            let pick: number;
            if (rc.bit(p, P_REP_G1 + state) === 0) pick = 1;
            else pick = rc.bit(p, P_REP_G2 + state) === 0 ? 2 : 3;
            const dist = reps[pick];
            for (let i = pick; i > 0; i--) reps[i] = reps[i - 1];
            reps[0] = dist;
          }
          len = this.length(rc, P_REP_LEN, posState);
          state = AFTER_REP(state);
        }
        const count = len + MIN_MATCH,
          back = reps[0] + 1;
        if (back > pos) corrupt('match distance before start');
        if (stop !== undefined && out.length + count > stop) corrupt('match past the unpacked size');
        out.reserve(count);
        const bytes = out.bytes;
        // Front to back, one byte at a time, so a match may overlap the bytes it produces.
        for (let i = out.length, end = out.length + count; i < end; i++) bytes[i] = bytes[i - back];
        out.length += count;
      }
      return false;
    } finally {
      this.state = state;
    }
  }
}

/**
 * Decodes an LZMA stream as JT 10 stores it: properties byte and 4-byte dictionary size, then either an 8-byte unpacked
 * size (the .lzma "alone" header; all ones = unknown) or directly the range-coded data ending in an end marker.
 * Returns the decoded bytes (a view of exactly the produced length).
 * @param input - The compressed segment bytes.
 * @param limit - The most output bytes accepted (default 2^30).
 * @throws TypeError for malformed data or output past `limit` bytes (default 2^30).
 */
export function inflateLZMA(input: Uint8Array, limit = 1 << 30): Uint8Array {
  if (input.length < 10) corrupt('too short');
  const model = new Model();
  model.configure(input[0]);
  // The .lzma header has an 8-byte size after the dictionary size. Take it when the range coder's zero start byte
  // follows it and the size is plausible (unknown, or under 2^40); otherwise the data starts at byte 5.
  let size: number | undefined,
    start = 5;
  if (input.length >= 18 && input[13] === 0) {
    const view = new DataView(input.buffer, input.byteOffset, input.byteLength),
      low = view.getUint32(5, true),
      high = view.getUint32(9, true);
    if (low === 0xffffffff && high === 0xffffffff) start = 13;
    else if (high < 256) {
      start = 13;
      size = high * 2 ** 32 + low;
    }
  }
  if (size !== undefined && size > limit) corrupt(`unpacked size ${size} past ${limit} bytes`);
  model.reset();
  const out = new Output(size ?? startCapacity(input.length, limit), limit),
    rc = new RangeDecoder(input, start, input.length);
  model.run(rc, out, size);
  return out.result();
}

const XZ_MAGIC = [0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00];

/**
 * True when input starts with the XZ stream magic FD 37 7A 58 5A 00 (false for shorter input).
 * @param input - The bytes to test.
 */
export const isXZ = (input: Uint8Array): boolean =>
  input.length >= XZ_MAGIC.length && XZ_MAGIC.every((byte, i) => input[i] === byte);

/** The filter id that marks LZMA2 in an XZ block header. */
const FILTER_LZMA2 = 0x21;

/**
 * Decodes one XZ stream whose blocks each use the single filter LZMA2. Checks (CRC32/CRC64/SHA-256) and header CRCs are
 * not verified; index and footer are not read. Returns all blocks' output concatenated.
 * @param input - The XZ stream bytes.
 * @param limit - The most output bytes accepted (default 2^30).
 * @throws TypeError for malformed data, any other filter chain, or output past `limit` bytes (default 2^30).
 */
export function inflateXZ(input: Uint8Array, limit = 1 << 30): Uint8Array {
  if (input.length < 24 || !isXZ(input)) corrupt('no XZ stream header');
  const type = input[7] & 0x0f,
    checkSize = type === 0 ? 0 : 4 << Math.floor((type - 1) / 3),
    out = new Output(startCapacity(input.length, limit), limit),
    model = new Model();
  let at = 12;
  const byte = (): number => {
    if (at >= input.length) corrupt('unexpected end');
    return input[at++];
  };
  // A multibyte integer: 7 bits per byte, least significant first, the high bit meaning another byte follows.
  const varint = (): number => {
    let value = 0;
    for (let i = 0; i < 9; i++) {
      const b = byte();
      value += (b & 0x7f) * 2 ** (7 * i);
      if (b < 0x80) return value;
    }
    return corrupt('integer too long');
  };
  for (;;) {
    const blockStart = at,
      head = byte();
    if (head === 0) break; // the index indicator: no more blocks
    const headerEnd = blockStart + (head + 1) * 4,
      flags = byte(),
      filters = (flags & 3) + 1;
    if (flags & 0x40) varint(); // compressed size
    if (flags & 0x80) varint(); // uncompressed size
    const id = varint();
    if (filters !== 1 || id !== FILTER_LZMA2) corrupt(`XZ filter ${id.toString(16)} (only LZMA2 alone is read)`);
    varint(); // the size of the filter properties (LZMA2's dictionary size byte), not needed
    // Chunks start past the properties, the header padding and the header CRC32.
    at = decodeLZMA2(input, headerEnd, model, out);
    at = blockStart + Math.ceil((at - blockStart) / 4) * 4 + checkSize;
  }
  return out.result();
}

/** Decodes the LZMA2 chunks of one block from `input[from]` through its end chunk; returns the offset after it. */
function decodeLZMA2(input: Uint8Array, from: number, model: Model, out: Output): number {
  let at = from,
    configured = false;
  const need = (count: number): void => {
    if (at + count > input.length) corrupt('chunk past the end');
  };
  const u16 = (): number => {
    const value = (input[at] << 8) | input[at + 1];
    at += 2;
    return value;
  };
  for (;;) {
    need(1);
    const control = input[at++];
    if (control === 0) break;
    if (control < 0x80) {
      // Stored chunk: 1 resets the dictionary, 2 does not.
      if (control > 2) corrupt(`LZMA2 control byte ${control}`);
      need(2);
      const count = u16() + 1;
      need(count);
      if (control === 1) out.base = out.length;
      out.reserve(count);
      out.bytes.set(input.subarray(at, at + count), out.length);
      out.length += count;
      at += count;
      continue;
    }
    // LZMA chunk: unpacked size from the control byte's low 5 bits and two bytes, packed size from two more.
    need(4);
    const unpacked = (control & 0x1f) * 65536 + u16() + 1,
      packed = u16() + 1,
      reset = (control >> 5) & 3;
    if (reset >= 2) {
      need(1);
      const props = input[at++];
      model.configure(props);
      if (model.lc + model.lp > 4) corrupt('LZMA2 literal settings over 4 bits');
      configured = true;
    } else if (!configured) corrupt('LZMA2 chunk before its properties');
    if (reset === 3) out.base = out.length;
    if (reset >= 1) model.reset();
    need(packed);
    model.run(new RangeDecoder(input, at, at + packed), out, out.length + unpacked);
    at += packed;
  }
  return at;
}
