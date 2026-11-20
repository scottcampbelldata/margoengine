// A small flat-shaded mesh builder for the building and harbour rules: planar polygons, extruded slabs, oriented boxes,
// frustums and clipped strips, with UVs in metres anchored to the world (so a tiled texture runs on across faces) and
// tangents from the same axes. Internal to @margoengine/procedural; our own code.
import type { GeometryData } from '@margoengine/geometry/utils';

export type V3 = readonly [number, number, number];
export const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const scale = (a: V3, s: number): V3 => [a[0] * s, a[1] * s, a[2] * s];
export const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const cross = (a: V3, b: V3): V3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
export const len = (a: V3) => Math.hypot(a[0], a[1], a[2]);
export const unit = (a: V3): V3 => {
  const l = len(a);
  return l > 0 ? scale(a, 1 / l) : [0, 1, 0];
};
export const lerp = (a: V3, b: V3, t: number): V3 => [
  a[0] + (b[0] - a[0]) * t,
  a[1] + (b[1] - a[1]) * t,
  a[2] + (b[2] - a[2]) * t,
];

/** Newell normal of a polygon (unnormalised length is twice the area). */
export function newell(p: readonly V3[]): V3 {
  let x = 0,
    y = 0,
    z = 0;
  for (let i = 0; i < p.length; i++) {
    const a = p[i],
      b = p[(i + 1) % p.length];
    x += (a[1] - b[1]) * (a[2] + b[2]);
    y += (a[2] - b[2]) * (a[0] + b[0]);
    z += (a[0] - b[0]) * (a[1] + b[1]);
  }
  return [x, y, z];
}
/** Drops repeated corners (within 1e-7 m), including the last against the first. */
export function dedupe(p: readonly V3[]): V3[] {
  const out: V3[] = [];
  for (const q of p) if (!out.length || len(sub(q, out[out.length - 1])) > 1e-7) out.push(q);
  while (out.length > 1 && len(sub(out[0], out[out.length - 1])) <= 1e-7) out.pop();
  return out;
}
/** Texture axes for a face of normal n: u horizontal, v up the face (or world x and z on a level face). */
export function axes(n: V3): [V3, V3] {
  if (Math.abs(n[1]) > 0.999) return [[1, 0, 0], n[1] > 0 ? [0, 0, -1] : [0, 0, 1]];
  const u = unit([n[2], 0, -n[0]]);
  return [u, cross(n, u)];
}

