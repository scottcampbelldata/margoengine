// BC1 to BC7 block decoding on the CPU (`@margoengine/decoders/bc`), written from the Khronos Data Format Specification 1.3
// (sections 18 to 20, S3TC, RGTC and BPTC). A GPU samples these blocks directly; this is for tools that need the pixels,
// such as exporters writing a PNG. BC4 fills red and BC5 red and green, with blue 0 and alpha 255. Signed BC4 and BC5 map
// -1..1 to 0..255, as a normal map in an unsigned image does, so their missing channels are 128. BC6H is linear light,
// so it is clamped to 0..1 and sRGB encoded.
import { ANCHOR_2, ANCHOR_3_SECOND, ANCHOR_3_THIRD, PARTITIONS_2, PARTITIONS_3 } from './bc-tables.js';
import { decodeFailed } from './errors.js';

/** RGBA8 pixels, rows top first. */
export interface BCImage {
  width: number;
  height: number;
  data: Uint8Array;
}

type Block = (src: Uint8Array, at: number, out: Uint8Array | Float32Array) => void;

/** A signed value of -127..127 as an unsigned byte, -1 at 0 and 1 at 255. */
export const signedByte = (v: number): number => Math.round(((Math.max(v, -127) + 127) / 254) * 255);

const r5 = (v: number): number => (v << 3) | (v >> 2);
const r6 = (v: number): number => (v << 2) | (v >> 4);

/** The colour half of BC1, BC2 and BC3: two 565 endpoints and 2-bit indices. */
function colorBlock(src: Uint8Array, at: number, out: Uint8Array | Float32Array, punchThrough: boolean): void {
  const c0 = src[at] | (src[at + 1] << 8),
    c1 = src[at + 2] | (src[at + 3] << 8),
    p = [r5(c0 >> 11), r6((c0 >> 5) & 63), r5(c0 & 31), 255, r5(c1 >> 11), r6((c1 >> 5) & 63), r5(c1 & 31), 255];
  const four = !punchThrough || c0 > c1;
  for (let c = 0; c < 3; c++) {
    const a = p[c],
      b = p[4 + c];
    if (four) {
      p[8 + c] = Math.round((2 * a + b) / 3);
      p[12 + c] = Math.round((a + 2 * b) / 3);
    } else {
      p[8 + c] = (a + b + 1) >> 1;
      p[12 + c] = 0;
    }
  }
  p[11] = 255;
  p[15] = four ? 255 : 0;
  for (let i = 0; i < 16; i++) {
    const index = ((src[at + 4 + (i >> 2)] >> ((i & 3) * 2)) & 3) * 4;
    out[i * 4] = p[index];
    out[i * 4 + 1] = p[index + 1];
    out[i * 4 + 2] = p[index + 2];
    out[i * 4 + 3] = p[index + 3];
  }
}

/** The 8-value ramp of a BC3 alpha, BC4 or BC5 half block, into `channel` of `out`. */
function rampBlock(
  src: Uint8Array,
  at: number,
  out: Uint8Array | Float32Array,
  channel: number,
  signed: boolean,
): void {
  const low = (v: number): number => (signed ? Math.max((v << 24) >> 24, -127) : v),
    a = low(src[at]),
    b = low(src[at + 1]),
    ramp = [a, b, 0, 0, 0, 0, 0, 0],
    max = signed ? 127 : 255,
    min = signed ? -127 : 0;
  if (a > b) for (let i = 1; i < 7; i++) ramp[i + 1] = ((7 - i) * a + i * b) / 7;
  else {
    for (let i = 1; i < 5; i++) ramp[i + 1] = ((5 - i) * a + i * b) / 5;
    ramp[6] = min;
    ramp[7] = max;
  }
  for (let i = 0; i < 16; i++) {
    const bit = i * 3,
      byte = at + 2 + (bit >> 3),
      index = ((src[byte] | (src[byte + 1] << 8)) >> (bit & 7)) & 7,
      v = ramp[index];
    out[i * 4 + channel] = out instanceof Float32Array ? v / max : signed ? signedByte(v) : Math.round(v);
  }
}

