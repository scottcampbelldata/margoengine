// The LAZ coders both writers share (laz-write.ts and copc-write.ts), the mirror of the decoder in laz.ts, written clean
// room from the same public descriptions: M. Isenburg, "LASzip: lossless compression of LiDAR data", Photogrammetric
// Engineering and Remote Sensing 79(2), 2013, https://doi.org/10.14358/PERS.79.2.209; the public LAZ format
// specification (https://github.com/ASPRSorg/LAS, "LAZ Specification 1.4"); ASPRS, LAS Specification 1.4 R15; and the
// range coding literature (I. H. Witten, R. M. Neal and J. G. Cleary, CACM 30(6), 1987; A. Said, HP Labs HPL-2004-76,
// 2004). No source code of LASzip, laz-perf, PDAL, lazrs or any other writer was read.
//
// Point formats 0 to 5 are written pointwise in chunks (compressor 2, item version 2, wave packets version 1), formats
// 6 to 10 in layered chunks (compressor 3, version 3). The first point of a chunk is stored raw; every layer whose value
// never changes in a chunk is left empty.
import { LAS_RECORD_SIZES } from './las.js';
import {
  BIT_SHIFT,
  BitModel,
  LEVEL10,
  LEVEL14,
  MAP10,
  MAP14,
  type Median5,
  MIN_LENGTH,
  SYMBOL_SHIFT,
  SymbolModel,
  clampByte,
  median5s,
} from './laz-model.js';

const model = (symbols: number) => new SymbolModel(symbols, false);
const models = (count: number, symbols: number) => Array.from({ length: count }, () => model(symbols));
const at = (list: (SymbolModel | undefined)[], i: number, symbols: number) => (list[i] ??= model(symbols));

/** A 32-bit range encoder: a byte out per renormalisation, carries run back into the bytes already written. */
class RangeEncoder {
  private out = new Uint8Array(1024);
  private n = 0;
  private base = 0;
  private length = 0xffffffff;

  private add(x: number) {
    let base = this.base + x;
    if (base >= 0x100000000) {
      base -= 0x100000000;
      const out = this.out;
      let p = this.n - 1;
      while (out[p] === 0xff) out[p--] = 0;
      out[p]++;
    }
    this.base = base;
  }
  private put(byte: number) {
    if (this.n === this.out.length) {
      const grown = new Uint8Array(this.n * 2);
      grown.set(this.out);
      this.out = grown;
    }
    this.out[this.n++] = byte;
  }
  private renorm() {
    while (this.length < MIN_LENGTH) {
      this.put(this.base >>> 24);
      this.base = (this.base << 8) >>> 0;
      this.length = (this.length << 8) >>> 0;
    }
  }
  bit(m: BitModel, bit: number) {
    const x = m.prob * (this.length >>> BIT_SHIFT);
    if (bit) {
      this.add(x);
      this.length -= x;
    } else {
      this.length = x;
      m.zeros++;
    }
    if (this.length < MIN_LENGTH) this.renorm();
    if (--m.until === 0) m.update();
  }
  symbol(m: SymbolModel, symbol: number) {
    const unit = this.length >>> SYMBOL_SHIFT,
      x = m.dist[symbol] * unit;
    this.add(x);
    this.length = symbol === m.last ? this.length - x : m.dist[symbol + 1] * unit - x;
    if (this.length < MIN_LENGTH) this.renorm();
    m.counts[symbol]++;
    if (--m.until === 0) m.update();
  }
  /** `value` in `count` raw bits, 1 to 32: more than 19 go as 16 low bits and then the rest. */
  bits(count: number, value: number) {
    if (count > 19) {
      this.bits(16, value & 0xffff);
      this.bits(count - 16, value >>> 16);
      return;
    }
    const unit = this.length >>> count;
    this.add(value * unit);
    this.length = unit;
    this.renorm();
  }
  int(value: number) {
    this.bits(32, value >>> 0);
  }
  /** Ends the stream: a value inside the final interval, then zeros so a decoder's 4-byte look-ahead is covered. */
  done(): Uint8Array {
    let pad = 3;
    if (this.length > 2 * MIN_LENGTH) {
      this.add(MIN_LENGTH);
      this.length = MIN_LENGTH >>> 1;
    } else {
      this.add(MIN_LENGTH >>> 1);
      this.length = MIN_LENGTH >>> 9;
      pad = 2;
    }
    this.renorm();
    for (let i = 0; i < pad; i++) this.put(0);
    return this.out.subarray(0, this.n);
  }
}

/** Codes an integer against its prediction: the corrector's bit count k per context, then its value among k bits. */
class IntegerCompressor {
  private readonly kModels: SymbolModel[];
  private readonly zero = new BitModel();
  private readonly correctors: (SymbolModel | undefined)[] = [];
  private readonly range: number;
  /** The bit count of the last corrector, which later items take their context from. */
  k = 0;
  constructor(
    private readonly encoder: RangeEncoder,
    bits: number,
    contexts = 1,
  ) {
    this.range = bits < 32 ? 2 ** bits : 0;
    this.kModels = models(contexts, bits + 1);
  }
  compress(predicted: number, real: number, context = 0) {
    let c = real - predicted;
    const range = this.range;
    if (range) {
      if (c < -range / 2) c += range;
      else if (c > range / 2 - 1) c -= range;
    } else c |= 0;
    // k bits hold -(2^k - 1) to -2^(k-1) and 2^(k-1) + 1 to 2^k.
    const magnitude = c <= 0 ? -c : c - 1,
      k = magnitude === 0 ? 0 : 32 - Math.clz32(magnitude),
      encoder = this.encoder;
    this.k = k;
    encoder.symbol(this.kModels[context], k);
    if (k === 0) encoder.bit(this.zero, c);
    else if (k < 32) {
      const value = c < 0 ? c + 2 ** k - 1 : c - 1,
        corrector = at(this.correctors, k, 1 << Math.min(k, 8));
      if (k <= 8) encoder.symbol(corrector, value);
      else {
        // The top 8 bits are modelled, the rest are raw.
        const low = k - 8;
        encoder.symbol(corrector, value >>> low);
        encoder.bits(low, value & ((1 << low) - 1));
      }
    }
  }
}