export class MeshBuilder {
  private p: number[] = [];
  private n: number[] = [];
  private uv: number[] = [];
  private t: number[] = [];
  private i: number[] = [];
  get triangles() {
    return this.i.length / 3;
  }
  get vertices() {
    return this.p.length / 3;
  }
  /** A planar convex polygon, front face toward `toward` when given (else by its winding). */
  poly(points: readonly V3[], toward?: V3): void {
    let p = dedupe(points);
    if (p.length < 3) return;
    let nn = newell(p);
    if (len(nn) < 1e-12) return;
    if (toward && dot(nn, toward) < 0) {
      p = p.slice().reverse();
      nn = scale(nn, -1);
    }
    const n = unit(nn),
      [u, v] = axes(n),
      base = this.p.length / 3;
    for (const q of p) {
      this.p.push(q[0], q[1], q[2]);
      this.n.push(n[0], n[1], n[2]);
      this.uv.push(dot(q, u), dot(q, v));
      this.t.push(u[0], u[1], u[2], 1);
    }
    for (let k = 1; k + 1 < p.length; k++) this.i.push(base, base + k, base + k + 1);
  }
  /** A planar convex polygon given outward, extruded by `depth` along `-normal` (a wall, a slab). */
  slab(points: readonly V3[], depth: number, toward?: V3, open = false): void {
    let p = dedupe(points);
    if (p.length < 3) return;
    let nn = newell(p);
    if (toward && dot(nn, toward) < 0) {
      p = p.slice().reverse();
      nn = scale(nn, -1);
    }
    const n = unit(nn),
      off = scale(n, -depth),
      back = p.map((q) => add(q, off));
    this.poly(p, n);
    if (!open) this.poly(back.slice().reverse(), scale(n, -1));
    for (let k = 0; k < p.length; k++) {
      const a = p[k],
        b = p[(k + 1) % p.length];
      const side = [a, add(a, off), add(b, off), b];
      this.poly(side, cross(sub(b, a), n));
    }
  }
  /** A box of half sizes h on axes (ax, ay, az, unit and orthogonal) centred at c. */
  box(c: V3, h: V3, ax: V3 = [1, 0, 0], ay: V3 = [0, 1, 0], az: V3 = [0, 0, 1]): void {
    const corner = (sx: number, sy: number, sz: number): V3 =>
      add(c, add(scale(ax, sx * h[0]), add(scale(ay, sy * h[1]), scale(az, sz * h[2]))));
    const faces: [V3, [number, number, number][]][] = [
      [ax, [[1, -1, -1], [1, 1, -1], [1, 1, 1], [1, -1, 1]]],
      [scale(ax, -1), [[-1, -1, 1], [-1, 1, 1], [-1, 1, -1], [-1, -1, -1]]],
      [ay, [[-1, 1, -1], [-1, 1, 1], [1, 1, 1], [1, 1, -1]]],
      [scale(ay, -1), [[-1, -1, 1], [-1, -1, -1], [1, -1, -1], [1, -1, 1]]],
      [az, [[-1, -1, 1], [1, -1, 1], [1, 1, 1], [-1, 1, 1]]],
      [scale(az, -1), [[1, -1, -1], [-1, -1, -1], [-1, 1, -1], [1, 1, -1]]],
    ];
    for (const [nrm, cs] of faces) this.poly(cs.map(([x, y, z]) => corner(x, y, z)), nrm);
  }
  /** A box between two points with a square-ish section: width along `side`, height along the rest. */
  beam(a: V3, b: V3, w: number, h: number, up: V3 = [0, 1, 0]): void {
    const d = sub(b, a),
      l = len(d);
    if (l < 1e-6) return;
    const ax = scale(d, 1 / l);
    let az = cross(ax, up);
    if (len(az) < 1e-6) az = cross(ax, [1, 0, 0]);
    az = unit(az);
    const ay = cross(az, ax);
    this.box(lerp(a, b, 0.5), [l / 2, h / 2, w / 2], ax, ay, az);
  }
  /** A frustum (closed) from centre a (radius ra) to centre b (radius rb), with `segments` flat sides. */
  frustum(a: V3, b: V3, ra: number, rb: number, segments: number, caps = true): void {
    const d = unit(sub(b, a));
    let e1 = cross(d, [0, 1, 0]);
    if (len(e1) < 1e-6) e1 = cross(d, [1, 0, 0]);
    e1 = unit(e1);
    const e2 = cross(d, e1),
      ring = (c: V3, r: number) =>
        Array.from({ length: segments }, (_, k): V3 => {
          const t = (2 * Math.PI * k) / segments;
          return add(c, add(scale(e1, r * Math.cos(t)), scale(e2, r * Math.sin(t))));
        }),
      A = ring(a, ra),
      B = ring(b, rb);
    for (let k = 0; k < segments; k++) {
      const k1 = (k + 1) % segments,
        mid = lerp(lerp(A[k], A[k1], 0.5), lerp(B[k], B[k1], 0.5), 0.5),
        out = sub(mid, lerp(a, b, 0.5));
      this.poly([A[k], A[k1], B[k1], B[k]], sub(out, scale(d, dot(out, d))));
    }
    if (caps) {
      this.poly(A, scale(d, -1));
      this.poly(B, d);
    }
  }
  /** Appends another builder's triangles. */
  append(o: MeshBuilder): void {
    const base = this.p.length / 3;
    this.p.push(...o.p);
    this.n.push(...o.n);
    this.uv.push(...o.uv);
    this.t.push(...o.t);
    for (const k of o.i) this.i.push(k + base);
  }
  /** Turns by yaw about +y and moves to origin; returns the owned geometry with tangents. */
  finish(origin: V3 = [0, 0, 0], yaw = 0): GeometryData {
    const c = Math.cos(yaw),
      s = Math.sin(yaw),
      count = this.p.length / 3,
      P = new Float32Array(count * 3),
      N = new Float32Array(count * 3),
      T = new Float32Array(count * 4);
    for (let k = 0; k < count; k++) {
      const x = this.p[3 * k],
        z = this.p[3 * k + 2];
      P[3 * k] = origin[0] + x * c + z * s;
      P[3 * k + 1] = origin[1] + this.p[3 * k + 1];
      P[3 * k + 2] = origin[2] - x * s + z * c;
      const nx = this.n[3 * k],
        nz = this.n[3 * k + 2];
      N[3 * k] = nx * c + nz * s;
      N[3 * k + 1] = this.n[3 * k + 1];
      N[3 * k + 2] = -nx * s + nz * c;
      const tx = this.t[4 * k],
        tz = this.t[4 * k + 2];
      T[4 * k] = tx * c + tz * s;
      T[4 * k + 1] = this.t[4 * k + 1];
      T[4 * k + 2] = -tx * s + tz * c;
      T[4 * k + 3] = 1;
    }
    return {
      positions: P,
      normals: N,
      uvs: Float32Array.from(this.uv),
      indices: Uint32Array.from(this.i),
      tangents: T,
    };
  }
}

/** Sutherland-Hodgman clip of a convex polygon by the half space f(p) >= 0, f linear. */
export function clip(p: readonly V3[], f: (q: V3) => number): V3[] {
  const out: V3[] = [];
  for (let k = 0; k < p.length; k++) {
    const a = p[k],
      b = p[(k + 1) % p.length],
      fa = f(a),
      fb = f(b);
    if (fa >= 0) out.push(a);
    if ((fa >= 0) !== (fb >= 0)) out.push(lerp(a, b, fa / (fa - fb)));
  }
  return out;
}

/** mulberry32: a small seeded generator. */
export function random(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
