// ETC2 and EAC block decoding on the CPU, written from the OpenGL ES 3.0 specification, appendix C (the ETC2 and EAC
// formats, clean room from the published text). RGB8 (which holds ETC1), RGB8 with punch-through alpha, RGBA8 with EAC
// alpha, and R11 and RG11 EAC, unsigned and signed. Used by `textureFileToRGBA`; a GPU samples these blocks directly.
import { decodeFailed } from './errors.js';

/** RGBA8 pixels, rows top first. */
export interface ETCImage {
  width: number;
  height: number;
  data: Uint8Array;
}

// Table C.6: the modifier sets of the individual and differential modes (a small, b large; the set is [-b, -a, a, b]).
const MODIFIERS = [
  [-8, -2, 2, 8],
  [-17, -5, 5, 17],
  [-29, -9, 9, 29],
  [-42, -13, 13, 42],
  [-60, -18, 18, 60],
  [-80, -24, 24, 80],
  [-106, -33, 33, 106],
  [-183, -47, 47, 183],
];
// Table C.8: the T and H distances.
const DISTANCES = [3, 6, 11, 16, 23, 32, 41, 64];
// Table C.10: the EAC modifier sets.
const EAC = [
  [-3, -6, -9, -15, 2, 5, 8, 14],
  [-3, -7, -10, -13, 2, 6, 9, 12],
  [-2, -5, -8, -13, 1, 4, 7, 12],
  [-2, -4, -6, -13, 1, 3, 5, 12],
  [-3, -6, -8, -12, 2, 5, 7, 11],
  [-3, -7, -9, -11, 2, 6, 8, 10],
  [-4, -7, -8, -11, 3, 6, 7, 10],
  [-3, -5, -8, -11, 2, 4, 7, 10],
  [-2, -6, -8, -10, 1, 5, 7, 9],
  [-2, -5, -8, -10, 1, 4, 7, 9],
  [-2, -4, -8, -10, 1, 3, 7, 9],
  [-2, -5, -7, -10, 1, 4, 6, 9],
  [-3, -4, -7, -10, 2, 3, 6, 9],
  [-1, -2, -3, -10, 0, 1, 2, 9],
  [-4, -6, -8, -9, 3, 5, 7, 8],
  [-3, -5, -7, -9, 2, 4, 6, 8],
];

const clamp255 = (v: number): number => (v < 0 ? 0 : v > 255 ? 255 : v);
const x4 = (v: number): number => (v << 4) | v;
const x5 = (v: number): number => (v << 3) | (v >> 2);
const x6 = (v: number): number => (v << 2) | (v >> 4);
const x7 = (v: number): number => (v << 1) | (v >> 6);
const signed3 = (v: number): number => (v & 4 ? v - 8 : v);

/**
 * One ETC2 colour block (8 bytes at `at`) into `out` as 16 RGBA texels in raster order, rows top first. `punch` reads
 * bit 33 as the opaque bit of the punch-through format; without it that bit is the differential bit.
 */
