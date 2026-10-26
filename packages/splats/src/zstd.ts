// Zstandard decompressor (frames, raw/RLE/compressed blocks, Huffman literals, FSE sequences, repeat offsets,
// xxHash64 content checksums, skippable frames). Written clean room from RFC 8878 and the public xxHash64
// description; no other implementation was read. Dictionaries are refused with a coded error.
import { MargoError } from '@margoengine/math/errors';

/** Options for {@link decompressZstd}. */
export interface ZstdOptions {
  /** Aborts decoding between blocks; the promise rejects with the signal's reason. */
  signal?: AbortSignal;
  /** Largest total output in bytes; more throws a RangeError. Default 268,435,456 (256 MiB). */
  maxOutputSize?: number;
  /** Largest frame window in bytes a frame may declare; more throws a RangeError. Default 134,217,728 (128 MiB). */
  maxWindowSize?: number;
}

const damaged = (what: string) =>
  new RangeError(`The Zstandard data is damaged (${what}); check that the file is complete.`);

const MAX_BLOCK = 1 << 17;
/** Output bytes between yields to the event loop, so an abort can land during a long decode. */
const YIELD_EVERY = 1 << 23;

// RFC 8878 3.1.1.3.2.1.1: literals length and match length codes (baseline, extra bits) and default distributions.
const LL_BASE = new Uint32Array(36),
  LL_BITS = new Uint8Array(36),
  ML_BASE = new Uint32Array(53),
  ML_BITS = new Uint8Array(53);
{
  const ll = [0, 0, 1, 1, 1, 1, 2, 2, 3, 3, 4, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16];
  for (let c = 0, base = 0; c < 36; c++) {
    LL_BITS[c] = c < 16 ? 0 : ll[c - 14];
    LL_BASE[c] = base;
    base += 1 << LL_BITS[c];
  }
  const ml = [1, 1, 1, 1, 2, 2, 3, 3, 4, 4, 5, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16];
  for (let c = 0, base = 3; c < 53; c++) {
    ML_BITS[c] = c < 32 ? 0 : ml[c - 32];
    ML_BASE[c] = base;
    base += 1 << ML_BITS[c];
  }
}
const LL_DEFAULT = [
  4, 3, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 1, 1, 1, 2, 2, 2, 2, 2, 2, 2, 2, 2, 3, 2, 1, 1, 1, 1, 1, -1, -1, -1, -1,
];
const ML_DEFAULT = [
  1, 4, 3, 2, 2, 2, 2, 2, 2, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1,
  1, 1, 1, 1, 1, 1, 1, -1, -1, -1, -1, -1, -1, -1,
];
const OF_DEFAULT = [1, 1, 1, 1, 1, 1, 2, 2, 2, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, -1, -1, -1, -1, -1];

/** Reads a little-endian backward bitstream (RFC 8878 4.1): bits are taken from the end towards the start. */
class BackwardBits {
  /** Bits still unread; negative once more bits were read than the stream holds (they read as zero). */
  pos: number;
  constructor(
    private readonly data: Uint8Array,
    private readonly start: number,
    private readonly length: number,
  ) {
    if (length < 1) throw damaged('an empty bitstream');
    const last = data[start + length - 1];
    if (last === 0) throw damaged('a bitstream without its end marker');
    this.pos = length * 8 - 8 + (31 - Math.clz32(last));
  }
  private byte(i: number): number {
    return i >= 0 && i < this.length ? this.data[this.start + i] : 0;
  }
  /** The `n` (at most 25) bits below the read position, without consuming them. */
  peek(n: number): number {
    if (n === 0) return 0;
    const p = this.pos - n,
      i = p >> 3,
      word = (this.byte(i) | (this.byte(i + 1) << 8) | (this.byte(i + 2) << 16) | (this.byte(i + 3) << 24)) >>> 0;
    return (word >>> (p & 7)) & ((1 << n) - 1);
  }
  /** Reads `n` bits, 0 to 31. */
  read(n: number): number {
    if (n > 24) {
      const high = this.read(n - 16);
      return high * 65536 + this.read(16);
    }
    const value = this.peek(n);
    this.pos -= n;
    return value;
  }
}

