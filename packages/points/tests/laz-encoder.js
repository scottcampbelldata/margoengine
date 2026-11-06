// Test-only LAZ encoder, written from the same public descriptions as src/laz.ts (the LASzip paper, the LAZ format
// specification, the range coding literature) and kept separate from the decoder's code so a round trip checks two
// implementations against each other. It is NOT the reference LASzip encoder: files it writes prove that the decoder
// inverts this reading of the specification, not byte compatibility with LASzip.
import { readLASHeader } from '../dist/las.js';

const MIN_LENGTH = 0x01000000;

class BitModel {
  constructor() {
    this.zeros = 1;
    this.total = 2;
    this.prob = 1 << 12;
    this.cycle = this.until = 4;
  }
  update() {
    this.total += this.cycle;
    if (this.total > 8192) {
      this.total = (this.total + 1) >> 1;
      this.zeros = (this.zeros + 1) >> 1;
      if (this.zeros === this.total) this.total += 1;
    }
    this.prob = Math.floor((this.zeros * Math.floor(2 ** 31 / this.total)) / 2 ** 18);
    this.cycle = Math.min(Math.floor((this.cycle * 5) / 4), 64);
    this.until = this.cycle;
  }
}

class SymbolModel {
  constructor(symbols) {
    this.symbols = symbols;
    this.dist = new Array(symbols).fill(0);
    this.counts = new Array(symbols).fill(1);
    this.total = 0;
    this.cycle = symbols;
    this.update();
    this.cycle = this.until = Math.floor((symbols + 6) / 2);
  }
  update() {
    this.total += this.cycle;
    if (this.total > 32768) {
      this.total = 0;
      for (let k = 0; k < this.symbols; k++) {
        this.counts[k] = (this.counts[k] + 1) >> 1;
        this.total += this.counts[k];
      }
    }
    const scale = Math.floor(2 ** 31 / this.total);
    let sum = 0;
    for (let k = 0; k < this.symbols; k++) {
      this.dist[k] = Math.floor((scale * sum) / 2 ** 16);
      sum += this.counts[k];
    }
    this.cycle = Math.min(Math.floor((this.cycle * 5) / 4), (this.symbols + 6) * 8);
    this.until = this.cycle;
  }
}

/** 32-bit range encoder: base and length, a byte out per renormalisation, carries propagated into the output. */
export class RangeEncoder {
  constructor() {
    this.out = new Uint8Array(256);
    this.n = 0;
    this.base = 0;
    this.length = 0xffffffff;
  }
  put(byte) {
    if (this.n === this.out.length) {
      const grown = new Uint8Array(this.out.length * 2);
      grown.set(this.out);
      this.out = grown;
    }
    this.out[this.n++] = byte;
  }
  add(x) {
    this.base += x;
    if (this.base >= 2 ** 32) {
      this.base -= 2 ** 32;
      let p = this.n - 1;
      while (this.out[p] === 0xff) this.out[p--] = 0;
      this.out[p] += 1;
    }
  }
  renorm() {
    while (this.length < MIN_LENGTH) {
      this.put(Math.floor(this.base / 2 ** 24));
      this.base = (this.base % 2 ** 24) * 256;
      this.length *= 256;
    }
  }
  bit(model, bit) {
    const x = model.prob * Math.floor(this.length / 2 ** 13);
    if (bit) {
      this.add(x);
      this.length -= x;
    } else {
      this.length = x;
      model.zeros += 1;
    }
    this.renorm();
    if (--model.until === 0) model.update();
  }
  symbol(model, sym) {
    if (!(sym >= 0 && sym < model.symbols)) throw new Error(`encoder bug: symbol ${sym} of ${model.symbols}`);
    const unit = Math.floor(this.length / 2 ** 15),
      x = model.dist[sym] * unit;
    this.add(x);
    this.length = sym === model.symbols - 1 ? this.length - x : model.dist[sym + 1] * unit - x;
    this.renorm();
    model.counts[sym] += 1;
    if (--model.until === 0) model.update();
  }
  bits(count, value) {
    if (count > 19) {
      this.bits(16, value % 65536);
      this.bits(count - 16, Math.floor(value / 65536));
      return;
    }
    const unit = Math.floor(this.length / 2 ** count);
    this.add(value * unit);
    this.length = unit;
    this.renorm();
  }
  int(value) {
    this.bits(16, value % 65536);
    this.bits(16, Math.floor(value / 65536));
  }
  /** Ends the stream: a value inside the final interval, then zeros so the decoder's 4-byte look-ahead is covered. */
  done() {
    let pad = 3;
    if (this.length > 2 * MIN_LENGTH) {
      this.add(MIN_LENGTH);
      this.length = MIN_LENGTH / 2;
    } else {
      this.add(MIN_LENGTH / 2);
      this.length = MIN_LENGTH / 512;
      pad = 2;
    }
    this.renorm();
    for (let i = 0; i < pad; i++) this.put(0);
    return this.out.slice(0, this.n);
  }
}