const bc1: Block = (src, at, out) => colorBlock(src, at, out, true);

const bc2: Block = (src, at, out) => {
  colorBlock(src, at + 8, out, false);
  for (let i = 0; i < 16; i++) out[i * 4 + 3] = ((src[at + (i >> 1)] >> ((i & 1) * 4)) & 15) * 17;
};

const bc3: Block = (src, at, out) => {
  colorBlock(src, at + 8, out, false);
  rampBlock(src, at, out, 3, false);
};

const single =
  (signed: boolean): Block =>
  (src, at, out) => {
    rampBlock(src, at, out, 0, signed);
    for (let i = 0; i < 16; i++) {
      out[i * 4 + 1] = out[i * 4 + 2] = out instanceof Float32Array ? 0 : signed ? 128 : 0;
      out[i * 4 + 3] = out instanceof Float32Array ? 1 : 255;
    }
  };

const double =
  (signed: boolean): Block =>
  (src, at, out) => {
    rampBlock(src, at, out, 0, signed);
    rampBlock(src, at + 8, out, 1, signed);
    for (let i = 0; i < 16; i++) {
      out[i * 4 + 2] = out instanceof Float32Array ? 0 : signed ? 128 : 0;
      out[i * 4 + 3] = out instanceof Float32Array ? 1 : 255;
    }
  };

/** `count` bits (at most 24) at bit `position` of the 16-byte block at `at`, least significant first. */
function bits(src: Uint8Array, at: number, position: number, count: number): number {
  let v = 0;
  for (let i = 0; i < count; i++, position++) v |= ((src[at + (position >> 3)] >> (position & 7)) & 1) << i;
  return v;
}

const WEIGHTS: Record<number, readonly number[]> = {
  2: [0, 21, 43, 64],
  3: [0, 9, 18, 27, 37, 46, 55, 64],
  4: [0, 4, 9, 13, 17, 21, 26, 30, 34, 38, 43, 47, 51, 55, 60, 64],
};

// Table 109: subsets, partition bits, rotation bits, index selection bits, colour bits, alpha bits, endpoint P-bits,
// shared P-bits, index bits, secondary index bits.
const BC7_MODES = [
  [3, 4, 0, 0, 4, 0, 1, 0, 3, 0],
  [2, 6, 0, 0, 6, 0, 0, 1, 3, 0],
  [3, 6, 0, 0, 5, 0, 0, 0, 2, 0],
  [2, 6, 0, 0, 7, 0, 1, 0, 2, 0],
  [1, 0, 2, 1, 5, 6, 0, 0, 2, 3],
  [1, 0, 2, 0, 7, 8, 0, 0, 2, 2],
  [1, 0, 0, 0, 7, 7, 1, 0, 4, 0],
  [2, 6, 0, 0, 5, 5, 1, 0, 2, 0],
];

/** Top-aligns the `n`-bit value in a byte and repeats its high bits below it. */
const widen = (v: number, n: number): number => {
  const x = v << (8 - n);
  return x | (x >> n);
};

