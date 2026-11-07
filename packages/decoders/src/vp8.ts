// VP8 key frame decoder for lossy WebP, written from RFC 6386 sections 7 to 15 and 19 (the prose, never the reference
// source of section 20). A WebP file holds exactly one key frame, so inter prediction, motion vectors and reference
// frames are left out on purpose. The output is the three planes the bitstream defines; `webp.ts` turns them into RGBA.
import { decodeFailed, deviceUnsupported } from './errors.js';
import { AC_Q, COEFF_UPDATE_PROBS, DC_Q, DEFAULT_COEFF_PROBS, KF_BMODE_PROBS } from './vp8-tables.js';

/** The decoded planes of one key frame. Rows are `stride` bytes apart; pixel (0, 0) sits at `offset`. */
export interface VP8Frame {
  width: number;
  height: number;
  y: Uint8Array;
  u: Uint8Array;
  v: Uint8Array;
  yStride: number;
  yOffset: number;
  uvStride: number;
  uvOffset: number;
}

const corrupt = (problem: string): Error =>
  decodeFailed(`VP8 ${problem}; pass the complete bytes of a valid lossy WebP file`);

/** Section 7: the boolean entropy decoder. `value` holds 8 + `count` bits of the coded number, so no shift per bit. */
class BoolReader {
  private value = 0;
  private range = 255;
  private count = -8;
  /** Bytes read past the end of the partition; a decoder always runs up to two ahead of the data it needs. */
  over = 0;
  constructor(
    private readonly bytes: Uint8Array,
    private at: number,
    private readonly end: number,
  ) {}
  read(prob: number): number {
    if (this.count < 0) {
      let next = 0;
      if (this.at < this.end) next = this.bytes[this.at++];
      else this.over++;
      this.value = (this.value << 8) | next;
      this.count += 8;
    }
    const split = 1 + (((this.range - 1) * prob) >> 8),
      big = split << this.count;
    let bit: number, range: number;
    if (this.value >= big) {
      range = this.range - split;
      this.value -= big;
      bit = 1;
    } else {
      range = split;
      bit = 0;
    }
    const shift = Math.clz32(range) - 24;
    this.range = range << shift;
    this.count -= shift;
    return bit;
  }
  literal(bits: number): number {
    let v = 0;
    while (bits-- > 0) v = v * 2 + this.read(128);
    return v;
  }
  /** A magnitude of `bits` bits, then its sign. */
  signed(bits: number): number {
    const v = this.literal(bits);
    return this.read(128) ? -v : v;
  }
  /** A flag, then `signed(bits)` when it is set. */
  optional(bits: number): number {
    return this.read(128) ? this.signed(bits) : 0;
  }
  tree(tree: Int8Array, probs: ArrayLike<number>, base = 0): number {
    let i = 0;
    do i = tree[i + this.read(probs[base + (i >> 1)])];
    while (i > 0);
    return -i;
  }
}

// Macroblock luma modes (section 11.2).
const DC_PRED = 0,
  V_PRED = 1,
  H_PRED = 2,
  TM_PRED = 3,
  B_PRED = 4;
// Subblock modes (section 11.2).
const B_DC_PRED = 0,
  B_TM_PRED = 1,
  B_VE_PRED = 2,
  B_HE_PRED = 3,
  B_LD_PRED = 4,
  B_RD_PRED = 5,
  B_VR_PRED = 6,
  B_VL_PRED = 7,
  B_HD_PRED = 8,
  B_HU_PRED = 9;

const YMODE_TREE = Int8Array.of(-B_PRED, 2, 4, 6, -DC_PRED, -V_PRED, -H_PRED, -TM_PRED),
  YMODE_PROBS = [145, 156, 163, 128],
  UVMODE_TREE = Int8Array.of(-DC_PRED, 2, -V_PRED, 4, -H_PRED, -TM_PRED),
  UVMODE_PROBS = [142, 114, 183],
  BMODE_TREE = Int8Array.of(
    ...[-B_DC_PRED, 2, -B_TM_PRED, 4, -B_VE_PRED, 6, 8, 12, -B_HE_PRED, 10, -B_RD_PRED, -B_VR_PRED],
    ...[-B_LD_PRED, 14, -B_VL_PRED, 16, -B_HD_PRED, -B_HU_PRED],
  ),
  SEGMENT_TREE = Int8Array.of(2, 4, -0, -1, -2, -3),
  // The subblock mode each whole-macroblock mode stands for in the contexts of its neighbours (section 11.3).
  MODE_CONTEXT = [B_DC_PRED, B_VE_PRED, B_HE_PRED, B_TM_PRED];

