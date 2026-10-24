// zlib (RFC 1950) and DEFLATE (RFC 1951) decoder, written from the two RFCs, for data whose decompressed size is
// known up front: EXR ZIP and ZIPS chunks (@margoengine/environment) and PNG image data (@margoengine/decoders/png).
// Decoding fills one buffer of exactly that size; every input read, output write and back reference is bounds
// checked, and damaged data throws MargoError 'failed'.
import { margoError } from './errors.js';

const damaged = (problem) => margoError('failed', `Compressed data ${problem}; the file is damaged, export it again`);

// Every `groupShift`-sized group of symbols adds one extra bit (after the first two groups, which have none), and each
// base is the previous base plus the span the previous symbol's extra bits cover. That rule rebuilds both RFC 1951
// section 3.2.5 tables: lengths 3, 4, ... 227 for symbols 257..284 and distances 1, 2, ... 24577 for 0..29. Length
// symbol 285 breaks the pattern (exactly 258, no extra bits), passed as `lastBase`.
function symbolRanges(count, groupShift, first, lastBase) {
  const base = new Uint16Array(count),
    extra = new Uint8Array(count);
  for (let i = 0, value = first; i < count; i++) {
    extra[i] = Math.max(0, (i >> groupShift) - 1);
    base[i] = value;
    value += 1 << extra[i];
  }
  if (lastBase !== undefined) {
    base[count - 1] = lastBase;
    extra[count - 1] = 0;
  }
  return { base, extra };
}
const LENGTHS = /* @__PURE__ */ symbolRanges(29, 2, 3, 258);
const DISTANCES = /* @__PURE__ */ symbolRanges(30, 1, 1);
const LENGTH_258 = 28;
const END_OF_BLOCK = 256;
// RFC 1951 section 3.2.7: order in which the code length alphabet's own code lengths are stored.
const CODE_LENGTH_ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];
const MAX_BITS = 15;

/**
 * The decoding table for the canonical code RFC 1951 section 3.2.2 assigns to these code lengths: one entry per
 * pattern of the next `width` stream bits (first stream bit lowest), `symbol << 4 | code length`, 0 for patterns no
 * code starts with.
 */
function huffmanTable(lengths) {
  const perLength = new Uint16Array(MAX_BITS + 1);
  let width = 1;
  for (const length of lengths)
    if (length) {
      perLength[length]++;
      width = Math.max(width, length);
    }
  // Kraft sum: more codes of some length than the shorter ones leave room for cannot be decoded. An incomplete set is
  // accepted (RFC 1951 allows a lone distance code); its unused patterns stay 0 and throw only if the data uses them.
  for (let length = 1, room = 1; length <= MAX_BITS; length++) {
    room = room * 2 - perLength[length];
    if (room < 0) throw damaged('has an over-subscribed Huffman code');
  }
  const nextCode = new Uint16Array(MAX_BITS + 1);
  for (let length = 1, code = 0; length <= MAX_BITS; length++) {
    code = (code + (length > 1 ? perLength[length - 1] : 0)) << 1;
    nextCode[length] = code;
  }
  const entries = new Int32Array(1 << width);
  for (let symbol = 0; symbol < lengths.length; symbol++) {
    const length = lengths[symbol];
    if (!length) continue;
    // Codes are defined most significant bit first but arrive first bit lowest, so the table is indexed reversed.
    const code = nextCode[length]++;
    let reversed = 0;
    for (let bit = 0; bit < length; bit++) reversed |= ((code >> bit) & 1) << (length - 1 - bit);
    const entry = (symbol << 4) | length;
    for (let index = reversed; index < entries.length; index += 1 << length) entries[index] = entry;
  }
  return { entries, width };
}