const bc7: Block = (src, at, out) => {
  let mode = 0;
  while (mode < 8 && !((src[at] >> mode) & 1)) mode++;
  if (mode === 8) {
    out.fill(0);
    return;
  }
  const [
    subsets,
    partitionBits,
    rotationBits,
    selectBits,
    colorBits,
    alphaBits,
    endpointP,
    sharedP,
    indexBits,
    index2Bits,
  ] = BC7_MODES[mode];
  let position = mode + 1;
  const take = (n: number): number => {
    const v = bits(src, at, position, n);
    position += n;
    return v;
  };
  const partition = take(partitionBits),
    rotation = take(rotationBits),
    select = take(selectBits),
    endpoints = subsets * 2,
    raw = new Uint8Array(endpoints * 4);
  for (let c = 0; c < 3; c++) for (let e = 0; e < endpoints; e++) raw[e * 4 + c] = take(colorBits);
  if (alphaBits) for (let e = 0; e < endpoints; e++) raw[e * 4 + 3] = take(alphaBits);
  const pBits = new Uint8Array(endpoints);
  if (endpointP) for (let e = 0; e < endpoints; e++) pBits[e] = take(1);
  if (sharedP)
    for (let s = 0; s < subsets; s++) {
      pBits[s * 2] = pBits[s * 2 + 1] = take(1);
    }
  const hasP = endpointP || sharedP ? 1 : 0;
  for (let e = 0; e < endpoints; e++)
    for (let c = 0; c < 4; c++) {
      if (c === 3 && !alphaBits) {
        raw[e * 4 + 3] = 255;
        continue;
      }
      const n = (c === 3 ? alphaBits : colorBits) + hasP;
      raw[e * 4 + c] = widen(hasP ? (raw[e * 4 + c] << 1) | pBits[e] : raw[e * 4 + c], n);
    }
  const subsetOf = (i: number): number =>
      subsets === 1 ? 0 : (subsets === 2 ? PARTITIONS_2 : PARTITIONS_3).charCodeAt(partition * 16 + i) - 48,
    anchor = (i: number): boolean =>
      i === 0 ||
      (subsets === 2 && i === ANCHOR_2[partition]) ||
      (subsets === 3 && (i === ANCHOR_3_SECOND[partition] || i === ANCHOR_3_THIRD[partition]));
  const primary = new Uint8Array(16),
    secondary = new Uint8Array(16);
  for (let i = 0; i < 16; i++) primary[i] = take(anchor(i) ? indexBits - 1 : indexBits);
  if (index2Bits) for (let i = 0; i < 16; i++) secondary[i] = take(i === 0 ? index2Bits - 1 : index2Bits);
  const colorIndex = select ? secondary : primary,
    alphaIndex = select ? primary : index2Bits ? secondary : primary,
    colorWeights = WEIGHTS[select ? index2Bits : indexBits],
    alphaWeights = WEIGHTS[select ? indexBits : index2Bits || indexBits];
  for (let i = 0; i < 16; i++) {
    const e = subsetOf(i) * 8,
      wc = colorWeights[colorIndex[i]],
      wa = alphaWeights[alphaIndex[i]],
      mix = (c: number, w: number): number => ((64 - w) * raw[e + c] + w * raw[e + 4 + c] + 32) >> 6,
      red = mix(0, wc),
      green = mix(1, wc),
      blue = mix(2, wc),
      alpha = mix(3, wa),
      o = i * 4;
    out[o] = rotation === 1 ? alpha : red;
    out[o + 1] = rotation === 2 ? alpha : green;
    out[o + 2] = rotation === 3 ? alpha : blue;
    out[o + 3] = rotation === 1 ? red : rotation === 2 ? green : rotation === 3 ? blue : alpha;
  }
};