/** A part of each point record, coded into the chunk's one stream. */
interface ItemWriter {
  readonly size: number;
  /** Takes a chunk's first point, stored raw, as the values to predict from. */
  init(view: DataView, from: number): void;
  write(view: DataView, from: number): void;
}

// --- point10 family (point formats 0 to 5) -------------------------------------------------------------------------

class Point10Writer implements ItemWriter {
  readonly size = 20;
  private x = 0;
  private y = 0;
  private bits = 0;
  private classification = 0;
  private angle = 0;
  private user = 0;
  private source = 0;
  private readonly lastIntensity = new Uint16Array(16);
  private readonly lastHeight = new Int32Array(8);
  private readonly medianX = median5s(16);
  private readonly medianY = median5s(16);
  private readonly changed = model(64);
  private readonly angles = models(2, 256);
  private readonly bitBytes: (SymbolModel | undefined)[] = [];
  private readonly classes: (SymbolModel | undefined)[] = [];
  private readonly users: (SymbolModel | undefined)[] = [];
  private readonly intensities: IntegerCompressor;
  private readonly sources: IntegerCompressor;
  private readonly dx: IntegerCompressor;
  private readonly dy: IntegerCompressor;
  private readonly z: IntegerCompressor;
  constructor(private readonly encoder: RangeEncoder) {
    this.intensities = new IntegerCompressor(encoder, 16, 4);
    this.sources = new IntegerCompressor(encoder, 16);
    this.dx = new IntegerCompressor(encoder, 32, 2);
    this.dy = new IntegerCompressor(encoder, 32, 22);
    this.z = new IntegerCompressor(encoder, 32, 20);
  }
  init(view: DataView, from: number) {
    this.x = view.getInt32(from, true);
    this.y = view.getInt32(from + 4, true);
    this.bits = view.getUint8(from + 14);
    this.classification = view.getUint8(from + 15);
    this.angle = view.getUint8(from + 16);
    this.user = view.getUint8(from + 17);
    this.source = view.getUint16(from + 18, true);
  }
  write(view: DataView, from: number) {
    const encoder = this.encoder,
      x = view.getInt32(from, true),
      y = view.getInt32(from + 4, true),
      z = view.getInt32(from + 8, true),
      intensity = view.getUint16(from + 12, true),
      bits = view.getUint8(from + 14),
      classification = view.getUint8(from + 15),
      angle = view.getUint8(from + 16),
      user = view.getUint8(from + 17),
      source = view.getUint16(from + 18, true),
      returns = (bits >> 3) & 7,
      index = (returns << 3) | (bits & 7),
      m = MAP10[index],
      level = LEVEL10[index],
      single = returns === 1 ? 1 : 0;
    const changed =
      (bits !== this.bits ? 32 : 0) |
      (intensity !== this.lastIntensity[m] ? 16 : 0) |
      (classification !== this.classification ? 8 : 0) |
      (angle !== this.angle ? 4 : 0) |
      (user !== this.user ? 2 : 0) |
      (source !== this.source ? 1 : 0);
    encoder.symbol(this.changed, changed);
    if (changed & 32) encoder.symbol(at(this.bitBytes, this.bits, 256), bits);
    if (changed & 16) {
      this.intensities.compress(this.lastIntensity[m], intensity, Math.min(m, 3));
      this.lastIntensity[m] = intensity;
    }
    if (changed & 8) encoder.symbol(at(this.classes, this.classification, 256), classification);
    if (changed & 4) encoder.symbol(this.angles[(bits >> 6) & 1], (angle - this.angle) & 255);
    if (changed & 2) encoder.symbol(at(this.users, this.user, 256), user);
    if (changed & 1) this.sources.compress(this.source, source);
    const stepX = (x - this.x) | 0,
      stepY = (y - this.y) | 0;
    this.dx.compress(this.medianX[m].get(), stepX, single);
    this.medianX[m].add(stepX);
    let k = this.dx.k;
    this.dy.compress(this.medianY[m].get(), stepY, single + (k < 20 ? k & ~1 : 20));
    this.medianY[m].add(stepY);
    k = (this.dx.k + this.dy.k) >> 1;
    this.z.compress(this.lastHeight[level], z, single + (k < 18 ? k & ~1 : 18));
    this.lastHeight[level] = z;
    this.x = x;
    this.y = y;
    this.bits = bits;
    this.classification = classification;
    this.angle = angle;
    this.user = user;
    this.source = source;
  }
}