/** Codes integers as prediction + corrector; the corrector's bit count k per context, then its bits. */
export class IntegerCompressor {
  constructor(enc, bits = 16, contexts = 1) {
    this.enc = enc;
    this.bitsHigh = 8;
    this.corrBits = bits < 32 ? bits : 32;
    this.range = bits < 32 ? 2 ** bits : 0;
    this.kModels = Array.from({ length: contexts }, () => new SymbolModel(this.corrBits + 1));
    this.zero = new BitModel();
    this.corrector = [];
    for (let i = 1; i <= this.corrBits; i++) this.corrector[i] = new SymbolModel(2 ** Math.min(i, 8));
    this.k = 0;
  }
  compress(pred, real, context = 0) {
    let c = real - pred;
    if (this.range) {
      if (c < -this.range / 2) c += this.range;
      else if (c > this.range / 2 - 1) c -= this.range;
    } else c |= 0;
    let k = 0;
    for (let v = c <= 0 ? -c : c - 1; v >= 1; v = Math.floor(v / 2)) k++;
    this.k = k;
    this.enc.symbol(this.kModels[context], k);
    if (k === 0) this.enc.bit(this.zero, c);
    else if (k < 32) {
      const v = c < 0 ? c + 2 ** k - 1 : c - 1;
      if (k <= this.bitsHigh) this.enc.symbol(this.corrector[k], v);
      else {
        const low = k - this.bitsHigh;
        this.enc.symbol(this.corrector[k], Math.floor(v / 2 ** low));
        this.enc.bits(low, v % 2 ** low);
      }
    }
  }
}

class Median5 {
  constructor() {
    this.v = [0, 0, 0, 0, 0];
    this.high = true;
  }
  get() {
    return this.v[2];
  }
  add(x) {
    const v = this.v;
    if (this.high) {
      if (x < v[2]) {
        v[4] = v[3];
        v[3] = v[2];
        if (x < v[0]) [v[2], v[1], v[0]] = [v[1], v[0], x];
        else if (x < v[1]) [v[2], v[1]] = [v[1], x];
        else v[2] = x;
      } else {
        if (x < v[3]) [v[4], v[3]] = [v[3], x];
        else v[4] = x;
        this.high = false;
      }
    } else if (v[2] < x) {
      v[0] = v[1];
      v[1] = v[2];
      if (v[4] < x) [v[2], v[3], v[4]] = [v[3], v[4], x];
      else if (v[3] < x) [v[2], v[3]] = [v[3], x];
      else v[2] = x;
    } else {
      if (v[1] < x) [v[0], v[1]] = [v[1], x];
      else v[0] = x;
      this.high = true;
    }
  }
}

const MAP10 = [
  [15, 14, 13, 12, 11, 10, 9, 8],
  [14, 0, 1, 3, 6, 10, 10, 9],
  [13, 1, 2, 4, 7, 11, 11, 10],
  [12, 3, 4, 5, 8, 12, 12, 11],
  [11, 6, 7, 8, 9, 13, 13, 12],
  [10, 10, 11, 12, 13, 14, 14, 13],
  [9, 10, 11, 12, 13, 14, 15, 14],
  [8, 9, 10, 11, 12, 13, 14, 15],
];
const MAP14_ROWS = [
  [0, 1, 2, 3, 4, 5, 3, 4, 4, 5],
  [1, 0, 1, 3, 4, 5, 3, 4, 4, 5],
  [2, 1, 2, 4, 5, 3, 4, 4, 5, 5],
  [3, 3, 4, 5, 4, 5, 4, 4, 5, 5],
  [4, 4, 5, 4, 5, 5, 4, 4, 5, 5],
  [5, 5, 3, 5, 5, 5, 4, 4, 5, 5],
  [3, 3, 4, 4, 4, 4, 4, 4, 5, 5],
  [4, 4, 4, 4, 4, 4, 4, 4, 5, 5],
  [4, 4, 5, 5, 5, 5, 5, 5, 5, 5],
];
const map14 = (n, r) => {
  if (n >= 4 && r >= 1 && r <= n) return r === 1 ? 3 : r === n ? 5 : 4;
  return n < MAP14_ROWS.length && r < 10 ? MAP14_ROWS[n][r] : 5;
};
const level = (n, r, max) => Math.min(Math.abs(n - r), max);
const clamp = (n) => Math.max(0, Math.min(255, n));
const model = (list, i, symbols) => (list[i] ??= new SymbolModel(symbols));

