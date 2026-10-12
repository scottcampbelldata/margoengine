/**
 * CPU side of the line geometry. The vertex shader in shader.ts runs the same expansion on the GPU;
 * `expandLine` is the reference implementation in screen pixels, used by tests and for CPU hit testing.
 */
import {transformPoint, type Mat4} from './math.js';

export type LineMode = 'segments' | 'strip' | 'loop';
export type LineJoin = 'miter' | 'round' | 'bevel';
export type LineCap = 'butt' | 'round' | 'square';

export const JOINS: readonly LineJoin[] = ['miter', 'round', 'bevel'];
export const CAPS: readonly LineCap[] = ['butt', 'round', 'square'];
export const MODES: readonly LineMode[] = ['segments', 'strip', 'loop'];

/** Triangles in each round cap or join fan. */
export const FAN = 10;
/** Vertices in one join or cap block: two gap triangles plus the fan. */
export const BLOCK = (FAN + 2) * 3;
/** Vertices drawn per segment instance: body quad, end block, start block. */
export const VERTICES_PER_SEGMENT = 6 + 2 * BLOCK;

/** Number of instanced segments drawn for `count` points. A loop needs at least 3 points, otherwise it draws as a strip. */
export function segmentCount(mode: LineMode, count: number): number {
  if (count < 2) return 0;
  if (mode === 'segments') return count >> 1;
  if (mode === 'loop' && count >= 3) return count;
  return count - 1;
}

export interface SegmentIndices {a: number; b: number; prev: number; next: number}

/** Point indices of segment `i`; prev and next are -1 where the line has an end (and so a cap). */
export function segmentIndices(mode: LineMode, count: number, i: number): SegmentIndices {
  if (mode === 'segments') return {a: 2 * i, b: 2 * i + 1, prev: -1, next: -1};
  if (mode === 'loop' && count >= 3) return {a: i, b: (i + 1) % count, prev: (i + count - 1) % count, next: (i + 2) % count};
  return {a: i, b: i + 1, prev: i > 0 ? i - 1 : -1, next: i + 2 < count ? i + 2 : -1};
}

/**
 * Cumulative distance along the line, written into the w component of `points` (stride 4: x, y, z, distance).
 * Distances are measured after applying `matrix` (world space) when given. Segment lists accumulate across
 * segments like three.js `LineSegments2.computeLineDistances`. Returns the total length, which for a loop
 * includes the closing segment.
 */
export function computeLineDistances(points: Float32Array, count: number, mode: LineMode, matrix?: Mat4 | null): number {
  const p = [0, 0, 0], q = [0, 0, 0];
  const at = (i: number, out: number[]) => {
    const x = points[i * 4], y = points[i * 4 + 1], z = points[i * 4 + 2];
    if (matrix) transformPoint(out, 0, matrix, x, y, z); else {out[0] = x; out[1] = y; out[2] = z;}
  };
  let total = 0;
  if (mode === 'segments') {
    for (let i = 0; i + 1 < count; i += 2) {
      at(i, p); at(i + 1, q);
      points[i * 4 + 3] = total; total += Math.hypot(q[0] - p[0], q[1] - p[1], q[2] - p[2]); points[i * 4 + 7] = total;
    }
    if (count % 2) points[(count - 1) * 4 + 3] = total;
    return total;
  }
  if (count) {at(0, p); points[3] = 0;}
  for (let i = 1; i < count; i++) {
    at(i, q); total += Math.hypot(q[0] - p[0], q[1] - p[1], q[2] - p[2]); points[i * 4 + 3] = total;
    p[0] = q[0]; p[1] = q[1]; p[2] = q[2];
  }
  if (mode === 'loop' && count >= 3) {at(0, q); total += Math.hypot(q[0] - p[0], q[1] - p[1], q[2] - p[2]);}
  return total;
}

type V2 = [number, number];
interface Joint {sOut: number; miter: boolean; innerOk: boolean; inner: V2; outer0: V2; outer1: V2; n1: V2}

const dot = (a: V2, b: V2) => a[0] * b[0] + a[1] * b[1];
const scale = (a: V2, s: number): V2 => [a[0] * s, a[1] * s];

/** Join geometry at a point where direction d0 turns into d1 (unit screen vectors). Mirrors `joint` in the WGSL. */
export function joint(d0: V2, d1: V2, hwG: number, len0: number, len1: number, join: number, miterLimit: number): Joint {
  const n0: V2 = [-d0[1], d0[0]], n1: V2 = [-d1[1], d1[0]];
  const cross = d0[0] * d1[1] - d0[1] * d1[0], sOut = cross > 0 ? -1 : 1;
  const sum: V2 = [n0[0] + n1[0], n0[1] + n1[1]], sl = Math.hypot(sum[0], sum[1]);
  let m = n0, L = 1e6;
  if (sl > 1e-4) {m = [sum[0] / sl, sum[1] / sl]; L = 1 / Math.max(dot(m, n0), 1e-6);}
  const miter = join === 0 && L <= miterLimit;
  const innerOk = L < 1e5 && hwG * Math.sqrt(Math.max(L * L - 1, 0)) <= Math.min(len0, len1);
  const inner = innerOk ? scale(m, -sOut * hwG * L) : [0, 0] as V2;
  return {sOut, miter, innerOk, inner, n1,
    outer0: miter ? scale(m, sOut * hwG * L) : scale(n0, sOut * hwG),
    outer1: miter ? scale(m, sOut * hwG * L) : scale(n1, sOut * hwG)};
}

export interface ExpandOptions {mode?: LineMode; width?: number; join?: LineJoin; cap?: LineCap; miterLimit?: number; antialias?: boolean}