let fixedTables;
/** The fixed literal/length and distance codes of block type 1 (RFC 1951 section 3.2.6), built on first use. */
function fixedCodes() {
  if (!fixedTables) {
    const literal = new Uint8Array(288);
    literal.fill(8, 0, 144).fill(9, 144, 256).fill(7, 256, 280).fill(8, 280, 288);
    fixedTables = [huffmanTable(literal), huffmanTable(new Uint8Array(30).fill(5))];
  }
  return fixedTables;
}

/** Reads the stream least significant bit first, holding up to 32 bits ahead. */
class BitStream {
  constructor(data, position) {
    this.data = data;
    this.position = position;
    this.held = 0;
    this.count = 0;
  }
  refill() {
    while (this.count <= 24 && this.position < this.data.length) {
      this.held |= this.data[this.position++] << this.count;
      this.count += 8;
    }
  }
  /** The next `n` bits (0..16) as an unsigned number. */
  bits(n) {
    if (this.count < n) {
      this.refill();
      if (this.count < n) throw damaged('ends early');
    }
    const value = this.held & ((1 << n) - 1);
    this.held >>>= n;
    this.count -= n;
    return value;
  }
  /** The next symbol of a Huffman code. */
  symbol(table) {
    if (this.count < table.width) this.refill();
    const entry = table.entries[this.held & (table.entries.length - 1)],
      length = entry & 15;
    if (entry === 0) throw damaged('uses a Huffman code its block does not define');
    if (length > this.count) throw damaged('ends early');
    this.held >>>= length;
    this.count -= length;
    return entry >> 4;
  }
  /** Drops the bits left in the current byte and returns the position of the next whole byte. */
  alignToByte() {
    this.position -= this.count >> 3;
    this.held = 0;
    this.count = 0;
    return this.position;
  }
}

/** Code lengths of a dynamic block's two codes (RFC 1951 section 3.2.7). */
function dynamicCodes(stream) {
  const literalCount = stream.bits(5) + 257,
    distanceCount = stream.bits(5) + 1,
    codeLengthCount = stream.bits(4) + 4;
  if (literalCount > 286) throw damaged(`declares ${literalCount} literal/length codes (at most 286)`);
  const codeLengthLengths = new Uint8Array(19);
  for (let i = 0; i < codeLengthCount; i++) codeLengthLengths[CODE_LENGTH_ORDER[i]] = stream.bits(3);
  const codeLengthCode = huffmanTable(codeLengthLengths);
  // One run of lengths covers both codes; repeats may cross from the literal lengths into the distance lengths.
  const lengths = new Uint8Array(literalCount + distanceCount);
  for (let filled = 0; filled < lengths.length; ) {
    const symbol = stream.symbol(codeLengthCode);
    if (symbol < 16) {
      lengths[filled++] = symbol;
      continue;
    }
    let value = 0,
      repeat;
    if (symbol === 16) {
      if (filled === 0) throw damaged('repeats a code length before the first one');
      value = lengths[filled - 1];
      repeat = 3 + stream.bits(2);
    } else repeat = symbol === 17 ? 3 + stream.bits(3) : 11 + stream.bits(7);
    if (repeat > lengths.length - filled) throw damaged('repeats code lengths past the declared count');
    lengths.fill(value, filled, filled + repeat);
    filled += repeat;
  }
  if (!lengths[END_OF_BLOCK]) throw damaged('has a block without an end-of-block code');
  return [huffmanTable(lengths.subarray(0, literalCount)), huffmanTable(lengths.subarray(literalCount))];
}

