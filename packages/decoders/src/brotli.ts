// Brotli decoding (`@margoengine/decoders/brotli`), written from RFC 7932. Browsers decode Brotli for HTTP responses but
// give a page no way to run it on bytes it holds, and formats such as Potree 2.0 store each node as its own Brotli stream.
// The output buffer is the sliding window: a stream decodes whole, so nothing is copied out of a ring.
import { inflateZlib } from '../../shared/inflate.js';
import { DICTIONARY_BYTES, DICTIONARY_ZLIB, TRANSFORMS } from './brotli-data.js';
import { decodeFailed } from './errors.js';

/** Options of {@link decodeBrotli}. */
export interface BrotliOptions {
  /** Largest output accepted, in bytes, so a small stream cannot fill memory. Default 2^30 (1 GiB). */
  maxBytes?: number;
}

const corrupt = (why: string) => decodeFailed(`Brotli stream is corrupt: ${why}`);

/** Bits a prefix code's first lookup takes; longer codes go on to a second table. */
const ROOT = 8;
const MAX_LENGTH = 15;

/** Reads a stream's bits from the least significant bit of each byte. Past the end it reads zeros and counts them. */
class Bits {
  acc = 0;
  count = 0;
  at = 0;
  /** Zero bits made up past the end of the input, still held in `acc`. */
  past = 0;
  readonly data: Uint8Array;
  constructor(data: Uint8Array) {
    this.data = data;
  }
  /** At least 24 bits in `acc`. */
  fill(): void {
    while (this.count <= 24) {
      if (this.at < this.data.length) this.acc |= this.data[this.at++] << this.count;
      else this.past += 8;
      this.count += 8;
    }
  }
  /** Up to 24 bits. */
  read(n: number): number {
    if (this.count < n) this.fill();
    const value = this.acc & ((1 << n) - 1);
    this.acc >>>= n;
    this.count -= n;
    return value;
  }
  /** Throws when a read took bits the input does not have. */
  check(): void {
    if (this.past > this.count) throw corrupt('it ends early');
  }
  /** Drops the bits up to the next byte boundary, which must be zero. */
  align(): void {
    if (this.read(this.count & 7)) throw corrupt('fill bits are not zero');
  }
  /** Copies whole bytes out, from a byte boundary. */
  copy(to: Uint8Array, at: number, bytes: number): void {
    this.check();
    this.at -= (this.count - this.past) >> 3;
    this.acc = 0;
    this.count = 0;
    this.past = 0;
    if (this.at + bytes > this.data.length) throw corrupt('it ends early');
    to.set(this.data.subarray(this.at, this.at + bytes), at);
    this.at += bytes;
  }
}

/**
 * A prefix code as a lookup table. An entry is `value * 32 + bits`. Up to `ROOT` bits it holds the symbol; above that
 * `value` is where a second table starts and `bits` is `ROOT` plus that table's width.
 */
function codeTable(lengths: Uint8Array, size: number): Int32Array {
  const counts = new Int32Array(MAX_LENGTH + 2);
  for (let s = 0; s < size; s++) counts[lengths[s]]++;
  counts[0] = 0;
  const next = new Int32Array(MAX_LENGTH + 2);
  for (let bits = 1, code = 0; bits <= MAX_LENGTH; bits++) {
    code = (code + counts[bits - 1]) << 1;
    next[bits] = code;
  }
  const reversed = new Int32Array(size),
    widest = new Uint8Array(1 << ROOT);
  for (let s = 0; s < size; s++) {
    const length = lengths[s];
    if (!length) continue;
    let code = next[length]++,
      out = 0;
    for (let b = 0; b < length; b++, code >>= 1) out = (out << 1) | (code & 1);
    reversed[s] = out;
    if (length > ROOT) {
      const low = out & ((1 << ROOT) - 1);
      if (length > widest[low]) widest[low] = length;
    }
  }
  let total = 1 << ROOT;
  const starts = new Int32Array(1 << ROOT);
  for (let low = 0; low < 1 << ROOT; low++)
    if (widest[low]) {
      starts[low] = total;
      total += 1 << (widest[low] - ROOT);
    }
  const table = new Int32Array(total);
  for (let low = 0; low < 1 << ROOT; low++)
    if (widest[low]) table[low] = starts[low] * 32 + widest[low];
  for (let s = 0; s < size; s++) {
    const length = lengths[s];
    if (!length) continue;
    const code = reversed[s],
      entry = s * 32 + length;
    if (length <= ROOT) {
      for (let i = code; i < 1 << ROOT; i += 1 << length) table[i] = entry;
      continue;
    }
    const low = code & ((1 << ROOT) - 1),
      width = widest[low] - ROOT,
      high = code >> ROOT;
    for (let i = high; i < 1 << width; i += 1 << (length - ROOT)) table[starts[low] + i] = entry;
  }
  return table;
}

