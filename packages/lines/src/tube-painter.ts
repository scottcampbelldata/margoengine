// Freehand 3D strokes as smooth tubes. A stroke is a list of points (from a pointer ray or an XR controller); the tube
// around it uses rotation-minimizing frames so it does not twist: the double-reflection method of Wang, Juettler, Zheng
// and Liu, "Computation of rotation minimizing frames", ACM Transactions on Graphics 27(1), 2008, which is Bishop's
// parallel transport ("There is more than one way to frame a curve", American Mathematical Monthly 82(3), 1975)
// computed without trigonometry.
import { Geometry } from '@margoengine/core';
import { rangeError } from '../../shared/errors.js';

/** Settings of {@link TubePainter}. */
export interface TubePainterOptions {
  /** Tube radius in world units at pressure 1. Default 0.01. */
  radius?: number;
  /** Vertices around each ring, 3 to 64. Default 8. */
  sides?: number;
  /** World units a point must move from the last kept point to be added. Default `radius / 2`. */
  minDistance?: number;
  /** Points kept per stroke, 2 to 65,536; later points are ignored until the next `begin`. Default 4096. */
  maxPoints?: number;
  /** Close the ends with flat discs. Default true. */
  caps?: boolean;
}
/** Mesh data of the painted strokes: three numbers per position and normal, three indices per triangle. */
export interface TubeData {
  positions: Float32Array;
  normals: Float32Array;
  indices: Uint32Array;
}