/** A 64-bit value as its signed high and unsigned low words. */
interface Words {
  hi: number;
  lo: number;
}
/** `a - b` modulo 2^64, as a signed 64-bit value in words. */
function subtract(aHi: number, aLo: number, bHi: number, bLo: number, out: Words): Words {
  const lo = aLo - bLo;
  out.lo = lo >>> 0;
  out.hi = (aHi - bHi - (lo < 0 ? 1 : 0)) | 0;
  return out;
}
const fits = ({ hi, lo }: Words) => (hi === 0 && lo < 0x80000000) || (hi === -1 && lo >= 0x80000000);

const MULTI = 500,
  MINUS = -10,
  /** Point10: the time is unchanged. Point14 has no such symbol, so its full times start here. */
  UNCHANGED = 511,
  FULL = 512;
/** Rounds a float32 quotient to the nearest integer, halves away from zero, in float32. */
const quantize = (f: number) => Math.trunc(Math.fround(f >= 0 ? f + 0.5 : f - 0.5));

/** GPS time sequences; `layered` is the point14 form, without the "unchanged" codes. Times are the raw 64-bit values. */
class GpsEncoder {
  private readonly fullCode: number;
  private readonly multi: SymbolModel;
  private readonly zero: SymbolModel;
  private readonly integers: IntegerCompressor;
  private readonly hi = new Int32Array(4);
  private readonly lo = new Uint32Array(4);
  private readonly diff = new Int32Array(4);
  private readonly extreme = new Int32Array(4);
  private last = 0;
  private next = 0;
  private readonly delta: Words = { hi: 0, lo: 0 };
  private readonly probe: Words = { hi: 0, lo: 0 };
  constructor(
    private readonly encoder: RangeEncoder,
    private readonly layered: boolean,
    hi: number,
    lo: number,
  ) {
    this.fullCode = layered ? UNCHANGED : FULL;
    this.multi = model(this.fullCode + 4);
    this.zero = model(layered ? 5 : 6);
    this.integers = new IntegerCompressor(encoder, 32, 9);
    this.hi[0] = hi;
    this.lo[0] = lo;
  }
  private full(hi: number, lo: number) {
    this.next = (this.next + 1) & 3;
    this.integers.compress(this.hi[this.last], hi, 8);
    this.encoder.int(lo);
    this.last = this.next;
    this.diff[this.last] = 0;
    this.extreme[this.last] = 0;
    this.hi[this.last] = hi;
    this.lo[this.last] = lo;
  }
  /** Another of the four sequences whose last time is within 32 bits of this one, counted from the current. */
  private other(hi: number, lo: number): number {
    for (let i = 1; i < 4; i++) {
      const s = (this.last + i) & 3;
      if (fits(subtract(hi, lo, this.hi[s], this.lo[s], this.probe))) return i;
    }
    return 0;
  }
  private bump(d: number) {
    if (++this.extreme[this.last] > 3) {
      this.diff[this.last] = d;
      this.extreme[this.last] = 0;
    }
  }
  write(hi: number, lo: number) {
    const { encoder, integers, layered } = this,
      small = layered ? 0 : 1;
    // Runs again only after switching to the sequence the time belongs to.
    for (;;) {
      const last = this.last,
        delta = subtract(hi, lo, this.hi[last], this.lo[last], this.delta),
        same = delta.hi === 0 && delta.lo === 0,
        prev = this.diff[last],
        near = fits(delta),
        d = delta.lo | 0;
      if (prev === 0) {
        if (!layered && same) return encoder.symbol(this.zero, 0);
        if (near) {
          encoder.symbol(this.zero, small);
          integers.compress(0, d, 0);
          this.diff[last] = d;
          this.extreme[last] = 0;
          break;
        }
        const i = this.other(hi, lo);
        if (i) {
          encoder.symbol(this.zero, small + 1 + i);
          this.last = (last + i) & 3;
          continue;
        }
        encoder.symbol(this.zero, small + 1);
        return this.full(hi, lo);
      }
      if (!layered && same) return encoder.symbol(this.multi, UNCHANGED);
      if (!near) {
        const i = this.other(hi, lo);
        if (i) {
          encoder.symbol(this.multi, this.fullCode + i);
          this.last = (last + i) & 3;
          continue;
        }
        encoder.symbol(this.multi, this.fullCode);
        return this.full(hi, lo);
      }
      const multi = quantize(Math.fround(Math.fround(d) / Math.fround(prev)));
      if (multi === 1) {
        encoder.symbol(this.multi, 1);
        integers.compress(prev, d, 1);
        this.extreme[last] = 0;
      } else if (multi > 1 && multi < MULTI) {
        encoder.symbol(this.multi, multi);
        integers.compress(Math.imul(multi, prev), d, multi < 10 ? 2 : 3);
      } else if (multi >= MULTI) {
        encoder.symbol(this.multi, MULTI);
        integers.compress(Math.imul(MULTI, prev), d, 4);
        this.bump(d);
      } else if (multi < 0 && multi > MINUS) {
        encoder.symbol(this.multi, MULTI - multi);
        integers.compress(Math.imul(multi, prev), d, 5);
      } else if (multi < 0) {
        encoder.symbol(this.multi, MULTI - MINUS);
        integers.compress(Math.imul(MINUS, prev), d, 6);
        this.bump(d);
      } else {
        encoder.symbol(this.multi, 0);
        integers.compress(0, d, 7);
        this.bump(d);
      }
      break;
    }
    this.hi[this.last] = hi;
    this.lo[this.last] = lo;
  }
}

