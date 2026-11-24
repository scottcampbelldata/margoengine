// The `inside` entry: volume and clearance queries on top of a MeshBVH. Is a point inside a mesh, by winding number, so
// small gaps and flipped patches do not spoil the answer as they spoil ray parity; how far apart are two meshes, by a
// branch and bound over both trees, for clearance checks.
import type { MutableVec3 } from '@margoengine/math';
import { INTERNAL_FLAG, NODE_WORDS } from './build.js';
import { MeshBVH } from './bvh.js';
import { closestPointTriangle, transformPoint, triangleTriangle } from './math.js';
import { windingAccuracy, windingAt, type WindingOptions } from './winding.js';

export type { WindingOptions };

/** Options of {@link meshDistance}. */
export interface MeshDistanceOptions {
  /** Only pairs within this distance count; farther meshes answer null. Default Infinity. */
  maxDistance?: number;
  /** Stop as soon as a pair at or below this distance is found: enough for a pass or fail clearance check. Default 0. */
  minDistance?: number;
}
/** The closest pair of points of two meshes. */
export interface MeshDistanceResult {
  /** 0 when the meshes touch or cross. */
  distance: number;
  /** On the first mesh, in its space. */
  pointA: MutableVec3;
  /** On the second mesh, in the first mesh's space. */
  pointB: MutableVec3;
  faceA: number;
  faceB: number;
}

/**
 * The generalized winding number of a mesh at a point: 1 inside a closed mesh wound counter-clockwise, 0 outside, -1
 * inside one wound the other way, and a value between on an open mesh.
 */
export function windingNumber(bvh: MeshBVH, point: ArrayLike<number>, options?: WindingOptions): number {
  return windingAt(bvh, point[0], point[1], point[2], windingAccuracy(options));
}

/** Whether a point is inside a mesh: its winding number's size is over one half, whichever way the mesh is wound. */
export function pointInside(bvh: MeshBVH, point: ArrayLike<number>, options?: WindingOptions): boolean {
  return Math.abs(windingNumber(bvh, point, options)) > 0.5;
}

const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

// Corner of triangle `at` in a tree's own order, into out at offset, under matrix m.
function corners(bvh: MeshBVH, at: number, m: ArrayLike<number>, out: Float64Array): void {
  const { index, positions: p, stride } = bvh;
  for (let v = 0; v < 3; v++) {
    const o = index[at * 3 + v] * stride;
    transformPoint(m, p[o], p[o + 1], p[o + 2], out, v * 3);
  }
}

const SCRATCH = new Float64Array(6);

// Closest points of segments p0-p1 and q0-q1 by clamped parameters, into out: x y z on each. Answers the squared distance.
function segmentSegment(p: Float64Array, i: number, j: number, q: Float64Array, k: number, l: number, out: Float64Array): number {
  const d1x = p[j] - p[i],
    d1y = p[j + 1] - p[i + 1],
    d1z = p[j + 2] - p[i + 2],
    d2x = q[l] - q[k],
    d2y = q[l + 1] - q[k + 1],
    d2z = q[l + 2] - q[k + 2],
    rx = p[i] - q[k],
    ry = p[i + 1] - q[k + 1],
    rz = p[i + 2] - q[k + 2],
    a = d1x * d1x + d1y * d1y + d1z * d1z,
    e = d2x * d2x + d2y * d2y + d2z * d2z,
    f = d2x * rx + d2y * ry + d2z * rz,
    c = d1x * rx + d1y * ry + d1z * rz,
    b = d1x * d2x + d1y * d2y + d1z * d2z,
    denominator = a * e - b * b;
  let s = denominator > 0 ? Math.min(Math.max((b * f - c * e) / denominator, 0), 1) : 0,
    t = e > 0 ? (b * s + f) / e : 0;
  if (t < 0) {
    t = 0;
    s = a > 0 ? Math.min(Math.max(-c / a, 0), 1) : 0;
  } else if (t > 1) {
    t = 1;
    s = a > 0 ? Math.min(Math.max((b - c) / a, 0), 1) : 0;
  }
  out[0] = p[i] + d1x * s;
  out[1] = p[i + 1] + d1y * s;
  out[2] = p[i + 2] + d1z * s;
  out[3] = q[k] + d2x * t;
  out[4] = q[k + 1] + d2y * t;
  out[5] = q[k + 2] + d2z * t;
  return (out[0] - out[3]) ** 2 + (out[1] - out[4]) ** 2 + (out[2] - out[5]) ** 2;
}

