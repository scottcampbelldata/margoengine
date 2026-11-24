// Generalized winding numbers over a MeshBVH: the solid angle a mesh spans seen from a point, over 4 pi. It is 1 inside a
// closed mesh wound counter-clockwise, 0 outside, and degrades gracefully on open or leaky meshes. Far subtrees use the
// dipole estimate of Barill, Dickson, Schmidt, Levin and Jacobson (SIGGRAPH 2018), near ones the exact triangle solid
// angle of Van Oosterom and Strackee (1983), both written from the papers.
import { INTERNAL_FLAG, NODE_WORDS } from './build.js';
import type { MeshBVH } from './bvh.js';

/** Options of winding queries. */
export interface WindingOptions {
  /**
   * A subtree farther than this many of its radii counts as one dipole. Higher is slower and more accurate; Infinity
   * sums every triangle exactly. Default 2.
   */
  accuracy?: number;
}

interface Moments {
  revision: number;
  /** Per node: centre xyz, radius, area-weighted normal xyz, padding. */
  data: Float64Array;
}

const WORDS = 8;
const FOUR_PI = 4 * Math.PI;
const moments = new WeakMap<MeshBVH, Moments>();
const STACK = new Int32Array(512);

function triangle(bvh: MeshBVH, at: number, out: Float64Array): void {
  const { index, positions: p, stride } = bvh;
  for (let v = 0; v < 3; v++) {
    const o = index[at * 3 + v] * stride;
    out[v * 3] = p[o];
    out[v * 3 + 1] = p[o + 1];
    out[v * 3 + 2] = p[o + 2];
  }
}

function build(bvh: MeshBVH): Float64Array {
  const u = bvh.nodeData,
    f = bvh.nodeBounds,
    count = bvh.nodeCount,
    data = new Float64Array(count * WORDS),
    t = new Float64Array(9),
    // Area-weighted sum of triangle centroids, then total area, per node, for the centre of the dipole.
    weight = new Float64Array(count * 4);
  for (let node = count - 1; node >= 0; node--) {
    const w = node * NODE_WORDS,
      m = node * WORDS,
      c = node * 4,
      word = u[w + 7];
    if (word & INTERNAL_FLAG) {
      const l = node + 1,
        r = u[w + 6];
      for (let k = 0; k < 4; k++) weight[c + k] = weight[l * 4 + k] + weight[r * 4 + k];
      for (let k = 4; k < 7; k++) data[m + k] = data[l * WORDS + k] + data[r * WORDS + k];
    } else {
      for (let at = u[w + 6], end = at + word; at < end; at++) {
        triangle(bvh, at, t);
        const ax = t[3] - t[0],
          ay = t[4] - t[1],
          az = t[5] - t[2],
          bx = t[6] - t[0],
          by = t[7] - t[1],
          bz = t[8] - t[2],
          nx = (ay * bz - az * by) / 2,
          ny = (az * bx - ax * bz) / 2,
          nz = (ax * by - ay * bx) / 2,
          area = Math.hypot(nx, ny, nz);
        data[m + 4] += nx;
        data[m + 5] += ny;
        data[m + 6] += nz;
        weight[c] += (area * (t[0] + t[3] + t[6])) / 3;
        weight[c + 1] += (area * (t[1] + t[4] + t[7])) / 3;
        weight[c + 2] += (area * (t[2] + t[5] + t[8])) / 3;
        weight[c + 3] += area;
      }
    }
    const area = weight[c + 3];
    // A subtree of zero area has no dipole; its box centre serves.
    for (let k = 0; k < 3; k++) data[m + k] = area > 0 ? weight[c + k] / area : (f[w + k] + f[w + k + 3]) / 2;
    // Farthest box corner from the centre: every triangle of the node lies within it.
    data[m + 3] = Math.hypot(
      Math.max(data[m] - f[w], f[w + 3] - data[m]),
      Math.max(data[m + 1] - f[w + 1], f[w + 4] - data[m + 1]),
      Math.max(data[m + 2] - f[w + 2], f[w + 5] - data[m + 2]),
    );
  }
  return data;
}

function nodeMoments(bvh: MeshBVH): Float64Array {
  let entry = moments.get(bvh);
  if (!entry || entry.revision !== bvh.revision) {
    entry = { revision: bvh.revision, data: build(bvh) };
    moments.set(bvh, entry);
  }
  return entry.data;
}

const T = new Float64Array(9);

/** Signed solid angle of the triangle in `T` seen from a point. */
function solidAngle(x: number, y: number, z: number): number {
  const ax = T[0] - x,
    ay = T[1] - y,
    az = T[2] - z,
    bx = T[3] - x,
    by = T[4] - y,
    bz = T[5] - z,
    cx = T[6] - x,
    cy = T[7] - y,
    cz = T[8] - z,
    la = Math.hypot(ax, ay, az),
    lb = Math.hypot(bx, by, bz),
    lc = Math.hypot(cx, cy, cz),
    volume = ax * (by * cz - bz * cy) + ay * (bz * cx - bx * cz) + az * (bx * cy - by * cx),
    base = la * lb * lc + (ax * bx + ay * by + az * bz) * lc + (ax * cx + ay * cy + az * cz) * lb + (bx * cx + by * cy + bz * cz) * la;
  return 2 * Math.atan2(volume, base);
}

/** @internal The generalized winding number of `bvh` at a point. */
export function windingAt(bvh: MeshBVH, x: number, y: number, z: number, accuracy: number): number {
  const m = nodeMoments(bvh),
    u = bvh.nodeData;
  let sp = 0,
    sum = 0;
  STACK[sp++] = 0;
  while (sp) {
    const node = STACK[--sp],
      o = node * WORDS,
      w = node * NODE_WORDS,
      word = u[w + 7],
      dx = m[o] - x,
      dy = m[o + 1] - y,
      dz = m[o + 2] - z,
      distance = Math.hypot(dx, dy, dz);
    if (distance > accuracy * m[o + 3]) {
      sum += (dx * m[o + 4] + dy * m[o + 5] + dz * m[o + 6]) / (distance * distance * distance);
      continue;
    }
    if (word & INTERNAL_FLAG) {
      STACK[sp++] = u[w + 6];
      STACK[sp++] = node + 1;
    } else
      for (let at = u[w + 6], end = at + word; at < end; at++) {
        triangle(bvh, at, T);
        sum += solidAngle(x, y, z);
      }
  }
  return sum / FOUR_PI;
}

/** @internal Checks `accuracy` and answers it, default 2. */
export function windingAccuracy({ accuracy = 2 }: WindingOptions = {}): number {
  if (!(accuracy > 0)) throw new RangeError('Invalid accuracy; pass a positive number, or Infinity for an exact sum.');
  return accuracy;
}
