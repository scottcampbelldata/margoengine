import type { Vec2 } from '@margoengine/math';

export {
  TileMap,
  type TileAtlas,
  type TileCamera,
  type TileMapOptions,
  type TileMapStats,
  type TilePixels,
  type TileTarget,
} from './renderer.js';
export {
  animatedTile,
  TILE_CHUNK_SIZE,
  chunkGrid,
  fillChunk,
  mapColor,
  tileReach,
  visibleChunks,
  type ChunkRange,
  type TileReach,
} from './chunks.js';

/** A property value as Tiled and LDtk store it: text, numbers, booleans, lists, or nested objects (Tiled "class"). */
export type PropertyValue =
  | string
  | number
  | boolean
  | null
  | readonly PropertyValue[]
  | { readonly [key: string]: PropertyValue };
/** Custom properties by name. */
export type Properties = { readonly [name: string]: PropertyValue };

/** Tiled's flip bit in a tile layer value: mirrored left to right. */
export const FLIP_H = 0x80000000;
/** Tiled's flip bit: mirrored top to bottom. */
export const FLIP_V = 0x40000000;
/** Tiled's flip bit: mirrored across the main diagonal (applied first; with `FLIP_H` it is a 90 degree turn). */
export const FLIP_D = 0x20000000;
/** All flip bits that carry meaning for orthogonal maps. */
export const FLIP_MASK = 0xe0000000;
/** Bits of a layer value that hold the global tile id (Tiled also reserves bit 28 for hex maps; it is cleared here). */
export const GID_MASK = 0x0fffffff;

/** Collision or object shape in pixels. `x`/`y` are from the tile's top left (collision) or the owning object's origin. */
export type MapShape =
  | {
      readonly kind: 'rect';
      readonly x: number;
      readonly y: number;
      readonly width: number;
      readonly height: number;
      readonly rotation?: number;
    }
  | {
      readonly kind: 'ellipse';
      readonly x: number;
      readonly y: number;
      readonly width: number;
      readonly height: number;
      readonly rotation?: number;
    }
  | { readonly kind: 'point'; readonly x: number; readonly y: number }
  | {
      readonly kind: 'polygon';
      readonly x: number;
      readonly y: number;
      readonly points: readonly Vec2[];
      readonly rotation?: number;
    }
  | {
      readonly kind: 'polyline';
      readonly x: number;
      readonly y: number;
      readonly points: readonly Vec2[];
      readonly rotation?: number;
    };

/** One frame of a tile animation: show `tileId` (local to the tileset) for `duration` milliseconds. */
export interface TileAnimationStep {
  readonly tileId: number;
  readonly duration: number;
}

/** Per-tile data. Only tiles with something to say need an entry. */
export interface TileDef {
  /** Local id, 0-based within the tileset. */
  readonly id: number;
  /** Free-form class or type name. */
  readonly type?: string;
  readonly properties?: Properties;
  /** Animation frames in order; the tile loops through them. */
  readonly animation?: readonly TileAnimationStep[];
  /** Collision shapes in tile pixels, consumed by physics. Empty or missing means no collision. */
  readonly collision?: readonly MapShape[];
  /** Image collection tilesets only: this tile's own image. */
  readonly image?: { readonly source: string; readonly width: number; readonly height: number };
}

/** A tileset: one atlas image cut into a grid, or a collection of per-tile images. */
export interface MapTileset {
  readonly name: string;
  /** Global id of the first tile. Layer values from `firstGid` up to `firstGid + tileCount - 1` belong here. */
  readonly firstGid: number;
  readonly tileWidth: number;
  readonly tileHeight: number;
  readonly tileCount: number;
  /** Tiles per row of the atlas; 0 for image collections. */
  readonly columns: number;
  /** Pixels between tiles in the atlas. Default 0. */
  readonly spacing?: number;
  /** Pixels around the atlas edge. Default 0. */
  readonly margin?: number;
  /** Pixel shift applied when drawing these tiles. Default [0, 0]. */
  readonly tileOffset?: Vec2;
  /** The atlas image. Missing for image collections. */
  readonly image?: { readonly source: string; readonly width: number; readonly height: number };
  readonly tiles?: readonly TileDef[];
  readonly properties?: Properties;
}