class Point10Writer {
  constructor(enc) {
    this.size = 20;
    this.enc = enc;
  }
  init(view, at) {
    const enc = this.enc;
    this.p = read10(view, at);
    this.p.intensity = 0;
    this.lastIntensity = new Array(16).fill(0);
    this.lastHeight = new Array(8).fill(0);
    this.mx = Array.from({ length: 16 }, () => new Median5());
    this.my = Array.from({ length: 16 }, () => new Median5());
    this.changed = new SymbolModel(64);
    this.angles = [new SymbolModel(256), new SymbolModel(256)];
    this.bitByte = [];
    this.classes = [];
    this.users = [];
    this.icIntensity = new IntegerCompressor(enc, 16, 4);
    this.icSource = new IntegerCompressor(enc, 16);
    this.icX = new IntegerCompressor(enc, 32, 2);
    this.icY = new IntegerCompressor(enc, 32, 22);
    this.icZ = new IntegerCompressor(enc, 32, 20);
  }
  write(view, at) {
    const enc = this.enc,
      last = this.p,
      p = read10(view, at),
      r = p.bits & 7,
      n = (p.bits >> 3) & 7,
      m = MAP10[n][r],
      l = level(n, r, 7),
      single = n === 1 ? 1 : 0;
    const changed =
      (p.bits !== last.bits ? 32 : 0) |
      (p.intensity !== this.lastIntensity[m] ? 16 : 0) |
      (p.cls !== last.cls ? 8 : 0) |
      (p.angle !== last.angle ? 4 : 0) |
      (p.user !== last.user ? 2 : 0) |
      (p.source !== last.source ? 1 : 0);
    enc.symbol(this.changed, changed);
    if (changed & 32) enc.symbol(model(this.bitByte, last.bits, 256), p.bits);
    if (changed & 16) {
      this.icIntensity.compress(this.lastIntensity[m], p.intensity, Math.min(m, 3));
      this.lastIntensity[m] = p.intensity;
    }
    if (changed & 8) enc.symbol(model(this.classes, last.cls, 256), p.cls);
    if (changed & 4) enc.symbol(this.angles[(p.bits >> 6) & 1], (p.angle - last.angle) & 255);
    if (changed & 2) enc.symbol(model(this.users, last.user, 256), p.user);
    if (changed & 1) this.icSource.compress(last.source, p.source);
    const dx = (p.x - last.x) | 0;
    this.icX.compress(this.mx[m].get(), dx, single);
    this.mx[m].add(dx);
    let k = this.icX.k;
    const dy = (p.y - last.y) | 0;
    this.icY.compress(this.my[m].get(), dy, single + (k < 20 ? k & ~1 : 20));
    this.my[m].add(dy);
    k = (this.icX.k + this.icY.k) >> 1;
    this.icZ.compress(this.lastHeight[l], p.z, single + (k < 18 ? k & ~1 : 18));
    this.lastHeight[l] = p.z;
    this.p = p;
  }
}

function read10(view, at) {
  return {
    x: view.getInt32(at, true),
    y: view.getInt32(at + 4, true),
    z: view.getInt32(at + 8, true),
    intensity: view.getUint16(at + 12, true),
    bits: view.getUint8(at + 14),
    cls: view.getUint8(at + 15),
    angle: view.getUint8(at + 16),
    user: view.getUint8(at + 17),
    source: view.getUint16(at + 18, true),
  };
}

const MULTI = 500,
  MINUS = -10,
  UNCHANGED = 511,
  FULL = 512;
const fits = (d) => d >= -(2n ** 31n) && d < 2n ** 31n;
const high = (t) => Number(BigInt.asIntN(32, t >> 32n));
const quantize = (f) => (f >= 0 ? Math.trunc(Math.fround(f + 0.5)) : Math.trunc(Math.fround(f - 0.5)));