const BANDS = [0, 1, 2, 3, 6, 4, 5, 6, 6, 6, 6, 6, 6, 6, 6, 7],
  ZIGZAG = [0, 1, 4, 8, 5, 2, 3, 6, 9, 12, 13, 10, 7, 11, 14, 15],
  CATEGORY_PROBS = [
    [173, 148, 140],
    [176, 155, 140, 135],
    [180, 157, 141, 134, 130],
    [254, 254, 243, 230, 196, 177, 153, 140, 133, 130, 129],
  ];

/** One plane's dequantization factors, [Y DC, Y AC, Y2 DC, Y2 AC, UV DC, UV AC]. */
type Factors = readonly [number, number, number, number, number, number];

const clampQ = (q: number): number => (q < 0 ? 0 : q > 127 ? 127 : q);
const clamp255 = (v: number): number => (v < 0 ? 0 : v > 255 ? 255 : v);

/** Section 13: reads the tokens of one block into `out[at..at + 16]`, dequantized. Returns the position after the last. */
function readBlock(
  r: BoolReader,
  probs: Uint8Array,
  type: number,
  context: number,
  first: number,
  dc: number,
  ac: number,
  out: Int16Array,
  at: number,
): number {
  const plane = type * 264;
  let i = first,
    p = plane + BANDS[i] * 33 + context * 11;
  if (!r.read(probs[p])) return first;
  for (;;) {
    while (!r.read(probs[p + 1])) {
      if (++i === 16) return 16;
      p = plane + BANDS[i] * 33;
    }
    let v: number, next: number;
    if (!r.read(probs[p + 2])) {
      v = 1;
      next = 1;
    } else {
      next = 2;
      if (!r.read(probs[p + 3])) v = !r.read(probs[p + 4]) ? 2 : 3 + r.read(probs[p + 5]);
      else if (!r.read(probs[p + 6])) {
        if (!r.read(probs[p + 7])) v = 5 + r.read(159);
        else {
          v = 7 + 2 * r.read(165);
          v += r.read(145);
        }
      } else {
        const high = r.read(probs[p + 8]),
          category = 2 * high + r.read(probs[p + 9 + high]),
          table = CATEGORY_PROBS[category];
        v = 0;
        for (let k = 0; k < table.length; k++) v = v * 2 + r.read(table[k]);
        v += 3 + (8 << category);
      }
    }
    if (r.read(128)) v = -v;
    out[at + ZIGZAG[i]] = v * (i === 0 ? dc : ac);
    if (++i === 16) return 16;
    p = plane + BANDS[i] * 33 + next * 11;
    if (!r.read(probs[p])) return i;
  }
}

/** Section 14.3: the inverse WHT of `c[at..]`; result (i, j) becomes the DC of luma block i * 4 + j. */
function inverseWHT(c: Int16Array, at: number, blocks: Int16Array): void {
  const t = new Int32Array(16);
  for (let i = 0; i < 4; i++) {
    const a = c[at + i] + c[at + 12 + i],
      b = c[at + 4 + i] + c[at + 8 + i],
      d = c[at + 4 + i] - c[at + 8 + i],
      e = c[at + i] - c[at + 12 + i];
    t[i] = a + b;
    t[4 + i] = d + e;
    t[8 + i] = a - b;
    t[12 + i] = e - d;
  }
  for (let i = 0; i < 4; i++) {
    const row = i * 4,
      a = t[row] + t[row + 3],
      b = t[row + 1] + t[row + 2],
      d = t[row + 1] - t[row + 2],
      e = t[row] - t[row + 3];
    blocks[(row + 0) * 16] = (a + b + 3) >> 3;
    blocks[(row + 1) * 16] = (d + e + 3) >> 3;
    blocks[(row + 2) * 16] = (a - b + 3) >> 3;
    blocks[(row + 3) * 16] = (e - d + 3) >> 3;
  }
}

const COS = 20091,
  SIN = 35468,
  idct = new Int32Array(16);

/** Section 14.4 and 14.5: the inverse DCT of `c[at..]`, added to the prediction already in `plane`. */
function addResidue(c: Int16Array, at: number, plane: Uint8Array, to: number, stride: number): void {
  for (let i = 0; i < 4; i++) {
    const i0 = c[at + i],
      i4 = c[at + 4 + i],
      i8 = c[at + 8 + i],
      i12 = c[at + 12 + i],
      a = i0 + i8,
      b = i0 - i8,
      d = ((i4 * SIN) >> 16) - (i12 + ((i12 * COS) >> 16)),
      e = i4 + ((i4 * COS) >> 16) + ((i12 * SIN) >> 16);
    idct[i] = a + e;
    idct[12 + i] = a - e;
    idct[4 + i] = b + d;
    idct[8 + i] = b - d;
  }
  for (let i = 0; i < 4; i++) {
    const row = i * 4,
      i0 = idct[row],
      i1 = idct[row + 1],
      i2 = idct[row + 2],
      i3 = idct[row + 3],
      a = i0 + i2,
      b = i0 - i2,
      d = ((i1 * SIN) >> 16) - (i3 + ((i3 * COS) >> 16)),
      e = i1 + ((i1 * COS) >> 16) + ((i3 * SIN) >> 16),
      o = to + i * stride;
    plane[o] = clamp255(plane[o] + ((a + e + 4) >> 3));
    plane[o + 3] = clamp255(plane[o + 3] + ((a - e + 4) >> 3));
    plane[o + 1] = clamp255(plane[o + 1] + ((b + d + 4) >> 3));
    plane[o + 2] = clamp255(plane[o + 2] + ((b - d + 4) >> 3));
  }
}

