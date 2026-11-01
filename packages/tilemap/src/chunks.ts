import { hexColor } from '@margoengine/math';
import { GID_MASK, type MapTileset, type TileAnimationStep, type TileLayer } from './index.js';

/** Tiles per side of a renderer chunk. */
export const TILE_CHUNK_SIZE = 64;
/** Tiles in one renderer chunk. */
export const CHUNK_CELLS = TILE_CHUNK_SIZE * TILE_CHUNK_SIZE;

/** Chunks across and down a layer of `width x height` tiles; an empty layer has none. */
export function chunkGrid(width: number, height: number): { chunksWide: number; chunksHigh: number } {
  return { chunksWide: Math.ceil(width / TILE_CHUNK_SIZE), chunksHigh: Math.ceil(height / TILE_CHUNK_SIZE) };
}

/** Copies chunk `(chunkX, chunkY)` of a layer into `out` (`CHUNK_CELLS` values, row by row); cells past the layer are 0. */
export function fillChunk(layer: TileLayer, chunkX: number, chunkY: number, out: Uint32Array): void {
  const left = chunkX * TILE_CHUNK_SIZE,
    top = chunkY * TILE_CHUNK_SIZE,
    wide = Math.max(0, Math.min(TILE_CHUNK_SIZE, layer.width - left)),
    high = Math.max(0, Math.min(TILE_CHUNK_SIZE, layer.height - top));
  out.fill(0);
  for (let y = 0; y < high; y++) {
    const from = (top + y) * layer.width + left;
    out.set(layer.data.subarray(from, from + wide), y * TILE_CHUNK_SIZE);
  }
}

/**
 * Counts how many cells of `values` belong to each tileset in `tilesets` (sorted by `firstGid`) into `counts` at `at`.
 * Empty cells and ids past every tileset count for nothing.
 */
export function countTilesets(
  values: Uint32Array,
  tilesets: readonly MapTileset[],
  counts: Uint32Array,
  at: number,
): void {
  counts.fill(0, at, at + tilesets.length);
  let last = 0;
  for (let i = 0; i < values.length; i++) {
    const gid = values[i] & GID_MASK;
    if (!gid) continue;
    let set = tilesets[last];
    if (!set || gid < set.firstGid || gid >= set.firstGid + set.tileCount) {
      last = tilesets.findIndex((s) => gid >= s.firstGid && gid < s.firstGid + s.tileCount);
      if (last < 0) {
        last = 0;
        continue;
      }
      set = tilesets[last];
    }
    counts[at + last]++;
  }
}

/** How far drawn tiles can reach past their cell, in map pixels. */
export interface TileReach {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
}

/**
 * The reach of a map's tilesets. A tile sits on the bottom left of its cell, so one bigger than the cell reaches up and
 * right, and a diagonal flip swaps its width and height. `tileOffset` moves it further.
 */
export function tileReach(tilesets: readonly MapTileset[], cellWidth: number, cellHeight: number): TileReach {
  let left = 0,
    top = 0,
    right = 0,
    bottom = 0;
  for (const set of tilesets) {
    const side = Math.max(set.tileWidth, set.tileHeight),
      x = set.tileOffset?.[0] ?? 0,
      y = set.tileOffset?.[1] ?? 0;
    left = Math.max(left, -x);
    top = Math.max(top, side - cellHeight - y);
    right = Math.max(right, side - cellWidth + x);
    bottom = Math.max(bottom, y);
  }
  return { left, top, right, bottom };
}

/** The chunks a target shows, inclusive; empty when `lastX < firstX` or `lastY < firstY`. */
export interface ChunkRange {
  firstX: number;
  firstY: number;
  lastX: number;
  lastY: number;
}

/**
 * Which chunks can show in a `targetWidth x targetHeight` target when the layer's top left lands at pixel
 * `(originX, originY)` and `zoom` target pixels make one map pixel. Writes to `out` and returns it.
 */
export function visibleChunks(
  originX: number,
  originY: number,
  zoom: number,
  targetWidth: number,
  targetHeight: number,
  cellWidth: number,
  cellHeight: number,
  chunksWide: number,
  chunksHigh: number,
  reach: TileReach,
  out: ChunkRange = { firstX: 0, firstY: 0, lastX: -1, lastY: -1 },
): ChunkRange {
  const wide = cellWidth * TILE_CHUNK_SIZE * zoom,
    high = cellHeight * TILE_CHUNK_SIZE * zoom;
  // A chunk from x to x + wide draws from x - left to x + wide + right, in target pixels.
  out.firstX = Math.max(0, Math.floor((-originX - reach.right * zoom) / wide));
  out.firstY = Math.max(0, Math.floor((-originY - reach.bottom * zoom) / high));
  out.lastX = Math.min(chunksWide - 1, Math.ceil((targetWidth - originX + reach.left * zoom) / wide) - 1);
  out.lastY = Math.min(chunksHigh - 1, Math.ceil((targetHeight - originY + reach.top * zoom) / high) - 1);
  return out;
}

/** The local tile an animation shows at `time` milliseconds, looping. An empty animation returns -1. */
export function animatedTile(animation: readonly TileAnimationStep[], time: number): number {
  let total = 0;
  for (const step of animation) total += step.duration;
  if (!(total > 0)) return -1;
  let left = ((time % total) + total) % total;
  for (const step of animation) {
    if (left < step.duration) return step.tileId;
    left -= step.duration;
  }
  return animation[animation.length - 1].tileId;
}

/** A map colour `#rrggbb` or `#aarrggbb` as `[r, g, b, a]` from 0 to 1, or undefined when it is neither. */
export function mapColor(text: string | undefined): [number, number, number, number] | undefined {
  if (!text) return undefined;
  // Tiled and LDtk put alpha first; hexColor reads it last.
  return hexColor(text.length === 9 ? `#${text.slice(3)}${text.slice(1, 3)}` : text);
}
