// A lattice girder (box-section truss): four corner chords tied by battens and diagonal lacing on each face, the
// welded steel section of crane masts and jibs, radio masts and stage trusses. Every member is a capped cylinder from
// cylinderGeometry, placed end to end between panel points and merged into one GeometryData, so a whole mast is one
// mesh and one draw. Bracing patterns as structural texts name them (Warren, Pratt, X; see the README for sources).
import type { GeometryData } from './data.js';
import { cylinderGeometry } from './primitives.js';
import { applyMatrix4, mergeGeometries } from './utils.js';

export type TrussPattern = 'warren' | 'pratt' | 'x';

export interface TrussOptions {
  /** Length along +Y, from y = 0 to y = length (default 1). */
  length?: number;
  /** Section width along X between chord centres at the foot (default 0.2). */
  width?: number;
  /** Section depth along Z between chord centres at the foot (default `width`). */
  depth?: number;
  /** Panels along the length (default the length over the larger section side, rounded, at least 1). */
  bays?: number;
  /** Corner chord radius (default 6 percent of the smaller section side). */
  chordRadius?: number;
  /** Batten and diagonal radius (default 60 percent of `chordRadius`). */
  lacingRadius?: number;
  /** Diagonal bracing on each face: `'warren'` zigzag (default), `'pratt'` all one way, `'x'` crossed. */
  pattern?: TrussPattern;
  /** Horizontal battens at every panel point (default true). */
  battens?: boolean;
  /** Section scale at the top end relative to the foot, for tapered jibs and masts (default 1). */
  taper?: number;
  /** Sides around each member (default 8). */
  radialSegments?: number;
}

type Point = readonly [number, number, number];

function positive(name: string, value: number) {
  if (!Number.isFinite(value) || value <= 0) throw new RangeError(`trussGeometry: ${name} must be a positive finite number, got ${value}`);
}

/** A capped cylinder of `radius` from `a` to `b`. */
function member(a: Point, b: Point, radius: number, sides: number): GeometryData {
  const dx = b[0] - a[0],
    dy = b[1] - a[1],
    dz = b[2] - a[2];
  const length = Math.hypot(dx, dy, dz);
  const ux = dx / length,
    uy = dy / length,
    uz = dz / length;
  // Column-major basis taking the cylinder's +Y onto the member, with any perpendicular pair for X and Z.
  const helper: Point = Math.abs(uy) < 0.9 ? [0, 1, 0] : [1, 0, 0];
  let xx = helper[1] * uz - helper[2] * uy,
    xy = helper[2] * ux - helper[0] * uz,
    xz = helper[0] * uy - helper[1] * ux;
  const xl = Math.hypot(xx, xy, xz);
  xx /= xl;
  xy /= xl;
  xz /= xl;
  const zx = xy * uz - xz * uy,
    zy = xz * ux - xx * uz,
    zz = xx * uy - xy * ux;
  const matrix = [xx, xy, xz, 0, ux, uy, uz, 0, zx, zy, zz, 0, a[0] + dx / 2, a[1] + dy / 2, a[2] + dz / 2, 1];
  return applyMatrix4(cylinderGeometry(radius, radius, length, sides, 1, false), matrix);
}

/**
 * A box-section lattice girder along +Y: four chords, battens at each panel point and diagonals on each face.
 * Throws `RangeError` for a non-positive size, radius or bay count, or a radius that does not fit the section.
 */
export function trussGeometry(options: TrussOptions = {}): GeometryData {
  const length = options.length ?? 1;
  const width = options.width ?? 0.2;
  const depth = options.depth ?? width;
  positive('length', length);
  positive('width', width);
  positive('depth', depth);
  const bays = options.bays ?? Math.max(1, Math.round(length / Math.max(width, depth)));
  if (!Number.isInteger(bays) || bays < 1) throw new RangeError(`trussGeometry: bays must be a whole number of at least 1, got ${bays}`);
  const chord = options.chordRadius ?? 0.06 * Math.min(width, depth);
  const lacing = options.lacingRadius ?? 0.6 * chord;
  const taper = options.taper ?? 1;
  const sides = options.radialSegments ?? 8;
  positive('chordRadius', chord);
  positive('lacingRadius', lacing);
  positive('taper', taper);
  if (!Number.isInteger(sides) || sides < 3) throw new RangeError(`trussGeometry: radialSegments must be a whole number of at least 3, got ${sides}`);
  if (2 * chord >= Math.min(width, depth) * Math.min(1, taper))
    throw new RangeError('trussGeometry: the chords overlap; make chordRadius smaller than half the narrowest section side');
  const pattern = options.pattern ?? 'warren';
  if (pattern !== 'warren' && pattern !== 'pratt' && pattern !== 'x') throw new RangeError(`trussGeometry: unknown pattern ${String(pattern)}`);

  // Corner k at panel point i: the section scales linearly from the foot to `taper` at the top.
  const corner = (k: number, i: number): Point => {
    const y = (length * i) / bays,
      s = 1 + ((taper - 1) * i) / bays;
    const sx = k === 1 || k === 2 ? 0.5 : -0.5,
      sz = k >= 2 ? 0.5 : -0.5;
    return [sx * width * s, y, sz * depth * s];
  };
  const parts: GeometryData[] = [];
  for (let k = 0; k < 4; k++) parts.push(member(corner(k, 0), corner(k, bays), chord, sides));
  for (let k = 0; k < 4; k++) {
    const n = (k + 1) % 4;
    if (options.battens ?? true) for (let i = 0; i <= bays; i++) parts.push(member(corner(k, i), corner(n, i), lacing, sides));
    for (let i = 0; i < bays; i++) {
      const rising = pattern === 'pratt' || i % 2 === 0;
      parts.push(rising ? member(corner(k, i), corner(n, i + 1), lacing, sides) : member(corner(n, i), corner(k, i + 1), lacing, sides));
      if (pattern === 'x') parts.push(rising ? member(corner(n, i), corner(k, i + 1), lacing, sides) : member(corner(k, i), corner(n, i + 1), lacing, sides));
    }
  }
  return mergeGeometries(parts);
}