class Gps11Writer implements ItemWriter {
  readonly size = 8;
  private gps!: GpsEncoder;
  constructor(private readonly encoder: RangeEncoder) {}
  init(view: DataView, from: number) {
    this.gps = new GpsEncoder(this.encoder, false, view.getInt32(from + 4, true), view.getUint32(from, true));
  }
  write(view: DataView, from: number) {
    this.gps.write(view.getInt32(from + 4, true), view.getUint32(from, true));
  }
}

/** The models of one RGB stream and the colour it last coded. */
class Rgb {
  private readonly used = model(128);
  private readonly diff = models(6, 256);
  readonly last = new Uint16Array(3);
  read(view: DataView, from: number) {
    for (let c = 0; c < 3; c++) this.last[c] = view.getUint16(from + c * 2, true);
  }
  /** Codes the colour at `from` against `last`, which takes it; returns whether any channel changed. */
  write(encoder: RangeEncoder, view: DataView, from: number, last = this.last): boolean {
    const l0 = last[0],
      l1 = last[1],
      l2 = last[2],
      r = view.getUint16(from, true),
      g = view.getUint16(from + 2, true),
      b = view.getUint16(from + 4, true),
      diff = this.diff;
    const symbol =
      ((l0 & 255) !== (r & 255) ? 1 : 0) |
      (l0 >> 8 !== r >> 8 ? 2 : 0) |
      ((l1 & 255) !== (g & 255) ? 4 : 0) |
      (l1 >> 8 !== g >> 8 ? 8 : 0) |
      ((l2 & 255) !== (b & 255) ? 16 : 0) |
      (l2 >> 8 !== b >> 8 ? 32 : 0) |
      (r !== g || r !== b ? 64 : 0);
    encoder.symbol(this.used, symbol);
    if (symbol & 1) encoder.symbol(diff[0], ((r & 255) - (l0 & 255)) & 255);
    if (symbol & 2) encoder.symbol(diff[1], ((r >> 8) - (l0 >> 8)) & 255);
    if (symbol & 64) {
      // Green and blue are predicted by red's change; a grey leaves them equal to red.
      let d = (r & 255) - (l0 & 255);
      if (symbol & 4) encoder.symbol(diff[2], ((g & 255) - clampByte(d + (l1 & 255))) & 255);
      if (symbol & 16) {
        d = Math.trunc((d + (g & 255) - (l1 & 255)) / 2);
        encoder.symbol(diff[4], ((b & 255) - clampByte(d + (l2 & 255))) & 255);
      }
      d = (r >> 8) - (l0 >> 8);
      if (symbol & 8) encoder.symbol(diff[3], ((g >> 8) - clampByte(d + (l1 >> 8))) & 255);
      if (symbol & 32) {
        d = Math.trunc((d + (g >> 8) - (l1 >> 8)) / 2);
        encoder.symbol(diff[5], ((b >> 8) - clampByte(d + (l2 >> 8))) & 255);
      }
    }
    last[0] = r;
    last[1] = g;
    last[2] = b;
    return l0 !== r || l1 !== g || l2 !== b;
  }
}

class Rgb12Writer implements ItemWriter {
  readonly size = 6;
  private readonly rgb = new Rgb();
  constructor(private readonly encoder: RangeEncoder) {}
  init(view: DataView, from: number) {
    this.rgb.read(view, from);
  }
  write(view: DataView, from: number) {
    this.rgb.write(this.encoder, view, from);
  }
}

class ByteWriter implements ItemWriter {
  private readonly last: Uint8Array;
  private readonly models: SymbolModel[];
  constructor(
    private readonly encoder: RangeEncoder,
    readonly size: number,
  ) {
    this.last = new Uint8Array(size);
    this.models = models(size, 256);
  }
  init(view: DataView, from: number) {
    for (let i = 0; i < this.size; i++) this.last[i] = view.getUint8(from + i);
  }
  write(view: DataView, from: number) {
    for (let i = 0; i < this.size; i++) {
      const v = view.getUint8(from + i);
      this.encoder.symbol(this.models[i], (v - this.last[i]) & 255);
      this.last[i] = v;
    }
  }
}

// --- wave packets (formats 4, 5, 9 and 10) -------------------------------------------------------------------------

/** A wave packet record: its offset in words, its floats as the integers their bytes spell. */
class Wave {
  index = 0;
  hi = 0;
  lo = 0;
  packetSize = 0;
  location = 0;
  readonly direction = new Int32Array(3);
  copy(w: Wave) {
    this.index = w.index;
    this.hi = w.hi;
    this.lo = w.lo;
    this.packetSize = w.packetSize;
    this.location = w.location;
    this.direction.set(w.direction);
  }
  read(view: DataView, from: number) {
    this.index = view.getUint8(from);
    this.lo = view.getUint32(from + 1, true);
    this.hi = view.getInt32(from + 5, true);
    this.packetSize = view.getInt32(from + 9, true);
    this.location = view.getInt32(from + 13, true);
    for (let c = 0; c < 3; c++) this.direction[c] = view.getInt32(from + 17 + c * 4, true);
  }
}