/** An FSE decoding table: per state, its symbol, bits to read and the baseline of the next state. */
interface Fse {
  log: number;
  symbol: Uint8Array;
  bits: Uint8Array;
  base: Uint32Array;
}

/** Builds a decoding table from normalised probabilities (RFC 8878 4.1.1). */
function buildFse(probabilities: ArrayLike<number>, symbols: number, log: number): Fse {
  const size = 1 << log,
    symbol = new Uint8Array(size),
    bits = new Uint8Array(size),
    base = new Uint32Array(size),
    next = new Uint32Array(symbols);
  let high = size - 1;
  for (let s = 0; s < symbols; s++)
    if (probabilities[s] === -1) {
      symbol[high--] = s;
      next[s] = 1;
    } else next[s] = probabilities[s];
  const step = (size >> 1) + (size >> 3) + 3,
    mask = size - 1;
  let position = 0;
  for (let s = 0; s < symbols; s++)
    for (let k = 0; k < probabilities[s]; k++) {
      symbol[position] = s;
      do position = (position + step) & mask;
      while (position > high);
    }
  if (position !== 0) throw damaged('an FSE table whose probabilities do not fill it');
  for (let state = 0; state < size; state++) {
    const n = next[symbol[state]]++,
      b = log - (31 - Math.clz32(n));
    bits[state] = b;
    base[state] = (n << b) - size;
  }
  return { log, symbol, bits, base };
}

/** A table that always yields `value` (RLE mode). */
function rleFse(value: number): Fse {
  return { log: 0, symbol: Uint8Array.of(value), bits: new Uint8Array(1), base: new Uint32Array(1) };
}

/** Reads an FSE table description (RFC 8878 4.1.1) at `at`; returns the table and the bytes it used. */
function readFse(data: Uint8Array, at: number, end: number, maxLog: number, maxSymbol: number): [Fse, number] {
  let bit = 0;
  const bitsAt = (n: number) => {
    const p = at * 8 + bit,
      i = p >> 3;
    if (i >= end) throw damaged('a truncated FSE table description');
    const word = data[i] | ((data[i + 1] ?? 0) << 8) | ((data[i + 2] ?? 0) << 16);
    return (word >>> (p & 7)) & ((1 << n) - 1);
  };
  const log = bitsAt(4) + 5;
  bit = 4;
  if (log > maxLog) throw damaged(`an FSE accuracy log of ${log} (at most ${maxLog})`);
  const probabilities: number[] = [];
  let remaining = (1 << log) + 1,
    threshold = 1 << log,
    width = log + 1;
  while (remaining > 1) {
    if (probabilities.length > maxSymbol) throw damaged('an FSE table with too many symbols');
    const max = 2 * threshold - 1 - remaining;
    let count = bitsAt(width - 1);
    if (count < max) bit += width - 1;
    else {
      count = bitsAt(width);
      if (count >= threshold) count -= max;
      bit += width;
    }
    const p = count - 1;
    probabilities.push(p);
    remaining -= p < 0 ? -p : p;
    if (p === 0)
      for (;;) {
        const repeat = bitsAt(2);
        bit += 2;
        for (let k = 0; k < repeat; k++) probabilities.push(0);
        if (repeat !== 3) break;
      }
    while (remaining < threshold) {
      width--;
      threshold >>= 1;
    }
  }
  if (remaining !== 1 || probabilities.length > maxSymbol + 1) throw damaged('an FSE table that does not sum');
  const used = (bit + 7) >> 3;
  if (at + used > end) throw damaged('a truncated FSE table description');
  return [buildFse(probabilities, probabilities.length, log), used];
}

/** A Huffman decoding table indexed by the next `bits` bits. */
interface Huffman {
  bits: number;
  symbol: Uint8Array;
  length: Uint8Array;
}