/** A code of one symbol takes no bits. */
function oneSymbol(symbol: number): Int32Array {
  return new Int32Array(1 << ROOT).fill(symbol * 32);
}

function decode(bits: Bits, table: Int32Array): number {
  if (bits.count < MAX_LENGTH) bits.fill();
  const acc = bits.acc;
  let entry = table[acc & ((1 << ROOT) - 1)],
    length = entry & 31;
  if (length > ROOT) {
    const width = length - ROOT;
    entry = table[(entry >>> 5) + ((acc >>> ROOT) & ((1 << width) - 1))];
    length = entry & 31;
    // Bits no code of this length starts with: only a stream that broke the code's rules gets here.
    if (!length) throw corrupt('a code is not in its table');
  }
  bits.acc = acc >>> length;
  bits.count -= length;
  return entry >>> 5;
}

const CODE_LENGTH_ORDER = [1, 2, 3, 4, 0, 5, 17, 6, 16, 7, 8, 9, 10, 11, 12, 13, 14, 15];

/** One prefix code of an alphabet of `size` symbols (section 3). */
function readCode(bits: Bits, size: number): Int32Array {
  const skip = bits.read(2);
  const lengths = new Uint8Array(size);
  if (skip === 1) {
    const count = bits.read(2) + 1,
      width = 32 - Math.clz32(size - 1),
      symbols: number[] = [];
    for (let i = 0; i < count; i++) {
      const symbol = bits.read(width);
      if (symbol >= size || symbols.includes(symbol)) throw corrupt('a simple code repeats or overruns its alphabet');
      symbols.push(symbol);
    }
    if (count === 1) return oneSymbol(symbols[0]);
    const shape =
      count === 2 ? [1, 1] : count === 3 ? [1, 2, 2] : bits.read(1) ? [1, 2, 3, 3] : [2, 2, 2, 2];
    symbols.forEach((symbol, i) => (lengths[symbol] = shape[i]));
    return codeTable(lengths, size);
  }
  const small = new Uint8Array(18);
  let space = 32,
    used = 0,
    single = 0;
  for (let i = skip; i < 18 && space > 0; i++) {
    // The fixed code of section 3.5, read a bit at a time from the right.
    let length: number;
    const two = bits.read(2);
    if (two === 0) length = 0;
    else if (two === 2) length = 3;
    else if (two === 1) length = 4;
    else if (!bits.read(1)) length = 2;
    else length = bits.read(1) ? 5 : 1;
    const symbol = CODE_LENGTH_ORDER[i];
    small[symbol] = length;
    if (length) {
      space -= 32 >> length;
      used++;
      single = symbol;
    }
  }
  if (used !== 1 && space !== 0) throw corrupt('code length codes do not fill their space');
  const inner = used === 1 ? oneSymbol(single) : codeTable(small, 18);
  let symbol = 0,
    previous = 8,
    repeat = 0,
    repeated = 0;
  space = 32768;
  while (symbol < size && space > 0) {
    const code = decode(bits, inner);
    if (code < 16) {
      repeat = 0;
      lengths[symbol++] = code;
      if (code) {
        previous = code;
        space -= 32768 >> code;
      }
      continue;
    }
    const extra = code - 14,
      length = code === 16 ? previous : 0;
    if (repeated !== length) {
      repeat = 0;
      repeated = length;
    }
    const before = repeat;
    if (repeat > 0) repeat = (repeat - 2) << extra;
    repeat += bits.read(extra) + 3;
    const added = repeat - before;
    if (symbol + added > size) throw corrupt('a repeat overruns its alphabet');
    lengths.fill(length, symbol, symbol + added);
    symbol += added;
    if (length) space -= added << (15 - length);
  }
  if (space !== 0) throw corrupt('code lengths do not fill their space');
  return codeTable(lengths, size);
}