/** Models of wave packets, with how the last one stored its offset. */
class WaveModels {
  private readonly index = model(256);
  private readonly types = models(4, 4);
  private readonly offsets: IntegerCompressor;
  private readonly sizes: IntegerCompressor;
  private readonly locations: IntegerCompressor;
  private readonly directions: IntegerCompressor;
  private type = 0;
  private step = 0;
  private readonly next = new Wave();
  private readonly delta: Words = { hi: 0, lo: 0 };
  constructor(private readonly encoder: RangeEncoder) {
    this.offsets = new IntegerCompressor(encoder, 32);
    this.sizes = new IntegerCompressor(encoder, 32);
    this.locations = new IntegerCompressor(encoder, 32);
    this.directions = new IntegerCompressor(encoder, 32, 3);
  }
  /** Codes the packet at `from` against `last`, which takes it; returns whether any field changed. */
  write(view: DataView, from: number, last: Wave): boolean {
    const w = this.next,
      encoder = this.encoder;
    w.read(view, from);
    encoder.symbol(this.index, w.index);
    const delta = subtract(w.hi, w.lo, last.hi, last.lo, this.delta),
      same = delta.hi === 0 && delta.lo === 0,
      // The packet that follows the last one's bytes.
      end = last.lo + (last.packetSize >>> 0),
      follows = w.lo === end >>> 0 && w.hi === ((last.hi + (end >= 0x100000000 ? 1 : 0)) | 0),
      type = same ? 0 : follows ? 1 : fits(delta) ? 2 : 3;
    encoder.symbol(this.types[this.type], type);
    this.type = type;
    if (type === 2) {
      this.offsets.compress(this.step, delta.lo | 0);
      this.step = delta.lo | 0;
    } else if (type === 3) {
      encoder.int(w.lo);
      encoder.int(w.hi);
    }
    this.sizes.compress(last.packetSize, w.packetSize);
    this.locations.compress(last.location, w.location);
    let turned = false;
    for (let c = 0; c < 3; c++) {
      this.directions.compress(last.direction[c], w.direction[c], c);
      if (w.direction[c] !== last.direction[c]) turned = true;
    }
    const changed =
      turned || !same || w.index !== last.index || w.packetSize !== last.packetSize || w.location !== last.location;
    last.copy(w);
    return changed;
  }
}

class Wave13Writer implements ItemWriter {
  readonly size = 29;
  private readonly models: WaveModels;
  private readonly last = new Wave();
  constructor(encoder: RangeEncoder) {
    this.models = new WaveModels(encoder);
  }
  init(view: DataView, from: number) {
    this.last.read(view, from);
  }
  write(view: DataView, from: number) {
    this.models.write(view, from, this.last);
  }
}

// --- layered point14 family (formats 6 to 10) ----------------------------------------------------------------------

/** One layer of a chunk: its own stream, and whether the value it codes ever changed. */
class Layer {
  readonly encoder = new RangeEncoder();
  changed = false;
}
const NOTHING = new Uint8Array(0);
const finished = (layer: Layer) => (layer.changed ? layer.encoder.done() : NOTHING);

/** A layered item, which also hands over its layers at the chunk's end. */
interface LayeredWriter extends ItemWriter {
  layers(): Uint8Array[];
}

/**
 * The scanner channel the point14 item is on (`current`), and the one it hands the items after it (`item`): the new
 * channel on a point that switches and 0 on any other, as the decoder follows it and LASzip's files show.
 */
interface Channel {
  current: number;
  item: number;
}

class Point14 {
  x = 0;
  y = 0;
  z = 0;
  intensity = 0;
  returnNumber = 0;
  returns = 0;
  /** Classification flags, scan direction and edge of flight line, without the scanner channel. */
  flags = 0;
  channel = 0;
  classification = 0;
  user = 0;
  angle = 0;
  source = 0;
  hi = 0;
  lo = 0;
  /** Whether this point's time differed from the one before it in its context. */
  timeChanged = false;
  read(view: DataView, from: number) {
    const returns = view.getUint8(from + 14),
      flags = view.getUint8(from + 15);
    this.x = view.getInt32(from, true);
    this.y = view.getInt32(from + 4, true);
    this.z = view.getInt32(from + 8, true);
    this.intensity = view.getUint16(from + 12, true);
    this.returnNumber = returns & 15;
    this.returns = returns >> 4;
    // Edge and scan direction sit above the four classification flags.
    this.flags = ((flags >> 2) & 0x30) | (flags & 15);
    this.channel = (flags >> 4) & 3;
    this.classification = view.getUint8(from + 16);
    this.user = view.getUint8(from + 17);
    this.angle = view.getInt16(from + 18, true);
    this.source = view.getUint16(from + 20, true);
    this.lo = view.getUint32(from + 22, true);
    this.hi = view.getInt32(from + 26, true);
  }
  copy(p: Point14) {
    this.x = p.x;
    this.y = p.y;
    this.z = p.z;
    this.intensity = p.intensity;
    this.returnNumber = p.returnNumber;
    this.returns = p.returns;
    this.flags = p.flags;
    this.channel = p.channel;
    this.classification = p.classification;
    this.user = p.user;
    this.angle = p.angle;
    this.source = p.source;
    this.lo = p.lo;
    this.hi = p.hi;
  }
}