/** Reads a Huffman tree description (RFC 8878 4.2.1); returns the table and the bytes it used. */
function readHuffman(data: Uint8Array, at: number, end: number): [Huffman, number] {
  if (at >= end) throw damaged('a missing Huffman tree');
  const header = data[at],
    weights = new Uint8Array(256);
  let count = 0,
    used: number;
  if (header >= 128) {
    count = header - 127;
    used = 1 + ((count + 1) >> 1);
    if (at + used > end) throw damaged('a truncated Huffman tree');
    for (let i = 0; i < count; i++) {
      const b = data[at + 1 + (i >> 1)];
      weights[i] = i & 1 ? b & 15 : b >> 4;
    }
  } else {
    used = 1 + header;
    if (at + used > end) throw damaged('a truncated Huffman tree');
    const [fse, tableBytes] = readFse(data, at + 1, at + used, 6, 255),
      stream = new BackwardBits(data, at + 1 + tableBytes, header - tableBytes);
    let s1 = stream.read(fse.log),
      s2 = stream.read(fse.log);
    for (;;) {
      if (count > 254) throw damaged('a Huffman tree with too many weights');
      weights[count++] = fse.symbol[s1];
      s1 = fse.base[s1] + stream.read(fse.bits[s1]);
      if (stream.pos < 0) {
        weights[count++] = fse.symbol[s2];
        break;
      }
      weights[count++] = fse.symbol[s2];
      s2 = fse.base[s2] + stream.read(fse.bits[s2]);
      if (stream.pos < 0) {
        weights[count++] = fse.symbol[s1];
        break;
      }
    }
  }
  let sum = 0;
  for (let i = 0; i < count; i++) {
    if (weights[i] > 11) throw damaged('a Huffman weight above 11');
    if (weights[i]) sum += 1 << (weights[i] - 1);
  }
  if (sum === 0 || count > 255) throw damaged('an empty Huffman tree');
  const bits = 32 - Math.clz32(sum),
    rest = (1 << bits) - sum;
  if (bits > 11 || rest & (rest - 1)) throw damaged('a Huffman tree that is not complete');
  weights[count++] = 32 - Math.clz32(rest);
  const size = 1 << bits,
    symbol = new Uint8Array(size),
    length = new Uint8Array(size);
  let next = 0;
  for (let w = 1; w <= bits; w++)
    for (let s = 0; s < count; s++)
      if (weights[s] === w) {
        const span = 1 << (w - 1);
        symbol.fill(s, next, next + span);
        length.fill(bits + 1 - w, next, next + span);
        next += span;
      }
  return [{ bits, symbol, length }, used];
}

/** Decodes one Huffman-coded stream of `size` literals into `out` at `to`. */
function huffmanStream(
  table: Huffman,
  data: Uint8Array,
  at: number,
  length: number,
  out: Uint8Array,
  to: number,
  size: number,
) {
  const stream = new BackwardBits(data, at, length),
    { bits, symbol, length: lengths } = table;
  for (let i = 0; i < size; i++) {
    const index = stream.peek(bits);
    out[to + i] = symbol[index];
    stream.pos -= lengths[index];
  }
  if (stream.pos !== 0) throw damaged('a Huffman stream that does not end where its literals do');
}

/** Per-frame decoder state that later blocks may reuse. */
interface FrameState {
  huffman?: Huffman;
  ll?: Fse;
  of?: Fse;
  ml?: Fse;
  repeats: [number, number, number];
}

let LL_PREDEFINED: Fse | undefined, ML_PREDEFINED: Fse | undefined, OF_PREDEFINED: Fse | undefined;

/** Growable output with a hard limit. */
class Output {
  bytes: Uint8Array<ArrayBuffer>;
  length = 0;
  constructor(private readonly limit: number) {
    this.bytes = new Uint8Array(Math.min(limit, 1 << 16));
  }
  reserve(extra: number) {
    const need = this.length + extra;
    if (need > this.limit)
      throw new RangeError(
        `Zstandard output passes the ${this.limit}-byte limit; raise maxOutputSize if the data is trusted.`,
      );
    if (need <= this.bytes.length) return;
    const grown = new Uint8Array(Math.min(this.limit, Math.max(need, this.bytes.length * 2)));
    grown.set(this.bytes.subarray(0, this.length));
    this.bytes = grown;
  }
}