const CP = new Float64Array(6);

function pointOnTriangle(t: Float64Array, x: number, y: number, z: number): number {
  closestPointTriangle(x, y, z, t[0], t[1], t[2], t[3], t[4], t[5], t[6], t[7], t[8], CP);
  return (CP[0] - x) ** 2 + (CP[1] - y) ** 2 + (CP[2] - z) ** 2;
}

/** Squared distance of two triangles (nine numbers each); `out` gets a closest point on each. */
function triangleDistance(a: Float64Array, b: Float64Array, out: Float64Array): number {
  let best = Infinity;
  for (let i = 0; i < 9; i += 3)
    for (let j = 0; j < 9; j += 3) {
      const d = segmentSegment(a, i, (i + 3) % 9, b, j, (j + 3) % 9, SCRATCH);
      if (d < best) {
        best = d;
        out.set(SCRATCH);
      }
    }
  for (let i = 0; i < 9; i += 3) {
    let d = pointOnTriangle(b, a[i], a[i + 1], a[i + 2]);
    if (d < best) {
      best = d;
      out[0] = a[i];
      out[1] = a[i + 1];
      out[2] = a[i + 2];
      out[3] = CP[0];
      out[4] = CP[1];
      out[5] = CP[2];
    }
    d = pointOnTriangle(a, b[i], b[i + 1], b[i + 2]);
    if (d < best) {
      best = d;
      out[0] = CP[0];
      out[1] = CP[1];
      out[2] = CP[2];
      out[3] = b[i];
      out[4] = b[i + 1];
      out[5] = b[i + 2];
    }
  }
  return best;
}

// Box of node `w` of a tree under a matrix: the corners' box.
function nodeBox(f: Float32Array, w: number, m: ArrayLike<number>, out: Float64Array): void {
  const p = [0, 0, 0];
  out.fill(Infinity, 0, 3);
  out.fill(-Infinity, 3, 6);
  for (let c = 0; c < 8; c++) {
    transformPoint(m, f[w + (c & 1 ? 3 : 0)], f[w + 1 + (c & 2 ? 3 : 0)], f[w + 2 + (c & 4 ? 3 : 0)], p);
    for (let k = 0; k < 3; k++) {
      out[k] = Math.min(out[k], p[k]);
      out[k + 3] = Math.max(out[k + 3], p[k]);
    }
  }
}

function boxGap(a: Float32Array, w: number, b: Float64Array): number {
  let sum = 0;
  for (let k = 0; k < 3; k++) {
    const gap = Math.max(a[w + k] - b[k + 3], b[k] - a[w + k + 3], 0);
    sum += gap * gap;
  }
  return sum;
}

interface Pair {
  a: number;
  b: number;
  gap: number;
}

/**
 * The closest points of two meshes, or null when they are farther apart than `maxDistance`. `matrix` (column-major,
 * default identity) takes the second mesh into the first's space; the answer is in the first's space. Triangles in
 * contact answer 0, with both points at one place on the contact only by chance of the pair found.
 */
