// bzip2 decoding (`@margoengine/decoders/bzip2`). bzip2 has no formal standard; this is written from the public description
// of the file format: J. Tsai's "bzip2 format" notes, and M. Burrows and D. Wheeler, "A Block-sorting Lossless Data
// Compression Algorithm" (DEC SRC 124, 1994) for the inverse transform. NRRD volumes name it as an encoding.
import { decodeFailed, deviceUnsupported } from './errors.js';

/** Options of {@link decodeBzip2}. */
export interface Bzip2Options {
  /** Largest output accepted, in bytes, so a small stream cannot fill memory. Default 2^30 (1 GiB). */
  maxBytes?: number;
  /**
   * Stop as soon as this many bytes are out and return exactly them, for containers whose header gives the size and
   * whose data may run on (NRRD). Nothing past them is decoded, so the CRC of the block holding the last of them and
   * of the stream are not checked. Default: decode every stream to its end.
   */
  stopAt?: number;
}

const corrupt = (why: string) => decodeFailed(`bzip2 stream is corrupt: ${why}`);
const GROUP = 50;
const MAX_LENGTH = 20;
const MAX_SELECTORS = 18002;
const crcTable = /* @__PURE__ */ (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i << 24;
    for (let k = 0; k < 8; k++) c = c & 0x80000000 ? (c << 1) ^ 0x04c11db7 : c << 1;
    table[i] = c >>> 0;
  }
  return table;
})();

/** The stream's bits, most significant first. */
class Bits {
  at = 0;
  private held = 0;
  private count = 0;
  private readonly data: Uint8Array;
  constructor(data: Uint8Array) {
    this.data = data;
  }
  /** `n` bits, at most 24. */
  read(n: number): number {
    while (this.count < n) {
      if (this.at >= this.data.length) throw corrupt('it ends early');
      this.held = ((this.held << 8) | this.data[this.at++]) & 0x7fffffff;
      this.count += 8;
    }
    this.count -= n;
    return (this.held >>> this.count) & ((1 << n) - 1);
  }
  /** Drops the rest of the byte. */
  align(): void {
    this.count -= this.count % 8;
  }
  /** Bytes read and not yet used, for a stream that starts after this one. */
  get next(): number {
    return this.at - Math.floor(this.count / 8);
  }
}

/** A canonical Huffman code as first code, first index and symbols per length. */
interface Code {
  limit: Int32Array;
  base: Int32Array;
  symbols: Uint16Array;
  shortest: number;
}

function buildCode(lengths: Uint8Array, size: number): Code {
  const limit = new Int32Array(MAX_LENGTH + 2),
    base = new Int32Array(MAX_LENGTH + 2),
    symbols = new Uint16Array(size);
  let shortest = MAX_LENGTH,
    at = 0,
    code = 0;
  for (let length = 1; length <= MAX_LENGTH; length++) {
    base[length] = at - code;
    for (let s = 0; s < size; s++)
      if (lengths[s] === length) {
        symbols[at++] = s;
        code++;
        if (length < shortest) shortest = length;
      }
    limit[length] = code;
    if (code > 2 ** length) throw corrupt('a code table is oversubscribed');
    code <<= 1;
  }
  return { limit, base, symbols, shortest };
}

function readSymbol(bits: Bits, code: Code): number {
  let length = code.shortest,
    value = bits.read(length);
  for (;;) {
    if (value < code.limit[length]) return code.symbols[value + code.base[length]];
    if (++length > MAX_LENGTH) throw corrupt('a code is not in its table');
    value = (value << 1) | bits.read(1);
  }
}

