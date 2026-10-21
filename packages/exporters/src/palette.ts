// Indexed palette textures: one texel per palette colour, sampled NEAREST, so voxel or pixel-art models can colour
// each face by pointing its UVs at a texel centre.
import { png } from './png.js';
import type { TextureData } from './scene.js';

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
