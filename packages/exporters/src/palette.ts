import { checked, type Pixels } from './frames.js';
// Indexed palette textures: one texel per palette colour, sampled NEAREST, so voxel or pixel-art models can colour
// each face by pointing its UVs at a texel centre.
import type { TextureData } from './scene.js';

// The PNG encoder loads on first use, as in model.js, so no module of this package imports it both ways.
const png: typeof import('./png.js').png = async (...args) => (await import('./png.js')).png(...args);

/** A palette laid out one colour per texel: {@link paletteTexture}'s result. */
export interface PaletteTexture {
  /** PNG of the palette, sampled NEAREST without mipmaps and clamped, so every texel reads back exactly. */
  texture: TextureData;
  /** Side of the square power-of-two image in texels: the smallest with `size * size` >= the entry count. */
  size: number;
  /** Texel-centre UV of each entry (glTF convention, v down from the top row), two per entry. */
  uvs: Float32Array;
}

/**
 * An indexed palette texture: entry `i` of `colors` (RGBA8, four bytes per entry, sRGB as PNG stores it) becomes texel
 * `i`, read left to right and top to bottom; texels past the last entry are transparent black. Give a face's UVs the
 * texel centre `uvs[2 * i]`, `uvs[2 * i + 1]` to colour it with entry `i`.
 * @throws RangeError when `colors` is empty, not whole RGBA entries, outside 0..255, or over 4096 x 4096 entries.
 */
export async function paletteTexture(
  colors: ArrayLike<number>,
  options: { name?: string } = {},
): Promise<PaletteTexture> {
  const length = colors?.length;
  if (typeof length !== 'number' || length === 0 || length % 4)
    throw new RangeError('Palette colors need four RGBA8 bytes per entry; pass at least one entry');
  const count = length / 4;
  if (count > 4096 * 4096) throw new RangeError('Palette has over 16,777,216 entries; split it');
  if (options.name !== undefined && typeof options.name !== 'string')
    throw new TypeError('Palette texture name must be a string');
  let size = 1;
  while (size * size < count) size *= 2;
  const data = new Uint8Array(size * size * 4);
  for (let i = 0; i < length; i++) {
    const value = colors[i];
    if (!Number.isInteger(value) || value < 0 || value > 255)
      throw new RangeError('Palette colors must be whole bytes 0..255; convert them to RGBA8');
    data[i] = value;
  }
  const uvs = new Float32Array(count * 2);
  for (let i = 0; i < count; i++) {
    uvs[i * 2] = ((i % size) + 0.5) / size;
    uvs[i * 2 + 1] = (Math.floor(i / size) + 0.5) / size;
  }
  const texture: TextureData = {
    image: await png({ data, width: size, height: size }, Infinity, false),
    mimeType: 'image/png',
    magFilter: 'nearest',
    minFilter: 'nearest',
    mipmaps: false,
    wrapS: 'clamp',
    wrapT: 'clamp',
  };
  if (options.name) texture.name = options.name;
  return { texture, size, uvs };
}

/** Result of shared median-cut palette quantization. */
export interface QuantizedPalette {
  /** RGB bytes, three per entry, at most 256 entries. */
  palette: number[];
  /** One palette index per input pixel. */
  indices: Uint8Array;
  /** True when index zero means transparent. */
  transparent: boolean;
}

const bayer = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];
/** Quantizes RGBA8 to at most 256 RGB entries with one transparent index when needed.
 * Exact colours are retained when they fit; otherwise uses weighted median cut
 * and optional ordered Bayer dithering. Alpha below 128 maps to index zero.
 * @param pixels Straight-alpha top-row-first RGBA8.
 * @param dither Ordered dithering for reduced palettes. Default false.
 */