/** Decodes the literals section of a compressed block; returns the literals and where the sequences start. */
function readLiterals(
  data: Uint8Array,
  at: number,
  end: number,
  state: FrameState,
  scratch: Uint8Array,
): [Uint8Array, number] {
  const b0 = data[at],
    type = b0 & 3,
    format = (b0 >> 2) & 3;
  if (type < 2) {
    let size: number, header: number;
    if ((format & 1) === 0) {
      size = b0 >> 3;
      header = 1;
    } else if (format === 1) {
      size = (b0 >> 4) | (data[at + 1] << 4);
      header = 2;
    } else {
      size = (b0 >> 4) | (data[at + 1] << 4) | (data[at + 2] << 12);
      header = 3;
    }
    if (size > MAX_BLOCK) throw damaged('a literals section larger than a block');
    const from = at + header;
    if (type === 0) {
      if (from + size > end) throw damaged('truncated raw literals');
      return [data.subarray(from, from + size), from + size];
    }
    if (from + 1 > end) throw damaged('truncated RLE literals');
    scratch.fill(data[from], 0, size);
    return [scratch.subarray(0, size), from + 1];
  }
  let size: number, compressed: number, header: number;
  const b1 = data[at + 1],
    b2 = data[at + 2];
  if (format < 2) {
    size = (b0 >> 4) | ((b1 & 63) << 4);
    compressed = (b1 >> 6) | (b2 << 2);
    header = 3;
  } else if (format === 2) {
    size = (b0 >> 4) | (b1 << 4) | ((b2 & 3) << 12);
    compressed = (b2 >> 2) | (data[at + 3] << 6);
    header = 4;
  } else {
    size = (b0 >> 4) | (b1 << 4) | ((b2 & 63) << 12);
    compressed = (b2 >> 6) | (data[at + 3] << 2) | (data[at + 4] << 10);
    header = 5;
  }
  if (size > MAX_BLOCK) throw damaged('a literals section larger than a block');
  let from = at + header;
  const stop = from + compressed;
  if (stop > end) throw damaged('truncated compressed literals');
  if (type === 2) {
    const [table, used] = readHuffman(data, from, stop);
    state.huffman = table;
    from += used;
  } else if (!state.huffman) throw damaged('treeless literals with no earlier Huffman tree');
  const table = state.huffman as Huffman;
  if (format === 0) huffmanStream(table, data, from, stop - from, scratch, 0, size);
  else {
    if (from + 6 > stop) throw damaged('a truncated literals jump table');
    const s1 = data[from] | (data[from + 1] << 8),
      s2 = data[from + 2] | (data[from + 3] << 8),
      s3 = data[from + 4] | (data[from + 5] << 8),
      part = (size + 3) >> 2,
      last = size - 3 * part;
    let p = from + 6;
    const s4 = stop - p - s1 - s2 - s3;
    if (s4 < 1 || last < 0) throw damaged('a literals jump table that does not fit');
    huffmanStream(table, data, p, s1, scratch, 0, part);
    p += s1;
    huffmanStream(table, data, p, s2, scratch, part, part);
    p += s2;
    huffmanStream(table, data, p, s3, scratch, 2 * part, part);
    p += s3;
    huffmanStream(table, data, p, s4, scratch, 3 * part, last);
  }
  return [scratch.subarray(0, size), stop];
}

/** Picks the FSE table for one symbol type from its compression mode (RFC 8878 3.1.1.3.2.1). */
function sequenceTable(
  mode: number,
  data: Uint8Array,
  at: number,
  end: number,
  previous: Fse | undefined,
  predefined: () => Fse,
  maxLog: number,
  maxSymbol: number,
): [Fse, number] {
  if (mode === 0) return [predefined(), 0];
  if (mode === 1) {
    if (at >= end) throw damaged('a missing RLE sequence symbol');
    if (data[at] > maxSymbol) throw damaged('an RLE sequence symbol out of range');
    return [rleFse(data[at]), 1];
  }
  if (mode === 2) return readFse(data, at, end, maxLog, maxSymbol);
  if (!previous) throw damaged('a repeated sequence table with no earlier table');
  return [previous, 0];
}