/** The variable-length count of section 9.2: 1 to 256. */
function readCount(bits: Bits): number {
  if (!bits.read(1)) return 1;
  const n = bits.read(3);
  return n ? (1 << n) + bits.read(n) + 1 : 2;
}

function readWindowBits(bits: Bits): number {
  if (!bits.read(1)) return 16;
  const n = bits.read(3);
  if (n) return 17 + n;
  const m = bits.read(3);
  if (m === 1) throw corrupt('its window size is reserved');
  return m ? 8 + m : 17;
}

const COUNT_BASE = [
    1, 5, 9, 13, 17, 25, 33, 41, 49, 65, 81, 97, 113, 145, 177, 209, 241, 305, 369, 497, 753, 1265, 2289, 4337, 8433, 16625,
  ],
  COUNT_EXTRA = [2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 6, 6, 7, 8, 9, 10, 11, 12, 13, 24],
  INSERT_BASE = [
    0, 1, 2, 3, 4, 5, 6, 8, 10, 14, 18, 26, 34, 50, 66, 98, 130, 194, 322, 578, 1090, 2114, 6210, 22594,
  ],
  INSERT_EXTRA = [0, 0, 0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 7, 8, 9, 10, 12, 14, 24],
  COPY_BASE = [2, 3, 4, 5, 6, 7, 8, 9, 10, 12, 14, 18, 22, 30, 38, 54, 70, 102, 134, 198, 326, 582, 1094, 2118],
  COPY_EXTRA = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 7, 8, 9, 10, 24],
  /** Per 64 insert-and-copy codes, where its insert and copy length codes start (section 5). */
  CELL_INSERT = [0, 0, 0, 0, 8, 8, 0, 16, 8, 16, 16],
  CELL_COPY = [0, 8, 0, 8, 0, 8, 16, 0, 16, 8, 16],
  /** Which of the last four distances each short code starts from, and what it adds (section 4). */
  SHORT_INDEX = [0, 1, 2, 3, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 1, 1],
  SHORT_DELTA = [0, 0, 0, 0, -1, 1, -2, 2, -3, 3, -1, 1, -2, 2, -3, 3],
  DICTIONARY_BITS = [0, 0, 0, 0, 10, 10, 11, 11, 10, 10, 10, 10, 10, 9, 9, 8, 7, 7, 8, 7, 7, 6, 6, 5, 5];

/** The lookup tables of section 7.1, run-length coded as pairs of value and count. */
const runs = (...pairs: number[]) => {
  const out = new Uint8Array(256);
  let at = 0;
  for (let i = 0; i < pairs.length; i += 2) {
    out.fill(pairs[i], at, at + pairs[i + 1]);
    at += pairs[i + 1];
  }
  return out;
};
const LUT0 = new Uint8Array(256),
  LUT1 = runs(0, 33, 1, 15, 2, 10, 1, 7, 2, 26, 1, 6, 3, 26, 1, 4, 0, 97, 2, 32),
  LUT2 = runs(0, 1, 1, 15, 2, 48, 3, 64, 4, 64, 5, 48, 6, 15, 7, 1);