/** The state of one scanner channel. */
class Point14Context {
  readonly last = new Point14();
  readonly lastIntensity: Uint16Array;
  readonly lastZ: Int32Array;
  readonly medianX: Median5[] = median5s(12);
  readonly medianY: Median5[] = median5s(12);
  readonly changed = models(8, 128);
  readonly channel = model(3);
  readonly returns: (SymbolModel | undefined)[] = [];
  readonly returnNumbers: (SymbolModel | undefined)[] = [];
  readonly returnStep = model(13);
  readonly classes: (SymbolModel | undefined)[] = [];
  readonly flags: (SymbolModel | undefined)[] = [];
  readonly users: (SymbolModel | undefined)[] = [];
  readonly dx: IntegerCompressor;
  readonly dy: IntegerCompressor;
  readonly z: IntegerCompressor;
  readonly intensities: IntegerCompressor;
  readonly angles: IntegerCompressor;
  readonly sources: IntegerCompressor;
  readonly gps: GpsEncoder;
  constructor(layers: Layer[], from: Point14) {
    const [xy, z, , , intensity, angle, , source, gps] = layers;
    this.last.copy(from);
    this.lastIntensity = new Uint16Array(8).fill(from.intensity);
    this.lastZ = new Int32Array(8).fill(from.z);
    this.dx = new IntegerCompressor(xy.encoder, 32, 2);
    this.dy = new IntegerCompressor(xy.encoder, 32, 22);
    this.z = new IntegerCompressor(z.encoder, 32, 20);
    this.intensities = new IntegerCompressor(intensity.encoder, 16, 4);
    this.angles = new IntegerCompressor(angle.encoder, 16, 2);
    this.sources = new IntegerCompressor(source.encoder, 16);
    this.gps = new GpsEncoder(gps.encoder, true, from.hi, from.lo);
  }
}

class Point14Writer implements LayeredWriter {
  readonly size = 30;
  /** XY and returns, Z, classification, flags, intensity, scan angle, user data, point source, GPS time. */
  private readonly streams = Array.from({ length: 9 }, () => new Layer());
  private readonly contexts: (Point14Context | undefined)[] = [];
  private readonly point = new Point14();
  constructor(private readonly channel: Channel) {}
  init(view: DataView, from: number) {
    const p = this.point;
    p.read(view, from);
    this.channel.current = this.channel.item = p.channel;
    this.contexts[p.channel] = new Point14Context(this.streams, p);
    // The first layer is always written: a reader needs it for every point.
    this.streams[0].changed = true;
  }
  write(view: DataView, from: number) {
    const streams = this.streams,
      xy = streams[0].encoder,
      p = this.point,
      current = this.channel.current;
    p.read(view, from);
    let context = this.contexts[current]!,
      last = context.last;
    const history =
        (last.returnNumber === 1 ? 1 : 0) + (last.returnNumber >= last.returns ? 2 : 0) + (last.timeChanged ? 4 : 0),
      switched = p.channel !== current,
      target = switched ? this.contexts[p.channel] : context,
      // What changed is told against the point last seen on the channel switched to, when it has been seen.
      t = target ? target.last : last,
      step = (p.returnNumber - t.returnNumber) & 15,
      code = step === 0 ? 0 : step === 1 ? 1 : step === 15 ? 2 : 3,
      sourceChanged = p.source !== t.source,
      timeChanged = p.hi !== t.hi || p.lo !== t.lo,
      angleChanged = p.angle !== t.angle,
      time = timeChanged ? 1 : 0;
    const changed =
      (switched ? 64 : 0) |
      (sourceChanged ? 32 : 0) |
      (timeChanged ? 16 : 0) |
      (angleChanged ? 8 : 0) |
      (p.returns !== t.returns ? 4 : 0) |
      code;
    xy.symbol(context.changed[history], changed);
    this.channel.item = 0;
    if (switched) {
      xy.symbol(context.channel, ((p.channel - current + 4) & 3) - 1);
      context = target ?? (this.contexts[p.channel] = new Point14Context(streams, last));
      this.channel.current = this.channel.item = p.channel;
      last = context.last;
      last.channel = p.channel;
    }
    if (changed & 4) xy.symbol(at(context.returns, last.returns, 16), p.returns);
    if (code === 3) {
      if (timeChanged) xy.symbol(at(context.returnNumbers, last.returnNumber, 16), p.returnNumber);
      else xy.symbol(context.returnStep, ((p.returnNumber - last.returnNumber + 16) & 15) - 2);
    }
    const n = p.returns,
      r = p.returnNumber,
      index = (n << 4) | r,
      m = (MAP14[index] << 1) | time,
      level = LEVEL14[index],
      single = n === 1 ? 1 : 0,
      place = (r === 1 ? 2 : 0) + (r >= n ? 1 : 0),
      stepX = (p.x - last.x) | 0,
      stepY = (p.y - last.y) | 0,
      mx = context.medianX[m],
      my = context.medianY[m];
    context.dx.compress(mx.get(), stepX, single);
    mx.add(stepX);
    let k = context.dx.k;
    context.dy.compress(my.get(), stepY, single + (k < 20 ? k & ~1 : 20));
    my.add(stepY);
    k = (context.dx.k + context.dy.k) >> 1;
    context.z.compress(context.lastZ[level], p.z, single + (k < 18 ? k & ~1 : 18));
    context.lastZ[level] = p.z;
    if (p.z !== last.z) streams[1].changed = true;
    streams[2].encoder.symbol(
      at(context.classes, ((last.classification & 31) << 1) + (place === 3 ? 1 : 0), 256),
      p.classification,
    );
    if (p.classification !== last.classification) streams[2].changed = true;
    streams[3].encoder.symbol(at(context.flags, last.flags, 64), p.flags);
    if (p.flags !== last.flags) streams[3].changed = true;
    const slot = (place << 1) | time;
    context.intensities.compress(context.lastIntensity[slot], p.intensity, place);
    context.lastIntensity[slot] = p.intensity;
    if (p.intensity !== last.intensity) streams[4].changed = true;
    if (angleChanged) {
      context.angles.compress(last.angle, p.angle, time);
      streams[5].changed = true;
    }
    streams[6].encoder.symbol(at(context.users, last.user >> 2, 256), p.user);
    if (p.user !== last.user) streams[6].changed = true;
    if (sourceChanged) {
      context.sources.compress(last.source, p.source);
      streams[7].changed = true;
    }
    if (timeChanged) {
      context.gps.write(p.hi, p.lo);
      streams[8].changed = true;
    }
    last.copy(p);
    last.timeChanged = timeChanged;
  }
  layers() {
    return this.streams.map(finished);
  }
}