/** Decodes one compressed block (RFC 8878 3.1.1.3) and appends it to `out`. */
function compressedBlock(
  data: Uint8Array,
  at: number,
  end: number,
  out: Output,
  frameStart: number,
  window: number,
  state: FrameState,
  scratch: Uint8Array,
) {
  const [literals, seqAt] = readLiterals(data, at, end, state, scratch);
  let p = seqAt;
  if (p >= end) throw damaged('a block without its sequences section');
  let count = data[p++];
  if (count >= 128) {
    if (count < 255) count = ((count - 128) << 8) + data[p++];
    else {
      count = data[p] + (data[p + 1] << 8) + 0x7f00;
      p += 2;
    }
  }
  if (p > end) throw damaged('a truncated sequences header');
  let lit = 0;
  if (count > 0) {
    if (p >= end) throw damaged('a truncated sequences header');
    const modes = data[p++];
    if (modes & 3) throw damaged('reserved bits set in the sequence compression modes');
    let used: number;
    [state.ll, used] = sequenceTable(
      modes >> 6,
      data,
      p,
      end,
      state.ll,
      () => (LL_PREDEFINED ??= buildFse(LL_DEFAULT, 36, 6)),
      9,
      35,
    );
    p += used;
    [state.of, used] = sequenceTable(
      (modes >> 4) & 3,
      data,
      p,
      end,
      state.of,
      () => (OF_PREDEFINED ??= buildFse(OF_DEFAULT, 29, 5)),
      8,
      31,
    );
    p += used;
    [state.ml, used] = sequenceTable(
      (modes >> 2) & 3,
      data,
      p,
      end,
      state.ml,
      () => (ML_PREDEFINED ??= buildFse(ML_DEFAULT, 53, 6)),
      9,
      52,
    );
    p += used;
    if (p >= end) throw damaged('a missing sequences bitstream');
    const ll = state.ll,
      of = state.of,
      ml = state.ml,
      stream = new BackwardBits(data, p, end - p),
      repeats = state.repeats;
    let sll = stream.read(ll.log),
      sof = stream.read(of.log),
      sml = stream.read(ml.log);
    for (let n = 0; n < count; n++) {
      const ofCode = of.symbol[sof],
        mlCode = ml.symbol[sml],
        llCode = ll.symbol[sll];
      if (ofCode > 31) throw damaged('an offset code above 31');
      const offsetValue = 2 ** ofCode + stream.read(ofCode),
        matchLength = ML_BASE[mlCode] + stream.read(ML_BITS[mlCode]),
        literalLength = LL_BASE[llCode] + stream.read(LL_BITS[llCode]);
      let offset: number;
      if (offsetValue > 3) {
        offset = offsetValue - 3;
        repeats[2] = repeats[1];
        repeats[1] = repeats[0];
        repeats[0] = offset;
      } else {
        const index = literalLength === 0 ? offsetValue : offsetValue - 1;
        if (index === 0) offset = repeats[0];
        else {
          offset = index === 3 ? repeats[0] - 1 : repeats[index];
          if (index !== 1) repeats[2] = repeats[1];
          repeats[1] = repeats[0];
          repeats[0] = offset;
        }
      }
      if (n + 1 < count) {
        sll = ll.base[sll] + stream.read(ll.bits[sll]);
        sml = ml.base[sml] + stream.read(ml.bits[sml]);
        sof = of.base[sof] + stream.read(of.bits[sof]);
      }
      if (lit + literalLength > literals.length) throw damaged('a sequence that runs past its literals');
      out.reserve(literalLength + matchLength);
      const bytes = out.bytes;
      bytes.set(literals.subarray(lit, lit + literalLength), out.length);
      lit += literalLength;
      out.length += literalLength;
      const produced = out.length - frameStart;
      if (offset < 1 || offset > produced || offset > window)
        throw damaged(`a match offset of ${offset} reaching before the start of the frame or window`);
      let to = out.length;
      const from = to - offset;
      if (offset >= matchLength) bytes.copyWithin(to, from, from + matchLength);
      else for (let k = 0; k < matchLength; k++) bytes[to + k] = bytes[from + k];
      to += matchLength;
      out.length = to;
    }
    if (stream.pos !== 0) throw damaged('a sequences bitstream that does not end where its sequences do');
  } else if (p !== end) throw damaged('bytes after a block with no sequences');
  const tail = literals.length - lit;
  out.reserve(tail);
  out.bytes.set(literals.subarray(lit), out.length);
  out.length += tail;
}