/** GPS time sequences; `layered` is the point14 variant (no "unchanged" code, 5 zero-difference symbols). */
class GpsEncoder {
  constructor(enc, layered, t) {
    this.enc = enc;
    this.layered = layered;
    // LAZ specification 1.4, note 6 of the point14 item: one symbol fewer than GPSTIME11 (515, not 516), because
    // "unchanged" (511 there) is bit 4 of the changed flags; a new sequence is 511 and the switches are 512 to 514.
    // A real USGS file proves it (the 516-symbol reading did not decode it).
    this.fullCode = layered ? UNCHANGED : FULL;
    this.multi = new SymbolModel(this.fullCode + 4);
    this.zero = new SymbolModel(layered ? 5 : 6);
    this.ic = new IntegerCompressor(enc, 32, 9);
    this.seq = [t, 0n, 0n, 0n];
    this.diff = [0, 0, 0, 0];
    this.extreme = [0, 0, 0, 0];
    this.last = 0;
    this.next = 0;
  }
  full(t) {
    this.next = (this.next + 1) & 3;
    this.ic.compress(high(this.seq[this.last]), high(t), 8);
    this.enc.int(Number(BigInt.asUintN(32, t)));
    this.last = this.next;
    this.diff[this.last] = 0;
    this.extreme[this.last] = 0;
    this.seq[this.last] = t;
  }
  other(t) {
    for (let i = 1; i < 4; i++) if (fits(BigInt.asIntN(64, t - this.seq[(this.last + i) & 3]))) return i;
    return 0;
  }
  bump(d) {
    if (++this.extreme[this.last] > 3) {
      this.diff[this.last] = d;
      this.extreme[this.last] = 0;
    }
  }
  write(t) {
    const { enc, ic } = this,
      small = this.layered ? 0 : 1;
    for (;;) {
      const last = this.last,
        d64 = BigInt.asIntN(64, t - this.seq[last]);
      if (this.diff[last] === 0) {
        if (!this.layered && d64 === 0n) return enc.symbol(this.zero, 0);
        if (fits(d64)) {
          const d = Number(d64);
          enc.symbol(this.zero, small);
          ic.compress(0, d, 0);
          this.diff[last] = d;
          this.extreme[last] = 0;
          this.seq[last] = t;
          return;
        }
        const i = this.other(t);
        if (i) {
          enc.symbol(this.zero, small + 1 + i);
          this.last = (last + i) & 3;
          continue;
        }
        enc.symbol(this.zero, small + 1);
        return this.full(t);
      }
      if (!this.layered && d64 === 0n) return enc.symbol(this.multi, UNCHANGED);
      if (!fits(d64)) {
        const i = this.other(t);
        if (i) {
          enc.symbol(this.multi, this.fullCode + i);
          this.last = (last + i) & 3;
          continue;
        }
        enc.symbol(this.multi, this.fullCode);
        return this.full(t);
      }
      const d = Number(d64),
        prev = this.diff[last],
        multi = quantize(Math.fround(Math.fround(d) / Math.fround(prev)));
      if (multi === 1) {
        enc.symbol(this.multi, 1);
        ic.compress(prev, d, 1);
        this.extreme[last] = 0;
      } else if (multi > 1 && multi < MULTI) {
        enc.symbol(this.multi, multi);
        ic.compress(Math.imul(multi, prev), d, multi < 10 ? 2 : 3);
      } else if (multi >= MULTI) {
        enc.symbol(this.multi, MULTI);
        ic.compress(Math.imul(MULTI, prev), d, 4);
        this.bump(d);
      } else if (multi < 0 && multi > MINUS) {
        enc.symbol(this.multi, MULTI - multi);
        ic.compress(Math.imul(multi, prev), d, 5);
      } else if (multi < 0) {
        enc.symbol(this.multi, MULTI - MINUS);
        ic.compress(Math.imul(MINUS, prev), d, 6);
        this.bump(d);
      } else {
        enc.symbol(this.multi, 0);
        ic.compress(0, d, 7);
        this.bump(d);
      }
      this.seq[last] = t;
      return;
    }
  }
}

class Gps11Writer {
  constructor(enc) {
    this.size = 8;
    this.enc = enc;
  }
  init(view, at) {
    this.gps = new GpsEncoder(this.enc, false, view.getBigInt64(at, true));
  }
  write(view, at) {
    this.gps.write(view.getBigInt64(at, true));
  }
}

class RgbModels {
  constructor() {
    this.used = new SymbolModel(128);
    this.diff = Array.from({ length: 6 }, () => new SymbolModel(256));
  }
}

/** Codes `rgb` against `last`; returns whether any byte changed. */
function writeRgb(enc, m, last, rgb) {
  const [l0, l1, l2] = last,
    [r, g, b] = rgb;
  const sym =
    ((l0 & 255) !== (r & 255) ? 1 : 0) |
    (l0 >> 8 !== r >> 8 ? 2 : 0) |
    ((l1 & 255) !== (g & 255) ? 4 : 0) |
    (l1 >> 8 !== g >> 8 ? 8 : 0) |
    ((l2 & 255) !== (b & 255) ? 16 : 0) |
    (l2 >> 8 !== b >> 8 ? 32 : 0) |
    (r !== g || r !== b ? 64 : 0);
  enc.symbol(m.used, sym);
  if (sym & 1) enc.symbol(m.diff[0], ((r & 255) - (l0 & 255)) & 255);
  if (sym & 2) enc.symbol(m.diff[1], ((r >> 8) - (l0 >> 8)) & 255);
  if (sym & 64) {
    let d = (r & 255) - (l0 & 255);
    if (sym & 4) enc.symbol(m.diff[2], ((g & 255) - clamp(d + (l1 & 255))) & 255);
    if (sym & 16) {
      d = Math.trunc((d + (g & 255) - (l1 & 255)) / 2);
      enc.symbol(m.diff[4], ((b & 255) - clamp(d + (l2 & 255))) & 255);
    }
    d = (r >> 8) - (l0 >> 8);
    if (sym & 8) enc.symbol(m.diff[3], ((g >> 8) - clamp(d + (l1 >> 8))) & 255);
    if (sym & 32) {
      d = Math.trunc((d + (g >> 8) - (l1 >> 8)) / 2);
      enc.symbol(m.diff[5], ((b >> 8) - clamp(d + (l2 >> 8))) & 255);
    }
  }
  const changed = l0 !== r || l1 !== g || l2 !== b;
  last[0] = r;
  last[1] = g;
  last[2] = b;
  return changed;
}

const rgbAt = (view, at) => [0, 1, 2].map((c) => view.getUint16(at + c * 2, true));

class Rgb12Writer {
  constructor(enc) {
    this.size = 6;
    this.enc = enc;
  }
  init(view, at) {
    this.last = rgbAt(view, at);
    this.models = new RgbModels();
  }
  write(view, at) {
    writeRgb(this.enc, this.models, this.last, rgbAt(view, at));
  }
}