export function meshDistance(
  a: MeshBVH,
  b: MeshBVH,
  matrix: ArrayLike<number> = IDENTITY,
  { maxDistance = Infinity, minDistance = 0 }: MeshDistanceOptions = {},
): MeshDistanceResult | null {
  if (!(a instanceof MeshBVH) || !(b instanceof MeshBVH)) throw new TypeError('Expected two MeshBVH; build one for each mesh.');
  if (!(maxDistance >= 0) || !(minDistance >= 0)) throw new RangeError('Invalid distance; pass maxDistance and minDistance of at least 0.');
  if (matrix.length !== 16) throw new TypeError('Invalid matrix; pass 16 numbers, column-major.');
  const fa = a.nodeBounds,
    ua = a.nodeData,
    fb = b.nodeBounds,
    ub = b.nodeData,
    ta = new Float64Array(9),
    tb = new Float64Array(9),
    both = new Float64Array(18),
    points = new Float64Array(6),
    best = new Float64Array(6),
    box = new Float64Array(6),
    other = new Float64Array(6),
    limit = maxDistance === Infinity ? Infinity : maxDistance * maxDistance * (1 + 1e-12),
    enough = minDistance * minDistance,
    // Depth first with the nearer pair on top, so a good bound comes early.
    stack: Pair[] = [];
  let bound = limit,
    faceA = -1,
    faceB = -1;
  const gapOf = (x: number, y: number): number => {
    nodeBox(fb, y * NODE_WORDS, matrix, box);
    return boxGap(fa, x * NODE_WORDS, box);
  };
  const leafPair = (x: number, y: number): boolean => {
    const wa = x * NODE_WORDS,
      wb = y * NODE_WORDS;
    for (let i = ua[wa + 6], ie = i + ua[wa + 7]; i < ie; i++) {
      corners(a, i, IDENTITY, ta);
      for (let j = ub[wb + 6], je = j + ub[wb + 7]; j < je; j++) {
        corners(b, j, matrix, tb);
        both.set(ta);
        both.set(tb, 9);
        const distance = triangleTriangle(both, 0, both, 9) ? 0 : triangleDistance(ta, tb, points);
        if (distance === 0) triangleDistance(ta, tb, points);
        if (distance < bound || faceA < 0) {
          if (distance > limit) continue;
          bound = distance;
          best.set(points);
          faceA = a.triangles[i];
          faceB = b.triangles[j];
          if (bound <= enough) return true;
        }
      }
    }
    return false;
  };
  stack.push({ a: 0, b: 0, gap: gapOf(0, 0) });
  while (stack.length) {
    const { a: x, b: y, gap } = stack.pop()!;
    if (gap > bound) continue;
    const wa = x * NODE_WORDS,
      wb = y * NODE_WORDS,
      innerA = !!(ua[wa + 7] & INTERNAL_FLAG),
      innerB = !!(ub[wb + 7] & INTERNAL_FLAG);
    if (!innerA && !innerB) {
      if (leafPair(x, y)) break;
      continue;
    }
    // Split the larger box, so both trees shrink together.
    nodeBox(fb, wb, matrix, other);
    const sizeA = Math.max(fa[wa + 3] - fa[wa], fa[wa + 4] - fa[wa + 1], fa[wa + 5] - fa[wa + 2]),
      sizeB = Math.max(other[3] - other[0], other[4] - other[1], other[5] - other[2]),
      splitA = innerA && (!innerB || sizeA >= sizeB),
      first = splitA ? x + 1 : y + 1,
      second = splitA ? ua[wa + 6] : ub[wb + 6],
      gapFirst = splitA ? gapOf(first, y) : gapOf(x, first),
      gapSecond = splitA ? gapOf(second, y) : gapOf(x, second),
      far = { a: splitA ? second : x, b: splitA ? y : second, gap: gapSecond },
      near = { a: splitA ? first : x, b: splitA ? y : first, gap: gapFirst };
    // The nearer pair goes on top.
    if (gapFirst <= gapSecond) stack.push(far, near);
    else stack.push(near, far);
  }
  if (faceA < 0) return null;
  return {
    distance: Math.sqrt(bound),
    pointA: [best[0], best[1], best[2]],
    pointB: [best[3], best[4], best[5]],
    faceA,
    faceB,
  };
}