/**
 * The context rule of the items after point14. Each channel has its own models. An item moving to a channel it has not
 * seen starts it from the values it holds, and one moving back to a seen channel codes with that channel's models but
 * predicts, for that one point, from the values of the channel it left.
 */
abstract class ChannelWriter<T extends object> implements LayeredWriter {
  abstract readonly size: number;
  private readonly contexts: (T | undefined)[] = [];
  private current = 0;
  /** The context whose values the point being coded is predicted from. */
  protected held!: T;
  constructor(private readonly channel: Channel) {}
  /** A channel's state, its values copied from `from`, or read from the chunk's first point. */
  protected abstract make(from: T): T;
  protected abstract first(view: DataView, from: number): T;
  abstract write(view: DataView, from: number): void;
  abstract layers(): Uint8Array[];
  init(view: DataView, from: number) {
    this.current = this.channel.current;
    this.contexts[this.current] = this.first(view, from);
  }
  /** The context whose models code this point; sets `held`. */
  protected pick(): T {
    const next = this.channel.item;
    let held = this.contexts[this.current]!;
    if (this.current !== next) {
      this.current = next;
      if (!this.contexts[next]) held = this.contexts[next] = this.make(held);
    }
    this.held = held;
    return this.contexts[next]!;
  }
}

interface ColorContext {
  readonly rgb: Rgb;
  readonly nirUsed: SymbolModel;
  readonly nirDiff: SymbolModel[];
  nir: number;
}

/** RGB14, and RGBNIR14 with near infrared in a second layer. */
class Rgb14Writer extends ChannelWriter<ColorContext> {
  private readonly color = new Layer();
  private readonly infrared = new Layer();
  constructor(
    channel: Channel,
    readonly size: number,
  ) {
    super(channel);
  }
  private context(): ColorContext {
    return { rgb: new Rgb(), nirUsed: model(4), nirDiff: models(2, 256), nir: 0 };
  }
  protected first(view: DataView, from: number) {
    const context = this.context();
    context.rgb.read(view, from);
    if (this.size === 8) context.nir = view.getUint16(from + 6, true);
    return context;
  }
  protected make(from: ColorContext) {
    const context = this.context();
    context.rgb.last.set(from.rgb.last);
    context.nir = from.nir;
    return context;
  }
  write(view: DataView, from: number) {
    const context = this.pick(),
      held = this.held;
    if (context.rgb.write(this.color.encoder, view, from, held.rgb.last)) this.color.changed = true;
    if (this.size !== 8) return;
    const l = held.nir,
      x = view.getUint16(from + 6, true),
      symbol = ((l & 255) !== (x & 255) ? 1 : 0) | (l >> 8 !== x >> 8 ? 2 : 0),
      encoder = this.infrared.encoder;
    encoder.symbol(context.nirUsed, symbol);
    if (symbol & 1) encoder.symbol(context.nirDiff[0], ((x & 255) - (l & 255)) & 255);
    if (symbol & 2) encoder.symbol(context.nirDiff[1], ((x >> 8) - (l >> 8)) & 255);
    if (symbol) this.infrared.changed = true;
    held.nir = x;
  }
  layers() {
    return this.size === 8 ? [finished(this.color), finished(this.infrared)] : [finished(this.color)];
  }
}

interface BytesContext {
  readonly last: Uint8Array;
  readonly models: SymbolModel[];
}

/** BYTE14: every extra byte in a layer of its own. */
class Byte14Writer extends ChannelWriter<BytesContext> {
  private readonly streams: Layer[];
  constructor(
    channel: Channel,
    readonly size: number,
  ) {
    super(channel);
    this.streams = Array.from({ length: size }, () => new Layer());
  }
  protected first(view: DataView, from: number) {
    const last = new Uint8Array(this.size);
    for (let i = 0; i < this.size; i++) last[i] = view.getUint8(from + i);
    return { last, models: models(this.size, 256) };
  }
  protected make(from: BytesContext) {
    return { last: from.last.slice(), models: models(this.size, 256) };
  }
  write(view: DataView, from: number) {
    const context = this.pick(),
      last = this.held.last;
    for (let i = 0; i < this.size; i++) {
      const v = view.getUint8(from + i),
        layer = this.streams[i];
      layer.encoder.symbol(context.models[i], (v - last[i]) & 255);
      if (v !== last[i]) layer.changed = true;
      last[i] = v;
    }
  }
  layers() {
    return this.streams.map(finished);
  }
}

interface WaveContext {
  readonly last: Wave;
  readonly models: WaveModels;
}