/** Fields every layer shares. */
export interface LayerBase {
  readonly name: string;
  readonly id?: number;
  /** 0 to 1. Default 1. */
  readonly opacity?: number;
  /** Default true. */
  readonly visible?: boolean;
  /** Pixel shift of the whole layer. Default [0, 0]. */
  readonly offset?: Vec2;
  /** Scroll factor against the camera: 1 moves with the world, 0 stays on screen. Default [1, 1]. */
  readonly parallax?: Vec2;
  /** Multiplies the layer's colour, CSS `#rrggbb` or `#aarrggbb`. */
  readonly tint?: string;
  readonly properties?: Properties;
}

/** A grid of tile ids. */
export interface TileLayer extends LayerBase {
  readonly type: 'tile';
  /** Size in tiles. */
  readonly width: number;
  readonly height: number;
  /** `width * height` values, row by row from the top left. Low 28 bits: global tile id (0 is empty). High bits: `FLIP_H`, `FLIP_V`, `FLIP_D`. */
  readonly data: Uint32Array;
}

/** A placed object: a marker, region, spawn point or tile sprite. */
export interface MapObject {
  readonly id: number;
  readonly name?: string;
  readonly type?: string;
  /** Pixel position in the map. For a tile object it is the bottom left of the tile. */
  readonly x: number;
  readonly y: number;
  readonly rotation?: number;
  readonly visible?: boolean;
  /** Global tile id (with flip bits) for a tile object. */
  readonly gid?: number;
  /** Outline for non-tile objects. Its own `x`/`y` are 0 here: the object carries the position. */
  readonly shape?: MapShape;
  readonly properties?: Properties;
}

/** A layer of objects. */
export interface ObjectLayer extends LayerBase {
  readonly type: 'object';
  readonly objects: readonly MapObject[];
}

/** A tile layer or an object layer. */
export type MapLayer = TileLayer | ObjectLayer;

/** A whole map. Orthogonal only. */
export interface TileMapData {
  /** Size in tiles. */
  readonly width: number;
  readonly height: number;
  /** Tile size in pixels. */
  readonly tileWidth: number;
  readonly tileHeight: number;
  readonly tilesets: readonly MapTileset[];
  /** Drawn in order, first at the back. */
  readonly layers: readonly MapLayer[];
  /** CSS `#rrggbb` or `#aarrggbb`. */
  readonly backgroundColor?: string;
  readonly properties?: Properties;
}

/** A decoded layer value. */
export interface DecodedTile {
  /** Global tile id; 0 is empty. */
  readonly gid: number;
  readonly flipH: boolean;
  readonly flipV: boolean;
  readonly flipD: boolean;
}

/** Split a layer value into its global id and flip flags. */
export function decodeTile(value: number): DecodedTile {
  const v = value >>> 0;
  return { gid: v & GID_MASK, flipH: (v & FLIP_H) !== 0, flipV: (v & FLIP_V) !== 0, flipD: (v & FLIP_D) !== 0 };
}

/** Build a layer value from a global id and flip flags (`FLIP_H | FLIP_V | FLIP_D`). Throws a RangeError for an id outside 0..268435455. */
export function encodeTile(gid: number, flags: number = 0): number {
  if (!Number.isInteger(gid) || gid < 0 || gid > GID_MASK)
    throw new RangeError(`gid must be an integer 0..${GID_MASK}, got ${gid}; split flip bits off with decodeTile.`);
  return (gid | (flags & FLIP_MASK)) >>> 0;
}

/** A tile layer of `width x height` tiles, empty unless `data` is given. */
export function createTileLayer(name: string, width: number, height: number, data?: Uint32Array): TileLayer {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 0 || height < 0)
    throw new RangeError(`layer size must be non-negative integers, got ${width} x ${height}.`);
  if (data && data.length !== width * height)
    throw new RangeError(
      `layer data has ${data.length} values, expected ${width * height}; pass width * height of them.`,
    );
  return { type: 'tile', name, width, height, data: data ?? new Uint32Array(width * height) };
}

