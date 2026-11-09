import { distanceAt } from './closest.js';
import type { Spline } from './index.js';

/** Number of cubic segments in a spline (the parameter range 0..1 is split evenly across them). */
export function splineSegmentCount(spline: Spline): number {
  const count = spline.points.length / 3;
  return spline.kind === 'bezier' ? (count - 1) / 3 : spline.closed ? count : count - 1;
}
/** Number of knots a per-knot array needs: one per segment boundary, and a closed curve's last knot is its first. */
export function knotCount(spline: Spline): number {
  const segments = splineSegmentCount(spline);
  return spline.closed ? segments : segments + 1;
}
/** Curve parameter at an arc-length position (the inverse of {@link distanceAt}). */
export function parameterAt(spline: Spline, distance: number): number {
  if (!Number.isFinite(distance) || distance < 0 || distance > spline.length)
    throw new RangeError('Distance must be from 0 to the spline length');
  const lengths = spline.arcLengths;
  if (!spline.length) return 0;
  let low = 0,
    high = lengths.length - 1;
  while (low + 1 < high) {
    const mid = (low + high) >>> 1;
    if (lengths[mid] < distance) low = mid;
    else high = mid;
  }
  const span = lengths[high] - lengths[low];
  return (low + (span ? (distance - lengths[low]) / span : 0)) / (lengths.length - 1);
}

/** An orthonormal frame on a curve: `binormal = tangent x normal`. */
export interface SplineFrame {
  position: Float64Array;
  tangent: Float64Array;
  normal: Float64Array;
  binormal: Float64Array;
}
/** Roll in radians: one value per knot (see {@link knotCount}), blended linearly, or a function of the parameter. */
export type Roll = ArrayLike<number> | ((t: number) => number);
/** Options for {@link SplineFrames}. */
export interface SplineFramesOptions {
  /** Intervals the curve is walked in, an integer 1..1,000,000. Default 256. */
  samples?: number;
  /** Which way "up" points at the start. Default [0, 1, 0]; used when it is not parallel to the first tangent. */
  up?: ArrayLike<number>;
  /** Roll about the tangent, added on top of the minimal rotation. */
  roll?: Roll;
  /** Closed curves only: spread the twist the loop picks up over its length so the frame meets itself. Default true. */
  closeLoop?: boolean;
}

const dot = (a: ArrayLike<number>, ao: number, b: ArrayLike<number>, bo: number): number =>
  a[ao] * b[bo] + a[ao + 1] * b[bo + 1] + a[ao + 2] * b[bo + 2];
/** Rotate `v` (at `vo`) about unit axis `k` by an angle, into `out`. */
const rotate = (
  v: ArrayLike<number>,
  vo: number,
  k: ArrayLike<number>,
  ko: number,
  angle: number,
  out: Float64Array,
  oo: number,
): void => {
  const c = Math.cos(angle),
    s = Math.sin(angle),
    d = dot(k, ko, v, vo) * (1 - c),
    cx = k[ko + 1] * v[vo + 2] - k[ko + 2] * v[vo + 1],
    cy = k[ko + 2] * v[vo] - k[ko] * v[vo + 2],
    cz = k[ko] * v[vo + 1] - k[ko + 1] * v[vo];
  out[oo] = v[vo] * c + cx * s + k[ko] * d;
  out[oo + 1] = v[vo + 1] * c + cy * s + k[ko + 1] * d;
  out[oo + 2] = v[vo + 2] * c + cz * s + k[ko + 2] * d;
};

/** A frame with fresh output arrays. */
export function newFrame(): SplineFrame {
  return {
    position: new Float64Array(3),
    tangent: new Float64Array(3),
    normal: new Float64Array(3),
    binormal: new Float64Array(3),
  };
}

/**
 * Rotation-minimising frames along a spline, so objects and cameras travel along it without flipping. Frames are
 * propagated along the curve by double reflection (Wang, Juttler, Zheng and Liu, 2008) from the first tangent and
 * `up`, and `roll` adds a twist about the tangent on top. Build once, then read frames at any distance.
 */
