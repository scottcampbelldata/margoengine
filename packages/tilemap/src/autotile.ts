import { GID_MASK, type TileLayer } from './index.js';

function reduceBlob(mask: number): number {
  let m = mask & 255;
  if (!(m & 1 && m & 4)) m &= ~2;
  if (!(m & 4 && m & 16)) m &= ~8;
  if (!(m & 16 && m & 64)) m &= ~32;
  if (!(m & 64 && m & 1)) m &= ~128;
  return m;
}

/** The 47 distinct blob masks, ascending. Bits: N 1, NE 2, E 4, SE 8, S 16, SW 32, W 64, NW 128. */
export const BLOB_MASKS: readonly number[] = (() => {
  const seen = new Set<number>();
  for (let m = 0; m < 256; m++) seen.add(reduceBlob(m));
  return [...seen].sort((a, b) => a - b);
})();

const BLOB_INDEX = new Map(BLOB_MASKS.map((m, i) => [m, i]));

/** Bitmask of the four edge neighbours: N 1, E 2, S 4, W 8. Any truthy argument counts as filled. */
export function cardinalMask(n: unknown, e: unknown, s: unknown, w: unknown): number {
  return (n ? 1 : 0) | (e ? 2 : 0) | (s ? 4 : 0) | (w ? 8 : 0);
}

/**
 * Bitmask of all eight neighbours for blob tiling, reduced: a corner only counts when both edges beside it are
 * filled, so the 256 raw cases collapse to the 47 values in `BLOB_MASKS`. Bits: N 1, NE 2, E 4, SE 8, S 16, SW 32, W 64, NW 128.
 */
export function blobMask(
  n: unknown,
  ne: unknown,
  e: unknown,
  se: unknown,
  s: unknown,
  sw: unknown,
  w: unknown,
  nw: unknown,
): number {
  return reduceBlob(
    (n ? 1 : 0) |
      (ne ? 2 : 0) |
      (e ? 4 : 0) |
      (se ? 8 : 0) |
      (s ? 16 : 0) |
      (sw ? 32 : 0) |
      (w ? 64 : 0) |
      (nw ? 128 : 0),
  );
}

/** Position of a reduced blob mask in `BLOB_MASKS` (0..46). Throws a RangeError for a mask that is not reduced. */
export function blobIndex(mask: number): number {
  const i = BLOB_INDEX.get(mask);
  if (i === undefined) throw new RangeError(`${mask} is not a reduced blob mask; build it with blobMask().`);
  return i;
}

/**
 * Tile choices as data. `cardinal`: 16 tiles indexed by `cardinalMask`. `blob`: 47 tiles in `BLOB_MASKS` order.
 * `tiles` hold tile ids local to the tileset.
 */
export interface AutotileRuleSet {
  readonly mode: 'cardinal' | 'blob';
  readonly tiles: readonly number[];
}

/** Options of `autotileGrid` and `autotile`. */
export interface AutotileOptions {
  /** Global id of the tileset's first tile, added to each rule tile. Default 1. */
  readonly firstGid?: number;
  /** Whether cells beyond the map edge count as filled (the terrain continues off the map). Default false. */
  readonly outside?: boolean;
}

/**
 * Pick a tile for every filled cell of a `width x height` grid from the filled neighbours. Returns global tile
 * values, 0 where the grid is empty. The same input always gives the same output.
 */
export function autotileGrid(
  filled: ArrayLike<unknown>,
  width: number,
  height: number,
  rules: AutotileRuleSet,
  options: AutotileOptions = {},
): Uint32Array {
  const want = rules.mode === 'blob' ? 47 : rules.mode === 'cardinal' ? 16 : -1;
  if (want < 0) throw new TypeError(`rules.mode must be 'cardinal' or 'blob', got '${String(rules.mode)}'.`);
  if (rules.tiles.length !== want)
    throw new RangeError(`a ${rules.mode} rule set needs ${want} tiles, got ${rules.tiles.length}; list one per case.`);
  if (filled.length !== width * height)
    throw new RangeError(`grid has ${filled.length} cells for ${width} x ${height}; pass width * height of them.`);
  const base = options.firstGid ?? 1;
  const out = options.outside ?? false;
  const at = (x: number, y: number): boolean =>
    x < 0 || y < 0 || x >= width || y >= height ? out : !!filled[y * width + x];
  const result = new Uint32Array(width * height);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      if (!filled[y * width + x]) continue;
      const index =
        rules.mode === 'blob'
          ? blobIndex(
              blobMask(
                at(x, y - 1),
                at(x + 1, y - 1),
                at(x + 1, y),
                at(x + 1, y + 1),
                at(x, y + 1),
                at(x - 1, y + 1),
                at(x - 1, y),
                at(x - 1, y - 1),
              ),
            )
          : cardinalMask(at(x, y - 1), at(x + 1, y), at(x, y + 1), at(x - 1, y));
      result[y * width + x] = base + rules.tiles[index];
    }
  return result;
}

