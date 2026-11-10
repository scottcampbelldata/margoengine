import type { Bone } from './skeletal.js';
import { arr, num, str, type SpineObject, type SpineValue } from './spine-data.js';

export const RAD = Math.PI / 180;
export const angle = (v: number): number => Math.atan2(Math.sin(v), Math.cos(v));
export const point = (m: ArrayLike<number>, x: number, y: number): [number, number] => [
  m[0] * x + m[2] * y + m[4],
  m[1] * x + m[3] * y + m[5],
];
export const unpoint = (m: ArrayLike<number>, x: number, y: number): [number, number] => {
  const d = m[0] * m[3] - m[1] * m[2];
  if (Math.abs(d) < 1e-15) return [0, 0];
  x -= m[4];
  y -= m[5];
  return [(x * m[3] - y * m[2]) / d, (y * m[0] - x * m[1]) / d];
};
export interface Extra {
  shearX: number;
  shearY: number;
  inherit: string;
  active: boolean;
}
// Parent basis for the five documented inheritance choices. Translation always uses the full parent matrix.
export function basis(b: Bone, e: Extra): number[] {
  const p = b.parent?.world;
  if (!p || e.inherit === 'onlyTranslation') return [1, 0, 0, 1, p?.[4] ?? 0, p?.[5] ?? 0];
  const [a, bb, c, d] = p,
    det = a * d - bb * c;
  if (e.inherit === 'noRotationOrReflection') {
    const sx = Math.hypot(a, bb);
    if (sx < 1e-15) return [0, 0, 0, Math.hypot(c, d), p[4], p[5]];
    // Remove the parent's rotation and reflection, retaining its stretch and shear.
    return [sx, 0, (a * c + bb * d) / sx, Math.abs(det) / sx, p[4], p[5]];
  }
  if (e.inherit === 'noScale' || e.inherit === 'noScaleOrReflection') {
    // Normalize in the child's rotated frame so anisotropic ancestors cannot stretch either local axis.
    const r = b.rotation,
      x = a * Math.cos(r) + c * Math.sin(r),
      y = bb * Math.cos(r) + d * Math.sin(r),
      length = Math.hypot(x, y);
    const ux = length ? x / length : 1,
      uy = length ? y / length : 0,
      sign = e.inherit === 'noScale' && det < 0 ? -1 : 1;
    const cr = Math.cos(r),
      sr = Math.sin(r);
    return [
      ux * cr + uy * sign * sr,
      uy * cr - ux * sign * sr,
      ux * sr - uy * sign * cr,
      uy * sr + ux * sign * cr,
      p[4],
      p[5],
    ];
  }
  return [...p];
}
export function updateBone(b: Bone, e: Extra): void {
  const p = b.parent?.world,
    base = basis(b, e),
    rx = b.rotation + e.shearX,
    ry = b.rotation + Math.PI / 2 + e.shearY;
  const a = Math.cos(rx) * b.scaleX,
    bb = Math.sin(rx) * b.scaleX,
    c = Math.cos(ry) * b.scaleY,
    d = Math.sin(ry) * b.scaleY;
  const xy = p ? point(p, b.x, b.y) : [b.x, b.y];
  b.world.set([
    base[0] * a + base[2] * bb,
    base[1] * a + base[3] * bb,
    base[0] * c + base[2] * d,
    base[1] * c + base[3] * d,
    xy[0],
    xy[1],
  ]);
}
export function setWorld(b: Bone, e: Extra, m: ArrayLike<number>): void {
  const base = basis(b, e),
    det = base[0] * base[3] - base[1] * base[2];
  const xy = b.parent ? unpoint(b.parent.world, m[4], m[5]) : [m[4], m[5]];
  b.x = xy[0];
  b.y = xy[1];
  if (Math.abs(det) < 1e-15) return;
  const a = (base[3] * m[0] - base[2] * m[1]) / det,
    bb = (-base[1] * m[0] + base[0] * m[1]) / det;
  const c = (base[3] * m[2] - base[2] * m[3]) / det,
    d = (-base[1] * m[2] + base[0] * m[3]) / det;
  b.rotation = Math.atan2(bb, a);
  b.scaleX = Math.hypot(a, bb);
  b.scaleY = Math.hypot(c, d);
  e.shearX = 0;
  e.shearY = angle(Math.atan2(d, c) - b.rotation - Math.PI / 2);
}
const cubic = (t: number, a: number, b: number, c: number, d: number): number => {
  const s = 1 - t;
  return s * s * s * a + 3 * s * s * t * b + 3 * s * t * t * c + t * t * t * d;
};
/** Sample exported curves. 3.x normalized controls; 4.x absolute time/value controls, one group per channel. */
export function interpolate(
  a: SpineObject,
  b: SpineObject,
  t: number,
  v0: number,
  v1: number,
  channel: number,
  absolute: boolean,
): number {
  const t0 = num(a.time),
    t1 = num(b.time),
    curve = a.curve;
  if (curve === 'stepped' || t1 === t0) return v0;
  if (curve === undefined || curve === 'linear') return v0 + ((v1 - v0) * (t - t0)) / (t1 - t0);
  const c = typeof curve === 'number' ? [curve, num(a.c2), num(a.c3, 1), num(a.c4, 1)] : arr(curve).map((v) => num(v));
  const at = c.length > 4 ? channel * 4 : 0;
  const x0 = absolute ? t0 : 0,
    x3 = absolute ? t1 : 1,
    target = absolute ? t : (t - t0) / (t1 - t0);
  let lo = 0,
    hi = 1;
  for (let i = 0; i < 48; i++) {
    const mid = (lo + hi) / 2;
    if (cubic(mid, x0, c[at], c[at + 2], x3) < target) lo = mid;
    else hi = mid;
  }
  const value = cubic((lo + hi) / 2, absolute ? v0 : 0, c[at + 1], c[at + 3], absolute ? v1 : 1);
  return absolute ? value : v0 + (v1 - v0) * value;
}
export function keyPair(keys: SpineObject[], t: number): [SpineObject, SpineObject] | undefined {
  let low = 0,
    high = keys.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if (num(keys[mid].time) <= t) low = mid + 1;
    else high = mid;
  }
  return low === 0 ? undefined : [keys[low - 1], keys[Math.min(low, keys.length - 1)]];
}
export function sample(
  keys: SpineObject[],
  t: number,
  field: string,
  fallback: number,
  channel: number,
  absolute: boolean,
): number | undefined {
  const pair = keyPair(keys, t);
  if (!pair) return undefined;
  const [a, b] = pair,
    first = num(a[field], fallback),
    last = num(b[field], fallback);
  return a === b ? first : interpolate(a, b, t, first, last, channel, absolute);
}
export const rgba = (value: SpineValue | undefined, fallback = 'ffffffff'): number[] => {
  const text = str(value, fallback);
  return [0, 2, 4, 6].map((i) => (i >= text.length ? 1 : Number.parseInt(text.slice(i, i + 2), 16) / 255));
};