class Wave14Writer extends ChannelWriter<WaveContext> {
  readonly size = 29;
  private readonly stream = new Layer();
  private context(): WaveContext {
    return { last: new Wave(), models: new WaveModels(this.stream.encoder) };
  }
  protected first(view: DataView, from: number) {
    const context = this.context();
    context.last.read(view, from);
    return context;
  }
  protected make(from: WaveContext) {
    const context = this.context();
    context.last.copy(from.last);
    return context;
  }
  write(view: DataView, from: number) {
    const context = this.pick();
    if (context.models.write(view, from, this.held.last)) this.stream.changed = true;
  }
  layers() {
    return [finished(this.stream)];
  }
}

// --- the file ------------------------------------------------------------------------------------------------------

/** LASzip item ids. */
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

/** The items of a record: `[type, size, version]`. */
export function itemsOf(format: number, recordLength: number): [number, number, number][] {
  const extra = recordLength - LAS_RECORD_SIZES[format],
    items: [number, number, number][] = [];
  if (format >= 6) {
    items.push([POINT14, 30, 3]);
    if (format === 7) items.push([RGB14, 6, 3]);
    else if (format === 8 || format === 10) items.push([RGBNIR14, 8, 3]);
    if (format >= 9) items.push([WAVEPACKET14, 29, 3]);
    if (extra) items.push([BYTE14, extra, 3]);
  } else {
    items.push([POINT10, 20, 2]);
    if (format === 1 || format >= 3) items.push([GPSTIME11, 8, 2]);
    if (format === 2 || format === 3 || format === 5) items.push([RGB12, 6, 2]);
    if (format >= 4) items.push([WAVEPACKET13, 29, 1]);
    if (extra) items.push([BYTE, extra, 2]);
  }
  return items;
}

/** One chunk of `count` points from `start`: its first record raw, then the coded rest. */
export function chunk(
  points: Uint8Array,
  view: DataView,
  start: number,
  count: number,
  length: number,
  items: readonly [number, number, number][],
): Uint8Array[] {
  const raw = points.subarray(start, start + length),
    layered = items[0][0] === POINT14,
    channel: Channel = { current: 0, item: 0 },
    encoder = new RangeEncoder(),
    layeredWriters: LayeredWriter[] = [],
    writers: ItemWriter[] = items.map(([type, size]) => {
      if (!layered)
        return type === POINT10
          ? new Point10Writer(encoder)
          : type === GPSTIME11
            ? new Gps11Writer(encoder)
            : type === RGB12
              ? new Rgb12Writer(encoder)
              : type === WAVEPACKET13
                ? new Wave13Writer(encoder)
                : new ByteWriter(encoder, size);
      const writer =
        type === POINT14
          ? new Point14Writer(channel)
          : type === WAVEPACKET14
            ? new Wave14Writer(channel)
            : type === BYTE14
              ? new Byte14Writer(channel, size)
              : new Rgb14Writer(channel, size);
      layeredWriters.push(writer);
      return writer;
    });
  let from = start;
  for (const writer of writers) {
    writer.init(view, from);
    from += writer.size;
  }
  const end = start + count * length;
  while (from < end)
    for (const writer of writers) {
      writer.write(view, from);
      from += writer.size;
    }
  if (!layered) return [raw, encoder.done()];
  const layers = layeredWriters.flatMap((writer) => writer.layers()),
    sizes = new DataView(new ArrayBuffer(4 + layers.length * 4));
  sizes.setUint32(0, count, true);
  layers.forEach((layer, i) => sizes.setUint32(4 + i * 4, layer.length, true));
  return [raw, new Uint8Array(sizes.buffer), ...layers];
}

/**
 * The `laszip encoded` record that describes the items: compressor 2 pointwise chunked or 3 layered chunked, coder 0,
 * and the version of LASzip whose coding this is. A chunk size of 0xffffffff marks variable chunks.
 */
export function lazRecord(items: readonly [number, number, number][], chunkSize: number): Uint8Array {
  const record = new Uint8Array(54 + 34 + items.length * 6),
    laszip = new DataView(record.buffer);
  record.set(new TextEncoder().encode('laszip encoded'), 2);
  record.set(new TextEncoder().encode('Margo Engine LAZ'), 22);
  laszip.setUint16(18, 22204, true);
  laszip.setUint16(20, record.length - 54, true);
  laszip.setUint16(54, items[0][0] === POINT14 ? 3 : 2, true);
  laszip.setUint8(58, 3);
  laszip.setUint8(59, 4);
  laszip.setUint32(66, chunkSize, true);
  // No special extended records.
  laszip.setBigInt64(70, -1n, true);
  laszip.setBigInt64(78, -1n, true);
  laszip.setUint16(86, items.length, true);
  items.forEach(([type, size, version], i) => {
    laszip.setUint16(88 + i * 6, type, true);
    laszip.setUint16(90 + i * 6, size, true);
    laszip.setUint16(92 + i * 6, version, true);
  });
  return record;
}

/**
 * The chunk table: each chunk's byte size, predicted from the one before, and with `counts` (variable chunks) its point
 * count.
 */
export function chunkTable(sizes: readonly number[], counts?: readonly number[]): Uint8Array[] {
  const encoder = new RangeEncoder(),
    integers = new IntegerCompressor(encoder, 32, 2),
    head = new DataView(new ArrayBuffer(8));
  head.setUint32(4, sizes.length, true);
  sizes.forEach((size, i) => {
    if (counts) integers.compress(i ? counts[i - 1] : 0, counts[i], 0);
    integers.compress(i ? sizes[i - 1] : 0, size, 1);
  });
  return [new Uint8Array(head.buffer), ...(sizes.length ? [encoder.done()] : [])];
}