/** Sections 12.2 and 12.3: whole-block prediction of `size` x `size` pixels at `at`. */
function predictBlock(
  plane: Uint8Array,
  at: number,
  stride: number,
  size: number,
  mode: number,
  hasAbove: boolean,
  hasLeft: boolean,
): void {
  const above = at - stride;
  if (mode === DC_PRED) {
    let sum = 0,
      shift = size === 16 ? 3 : 2;
    if (hasAbove) for (let i = 0; i < size; i++) sum += plane[above + i];
    if (hasLeft) for (let i = 0; i < size; i++) sum += plane[at + i * stride - 1];
    shift += (hasAbove ? 1 : 0) + (hasLeft ? 1 : 0);
    const value = hasAbove || hasLeft ? (sum + (1 << (shift - 1))) >> shift : 128;
    for (let y = 0; y < size; y++) plane.fill(value, at + y * stride, at + y * stride + size);
  } else if (mode === V_PRED) {
    for (let y = 0; y < size; y++) plane.copyWithin(at + y * stride, above, above + size);
  } else if (mode === H_PRED) {
    for (let y = 0; y < size; y++) {
      const row = at + y * stride;
      plane.fill(plane[row - 1], row, row + size);
    }
  } else {
    const corner = plane[above - 1];
    for (let y = 0; y < size; y++) {
      const row = at + y * stride,
        base = plane[row - 1] - corner;
      for (let x = 0; x < size; x++) plane[row + x] = clamp255(base + plane[above + x]);
    }
  }
}

const avg2 = (x: number, y: number): number => (x + y + 1) >> 1;
const avg3 = (x: number, y: number, z: number): number => (x + y + y + z + 2) >> 2;

/**
 * Section 12.3: predicts one 4x4 subblock from `e`, the 13 edge pixels in the RFC's order: e[0..3] the left column
 * from the bottom up, e[4] the corner, e[5..12] the above row and the four above and to the right.
 */