export interface PathSample {
  x: number;
  y: number;
  angle: number;
}
// Composite cubics: open exports include an unused handle at each end; closed exports wrap the final control triple.
export function pathSampler(
  vertices: Float64Array,
  data: SpineObject,
): { length: number; at: (distance: number) => PathSample } {
  const closed = data.closed === true,
    points: number[][] = [];
  for (let i = 0; i < vertices.length; i += 2) points.push([vertices[i], vertices[i + 1]]);
  const curves: number[][][] = [];
  if (closed) {
    for (let i = 1; i < points.length; i += 3)
      curves.push([
        points[i],
        points[(i + 1) % points.length],
        points[(i + 2) % points.length],
        points[(i + 3) % points.length],
      ]);
  } else for (let i = 1; i + 3 < points.length; i += 3) curves.push(points.slice(i, i + 4));
  const evaluate = (curve: number, t: number): PathSample => {
    const [a, b, c, d] = curves[curve],
      s = 1 - t;
    const dx = 3 * s * s * (b[0] - a[0]) + 6 * s * t * (c[0] - b[0]) + 3 * t * t * (d[0] - c[0]);
    const dy = 3 * s * s * (b[1] - a[1]) + 6 * s * t * (c[1] - b[1]) + 3 * t * t * (d[1] - c[1]);
    return { x: cubic(t, a[0], b[0], c[0], d[0]), y: cubic(t, a[1], b[1], c[1], d[1]), angle: Math.atan2(dy, dx) };
  };
  // Deterministic chord table for arc-length inversion; no clock-dependent iteration or simulation state.
  const tables = curves.map((_, i) => {
    const table = [0];
    let prev = evaluate(i, 0);
    for (let j = 1; j <= 128; j++) {
      const p = evaluate(i, j / 128);
      table.push(table[j - 1] + Math.hypot(p.x - prev.x, p.y - prev.y));
      prev = p;
    }
    return table;
  });
  const lengths: number[] = [],
    constant = data.constantSpeed !== false || data.lengths === undefined;
  let length = 0;
  for (let i = 0; i < curves.length; i++) {
    length = constant ? length + tables[i][128] : num(arr(data.lengths)[i]);
    lengths.push(length);
  }
  return {
    length,
    at(distance) {
      if (!curves.length) return { x: 0, y: 0, angle: 0 };
      if (closed && length > 0) distance = ((distance % length) + length) % length;
      if (distance < 0 || distance > length) {
        const start = distance < 0,
          p = evaluate(start ? 0 : curves.length - 1, start ? 0 : 1),
          extra = start ? distance : distance - length;
        return { ...p, x: p.x + Math.cos(p.angle) * extra, y: p.y + Math.sin(p.angle) * extra };
      }
      let i = 0;
      while (i + 1 < lengths.length && distance > lengths[i]) i++;
      const before = lengths[i - 1] ?? 0,
        extent = lengths[i] - before,
        fraction = extent > 0 ? (distance - before) / extent : 0;
      if (!constant) return evaluate(i, fraction);
      const table = tables[i],
        target = fraction * table[128];
      let j = 1;
      while (j < 128 && table[j] < target) j++;
      const span = table[j] - table[j - 1],
        t = (j - 1 + (span > 0 ? (target - table[j - 1]) / span : 0)) / 128;
      return evaluate(i, t);
    },
  };
}