/** One block's transformed bytes into `tt`; returns how many. */
function readBlock(bits: Bits, tt: Uint32Array, size: number): { count: number; origin: number } {
  if (bits.read(1)) throw deviceUnsupported('bzip2 randomised blocks are not read; nothing has written them since 1999');
  const origin = bits.read(24),
    ranges = bits.read(16),
    seen: number[] = [];
  for (let i = 0; i < 16; i++)
    if (ranges & (0x8000 >> i)) {
      const used = bits.read(16);
      for (let k = 0; k < 16; k++) if (used & (0x8000 >> k)) seen.push(i * 16 + k);
    }
  if (!seen.length) throw corrupt('a block uses no symbols');
  const alphabet = seen.length + 2,
    groups = bits.read(3),
    selectorCount = bits.read(15);
  if (groups < 2 || groups > 6) throw corrupt('a block has the wrong number of code tables');
  if (!selectorCount) throw corrupt('a block has no selectors');
  // Selectors past 18002 are read and ignored, as a block cannot use them.
  const selectors = new Uint8Array(Math.min(selectorCount, MAX_SELECTORS)),
    order = [0, 1, 2, 3, 4, 5];
  for (let i = 0; i < selectorCount; i++) {
    let j = 0;
    while (bits.read(1)) if (++j >= groups) throw corrupt('a selector is out of range');
    const table = order[j];
    order.copyWithin(1, 0, j);
    order[0] = table;
    if (i < MAX_SELECTORS) selectors[i] = table;
  }
  const codes: Code[] = [],
    lengths = new Uint8Array(alphabet);
  for (let t = 0; t < groups; t++) {
    let length = bits.read(5);
    for (let s = 0; s < alphabet; s++) {
      for (;;) {
        if (length < 1 || length > MAX_LENGTH) throw corrupt('a code length is out of range');
        if (!bits.read(1)) break;
        length += bits.read(1) ? -1 : 1;
      }
      lengths[s] = length;
    }
    codes.push(buildCode(lengths, alphabet));
  }
  const end = alphabet - 1,
    front = Uint8Array.from(seen),
    counts = new Uint32Array(256);
  let count = 0,
    group = 0,
    left = 0,
    code = codes[0],
    run = 0,
    weight = 1;
  const flush = () => {
    if (!run) return;
    if (count + run > size) throw corrupt('a block is larger than its header allows');
    const byte = front[0];
    counts[byte] += run;
    tt.fill(byte, count, count + run);
    count += run;
    run = 0;
    weight = 1;
  };
  for (;;) {
    if (!left) {
      if (group >= selectors.length) throw corrupt('a block ran out of selectors');
      code = codes[selectors[group++]];
      left = GROUP;
    }
    left--;
    const symbol = readSymbol(bits, code);
    if (symbol < 2) {
      // Runs count in bijective base 2: RUNA is one of this weight, RUNB two.
      if (weight > size) throw corrupt('a run is larger than a block');
      run += weight << symbol;
      weight <<= 1;
      continue;
    }
    flush();
    if (symbol === end) break;
    const index = symbol - 1;
    if (index >= seen.length) throw corrupt('a move-to-front index is out of range');
    const byte = front[index];
    front.copyWithin(1, 0, index);
    front[0] = byte;
    if (count >= size) throw corrupt('a block is larger than its header allows');
    counts[byte]++;
    tt[count++] = byte;
  }
  if (origin >= count) throw corrupt('a block starts outside itself');
  // The inverse transform as a linked list: the high bits of tt[i] name the next byte's place.
  let total = 0;
  for (let i = 0; i < 256; i++) {
    const n = counts[i];
    counts[i] = total;
    total += n;
  }
  for (let i = 0; i < count; i++) tt[counts[tt[i] & 0xff]++] |= i << 8;
  return { count, origin };
}

/**
 * Decodes one or more concatenated bzip2 streams into their bytes, checking every block's CRC and each stream's. Runs on
 * the calling thread. `.bz2` files, and the data of an NRRD volume whose encoding is `bzip2`.
 * @throws MargoError `'failed'` for a corrupt or short stream or one past `maxBytes`, `'unsupported'` for a randomised block.
 */
export function decodeBzip2(input: Uint8Array, options: Bzip2Options = {}): Uint8Array {
  const maxBytes = options.maxBytes ?? 2 ** 30,
    stop = options.stopAt ?? Number.POSITIVE_INFINITY;
  if (stop <= 0) return new Uint8Array(0);
  let out = new Uint8Array(Math.min(maxBytes, Math.max(1024, input.length * 4))),
    length = 0,
    start = 0;
  const room = (bytes: number) => {
    if (length + bytes > maxBytes) throw decodeFailed(`bzip2 output is over maxBytes (${maxBytes}); raise it to read this file`);
    if (length + bytes <= out.length) return;
    const next = new Uint8Array(Math.min(maxBytes, Math.max(out.length * 2, length + bytes)));
    next.set(out.subarray(0, length));
    out = next;
  };
  do {
    const bits = new Bits(start ? input.subarray(start) : input);
    if (bits.read(8) !== 0x42 || bits.read(8) !== 0x5a || bits.read(8) !== 0x68) throw corrupt('it has no BZh header');
    const level = bits.read(8) - 0x30;
    if (level < 1 || level > 9) throw corrupt('its block size is out of range');
    const size = level * 100_000,
      tt = new Uint32Array(size);
    let combined = 0;
    for (;;) {
      const high = bits.read(24),
        low = bits.read(24);
      if (high === 0x177245 && low === 0x385090) break;
      if (high !== 0x314159 || low !== 0x265359) throw corrupt('a block has no magic number');
      const want = ((bits.read(16) << 16) | bits.read(16)) >>> 0,
        { count, origin } = readBlock(bits, tt, size);
      // Undo the first run-length step as the bytes leave the list: four equal bytes, then a count of more.
      let crc = 0xffffffff,
        at = tt[origin] >>> 8,
        same = 0,
        previous = -1;
      for (let i = 0; i < count; i++) {
        const entry = tt[at],
          byte = entry & 0xff;
        at = entry >>> 8;
        if (same === 4) {
          const run = Math.min(byte, stop - length);
          room(run);
          out.fill(previous, length, length + run);
          for (let k = 0; k < run; k++) crc = (crc << 8) ^ crcTable[(crc >>> 24) ^ previous];
          length += run;
          if (length >= stop) return out.subarray(0, length);
          same = 0;
          previous = -1;
          continue;
        }
        same = byte === previous ? same + 1 : 1;
        previous = byte;
        room(1);
        out[length++] = byte;
        if (length >= stop) return out.subarray(0, length);
        crc = (crc << 8) ^ crcTable[(crc >>> 24) ^ byte];
      }
      crc = ~crc >>> 0;
      if (crc !== want) throw corrupt('a block fails its CRC');
      combined = (((combined << 1) | (combined >>> 31)) ^ crc) >>> 0;
    }
    const want = ((bits.read(16) << 16) | bits.read(16)) >>> 0;
    if (want !== combined) throw corrupt('the stream fails its CRC');
    bits.align();
    start += bits.next;
  } while (start < input.length);
  return out.subarray(0, length);
}