class ByteWriter {
  constructor(enc, size) {
    this.size = size;
    this.enc = enc;
  }
  init(view, at) {
    this.last = Array.from({ length: this.size }, (_, i) => view.getUint8(at + i));
    this.models = Array.from({ length: this.size }, () => new SymbolModel(256));
  }
  write(view, at) {
    for (let i = 0; i < this.size; i++) {
      const v = view.getUint8(at + i);
      this.enc.symbol(this.models[i], (v - this.last[i]) & 255);
      this.last[i] = v;
    }
  }
}

// --- layered point14 family ------------------------------------------------------------------------------------

/** One layer: its own encoder, restarted each chunk, and whether any value it codes changed. */
class Layer {
  constructor() {
    this.enc = new RangeEncoder();
    this.changed = false;
  }
  bytes(always) {
    return this.changed || always ? this.enc.done() : new Uint8Array(0);
  }
}

function read14(view, at) {
  const b = view.getUint8(at + 14),
    f = view.getUint8(at + 15);
  return {
    x: view.getInt32(at, true),
    y: view.getInt32(at + 4, true),
    z: view.getInt32(at + 8, true),
    intensity: view.getUint16(at + 12, true),
    ret: b & 15,
    returns: b >> 4,
    classFlags: f & 15,
    channel: (f >> 4) & 3,
    scanDirection: (f >> 6) & 1,
    edge: f >> 7,
    cls: view.getUint8(at + 16),
    user: view.getUint8(at + 17),
    angle: view.getInt16(at + 18, true),
    source: view.getUint16(at + 20, true),
    gps: view.getBigInt64(at + 22, true),
    gpsChange: false,
  };
}

class Point14Writer {
  constructor(channel) {
    this.size = 30;
    this.channel = channel;
  }
  start() {
    this.layers = Array.from({ length: 9 }, () => new Layer());
  }
  context(c, from) {
    const [xy, z, , , intensity, angle, , source, gps] = this.layers.map((l) => l.enc);
    const ctx = {
      last: { ...from, gpsChange: false },
      lastIntensity: new Array(8).fill(from.intensity),
      lastZ: new Array(8).fill(from.z),
      mx: Array.from({ length: 12 }, () => new Median5()),
      my: Array.from({ length: 12 }, () => new Median5()),
      changed: Array.from({ length: 8 }, () => new SymbolModel(128)),
      channel: new SymbolModel(3),
      returns: [],
      ret: [],
      retGpsSame: new SymbolModel(13),
      classes: [],
      flags: [],
      users: [],
      icX: new IntegerCompressor(xy, 32, 2),
      icY: new IntegerCompressor(xy, 32, 22),
      icZ: new IntegerCompressor(z, 32, 20),
      icIntensity: new IntegerCompressor(intensity, 16, 4),
      icAngle: new IntegerCompressor(angle, 16, 2),
      icSource: new IntegerCompressor(source, 16),
      gps: new GpsEncoder(gps, true, from.gps),
    };
    this.contexts[c] = ctx;
    return ctx;
  }
  init(view, at) {
    const p = read14(view, at);
    this.contexts = [];
    this.channel.current = this.channel.item = p.channel;
    this.context(p.channel, p);
  }
  write(view, at) {
    const L = this.layers,
      xy = L[0].enc,
      p = read14(view, at);
    let ctx = this.contexts[this.channel.current],
      last = ctx.last;
    const lpr = (last.ret === 1 ? 1 : 0) + (last.ret >= last.returns ? 2 : 0) + (last.gpsChange ? 4 : 0);
    const switched = p.channel !== this.channel.current,
      target = switched ? this.contexts[p.channel] : ctx,
      t = target ? target.last : last;
    const code = p.ret === t.ret ? 0 : p.ret === ((t.ret + 1) & 15) ? 1 : p.ret === ((t.ret + 15) & 15) ? 2 : 3;
    const sourceChange = p.source !== t.source,
      gpsChange = p.gps !== t.gps,
      angleChange = p.angle !== t.angle,
      gpsBit = gpsChange ? 1 : 0;
    const changed =
      (switched ? 64 : 0) |
      (sourceChange ? 32 : 0) |
      (gpsChange ? 16 : 0) |
      (angleChange ? 8 : 0) |
      (p.returns !== t.returns ? 4 : 0) |
      code;
    xy.symbol(ctx.changed[lpr], changed);
    this.channel.item = 0;
    if (switched) {
      xy.symbol(ctx.channel, ((p.channel - this.channel.current + 4) & 3) - 1);
      ctx = target ?? this.context(p.channel, last);
      this.channel.current = this.channel.item = p.channel;
      last = ctx.last;
      last.channel = p.channel;
    }
    if (changed & 4) xy.symbol(model(ctx.returns, last.returns, 16), p.returns);
    if (code === 3) {
      if (gpsChange) xy.symbol(model(ctx.ret, last.ret, 16), p.ret);
      else xy.symbol(ctx.retGpsSame, ((p.ret - last.ret + 16) & 15) - 2);
    }
    const n = p.returns,
      r = p.ret,
      m = map14(n, r),
      l = level(n, r, 7),
      single = n === 1 ? 1 : 0,
      cpr = (r === 1 ? 2 : 0) + (r >= n ? 1 : 0);
    const dx = (p.x - last.x) | 0,
      mx = ctx.mx[(m << 1) | gpsBit],
      my = ctx.my[(m << 1) | gpsBit];
    ctx.icX.compress(mx.get(), dx, single);
    mx.add(dx);
    let k = ctx.icX.k;
    const dy = (p.y - last.y) | 0;
    ctx.icY.compress(my.get(), dy, single + (k < 20 ? k & ~1 : 20));
    my.add(dy);
    k = (ctx.icX.k + ctx.icY.k) >> 1;
    ctx.icZ.compress(ctx.lastZ[l], p.z, single + (k < 18 ? k & ~1 : 18));
    ctx.lastZ[l] = p.z;
    if (p.z !== last.z) L[1].changed = true;
    L[2].enc.symbol(model(ctx.classes, ((last.cls & 31) << 1) + (cpr === 3 ? 1 : 0), 256), p.cls);
    if (p.cls !== last.cls) L[2].changed = true;
    const flags = (last.edge << 5) | (last.scanDirection << 4) | last.classFlags,
      next = (p.edge << 5) | (p.scanDirection << 4) | p.classFlags;
    L[3].enc.symbol(model(ctx.flags, flags, 64), next);
    if (flags !== next) L[3].changed = true;
    const i = (cpr << 1) | gpsBit;
    ctx.icIntensity.compress(ctx.lastIntensity[i], p.intensity, cpr);
    ctx.lastIntensity[i] = p.intensity;
    if (p.intensity !== last.intensity) L[4].changed = true;
    if (angleChange) {
      ctx.icAngle.compress(last.angle, p.angle, gpsBit);
      L[5].changed = true;
    }
    L[6].enc.symbol(model(ctx.users, last.user >> 2, 256), p.user);
    if (p.user !== last.user) L[6].changed = true;
    if (sourceChange) {
      ctx.icSource.compress(last.source, p.source);
      L[7].changed = true;
    }
    if (gpsChange) {
      ctx.gps.write(p.gps);
      L[8].changed = true;
    }
    Object.assign(last, p, { gpsChange });
  }
  chunkLayers() {
    return this.layers.map((l, i) => l.bytes(i === 0));
  }
}

