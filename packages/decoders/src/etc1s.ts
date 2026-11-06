// BasisLZ (ETC1S) reader for `@margoengine/decoders/ktx2-gpu`, from the public .basis and ETC1S specification and the
// BasisLZ section of the KTX 2.0 specification. The Huffman coded streams are sequential, so they stay on the CPU; what
// comes out is two codebook indices per 4x4 block, which the GPU expands to texels.
import { decodeFailed } from './errors.js';

const SMALL_ZERO_RUN = 17,
  BIG_ZERO_RUN = 18,
  SMALL_REPEAT = 19,
  BIG_REPEAT = 20,
  LENGTH_ORDER = [17, 18, 19, 20, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15, 16],
  MAX_SYMBOLS = 1 << 14,
  FAST_BITS = 10,
  PRED_REPEAT_SYMBOL = 256,
  PRED_MIN_REPEAT = 3,
  PRED_COUNT_VLC_BITS = 4,
  HISTORY_RLE_THRESHOLD = 3,
  HISTORY_RLE_TOTAL = 64,
  IMAGE_DESCRIPTION = 20,
  HEADER = 20,
  P_FRAME = 2;

const damaged = (what: string): Error => decodeFailed(`KTX2: BasisLZ ${what} is damaged; re-export the file`);

class Bits {
  private at = 0;
  private held = 0;
  private count = 0;
  constructor(private readonly bytes: Uint8Array) {}

  private fill(want: number): void {
    while (this.count < want) {
      if (this.at >= this.bytes.length && this.count + 8 * (this.at - this.bytes.length) > 64) throw damaged('stream');
      const byte = this.at < this.bytes.length ? this.bytes[this.at] : 0;
      this.at++;
      this.held |= byte << this.count;
      this.count += 8;
    }
  }
  /** Reads up to 16 bits, first bit lowest. */
  get(bits: number): number {
    if (!bits) return 0;
    this.fill(bits);
    const value = this.held & ((1 << bits) - 1);
    this.held >>>= bits;
    this.count -= bits;
    return value;
  }
  peek(bits: number): number {
    this.fill(bits);
    return this.held & ((1 << bits) - 1);
  }
  skip(bits: number): void {
    this.held >>>= bits;
    this.count -= bits;
  }
  vlc(chunkBits: number): number {
    const size = 1 << chunkBits,
      mask = size - 1;
    let value = 0,
      offset = 0;
    for (;;) {
      const chunk = this.get(chunkBits + 1);
      value = (value | ((chunk & mask) << offset)) >>> 0;
      offset += chunkBits;
      if (!(chunk & size)) return value;
      if (offset >= 32) throw damaged('length code');
    }
  }
}

// A canonical Huffman table. Codes are read first bit first, so the fast table is indexed by the bit-reversed code; codes
// longer than FAST_BITS walk the canonical lengths one bit at a time.
class Huffman {
  private readonly fast: Int32Array;
  private readonly fastBits: number;
  private readonly first = new Int32Array(18);
  private readonly start = new Int32Array(18);
  private readonly counts = new Int32Array(18);
  private readonly symbols: Uint16Array;
  private readonly longest: number;

  constructor(lengths: Uint8Array) {
    const { first, start, counts } = this;
    let used = 0,
      longest = 0;
    for (const length of lengths)
      if (length) {
        counts[length]++;
        used++;
        if (length > longest) longest = length;
      }
    this.longest = longest;
    this.symbols = new Uint16Array(used);
    let code = 0,
      index = 0;
    for (let length = 1; length <= longest; length++) {
      first[length] = code;
      start[length] = index;
      code = (code + counts[length]) << 1;
      index += counts[length];
    }
    const next = start.slice(),
      codes = first.slice();
    this.fastBits = Math.min(FAST_BITS, Math.max(longest, 1));
    this.fast = new Int32Array(1 << this.fastBits).fill(-1);
    lengths.forEach((length, symbol) => {
      if (!length) return;
      this.symbols[next[length]++] = symbol;
      const value = codes[length]++;
      if (length > this.fastBits) return;
      let reversed = 0;
      for (let bit = 0; bit < length; bit++) if (value & (1 << bit)) reversed |= 1 << (length - 1 - bit);
      for (let fill = reversed; fill < this.fast.length; fill += 1 << length) this.fast[fill] = (symbol << 5) | length;
    });
  }

  decode(bits: Bits): number {
    const hit = this.fast[bits.peek(this.fastBits)];
    if (hit >= 0) {
      bits.skip(hit & 31);
      return hit >> 5;
    }
    let code = 0;
    for (let length = 1; length <= this.longest; length++) {
      code = (code << 1) | bits.get(1);
      const offset = code - this.first[length];
      if (offset >= 0 && offset < this.counts[length]) return this.symbols[this.start[length] + offset];
    }
    throw damaged('Huffman code');
  }
}