function predictSubblock(plane: Uint8Array, at: number, stride: number, mode: number, e: Uint8Array): void {
  const s = stride,
    r0 = at,
    r1 = at + s,
    r2 = at + 2 * s,
    r3 = at + 3 * s,
    a3 = (i: number): number => avg3(e[i - 1], e[i], e[i + 1]),
    a2 = (i: number): number => avg2(e[i], e[i + 1]);
  switch (mode) {
    case B_DC_PRED: {
      let v = 4;
      for (let i = 0; i < 4; i++) v += e[5 + i] + e[i];
      v >>= 3;
      for (let y = 0; y < 4; y++) plane.fill(v, at + y * s, at + y * s + 4);
      break;
    }
    case B_TM_PRED:
      for (let y = 0; y < 4; y++)
        for (let x = 0; x < 4; x++) plane[at + y * s + x] = clamp255(e[3 - y] + e[5 + x] - e[4]);
      break;
    case B_VE_PRED:
      for (let x = 0; x < 4; x++) plane[r0 + x] = plane[r1 + x] = plane[r2 + x] = plane[r3 + x] = a3(5 + x);
      break;
    case B_HE_PRED: {
      plane.fill(avg3(e[4], e[3], e[2]), r0, r0 + 4);
      plane.fill(avg3(e[3], e[2], e[1]), r1, r1 + 4);
      plane.fill(avg3(e[2], e[1], e[0]), r2, r2 + 4);
      plane.fill(avg3(e[1], e[0], e[0]), r3, r3 + 4);
      break;
    }
    case B_LD_PRED:
      plane[r0] = a3(6);
      plane[r0 + 1] = plane[r1] = a3(7);
      plane[r0 + 2] = plane[r1 + 1] = plane[r2] = a3(8);
      plane[r0 + 3] = plane[r1 + 2] = plane[r2 + 1] = plane[r3] = a3(9);
      plane[r1 + 3] = plane[r2 + 2] = plane[r3 + 1] = a3(10);
      plane[r2 + 3] = plane[r3 + 2] = a3(11);
      plane[r3 + 3] = avg3(e[11], e[12], e[12]);
      break;
    case B_RD_PRED:
      plane[r3] = a3(1);
      plane[r3 + 1] = plane[r2] = a3(2);
      plane[r3 + 2] = plane[r2 + 1] = plane[r1] = a3(3);
      plane[r3 + 3] = plane[r2 + 2] = plane[r1 + 1] = plane[r0] = a3(4);
      plane[r2 + 3] = plane[r1 + 2] = plane[r0 + 1] = a3(5);
      plane[r1 + 3] = plane[r0 + 2] = a3(6);
      plane[r0 + 3] = a3(7);
      break;
    case B_VR_PRED:
      plane[r3] = a3(2);
      plane[r2] = a3(3);
      plane[r3 + 1] = plane[r1] = a3(4);
      plane[r2 + 1] = plane[r0] = a2(4);
      plane[r3 + 2] = plane[r1 + 1] = a3(5);
      plane[r2 + 2] = plane[r0 + 1] = a2(5);
      plane[r3 + 3] = plane[r1 + 2] = a3(6);
      plane[r2 + 3] = plane[r0 + 2] = a2(6);
      plane[r1 + 3] = a3(7);
      plane[r0 + 3] = a2(7);
      break;
    case B_VL_PRED:
      plane[r0] = a2(5);
      plane[r1] = a3(6);
      plane[r2] = plane[r0 + 1] = a2(6);
      plane[r1 + 1] = plane[r3] = a3(7);
      plane[r2 + 1] = plane[r0 + 2] = a2(7);
      plane[r3 + 1] = plane[r1 + 2] = a3(8);
      plane[r2 + 2] = plane[r0 + 3] = a2(8);
      plane[r3 + 2] = plane[r1 + 3] = a3(9);
      plane[r2 + 3] = a3(10);
      plane[r3 + 3] = a3(11);
      break;
    case B_HD_PRED:
      plane[r3] = a2(0);
      plane[r3 + 1] = a3(1);
      plane[r2] = plane[r3 + 2] = a2(1);
      plane[r2 + 1] = plane[r3 + 3] = a3(2);
      plane[r2 + 2] = plane[r1] = a2(2);
      plane[r2 + 3] = plane[r1 + 1] = a3(3);
      plane[r1 + 2] = plane[r0] = a2(3);
      plane[r1 + 3] = plane[r0 + 1] = a3(4);
      plane[r0 + 2] = a3(5);
      plane[r0 + 3] = a3(6);
      break;
    default: {
      // B_HU_PRED, the last mode; L[i] is e[3 - i].
      const l0 = e[3],
        l1 = e[2],
        l2 = e[1],
        l3 = e[0];
      plane[r0] = avg2(l0, l1);
      plane[r0 + 1] = avg3(l0, l1, l2);
      plane[r0 + 2] = plane[r1] = avg2(l1, l2);
      plane[r0 + 3] = plane[r1 + 1] = avg3(l1, l2, l3);
      plane[r1 + 2] = plane[r2] = avg2(l2, l3);
      plane[r1 + 3] = plane[r2 + 1] = avg3(l2, l3, l3);
      plane[r2 + 2] = plane[r2 + 3] = plane[r3] = plane[r3 + 1] = plane[r3 + 2] = plane[r3 + 3] = l3;
    }
  }
}

const s8 = (v: number): number => (v < -128 ? -128 : v > 127 ? 127 : v);

/** Section 15.2: the adjustment shared by every filter. `i` is the first pixel after the edge. */
function commonAdjust(outer: boolean, p: Uint8Array, i: number, step: number): number {
  const p1 = p[i - 2 * step] - 128,
    p0 = p[i - step] - 128,
    q0 = p[i] - 128,
    q1 = p[i + step] - 128,
    a = s8((outer ? s8(p1 - q1) : 0) + 3 * (q0 - p0)),
    b = s8(a + 3) >> 3,
    c = s8(a + 4) >> 3;
  p[i] = s8(q0 - c) + 128;
  p[i - step] = s8(p0 + b) + 128;
  return c;
}

const edgeWithin = (p: Uint8Array, i: number, step: number, limit: number): boolean =>
  Math.abs(p[i - step] - p[i]) * 2 + (Math.abs(p[i - 2 * step] - p[i + step]) >> 1) <= limit;

/** Section 15.2: the simple filter over `count` segments of an edge. */
function simpleEdge(p: Uint8Array, i: number, step: number, along: number, count: number, limit: number): void {
  for (let n = 0; n < count; n++, i += along) if (edgeWithin(p, i, step, limit)) commonAdjust(true, p, i, step);
}