/** The context rule of the layered items after point14: models of the record's context, last value of the one before. */
function pickContext(writer) {
  const context = writer.channel.item;
  let holder = writer.contexts[writer.current];
  if (writer.current !== context) {
    writer.current = context;
    if (!writer.contexts[context]) holder = writer.context(context, holder.last);
  }
  return { ctx: writer.contexts[context], last: holder.last };
}

/** RGB14 / RGBNIR14 / BYTE14: per context models, by the rule of `pickContext`. */
class ChannelWriter {
  constructor(channel, size, kind) {
    this.channel = channel;
    this.size = size;
    this.kind = kind;
    this.count = kind === 'bytes' ? size : kind === 'rgbnir' ? 2 : 1;
  }
  start() {
    this.layers = Array.from({ length: this.count }, () => new Layer());
  }
  values(view, at) {
    if (this.kind === 'bytes') return Array.from({ length: this.size }, (_, i) => view.getUint8(at + i));
    return Array.from({ length: this.size / 2 }, (_, c) => view.getUint16(at + c * 2, true));
  }
  context(c, last) {
    const ctx = {
      last: [...last],
      rgb: new RgbModels(),
      nirUsed: new SymbolModel(4),
      nir: [new SymbolModel(256), new SymbolModel(256)],
      bytes: Array.from({ length: this.size }, () => new SymbolModel(256)),
    };
    this.contexts[c] = ctx;
    return ctx;
  }
  init(view, at) {
    this.contexts = [];
    this.current = this.channel.current;
    this.context(this.current, this.values(view, at));
  }
  write(view, at) {
    const { ctx, last } = pickContext(this),
      v = this.values(view, at);
    if (this.kind === 'bytes') {
      for (let i = 0; i < this.size; i++) {
        this.layers[i].enc.symbol(ctx.bytes[i], (v[i] - last[i]) & 255);
        if (v[i] !== last[i]) this.layers[i].changed = true;
        last[i] = v[i];
      }
      return;
    }
    const rgb = last.slice(0, 3);
    if (writeRgb(this.layers[0].enc, ctx.rgb, rgb, v)) this.layers[0].changed = true;
    last.splice(0, 3, ...rgb);
    if (this.kind === 'rgbnir') {
      const l = last[3],
        x = v[3],
        sym = ((l & 255) !== (x & 255) ? 1 : 0) | (l >> 8 !== x >> 8 ? 2 : 0),
        enc = this.layers[1].enc;
      enc.symbol(ctx.nirUsed, sym);
      if (sym & 1) enc.symbol(ctx.nir[0], ((x & 255) - (l & 255)) & 255);
      if (sym & 2) enc.symbol(ctx.nir[1], ((x >> 8) - (l >> 8)) & 255);
      if (sym) this.layers[1].changed = true;
      last[3] = x;
    }
  }
  chunkLayers() {
    return this.layers.map((l) => l.bytes(false));
  }
}