function colourBlock(src: Uint8Array, at: number, out: Uint8Array, punch: boolean): void {
  const hi = ((src[at] << 24) | (src[at + 1] << 16) | (src[at + 2] << 8) | src[at + 3]) >>> 0,
    lo = ((src[at + 4] << 24) | (src[at + 5] << 16) | (src[at + 6] << 8) | src[at + 7]) >>> 0,
    bit33 = (hi >>> 1) & 1,
    flip = hi & 1;
  // Selector of pixel n (a, b, c, d down the first column, then the next column): the MSB plane over the LSB plane.
  const index = (n: number): number => (((lo >>> (16 + n)) & 1) << 1) | ((lo >>> n) & 1);
  const put = (n: number, r: number, g: number, b: number, a = 255): void => {
    const x = n >> 2,
      y = n & 3,
      o = (y * 4 + x) * 4;
    out[o] = clamp255(r);
    out[o + 1] = clamp255(g);
    out[o + 2] = clamp255(b);
    out[o + 3] = a;
  };
  const R = (hi >>> 27) & 31,
    G = (hi >>> 19) & 31,
    B = (hi >>> 11) & 31,
    dR = signed3((hi >>> 24) & 7),
    dG = signed3((hi >>> 16) & 7),
    dB = signed3((hi >>> 8) & 7);
  const individual = !punch && bit33 === 0;
  const opaque = !punch || bit33 === 1;
  const painted = (colours: number[][]): void => {
    for (let n = 0; n < 16; n++) {
      const i = index(n);
      if (!opaque && i === 2) put(n, 0, 0, 0, 0);
      else put(n, colours[i][0], colours[i][1], colours[i][2]);
    }
  };
  if (!individual && (R + dR < 0 || R + dR > 31)) {
    // T mode: paint 0 is base 1, paint 2 is base 2, paints 1 and 3 are base 2 shifted by the distance.
    const r1 = x4((((hi >>> 27) & 3) << 2) | ((hi >>> 24) & 3)),
      g1 = x4((hi >>> 20) & 15),
      b1 = x4((hi >>> 16) & 15),
      r2 = x4((hi >>> 12) & 15),
      g2 = x4((hi >>> 8) & 15),
      b2 = x4((hi >>> 4) & 15),
      d = DISTANCES[(((hi >>> 2) & 3) << 1) | (hi & 1)];
    painted([
      [r1, g1, b1],
      [r2 + d, g2 + d, b2 + d],
      [r2, g2, b2],
      [r2 - d, g2 - d, b2 - d],
    ]);
  } else if (!individual && (G + dG < 0 || G + dG > 31)) {
    // H mode: the distance's low bit is whether base 1 is not above base 2.
    const r1 = x4((hi >>> 27) & 15),
      g1 = x4((((hi >>> 24) & 7) << 1) | ((hi >>> 20) & 1)),
      b1 = x4((((hi >>> 19) & 1) << 3) | ((hi >>> 15) & 7)),
      r2 = x4((hi >>> 11) & 15),
      g2 = x4((hi >>> 7) & 15),
      b2 = x4((hi >>> 3) & 15),
      value1 = (r1 << 16) | (g1 << 8) | b1,
      value2 = (r2 << 16) | (g2 << 8) | b2,
      d = DISTANCES[(((hi >>> 2) & 1) << 2) | ((hi & 1) << 1) | (value1 >= value2 ? 1 : 0)];
    painted([
      [r1 + d, g1 + d, b1 + d],
      [r1 - d, g1 - d, b1 - d],
      [r2 + d, g2 + d, b2 + d],
      [r2 - d, g2 - d, b2 - d],
    ]);
  } else if (!individual && (B + dB < 0 || B + dB > 31)) {
    // Planar mode: three corners in RGB 676, the rest interpolated.
    const ro = x6((hi >>> 25) & 63),
      go = x7((((hi >>> 24) & 1) << 6) | ((hi >>> 17) & 63)),
      bo = x6((((hi >>> 16) & 1) << 5) | (((hi >>> 11) & 3) << 3) | ((hi >>> 7) & 7)),
      rh = x6((((hi >>> 2) & 31) << 1) | (hi & 1)),
      gh = x7((lo >>> 25) & 127),
      bh = x6((lo >>> 19) & 63),
      rv = x6((lo >>> 13) & 63),
      gv = x7((lo >>> 6) & 127),
      bv = x6(lo & 63);
    for (let n = 0; n < 16; n++) {
      const x = n >> 2,
        y = n & 3;
      put(
        n,
        (x * (rh - ro) + y * (rv - ro) + 4 * ro + 2) >> 2,
        (x * (gh - go) + y * (gv - go) + 4 * go + 2) >> 2,
        (x * (bh - bo) + y * (bv - bo) + 4 * bo + 2) >> 2,
      );
    }
  } else {
    // Individual or differential: two subblocks, each a base colour and a modifier set.
    const base = individual
      ? [
          [x4((hi >>> 28) & 15), x4((hi >>> 20) & 15), x4((hi >>> 12) & 15)],
          [x4((hi >>> 24) & 15), x4((hi >>> 16) & 15), x4((hi >>> 8) & 15)],
        ]
      : [
          [x5(R), x5(G), x5(B)],
          [x5(R + dR), x5(G + dG), x5(B + dB)],
        ];
    const tables = [MODIFIERS[(hi >>> 5) & 7], MODIFIERS[(hi >>> 2) & 7]];
    for (let n = 0; n < 16; n++) {
      const x = n >> 2,
        y = n & 3,
        s = flip ? (y >= 2 ? 1 : 0) : x >= 2 ? 1 : 0,
        i = index(n);
      if (punch && !opaque && i === 2) {
        put(n, 0, 0, 0, 0);
        continue;
      }
      const t = tables[s];
      // Selector (MSB, LSB): 0 is +a, 1 is +b, 2 is -a, 3 is -b; without the opaque bit the small step is 0.
      const m = !opaque && (i === 0 || i === 2) ? 0 : [t[2], t[3], t[1], t[0]][i];
      put(n, base[s][0] + m, base[s][1] + m, base[s][2] + m);
    }
  }
}

