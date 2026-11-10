// Clean-room view refinement: OGC 3D Tiles 1.1 section 6.7, Losasso and Hoppe (2004).
import { rangeError } from '../../shared/errors.js';
import { project, unproject, type Projection } from './geo.js';

/** XYZ Web Mercator tile address. */
export interface GeoTile {
  readonly z: number;
  readonly x: number;
  readonly y: number;
}
/** Data-to-clip transform and physical viewport pixels. Recompute after camera motion or resize. */
export interface GeoTileView {
  readonly matrix: ArrayLike<number>;
  readonly width: number;
  readonly height: number;
}
/** View refinement options. */
export interface GeoLodSelection {
  /** Default mercator. */
  readonly projection?: Projection;
  /** Deepest source level, default 15. */
  readonly maxZoom?: number;
  /** Maximum selected tiles, default 64. */
  readonly tileBudget?: number;
  /** Refine above this projected tile span in pixels, default 256. */
  readonly tilePixels?: number;
}
/** Stable XYZ cache key. */
export const geoTileKey = (tile: GeoTile): string => `${tile.z}/${tile.x}/${tile.y}`;
/** Four children in northwest, northeast, southwest, southeast order. */
export const geoTileChildren = (t: GeoTile): GeoTile[] =>
  [0, 1, 2, 3].map((i) => ({ z: t.z + 1, x: t.x * 2 + (i % 2), y: t.y * 2 + Math.floor(i / 2) }));
/** Ancestors, root first, including the tile. */
export function geoTileAncestors(t: GeoTile): GeoTile[] {
  return Array.from({ length: t.z + 1 }, (_, z) => ({
    z,
    x: Math.floor(t.x / 2 ** (t.z - z)),
    y: Math.floor(t.y / 2 ** (t.z - z)),
  }));
}
/** Longitude/latitude at a tile-local coordinate (u and v in 0..1). */
export function geoTileLonLat(t: GeoTile, u: number, v: number): [number, number] {
  const n = 2 ** t.z;
  return unproject((2 * (t.x + u)) / n - 1, 1 - (2 * (t.y + v)) / n);
}

// A conservative Cartesian box encloses a globe patch. Sampling includes all extrema of sin/cos at quadrant
// boundaries for XYZ levels 0..2, and the latitude extrema at the equator, so curved root tiles are not culled
// because their corners coincide at the dateline. Clip the box, not just its visible corners.
function span(t: GeoTile, view: GeoTileView, projection: Projection): number {
  const lo = [Infinity, Infinity, Infinity],
    hi = [-Infinity, -Infinity, -Infinity];
  for (let v = 0; v <= 4; v++)
    for (let u = 0; u <= 4; u++) {
      const [lon, lat] = geoTileLonLat(t, u / 4, v / 4),
        p = project(lon, lat, 12000, projection);
      for (let k = 0; k < 3; k++) {
        lo[k] = Math.min(lo[k], p[k]);
        hi[k] = Math.max(hi[k], p[k]);
      }
      const ground = project(lon, lat, -12000, projection);
      for (let k = 0; k < 3; k++) {
        lo[k] = Math.min(lo[k], ground[k]);
        hi[k] = Math.max(hi[k], ground[k]);
      }
    }
  const clips: number[][] = [],
    m = view.matrix;
  for (let i = 0; i < 8; i++) {
    const x = i & 1 ? hi[0] : lo[0],
      y = i & 2 ? hi[1] : lo[1],
      z = i & 4 ? hi[2] : lo[2];
    clips.push([0, 1, 2, 3].map((k) => m[k] * x + m[k + 4] * y + m[k + 8] * z + m[k + 12]));
  }
  if (
    [0, 1, 2, 3, 4, 5].some((plane) =>
      clips.every((p) => {
        if (plane === 4) return p[2] < 0;
        if (plane === 5) return p[2] > p[3];
        return (plane % 2 ? -1 : 1) * p[Math.floor(plane / 2)] > p[3];
      }),
    )
  )
    return 0;
  if (clips.some((p) => p[3] <= 0)) return Infinity;
  const xs = clips.map((p) => p[0] / p[3]),
    ys = clips.map((p) => p[1] / p[3]);
  return Math.max(
    ((Math.max(...xs) - Math.min(...xs)) * view.width) / 2,
    ((Math.max(...ys) - Math.min(...ys)) * view.height) / 2,
  );
}