/**
 * Decompresses Zstandard data (RFC 8878): one or more frames, skippable frames skipped, content checksums verified.
 * Dictionaries are not supported.
 * @throws TypeError when `input` is not bytes; RangeError for damaged or truncated data, a failed checksum, a frame
 * window above `maxWindowSize` or output above `maxOutputSize`; MargoError `unsupported` for a frame that needs a
 * dictionary.
 * @example
 * const bytes = await decompressZstd(compressed, { maxOutputSize: 1 << 24 });
 */
export async function decompressZstd(input: Uint8Array, options: ZstdOptions = {}): Promise<Uint8Array<ArrayBuffer>> {
  if (!(input instanceof Uint8Array)) throw new TypeError('Expected Zstandard bytes as a Uint8Array');
  const { signal, maxOutputSize = 1 << 28, maxWindowSize = 1 << 27 } = options;
  if (!(maxOutputSize >= 0) || !(maxWindowSize >= 0))
    throw new RangeError('maxOutputSize and maxWindowSize must be 0 or more bytes; pass byte counts.');
  signal?.throwIfAborted();
  const data = input,
    out = new Output(maxOutputSize),
    scratch = new Uint8Array(MAX_BLOCK);
  let at = 0,
    nextYield = YIELD_EVERY;
  if (data.length === 0) throw damaged('no frames');
  while (at < data.length) {
    if (at + 4 > data.length) throw damaged('a truncated frame magic number');
    const magic = (data[at] | (data[at + 1] << 8) | (data[at + 2] << 16) | (data[at + 3] << 24)) >>> 0;
    if ((magic & 0xfffffff0) === 0x184d2a50) {
      if (at + 8 > data.length) throw damaged('a truncated skippable frame');
      const size = (data[at + 4] | (data[at + 5] << 8) | (data[at + 6] << 16) | (data[at + 7] << 24)) >>> 0;
      at += 8 + size;
      if (at > data.length) throw damaged('a truncated skippable frame');
      continue;
    }
    if (magic !== 0xfd2fb528) throw damaged('a wrong frame magic number');
    at += 4;
    if (at >= data.length) throw damaged('a truncated frame header');
    const descriptor = data[at++],
      sizeFlag = descriptor >> 6,
      single = (descriptor >> 5) & 1,
      checksum = (descriptor >> 2) & 1,
      dictFlag = descriptor & 3;
    if (descriptor & 8) throw damaged('a reserved frame header bit set');
    const headerBytes = (single ? 0 : 1) + [0, 1, 2, 4][dictFlag] + [single, 2, 4, 8][sizeFlag];
    if (at + headerBytes > data.length) throw damaged('a truncated frame header');
    let window = 0;
    if (!single) {
      const w = data[at++],
        log = 10 + (w >> 3),
        base = 2 ** log;
      window = base + (base / 8) * (w & 7);
    }
    let dictionary = 0;
    for (let k = 0, n = [0, 1, 2, 4][dictFlag]; k < n; k++) dictionary += data[at++] * 2 ** (8 * k);
    if (dictionary !== 0)
      throw new MargoError(
        'unsupported',
        `This Zstandard frame needs dictionary ${dictionary}, and dictionaries are not supported; compress without a dictionary.`,
      );
    let contentSize = -1;
    const fieldSize = [single, 2, 4, 8][sizeFlag];
    if (fieldSize) {
      contentSize = 0;
      for (let k = 0; k < fieldSize; k++) contentSize += data[at++] * 2 ** (8 * k);
      if (fieldSize === 2) contentSize += 256;
    }
    if (single) window = contentSize;
    if (window > maxWindowSize)
      throw new RangeError(
        `A Zstandard frame needs a ${window}-byte window, above the ${maxWindowSize}-byte limit; raise maxWindowSize if the data is trusted.`,
      );
    if (contentSize >= 0) out.reserve(contentSize);
    const frameStart = out.length,
      blockLimit = Math.min(window, MAX_BLOCK),
      state: FrameState = { repeats: [1, 4, 8] };
    for (let last = 0; !last; ) {
      signal?.throwIfAborted();
      if (out.length >= nextYield) {
        nextYield = out.length + YIELD_EVERY;
        await new Promise((resolve) => setTimeout(resolve, 0));
        signal?.throwIfAborted();
      }
      if (at + 3 > data.length) throw damaged('a truncated block header');
      const header = data[at] | (data[at + 1] << 8) | (data[at + 2] << 16);
      at += 3;
      last = header & 1;
      const type = (header >> 1) & 3,
        size = header >>> 3;
      if (type === 3) throw damaged('a reserved block type');
      if (size > blockLimit) throw damaged('a block larger than the frame allows');
      if (type === 1) {
        if (at + 1 > data.length) throw damaged('a truncated RLE block');
        out.reserve(size);
        out.bytes.fill(data[at], out.length, out.length + size);
        out.length += size;
        at += 1;
        continue;
      }
      if (at + size > data.length) throw damaged('a truncated block');
      if (type === 0) {
        out.reserve(size);
        out.bytes.set(data.subarray(at, at + size), out.length);
        out.length += size;
      } else {
        if (size === 0) throw damaged('an empty compressed block');
        const before = out.length;
        compressedBlock(data, at, at + size, out, frameStart, window, state, scratch);
        if (out.length - before > blockLimit) throw damaged('a block that decodes larger than the frame allows');
      }
      at += size;
    }
    const produced = out.length - frameStart;
    if (contentSize >= 0 && produced !== contentSize)
      throw damaged(`a frame that decodes to ${produced} bytes but declares ${contentSize}`);
    if (checksum) {
      if (at + 4 > data.length) throw damaged('a truncated content checksum');
      const expected = (data[at] | (data[at + 1] << 8) | (data[at + 2] << 16) | (data[at + 3] << 24)) >>> 0;
      at += 4;
      if (xxh64Low(out.bytes, frameStart, out.length) !== expected) throw damaged('a content checksum mismatch');
    }
  }
  return out.bytes.length === out.length ? out.bytes : out.bytes.slice(0, out.length);
}

