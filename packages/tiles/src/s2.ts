// @margoengine/tiles/s2: S2 cell bounding volumes (3DTILES_bounding_volume_S2), as global datasets use them. Pass `s2`
// in `boundingVolumes` of `Tileset.load` or `TilesRenderer.load`; tilesets without S2 never load this module. Written
// from the extension's README (CesiumGS/3d-tiles, Complete): cell IDs and tokens, the quadratic projection, the cell
// extruded along ellipsoid normals between minimumHeight and maximumHeight, quadtree and octree implicit subdivision
// with Morton tile coordinates on the face's (i, j) grid; and from the S2 cell hierarchy guide (s2geometry.io): six
// cube faces, a Hilbert curve on each, odd faces mirrored so the curve runs on from face to face.
import { TileBounds, type BoundingVolumeExtension, type SplitBounds } from './bounds.js';
import { cartographicToEcef, eastNorthUpToEcef, WGS84_A, WGS84_B } from './wgs84.js';

/** An S2 cell: cube face 0 to 5, level 0 to 30, and its (i, j) position on the face's 2^level x 2^level grid. */
export interface S2Cell {
  readonly face: number;
  readonly level: number;
  readonly i: number;
  readonly j: number;
}

/** The extension's JSON: `token`, and heights in metres above the WGS84 ellipsoid. */
export interface S2VolumeJSON {
  token: string;
  minimumHeight: number;
  maximumHeight: number;
}

// The Hilbert curve visits the four subsquares of a square, in its canonical orientation, at (i, j) = (0, 0),
// (0, 1), (1, 1), (1, 0), written as i * 2 + j. A swapped square exchanges i and j, an inverted one flips both.
// The first subsquare's curve is swapped, the last is swapped and inverted, the middle two keep the parent's.
const SWAP = 1,
  INVERT = 2;
const POSITION_TO_IJ = [
  [0, 1, 3, 2],
  [0, 2, 3, 1],
  [3, 2, 0, 1],
  [3, 1, 0, 2],
];
const POSITION_TO_ORIENTATION = [SWAP, 0, 0, SWAP | INVERT];
const IJ_TO_POSITION = POSITION_TO_IJ.map((row) => [0, 1, 2, 3].map((ij) => row.indexOf(ij)));

const invalid = (token: unknown, why: string) =>
  new TypeError(`Invalid S2 token ${JSON.stringify(token)}: ${why}; give a cell's hex token such as "89c6c7"`);

/** Reads an S2 cell token (the cell ID in hex, trailing zeros dropped). Throws TypeError naming what is wrong. */
export function parseS2Token(token: string): S2Cell {
  if (typeof token !== 'string' || !/^[0-9a-fA-F]{1,16}$/.test(token)) throw invalid(token, 'not 1 to 16 hex digits');
  const id = BigInt(`0x${token.padEnd(16, '0')}`);
  if (id === 0n) throw invalid(token, 'zero is not a cell');
  const face = Number(id >> 61n);
  if (face > 5) throw invalid(token, `face ${face} does not exist (0 to 5)`);
  let zeros = 0;
  while (!((id >> BigInt(zeros)) & 1n)) zeros++;
  if (zeros % 2 || zeros > 60) throw invalid(token, 'the bit after the last child is misplaced');
  const level = (60 - zeros) / 2;
  let orientation = face & SWAP,
    i = 0,
    j = 0;
  for (let k = 0; k < level; k++) {
    const position = Number((id >> BigInt(59 - 2 * k)) & 3n),
      ij = POSITION_TO_IJ[orientation][position];
    i = i * 2 + (ij >> 1);
    j = j * 2 + (ij & 1);
    orientation ^= POSITION_TO_ORIENTATION[position];
  }
  return { face, level, i, j };
}

/** The token of a cell. Throws RangeError for a cell off its face's grid. */
export function s2Token({ face, level, i, j }: S2Cell): string {
  const n = 2 ** level;
  if (
    !Number.isInteger(face) ||
    face < 0 ||
    face > 5 ||
    !Number.isInteger(level) ||
    level < 0 ||
    level > 30 ||
    !Number.isInteger(i) ||
    !Number.isInteger(j) ||
    i < 0 ||
    j < 0 ||
    i >= n ||
    j >= n
  )
    throw new RangeError(
      `Invalid S2 cell ${JSON.stringify({ face, level, i, j })}; face 0-5, level 0-30, i and j on its grid`,
    );
  let id = BigInt(face) << 61n,
    orientation = face & SWAP;
  for (let k = 0; k < level; k++) {
    const bit = 2 ** (level - 1 - k),
      ij = (Math.floor(i / bit) % 2) * 2 + (Math.floor(j / bit) % 2),
      position = IJ_TO_POSITION[orientation][ij];
    id |= BigInt(position) << BigInt(59 - 2 * k);
    orientation ^= POSITION_TO_ORIENTATION[position];
  }
  id |= 1n << BigInt(60 - 2 * level);
  return id.toString(16).padStart(16, '0').replace(/0+$/, '');
}

/** The quadratic projection from face coordinate s (0 to 1) to cube coordinate u (-1 to 1). */
const quadratic = (s: number) => (s >= 0.5 ? (4 * s * s - 1) / 3 : (1 - 4 * (1 - s) * (1 - s)) / 3);

/** The point of the unit cube at (u, v) on `face` (not normalised). */
function cube(face: number, u: number, v: number): [number, number, number] {
  switch (face) {
    case 0:
      return [1, u, v];
    case 1:
      return [-u, 1, v];
    case 2:
      return [-u, -v, 1];
    case 3:
      return [-1, -v, -u];
    case 4:
      return [v, -1, -u];
    default:
      return [v, u, -1];
  }
}

