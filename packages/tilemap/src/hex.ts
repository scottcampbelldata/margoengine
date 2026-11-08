// Hexagonal map cells as cube coordinates, for distances, rings and lines on Tiled's hexagonal (and staggered) maps.
// Offset cells (Tiled's column and row) map to cube coordinates q + r + s = 0, where a hex step changes two of them by
// one, so the distance is the largest change (A. Patel, "Hexagonal Grids", Red Blob Games, 2013, sections on offset
// and cube coordinates, distances, rounding and line drawing).
import { cellNeighbors, type MapGrid } from './layout.js';

export {
  cellBox,
  cellCenter,
  cellNeighbors,
  cellPolygon,
  mapPixelSize,
  paintOrder,
  pixelToCell,
  type CellBox,
  type MapGrid,
} from './layout.js';

/** Cube coordinates of a hex cell: `q + r + s = 0`. */
export type Cube = readonly [q: number, r: number, s: number];

const axis = (map: MapGrid): { y: boolean; odd: boolean } => {
  if (map.orientation !== 'hexagonal' && map.orientation !== 'staggered')
    throw new RangeError(`hex cells need a hexagonal or staggered map, got "${map.orientation ?? 'orthogonal'}".`);
  return { y: (map.staggerAxis ?? 'y') === 'y', odd: (map.staggerIndex ?? 'odd') === 'odd' };
};

/** The cube coordinates of map cell (`x`, `y`). */
export function cellToCube(map: MapGrid, x: number, y: number): Cube {
  const { y: rows, odd } = axis(map);
  // Along the stagger axis the cube r is the row; across it each pair of rows shifts q by one. The pushed half of a pair
  // (odd or even) decides which way the half rounds.
  if (rows) {
    const q = x - (odd ? (y - (y & 1)) / 2 : (y + (y & 1)) / 2);
    return [q, y, -q - y];
  }
  const r = y - (odd ? (x - (x & 1)) / 2 : (x + (x & 1)) / 2);
  return [x, r, -x - r];
}

/** The map cell of cube coordinates `cube`. */
export function cubeToCell(map: MapGrid, [q, r]: Cube): [number, number] {
  const { y: rows, odd } = axis(map);
  if (rows) return [q + (odd ? (r - (r & 1)) / 2 : (r + (r & 1)) / 2), r];
  return [q, r + (odd ? (q - (q & 1)) / 2 : (q + (q & 1)) / 2)];
}

/** Steps between two cells over shared edges (hexagonal maps) or shared edges and corners (staggered maps' rows). */
export function hexDistance(map: MapGrid, a: readonly [number, number], b: readonly [number, number]): number {
  const [aq, ar, as] = cellToCube(map, a[0], a[1]),
    [bq, br, bs] = cellToCube(map, b[0], b[1]);
  return Math.max(Math.abs(aq - bq), Math.abs(ar - br), Math.abs(as - bs));
}

/** The nearest cube to fractional cube coordinates: round all three, then fix the one that moved most. */
export function roundCube(q: number, r: number, s: number): Cube {
  let rq = Math.round(q),
    rr = Math.round(r),
    rs = Math.round(s);
  const dq = Math.abs(rq - q),
    dr = Math.abs(rr - r),
    ds = Math.abs(rs - s);
  if (dq > dr && dq > ds) rq = -rr - rs;
  else if (dr > ds) rr = -rq - rs;
  else rs = -rq - rr;
  return [rq + 0, rr + 0, rs + 0];
}

/**
 * The cells on the straight line from `a` to `b`, both included, one per step: the cube points at equal fractions of
 * the way, nudged by a millionth so a line along an edge always picks the same side, rounded to cells.
 */
export function hexLine(map: MapGrid, a: readonly [number, number], b: readonly [number, number]): [number, number][] {
  const n = hexDistance(map, a, b),
    [aq, ar, as] = cellToCube(map, a[0], a[1]),
    [bq, br, bs] = cellToCube(map, b[0], b[1]),
    out: [number, number][] = [];
  for (let i = 0; i <= n; i++) {
    const t = n ? i / n : 0;
    out.push(
      cubeToCell(map, roundCube(aq + (bq - aq) * t + 1e-6, ar + (br - ar) * t + 1e-6, as + (bs - as) * t - 2e-6)),
    );
  }
  return out;
}

/** The cells exactly `radius` steps from (`x`, `y`), walking the ring from one corner; the cell itself for radius 0. */
export function hexRing(map: MapGrid, x: number, y: number, radius: number): [number, number][] {
  if (!Number.isInteger(radius) || radius < 0)
    throw new RangeError(`radius must be a whole number of 0 or more, got ${radius}.`);
  if (!radius) return [[x, y]];
  const [q, r, s] = cellToCube(map, x, y),
    // The six cube directions, in turn round the ring.
    dirs: Cube[] = [
      [1, -1, 0],
      [1, 0, -1],
      [0, 1, -1],
      [-1, 1, 0],
      [-1, 0, 1],
      [0, -1, 1],
    ],
    out: [number, number][] = [];
  let c: Cube = [q + dirs[4][0] * radius, r + dirs[4][1] * radius, s + dirs[4][2] * radius];
  for (const d of dirs)
    for (let i = 0; i < radius; i++) {
      out.push(cubeToCell(map, c));
      c = [c[0] + d[0], c[1] + d[1], c[2] + d[2]];
    }
  return out;
}

/** True when two cells share an edge: a {@link cellNeighbors} pair. */
export function hexAdjacent(map: MapGrid, a: readonly [number, number], b: readonly [number, number]): boolean {
  return cellNeighbors(map, a[0], a[1]).some(([x, y]) => x === b[0] && y === b[1]);
}
