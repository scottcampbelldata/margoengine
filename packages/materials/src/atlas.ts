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
const raw = (s: unknown): s is Pixels =>
  !!s && typeof s === 'object' && 'data' in s && (s.data instanceof Uint8Array || s.data instanceof Uint8ClampedArray);
/** Decoded rows, flipped for drawable images so they keep `Texture`'s flipY orientation once stored as raw rows. */
function pixels(s: Pixels | CanvasImageSource): [Pixels, boolean] {
  if (raw(s)) return [s, false];
  const dimensions = s as { naturalWidth?: number; naturalHeight?: number; width: number; height: number },
    w = dimensions.naturalWidth ?? dimensions.width,
    h = dimensions.naturalHeight ?? dimensions.height,
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
/** Options for {@link padTileGrid}: the source grid's cells and the padding to add around each. */
export interface TileGridOptions {
  /** Tile width and height in pixels, positive integers. */
  tileWidth: number;
  tileHeight: number;
  /** Border pixels repeated around every tile in the output, so filtering and mip levels do not bleed. Default 2. */
  padding?: number;
  /** Pixels around the whole source grid (Tiled's tileset margin). Default 0. */
  margin?: number;
  /** Pixels between source tiles (Tiled's tileset spacing). Default 0. */
  spacing?: number;
}
/** {@link padTileGrid}'s result: the padded image, one region per tile (row-major, top row first) and the grid's size. */
export interface TileGridAtlas extends Atlas {
  columns: number;
  rows: number;
  tileWidth: number;
  tileHeight: number;
  padding: number;
}
/**
 * Re-lays an atlas that is already a grid of equal tiles (a tileset) with `padding` copies of each tile's own border
 * pixels around it, so linear filtering and the first mip levels sample the tile's edge instead of its neighbour (no
 * seams, no bleeding). Tile (column, row), counted from the top-left of the source image, keeps its pixels exactly;
 * `regions[row * columns + column]` maps its 0-1 UVs onto it, and {@link remapTileUVs} moves UVs written for the
 * source grid. Raw data and ImageData keep their row order; images, bitmaps and canvases are read through a 2D canvas
 * as `packAtlas` does. Throws RangeError for a grid that does not fit the image or options out of range.
 */
export function padTileGrid(image: Pixels | CanvasImageSource, options: TileGridOptions): TileGridAtlas {
  const [s, flip] = pixels(image),
    { tileWidth: tw, tileHeight: th, padding: p = 2, margin = 0, spacing = 0 } = options ?? ({} as TileGridOptions);
  if (![tw, th].every((v) => Number.isInteger(v) && v > 0))
    throw new RangeError('Tile grid tileWidth and tileHeight must be positive integers; pass the tile size in pixels');
  if (![p, margin, spacing].every((v) => Number.isInteger(v) && v >= 0))
    throw new RangeError('Tile grid padding, margin and spacing must be integers >= 0');
  if (!(Number.isInteger(s.width) && Number.isInteger(s.height) && s.data.length >= s.width * s.height * 4))
    throw new RangeError('Tile grid image needs width*height RGBA8 pixels');
  const columns = Math.floor((s.width - 2 * margin + spacing) / (tw + spacing)),
    rows = Math.floor((s.height - 2 * margin + spacing) / (th + spacing));
  if (columns < 1 || rows < 1)
    throw new RangeError('Tile grid tiles do not fit the image; check tileWidth, tileHeight, margin and spacing');
  const pw = tw + 2 * p,
    ph = th + 2 * p,
    width = columns * pw,
    height = rows * ph;
  if (width * height > 16_777_216) throw new RangeError('Tile grid output exceeds 4096x4096 pixels; use less padding');
  // Source pixel (x, y), rows top first as decoded; drawable images are written bottom row first (see pixels()).
  const source = (x: number, y: number) => (y * s.width + x) * 4;
  const data = new Uint8Array(width * height * 4);
  for (let row = 0; row < rows; row++)
    for (let column = 0; column < columns; column++) {
      const sx = margin + column * (tw + spacing),
        sy = margin + row * (th + spacing);
      for (let y = -p; y < th + p; y++)
        for (let x = -p; x < tw + p; x++) {
          const from = source(sx + Math.min(tw - 1, Math.max(0, x)), sy + Math.min(th - 1, Math.max(0, y))),
            oy = row * ph + p + y,
            to = ((flip ? height - 1 - oy : oy) * width + column * pw + p + x) * 4;
          for (let c = 0; c < 4; c++) data[to + c] = s.data[from + c];
        }
    }
  const regions: TextureTransform[] = [];
  for (let row = 0; row < rows; row++)
    for (let column = 0; column < columns; column++) {
      const top = row * ph + p;
      regions.push({
        offset: [(column * pw + p) / width, (flip ? height - top - th : top) / height],
        scale: [tw / width, th / height],
      });
    }
  return { image: { data, width, height }, regions, columns, rows, tileWidth: tw, tileHeight: th, padding: p };
}
/**
 * Moves UV pairs written for the source grid onto `grid`'s padded atlas. `tiles` names each vertex's tile as an index
 * `row * columns + column` (UVs on a shared tile edge are ambiguous, so the caller says which tile a vertex belongs
 * to); a UV outside its tile is kept at the same offset from it. `sourceWidth`/`sourceHeight` and `margin`/`spacing`
 * describe the source image as passed to {@link padTileGrid}.
 */
export function remapTileUVs(
  uvs: ArrayLike<number>,
  tiles: ArrayLike<number>,
  grid: TileGridAtlas,
  source: { width: number; height: number; margin?: number; spacing?: number },
): Float32Array {
  if (tiles.length * 2 !== uvs.length)
    throw new RangeError('remapTileUVs needs one tile index per UV pair; pass tiles of length uvs.length / 2');
  const { width, height, margin = 0, spacing = 0 } = source,
    out = new Float32Array(uvs.length);
  for (let i = 0; i < tiles.length; i++) {
    const tile = tiles[i];
    if (!Number.isInteger(tile) || tile < 0 || tile >= grid.regions.length)
      throw new RangeError(`remapTileUVs tile ${tile} is not in the grid; use 0 to ${grid.regions.length - 1}`);
    const column = tile % grid.columns,
      row = Math.floor(tile / grid.columns),
      // Position inside the tile, in tile units, from the source tile's own corner (v counted like the image rows).
      u = (uvs[i * 2] * width - (margin + column * (grid.tileWidth + spacing))) / grid.tileWidth,
      v = (uvs[i * 2 + 1] * height - (margin + row * (grid.tileHeight + spacing))) / grid.tileHeight,
      r = grid.regions[tile];
    out[i * 2] = r.offset![0] + u * r.scale![0];
    out[i * 2 + 1] = r.offset![1] + v * r.scale![1];
  }
  return out;
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