/** One 8-byte EAC channel block (`at`), the 16 values in raster order, as 11-bit values (signed ones as -1023..1023). */
function eacBlock(src: Uint8Array, at: number, signed: boolean, values: Int16Array): void {
  const base = signed ? ((src[at] << 24) >> 24 === -128 ? -127 : (src[at] << 24) >> 24) : src[at],
    multiplier = src[at + 1] >> 4,
    table = EAC[src[at + 1] & 15];
  // The 48 selector bits, pixel a first with its most significant bit at bit 47.
  let bits = 0n;
  for (let i = 2; i < 8; i++) bits = (bits << 8n) | BigInt(src[at + i]);
  for (let n = 0; n < 16; n++) {
    const selector = Number((bits >> BigInt(45 - 3 * n)) & 7n),
      modifier = table[selector] * (multiplier === 0 ? 1 : multiplier * 8),
      value = signed ? base * 8 + modifier : base * 8 + 4 + modifier,
      x = n >> 2,
      y = n & 3;
    values[y * 4 + x] = signed ? Math.min(1023, Math.max(-1023, value)) : Math.min(2047, Math.max(0, value));
  }
}

const byte11 = (v: number): number => Math.round((v * 255) / 2047);
const byteS11 = (v: number): number => Math.round(((v + 1023) * 255) / 2046);

/**
 * Decodes ETC2 and EAC blocks of one image to RGBA8. `format` is a WebGPU format name: `etc2-rgb8unorm`,
 * `etc2-rgb8a1unorm`, `etc2-rgba8unorm`, `eac-r11unorm`, `eac-r11snorm`, `eac-rg11unorm` or `eac-rg11snorm`, with or
 * without `-srgb`; bytes come out as stored, so the sRGB variants read the same. R11 fills red (green, blue 0, alpha
 * 255), RG11 red and green; the 11-bit values are rounded to 8 bits, and the signed ones map -1..1 to 0..255 as BC4
 * does. The alpha of `etc2-rgba8unorm` is the EAC alpha channel (a multiplier of 0 multiplies by 0, as the alpha part
 * of the specification says).
 *
 * @throws TypeError when `format` is not an ETC2 or EAC format.
 * @throws MargoError `failed` when `blocks` is shorter than the image needs.
 */
export function decodeETC(format: string, blocks: Uint8Array, width: number, height: number): ETCImage {
  const key = format.replace(/-srgb$/, ''),
    known = [
      'etc2-rgb8unorm',
      'etc2-rgb8a1unorm',
      'etc2-rgba8unorm',
      'eac-r11unorm',
      'eac-r11snorm',
      'eac-rg11unorm',
      'eac-rg11snorm',
    ];
  if (!known.includes(key))
    throw new TypeError(`${format} is not an ETC2 or EAC format; pass etc2-rgb8unorm to eac-rg11snorm`);
  const across = (width + 3) >> 2,
    down = (height + 3) >> 2,
    size = key === 'etc2-rgb8unorm' || key === 'etc2-rgb8a1unorm' || key.startsWith('eac-r11') ? 8 : 16;
  if (blocks.length < across * down * size)
    throw decodeFailed(
      `${format}: ${blocks.length} bytes hold too few blocks for ${width}x${height}; pass the whole level`,
    );
  const data = new Uint8Array(width * height * 4),
    texels = new Uint8Array(64),
    first = new Int16Array(16),
    second = new Int16Array(16),
    signed = key.endsWith('snorm'),
    channels = key.startsWith('eac-rg11') ? 2 : 1;
  for (let by = 0; by < down; by++)
    for (let bx = 0; bx < across; bx++) {
      const at = (by * across + bx) * size;
      if (key.startsWith('eac-')) {
        eacBlock(blocks, at, signed, first);
        if (channels === 2) eacBlock(blocks, at + 8, signed, second);
        for (let i = 0; i < 16; i++) {
          texels[i * 4] = signed ? byteS11(first[i]) : byte11(first[i]);
          texels[i * 4 + 1] = channels === 2 ? (signed ? byteS11(second[i]) : byte11(second[i])) : signed ? 128 : 0;
          texels[i * 4 + 2] = signed ? 128 : 0;
          texels[i * 4 + 3] = 255;
        }
      } else if (key === 'etc2-rgba8unorm') {
        colourBlock(blocks, at + 8, texels, false);
        // The alpha part: 8-bit, with a multiplier of 0 meaning 0 (not 1/8).
        const alphaBase = blocks[at],
          multiplier = blocks[at + 1] >> 4,
          table = EAC[blocks[at + 1] & 15];
        let bits = 0n;
        for (let i = 2; i < 8; i++) bits = (bits << 8n) | BigInt(blocks[at + i]);
        for (let n = 0; n < 16; n++) {
          const selector = Number((bits >> BigInt(45 - 3 * n)) & 7n),
            x = n >> 2,
            y = n & 3;
          texels[(y * 4 + x) * 4 + 3] = clamp255(alphaBase + table[selector] * multiplier);
        }
      } else colourBlock(blocks, at, texels, key === 'etc2-rgb8a1unorm');
      for (let y = 0; y < 4 && by * 4 + y < height; y++) {
        const columns = Math.min(4, width - bx * 4);
        data.set(texels.subarray(y * 16, y * 16 + columns * 4), ((by * 4 + y) * width + bx * 4) * 4);
      }
    }
  return { width, height, data };
}