// Table 122, as printed: how each mode's bits fill the endpoints, least significant bit of the block first.
const BC6H_LAYOUTS: Record<number, string> = {
  0: 'G24 B24 B34 R09..0 G09..0 B09..0 R14..0 G34 G23..0 G14..0 B30 G33..0 B14..0 B31 B23..0 R24..0 B32 R34..0 B33',
  1: 'G25 G34 G35 R06..0 B30 B31 B24 G06..0 B25 B32 G24 B06..0 B33 B35 B34 R15..0 G23..0 G15..0 G33..0 B15..0 B23..0 R25..0 R35..0',
  2: 'R09..0 G09..0 B09..0 R14..0 R010 G23..0 G13..0 G010 B30 G33..0 B13..0 B010 B31 B23..0 R24..0 B32 R34..0 B33',
  6: 'R09..0 G09..0 B09..0 R13..0 R010 G34 G23..0 G14..0 G010 G33..0 B13..0 B010 B31 B23..0 R23..0 B30 B32 R33..0 G24 B33',
  10: 'R09..0 G09..0 B09..0 R13..0 R010 B24 G23..0 G13..0 G010 B30 G33..0 B14..0 B010 B23..0 R23..0 B31 B32 R33..0 B34 B33',
  14: 'R08..0 B24 G08..0 G24 B08..0 B34 R14..0 G34 G23..0 G14..0 B30 G33..0 B14..0 B31 B23..0 R24..0 B32 R34..0 B33',
  18: 'R07..0 G34 B24 G07..0 B32 G24 B07..0 B33 B34 R15..0 G23..0 G14..0 B30 G33..0 B14..0 B31 B23..0 R25..0 R35..0',
  22: 'R07..0 B30 B24 G07..0 G25 G24 B07..0 G35 B34 R14..0 G34 G23..0 G15..0 G33..0 B14..0 B31 B23..0 R24..0 B32 R34..0 B33',
  26: 'R07..0 B31 B24 G07..0 B25 G24 B07..0 B35 B34 R14..0 G34 G23..0 G14..0 B30 G33..0 B15..0 B23..0 R24..0 B32 R34..0 B33',
  30: 'R05..0 G34 B30 B31 B24 G05..0 G25 B25 B32 G24 B05..0 G35 B33 B35 B34 R15..0 G23..0 G15..0 G33..0 B15..0 B23..0 R25..0 R35..0',
  3: 'R09..0 G09..0 B09..0 R19..0 G19..0 B19..0',
  7: 'R09..0 G09..0 B09..0 R18..0 R010 G18..0 G010 B18..0 B010',
  11: 'R09..0 G09..0 B09..0 R17..0 R010..11 G17..0 G010..11 B17..0 B010..11',
  15: 'R09..0 G09..0 B09..0 R13..0 R010..15 G13..0 G010..15 B13..0 B010..15',
};
// Table 121: whether endpoints are deltas, endpoint bits, delta bits of red, green and blue.
const BC6H_MODES: Record<number, readonly [boolean, number, number, number, number]> = {
  0: [true, 10, 5, 5, 5],
  1: [true, 7, 6, 6, 6],
  2: [true, 11, 5, 4, 4],
  6: [true, 11, 4, 5, 4],
  10: [true, 11, 4, 4, 5],
  14: [true, 9, 5, 5, 5],
  18: [true, 8, 6, 5, 5],
  22: [true, 8, 5, 6, 5],
  26: [true, 8, 5, 5, 6],
  30: [false, 6, 6, 6, 6],
  3: [false, 10, 10, 10, 10],
  7: [true, 11, 9, 9, 9],
  11: [true, 12, 8, 8, 8],
  15: [true, 16, 4, 4, 4],
};

/** Each field of a layout: endpoint (0..3), channel (0..2), and the bit numbers in the order the block stores them. */
type Field = readonly [number, number, readonly number[]];
const layouts = new Map<number, readonly Field[]>();

function layoutOf(mode: number): readonly Field[] {
  let fields = layouts.get(mode);
  if (!fields) {
    fields = BC6H_LAYOUTS[mode].split(' ').map((text) => {
      // A name such as R010..15 is channel R, endpoint 0, then bits 10 to 15; the first bit stored is the second number.
      const [, channel, endpoint, high, low] = /^([RGB])(\d)(\d+)(?:\.\.(\d+))?$/.exec(text)!,
        from = Number(low ?? high),
        to = Number(high),
        order: number[] = [];
      for (let b = from; ; b += to >= from ? 1 : -1) {
        order.push(b);
        if (b === to) break;
      }
      return [Number(endpoint), 'RGB'.indexOf(channel), order] as const;
    });
    layouts.set(mode, fields);
  }
  return fields;
}

const signExtend = (v: number, n: number): number => (n >= 32 ? v : (v << (32 - n)) >> (32 - n));