/** The tileset that owns a layer value (flip bits ignored), or undefined for 0 and ids past every tileset. */
export function tilesetForGid(map: TileMapData, value: number): MapTileset | undefined {
  const gid = value & GID_MASK;
  if (gid === 0) return undefined;
  let best: MapTileset | undefined;
  for (const set of map.tilesets)
    if (set.firstGid <= gid && gid < set.firstGid + set.tileCount && (!best || set.firstGid > best.firstGid))
      best = set;
  return best;
}

/** The per-tile definition (animation, collision, properties) for a layer value, or undefined. */
export function tileDefForGid(map: TileMapData, value: number): TileDef | undefined {
  const set = tilesetForGid(map, value);
  if (!set) return undefined;
  const local = (value & GID_MASK) - set.firstGid;
  return set.tiles?.find((t) => t.id === local);
}

/** The raw layer value at tile `(x, y)`, or 0 outside the layer. */
export function tileAt(layer: TileLayer, x: number, y: number): number {
  return x >= 0 && y >= 0 && x < layer.width && y < layer.height ? layer.data[y * layer.width + x] : 0;
}

/**
 * Check a map's structure and throw on the first problem: a TypeError for a wrong shape, a RangeError for a bad
 * number. The message names the field and what to change.
 */
export function validateTileMap(map: TileMapData): void {
  const size = (v: number, what: string, min = 1) => {
    if (!Number.isInteger(v) || v < min)
      throw new RangeError(`${what} must be an integer of ${min} or more, got ${v}.`);
  };
  size(map.width, 'map.width', 0);
  size(map.height, 'map.height', 0);
  size(map.tileWidth, 'map.tileWidth');
  size(map.tileHeight, 'map.tileHeight');
  if (!Array.isArray(map.tilesets) || !Array.isArray(map.layers))
    throw new TypeError('map.tilesets and map.layers must be arrays; pass [] for none.');
  let end = 1;
  for (const set of [...map.tilesets].sort((a, b) => a.firstGid - b.firstGid)) {
    const at = `tileset "${set.name}"`;
    size(set.firstGid, `${at} firstGid`);
    size(set.tileCount, `${at} tileCount`, 0);
    size(set.tileWidth, `${at} tileWidth`);
    size(set.tileHeight, `${at} tileHeight`);
    if (set.firstGid < end)
      throw new RangeError(
        `${at} starts at gid ${set.firstGid}, inside the previous tileset (free from ${end}); raise its firstGid.`,
      );
    end = set.firstGid + set.tileCount;
    for (const tile of set.tiles ?? []) {
      if (!Number.isInteger(tile.id) || tile.id < 0 || tile.id >= set.tileCount)
        throw new RangeError(
          `${at} has a tile entry with id ${tile.id}, outside 0..${set.tileCount - 1}; raise tileCount or fix the id.`,
        );
      for (const f of tile.animation ?? []) {
        if (!Number.isInteger(f.tileId) || f.tileId < 0 || f.tileId >= set.tileCount)
          throw new RangeError(
            `${at} tile ${tile.id} animates to tile ${f.tileId}, outside 0..${set.tileCount - 1}; point it at a tile of this set.`,
          );
        if (!(f.duration > 0) || !Number.isFinite(f.duration))
          throw new RangeError(
            `${at} tile ${tile.id} has a frame duration of ${f.duration}; use a positive number of milliseconds.`,
          );
      }
    }
  }
  for (const layer of map.layers) {
    if (layer.opacity !== undefined && !(layer.opacity >= 0 && layer.opacity <= 1))
      throw new RangeError(`layer "${layer.name}" opacity must be 0..1, got ${layer.opacity}.`);
    if (layer.type === 'tile') {
      if (!(layer.data instanceof Uint32Array))
        throw new TypeError(
          `layer "${layer.name}" data must be a Uint32Array; wrap plain arrays with new Uint32Array(values).`,
        );
      if (layer.data.length !== layer.width * layer.height)
        throw new RangeError(
          `layer "${layer.name}" has ${layer.data.length} values for ${layer.width} x ${layer.height} tiles; resize the array to width * height.`,
        );
    } else if (layer.type === 'object') {
      if (!Array.isArray(layer.objects)) throw new TypeError(`layer "${layer.name}" objects must be an array.`);
    } else
      throw new TypeError(`layer "${(layer as { name?: string }).name}" has an unknown type; use 'tile' or 'object'.`);
  }
}