/** Decodes one Huffman-coded block into `output` from `written` on; returns the new output length. */
function huffmanBlock(stream, literals, distances, output, written) {
  const capacity = output.length;
  for (;;) {
    const symbol = stream.symbol(literals);
    if (symbol < END_OF_BLOCK) {
      if (written >= capacity) throw damaged(`inflates past its ${capacity} bytes`);
      output[written++] = symbol;
      continue;
    }
    if (symbol === END_OF_BLOCK) return written;
    const lengthSymbol = symbol - 257;
    if (lengthSymbol > LENGTH_258) throw damaged(`uses the reserved length symbol ${symbol}`);
    const length = LENGTHS.base[lengthSymbol] + stream.bits(LENGTHS.extra[lengthSymbol]),
      distanceSymbol = stream.symbol(distances);
    if (distanceSymbol >= 30) throw damaged(`uses the reserved distance symbol ${distanceSymbol}`);
    const distance = DISTANCES.base[distanceSymbol] + stream.bits(DISTANCES.extra[distanceSymbol]);
    if (distance > written) throw damaged('refers back before the start of its data');
    if (length > capacity - written) throw damaged(`inflates past its ${capacity} bytes`);
    // Front to back, one byte at a time: a distance shorter than the length repeats the bytes just written.
    for (let from = written - distance, stop = written + length; written < stop; ) output[written++] = output[from++];
  }
}

export function inflateZlib(input, size, checkAdler = true) {
  if (input.length < 2) throw damaged('is too short for a zlib header');
  const method = input[0],
    flags = input[1];
  // RFC 1950: compression method 8 (deflate), window of at most 32 KiB, header check, no preset dictionary.
  if ((method & 15) !== 8 || method >> 4 > 7 || ((method << 8) | flags) % 31 !== 0)
    throw damaged('has no valid zlib header');
  if (flags & 0x20) throw damaged('needs a preset dictionary');
  const output = new Uint8Array(size),
    stream = new BitStream(input, 2);
  let written = 0,
    final = 0;
  do {
    final = stream.bits(1);
    const type = stream.bits(2);
    if (type === 0) {
      // Stored block: byte aligned LEN, NLEN (its one's complement), then LEN raw bytes.
      let at = stream.alignToByte();
      if (input.length - at < 4) throw damaged('ends early');
      const length = input[at] | (input[at + 1] << 8),
        check = input[at + 2] | (input[at + 3] << 8);
      if ((length ^ 0xffff) !== check) throw damaged('has a stored block whose length check fails');
      at += 4;
      if (length > input.length - at) throw damaged('ends early');
      if (length > size - written) throw damaged(`inflates past its ${size} bytes`);
      output.set(input.subarray(at, at + length), written);
      written += length;
      stream.position = at + length;
    } else if (type === 1) {
      const [literals, distances] = fixedCodes();
      written = huffmanBlock(stream, literals, distances, output, written);
    } else if (type === 2) {
      const [literals, distances] = dynamicCodes(stream);
      written = huffmanBlock(stream, literals, distances, output, written);
    } else throw damaged('uses the reserved block type 3');
  } while (!final);
  if (written !== size) throw damaged(`inflates to ${written} bytes, not the ${size} its header states`);
  // RFC 1950 trailer: the Adler-32 of the decompressed bytes, big-endian, after the last block's final byte.
  const at = stream.alignToByte();
  if (input.length - at < 4) throw damaged('ends before its Adler-32 checksum');
  const stored = ((input[at] << 24) | (input[at + 1] << 16) | (input[at + 2] << 8) | input[at + 3]) >>> 0;
  if (checkAdler && adler32(output) !== stored) throw damaged('fails its Adler-32 checksum');
  return output;
}

/**
 * Adler-32 (RFC 1950 section 8.2): two sums modulo 65521. 5552 bytes is the longest run after which the second sum
 * still fits in 32 unsigned bits, so the sums stay 32-bit integers (twice as fast as doubles) and are reduced per run.
 */
function adler32(bytes) {
  let a = 1,
    b = 0;
  for (let start = 0; start < bytes.length; start += 5552) {
    const end = Math.min(bytes.length, start + 5552);
    for (let i = start; i < end; i++) {
      a = (a + bytes[i]) | 0;
      b = (b + a) | 0;
    }
    a %= 65521;
    b = (b >>> 0) % 65521;
  }
  return ((b << 16) | a) >>> 0;
}
