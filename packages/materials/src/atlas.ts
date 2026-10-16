import type { TextureTransform } from '@margoengine/gltf-pro';
type Pixels = { data: ArrayLike<number>; width: number; height: number };
export interface AtlasOptions {
  /** Edge texels repeated around each image so filtering and the first mip levels do not bleed. Default 2. */ padding?: number;
  /** Largest width or height. Default 4096. */
  maxSize?: number;
}
/** One RGBA8 image for `new Texture(atlas.image)` and, per input, the UV transform that maps its 0-1 UVs onto its region. */
export interface Atlas {
  image: { data: Uint8Array; width: number; height: number };
  regions: TextureTransform[];
}
const raw = (s: any): s is Pixels => s?.data instanceof Uint8Array || s?.data instanceof Uint8ClampedArray;
/** Decoded rows, flipped for drawable images so they keep `Texture`'s flipY orientation once stored as raw rows. */
function pixels(s: Pixels | CanvasImageSource): [Pixels, boolean] {
  if (raw(s)) return [s, false];
  const w = (s as any).naturalWidth ?? (s as any).width,
    h = (s as any).naturalHeight ?? (s as any).height,
    c = new OffscreenCanvas(w, h).getContext('2d')!;
  c.drawImage(s, 0, 0);
  return [c.getImageData(0, 0, w, h), true];
}
/**
 * Shelf-packs images into one texture so meshes with different images can share one material (`uvTransform`) or one
 * merged geometry (`transformUVs`). Raw data and ImageData keep their row order; images, bitmaps and canvases are read
 * through a 2D canvas (alpha passes through premultiplication). Regions are not for `repeat` wrapping.
 */
export function packAtlas(
  images: readonly (Pixels | CanvasImageSource)[],
  { padding = 2, maxSize = 4096 }: AtlasOptions = {},
): Atlas {
  if (
    !images?.length ||
    !Number.isInteger(padding) ||
    padding < 0 ||
    !Number.isInteger(maxSize) ||
    maxSize < 1 ||
    maxSize * maxSize > 16_777_216
  )
    throw new RangeError('Invalid atlas images or options');
  const list = images.map(pixels),
    p = padding,
    order = list.map((_, i) => i).sort((a, b) => list[b][0].height - list[a][0].height),
    at = new Array<[number, number]>(list.length);
  for (const [s] of list)
    if (
      !(
        Number.isInteger(s.width) &&
        Number.isInteger(s.height) &&
        s.width > 0 &&
        s.height > 0 &&
        s.data.length >= s.width * s.height * 4
      )
    )
      throw new RangeError('Atlas images need width*height RGBA8 pixels');
  let width =
      2 **
      Math.ceil(
        Math.log2(
          Math.max(
            ...list.map(([s]) => s.width + 2 * p),
            Math.sqrt(list.reduce((n, [s]) => n + (s.width + 2 * p) * (s.height + 2 * p), 0)),
          ),
        ),
      ),
    height = 0;
  // Shelves of descending height; a wider atlas is tried while the shelves overflow maxSize.
  for (; ; width *= 2) {
    let x = 0,
      y = 0,
      shelf = 0;
    if (width > maxSize) throw new RangeError('Atlas images exceed maxSize');
    for (const i of order) {
      const w = list[i][0].width + 2 * p,
        h = list[i][0].height + 2 * p;
      if (x + w > width) {
        y += shelf;
        x = shelf = 0;
      }
      at[i] = [x, y];
      x += w;
      shelf = Math.max(shelf, h);
    }
    if ((height = y + shelf) <= maxSize) break;
  }
  const data = new Uint8Array(width * height * 4);
  list.forEach(([s, flip], i) => {
    const [x0, y0] = at[i],
      w = s.width,
      h = s.height;
    for (let y = -p; y < h + p; y++)
      for (let x = -p; x < w + p; x++) {
        const sy = Math.min(h - 1, Math.max(0, y)),
          from = ((flip ? h - 1 - sy : sy) * w + Math.min(w - 1, Math.max(0, x))) * 4,
          to = ((y0 + p + y) * width + x0 + p + x) * 4;
        for (let c = 0; c < 4; c++) data[to + c] = s.data[from + c];
      }
  });
  return {
    image: { data, width, height },
    regions: list.map(([s], i) => ({
      offset: [(at[i][0] + p) / width, (at[i][1] + p) / height],
      scale: [s.width / width, s.height / height],
    })),
  };
}
/** Applies a texture transform to packed UV pairs (bake an atlas region into geometry before merging meshes). */
export function transformUVs(
  uvs: ArrayLike<number>,
  { offset = [0, 0], scale = [1, 1], rotation = 0 }: TextureTransform,
): Float32Array {
  const out = new Float32Array(uvs.length),
    c = Math.cos(rotation),
    s = Math.sin(rotation);
  for (let i = 0; i < uvs.length; i += 2) {
    const u = uvs[i] * scale[0],
      v = uvs[i + 1] * scale[1];
    out[i] = c * u + s * v + offset[0];
    out[i + 1] = -s * u + c * v + offset[1];
  }
  return out;
}