type V3 = [number, number, number];
const bad = (message: string): never => {
  throw rangeError(`TubePainter: ${message}; pass valid options`, 'arguments');
};
const finite3 = (p: ArrayLike<number>, what: string): V3 => {
  if (!p || p.length < 3 || !Number.isFinite(p[0]) || !Number.isFinite(p[1]) || !Number.isFinite(p[2]))
    return bad(`${what} must be three finite numbers`);
  return [p[0], p[1], p[2]];
};
const dot = (a: V3, b: V3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const unit = (a: V3): V3 => {
  const l = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};
/** `v` reflected in the plane through the origin with normal `n`, where `c` is n.n (0 leaves `v` as it is). */
const reflect = (v: V3, n: V3, c: number): V3 => {
  if (c < 1e-18) return v;
  const k = (2 * dot(n, v)) / c;
  return [v[0] - k * n[0], v[1] - k * n[1], v[2] - k * n[2]];
};

interface Stroke {
  points: V3[];
  radii: number[];
}

/** The point `distance` along a ray: a pointer ray through the screen, or a controller's pose and forward direction. */
export function rayPoint(origin: ArrayLike<number>, direction: ArrayLike<number>, distance: number): [number, number, number] {
  const o = finite3(origin, 'origin'),
    d = unit(finite3(direction, 'direction'));
  if (!Number.isFinite(distance)) bad('distance must be a finite number');
  return [o[0] + d[0] * distance, o[1] + d[1] * distance, o[2] + d[2] * distance];
}

/**
 * Paints tubes along freehand 3D strokes. `begin` starts a stroke, `add` extends it with the pointer ray's point or the
 * controller's position (with a pressure that scales the radius), `end` finishes it; `data()` or `toGeometry()` turns every
 * stroke into one mesh. Strokes with fewer than 2 points draw nothing.
 */
export class TubePainter {
  private readonly strokes: Stroke[] = [];
  private open: Stroke | null = null;
  readonly radius: number;
  readonly sides: number;
  readonly minDistance: number;
  readonly maxPoints: number;
  readonly caps: boolean;
  constructor(options: TubePainterOptions = {}) {
    const { radius = 0.01, sides = 8, maxPoints = 4096, caps = true } = options;
    if (!(radius > 0) || !Number.isFinite(radius)) bad('radius must be a finite number above 0');
    if (!Number.isInteger(sides) || sides < 3 || sides > 64) bad('sides must be an integer from 3 to 64');
    if (!Number.isInteger(maxPoints) || maxPoints < 2 || maxPoints > 65536) bad('maxPoints must be an integer from 2 to 65536');
    const minDistance = options.minDistance ?? radius / 2;
    if (!(minDistance > 0) || !Number.isFinite(minDistance)) bad('minDistance must be a finite number above 0');
    this.radius = radius;
    this.sides = sides;
    this.maxPoints = maxPoints;
    this.minDistance = minDistance;
    this.caps = caps;
  }
  /** Strokes begun so far, the open one included. */
  get strokeCount(): number {
    return this.strokes.length;
  }
  /** True while a stroke is open. */
  get painting(): boolean {
    return this.open !== null;
  }
  /** Starts a stroke at `point` (ends the open one). `pressure` scales the radius, 0 or more (default 1). */
  begin(point: ArrayLike<number>, pressure = 1): void {
    this.end();
    this.open = { points: [], radii: [] };
    this.strokes.push(this.open);
    this.add(point, pressure);
  }
  /**
   * Extends the open stroke. Returns false when nothing was added: no stroke is open, the point is closer than
   * `minDistance` to the last one, or the stroke holds `maxPoints`.
   */
  add(point: ArrayLike<number>, pressure = 1): boolean {
    const p = finite3(point, 'point');
    if (!(pressure >= 0) || !Number.isFinite(pressure)) bad('pressure must be a finite number of 0 or more');
    const s = this.open;
    if (!s || s.points.length >= this.maxPoints) return false;
    const last = s.points[s.points.length - 1];
    if (last && Math.hypot(p[0] - last[0], p[1] - last[1], p[2] - last[2]) < this.minDistance) return false;
    s.points.push(p);
    s.radii.push(this.radius * pressure);
    return true;
  }
  /** Finishes the open stroke. */
  end(): void {
    this.open = null;
  }
  /** Removes the last stroke. Returns false when there is none. */
  undo(): boolean {
    this.open = null;
    return this.strokes.pop() !== undefined;
  }
  /** Removes every stroke. */
  clear(): void {
    this.open = null;
    this.strokes.length = 0;
  }
  /** The mesh data of every stroke at the current points (rebuilt on each call, linear in the number of points). */
  data(): TubeData {
    const n = this.sides,
      pos: number[] = [],
      nor: number[] = [],
      idx: number[] = [];
    for (const s of this.strokes) {
      const m = s.points.length;
      if (m < 2) continue;
      const P = s.points,
        T: V3[] = P.map((_, i) => unit(sub(P[Math.min(i + 1, m - 1)], P[Math.max(i - 1, 0)])));
      // Normal of the first ring: any direction perpendicular to the tangent, away from the axis it is least aligned with.
      const t0 = T[0],
        axis: V3 = Math.abs(t0[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
      const R: V3[] = [unit(cross(t0, axis))];
      for (let i = 1; i < m; i++) {
        // Double reflection: mirror the frame in the plane bisecting the step, then in the plane that restores the tangent.
        const v1 = sub(P[i], P[i - 1]),
          c1 = dot(v1, v1),
          rL = reflect(R[i - 1], v1, c1),
          tL = reflect(T[i - 1], v1, c1),
          v2 = sub(T[i], tL);
        R.push(unit(reflect(rL, v2, dot(v2, v2))));
      }
      const ring = (i: number, tangentSign: number): number => {
        const first = pos.length / 3,
          r = R[i],
          b = cross(T[i], r);
        for (let k = 0; k < n; k++) {
          const a = (k / n) * Math.PI * 2,
            c = Math.cos(a),
            sn = Math.sin(a),
            x = c * r[0] + sn * b[0],
            y = c * r[1] + sn * b[1],
            z = c * r[2] + sn * b[2];
          pos.push(P[i][0] + s.radii[i] * x, P[i][1] + s.radii[i] * y, P[i][2] + s.radii[i] * z);
          if (tangentSign === 0) nor.push(x, y, z);
          else nor.push(tangentSign * T[i][0], tangentSign * T[i][1], tangentSign * T[i][2]);
        }
        return first;
      };
      const rings: number[] = [];
      for (let i = 0; i < m; i++) rings.push(ring(i, 0));
      for (let i = 0; i + 1 < m; i++)
        for (let k = 0; k < n; k++) {
          const a = rings[i] + k,
            b = rings[i] + ((k + 1) % n),
            c = rings[i + 1] + k,
            d = rings[i + 1] + ((k + 1) % n);
          idx.push(a, b, c, b, d, c);
        }
      if (this.caps)
        for (const [i, sign] of [
          [0, -1],
          [m - 1, 1],
        ] as const) {
          const edge = ring(i, sign),
            centre = pos.length / 3;
          pos.push(P[i][0], P[i][1], P[i][2]);
          nor.push(sign * T[i][0], sign * T[i][1], sign * T[i][2]);
          for (let k = 0; k < n; k++) {
            const a = edge + k,
              b = edge + ((k + 1) % n);
            if (sign < 0) idx.push(centre, b, a);
            else idx.push(centre, a, b);
          }
        }
    }
    return { positions: new Float32Array(pos), normals: new Float32Array(nor), indices: new Uint32Array(idx) };
  }
  /** A core `Geometry` of every stroke, for `engine.createMesh().setGeometry(...)`; an empty geometry when nothing is painted. */
  toGeometry(): Geometry {
    const d = this.data();
    return new Geometry(d.positions, d.normals, d.indices);
  }
}