// xxHash64 (seed 0) on 32-bit halves; each 64-bit operation leaves its result in rh:rl.
let rh = 0,
  rl = 0;
const P1H = 0x9e3779b1,
  P1L = 0x85ebca87,
  P2H = 0xc2b2ae3d,
  P2L = 0x27d4eb4f,
  P3H = 0x165667b1,
  P3L = 0x9e3779f9,
  P4H = 0x85ebca77,
  P4L = 0xc2b2ae63,
  P5H = 0x27d4eb2f,
  P5L = 0x165667c5;

function mul(ah: number, al: number, bh: number, bl: number) {
  const a0 = al & 0xffff,
    a1 = al >>> 16,
    b0 = bl & 0xffff,
    b1 = bl >>> 16,
    p00 = a0 * b0,
    p01 = a0 * b1,
    p10 = a1 * b0,
    mid = (p00 >>> 16) + (p01 & 0xffff) + (p10 & 0xffff);
  rl = ((mid << 16) | (p00 & 0xffff)) >>> 0;
  rh = (a1 * b1 + (p01 >>> 16) + (p10 >>> 16) + (mid >>> 16) + Math.imul(al, bh) + Math.imul(ah, bl)) >>> 0;
}
function add(ah: number, al: number, bh: number, bl: number) {
  const low = al + bl;
  rl = low >>> 0;
  rh = (ah + bh + (low > 0xffffffff ? 1 : 0)) >>> 0;
}
function rotl(h: number, l: number, r: number) {
  if (r >= 32) {
    const t = h;
    h = l;
    l = t;
    r -= 32;
  }
  if (r === 0) {
    rh = h;
    rl = l;
  } else {
    rh = ((h << r) | (l >>> (32 - r))) >>> 0;
    rl = ((l << r) | (h >>> (32 - r))) >>> 0;
  }
}
/** acc = rotl(acc + lane * P2, 31) * P1 */
function round(ah: number, al: number, lh: number, ll: number) {
  mul(lh, ll, P2H, P2L);
  add(ah, al, rh, rl);
  rotl(rh, rl, 31);
  mul(rh, rl, P1H, P1L);
}
const u32 = (b: Uint8Array, i: number) => (b[i] | (b[i + 1] << 8) | (b[i + 2] << 16) | (b[i + 3] << 24)) >>> 0;