/** Reads the fields of a wave packet record. */
const readWave = (view, at) => ({
  index: view.getUint8(at),
  offset: view.getBigUint64(at + 1, true),
  size: view.getInt32(at + 9, true),
  location: view.getInt32(at + 13, true),
  direction: [view.getInt32(at + 17, true), view.getInt32(at + 21, true), view.getInt32(at + 25, true)],
});

const waveModels = (enc) => ({
  index: new SymbolModel(256),
  type: Array.from({ length: 4 }, () => new SymbolModel(4)),
  diff: new IntegerCompressor(enc, 32),
  size: new IntegerCompressor(enc, 32),
  location: new IntegerCompressor(enc, 32),
  direction: new IntegerCompressor(enc, 32, 3),
  lastType: 0,
  lastDiff: 0,
});

/** Encodes `w` after `last`. Returns whether any field changed. */
function writeWave(enc, m, last, w) {
  enc.symbol(m.index, w.index);
  const delta = BigInt.asIntN(64, w.offset - last.offset),
    type =
      delta === 0n
        ? 0
        : w.offset === BigInt.asUintN(64, last.offset + BigInt(last.size >>> 0))
          ? 1
          : delta === BigInt.asIntN(32, delta)
            ? 2
            : 3;
  enc.symbol(m.type[m.lastType], type);
  m.lastType = type;
  if (type === 2) {
    m.diff.compress(m.lastDiff, Number(delta));
    m.lastDiff = Number(delta);
  } else if (type === 3) {
    enc.int(Number(w.offset & 0xffffffffn));
    enc.int(Number(w.offset >> 32n));
  }
  m.size.compress(last.size, w.size);
  m.location.compress(last.location, w.location);
  for (let c = 0; c < 3; c++) m.direction.compress(last.direction[c], w.direction[c], c);
  const changed =
    w.index !== last.index ||
    delta !== 0n ||
    w.size !== last.size ||
    w.location !== last.location ||
    w.direction.some((v, c) => v !== last.direction[c]);
  Object.assign(last, w);
  return changed;
}

class Wave13Writer {
  constructor(enc) {
    this.size = 29;
    this.enc = enc;
    this.models = waveModels(enc);
  }
  init(view, at) {
    this.last = readWave(view, at);
  }
  write(view, at) {
    writeWave(this.enc, this.models, this.last, readWave(view, at));
  }
}

class Wave14Writer {
  constructor(channel) {
    this.size = 29;
    this.channel = channel;
  }
  start() {
    this.layer = new Layer();
  }
  context(c, last) {
    return (this.contexts[c] = { last: { ...last }, models: waveModels(this.layer.enc) });
  }
  init(view, at) {
    this.contexts = [];
    this.current = this.channel.current;
    this.context(this.current, readWave(view, at));
  }
  write(view, at) {
    const { ctx, last } = pickContext(this);
    if (writeWave(this.layer.enc, ctx.models, last, readWave(view, at))) this.layer.changed = true;
  }
  chunkLayers() {
    return [this.layer.bytes(false)];
  }
}

const concat = (parts) => {
  const out = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
};

/**
 * Compresses an uncompressed LAS file (formats 0 to 10, any extra bytes) to LAZ.
 * `chunkSize`: points per chunk (default 50,000); `chunks`: explicit chunk point counts (variable chunks);
 * `tableAtEnd`: write -1 as the chunk table offset and the offset in the file's last 8 bytes.
 * `pointwise`: compressor 1, one stream with no chunk table (formats 0 to 5); `adaptiveZero`: mark variable chunks with
 * a chunk size of 0, the specification's other spelling of 2^32 - 1.
 * `override`: LASzip record fields to write instead (compressor, coder, item version, the item list) for the
 * unsupported-feature tests.
 */