export class SplineFrames {
  readonly spline: Spline;
  readonly samples: number;
  /** Reference normal at each of `samples + 1` evenly spaced arc positions, 3 numbers each. */
  readonly normals: Float64Array;
  private readonly roll?: Roll;
  constructor(spline: Spline, { samples = 256, up = [0, 1, 0], roll, closeLoop = true }: SplineFramesOptions = {}) {
    if (!Number.isInteger(samples) || samples < 1 || samples > 1_000_000)
      throw new RangeError('samples must be an integer from 1 to 1,000,000');
    if (up.length !== 3 || !(Number.isFinite(up[0]) && Number.isFinite(up[1]) && Number.isFinite(up[2])))
      throw new TypeError('up must be a finite 3D vector');
    if (roll && typeof roll !== 'function') {
      const expected = knotCount(spline);
      if (roll.length !== expected) throw new RangeError(`roll needs ${expected} values, one per knot`);
      for (let i = 0; i < roll.length; i++) if (!Number.isFinite(roll[i])) throw new RangeError('roll must be finite');
    }
    this.spline = spline;
    this.samples = samples;
    this.roll = roll;
    const n = samples + 1,
      pos = new Float64Array(n * 3),
      tan = new Float64Array(n * 3),
      normals = new Float64Array(n * 3),
      scratch = new Float64Array(3),
      length = spline.length;
    for (let i = 0; i < n; i++) {
      const t = parameterAt(spline, (i / samples) * length);
      spline.at(t, scratch);
      pos.set(scratch, i * 3);
      spline.tangent(t, scratch);
      tan.set(scratch, i * 3);
    }
    // Start from `up` made perpendicular to the first tangent; fall back to the axis least aligned with it.
    let ux = up[0],
      uy = up[1],
      uz = up[2];
    const along = ux * tan[0] + uy * tan[1] + uz * tan[2];
    ux -= along * tan[0];
    uy -= along * tan[1];
    uz -= along * tan[2];
    let ul = Math.hypot(ux, uy, uz);
    if (ul < 1e-6) {
      const ax = Math.abs(tan[0]),
        ay = Math.abs(tan[1]),
        az = Math.abs(tan[2]);
      ux = ax <= ay && ax <= az ? 1 : 0;
      uy = ux === 0 && ay <= az ? 1 : 0;
      uz = ux === 0 && uy === 0 ? 1 : 0;
      const a2 = ux * tan[0] + uy * tan[1] + uz * tan[2];
      ux -= a2 * tan[0];
      uy -= a2 * tan[1];
      uz -= a2 * tan[2];
      ul = Math.hypot(ux, uy, uz);
    }
    normals[0] = ux / ul;
    normals[1] = uy / ul;
    normals[2] = uz / ul;
    for (let i = 0; i < samples; i++) {
      const a = i * 3,
        b = a + 3,
        v1x = pos[b] - pos[a],
        v1y = pos[b + 1] - pos[a + 1],
        v1z = pos[b + 2] - pos[a + 2],
        c1 = v1x * v1x + v1y * v1y + v1z * v1z;
      let rx = normals[a],
        ry = normals[a + 1],
        rz = normals[a + 2];
      if (c1 > 1e-24) {
        const k = 2 / c1,
          dr = k * (v1x * rx + v1y * ry + v1z * rz),
          dt = k * (v1x * tan[a] + v1y * tan[a + 1] + v1z * tan[a + 2]),
          rLx = rx - dr * v1x,
          rLy = ry - dr * v1y,
          rLz = rz - dr * v1z,
          v2x = tan[b] - (tan[a] - dt * v1x),
          v2y = tan[b + 1] - (tan[a + 1] - dt * v1y),
          v2z = tan[b + 2] - (tan[a + 2] - dt * v1z),
          c2 = v2x * v2x + v2y * v2y + v2z * v2z;
        if (c2 > 1e-24) {
          const d2 = (2 / c2) * (v2x * rLx + v2y * rLy + v2z * rLz);
          rx = rLx - d2 * v2x;
          ry = rLy - d2 * v2y;
          rz = rLz - d2 * v2z;
        } else {
          rx = rLx;
          ry = rLy;
          rz = rLz;
        }
      }
      // Keep the normal exactly perpendicular and unit length against drift.
      const dd = rx * tan[b] + ry * tan[b + 1] + rz * tan[b + 2];
      rx -= dd * tan[b];
      ry -= dd * tan[b + 1];
      rz -= dd * tan[b + 2];
      const rl = Math.hypot(rx, ry, rz) || 1;
      normals[b] = rx / rl;
      normals[b + 1] = ry / rl;
      normals[b + 2] = rz / rl;
    }
    if (spline.closed && closeLoop && length > 0) {
      const e = samples * 3,
        cx = normals[e + 1] * normals[2] - normals[e + 2] * normals[1],
        cy = normals[e + 2] * normals[0] - normals[e] * normals[2],
        cz = normals[e] * normals[1] - normals[e + 1] * normals[0],
        twist = Math.atan2(cx * tan[0] + cy * tan[1] + cz * tan[2], dot(normals, e, normals, 0));
      for (let i = 1; i <= samples; i++) rotate(normals, i * 3, tan, i * 3, (twist * i) / samples, normals, i * 3);
      normals.set(normals.subarray(0,3),e);
    }
    this.normals = normals;
  }
  /** Roll in radians at curve parameter `t`. */
  rollAt(t: number): number {
    const roll = this.roll;
    if (!roll) return 0;
    if (typeof roll === 'function') return roll(t);
    const segments = splineSegmentCount(this.spline),
      scaled = t * segments,
      k = Math.min(segments - 1, Math.floor(scaled)),
      w = scaled - k;
    return roll[k] * (1 - w) + roll[this.spline.closed ? (k + 1) % roll.length : k + 1] * w;
  }
  /** Frame at an arc-length position (0 to the spline length), written into `out`. */
  frameAt(distance: number, out: SplineFrame = newFrame()): SplineFrame {
    const spline = this.spline,
      t = parameterAt(spline, distance),
      f = spline.length ? (distance / spline.length) * this.samples : 0,
      i = Math.min(this.samples - 1, Math.floor(f)),
      w = f - i,
      n = this.normals;
    spline.at(t, out.position);
    spline.tangent(t, out.tangent);
    const T = out.tangent;
    let rx = n[i * 3] * (1 - w) + n[i * 3 + 3] * w,
      ry = n[i * 3 + 1] * (1 - w) + n[i * 3 + 4] * w,
      rz = n[i * 3 + 2] * (1 - w) + n[i * 3 + 5] * w;
    const d = rx * T[0] + ry * T[1] + rz * T[2];
    rx -= d * T[0];
    ry -= d * T[1];
    rz -= d * T[2];
    const rl = Math.hypot(rx, ry, rz);
    if (rl < 1e-9) {
      // Opposite neighbours cancelled; the nearer sample still points somewhere perpendicular enough.
      const j = (w < 0.5 ? i : i + 1) * 3;
      rx = n[j];
      ry = n[j + 1];
      rz = n[j + 2];
    } else {
      rx /= rl;
      ry /= rl;
      rz /= rl;
    }
    out.normal[0] = rx;
    out.normal[1] = ry;
    out.normal[2] = rz;
    const roll = this.rollAt(t);
    if (roll) rotate(out.normal, 0, T, 0, roll, out.normal, 0);
    const N = out.normal;
    out.binormal[0] = T[1] * N[2] - T[2] * N[1];
    out.binormal[1] = T[2] * N[0] - T[0] * N[2];
    out.binormal[2] = T[0] * N[1] - T[1] * N[0];
    return out;
  }
  /** Frame at curve parameter `t` (0..1). */
  frameAtParameter(t: number, out?: SplineFrame): SplineFrame {
    return this.frameAt(distanceAt(this.spline, t), out);
  }
}