/**
 * Longitude and latitude (radians) of a point of `cell` at fractions `s` and `t` (0 to 1) across it: the cube point's
 * direction, read as geodetic longitude and latitude on WGS84 as the extension does.
 */
export function s2LonLat(cell: S2Cell, s = 0.5, t = 0.5): [number, number] {
  const n = 2 ** cell.level,
    [x, y, z] = cube(cell.face, quadratic((cell.i + s) / n), quadratic((cell.j + t) / n));
  return [Math.atan2(y, x), Math.atan2(z, Math.hypot(x, y))];
}

/** Samples per cell side for the box; curvature between samples is added as padding. */
const SAMPLES = 16;

/**
 * An oriented box around `cell` extruded from `minimumHeight` to `maximumHeight` along the ellipsoid normals, in ECEF:
 * axes east, north and up at the cell's centre, sized by a grid of points on its bottom and top surfaces, then grown
 * by the largest gap between those points and the surface (the sagitta at the ellipsoid's largest curvature radius).
 */
export function s2CellBounds(
  cell: S2Cell,
  minimumHeight: number,
  maximumHeight: number,
  split?: SplitBounds,
): TileBounds {
  if (!Number.isFinite(minimumHeight) || !Number.isFinite(maximumHeight) || minimumHeight > maximumHeight)
    throw new RangeError(
      `Invalid S2 heights ${minimumHeight} and ${maximumHeight}; give finite metres with minimumHeight <= maximumHeight`,
    );
  const [lon, lat] = s2LonLat(cell),
    origin = cartographicToEcef(lon, lat, (minimumHeight + maximumHeight) / 2),
    frame = eastNorthUpToEcef(origin[0], origin[1], origin[2]),
    axes = [0, 4, 8].map((c) => [frame[c], frame[c + 1], frame[c + 2]]),
    low = [Infinity, Infinity, Infinity],
    high = [-Infinity, -Infinity, -Infinity],
    directions: number[][] = [];
  for (let a = 0; a <= SAMPLES; a++)
    for (let b = 0; b <= SAMPLES; b++) {
      const [plon, plat] = s2LonLat(cell, a / SAMPLES, b / SAMPLES);
      directions.push([Math.cos(plat) * Math.cos(plon), Math.cos(plat) * Math.sin(plon), Math.sin(plat)]);
      for (const h of [minimumHeight, maximumHeight]) {
        const p = cartographicToEcef(plon, plat, h);
        for (let k = 0; k < 3; k++) {
          const d = (p[0] - origin[0]) * axes[k][0] + (p[1] - origin[1]) * axes[k][1] + (p[2] - origin[2]) * axes[k][2];
          low[k] = Math.min(low[k], d);
          high[k] = Math.max(high[k], d);
        }
      }
    }
  // Largest angle between neighbouring samples (sides and diagonals of each grid square).
  let angle = 0;
  const at = (a: number, b: number) => directions[a * (SAMPLES + 1) + b];
  const between = (p: number[], q: number[]) => Math.acos(Math.min(1, p[0] * q[0] + p[1] * q[1] + p[2] * q[2]));
  for (let a = 0; a < SAMPLES; a++)
    for (let b = 0; b < SAMPLES; b++)
      angle = Math.max(
        angle,
        between(at(a, b), at(a + 1, b)),
        between(at(a, b), at(a, b + 1)),
        between(at(a, b), at(a + 1, b + 1)),
        between(at(a + 1, b), at(a, b + 1)),
      );
  const radius = (WGS84_A * WGS84_A) / WGS84_B + Math.max(maximumHeight, 0),
    pad = radius * (1 - Math.cos(angle / 2));
  const center = [...origin],
    half: number[] = [];
  for (let k = 0; k < 3; k++) {
    const mid = (low[k] + high[k]) / 2,
      extent = (high[k] - low[k]) / 2 + pad;
    for (let c = 0; c < 3; c++) center[c] += axes[k][c] * mid;
    half.push(axes[k][0] * extent, axes[k][1] * extent, axes[k][2] * extent);
  }
  return new TileBounds(center, half, { split });
}

/**
 * The bounds of an S2 volume JSON, with implicit subdivision: a quadtree tile (level, x, y) below it is the cell
 * (face, level + L, i * 2^level + x, j * 2^level + y) over the same heights; an octree tile also takes the z-th of
 * 2^level equal height slabs.
 */
export function s2Bounds(volume: S2VolumeJSON): TileBounds {
  if (!volume || typeof volume !== 'object')
    throw new TypeError('Invalid 3DTILES_bounding_volume_S2; give { token, minimumHeight, maximumHeight }');
  const root = parseS2Token(volume.token),
    { minimumHeight, maximumHeight } = volume;
  const split: SplitBounds = (scheme, level, x, y, z) => {
    const n = 2 ** level,
      cell = { face: root.face, level: root.level + level, i: root.i * n + x, j: root.j * n + y };
    if (cell.level > 30)
      throw new RangeError(`Implicit S2 tile level ${cell.level} is past S2's 30 levels; lower availableLevels`);
    if (scheme !== 'OCTREE') return s2CellBounds(cell, minimumHeight, maximumHeight);
    const slab = (maximumHeight - minimumHeight) / n;
    return s2CellBounds(cell, minimumHeight + slab * z, minimumHeight + slab * (z + 1));
  };
  return s2CellBounds(root, minimumHeight, maximumHeight, split);
}

/** The 3DTILES_bounding_volume_S2 reader: pass it as `boundingVolumes: [s2]` to `Tileset.load` or `TilesRenderer.load`. */
export const s2: BoundingVolumeExtension = {
  name: '3DTILES_bounding_volume_S2',
  bounds: (volume) => s2Bounds(volume as S2VolumeJSON),
};