function readHuffman(bits: Bits): Huffman {
  const total = bits.get(14),
    lengthCodes = bits.get(5);
  if (total > MAX_SYMBOLS || !lengthCodes || lengthCodes > LENGTH_ORDER.length) throw damaged('Huffman table');
  const small = new Uint8Array(LENGTH_ORDER.length);
  for (let i = 0; i < lengthCodes; i++) small[LENGTH_ORDER[i]] = bits.get(3);
  const table = new Huffman(small),
    lengths = new Uint8Array(total);
  for (let at = 0; at < total; ) {
    const code = table.decode(bits);
    if (code <= 16) {
      lengths[at++] = code;
      continue;
    }
    let run: number,
      value = 0;
    if (code === SMALL_ZERO_RUN) run = bits.get(3) + 3;
    else if (code === BIG_ZERO_RUN) run = bits.get(7) + 11;
    else if (code === SMALL_REPEAT || code === BIG_REPEAT) {
      if (!at || !lengths[at - 1]) throw damaged('Huffman table');
      value = lengths[at - 1];
      run = code === SMALL_REPEAT ? bits.get(2) + 3 : bits.get(7) + 7;
    } else throw damaged('Huffman table');
    if (at + run > total) throw damaged('Huffman table');
    lengths.fill(value, at, at + run);
    at += run;
  }
  return new Huffman(lengths);
}

// Each entry: red, green and blue expanded to 8 bits, then the intensity table in the top byte.
function readEndpoints(bytes: Uint8Array, count: number): Uint32Array {
  const bits = new Bits(bytes),
    models = [readHuffman(bits), readHuffman(bits), readHuffman(bits)],
    intensity = readHuffman(bits),
    gray = bits.get(1) === 1,
    out = new Uint32Array(count),
    previous = [16, 16, 16];
  let previousIntensity = 0;
  for (let i = 0; i < count; i++) {
    previousIntensity = (intensity.decode(bits) + previousIntensity) & 7;
    for (let c = 0; c < (gray ? 1 : 3); c++) {
      const was = previous[c],
        delta = models[was <= 9 ? 0 : was <= 21 ? 1 : 2].decode(bits);
      previous[c] = (was + delta) & 31;
    }
    const [red, green, blue] = (gray ? [previous[0], previous[0], previous[0]] : previous).map(
      (value) => (value << 3) | (value >> 2),
    );
    out[i] = (red | (green << 8) | (blue << 16) | (previousIntensity << 24)) >>> 0;
  }
  return out;
}

// Each entry: 16 selectors of 2 bits, texel x + 4y at bit 2(x + 4y).
function readSelectors(bytes: Uint8Array, count: number): Uint32Array {
  const bits = new Bits(bytes),
    out = new Uint32Array(count);
  if (bits.get(1) || bits.get(1)) throw decodeFailed('KTX2: BasisLZ global selector codebooks are not supported');
  const raw = bits.get(1) === 1,
    model = raw ? undefined : readHuffman(bits),
    previous = [0, 0, 0, 0];
  for (let i = 0; i < count; i++) {
    let packed = 0;
    for (let row = 0; row < 4; row++) {
      previous[row] = raw || !i ? bits.get(8) : model!.decode(bits) ^ previous[row];
      packed |= previous[row] << (row * 8);
    }
    out[i] = packed >>> 0;
  }
  return out;
}

/** The two codebooks, and the Huffman tables every slice shares. */
export interface BasisLZTables {
  /** One word per endpoint: red, green, blue, intensity table. */
  endpoints: Uint32Array;
  /** One word per selector: 2 bits per texel. */
  selectors: Uint32Array;
  predictions: Huffman;
  deltas: Huffman;
  selectorModel: Huffman;
  historyRuns: Huffman;
  historySize: number;
  images: { flags: number; rgbAt: number; rgbLength: number; alphaAt: number; alphaLength: number }[];
}

/**
 * Reads the supercompression global data of a BasisLZ file.
 *
 * @throws MargoError `failed` on damaged tables, or texture video, whose frames depend on each other.
 */