export function quantizePalette(pixels: Pixels, dither = false): QuantizedPalette {
  const { data, width } = checked(pixels);
  if (typeof dither !== 'boolean') throw new TypeError('Palette dither must be a boolean; pass true or false');
  const n = data.length / 4,
    indices = new Uint8Array(n),
    exact = new Map<number, number>(),
    rgb = (i: number): number => (data[i * 4] << 16) | (data[i * 4 + 1] << 8) | data[i * 4 + 2];
  let transparent = false;
  for (let i = 0; i < n; i++)
    if (data[i * 4 + 3] < 128) transparent = true;
    else if (exact.size <= 256 && !exact.has(rgb(i))) exact.set(rgb(i), exact.size);
  const offset = transparent ? 1 : 0,
    palette = transparent ? [0, 0, 0] : [];
  if (exact.size + offset <= 256) {
    for (const c of exact.keys()) palette.push(c >> 16, (c >> 8) & 255, c & 255);
    for (let i = 0; i < n; i++) indices[i] = data[i * 4 + 3] < 128 ? 0 : exact.get(rgb(i))! + offset;
    return { palette, indices, transparent };
  }
  // Median cut over 5-bit bins (key r5 << 10 | g5 << 5 | b5).
  const key = (r: number, g: number, b: number): number => ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3),
    counts = new Uint32Array(32768),
    sums = new Float64Array(32768 * 3);
  for (let i = 0; i < n; i++)
    if (data[i * 4 + 3] >= 128) {
      const k = key(data[i * 4], data[i * 4 + 1], data[i * 4 + 2]);
      counts[k]++;
      for (let c = 0; c < 3; c++) sums[k * 3 + c] += data[i * 4 + c];
    }
  const boxes: number[][] = [[]];
  for (let k = 0; k < 32768; k++) if (counts[k]) boxes[0].push(k);
  while (boxes.length < 256 - offset) {
    let best = -1,
      widest = 0,
      shift = 0;
    boxes.forEach((box, b) => {
      for (let s = 0; s <= 10; s += 5) {
        let low = 31,
          high = 0;
        for (const k of box) {
          const v = (k >> s) & 31;
          low = Math.min(low, v);
          high = Math.max(high, v);
        }
        if (high - low > widest) [best, widest, shift] = [b, high - low, s];
      }
    });
    if (best < 0) break;
    const box = boxes[best].sort((p, q) => ((p >> shift) & 31) - ((q >> shift) & 31));
    let total = 0,
      half = 0,
      split = 0;
    for (const k of box) total += counts[k];
    while (split < box.length - 2 && (half += counts[box[split]]) < total / 2) split++;
    boxes.push(box.splice(split + 1));
  }
  const lookup = new Int16Array(32768).fill(-1);
  boxes.forEach((box, b) => {
    const mean = [0, 0, 0];
    let total = 0;
    for (const k of box) {
      total += counts[k];
      for (let c = 0; c < 3; c++) mean[c] += sums[k * 3 + c];
      lookup[k] = b + offset;
    }
    palette.push(...mean.map((v) => Math.round(v / total)));
  });
  for (let i = 0; i < n; i++) {
    if (data[i * 4 + 3] < 128) continue; // index 0
    const d = dither ? ((bayer[(((i / width) & 3) << 2) | ((i % width) & 3)] + 0.5) / 16 - 0.5) * 32 : 0,
      [r, g, b] = [0, 1, 2].map((c) => Math.max(0, Math.min(255, Math.round(data[i * 4 + c] + d)))),
      k = key(r, g, b);
    if (lookup[k] < 0) {
      // A dithered colour outside the histogram: the nearest palette entry to the bin centre.
      let nearest = Infinity;
      for (let p = offset; p < palette.length / 3; p++) {
        const e =
          (palette[p * 3] - ((r & 0xf8) | 4)) ** 2 +
          (palette[p * 3 + 1] - ((g & 0xf8) | 4)) ** 2 +
          (palette[p * 3 + 2] - ((b & 0xf8) | 4)) ** 2;
        if (e < nearest) [nearest, lookup[k]] = [e, p];
      }
    }
    indices[i] = lookup[k];
  }
  return { palette, indices, transparent };
}
