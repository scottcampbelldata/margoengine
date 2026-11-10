// KTX2 container and BasisLZ encoding, clean room from KTX2 appendices C/D.
import { codeLengths, canonicalCodes } from './prefix-codes.js';
import type { KTX2Mode } from './ktx2-encode.js';

class Bits {
  data: number[] = [];
  at = 0;
  put(value: number, count: number): void {
    for (let b = 0; b < count; b++, this.at++) {
      const i = this.at >> 3;
      this.data[i] = (this.data[i] ?? 0) | (((value >>> b) & 1) << (this.at & 7));
    }
  }
  finish(): Uint8Array {
    return new Uint8Array(this.data);
  }
}
const order = [17, 18, 19, 20, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15, 16];
class Huffman {
  lengths: Uint8Array;
  codes: Uint16Array;
  constructor(values: readonly number[], limit = 16) {
    let largest = 1;
    for (const value of values) largest = Math.max(largest, value);
    const histogram = new Uint32Array(largest + 1);
    for (const value of values) histogram[value]++;
    if (!values.length) histogram[0] = 1;
    this.lengths = codeLengths(histogram, limit);
    const used = [...histogram.keys()].filter((i) => histogram[i]);
    if (used.length === 1) this.lengths[used[0]] = 1;
    let last = this.lengths.length;
    while (last && this.lengths[last - 1] === 0) last--;
    this.lengths = this.lengths.slice(0, last);
    if (this.lengths.length >= 16384) throw new RangeError('BasisLZ Huffman alphabet exceeds 16383 symbols; reduce quality or split the image');
    this.codes = canonicalCodes(this.lengths);
  }
  symbol(bits: Bits, symbol: number): void {
    bits.put(this.codes[symbol], this.lengths[symbol]);
  }
  write(bits: Bits): void {
    const tokens: [number, number, number][] = [];
    for (let i = 0; i < this.lengths.length; ) {
      const value = this.lengths[i];
      let count = 1;
      while (i + count < this.lengths.length && this.lengths[i + count] === value) count++;
      if (value === 0) {
        while (count >= 3) {
          const n = Math.min(count, 138);
          tokens.push(n >= 11 ? [18, n - 11, 7] : [17, n - 3, 3]);
          i += n;
          count -= n;
        }
      } else {
        tokens.push([value, 0, 0]);
        i++;
        count--;
        while (count >= 3) {
          const n = Math.min(count, 134);
          tokens.push(n >= 7 ? [20, n - 7, 7] : [19, n - 3, 2]);
          i += n;
          count -= n;
        }
      }
      while (count-- > 0) {
        tokens.push([value, 0, 0]);
        i++;
      }
    }
    // Each code-length-alphabet length is stored in three bits, independently
    // of the 16-bit limit of the large alphabet it describes.
    const small = new Huffman(
      tokens.map((t) => t[0]),
      7,
    );
    let count = order.length;
    while (count && !small.lengths[order[count - 1]]) count--;
    bits.put(this.lengths.length, 14);
    bits.put(count, 5);
    for (let i = 0; i < count; i++) bits.put(small.lengths[order[i]] ?? 0, 3);
    for (const [symbol, value, n] of tokens) {
      small.symbol(bits, symbol);
      bits.put(value, n);
    }
  }
}
const u32 = (view: DataView, at: number, n: number): void => view.setUint32(at, n, true);
function descriptor(mode: KTX2Mode, alpha: boolean, srgb: boolean): Uint8Array {
  const samples = mode === 'etc1s' && alpha ? 2 : 1,
    data = new Uint8Array(28 + samples * 16),
    view = new DataView(data.buffer);
  u32(view, 0, data.length);
  view.setUint16(8, 2, true);
  view.setUint16(10, data.length - 4, true);
  data.set([mode === 'etc1s' ? 163 : 166, srgb ? 1 : 0, srgb ? 2 : 1, 0, 3, 3, 0, 0], 12);
  data[20] = mode === 'etc1s' ? 8 : 16;
  if (mode === 'etc1s' && alpha) data[21] = 8;
  for (let i = 0; i < samples; i++) {
    const at = 28 + i * 16;
    view.setUint16(at, i * 64, true);
    data[at + 2] = mode === 'etc1s' ? 63 : 127;
    data[at + 3] = mode === 'etc1s' ? (i === 1 ? 15 : 0) : alpha ? 3 : 0;
    u32(view, at + 12, 0xffffffff);
  }
  return data;
}
export interface EncodedLevel {
  data: Uint8Array;
  rawLength?: number;
}
export function packKTX2(
  width: number,
  height: number,
  levels: EncodedLevel[],
  mode: KTX2Mode,
  alpha: boolean,
  srgb: boolean,
  global: Uint8Array = new Uint8Array(),
): Uint8Array {
  const dfd = descriptor(mode, alpha, srgb),
    dfdAt = 80 + levels.length * 24,
    globalAt = (dfdAt + dfd.length + 7) & ~7;
  let length = globalAt + global.length;
  const positions: number[] = [];
  for (let i = levels.length - 1; i >= 0; i--) {
    positions[i] = length;
    length += levels[i].data.length;
  }
  const result = new Uint8Array(length),
    view = new DataView(result.buffer),
    scheme = mode === 'etc1s' ? 1 : 2;
  result.set([171, 75, 84, 88, 32, 50, 48, 187, 13, 10, 26, 10]);
  for (const [at, value] of [
    [16, 1],
    [20, width],
    [24, height],
    [36, 1],
    [40, levels.length],
    [44, scheme],
    [48, dfdAt],
    [52, dfd.length],
  ])
    u32(view, at, value);
  if (global.length) {
    view.setBigUint64(64, BigInt(globalAt), true);
    view.setBigUint64(72, BigInt(global.length), true);
    result.set(global, globalAt);
  }
  result.set(dfd, dfdAt);
  levels.forEach((level, i) => {
    view.setBigUint64(80 + i * 24, BigInt(positions[i]), true);
    view.setBigUint64(88 + i * 24, BigInt(level.data.length), true);
    view.setBigUint64(96 + i * 24, BigInt(scheme === 1 ? 0 : (level.rawLength ?? level.data.length)), true);
    result.set(level.data, positions[i]);
  });
  return result;
}
// Evaluate the complete context-coded payload, including books and model headers.
// Index relabelling changes no endpoint, selector or decoded pixel.
export function encodeBasisLZ(
  fitted: Uint8Array[], dimensions: [number, number][], alpha: boolean,
): { levels: EncodedLevel[]; global: Uint8Array } {
  let best = encodeBasisLZOrder(fitted, dimensions, alpha, 0);
  const size = (candidate: typeof best): number => candidate.global.length +
    candidate.levels.reduce((n, level) => n + level.data.length, 0);
  let bytes = size(best);
  for (let order = 1; order <= 5; order++) {
    const candidate = encodeBasisLZOrder(fitted, dimensions, alpha, order), next = size(candidate);
    if (next < bytes) { best = candidate; bytes = next; }
  }
  return best;
}
function encodeBasisLZOrder(
  fitted: Uint8Array[],
  dimensions: [number, number][],
  alpha: boolean,
  endpointOrder: number,
): { levels: EncodedLevel[]; global: Uint8Array } {
  const endpoints: number[] = [],
    selectors: number[] = [],
    em = new Map<number, number>(),
    sm = new Map<number, number>(),
    slices: [number, number][][] = [];
  for (const data of fitted) {
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength),
      indices: [number, number][] = [];
    for (let at = 0; at < data.length; at += 8) {
      const e = view.getUint32(at, true),
        s = view.getUint32(at + 4, true);
      if (!em.has(e)) {
        em.set(e, endpoints.length);
        endpoints.push(e);
      }
      if (!sm.has(s)) {
        sm.set(s, selectors.length);
        selectors.push(s);
      }
      indices.push([em.get(e)!, sm.get(s)!]);
    }
    slices.push(indices);
  }
  if (endpoints.length > 16128 || selectors.length > 16128)
    throw new RangeError('BasisLZ shared codebook exceeds 16128 entries; reduce quality or split the image');
  // Relabel codebook indices without changing any reconstructed texel. Adjacent
  // selector rows then share high bytes, improving the format's XOR predictor.
  if (endpointOrder) {
    const oldEndpoints = endpoints.slice(),
      morton = (e: number): number => {
        let value = 0;
        for (let bit = 0; bit < 5; bit++)
          for (let c = 0; c < 3; c++) value |= ((e >>> (c * 8 + bit)) & 1) << (bit * 3 + c);
        return value;
      },
      key = (e: number): number => {
        const r = e & 255, g = (e >>> 8) & 255, b = (e >>> 16) & 255, table = e >>> 24;
        switch (endpointOrder) {
          case 1: return table * 32768 + morton(e);
          case 2: return morton(e) * 8 + table;
          case 3: return (r * 1024 + g * 32 + b) * 8 + table;
          case 4: return (g * 1024 + r * 32 + b) * 8 + table;
          default: return e;
        }
      };
    endpoints.sort((a, b) => key(a) - key(b));
    const order = new Map(endpoints.map((value, i) => [value, i]));
    for (const slice of slices) for (const pair of slice) pair[0] = order.get(oldEndpoints[pair[0]])!;
  }
  const oldSelectors = selectors.slice();
  selectors.sort((a, b) => a - b);
  const selectorOrder = new Map(selectors.map((value, i) => [value, i]));
  for (const slice of slices) for (const pair of slice) pair[1] = selectorOrder.get(oldSelectors[pair[1]])!;
  const previous = [16, 16, 16],
    deltas: number[][] = [[], [], []],
    intensities: number[] = [];
  let intensity = 0;
  for (const packed of endpoints) {
    const next = packed >>> 24;
    intensities.push((next - intensity) & 7);
    intensity = next;
    for (let c = 0; c < 3; c++) {
      const value = (packed >>> (c * 8)) & 255,
        was = previous[c];
      deltas[was <= 9 ? 0 : was <= 21 ? 1 : 2].push((value - was) & 31);
      previous[c] = value;
    }
  }
  const models = [...deltas.map((values) => new Huffman(values)), new Huffman(intensities)],
    eb = new Bits();
  for (const model of models) model.write(eb);
  eb.put(0, 1);
  previous.fill(16);
  intensity = 0;
  for (const packed of endpoints) {
    const next = packed >>> 24;
    models[3].symbol(eb, (next - intensity) & 7);
    intensity = next;
    for (let c = 0; c < 3; c++) {
      const value = (packed >>> (c * 8)) & 255,
        was = previous[c];
      models[was <= 9 ? 0 : was <= 21 ? 1 : 2].symbol(eb, (value - was) & 31);
      previous[c] = value;
    }
  }
  const sb = new Bits(),
    selectorDeltas: number[] = [],
    prev = [0, 0, 0, 0];
  for (let i = 1; i < selectors.length; i++)
    for (let c = 0; c < 4; c++)
      selectorDeltas.push(((selectors[i] >>> (c * 8)) ^ (selectors[i - 1] >>> (c * 8))) & 255);
  const selectorModel = new Huffman(selectorDeltas);
  sb.put(0, 1);
  sb.put(0, 1);
  sb.put(0, 1);
  selectorModel.write(sb);
  for (let i = 0; i < selectors.length; i++)
    for (let c = 0; c < 4; c++) {
      const value = (selectors[i] >>> (c * 8)) & 255;
      if (i) selectorModel.symbol(sb, value ^ prev[c]);
      else sb.put(value, 8);
      prev[c] = value;
    }
  const predictions: number[] = [],
    endpointDeltas: number[] = [],
    symbols: number[] = [],
    plans: [number, number][][] = [];
  slices.forEach((indices, i) => {
    const [width, height] = dimensions[i],
      bx = Math.ceil(width / 4),
      by = Math.ceil(height / 4),
      pred: number[] = [],
      history = new Array<number>(64).fill(-1),
      plan: [number, number][] = [];
    let rover = 32,
      last = 0;
    for (let y = 0; y < by; y++)
      for (let x = 0; x < bx; x++) {
        const t = y * bx + x,
          e = indices[t][0];
        pred[t] =
          x && indices[t - 1][0] === e
            ? 0
            : y && indices[t - bx][0] === e
              ? 1
              : x && y && indices[t - bx - 1][0] === e
                ? 2
                : 3;
      }
    for (let y = 0; y < by; y++)
      for (let x = 0; x < bx; x++) {
        const t = y * bx + x,
          [e, s] = indices[t];
        if (!(y & 1) && !(x & 1)) {
          let code = 0;
          for (let dy = 0; dy < 2; dy++)
            for (let dx = 0; dx < 2; dx++)
              if (y + dy < by && x + dx < bx) code |= pred[(y + dy) * bx + x + dx] << (dy * 4 + dx * 2);
          predictions.push(code);
          plan.push([0, code]);
        }
        if (pred[t] === 3) {
          const delta = (e - last + endpoints.length) % endpoints.length;
          endpointDeltas.push(delta);
          plan.push([1, delta]);
        }
        const seen = history.indexOf(s),
          symbol = seen < 0 ? s : selectors.length + seen;
        if (seen < 0) {
          history[rover++] = s;
          if (rover === 64) rover = 32;
        } else if (seen) {
          const near = seen >> 1;
          [history[near], history[seen]] = [history[seen], history[near]];
        }
        symbols.push(symbol);
        plan.push([2, symbol]);
        last = e;
      }
    plans.push(plan);
  });
  const tables = [new Huffman(predictions), new Huffman(endpointDeltas), new Huffman(symbols), new Huffman([0])],
    tb = new Bits();
  for (const table of tables) table.write(tb);
  tb.put(64, 13);
  const streams = plans.map((plan) => {
      const bits = new Bits();
      for (const [model, symbol] of plan) tables[model].symbol(bits, symbol);
      return bits.finish();
    }),
    e = eb.finish(),
    s = sb.finish(),
    t = tb.finish(),
    levels: EncodedLevel[] = [],
    imageCount = fitted.length / (alpha ? 2 : 1),
    global = new Uint8Array(20 + 20 * imageCount + e.length + s.length + t.length),
    view = new DataView(global.buffer);
  view.setUint16(0, endpoints.length, true);
  view.setUint16(2, selectors.length, true);
  u32(view, 4, e.length);
  u32(view, 8, s.length);
  u32(view, 12, t.length);
  for (let level = 0; level < imageCount; level++) {
    const color = streams[level * (alpha ? 2 : 1)],
      transparency = alpha ? streams[level * 2 + 1] : new Uint8Array(),
      data = new Uint8Array(color.length + transparency.length),
      at = 20 + level * 20;
    data.set(color);
    data.set(transparency, color.length);
    levels.push({ data });
    u32(view, at + 8, color.length);
    if (alpha) {
      u32(view, at + 12, color.length);
      u32(view, at + 16, transparency.length);
    }
  }
  let at = 20 + 20 * imageCount;
  for (const bytes of [e, s, t]) {
    global.set(bytes, at);
    at += bytes.length;
  }
  return { levels, global };
}