export function readBasisLZ(global: Uint8Array, imageCount: number): BasisLZTables {
  if (global.length < HEADER) throw damaged('global data');
  const view = new DataView(global.buffer, global.byteOffset, global.byteLength),
    endpointCount = view.getUint16(0, true),
    selectorCount = view.getUint16(2, true),
    endpointLength = view.getUint32(4, true),
    selectorLength = view.getUint32(8, true),
    tableLength = view.getUint32(12, true),
    extended = view.getUint32(16, true),
    endpointAt = HEADER + imageCount * IMAGE_DESCRIPTION,
    selectorAt = endpointAt + endpointLength,
    tableAt = selectorAt + selectorLength;
  if (tableAt + tableLength + extended > global.length) throw damaged('global data');
  const images: BasisLZTables['images'] = [];
  for (let i = 0; i < imageCount; i++) {
    const at = HEADER + i * IMAGE_DESCRIPTION,
      image = {
        flags: view.getUint32(at, true),
        rgbAt: view.getUint32(at + 4, true),
        rgbLength: view.getUint32(at + 8, true),
        alphaAt: view.getUint32(at + 12, true),
        alphaLength: view.getUint32(at + 16, true),
      };
    if (image.flags & P_FRAME) throw decodeFailed('KTX2: texture video is not supported here; use KTX2LayerDecoder');
    images.push(image);
  }
  const bits = new Bits(global.subarray(tableAt, tableAt + tableLength)),
    predictions = readHuffman(bits),
    deltas = readHuffman(bits),
    selectorModel = readHuffman(bits),
    historyRuns = readHuffman(bits),
    historySize = bits.get(13);
  return {
    endpoints: readEndpoints(global.subarray(endpointAt, selectorAt), endpointCount),
    selectors: readSelectors(global.subarray(selectorAt, tableAt), selectorCount),
    predictions,
    deltas,
    selectorModel,
    historyRuns,
    historySize,
    images,
  };
}

/**
 * Decodes one slice into `out`, one word per block in raster order: the endpoint index, and the selector index above it.
 *
 * @throws MargoError `failed` when an index falls outside its codebook.
 */
export function readETC1SSlice(tables: BasisLZTables, slice: Uint8Array, blocksX: number, blocksY: number, out: Uint32Array): void {
  const { predictions, deltas, selectorModel, historyRuns, historySize } = tables,
    endpointCount = tables.endpoints.length,
    selectorCount = tables.selectors.length,
    bits = new Bits(slice),
    rleSymbol = historySize + selectorCount,
    history = new Int32Array(historySize),
    // Endpoint index and prediction bits of the last two rows of blocks.
    indices = [new Uint16Array(blocksX), new Uint16Array(blocksX)],
    predicted = [new Uint8Array(blocksX), new Uint8Array(blocksX)];
  let rover = historySize >> 1,
    selectorRun = 0,
    bitsNow = 0,
    lastSymbol = 0,
    repeats = 0,
    lastEndpoint = 0;
  for (let y = 0; y < blocksY; y++) {
    const row = y & 1;
    for (let x = 0; x < blocksX; x++) {
      if (!(x & 1)) {
        if (!row) {
          if (repeats) {
            repeats--;
            bitsNow = lastSymbol;
          } else {
            bitsNow = predictions.decode(bits);
            if (bitsNow === PRED_REPEAT_SYMBOL) {
              repeats = bits.vlc(PRED_COUNT_VLC_BITS) + PRED_MIN_REPEAT - 1;
              bitsNow = lastSymbol;
            } else lastSymbol = bitsNow;
          }
          predicted[row ^ 1][x] = bitsNow >> 4;
        } else bitsNow = predicted[row][x];
      }
      const prediction = bitsNow & 3;
      bitsNow >>= 2;
      let endpoint: number;
      if (prediction === 0) {
        if (!x) throw damaged('endpoint prediction');
        endpoint = lastEndpoint;
      } else if (prediction === 1) {
        if (!y) throw damaged('endpoint prediction');
        endpoint = indices[row ^ 1][x];
      } else if (prediction === 2) {
        if (!x || !y) throw damaged('endpoint prediction');
        endpoint = indices[row ^ 1][x - 1];
      } else {
        endpoint = deltas.decode(bits) + lastEndpoint;
        if (endpoint >= endpointCount) endpoint -= endpointCount;
      }
      if (endpoint >= endpointCount) throw damaged('endpoint index');
      indices[row][x] = endpoint;
      lastEndpoint = endpoint;

      let symbol: number;
      if (selectorRun > 0) {
        selectorRun--;
        symbol = selectorCount;
      } else {
        symbol = selectorModel.decode(bits);
        if (symbol === rleSymbol) {
          const run = historyRuns.decode(bits);
          selectorRun =
            (run === HISTORY_RLE_TOTAL - 1 ? bits.vlc(7) + HISTORY_RLE_THRESHOLD : run + HISTORY_RLE_THRESHOLD) - 1;
          symbol = selectorCount;
        }
      }
      let selector: number;
      if (symbol >= selectorCount) {
        const slot = symbol - selectorCount;
        if (slot >= historySize) throw damaged('selector history');
        selector = history[slot];
        if (slot) {
          const half = slot >> 1,
            moved = history[half];
          history[half] = history[slot];
          history[slot] = moved;
        }
      } else {
        selector = symbol;
        if (historySize) {
          history[rover++] = selector;
          if (rover === historySize) rover = historySize >> 1;
        }
      }
      if (selector >= selectorCount) throw damaged('selector index');
      out[y * blocksX + x] = (endpoint | (selector << 16)) >>> 0;
    }
  }
}