/**
 * Expands a 2D polyline given in screen pixels into triangles, exactly as the GPU does per segment instance.
 * Returns x, y, d triples per vertex where d is the signed distance from the segment centerline; degenerate
 * (zero area) triangles are dropped. With `antialias` the geometry grows by one pixel for the edge ramp.
 */
export function expandLine(points: ArrayLike<number>, options: ExpandOptions = {}): Float32Array {
  const mode = options.mode ?? 'strip', count = points.length >> 1, hw = Math.max((options.width ?? 1) / 2, 0.5);
  const join = JOINS.indexOf(options.join ?? 'round'), cap = CAPS.indexOf(options.cap ?? 'round'), limit = options.miterLimit ?? 4;
  if (join < 0 || cap < 0 || !MODES.includes(mode)) throw new TypeError('Unknown line mode, join or cap');
  const aa = options.antialias === false ? 0 : 1, hwG = hw + aa, out: number[] = [];
  const pt = (i: number): V2 => [points[i * 2], points[i * 2 + 1]];
  const along = (a: V2, b: V2): [V2, number] => {const dx = b[0] - a[0], dy = b[1] - a[1], len = Math.hypot(dx, dy); return [len > 1e-4 ? [dx / len, dy / len] : [1, 0], len];};
  for (let i = 0, segments = segmentCount(mode, count); i < segments; i++) {
    const s = segmentIndices(mode, count, i), sa = pt(s.a), sb = pt(s.b), [dir, len] = along(sa, sb), nrm: V2 = [-dir[1], dir[0]];
    let hasPrev = s.prev >= 0, hasNext = s.next >= 0, dPrev: V2 = dir, lPrev = 0, dNext: V2 = dir, lNext = 0;
    if (hasPrev) {[dPrev, lPrev] = along(pt(s.prev), sa); hasPrev = lPrev > 1e-4;}
    if (hasNext) {[dNext, lNext] = along(sb, pt(s.next)); hasNext = lNext > 1e-4;}
    const jA = hasPrev ? joint(dPrev, dir, hwG, lPrev, len, join, limit) : null;
    const jB = hasNext ? joint(dir, dNext, hwG, len, lNext, join, limit) : null;
    const tri: number[] = [];
    const vertex = (center: V2, off: V2, d: number) => tri.push(center[0] + off[0], center[1] + off[1], d);
    const corner = (atB: boolean, side: number) => {
      const j = atB ? jB : jA, c = atB ? sb : sa;
      let off: V2;
      if (j) off = side === j.sOut ? (atB ? j.outer0 : j.outer1) : j.innerOk ? j.inner : scale(nrm, side * hwG);
      else {const ext = cap === 2 ? hw + aa : cap === 0 ? aa : 0; off = [nrm[0] * side * hwG + dir[0] * (atB ? ext : -ext), nrm[1] * side * hwG + dir[1] * (atB ? ext : -ext)];}
      vertex(c, off, dot(off, nrm));
    };
    corner(false, -1); corner(false, 1); corner(true, 1); corner(false, -1); corner(true, 1); corner(true, -1);
    const fan = (center: V2, from: V2, sweep: number) => {
      const a0 = Math.atan2(from[1], from[0]);
      for (let k = 0; k < FAN; k++) {
        const t0 = a0 + sweep * k / FAN, t1 = a0 + sweep * (k + 1) / FAN;
        vertex(center, [0, 0], 0); vertex(center, [Math.cos(t0) * hwG, Math.sin(t0) * hwG], hwG); vertex(center, [Math.cos(t1) * hwG, Math.sin(t1) * hwG], hwG);
      }
    };
    if (jB) {
      const inner0 = jB.innerOk ? jB.inner : scale(nrm, -jB.sOut * hwG), inner1 = jB.innerOk ? jB.inner : scale(jB.n1, -jB.sOut * hwG);
      vertex(sb, inner0, dot(inner0, nrm)); vertex(sb, [0, 0], 0); vertex(sb, jB.outer0, dot(jB.outer0, nrm));
      vertex(sb, inner1, dot(inner1, jB.n1)); vertex(sb, [0, 0], 0); vertex(sb, jB.outer1, dot(jB.outer1, jB.n1));
      if (!jB.miter && join !== 1) {vertex(sb, [0, 0], 0); vertex(sb, jB.outer0, hwG); vertex(sb, jB.outer1, hwG);}
      else if (!jB.miter) fan(sb, jB.outer0, Math.atan2(jB.outer0[0] * jB.outer1[1] - jB.outer0[1] * jB.outer1[0], dot(jB.outer0, jB.outer1)));
    } else if (cap === 1) fan(sb, nrm, -Math.PI);
    if (!jA && cap === 1) fan(sa, nrm, Math.PI);
    for (let t = 0; t < tri.length; t += 9) {
      const area = (tri[t + 3] - tri[t]) * (tri[t + 7] - tri[t + 1]) - (tri[t + 6] - tri[t]) * (tri[t + 4] - tri[t + 1]);
      if (Math.abs(area) > 1e-6) out.push(...tri.slice(t, t + 9));
    }
  }
  return new Float32Array(out);
}

/** Sum of absolute triangle areas of an `expandLine` result. */
export function triangleArea(vertices: ArrayLike<number>): number {
  let total = 0;
  for (let t = 0; t + 8 < vertices.length; t += 9)
    total += Math.abs((vertices[t + 3] - vertices[t]) * (vertices[t + 7] - vertices[t + 1]) - (vertices[t + 6] - vertices[t]) * (vertices[t + 4] - vertices[t + 1])) / 2;
  return total;
}