export function encodeLAZ(
  las,
  { chunkSize = 50_000, chunks, tableAtEnd = false, pointwise = false, adaptiveZero = false, override = {} } = {},
) {
  const { header } = readLASHeader(las),
    format = header.pointFormat,
    length = header.pointRecordLength,
    count = header.pointCount,
    layered = format >= 6,
    channel = { current: 0, item: 0 };
  const base = [20, 28, 26, 34, 57, 63, 30, 36, 38, 59, 67][format],
    extra = length - base;
  const items = layered
    ? [
        [10, 30],
        ...(format === 7 ? [[11, 6]] : format === 8 || format === 10 ? [[12, 8]] : []),
        ...(format >= 9 ? [[13, 29]] : []),
      ]
    : [
        [6, 20],
        ...([1, 3, 4, 5].includes(format) ? [[7, 8]] : []),
        ...([2, 3, 5].includes(format) ? [[8, 6]] : []),
        ...(format >= 4 ? [[9, 29]] : []),
      ];
  if (extra) items.push([layered ? 14 : 0, extra]);
  const version = layered ? 3 : 2;
  const makeWriters = (enc) =>
    items.map(([type, size]) => {
      switch (type) {
        case 6:
          return new Point10Writer(enc);
        case 7:
          return new Gps11Writer(enc);
        case 8:
          return new Rgb12Writer(enc);
        case 9:
          return new Wave13Writer(enc);
        case 13:
          return new Wave14Writer(channel);
        case 0:
          return new ByteWriter(enc, size);
        case 10:
          return new Point14Writer(channel);
        case 11:
          return new ChannelWriter(channel, size, 'rgb');
        case 12:
          return new ChannelWriter(channel, size, 'rgbnir');
        default:
          return new ChannelWriter(channel, size, 'bytes');
      }
    });
  const counts = pointwise ? [count] : chunks ? [...chunks] : [];
  if (!chunks && !pointwise) for (let left = count; left > 0; left -= chunkSize) counts.push(Math.min(chunkSize, left));
  const data = las.subarray(header.pointDataOffset),
    view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const parts = [];
  let first = 0;
  for (const n of counts) {
    const raw = data.subarray(first * length, (first + 1) * length);
    if (layered) {
      const writers = makeWriters(null);
      for (const w of writers) w.start();
      let o = first * length;
      for (const w of writers) {
        w.init(view, o);
        o += w.size;
      }
      for (let p = 1; p < n; p++) {
        o = (first + p) * length;
        for (const w of writers) {
          w.write(view, o);
          o += w.size;
        }
      }
      const layers = writers.flatMap((w) => w.chunkLayers()),
        table = new DataView(new ArrayBuffer(4 + layers.length * 4));
      table.setUint32(0, n, true);
      layers.forEach((l, i) => table.setUint32(4 + i * 4, l.length, true));
      parts.push(concat([raw, new Uint8Array(table.buffer), ...layers]));
    } else {
      const enc = new RangeEncoder(),
        writers = makeWriters(enc);
      let o = first * length;
      for (const w of writers) {
        w.init(view, o);
        o += w.size;
      }
      for (let p = 1; p < n; p++) {
        o = (first + p) * length;
        for (const w of writers) {
          w.write(view, o);
          o += w.size;
        }
      }
      parts.push(concat([raw, enc.done()]));
    }
    first += n;
  }
  // Chunk table: each chunk's point count (variable chunks only) and byte size, predicted from the previous one.
  const enc = new RangeEncoder(),
    ic = new IntegerCompressor(enc, 32, 2);
  parts.forEach((part, i) => {
    if (chunks) ic.compress(i ? counts[i - 1] : 0, counts[i], 0);
    ic.compress(i ? parts[i - 1].length : 0, part.length, 1);
  });
  const tableBody = enc.done(),
    tableHead = new DataView(new ArrayBuffer(8));
  tableHead.setUint32(4, parts.length, true);
  // The LASzip record.
  const listed = override.items ?? items,
    vlr = new DataView(new ArrayBuffer(34 + listed.length * 6));
  vlr.setUint16(0, override.compressor ?? (layered ? 3 : pointwise ? 1 : 2), true);
  vlr.setUint16(2, override.coder ?? 0, true);
  vlr.setUint8(4, 3);
  vlr.setUint8(5, 4);
  vlr.setUint32(12, pointwise || adaptiveZero ? 0 : chunks ? 0xffffffff : chunkSize, true);
  vlr.setBigInt64(16, -1n, true);
  vlr.setBigInt64(24, -1n, true);
  vlr.setUint16(32, listed.length, true);
  listed.forEach(([type, size], i) => {
    vlr.setUint16(34 + i * 6, type, true);
    vlr.setUint16(36 + i * 6, size, true);
    vlr.setUint16(38 + i * 6, override.version ?? (type === 9 ? 1 : version), true);
  });
  const record = new Uint8Array(54 + vlr.byteLength),
    rv = new DataView(record.buffer);
  record.set(new TextEncoder().encode('laszip encoded'), 2);
  rv.setUint16(18, 22204, true);
  rv.setUint16(20, vlr.byteLength, true);
  record.set(new Uint8Array(vlr.buffer), 54);
  const head = las.slice(0, header.pointDataOffset),
    hv = new DataView(head.buffer),
    pointOffset = header.pointDataOffset + record.length;
  hv.setUint32(96, pointOffset, true);
  hv.setUint32(100, hv.getUint32(100, true) + 1, true);
  hv.setUint8(104, format | 0x80);
  if (pointwise) return concat([head, record, ...parts]);
  const chunkBytes = concat(parts),
    tableOffset = pointOffset + 8 + chunkBytes.length,
    offset = new DataView(new ArrayBuffer(8));
  offset.setBigInt64(0, tableAtEnd ? -1n : BigInt(tableOffset), true);
  const tail = new DataView(new ArrayBuffer(8));
  tail.setBigInt64(0, BigInt(tableOffset), true);
  return concat([
    head,
    record,
    new Uint8Array(offset.buffer),
    chunkBytes,
    new Uint8Array(tableHead.buffer),
    tableBody,
    ...(tableAtEnd ? [new Uint8Array(tail.buffer)] : []),
  ]);
}