LUT0.set(
  [
    0, 0, 0, 0, 0, 0, 0, 0, 0, 4, 4, 0, 0, 4, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 8, 12, 16, 12, 12, 20,
    12, 16, 24, 28, 12, 12, 32, 12, 36, 12, 44, 44, 44, 44, 44, 44, 44, 44, 44, 44, 32, 32, 24, 40, 28, 12, 12, 48, 52, 52,
    52, 48, 52, 52, 52, 48, 52, 52, 52, 52, 52, 48, 52, 52, 52, 52, 52, 48, 52, 52, 52, 52, 52, 24, 12, 28, 12, 12, 12, 56,
    60, 60, 60, 56, 60, 60, 60, 56, 60, 60, 60, 60, 60, 56, 60, 60, 60, 60, 60, 56, 60, 60, 60, 60, 60, 24, 12, 28, 12, 0,
  ],
  0,
);
for (let i = 128; i < 256; i++) LUT0[i] = (i & 1) | (i >= 192 ? 2 : 0);

/** A block category: literals, insert-and-copy lengths or distances (section 6). */
class Blocks {
  types = 1;
  type = 0;
  previous = 1;
  left = 1 << 24;
  typeCode: Int32Array | null = null;
  countCode: Int32Array | null = null;
  constructor(bits: Bits) {
    this.types = readCount(bits);
    if (this.types < 2) return;
    this.typeCode = readCode(bits, this.types + 2);
    this.countCode = readCode(bits, 26);
    this.left = readBlockCount(bits, this.countCode);
  }
  /** The next block: its type and how many it holds. */
  next(bits: Bits): void {
    const symbol = decode(bits, this.typeCode as Int32Array);
    let type = symbol === 0 ? this.previous : symbol === 1 ? this.type + 1 : symbol - 2;
    if (type >= this.types) type -= this.types;
    this.previous = this.type;
    this.type = type;
    this.left = readBlockCount(bits, this.countCode as Int32Array);
  }
}
function readBlockCount(bits: Bits, code: Int32Array): number {
  const symbol = decode(bits, code);
  return COUNT_BASE[symbol] + bits.read(COUNT_EXTRA[symbol]);
}

/** A context map (section 7.3). */
function readContextMap(bits: Bits, size: number, trees: number): Uint8Array {
  const map = new Uint8Array(size);
  if (trees < 2) return map;
  const runMax = bits.read(1) ? bits.read(4) + 1 : 0,
    code = readCode(bits, trees + runMax);
  for (let i = 0; i < size; ) {
    const symbol = decode(bits, code);
    if (symbol === 0) i++;
    else if (symbol <= runMax) {
      i += (1 << symbol) + bits.read(symbol);
      if (i > size) throw corrupt('a context map run overruns the map');
    } else map[i++] = symbol - runMax;
  }
  if (bits.read(1)) {
    const front = new Uint8Array(256);
    for (let i = 0; i < 256; i++) front[i] = i;
    for (let i = 0; i < size; i++) {
      const index = map[i],
        value = front[index];
      map[i] = value;
      front.copyWithin(1, 0, index);
      front[0] = value;
    }
  }
  return map;
}

let dictionary: Uint8Array | undefined;
const offsets = new Int32Array(26);
function dictionaryBytes(): Uint8Array {
  if (dictionary) return dictionary;
  const text = atob(DICTIONARY_ZLIB),
    packed = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) packed[i] = text.charCodeAt(i);
  dictionary = inflateZlib(packed, DICTIONARY_BYTES) as Uint8Array;
  for (let length = 0; length < 25; length++)
    offsets[length + 1] = offsets[length] + (length < 4 ? 0 : length << DICTIONARY_BITS[length]);
  return dictionary;
}

/** Section 8's case change at `pos`; returns how many bytes it covered. */
function ferment(word: Uint8Array, end: number, pos: number): number {
  const byte = word[pos];
  if (byte < 192) {
    if (byte >= 97 && byte <= 122) word[pos] = byte ^ 32;
    return 1;
  }
  if (byte < 224) {
    if (pos + 1 < end) word[pos + 1] ^= 32;
    return 2;
  }
  if (pos + 2 < end) word[pos + 2] ^= 5;
  return 3;
}