const filterYes = (p: Uint8Array, i: number, s: number, interior: number, edge: number): boolean =>
  edgeWithin(p, i, s, edge) &&
  Math.abs(p[i - 4 * s] - p[i - 3 * s]) <= interior &&
  Math.abs(p[i - 3 * s] - p[i - 2 * s]) <= interior &&
  Math.abs(p[i - 2 * s] - p[i - s]) <= interior &&
  Math.abs(p[i + 3 * s] - p[i + 2 * s]) <= interior &&
  Math.abs(p[i + 2 * s] - p[i + s]) <= interior &&
  Math.abs(p[i + s] - p[i]) <= interior;

const highVariance = (p: Uint8Array, i: number, s: number, threshold: number): boolean =>
  Math.abs(p[i - 2 * s] - p[i - s]) > threshold || Math.abs(p[i + s] - p[i]) > threshold;

/** Section 15.3: the normal filter of an edge between subblocks. */
function subblockEdge(
  p: Uint8Array,
  i: number,
  s: number,
  along: number,
  count: number,
  hevLimit: number,
  interior: number,
  edge: number,
): void {
  for (let n = 0; n < count; n++, i += along) {
    if (!filterYes(p, i, s, interior, edge)) continue;
    const high = highVariance(p, i, s, hevLimit),
      q1 = p[i + s] - 128,
      p1 = p[i - 2 * s] - 128,
      a = (commonAdjust(high, p, i, s) + 1) >> 1;
    if (!high) {
      p[i + s] = s8(q1 - a) + 128;
      p[i - 2 * s] = s8(p1 + a) + 128;
    }
  }
}

/** Section 15.3: the normal filter of an edge between macroblocks. */
function macroblockEdge(
  p: Uint8Array,
  i: number,
  s: number,
  along: number,
  count: number,
  hevLimit: number,
  interior: number,
  edge: number,
): void {
  for (let n = 0; n < count; n++, i += along) {
    if (!filterYes(p, i, s, interior, edge)) continue;
    if (highVariance(p, i, s, hevLimit)) {
      commonAdjust(true, p, i, s);
      continue;
    }
    const p2 = p[i - 3 * s] - 128,
      p1 = p[i - 2 * s] - 128,
      p0 = p[i - s] - 128,
      q0 = p[i] - 128,
      q1 = p[i + s] - 128,
      q2 = p[i + 2 * s] - 128,
      w = s8(s8(p1 - q1) + 3 * (q0 - p0));
    let a = s8((27 * w + 63) >> 7);
    p[i] = s8(q0 - a) + 128;
    p[i - s] = s8(p0 + a) + 128;
    a = s8((18 * w + 63) >> 7);
    p[i + s] = s8(q1 - a) + 128;
    p[i - 2 * s] = s8(p1 + a) + 128;
    a = s8((9 * w + 63) >> 7);
    p[i + 2 * s] = s8(q2 - a) + 128;
    p[i - 3 * s] = s8(p2 + a) + 128;
  }
}

/** Reads the 10-byte key frame start (section 9.1) without decoding: the frame's size, or throws. */
export function vp8Size(bytes: Uint8Array, start: number, end: number): { width: number; height: number } {
  if (end - start < 10) throw corrupt('frame is shorter than its header');
  if (bytes[start] & 1) throw deviceUnsupported('VP8 interframes are not WebP; pass a file holding one key frame');
  if (bytes[start + 3] !== 0x9d || bytes[start + 4] !== 0x01 || bytes[start + 5] !== 0x2a)
    throw corrupt('frame lacks its start code');
  return {
    width: (bytes[start + 6] | (bytes[start + 7] << 8)) & 0x3fff,
    height: (bytes[start + 8] | (bytes[start + 9] << 8)) & 0x3fff,
  };
}

/**
 * Decodes the key frame in `bytes[start..end]`.
 * @throws MargoError `failed` when the data is damaged; `unsupported` for an interframe.
 */