/** Best-first quadtree selection. Refines the largest visible tile first, never exceeding the leaf budget. */
export function selectGeoTiles(view: GeoTileView, options: GeoLodSelection = {}): GeoTile[] {
  const maxZoom = options.maxZoom ?? 15,
    budget = options.tileBudget ?? 64,
    pixels = options.tilePixels ?? 256;
  if (
    view.matrix.length !== 16 ||
    !Array.from(view.matrix).every(Number.isFinite) ||
    !(view.width > 0 && Number.isFinite(view.width)) ||
    !(view.height > 0 && Number.isFinite(view.height))
  )
    throw rangeError('Tile view needs a finite 4x4 matrix and positive viewport', 'sciviz');
  if (
    !Number.isInteger(maxZoom) ||
    maxZoom < 0 ||
    maxZoom > 24 ||
    !Number.isInteger(budget) ||
    budget < 1 ||
    budget > 65536 ||
    !(pixels > 0 && Number.isFinite(pixels))
  )
    throw rangeError('Tile selection needs maxZoom 0..24, tileBudget 1..65536 and positive tilePixels', 'sciviz');
  const projection = options.projection ?? 'mercator';
  const root = { z: 0, x: 0, y: 0 },
    size = span(root, view, projection);
  const leaves = size ? [{ tile: root, size, stopped: false }] : [];
  for (;;) {
    let index = -1,
      largest = pixels;
    for (let i = 0; i < leaves.length; i++)
      if (!leaves[i].stopped && leaves[i].tile.z < maxZoom && leaves[i].size > largest) {
        index = i;
        largest = leaves[i].size;
      }
    if (index < 0) break;
    const children = geoTileChildren(leaves[index].tile)
      .map((tile) => ({ tile, size: span(tile, view, projection), stopped: false }))
      .filter((t) => t.size > 0);
    if (leaves.length - 1 + children.length > budget) {
      leaves[index].stopped = true;
      continue;
    }
    leaves.splice(index, 1, ...children);
  }
  return leaves.map((l) => l.tile);
}

/** Regular tile heights, metres, row-major from northwest. */
export interface GeoTileElevation {
  readonly heights: Float32Array;
  readonly width: number;
  readonly height: number;
}
/** Bilinear height at tile-local coordinates, clamped at the source edges. */
export function geoTileHeight(e: GeoTileElevation | undefined, u: number, v: number): number {
  if (!e) return 0;
  const x = Math.max(0, Math.min(e.width - 1, u * e.width - 0.5)),
    y = Math.max(0, Math.min(e.height - 1, v * e.height - 0.5)),
    i = Math.floor(x),
    j = Math.floor(y),
    dx = x - i,
    dy = y - j;
  const a = e.heights[j * e.width + i],
    b = e.heights[j * e.width + Math.min(i + 1, e.width - 1)],
    c = e.heights[Math.min(j + 1, e.height - 1) * e.width + i],
    d = e.heights[Math.min(j + 1, e.height - 1) * e.width + Math.min(i + 1, e.width - 1)];
  return (a * (1 - dx) + b * dx) * (1 - dy) + (c * (1 - dx) + d * dx) * dy;
}
/** Projected tile mesh, with downward skirts along all four edges. Each vertex is x,y,z,u,v. */
export function geoTileMesh(
  t: GeoTile,
  projection: Projection,
  elevation?: GeoTileElevation,
  segments = 32,
  skirt = 1000,
): { vertices: Float32Array; indices: Uint32Array } {
  if (!Number.isInteger(segments) || segments < 1 || segments > 256 || !Number.isFinite(skirt) || skirt < 0)
    throw rangeError('Tile mesh needs segments 1..256 and nonnegative skirt metres', 'sciviz');
  if (
    elevation &&
    (!Number.isInteger(elevation.width) ||
      elevation.width < 1 ||
      !Number.isInteger(elevation.height) ||
      elevation.height < 1 ||
      elevation.heights.length !== elevation.width * elevation.height ||
      !elevation.heights.every(Number.isFinite))
  )
    throw rangeError('Elevation dimensions must match finite height samples', 'sciviz');
  const vertices: number[] = [],
    indices: number[] = [],
    n = segments + 1;
  const vertex = (u: number, v: number, drop = 0) => {
    const [lon, lat] = geoTileLonLat(t, u, v);
    vertices.push(...project(lon, lat, geoTileHeight(elevation, u, v) - drop, projection), u, v);
    return vertices.length / 5 - 1;
  };
  for (let y = 0; y <= segments; y++) for (let x = 0; x <= segments; x++) vertex(x / segments, y / segments);
  for (let y = 0; y < segments; y++)
    for (let x = 0; x < segments; x++) {
      const a = y * n + x;
      indices.push(a, a + n, a + 1, a + 1, a + n, a + n + 1);
    }
  for (let edge = 0; edge < 4; edge++) {
    let previous = -1;
    for (let i = 0; i <= segments; i++) {
      const x = edge === 0 ? i : edge === 1 ? segments : edge === 2 ? segments - i : 0,
        y = edge === 0 ? 0 : edge === 1 ? i : edge === 2 ? segments : segments - i;
      const base = y * n + x,
        down = vertex(x / segments, y / segments, skirt);
      if (i) indices.push(previous, down - 1, base, base, down - 1, down);
      previous = base;
    }
  }
  return { vertices: new Float32Array(vertices), indices: new Uint32Array(indices) };
}