function unquantize(x: number, n: number, signed: boolean): number {
  if (!signed) {
    if (n >= 15) return x;
    if (x === 0) return 0;
    if (x === (1 << n) - 1) return 0xffff;
    return ((x << 15) + 0x4000) >> (n - 1);
  }
  if (n >= 16) return x;
  const negative = x < 0,
    a = negative ? -x : x;
  let q: number;
  if (a === 0) q = 0;
  else if (a >= (1 << (n - 1)) - 1) q = 0x7fff;
  else q = ((a << 15) + 0x4000) >> (n - 1);
  return negative ? -q : q;
}

/** A 16-bit float's bits as a number. */
export const halfToFloat = (h: number): number => {
  const e = (h >> 10) & 31,
    m = h & 1023,
    v = e === 0 ? m / 16777216 : e === 31 ? (m ? Number.NaN : Infinity) : (1 + m / 1024) * 2 ** (e - 15);
  return h & 0x8000 ? -v : v;
};

/** Linear light to an sRGB byte, clamped to 0..1. */
export const linearToByte = (v: number): number => {
  const c = v <= 0 ? 0 : v >= 1 ? 1 : v;
  return Math.round((c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055) * 255);
};

const bc6h =
  (signed: boolean): Block =>
  (src, at, out) => {
    const low = bits(src, at, 0, 2),
      mode = low < 2 ? low : bits(src, at, 0, 5),
      info = BC6H_MODES[mode];
    if (!info) {
      for (let i = 0; i < 16; i++) out.set([0, 0, 0, out instanceof Float32Array ? 1 : 255], i * 4);
      return;
    }
    const [deltas, width, ...deltaBits] = info,
      twoSubsets = mode < 3 || (mode & 3) === 2,
      e = new Int32Array(12);
    let position = low < 2 ? 2 : 5;
    for (const [endpoint, channel, order] of layoutOf(mode))
      for (const b of order) {
        if ((src[at + (position >> 3)] >> (position & 7)) & 1) e[endpoint * 3 + channel] |= 1 << b;
        position++;
      }
    const partition = twoSubsets ? bits(src, at, position, 5) : 0;
    position += twoSubsets ? 5 : 0;
    const count = twoSubsets ? 4 : 2;
    for (let c = 0; c < 3; c++) {
      if (signed) e[c] = signExtend(e[c], width);
      for (let k = 1; k < count; k++) {
        const i = k * 3 + c;
        if (deltas) {
          e[i] = (signExtend(e[i], deltaBits[c]) + e[c]) & ((1 << width) - 1);
          if (signed) e[i] = signExtend(e[i], width);
        } else if (signed) e[i] = signExtend(e[i], width);
      }
      for (let k = 0; k < count; k++) e[k * 3 + c] = unquantize(e[k * 3 + c], width, signed);
    }
    const indexBits = twoSubsets ? 3 : 4,
      weights = WEIGHTS[indexBits];
    for (let i = 0; i < 16; i++) {
      const subset = twoSubsets ? PARTITIONS_2.charCodeAt(partition * 16 + i) - 48 : 0,
        anchor = i === 0 || (twoSubsets && i === ANCHOR_2[partition]),
        n = anchor ? indexBits - 1 : indexBits,
        w = weights[bits(src, at, position, n)];
      position += n;
      for (let c = 0; c < 3; c++) {
        const a = e[subset * 6 + c],
          b = e[subset * 6 + 3 + c],
          v = ((64 - w) * a + w * b + 32) >> 6,
          h = signed ? (v < 0 ? ((-v * 31) >> 5) | 0x8000 : (v * 31) >> 5) : (v * 31) >> 6;
        out[i * 4 + c] = out instanceof Float32Array ? halfToFloat(h) : linearToByte(halfToFloat(h));
      }
      out[i * 4 + 3] = out instanceof Float32Array ? 1 : 255;
    }
  };

