// LAZ (LASzip compressed LAS) decoder, written clean room from public descriptions only: M. Isenburg, "LASzip: lossless
// compression of LiDAR data", Photogrammetric Engineering and Remote Sensing 79(2), 2013 (the item predictors and the
// integer corrector coding); the public LAZ format specification (the "laszip encoded" record 22204, compressor and
// item ids, the chunk table and the layered point14 chunks); and the arithmetic range coding literature (I. H. Witten,
// R. M. Neal and J. G. Cleary, "Arithmetic coding for data compression", CACM 30(6), 1987; A. Said, "Introduction to
// arithmetic coding: theory and practice", HP Labs HPL-2004-76, 2004, for the 32-bit renormalising coder with
// adaptive bit and symbol models). No source code of LASzip, laz-perf, PDAL, lazrs or any loader was read.
//
// Decoding runs one chunk at a time: `lazChunks` yields the uncompressed records of each chunk, so the whole
// uncompressed file is never held. Every read is bounded by its chunk or layer; a corrupt stream throws a RangeError
// or TypeError that names the chunk, and anything not implemented throws a MargoError with code `unsupported`.
import { MargoError } from '@margoengine/math/errors';
import type { LASHeader, LASRecord, LazDecoder } from './las.js';

/** One item of a LASzip record: a part of each point record and how it is compressed. */
export interface LazItem {
  /** LASzip item type id: 0 BYTE, 6 POINT10, 7 GPSTIME11, 8 RGB12, 9 WAVEPACKET13, 10 POINT14, 11 RGB14, 12 RGBNIR14, 13 WAVEPACKET14, 14 BYTE14. */
  readonly type: number;
  /** The item's name, for messages (`POINT10`, `RGB14`, ...). */
  readonly name: string;
  /** Bytes of the point record the item covers. */
  readonly size: number;
  /** Compression version of the item. */
  readonly version: number;
}

/** The LASzip record (user id `laszip encoded`, record id 22204) of a LAZ file. */
export interface LazInfo {
  /** 1 pointwise, 2 pointwise chunked (formats 0 to 5), 3 layered chunked (formats 6 to 10). */
  readonly compressor: number;
  /** 0: arithmetic coding (the only coder defined). */
  readonly coder: number;
  /** Version of the software that wrote the file, as `major.minor.revision`. */
  readonly version: string;
  readonly options: number;
  /** Points per chunk, or `'variable'` when the chunk table stores each chunk's count. */
  readonly chunkSize: number | 'variable';
  readonly items: readonly LazItem[];
}

/** Options of `lazChunks`. */
export interface LazChunkOptions {
  /** Stops decoding between chunks. */
  readonly signal?: AbortSignal;
}

const ITEM_NAMES = [
  'BYTE',
  'SHORT',
  'INT',
  'LONG',
  'FLOAT',
  'DOUBLE',
  'POINT10',
  'GPSTIME11',
  'RGB12',
  'WAVEPACKET13',
  'POINT14',
  'RGB14',
  'RGBNIR14',
  'WAVEPACKET14',
  'BYTE14',
];
const BYTE = 0,
  POINT10 = 6,
  GPSTIME11 = 7,
  RGB12 = 8,
  WAVEPACKET13 = 9,
  POINT14 = 10,
  RGB14 = 11,
  RGBNIR14 = 12,
  WAVEPACKET14 = 13,
  BYTE14 = 14;
const VARIABLE = 0xffffffff;

/** Reads the LASzip record. Throws a TypeError when the file has none or it is malformed. */
export function lazInfo(records: readonly LASRecord[]): LazInfo {
  const record = records.find((r) => r.userId === 'laszip encoded' && r.recordId === 22204);
  if (!record)
    throw new TypeError(
      'LAZ file has no LASzip record (user id "laszip encoded", record 22204); the file is corrupt or not LAZ',
    );
  const d = record.data,
    view = new DataView(d.buffer, d.byteOffset, d.byteLength);
  if (d.byteLength < 34) throw new TypeError('LASzip record is shorter than 34 bytes; the file is corrupt');
  const count = view.getUint16(32, true);
  if (d.byteLength < 34 + count * 6)
    throw new TypeError(`LASzip record lists ${count} items but holds fewer; the file is corrupt`);
  const items: LazItem[] = [];
  for (let i = 0; i < count; i++) {
    const type = view.getUint16(34 + i * 6, true);
    items.push({
      type,
      name: ITEM_NAMES[type] ?? `item ${type}`,
      size: view.getUint16(36 + i * 6, true),
      version: view.getUint16(38 + i * 6, true),
    });
  }
  const chunk = view.getUint32(12, true);
  return {
    compressor: view.getUint16(0, true),
    coder: view.getUint16(2, true),
    version: `${view.getUint8(4)}.${view.getUint8(5)}.${view.getUint16(6, true)}`,
    options: view.getUint32(8, true),
    chunkSize: chunk === VARIABLE ? 'variable' : chunk,
    items,
  };
}

/** The items each point format compresses into, in record order (without extra bytes). */
function expectedItems(format: number, layered: boolean): number[] {
  if (layered)
    return [POINT14, ...(format === 7 ? [RGB14] : format === 8 || format === 10 ? [RGBNIR14] : [])].concat(
      format === 9 || format === 10 ? [WAVEPACKET14] : [],
    );
  return [
    POINT10,
    ...([1, 3, 4, 5].includes(format) ? [GPSTIME11] : []),
    ...([2, 3, 5].includes(format) ? [RGB12] : []),
    ...(format === 4 || format === 5 ? [WAVEPACKET13] : []),
  ];
}

const unsupported = (what: string) =>
  new MargoError(
    'unsupported',
    `LAZ ${what} is not supported by this decoder; decompress the file to LAS first (for example with laszip or PDAL)`,
  );