/** The transformed word, in the scratch buffer; returns its length. */
function dictionaryWord(out: Uint8Array, length: number, index: number, transform: number): number {
  const data = dictionaryBytes(),
    [prefix, kind, suffix] = TRANSFORMS[transform],
    start = offsets[length] + index * length;
  let from = start,
    to = start + length;
  if (kind >= 12) to -= Math.min(kind - 11, length);
  else if (kind >= 3) from += Math.min(kind - 2, length);
  let at = 0;
  for (let i = 0; i < prefix.length; i++) out[at++] = prefix.charCodeAt(i);
  const first = at;
  out.set(data.subarray(from, to), at);
  at += to - from;
  if (kind === 1 && at > first) ferment(out, at, first);
  else if (kind === 2) for (let i = first; i < at; ) i += ferment(out, at, i);
  for (let i = 0; i < suffix.length; i++) out[at++] = suffix.charCodeAt(i);
  return at;
}

/**
 * Decodes one Brotli stream (RFC 7932) whole. Runs on the calling thread.
 * ```ts
 * const bytes = decodeBrotli(new Uint8Array(await (await fetch('/node.br')).arrayBuffer()));
 * ```
 * @throws MargoError `'failed'` when the stream breaks the format, ends early or would pass `maxBytes`.
 */