/**
 * Auto-tile a tile layer: cells that `matches` (default: any tile) get the tile their neighbours call for, other
 * cells are copied unchanged. Returns a new layer.
 */
export function autotile(
  layer: TileLayer,
  rules: AutotileRuleSet,
  options: AutotileOptions & { readonly matches?: (value: number) => boolean } = {},
): TileLayer {
  const test = options.matches ?? ((v: number) => (v & GID_MASK) !== 0);
  const filled = new Uint8Array(layer.data.length);
  for (let i = 0; i < filled.length; i++) filled[i] = test(layer.data[i]) ? 1 : 0;
  const tiles = autotileGrid(filled, layer.width, layer.height, rules, options);
  const data = new Uint32Array(layer.data);
  for (let i = 0; i < data.length; i++) if (filled[i]) data[i] = tiles[i];
  return { ...layer, data };
}

/** A tile for terrain matching: terrain ids at its corners, top left, top right, bottom right, bottom left. */
export interface TerrainTile {
  /** Tile id local to the tileset. */
  readonly tile: number;
  readonly corners: readonly [number, number, number, number];
  /** Chance weight among tiles with the same corners. Default 1. */
  readonly weight?: number;
}

/** Tiles tagged by the terrain at their corners. */
export interface TerrainSet {
  readonly tiles: readonly TerrainTile[];
}

/** Options of `resolveTerrain`. */
export interface TerrainOptions {
  /** Global id of the tileset's first tile. Default 1. */
  readonly firstGid?: number;
  /** Changes which of several matching tiles is picked; the same seed always gives the same map. Default 0. */
  readonly seed?: number;
}

function hash(x: number, y: number, seed: number): number {
  let h = (Math.imul(x, 0x27d4eb2d) ^ Math.imul(y, 0x165667b1) ^ Math.imul(seed, 0x9e3779b1)) >>> 0;
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/**
 * Pick the tile whose four corners equal the terrain at the four corners of each cell. `vertices` is the
 * `(width + 1) x (height + 1)` grid of corner terrain ids. Cells no tile matches stay 0. Several matches are
 * chosen by weight with a hash of the cell and seed, so the result is deterministic.
 */
export function resolveTerrain(
  vertices: ArrayLike<number>,
  width: number,
  height: number,
  set: TerrainSet,
  options: TerrainOptions = {},
): Uint32Array {
  const stride = width + 1;
  if (vertices.length !== stride * (height + 1))
    throw new RangeError(
      `vertex grid has ${vertices.length} values, expected ${stride * (height + 1)}; pass (width + 1) * (height + 1).`,
    );
  const base = options.firstGid ?? 1;
  const seed = options.seed ?? 0;
  const out = new Uint32Array(width * height);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const tl = vertices[y * stride + x];
      const tr = vertices[y * stride + x + 1];
      const br = vertices[(y + 1) * stride + x + 1];
      const bl = vertices[(y + 1) * stride + x];
      let total = 0;
      const found: TerrainTile[] = [];
      for (const t of set.tiles)
        if (t.corners[0] === tl && t.corners[1] === tr && t.corners[2] === br && t.corners[3] === bl) {
          found.push(t);
          total += t.weight ?? 1;
        }
      if (found.length === 0) continue;
      let pick = hash(x, y, seed) * total;
      let chosen = found[found.length - 1];
      for (const t of found) {
        pick -= t.weight ?? 1;
        if (pick < 0) {
          chosen = t;
          break;
        }
      }
      out[y * width + x] = base + chosen.tile;
    }
  return out;
}

/**
 * Corner terrain from painted cells: each corner takes the highest terrain id among the cells that touch it, so
 * 0 (nothing) loses to any terrain. Returns the `(width + 1) x (height + 1)` grid for `resolveTerrain`.
 */
export function verticesFromCells(cells: ArrayLike<number>, width: number, height: number): Uint8Array {
  if (cells.length !== width * height)
    throw new RangeError(`grid has ${cells.length} cells for ${width} x ${height}; pass width * height of them.`);
  const stride = width + 1;
  const out = new Uint8Array(stride * (height + 1));
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const v = cells[y * width + x];
      for (const [dx, dy] of [
        [0, 0],
        [1, 0],
        [0, 1],
        [1, 1],
      ] as const) {
        const i = (y + dy) * stride + x + dx;
        if (v > out[i]) out[i] = v;
      }
    }
  return out;
}