/** Checks the items against the header and that every one is implemented. */
function checkItems(info: LazInfo, header: LASHeader) {
  if (info.coder !== 0) throw unsupported(`coder ${info.coder} (only arithmetic coding, 0, is defined)`);
  if (info.compressor === 0 || info.compressor === 1)
    throw unsupported(
      `compressor ${info.compressor} (${info.compressor ? 'pointwise without chunks, from LASzip 1.x' : 'none'})`,
    );
  if (info.compressor !== 2 && info.compressor !== 3) throw unsupported(`compressor ${info.compressor}`);
  const layered = info.compressor === 3,
    format = header.pointFormat;
  if (layered !== format >= 6)
    throw unsupported(
      `point format ${format} with compressor ${info.compressor} (formats 0 to 5 use 2, formats 6 to 10 use 3)`,
    );
  const expected = expectedItems(format, layered),
    types = info.items.map((i) => i.type),
    extra = types.slice(expected.length),
    total = info.items.reduce((s, i) => s + i.size, 0);
  const extraType = layered ? BYTE14 : BYTE;
  if (
    expected.some((t, i) => types[i] !== t) ||
    extra.some((t) => t !== extraType) ||
    total !== header.pointRecordLength
  )
    throw new TypeError(
      `LASzip items ${info.items.map((i) => `${i.name}(${i.size})`).join(' ')} do not match point format ${format} with ${header.pointRecordLength}-byte records; the file is corrupt`,
    );
  const sizes: Record<number, number> = {
    [POINT10]: 20,
    [GPSTIME11]: 8,
    [RGB12]: 6,
    [POINT14]: 30,
    [RGB14]: 6,
    [RGBNIR14]: 8,
  };
  for (const item of info.items) {
    if (item.type === WAVEPACKET13 || item.type === WAVEPACKET14)
      throw unsupported(`item ${item.name} (waveform packets of point formats 4, 5, 9 and 10)`);
    if (sizes[item.type] !== undefined && sizes[item.type] !== item.size)
      throw new TypeError(
        `LASzip item ${item.name} has size ${item.size}, not ${sizes[item.type]}; the file is corrupt`,
      );
    const version = layered ? 3 : 2;
    if (item.version !== version)
      throw unsupported(
        `item ${item.name} version ${item.version} (this decoder reads version ${version}, what LASzip 2 and 3 write)`,
      );
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Range decoder with adaptive models. 32-bit interval [base, base + length) renormalised a byte at a time when the
// length falls below 2^24; probabilities in 13 bits (bits) and 15 bits (symbols), counts rescaled when they overflow.
// ---------------------------------------------------------------------------------------------------------------

const MIN_LENGTH = 0x01000000,
  BIT_SHIFT = 13,
  BIT_MAX = 1 << 13,
  SYMBOL_SHIFT = 15,
  SYMBOL_MAX = 1 << 15;

/** An adaptive binary model. */
class BitModel {
  prob = 0;
  zeros = 0;
  total = 0;
  cycle = 0;
  until = 0;
  constructor() {
    this.reset();
  }
  reset() {
    this.zeros = 1;
    this.total = 2;
    this.prob = 1 << (BIT_SHIFT - 1);
    this.cycle = this.until = 4;
  }
  update() {
    if ((this.total += this.cycle) > BIT_MAX) {
      this.total = (this.total + 1) >>> 1;
      this.zeros = (this.zeros + 1) >>> 1;
      if (this.zeros === this.total) this.total++;
    }
    const scale = Math.floor(0x80000000 / this.total);
    this.prob = Math.floor((this.zeros * scale) / 2 ** (31 - BIT_SHIFT));
    this.cycle = Math.min((5 * this.cycle) >>> 2, 64);
    this.until = this.cycle;
  }
}

/** An adaptive model of `symbols` symbols, with a lookup table to start the search when there are more than 16. */
class SymbolModel {
  readonly symbols: number;
  readonly last: number;
  readonly dist: Uint32Array;
  readonly counts: Uint32Array;
  readonly table: Uint32Array | undefined;
  readonly tableSize: number;
  readonly tableShift: number;
  total = 0;
  cycle = 0;
  until = 0;
  constructor(symbols: number) {
    this.symbols = symbols;
    this.last = symbols - 1;
    this.dist = new Uint32Array(symbols);
    this.counts = new Uint32Array(symbols);
    if (symbols > 16) {
      let bits = 3;
      while (symbols > 1 << (bits + 2)) bits++;
      this.tableSize = 1 << bits;
      this.tableShift = SYMBOL_SHIFT - bits;
      this.table = new Uint32Array(this.tableSize + 2);
    } else {
      this.tableSize = 0;
      this.tableShift = 0;
    }
    this.reset();
  }
  reset() {
    this.total = 0;
    this.cycle = this.symbols;
    this.counts.fill(1);
    this.update();
    this.cycle = this.until = (this.symbols + 6) >>> 1;
  }
  update() {
    const { counts, dist, symbols } = this;
    if ((this.total += this.cycle) > SYMBOL_MAX) {
      let total = 0;
      for (let k = 0; k < symbols; k++) total += counts[k] = (counts[k] + 1) >>> 1;
      this.total = total;
    }
    const scale = Math.floor(0x80000000 / this.total),
      down = 2 ** (31 - SYMBOL_SHIFT);
    let sum = 0;
    const table = this.table;
    if (!table)
      for (let k = 0; k < symbols; k++) {
        dist[k] = Math.floor((scale * sum) / down);
        sum += counts[k];
      }
    else {
      let s = 0;
      for (let k = 0; k < symbols; k++) {
        dist[k] = Math.floor((scale * sum) / down);
        sum += counts[k];
        const w = dist[k] >>> this.tableShift;
        while (s < w) table[++s] = k - 1;
      }
      table[0] = 0;
      while (s <= this.tableSize) table[++s] = symbols - 1;
    }
    this.cycle = Math.min((5 * this.cycle) >>> 2, (symbols + 6) << 3);
    this.until = this.cycle;
  }
}

const EMPTY: Uint8Array = new Uint8Array(0);

/** Arithmetic decoder over one byte range. */
class RangeDecoder {
  private bytes = EMPTY;
  private at = 0;
  private end = 0;
  private over = 0;
  private value = 0;
  private length = 0;
  /** What the range is, for messages ("chunk 3", "chunk 3 intensity layer"). */
  label = '';

  init(bytes: Uint8Array, start: number, end: number, label: string) {
    this.bytes = bytes;
    this.at = start;
    this.end = end;
    this.over = 0;
    this.label = label;
    this.length = 0xffffffff;
    this.value = this.byte() * 0x1000000 + this.byte() * 0x10000 + this.byte() * 0x100 + this.byte();
    // A coder that starts at its full length can never hold the top value; seeing it means the bytes are not LAZ.
    if (this.value === 0xffffffff)
      throw new RangeError(`LAZ ${label} starts with an invalid code; the file is corrupt`);
  }

  private byte(): number {
    if (this.at < this.end) return this.bytes[this.at++];
    // The encoder's final bytes always cover the decoder's 4-byte look-ahead; reading further means corrupt data.
    if (++this.over > 4) throw new RangeError(`LAZ ${this.label} reads past its end; the file is corrupt`);
    return 0;
  }

  private renorm() {
    do {
      this.value = this.value * 256 + this.byte();
      this.length *= 256;
    } while (this.length < MIN_LENGTH);
  }

  decodeBit(m: BitModel): number {
    const x = m.prob * (this.length >>> BIT_SHIFT);
    let bit: number;
    if (this.value < x) {
      bit = 0;
      this.length = x;
      m.zeros++;
    } else {
      bit = 1;
      this.value -= x;
      this.length -= x;
    }
    if (this.length < MIN_LENGTH) this.renorm();
    if (--m.until === 0) m.update();
    return bit;
  }

  decodeSymbol(m: SymbolModel): number {
    let sym: number,
      x: number,
      y = this.length;
    const unit = (this.length = this.length >>> SYMBOL_SHIFT),
      dist = m.dist;
    if (m.table) {
      const dv = Math.floor(this.value / unit),
        t = Math.min(dv >>> m.tableShift, m.tableSize);
      sym = m.table[t];
      let n = m.table[t + 1] + 1;
      while (n > sym + 1) {
        const k = (sym + n) >>> 1;
        if (dist[k] > dv) n = k;
        else sym = k;
      }
      x = dist[sym] * unit;
      if (sym !== m.last) y = dist[sym + 1] * unit;
    } else {
      x = sym = 0;
      let n = m.symbols,
        k = n >>> 1;
      do {
        const z = unit * dist[k];
        if (z > this.value) {
          n = k;
          y = z;
        } else {
          sym = k;
          x = z;
        }
      } while ((k = (sym + n) >>> 1) !== sym);
    }
    this.value -= x;
    this.length = y - x;
    if (this.length < MIN_LENGTH) this.renorm();
    m.counts[sym]++;
    if (--m.until === 0) m.update();
    return sym;
  }

  /** `bits` raw bits (up to 32), as an unsigned number. */
  readBits(bits: number): number {
    if (bits > 19) {
      const low = this.readBits(16);
      return this.readBits(bits - 16) * 0x10000 + low;
    }
    const unit = (this.length = this.length >>> bits),
      sym = Math.floor(this.value / unit);
    this.value -= unit * sym;
    if (this.length < MIN_LENGTH) this.renorm();
    return sym;
  }

  readInt(): number {
    const low = this.readBits(16);
    return this.readBits(16) * 0x10000 + low;
  }
}

/**
 * Integer decompressor: a prediction plus a corrector. The corrector's bit length k is coded with a symbol model per
 * context; then the corrector itself, in k bits (a symbol model for k up to 8, otherwise the top 8 bits modelled and
 * the rest raw). k = 0 codes the correctors 0 and 1 with a bit model.
 */
class IntegerDecompressor {
  /** Bit length of the last corrector (a context for the next coordinate). */
  k = 0;
  private readonly corrBits: number;
  private readonly corrRange: number;
  private readonly corrMin: number;
  private readonly kModels: SymbolModel[];
  private readonly zero = new BitModel();
  private readonly corrector: SymbolModel[] = [];
  constructor(
    private readonly dec: RangeDecoder,
    bits = 16,
    contexts = 1,
    private readonly bitsHigh = 8,
  ) {
    if (bits && bits < 32) {
      this.corrBits = bits;
      this.corrRange = 2 ** bits;
      this.corrMin = -(this.corrRange / 2);
    } else {
      this.corrBits = 32;
      this.corrRange = 0;
      this.corrMin = -0x80000000;
    }
    this.kModels = Array.from({ length: contexts }, () => new SymbolModel(this.corrBits + 1));
    for (let i = 1; i <= this.corrBits; i++) this.corrector[i] = new SymbolModel(1 << Math.min(i, bitsHigh));
  }

  reset() {
    for (const m of this.kModels) m.reset();
    this.zero.reset();
    for (let i = 1; i <= this.corrBits; i++) this.corrector[i].reset();
  }

  decompress(pred: number, context = 0): number {
    const real = pred + this.corrector_(this.kModels[context]);
    if (!this.corrRange) return real | 0;
    return real < 0 ? real + this.corrRange : real >= this.corrRange ? real - this.corrRange : real;
  }

  private corrector_(model: SymbolModel): number {
    const dec = this.dec,
      k = (this.k = dec.decodeSymbol(model));
    if (!k) return dec.decodeBit(this.zero);
    if (k >= 32) return this.corrMin;
    let c: number;
    if (k <= this.bitsHigh) c = dec.decodeSymbol(this.corrector[k]);
    else {
      const low = k - this.bitsHigh;
      c = dec.decodeSymbol(this.corrector[k]) * 2 ** low + dec.readBits(low);
    }
    return c >= 2 ** (k - 1) ? c + 1 : c - (2 ** k - 1);
  }
}

/** Running median of the last five values, kept by insertion (the coordinate difference predictor). */
class Median5 {
  private readonly v = new Int32Array(5);
  private high = true;
  reset() {
    this.v.fill(0);
    this.high = true;
  }
  get(): number {
    return this.v[2];
  }
  add(x: number) {
    const v = this.v;
    if (this.high) {
      if (x < v[2]) {
        v[4] = v[3];
        v[3] = v[2];
        if (x < v[0]) {
          v[2] = v[1];
          v[1] = v[0];
          v[0] = x;
        } else if (x < v[1]) {
          v[2] = v[1];
          v[1] = x;
        } else v[2] = x;
      } else {
        if (x < v[3]) {
          v[4] = v[3];
          v[3] = x;
        } else v[4] = x;
        this.high = false;
      }
    } else if (v[2] < x) {
      v[0] = v[1];
      v[1] = v[2];
      if (v[4] < x) {
        v[2] = v[3];
        v[3] = v[4];
        v[4] = x;
      } else if (v[3] < x) {
        v[2] = v[3];
        v[3] = x;
      } else v[2] = x;
    } else {
      if (v[1] < x) {
        v[0] = v[1];
        v[1] = x;
      } else v[0] = x;
      this.high = true;
    }
  }
}

const median5s = (n: number) => Array.from({ length: n }, () => new Median5());
const clampByte = (n: number) => (n <= 0 ? 0 : n >= 255 ? 255 : n);
const lazy = (models: (SymbolModel | undefined)[], i: number, symbols: number) =>
  (models[i] ??= new SymbolModel(symbols));
const resetAll = (models: readonly (SymbolModel | undefined)[]) => {
  for (const m of models) m?.reset();
};

// Return contexts of the point10 item, indexed [returns * 8 + return number]: a map of the return to 16 groups, and
// its distance from the last return.
// biome-ignore format: an 8 x 8 table
const MAP10 = new Uint8Array([
  15, 14, 13, 12, 11, 10, 9, 8,
  14, 0, 1, 3, 6, 10, 10, 9,
  13, 1, 2, 4, 7, 11, 11, 10,
  12, 3, 4, 5, 8, 12, 12, 11,
  11, 6, 7, 8, 9, 13, 13, 12,
  10, 10, 11, 12, 13, 14, 14, 13,
  9, 10, 11, 12, 13, 14, 15, 14,
  8, 9, 10, 11, 12, 13, 14, 15,
]);
const LEVEL10 = new Uint8Array(64).map((_, i) => Math.abs((i >> 3) - (i & 7)));
// The point14 item's six return groups and eight levels, indexed [returns * 16 + return number]. From three returns on,
// the first return is group 3, the last 5 and those between 4: checked against real files up to six returns.
// biome-ignore format: a 16 x 16 table
const MAP14 = new Uint8Array([
  0, 1, 2, 3, 4, 5, 3, 4, 4, 5, 5, 5, 5, 5, 5, 5,
  1, 0, 1, 3, 4, 5, 3, 4, 4, 5, 5, 5, 5, 5, 5, 5,
  2, 1, 2, 4, 5, 3, 4, 4, 5, 5, 5, 5, 5, 5, 5, 5,
  3, 3, 4, 5, 4, 5, 4, 4, 5, 5, 5, 5, 5, 5, 5, 5,
  4, 3, 4, 4, 5, 5, 4, 4, 5, 5, 5, 5, 5, 5, 5, 5,
  5, 3, 4, 4, 4, 5, 4, 4, 5, 5, 5, 5, 5, 5, 5, 5,
  3, 3, 4, 4, 4, 4, 5, 4, 5, 5, 5, 5, 5, 5, 5, 5,
  4, 3, 4, 4, 4, 4, 4, 5, 5, 5, 5, 5, 5, 5, 5, 5,
  4, 3, 4, 4, 4, 4, 4, 4, 5, 5, 5, 5, 5, 5, 5, 5,
  5, 3, 4, 4, 4, 4, 4, 4, 4, 5, 5, 5, 5, 5, 5, 5,
  5, 3, 4, 4, 4, 4, 4, 4, 4, 4, 5, 5, 5, 5, 5, 5,
  5, 3, 4, 4, 4, 4, 4, 4, 4, 4, 4, 5, 5, 5, 5, 5,
  5, 3, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 5, 5, 5, 5,
  5, 3, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 5, 5, 5,
  5, 3, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 5, 5,
  5, 3, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 5,
]);
const LEVEL14 = new Uint8Array(256).map((_, i) => Math.min(Math.abs((i >> 4) - (i & 15)), 7));

/** A part of each point record, decoded from one or more arithmetic streams. */
interface ItemReader {
  readonly size: number;
  /** Starts a chunk from its first point, stored raw at `at`. */
  init(view: DataView, at: number): void;
  /** Decodes the next point's item into `at`. */
  read(view: DataView, at: number): void;
}

/** A layered item: its layer sizes come first in the chunk, then the layers themselves. */
interface LayeredReader extends ItemReader {
  readonly layers: number;
  /** Assigns layer `i` its bytes (an empty range means the value never changes in the chunk). */
  layer(i: number, bytes: Uint8Array, start: number, end: number, label: string): void;
}

// --- point10 family (point formats 0 to 5), version 2, one stream per chunk ---------------------------------------

class Point10Reader implements ItemReader {
  readonly size = 20;
  private x = 0;
  private y = 0;
  private z = 0;
  private intensity = 0;
  private bits = 0;
  private cls = 0;
  private angle = 0;
  private user = 0;
  private psid = 0;
  private readonly lastIntensity = new Uint16Array(16);
  private readonly lastHeight = new Int32Array(8);
  private readonly medianX = median5s(16);
  private readonly medianY = median5s(16);
  private readonly changed = new SymbolModel(64);
  private readonly angleModels = [new SymbolModel(256), new SymbolModel(256)];
  private readonly bitByte: (SymbolModel | undefined)[] = [];
  private readonly classes: (SymbolModel | undefined)[] = [];
  private readonly userData: (SymbolModel | undefined)[] = [];
  private readonly icIntensity: IntegerDecompressor;
  private readonly icPsid: IntegerDecompressor;
  private readonly icX: IntegerDecompressor;
  private readonly icY: IntegerDecompressor;
  private readonly icZ: IntegerDecompressor;
  constructor(private readonly dec: RangeDecoder) {
    this.icIntensity = new IntegerDecompressor(dec, 16, 4);
    this.icPsid = new IntegerDecompressor(dec, 16);
    this.icX = new IntegerDecompressor(dec, 32, 2);
    this.icY = new IntegerDecompressor(dec, 32, 22);
    this.icZ = new IntegerDecompressor(dec, 32, 20);
  }

  init(view: DataView, at: number) {
    for (const m of this.medianX) m.reset();
    for (const m of this.medianY) m.reset();
    this.lastIntensity.fill(0);
    this.lastHeight.fill(0);
    this.changed.reset();
    for (const m of this.angleModels) m.reset();
    resetAll(this.bitByte);
    resetAll(this.classes);
    resetAll(this.userData);
    for (const ic of [this.icIntensity, this.icPsid, this.icX, this.icY, this.icZ]) ic.reset();
    this.x = view.getInt32(at, true);
    this.y = view.getInt32(at + 4, true);
    this.z = view.getInt32(at + 8, true);
    // The intensity is predicted per return group from zero, not from the first point.
    this.intensity = 0;
    this.bits = view.getUint8(at + 14);
    this.cls = view.getUint8(at + 15);
    this.angle = view.getUint8(at + 16);
    this.user = view.getUint8(at + 17);
    this.psid = view.getUint16(at + 18, true);
  }

  read(view: DataView, at: number) {
    const dec = this.dec,
      changed = dec.decodeSymbol(this.changed);
    if (changed & 32) this.bits = dec.decodeSymbol(lazy(this.bitByte, this.bits, 256));
    const r = this.bits & 7,
      n = (this.bits >> 3) & 7,
      m = MAP10[n * 8 + r],
      l = LEVEL10[n * 8 + r],
      single = n === 1 ? 1 : 0;
    if (changed) {
      if (changed & 16) {
        this.intensity = this.icIntensity.decompress(this.lastIntensity[m], m < 3 ? m : 3);
        this.lastIntensity[m] = this.intensity;
      } else this.intensity = this.lastIntensity[m];
      if (changed & 8) this.cls = dec.decodeSymbol(lazy(this.classes, this.cls, 256));
      if (changed & 4) this.angle = (dec.decodeSymbol(this.angleModels[(this.bits >> 6) & 1]) + this.angle) & 255;
      if (changed & 2) this.user = dec.decodeSymbol(lazy(this.userData, this.user, 256));
      if (changed & 1) this.psid = this.icPsid.decompress(this.psid);
    }
    let diff = this.icX.decompress(this.medianX[m].get(), single);
    this.x = (this.x + diff) | 0;
    this.medianX[m].add(diff);
    let k = this.icX.k;
    diff = this.icY.decompress(this.medianY[m].get(), single + (k < 20 ? k & ~1 : 20));
    this.y = (this.y + diff) | 0;
    this.medianY[m].add(diff);
    k = (this.icX.k + this.icY.k) >>> 1;
    this.z = this.icZ.decompress(this.lastHeight[l], single + (k < 18 ? k & ~1 : 18));
    this.lastHeight[l] = this.z;
    view.setInt32(at, this.x, true);
    view.setInt32(at + 4, this.y, true);
    view.setInt32(at + 8, this.z, true);
    view.setUint16(at + 12, this.intensity, true);
    view.setUint8(at + 14, this.bits);
    view.setUint8(at + 15, this.cls);
    view.setUint8(at + 16, this.angle);
    view.setUint8(at + 17, this.user);
    view.setUint16(at + 18, this.psid, true);
  }
}

// GPS time coding: up to four interleaved time sequences, each predicted from its last integer difference (the
// double's bits read as a 64-bit integer) times a small multiplier; a jump outside 32 bits starts a new sequence.
const MULTI = 500,
  MULTI_MINUS = -10,
  // Symbol 511 is "unchanged" in GPSTIME11 (516 symbols) and does not exist in point14, where bit 4 of the changed
  // flags carries it (515 symbols, LAZ specification 1.4, note 6): there 511 starts a new sequence, 512 to 514 switch.
  MULTI_UNCHANGED = MULTI - MULTI_MINUS + 1;

class GpsTime {
  last = 0;
  private next = 0;
  readonly low = new Uint32Array(4);
  readonly high = new Uint32Array(4);
  private readonly diff = new Int32Array(4);
  private readonly extreme = new Int32Array(4);
  private readonly multi: SymbolModel;
  private readonly zero: SymbolModel;
  private readonly ic: IntegerDecompressor;
  /** Symbol of the multiplier model that starts a new sequence; the sequence switches follow it. */
  private readonly fullCode: number;
  /** `layered`: the point14 coding, where an unchanged time is flagged by the point and never coded here. */
  constructor(
    private readonly dec: RangeDecoder,
    private readonly layered: boolean,
  ) {
    this.fullCode = layered ? MULTI_UNCHANGED : MULTI_UNCHANGED + 1;
    this.multi = new SymbolModel(this.fullCode + 4);
    this.zero = new SymbolModel(layered ? 5 : 6);
    this.ic = new IntegerDecompressor(dec, 32, 9);
  }

  reset(low: number, high: number) {
    this.multi.reset();
    this.zero.reset();
    this.ic.reset();
    this.last = this.next = 0;
    this.diff.fill(0);
    this.extreme.fill(0);
    this.low.fill(0);
    this.high.fill(0);
    this.low[0] = low;
    this.high[0] = high;
  }

  private add(i: number, d: number) {
    const s = this.low[i] + d;
    this.low[i] = s;
    if (s >= 0x100000000) this.high[i]++;
    else if (s < 0) this.high[i]--;
  }

  private full() {
    const next = (this.next = (this.next + 1) & 3);
    const high = this.ic.decompress(this.high[this.last] | 0, 8);
    this.low[next] = this.dec.readInt();
    this.high[next] = high;
    this.last = next;
    this.diff[next] = 0;
    this.extreme[next] = 0;
  }

  private extremeDiff(d: number) {
    if (++this.extreme[this.last] > 3) {
      this.diff[this.last] = d;
      this.extreme[this.last] = 0;
    }
  }

  read() {
    const dec = this.dec,
      ic = this.ic;
    for (let switches = 0; ; switches++) {
      // The encoder switches sequence at most once per point; more is corrupt data, not a reason to loop.
      if (switches > 3)
        throw new RangeError(`LAZ ${dec.label} GPS time switches sequence repeatedly; the file is corrupt`);
      const last = this.last;
      if (this.diff[last] === 0) {
        const multi = dec.decodeSymbol(this.zero),
          small = this.layered ? 0 : 1;
        if (multi === small) {
          const d = ic.decompress(0, 0);
          this.diff[last] = d;
          this.add(last, d);
          this.extreme[last] = 0;
        } else if (multi === small + 1) this.full();
        else if (multi > small + 1) {
          this.last = (last + multi - small - 1) & 3;
          continue;
        }
        return;
      }
      let multi = dec.decodeSymbol(this.multi);
      if (multi === 1) {
        const d = ic.decompress(this.diff[last], 1);
        // Real files keep the previous difference after a multiplier 1 point: point14 (USGS 3DEP, LASzip 3.4.3) and
        // GPSTIME11 (PDAL autzen_trim.laz, every record equal to its LAS twin) alike.
        this.add(last, d);
        this.extreme[last] = 0;
      } else if (multi < MULTI_UNCHANGED) {
        let d: number;
        if (multi === 0) {
          d = ic.decompress(0, 7);
          this.extremeDiff(d);
        } else if (multi < MULTI) d = ic.decompress(Math.imul(multi, this.diff[last]), multi < 10 ? 2 : 3);
        else if (multi === MULTI) {
          d = ic.decompress(Math.imul(MULTI, this.diff[last]), 4);
          this.extremeDiff(d);
        } else {
          multi = MULTI - multi;
          if (multi > MULTI_MINUS) d = ic.decompress(Math.imul(multi, this.diff[last]), 5);
          else {
            d = ic.decompress(Math.imul(MULTI_MINUS, this.diff[last]), 6);
            this.extremeDiff(d);
          }
        }
        this.add(last, d);
      } else if (multi === this.fullCode) this.full();
      else if (multi > this.fullCode) {
        this.last = (last + multi - this.fullCode) & 3;
        continue;
      }
      return;
    }
  }
}

class Gps11Reader implements ItemReader {
  readonly size = 8;
  private readonly gps: GpsTime;
  constructor(dec: RangeDecoder) {
    this.gps = new GpsTime(dec, false);
  }
  init(view: DataView, at: number) {
    this.gps.reset(view.getUint32(at, true), view.getUint32(at + 4, true));
  }
  read(view: DataView, at: number) {
    const gps = this.gps;
    gps.read();
    view.setUint32(at, gps.low[gps.last], true);
    view.setUint32(at + 4, gps.high[gps.last], true);
  }
}

/** Models of the RGB coding: which of the six bytes changed, then each byte's difference from its prediction. */
class RgbModels {
  readonly used = new SymbolModel(128);
  readonly diff = Array.from({ length: 6 }, () => new SymbolModel(256));
  reset() {
    this.used.reset();
    for (const m of this.diff) m.reset();
  }
}

/** Decodes one RGB value into `last` (red predicts green and blue, per byte). */
function readRgb(dec: RangeDecoder, m: RgbModels, last: Uint16Array) {
  const sym = dec.decodeSymbol(m.used),
    l0 = last[0],
    l1 = last[1],
    l2 = last[2];
  let r = sym & 1 ? (dec.decodeSymbol(m.diff[0]) + (l0 & 255)) & 255 : l0 & 255;
  r |= sym & 2 ? ((dec.decodeSymbol(m.diff[1]) + (l0 >> 8)) & 255) << 8 : l0 & 0xff00;
  let g = r,
    b = r;
  if (sym & 64) {
    let d = (r & 255) - (l0 & 255);
    g = sym & 4 ? (dec.decodeSymbol(m.diff[2]) + clampByte(d + (l1 & 255))) & 255 : l1 & 255;
    if (sym & 16) {
      d = Math.trunc((d + (g & 255) - (l1 & 255)) / 2);
      b = (dec.decodeSymbol(m.diff[4]) + clampByte(d + (l2 & 255))) & 255;
    } else b = l2 & 255;
    d = (r >> 8) - (l0 >> 8);
    g |= sym & 8 ? ((dec.decodeSymbol(m.diff[3]) + clampByte(d + (l1 >> 8))) & 255) << 8 : l1 & 0xff00;
    if (sym & 32) {
      d = Math.trunc((d + (g >> 8) - (l1 >> 8)) / 2);
      b |= ((dec.decodeSymbol(m.diff[5]) + clampByte(d + (l2 >> 8))) & 255) << 8;
    } else b |= l2 & 0xff00;
  }
  last[0] = r;
  last[1] = g;
  last[2] = b;
}

const writeRgb = (view: DataView, at: number, rgb: Uint16Array) => {
  view.setUint16(at, rgb[0], true);
  view.setUint16(at + 2, rgb[1], true);
  view.setUint16(at + 4, rgb[2], true);
};

class Rgb12Reader implements ItemReader {
  readonly size = 6;
  private readonly last = new Uint16Array(3);
  private readonly models = new RgbModels();
  constructor(private readonly dec: RangeDecoder) {}
  init(view: DataView, at: number) {
    this.models.reset();
    for (let c = 0; c < 3; c++) this.last[c] = view.getUint16(at + c * 2, true);
  }
  read(view: DataView, at: number) {
    readRgb(this.dec, this.models, this.last);
    writeRgb(view, at, this.last);
  }
}

class ByteReader implements ItemReader {
  private readonly last: Uint8Array;
  private readonly models: SymbolModel[];
  constructor(
    private readonly dec: RangeDecoder,
    readonly size: number,
  ) {
    this.last = new Uint8Array(size);
    this.models = Array.from({ length: size }, () => new SymbolModel(256));
  }
  init(view: DataView, at: number) {
    resetAll(this.models);
    for (let i = 0; i < this.size; i++) this.last[i] = view.getUint8(at + i);
  }
  read(view: DataView, at: number) {
    for (let i = 0; i < this.size; i++) {
      this.last[i] = (this.last[i] + this.dec.decodeSymbol(this.models[i])) & 255;
      view.setUint8(at + i, this.last[i]);
    }
  }
}

// --- point14 family (point formats 6 to 10), version 3, layered: one stream per attribute per chunk --------------

/** The fields of a point14 record, as the predictors see them. */
class Point14 {
  x = 0;
  y = 0;
  z = 0;
  intensity = 0;
  ret = 0;
  returns = 0;
  classFlags = 0;
  channel = 0;
  scanDirection = 0;
  edge = 0;
  cls = 0;
  user = 0;
  angle = 0;
  psid = 0;
  gpsLow = 0;
  gpsHigh = 0;
  gpsChange = false;
  copy(p: Point14) {
    Object.assign(this, p);
  }
  readFrom(view: DataView, at: number) {
    this.x = view.getInt32(at, true);
    this.y = view.getInt32(at + 4, true);
    this.z = view.getInt32(at + 8, true);
    this.intensity = view.getUint16(at + 12, true);
    const b = view.getUint8(at + 14),
      f = view.getUint8(at + 15);
    this.ret = b & 15;
    this.returns = b >> 4;
    this.classFlags = f & 15;
    this.channel = (f >> 4) & 3;
    this.scanDirection = (f >> 6) & 1;
    this.edge = f >> 7;
    this.cls = view.getUint8(at + 16);
    this.user = view.getUint8(at + 17);
    this.angle = view.getInt16(at + 18, true);
    this.psid = view.getUint16(at + 20, true);
    this.gpsLow = view.getUint32(at + 22, true);
    this.gpsHigh = view.getUint32(at + 26, true);
    this.gpsChange = false;
  }
  writeTo(view: DataView, at: number) {
    view.setInt32(at, this.x, true);
    view.setInt32(at + 4, this.y, true);
    view.setInt32(at + 8, this.z, true);
    view.setUint16(at + 12, this.intensity, true);
    view.setUint8(at + 14, this.ret | (this.returns << 4));
    view.setUint8(at + 15, this.classFlags | (this.channel << 4) | (this.scanDirection << 6) | (this.edge << 7));
    view.setUint8(at + 16, this.cls);
    view.setUint8(at + 17, this.user);
    view.setInt16(at + 18, this.angle, true);
    view.setUint16(at + 20, this.psid, true);
    view.setUint32(at + 22, this.gpsLow, true);
    view.setUint32(at + 26, this.gpsHigh, true);
  }
}

/** The 9 point14 layers, in chunk order. */
const XY = 0,
  Z = 1,
  CLASS = 2,
  FLAGS = 3,
  INTENSITY = 4,
  ANGLE = 5,
  USER = 6,
  SOURCE = 7,
  GPS = 8;

/** Everything one scanner channel predicts from: its last point and its own models. */
class Point14Context {
  unused = true;
  readonly last = new Point14();
  readonly lastIntensity = new Uint16Array(8);
  readonly lastZ = new Int32Array(8);
  readonly medianX = median5s(12);
  readonly medianY = median5s(12);
  readonly changed = Array.from({ length: 8 }, () => new SymbolModel(128));
  readonly channel = new SymbolModel(3);
  readonly returns: (SymbolModel | undefined)[] = [];
  readonly ret: (SymbolModel | undefined)[] = [];
  readonly retGpsSame = new SymbolModel(13);
  readonly classes: (SymbolModel | undefined)[] = [];
  readonly flags: (SymbolModel | undefined)[] = [];
  readonly userData: (SymbolModel | undefined)[] = [];
  readonly icX: IntegerDecompressor;
  readonly icY: IntegerDecompressor;
  readonly icZ: IntegerDecompressor;
  readonly icIntensity: IntegerDecompressor;
  readonly icAngle: IntegerDecompressor;
  readonly icPsid: IntegerDecompressor;
  readonly gps: GpsTime;
  constructor(layers: readonly RangeDecoder[]) {
    this.icX = new IntegerDecompressor(layers[XY], 32, 2);
    this.icY = new IntegerDecompressor(layers[XY], 32, 22);
    this.icZ = new IntegerDecompressor(layers[Z], 32, 20);
    this.icIntensity = new IntegerDecompressor(layers[INTENSITY], 16, 4);
    this.icAngle = new IntegerDecompressor(layers[ANGLE], 16, 2);
    this.icPsid = new IntegerDecompressor(layers[SOURCE], 16);
    this.gps = new GpsTime(layers[GPS], true);
  }
  reset(from: Point14) {
    for (const m of this.changed) m.reset();
    this.channel.reset();
    this.retGpsSame.reset();
    resetAll(this.returns);
    resetAll(this.ret);
    resetAll(this.classes);
    resetAll(this.flags);
    resetAll(this.userData);
    for (const ic of [this.icX, this.icY, this.icZ, this.icIntensity, this.icAngle, this.icPsid]) ic.reset();
    for (const m of this.medianX) m.reset();
    for (const m of this.medianY) m.reset();
    this.lastZ.fill(from.z);
    this.lastIntensity.fill(from.intensity);
    this.gps.reset(from.gpsLow, from.gpsHigh);
    this.last.copy(from);
    this.last.gpsChange = false;
    this.unused = false;
  }
}

/** The scanner channel the point14 item last decoded, which the other layered items follow. */
interface Channel {
  current: number;
}

class Point14Reader implements LayeredReader {
  readonly size = 30;
  readonly layers = 9;
  private readonly dec = Array.from({ length: 9 }, () => new RangeDecoder());
  private readonly has = new Array<boolean>(9).fill(false);
  private readonly contexts: (Point14Context | undefined)[] = [];
  private readonly first = new Point14();
  constructor(private readonly channel: Channel) {}

  layer(i: number, bytes: Uint8Array, start: number, end: number, label: string) {
    this.has[i] = i === XY || end > start;
    if (this.has[i]) this.dec[i].init(bytes, start, end, label);
  }

  private context(c: number, from: Point14): Point14Context {
    const ctx = (this.contexts[c] ??= new Point14Context(this.dec));
    ctx.reset(from);
    return ctx;
  }

  init(view: DataView, at: number) {
    this.first.readFrom(view, at);
    for (const ctx of this.contexts) if (ctx) ctx.unused = true;
    this.channel.current = this.first.channel;
    this.context(this.first.channel, this.first);
  }

  read(view: DataView, at: number) {
    const dec = this.dec,
      has = this.has;
    let ctx = this.contexts[this.channel.current]!,
      last = ctx.last;
    // Context of the last point: first and/or last return, and whether its GPS time changed.
    const lpr = (last.ret === 1 ? 1 : 0) + (last.ret >= last.returns ? 2 : 0) + (last.gpsChange ? 4 : 0);
    const changed = dec[XY].decodeSymbol(ctx.changed[lpr]);
    if (changed & 64) {
      const channel = (this.channel.current + dec[XY].decodeSymbol(ctx.channel) + 1) & 3,
        next = this.contexts[channel];
      ctx = next && !next.unused ? next : this.context(channel, last);
      this.channel.current = channel;
      last = ctx.last;
      last.channel = channel;
    }
    const sourceChange = (changed & 32) !== 0,
      gpsChange = (changed & 16) !== 0,
      angleChange = (changed & 8) !== 0,
      gpsBit = gpsChange ? 1 : 0;
    const lastN = last.returns,
      lastR = last.ret;
    if (changed & 4) last.returns = dec[XY].decodeSymbol(lazy(ctx.returns, lastN, 16));
    const code = changed & 3;
    if (code === 1) last.ret = (lastR + 1) & 15;
    else if (code === 2) last.ret = (lastR + 15) & 15;
    else if (code === 3)
      last.ret = gpsChange
        ? dec[XY].decodeSymbol(lazy(ctx.ret, lastR, 16))
        : (lastR + dec[XY].decodeSymbol(ctx.retGpsSame) + 2) & 15;
    const n = last.returns,
      r = last.ret,
      m = MAP14[n * 16 + r],
      l = LEVEL14[n * 16 + r],
      single = n === 1 ? 1 : 0,
      cpr = (r === 1 ? 2 : 0) + (r >= n ? 1 : 0);
    const mx = ctx.medianX[(m << 1) | gpsBit],
      my = ctx.medianY[(m << 1) | gpsBit];
    let diff = ctx.icX.decompress(mx.get(), single);
    last.x = (last.x + diff) | 0;
    mx.add(diff);
    let k = ctx.icX.k;
    diff = ctx.icY.decompress(my.get(), single + (k < 20 ? k & ~1 : 20));
    last.y = (last.y + diff) | 0;
    my.add(diff);
    if (has[Z]) {
      k = (ctx.icX.k + ctx.icY.k) >>> 1;
      last.z = ctx.icZ.decompress(ctx.lastZ[l], single + (k < 18 ? k & ~1 : 18));
      ctx.lastZ[l] = last.z;
    }
    if (has[CLASS]) {
      const c = ((last.cls & 31) << 1) + (cpr === 3 ? 1 : 0);
      last.cls = dec[CLASS].decodeSymbol(lazy(ctx.classes, c, 256));
    }
    if (has[FLAGS]) {
      const f = (last.edge << 5) | (last.scanDirection << 4) | last.classFlags,
        flags = dec[FLAGS].decodeSymbol(lazy(ctx.flags, f, 64));
      last.edge = (flags >> 5) & 1;
      last.scanDirection = (flags >> 4) & 1;
      last.classFlags = flags & 15;
    }
    if (has[INTENSITY]) {
      const i = (cpr << 1) | gpsBit;
      last.intensity = ctx.icIntensity.decompress(ctx.lastIntensity[i], cpr);
      ctx.lastIntensity[i] = last.intensity;
    }
    if (has[ANGLE] && angleChange) last.angle = (ctx.icAngle.decompress(last.angle, gpsBit) << 16) >> 16;
    if (has[USER]) last.user = dec[USER].decodeSymbol(lazy(ctx.userData, last.user >> 2, 256));
    if (has[SOURCE] && sourceChange) last.psid = ctx.icPsid.decompress(last.psid);
    if (has[GPS] && gpsChange) {
      ctx.gps.read();
      last.gpsLow = ctx.gps.low[ctx.gps.last];
      last.gpsHigh = ctx.gps.high[ctx.gps.last];
    }
    last.writeTo(view, at);
    last.gpsChange = gpsChange;
  }
}

/** A layered item that follows the point14 scanner channel: per channel last value and models. */
abstract class ChannelReader<C extends { unused: boolean }> implements LayeredReader {
  abstract readonly size: number;
  abstract readonly layers: number;
  protected readonly dec: RangeDecoder[] = [];
  protected readonly has: boolean[] = [];
  protected readonly contexts: (C | undefined)[] = [];
  protected current = 0;
  constructor(protected readonly channel: Channel) {}
  protected abstract create(): C;
  /** Starts context `ctx` from a record's bytes (`view`) or from another context. */
  protected abstract start(ctx: C, from: DataView | C, at: number): void;
  protected abstract decode(ctx: C, view: DataView, at: number): void;

  layer(i: number, bytes: Uint8Array, start: number, end: number, label: string) {
    this.dec[i] ??= new RangeDecoder();
    this.has[i] = end > start;
    if (this.has[i]) this.dec[i].init(bytes, start, end, label);
  }
  private context(c: number, from: DataView | C, at: number): C {
    const ctx = (this.contexts[c] ??= this.create());
    this.start(ctx, from, at);
    ctx.unused = false;
    return ctx;
  }
  init(view: DataView, at: number) {
    for (const ctx of this.contexts) if (ctx) ctx.unused = true;
    this.current = this.channel.current;
    this.context(this.current, view, at);
  }
  read(view: DataView, at: number) {
    let ctx = this.contexts[this.current]!;
    if (this.current !== this.channel.current) {
      this.current = this.channel.current;
      const next = this.contexts[this.current];
      ctx = next && !next.unused ? next : this.context(this.current, ctx, 0);
    }
    this.decode(ctx, view, at);
  }
}

class RgbContext {
  unused = true;
  readonly last = new Uint16Array(4);
  readonly rgb = new RgbModels();
  readonly nirUsed = new SymbolModel(4);
  readonly nir = [new SymbolModel(256), new SymbolModel(256)];
}

class Rgb14Reader extends ChannelReader<RgbContext> {
  readonly layers: number;
  constructor(
    channel: Channel,
    readonly size: number,
  ) {
    super(channel);
    this.layers = size === 8 ? 2 : 1;
  }
  protected create() {
    return new RgbContext();
  }
  protected start(ctx: RgbContext, from: DataView | RgbContext, at: number) {
    ctx.rgb.reset();
    ctx.nirUsed.reset();
    for (const m of ctx.nir) m.reset();
    if (!(from instanceof DataView)) ctx.last.set(from.last);
    else for (let c = 0; c < this.size / 2; c++) ctx.last[c] = from.getUint16(at + c * 2, true);
  }
  protected decode(ctx: RgbContext, view: DataView, at: number) {
    if (this.has[0]) readRgb(this.dec[0], ctx.rgb, ctx.last);
    writeRgb(view, at, ctx.last);
    if (this.layers === 2) {
      if (this.has[1]) {
        const dec = this.dec[1],
          sym = dec.decodeSymbol(ctx.nirUsed),
          l = ctx.last[3];
        let v = sym & 1 ? (dec.decodeSymbol(ctx.nir[0]) + (l & 255)) & 255 : l & 255;
        v |= sym & 2 ? ((dec.decodeSymbol(ctx.nir[1]) + (l >> 8)) & 255) << 8 : l & 0xff00;
        ctx.last[3] = v;
      }
      view.setUint16(at + 6, ctx.last[3], true);
    }
  }
}

class BytesContext {
  unused = true;
  readonly last: Uint8Array;
  readonly models: SymbolModel[];
  constructor(size: number) {
    this.last = new Uint8Array(size);
    this.models = Array.from({ length: size }, () => new SymbolModel(256));
  }
}

class Byte14Reader extends ChannelReader<BytesContext> {
  readonly layers: number;
  constructor(
    channel: Channel,
    readonly size: number,
  ) {
    super(channel);
    this.layers = size;
  }
  protected create() {
    return new BytesContext(this.size);
  }
  protected start(ctx: BytesContext, from: DataView | BytesContext, at: number) {
    resetAll(ctx.models);
    if (from instanceof DataView) for (let i = 0; i < this.size; i++) ctx.last[i] = from.getUint8(at + i);
    else ctx.last.set(from.last);
  }
  protected decode(ctx: BytesContext, view: DataView, at: number) {
    for (let i = 0; i < this.size; i++) {
      if (this.has[i]) ctx.last[i] = (ctx.last[i] + this.dec[i].decodeSymbol(ctx.models[i])) & 255;
      view.setUint8(at + i, ctx.last[i]);
    }
  }
}

// --- chunks -------------------------------------------------------------------------------------------------------

interface Chunk {
  readonly start: number;
  readonly end: number;
  readonly count: number;
}

/** Reads the chunk table: the point count (variable chunks) and byte size of every chunk, as coded differences. */
function chunkTable(file: Uint8Array, header: LASHeader, info: LazInfo): Chunk[] {
  const view = new DataView(file.buffer, file.byteOffset, file.byteLength),
    first = header.pointDataOffset + 8;
  if (first > file.byteLength)
    throw new RangeError('LAZ point data is shorter than its 8-byte chunk table offset; the file is truncated');
  let table = Number(view.getBigInt64(header.pointDataOffset, true));
  // A writer that could not seek back stores -1 and puts the offset in the file's last 8 bytes.
  if (table === -1 && file.byteLength >= first + 8) table = Number(view.getBigInt64(file.byteLength - 8, true));
  if (!(table >= first && table + 8 <= file.byteLength))
    throw new RangeError(
      `LAZ chunk table offset ${table} lies outside the file; the file is truncated or corrupt (LAZ is read through its chunk table)`,
    );
  const version = view.getUint32(table, true),
    n = view.getUint32(table + 4, true),
    variable = info.chunkSize === 'variable';
  if (version !== 0) throw unsupported(`chunk table version ${version}`);
  const expected = variable ? undefined : Math.ceil(header.pointCount / (info.chunkSize as number));
  if (expected !== undefined ? n !== expected : n > header.pointCount)
    throw new RangeError(
      `LAZ chunk table lists ${n} chunks for ${header.pointCount} points${expected === undefined ? '' : ` (expected ${expected})`}; the file is corrupt`,
    );
  const chunks: Chunk[] = [];
  if (!n) return chunks;
  const dec = new RangeDecoder(),
    ic = new IntegerDecompressor(dec, 32, 2);
  dec.init(file, table + 8, file.byteLength, 'chunk table');
  let count = 0,
    bytes = 0,
    start = first,
    points = 0;
  for (let i = 0; i < n; i++) {
    if (variable) count = ic.decompress(count, 0);
    else count = Math.min(info.chunkSize as number, header.pointCount - points);
    bytes = ic.decompress(bytes, 1);
    if (count < 0 || bytes < 0 || start + bytes > table || points + count > header.pointCount)
      throw new RangeError(
        `LAZ chunk ${i} (${count} points, ${bytes} bytes at ${start}) does not fit the point data; the file is corrupt`,
      );
    chunks.push({ start, end: start + bytes, count });
    start += bytes;
    points += count;
  }
  if (points !== header.pointCount)
    throw new RangeError(
      `LAZ chunks hold ${points} points but the header says ${header.pointCount}; the file is corrupt`,
    );
  return chunks;
}

/** The readers of one file, made once and restarted for every chunk. */
function readersFor(info: LazInfo): { readers: ItemReader[]; dec: RangeDecoder; layered: boolean } {
  const dec = new RangeDecoder(),
    layered = info.compressor === 3,
    channel: Channel = { current: 0 };
  const readers = info.items.map((item): ItemReader => {
    switch (item.type) {
      case POINT10:
        return new Point10Reader(dec);
      case GPSTIME11:
        return new Gps11Reader(dec);
      case RGB12:
        return new Rgb12Reader(dec);
      case BYTE:
        return new ByteReader(dec, item.size);
      case POINT14:
        return new Point14Reader(channel);
      case RGB14:
      case RGBNIR14:
        return new Rgb14Reader(channel, item.size);
      default:
        return new Byte14Reader(channel, item.size);
    }
  });
  return { readers, dec, layered };
}

/** Decodes one chunk into `out` (`chunk.count` records). */
function decodeChunk(
  file: Uint8Array,
  chunk: Chunk,
  index: number,
  length: number,
  plan: ReturnType<typeof readersFor>,
  out: Uint8Array,
) {
  const { readers, dec, layered } = plan,
    label = `chunk ${index}`,
    view = new DataView(out.buffer, out.byteOffset, out.byteLength);
  if (!chunk.count) return;
  let at = chunk.start + length;
  if (at > chunk.end) throw new RangeError(`LAZ ${label} is shorter than its first point; the file is corrupt`);
  out.set(file.subarray(chunk.start, at));
  if (layered) {
    const source = new DataView(file.buffer, file.byteOffset, file.byteLength),
      layers = readers as LayeredReader[],
      total = layers.reduce((s, r) => s + r.layers, 0);
    if (at + 4 + total * 4 > chunk.end)
      throw new RangeError(`LAZ ${label} is shorter than its layer table; the file is corrupt`);
    const count = source.getUint32(at, true);
    if (count !== chunk.count)
      throw new RangeError(`LAZ ${label} holds ${count} points but its table says ${chunk.count}; the file is corrupt`);
    let size = at + 4,
      data = size + total * 4,
      layer = 0;
    for (const reader of layers)
      for (let i = 0; i < reader.layers; i++, size += 4, layer++) {
        const bytes = source.getUint32(size, true);
        if (data + bytes > chunk.end)
          throw new RangeError(`LAZ ${label} layer sizes run past the chunk; the file is corrupt`);
        reader.layer(i, file, data, data + bytes, `${label} layer ${layer}`);
        data += bytes;
      }
  } else dec.init(file, at, chunk.end, label);
  at = 0;
  for (const reader of readers) {
    reader.init(view, at);
    at += reader.size;
  }
  for (let p = 1; p < chunk.count; p++) {
    let o = p * length;
    for (const reader of readers) {
      reader.read(view, o);
      o += reader.size;
    }
  }
}

const now = () => globalThis.performance?.now() ?? Date.now();

/**
 * Decodes a LAZ file one chunk at a time: yields the uncompressed point records of each chunk, in file order. Stops
 * with `signal` between chunks (and gives the event loop a turn about every 30 ms). Throws a MargoError with code
 * `unsupported` for items this decoder does not read, a RangeError or TypeError for corrupt or truncated data.
 */
export async function* lazChunks(
  file: Uint8Array,
  header: LASHeader,
  records: readonly LASRecord[],
  options: LazChunkOptions = {},
): AsyncGenerator<Uint8Array, void, undefined> {
  const signal = options.signal;
  signal?.throwIfAborted();
  if (!header.compressed)
    throw new TypeError('LAS file is not compressed (no LAZ bit in the point format); use parseLAS');
  const info = lazInfo(records);
  checkItems(info, header);
  // The chunk table sits after the points, so a file cut short loses it and cannot be read, even with `partial`.
  const chunks = chunkTable(file, header, info);
  const plan = readersFor(info),
    length = header.pointRecordLength;
  let turn = now();
  for (let i = 0; i < chunks.length; i++) {
    signal?.throwIfAborted();
    if (now() - turn > 30) {
      await new Promise((resolve) => setTimeout(resolve, 0));
      signal?.throwIfAborted();
      turn = now();
    }
    const out = new Uint8Array(chunks[i].count * length);
    decodeChunk(file, chunks[i], i, length, plan, out);
    yield out;
  }
}

/**
 * Decodes one chunk held by itself (a COPC node's bytes): `count` uncompressed point records, for a file with `header`
 * and `records`. Throws as `lazChunks`.
 */
export function decodeLazChunk(
  chunk: Uint8Array,
  count: number,
  header: LASHeader,
  records: readonly LASRecord[],
): Uint8Array {
  const info = lazInfo(records);
  checkItems(info, header);
  const out = new Uint8Array(count * header.pointRecordLength);
  decodeChunk(chunk, { start: 0, end: chunk.byteLength, count }, 0, header.pointRecordLength, readersFor(info), out);
  return out;
}

/**
 * A LAZ decoder for `parseLAS` / `loadLAS`: `parseLAS(bytes, { laz: createLazDecoder() })`. Point formats 0 to 3
 * (POINT10, GPSTIME11, RGB12 and extra bytes, version 2) and 6 to 8 (POINT14, RGB14, RGBNIR14 and extra bytes,
 * layered version 3), fixed or variable chunks. Decodes one chunk at a time into the point arrays.
 */
export function createLazDecoder(): LazDecoder {
  return (file, header, records, signal) => lazChunks(file, header, records, { signal });
}