export function decodeBrotli(input: Uint8Array, options: BrotliOptions = {}): Uint8Array {
  const limit = options.maxBytes ?? 2 ** 30,
    bits = new Bits(input),
    windowSize = (1 << readWindowBits(bits)) - 16,
    last = [16, 15, 11, 4],
    word = new Uint8Array(40);
  let out = new Uint8Array(Math.min(limit, Math.max(1024, input.length * 4))),
    pos = 0,
    lastIndex = 3,
    done = false;
  const reserve = (bytes: number) => {
    if (pos + bytes > limit) throw decodeFailed(`Brotli output passes maxBytes (${limit})`);
    if (pos + bytes <= out.length) return;
    const grown = new Uint8Array(Math.min(limit, Math.max(pos + bytes, out.length * 2)));
    grown.set(out.subarray(0, pos));
    out = grown;
  };
  while (!done) {
    done = bits.read(1) === 1;
    if (done && bits.read(1)) break;
    const nibbles = bits.read(2);
    if (nibbles === 3) {
      if (bits.read(1)) throw corrupt('a reserved bit is set');
      const skipBytes = bits.read(2);
      let skip = 0;
      for (let i = 0; i < skipBytes; i++) {
        const byte = bits.read(8);
        if (i === skipBytes - 1 && i > 0 && !byte) throw corrupt('a metadata length has a zero last byte');
        skip += byte * 2 ** (8 * i);
      }
      if (skipBytes) skip++;
      bits.align();
      bits.copy(new Uint8Array(skip), 0, skip);
      continue;
    }
    let length = 0;
    for (let i = 0; i < nibbles + 4; i++) {
      const nibble = bits.read(4);
      if (i === nibbles + 3 && i > 3 && !nibble) throw corrupt('a block length has a zero last nibble');
      length += nibble * 16 ** i;
    }
    length++;
    reserve(length);
    if (!done && bits.read(1)) {
      bits.align();
      bits.copy(out, pos, length);
      pos += length;
      continue;
    }
    const literal = new Blocks(bits),
      command = new Blocks(bits),
      distance = new Blocks(bits),
      postfix = bits.read(2),
      direct = bits.read(4) << postfix,
      modes = new Uint8Array(literal.types);
    for (let i = 0; i < literal.types; i++) modes[i] = bits.read(2);
    const literalTrees = readCount(bits),
      literalMap = readContextMap(bits, 64 * literal.types, literalTrees),
      distanceTrees = readCount(bits),
      distanceMap = readContextMap(bits, 4 * distance.types, distanceTrees),
      literalCodes: Int32Array[] = [],
      commandCodes: Int32Array[] = [],
      distanceCodes: Int32Array[] = [];
    for (let i = 0; i < literalTrees; i++) literalCodes.push(readCode(bits, 256));
    for (let i = 0; i < command.types; i++) commandCodes.push(readCode(bits, 704));
    const distanceSize = 16 + direct + (48 << postfix);
    for (let i = 0; i < distanceTrees; i++) distanceCodes.push(readCode(bits, distanceSize));
    const end = pos + length,
      postfixMask = (1 << postfix) - 1;
    while (pos < end) {
      bits.check();
      if (command.typeCode && command.left === 0) command.next(bits);
      command.left--;
      const code = decode(bits, commandCodes[command.type]),
        cell = code >> 6,
        insertCode = CELL_INSERT[cell] + ((code >> 3) & 7),
        copyCode = CELL_COPY[cell] + (code & 7),
        insert = INSERT_BASE[insertCode] + bits.read(INSERT_EXTRA[insertCode]),
        copy = COPY_BASE[copyCode] + bits.read(COPY_EXTRA[copyCode]);
      if (pos + insert > end) throw corrupt('an insert overruns its block');
      let p1 = pos > 0 ? out[pos - 1] : 0,
        p2 = pos > 1 ? out[pos - 2] : 0;
      for (let i = 0; i < insert; i++) {
        if (literal.typeCode && literal.left === 0) literal.next(bits);
        literal.left--;
        const mode = modes[literal.type],
          context =
            mode === 0 ? p1 & 63 : mode === 1 ? p1 >> 2 : mode === 2 ? LUT0[p1] | LUT1[p2] : (LUT2[p1] << 3) | LUT2[p2],
          byte = decode(bits, literalCodes[literalMap[64 * literal.type + context]]);
        out[pos++] = byte;
        p2 = p1;
        p1 = byte;
      }
      if (pos === end) break;
      let backward: number,
        symbol = 0;
      if (code < 128) backward = last[lastIndex];
      else {
        if (distance.typeCode && distance.left === 0) distance.next(bits);
        distance.left--;
        const context = copy > 4 ? 3 : copy - 2;
        symbol = decode(bits, distanceCodes[distanceMap[4 * distance.type + context]]);
        if (symbol < 16) {
          backward = last[(lastIndex - SHORT_INDEX[symbol]) & 3] + SHORT_DELTA[symbol];
          if (backward <= 0) throw corrupt('a short distance is not positive');
        } else if (symbol < 16 + direct) backward = symbol - 15;
        else {
          const rest = symbol - direct - 16,
            extra = 1 + (rest >> (postfix + 1)),
            high = rest >> postfix,
            offset = (2 + (high & 1)) * 2 ** extra - 4;
          backward = (offset + bits.read(extra)) * (postfixMask + 1) + (rest & postfixMask) + direct + 1;
        }
      }
      const reach = Math.min(windowSize, pos);
      if (backward <= reach) {
        if (pos + copy > end) throw corrupt('a copy overruns its block');
        if (backward >= copy) out.copyWithin(pos, pos - backward, pos - backward + copy);
        else for (let i = 0, from = pos - backward; i < copy; i++) out[pos + i] = out[from + i];
        pos += copy;
        if (symbol !== 0) {
          lastIndex = (lastIndex + 1) & 3;
          last[lastIndex] = backward;
        }
        continue;
      }
      if (copy < 4 || copy > 24) throw corrupt('a dictionary word has a length outside 4 to 24');
      const id = backward - reach - 1,
        shift = DICTIONARY_BITS[copy],
        transform = Math.floor(id / 2 ** shift);
      if (transform > 120) throw corrupt('a dictionary word has an unknown transform');
      const bytes = dictionaryWord(word, copy, id % 2 ** shift, transform);
      if (pos + bytes > end) throw corrupt('a dictionary word overruns its block');
      out.set(word.subarray(0, bytes), pos);
      pos += bytes;
    }
    bits.check();
  }
  bits.check();
  return out.subarray(0, pos);
}