const BLOCKS: Record<string, readonly [Block, number]> = {
  'bc1-rgba': [bc1, 8],
  'bc2-rgba': [bc2, 16],
  'bc3-rgba': [bc3, 16],
  'bc4-r-unorm': [single(false), 8],
  'bc4-r-snorm': [single(true), 8],
  'bc5-rg-unorm': [double(false), 16],
  'bc5-rg-snorm': [double(true), 16],
  'bc6h-rgb-ufloat': [bc6h(false), 16],
  'bc6h-rgb-float': [bc6h(true), 16],
  'bc7-rgba': [bc7, 16],
};

/**
 * Decodes BC1 to BC7 blocks of one image to RGBA8. `format` is a WebGPU format name (`bc7-rgba-unorm-srgb`,
 * `bc1-rgba-unorm` ...); bytes are returned as stored, so sRGB and unorm variants read the same.
 *
 * @example
 * import {decodeBC} from 'margoengine/decoders/bc';
 * const white = new Uint8Array([255, 255, 255, 255, 0, 0, 0, 0]); // one BC1 block
 * console.log(decodeBC('bc1-rgba-unorm', white, 4, 4).data.length); // 64
 *
 * @throws TypeError when `format` is not a BC format.
 * @throws MargoError `failed` when `blocks` is shorter than the image needs.
 */
export function decodeBC(format: string, blocks: Uint8Array, width: number, height: number): BCImage {
  const key = format.replace(/-unorm(-srgb)?$/, (whole) => (/^bc[45]/.test(format) ? whole : '')),
    entry = BLOCKS[key];
  if (!entry) throw new TypeError(`${format} is not a BC format; pass one of bc1-rgba-unorm to bc7-rgba-unorm-srgb`);
  const [decode, size] = entry,
    across = (width + 3) >> 2,
    down = (height + 3) >> 2;
  if (blocks.length < across * down * size)
    throw decodeFailed(
      `${format}: ${blocks.length} bytes hold too few blocks for ${width}x${height}; pass the whole level`,
    );
  const data = new Uint8Array(width * height * 4),
    texels = new Uint8Array(64);
  for (let by = 0; by < down; by++)
    for (let bx = 0; bx < across; bx++) {
      decode(blocks, (by * across + bx) * size, texels);
      for (let y = 0; y < 4 && by * 4 + y < height; y++) {
        const columns = Math.min(4, width - bx * 4);
        data.set(texels.subarray(y * 16, y * 16 + columns * 4), ((by * 4 + y) * width + bx * 4) * 4);
      }
    }
  return { width, height, data };
}

/** Decode BC4/BC5/BC6H to floating-point RGBA, preserving signed channels and HDR radiance. Other BC formats return normalized RGBA. */
export function decodeBCFloat(
  format: string,
  blocks: Uint8Array,
  width: number,
  height: number,
): {
  width: number;
  height: number;
  data: Float32Array;
} {
  if (!/^bc[456]/.test(format)) {
    const image = decodeBC(format, blocks, width, height);
    return { width, height, data: Float32Array.from(image.data, (v) => v / 255) };
  }
  const entry = BLOCKS[format];
  if (!entry) throw new TypeError('Unknown BC float format ' + format + '; pass a BC4, BC5 or BC6H WebGPU format');
  const [decode, size] = entry,
    across = Math.ceil(width / 4),
    down = Math.ceil(height / 4);
  if (blocks.length < across * down * size)
    throw decodeFailed('BC float image has too few blocks; pass the complete mip level');
  const data = new Float32Array(width * height * 4),
    texels = new Float32Array(64);
  for (let by = 0; by < down; by++)
    for (let bx = 0; bx < across; bx++) {
      decode(blocks, (by * across + bx) * size, texels);
      for (let y = 0; y < 4 && by * 4 + y < height; y++) {
        const columns = Math.min(4, width - bx * 4);
        data.set(texels.subarray(y * 16, y * 16 + columns * 4), ((by * 4 + y) * width + bx * 4) * 4);
      }
    }
  return { width, height, data };
}