/** The low 32 bits of xxHash64 (seed 0) of `bytes[start, end)`, which a Zstandard content checksum stores. */
function xxh64Low(bytes: Uint8Array, start: number, end: number): number {
  const length = end - start;
  let p = start,
    h: number,
    l: number;
  if (length >= 32) {
    add(P1H, P1L, P2H, P2L);
    let v1h = rh,
      v1l = rl,
      v2h = P2H,
      v2l = P2L,
      v3h = 0,
      v3l = 0;
    add(0, 0, ~P1H >>> 0, ~P1L >>> 0);
    add(rh, rl, 0, 1);
    let v4h = rh,
      v4l = rl;
    for (const limit = end - 32; p <= limit; p += 32) {
      round(v1h, v1l, u32(bytes, p + 4), u32(bytes, p));
      v1h = rh;
      v1l = rl;
      round(v2h, v2l, u32(bytes, p + 12), u32(bytes, p + 8));
      v2h = rh;
      v2l = rl;
      round(v3h, v3l, u32(bytes, p + 20), u32(bytes, p + 16));
      v3h = rh;
      v3l = rl;
      round(v4h, v4l, u32(bytes, p + 28), u32(bytes, p + 24));
      v4h = rh;
      v4l = rl;
    }
    rotl(v1h, v1l, 1);
    h = rh;
    l = rl;
    rotl(v2h, v2l, 7);
    add(h, l, rh, rl);
    h = rh;
    l = rl;
    rotl(v3h, v3l, 12);
    add(h, l, rh, rl);
    h = rh;
    l = rl;
    rotl(v4h, v4l, 18);
    add(h, l, rh, rl);
    h = rh;
    l = rl;
    for (const [vh, vl] of [
      [v1h, v1l],
      [v2h, v2l],
      [v3h, v3l],
      [v4h, v4l],
    ]) {
      round(0, 0, vh, vl);
      h = (h ^ rh) >>> 0;
      l = (l ^ rl) >>> 0;
      mul(h, l, P1H, P1L);
      add(rh, rl, P4H, P4L);
      h = rh;
      l = rl;
    }
  } else {
    h = P5H;
    l = P5L;
  }
  add(h, l, Math.floor(length / 2 ** 32), length >>> 0);
  h = rh;
  l = rl;
  for (; p + 8 <= end; p += 8) {
    round(0, 0, u32(bytes, p + 4), u32(bytes, p));
    h = (h ^ rh) >>> 0;
    l = (l ^ rl) >>> 0;
    rotl(h, l, 27);
    mul(rh, rl, P1H, P1L);
    add(rh, rl, P4H, P4L);
    h = rh;
    l = rl;
  }
  if (p + 4 <= end) {
    mul(0, u32(bytes, p), P1H, P1L);
    h = (h ^ rh) >>> 0;
    l = (l ^ rl) >>> 0;
    rotl(h, l, 23);
    mul(rh, rl, P2H, P2L);
    add(rh, rl, P3H, P3L);
    h = rh;
    l = rl;
    p += 4;
  }
  for (; p < end; p++) {
    mul(0, bytes[p], P5H, P5L);
    h = (h ^ rh) >>> 0;
    l = (l ^ rl) >>> 0;
    rotl(h, l, 11);
    mul(rh, rl, P1H, P1L);
    h = rh;
    l = rl;
  }
  // Avalanche: h ^= h >> 33; h *= P2; h ^= h >> 29; h *= P3; h ^= h >> 32.
  l = (l ^ (h >>> 1)) >>> 0;
  mul(h, l, P2H, P2L);
  h = rh;
  l = rl;
  l = (l ^ ((l >>> 29) | (h << 3))) >>> 0;
  h = (h ^ (h >>> 29)) >>> 0;
  mul(h, l, P3H, P3L);
  return (rl ^ rh) >>> 0;
}