export function decodeVP8(bytes: Uint8Array, start: number, end: number): VP8Frame {
  const { width, height } = vp8Size(bytes, start, end);
  if (!width || !height) throw corrupt('frame has no pixels');
  const tag = bytes[start] | (bytes[start + 1] << 8) | (bytes[start + 2] << 16);
  if (((tag >> 1) & 7) > 3) throw corrupt('frame names an unknown version');
  const firstSize = tag >>> 5,
    firstAt = start + 10,
    firstEnd = firstAt + firstSize;
  if (firstEnd > end) throw corrupt('first partition runs past the end of the data');
  const r = new BoolReader(bytes, firstAt, firstEnd);

  // Frame header, section 19.2.
  r.read(128); // color_space: BT.601 is the only one WebP names
  r.read(128); // clamping_type: clamping is harmless when the encoder promises it is not needed
  const segmentation = r.read(128) === 1,
    segmentQ = [0, 0, 0, 0],
    segmentFilter = [0, 0, 0, 0],
    segmentProbs = [255, 255, 255];
  let updateMap = false,
    absolute = false;
  if (segmentation) {
    updateMap = r.read(128) === 1;
    if (r.read(128)) {
      absolute = r.read(128) === 1;
      for (let i = 0; i < 4; i++) segmentQ[i] = r.optional(7);
      for (let i = 0; i < 4; i++) segmentFilter[i] = r.optional(6);
    }
    if (updateMap) for (let i = 0; i < 3; i++) segmentProbs[i] = r.read(128) ? r.literal(8) : 255;
  }
  const simple = r.read(128) === 1,
    frameLevel = r.literal(6),
    sharpness = r.literal(3),
    deltaEnabled = r.read(128) === 1,
    refDeltas = [0, 0, 0, 0],
    modeDeltas = [0, 0, 0, 0];
  if (deltaEnabled && r.read(128)) {
    for (let i = 0; i < 4; i++) if (r.read(128)) refDeltas[i] = r.signed(6);
    for (let i = 0; i < 4; i++) if (r.read(128)) modeDeltas[i] = r.signed(6);
  }
  const partitions = 1 << r.literal(2),
    baseQ = r.literal(7),
    yDcDelta = r.optional(4),
    y2DcDelta = r.optional(4),
    y2AcDelta = r.optional(4),
    uvDcDelta = r.optional(4),
    uvAcDelta = r.optional(4);
  r.read(128); // refresh_entropy_probs: nothing follows a single frame
  const probs = DEFAULT_COEFF_PROBS.slice();
  for (let i = 0; i < 1056; i++) if (r.read(COEFF_UPDATE_PROBS[i])) probs[i] = r.literal(8);
  const skipEnabled = r.read(128) === 1,
    skipProb = skipEnabled ? r.literal(8) : 0;

  // Token partitions, section 9.5.
  const sizesAt = firstEnd,
    readers: BoolReader[] = [];
  let at = sizesAt + 3 * (partitions - 1);
  if (at > end) throw corrupt('partition sizes run past the end of the data');
  for (let i = 0; i < partitions; i++) {
    const s = sizesAt + i * 3,
      next = i === partitions - 1 ? end : at + (bytes[s] | (bytes[s + 1] << 8) | (bytes[s + 2] << 16));
    if (next > end) throw corrupt('token partition runs past the end of the data');
    readers.push(new BoolReader(bytes, at, next));
    at = next;
  }

  // Six factors per segment, section 14.1. Y2 AC and UV DC are scaled and clamped the way the format defines them.
  const factors: Factors[] = [];
  for (let s = 0; s < 4; s++) {
    const q = clampQ(segmentation ? (absolute ? segmentQ[s] : baseQ + segmentQ[s]) : baseQ);
    factors.push([
      DC_Q[clampQ(q + yDcDelta)],
      AC_Q[q],
      DC_Q[clampQ(q + y2DcDelta)] * 2,
      Math.max(8, Math.trunc((AC_Q[clampQ(q + y2AcDelta)] * 155) / 100)),
      Math.min(132, DC_Q[clampQ(q + uvDcDelta)]),
      AC_Q[clampQ(q + uvAcDelta)],
    ]);
  }

  // Planes hold one row above and a left margin: the out-of-frame pixels of section 12 live in the buffer.
  const mbWidth = (width + 15) >> 4,
    mbHeight = (height + 15) >> 4,
    yStride = mbWidth * 16 + 32,
    uvStride = mbWidth * 8 + 32,
    yOffset = yStride + 16,
    uvOffset = uvStride + 16,
    y = new Uint8Array(yStride * (mbHeight * 16 + 1)),
    u = new Uint8Array(uvStride * (mbHeight * 8 + 1)),
    v = new Uint8Array(uvStride * (mbHeight * 8 + 1));
  y.fill(127, 0, yStride);
  u.fill(127, 0, uvStride);
  v.fill(127, 0, uvStride);
  for (let row = 0; row < mbHeight * 16; row++) y[yOffset + row * yStride - 1] = 129;
  for (let row = 0; row < mbHeight * 8; row++) u[uvOffset + row * uvStride - 1] = v[uvOffset + row * uvStride - 1] = 129;

  const aboveModes = new Uint8Array(mbWidth * 4),
    leftModes = new Uint8Array(4),
    subModes = new Uint8Array(16),
    aboveNonZero = new Uint8Array(mbWidth * 9),
    leftNonZero = new Uint8Array(9),
    levels = new Uint8Array(mbWidth * mbHeight),
    inner = new Uint8Array(mbWidth * mbHeight),
    coefficients = new Int16Array(25 * 16),
    edge = new Uint8Array(13);

  for (let mbY = 0; mbY < mbHeight; mbY++) {
    const tokens = readers[mbY & (partitions - 1)];
    leftModes.fill(0);
    leftNonZero.fill(0);
    for (let mbX = 0; mbX < mbWidth; mbX++) {
      // Macroblock header, section 19.3.
      const segment = updateMap ? r.tree(SEGMENT_TREE, segmentProbs) : 0,
        skip = skipEnabled ? r.read(skipProb) === 1 : false,
        yMode = r.tree(YMODE_TREE, YMODE_PROBS),
        above4 = mbX * 4;
      if (yMode === B_PRED) {
        for (let b = 0; b < 16; b++) {
          const column = b & 3,
            a = aboveModes[above4 + column],
            l = leftModes[b >> 2],
            mode = r.tree(BMODE_TREE, KF_BMODE_PROBS, (a * 10 + l) * 9);
          subModes[b] = mode;
          aboveModes[above4 + column] = mode;
          leftModes[b >> 2] = mode;
        }
      } else {
        const mode = MODE_CONTEXT[yMode];
        aboveModes.fill(mode, above4, above4 + 4);
        leftModes.fill(mode);
      }
      const uvMode = r.tree(UVMODE_TREE, UVMODE_PROBS),
        f = factors[segment],
        hasY2 = yMode !== B_PRED,
        above9 = mbX * 9;

      // Residue, section 13. The context of a block is its neighbours' state: [4 Y, 2 U, 2 V, Y2].
      let coded = false;
      if (skip) {
        aboveNonZero.fill(0, above9, above9 + 8);
        leftNonZero.fill(0, 0, 8);
        if (hasY2) aboveNonZero[above9 + 8] = leftNonZero[8] = 0;
      } else {
        coefficients.fill(0);
        let first = 0,
          type = 3;
        if (hasY2) {
          const eob = readBlock(
            tokens,
            probs,
            1,
            aboveNonZero[above9 + 8] + leftNonZero[8],
            0,
            f[2],
            f[3],
            coefficients,
            384,
          );
          aboveNonZero[above9 + 8] = leftNonZero[8] = eob > 0 ? 1 : 0;
          if (eob > 0) {
            coded = true;
            inverseWHT(coefficients, 384, coefficients);
          }
          first = 1;
          type = 0;
        }
        for (let b = 0; b < 16; b++) {
          const column = b & 3,
            row = b >> 2,
            eob = readBlock(
              tokens,
              probs,
              type,
              aboveNonZero[above9 + column] + leftNonZero[row],
              first,
              f[0],
              f[1],
              coefficients,
              b * 16,
            ),
            non = eob > first ? 1 : 0;
          aboveNonZero[above9 + column] = leftNonZero[row] = non;
          if (non) coded = true;
        }
        for (let plane = 0; plane < 2; plane++)
          for (let b = 0; b < 4; b++) {
            const column = 4 + plane * 2 + (b & 1),
              row = 4 + plane * 2 + (b >> 1),
              eob = readBlock(
                tokens,
                probs,
                2,
                aboveNonZero[above9 + column] + leftNonZero[row],
                0,
                f[4],
                f[5],
                coefficients,
                (16 + plane * 4 + b) * 16,
              ),
              non = eob > 0 ? 1 : 0;
            aboveNonZero[above9 + column] = leftNonZero[row] = non;
            if (non) coded = true;
          }
      }

      // Loop filter level of this macroblock (sections 9.3, 9.4), applied after the whole frame is rebuilt.
      const index = mbY * mbWidth + mbX;
      let level = segmentation ? (absolute ? segmentFilter[segment] : frameLevel + segmentFilter[segment]) : frameLevel;
      level = level < 0 ? 0 : level > 63 ? 63 : level;
      if (deltaEnabled) {
        level += refDeltas[0];
        if (yMode === B_PRED) level += modeDeltas[0];
        level = level < 0 ? 0 : level > 63 ? 63 : level;
      }
      levels[index] = level;
      inner[index] = coded || yMode === B_PRED ? 1 : 0;

      // Prediction and reconstruction, sections 12 and 14.
      const yAt = yOffset + mbY * 16 * yStride + mbX * 16,
        uvAt = uvOffset + mbY * 8 * uvStride + mbX * 8;
      if (yMode === B_PRED) {
        // The four pixels above and to the right of the macroblock, shared by subblocks 3, 7, 11 and 15.
        const rightAbove = yAt - yStride + 16,
          last = mbX === mbWidth - 1 && mbY > 0,
          r0 = last ? y[rightAbove - 1] : y[rightAbove],
          r1 = last ? r0 : y[rightAbove + 1],
          r2 = last ? r0 : y[rightAbove + 2],
          r3 = last ? r0 : y[rightAbove + 3];
        for (let b = 0; b < 16; b++) {
          const to = yAt + (b >> 2) * 4 * yStride + (b & 3) * 4,
            above = to - yStride;
          edge[0] = y[to + 3 * yStride - 1];
          edge[1] = y[to + 2 * yStride - 1];
          edge[2] = y[to + yStride - 1];
          edge[3] = y[to - 1];
          edge[4] = y[above - 1];
          for (let i = 0; i < 4; i++) edge[5 + i] = y[above + i];
          if ((b & 3) === 3) {
            edge[9] = r0;
            edge[10] = r1;
            edge[11] = r2;
            edge[12] = r3;
          } else for (let i = 4; i < 8; i++) edge[5 + i] = y[above + i];
          predictSubblock(y, to, yStride, subModes[b], edge);
          if (!skip) addResidue(coefficients, b * 16, y, to, yStride);
        }
      } else {
        predictBlock(y, yAt, yStride, 16, yMode, mbY > 0, mbX > 0);
        if (!skip)
          for (let b = 0; b < 16; b++)
            addResidue(coefficients, b * 16, y, yAt + (b >> 2) * 4 * yStride + (b & 3) * 4, yStride);
      }
      predictBlock(u, uvAt, uvStride, 8, uvMode, mbY > 0, mbX > 0);
      predictBlock(v, uvAt, uvStride, 8, uvMode, mbY > 0, mbX > 0);
      if (!skip)
        for (let b = 0; b < 4; b++) {
          const to = uvAt + (b >> 1) * 4 * uvStride + (b & 1) * 4;
          addResidue(coefficients, (16 + b) * 16, u, to, uvStride);
          addResidue(coefficients, (20 + b) * 16, v, to, uvStride);
        }
    }
    if (r.over > 2 || tokens.over > 2) throw corrupt('data ends before the last macroblock');
  }

  // Loop filter, section 15: the whole frame, macroblocks in raster order.
  if (frameLevel > 0)
    for (let mbY = 0; mbY < mbHeight; mbY++)
      for (let mbX = 0; mbX < mbWidth; mbX++) {
        const index = mbY * mbWidth + mbX,
          level = levels[index];
        if (level === 0) continue;
        let interior = level;
        if (sharpness) {
          interior >>= sharpness > 4 ? 2 : 1;
          if (interior > 9 - sharpness) interior = 9 - sharpness;
        }
        if (!interior) interior = 1;
        const hev = level >= 40 ? 2 : level >= 15 ? 1 : 0,
          mbLimit = (level + 2) * 2 + interior,
          subLimit = level * 2 + interior,
          withInner = inner[index] === 1,
          yAt = yOffset + mbY * 16 * yStride + mbX * 16,
          uvAt = uvOffset + mbY * 8 * uvStride + mbX * 8;
        if (simple) {
          if (mbX > 0) simpleEdge(y, yAt, 1, yStride, 16, mbLimit);
          if (withInner) for (let x = 4; x < 16; x += 4) simpleEdge(y, yAt + x, 1, yStride, 16, subLimit);
          if (mbY > 0) simpleEdge(y, yAt, yStride, 1, 16, mbLimit);
          if (withInner) for (let r4 = 4; r4 < 16; r4 += 4) simpleEdge(y, yAt + r4 * yStride, yStride, 1, 16, subLimit);
          continue;
        }
        if (mbX > 0) {
          macroblockEdge(y, yAt, 1, yStride, 16, hev, interior, mbLimit);
          macroblockEdge(u, uvAt, 1, uvStride, 8, hev, interior, mbLimit);
          macroblockEdge(v, uvAt, 1, uvStride, 8, hev, interior, mbLimit);
        }
        if (withInner) {
          for (let x = 4; x < 16; x += 4) subblockEdge(y, yAt + x, 1, yStride, 16, hev, interior, subLimit);
          subblockEdge(u, uvAt + 4, 1, uvStride, 8, hev, interior, subLimit);
          subblockEdge(v, uvAt + 4, 1, uvStride, 8, hev, interior, subLimit);
        }
        if (mbY > 0) {
          macroblockEdge(y, yAt, yStride, 1, 16, hev, interior, mbLimit);
          macroblockEdge(u, uvAt, uvStride, 1, 8, hev, interior, mbLimit);
          macroblockEdge(v, uvAt, uvStride, 1, 8, hev, interior, mbLimit);
        }
        if (withInner) {
          for (let r4 = 4; r4 < 16; r4 += 4)
            subblockEdge(y, yAt + r4 * yStride, yStride, 1, 16, hev, interior, subLimit);
          subblockEdge(u, uvAt + 4 * uvStride, uvStride, 1, 8, hev, interior, subLimit);
          subblockEdge(v, uvAt + 4 * uvStride, uvStride, 1, 8, hev, interior, subLimit);
        }
      }
  return { width, height, y, u, v, yStride, yOffset, uvStride, uvOffset };
}
