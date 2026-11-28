// The debug view of floating bodies (SEA-12): each compact body's edges below the water, its waterline, its centre of
// buoyancy and its load arrows, as line segments for `@margoengine/physics/debug-view` (`view.add(loads)`). Drawing only:
// an analytic shape (sphere, ellipsoid, capsule) is drawn as a fine closed surface; its loads stay analytic.
import { cos, hypot, sin } from '@margoengine/math/pinned';
import type { HullMesh, Quat, Vec3 } from '../seakeeping/wetted.js';

/** Line segments: x, y, z of two vertices a segment; r, g, b, a a vertex. */
export interface LoadLines {
  vertices: Float32Array;
  colors: Float32Array;
}

type Colour = readonly [number, number, number, number];
export const SUBMERGED: Colour = [0.25, 0.55, 1, 1];
export const WATERLINE: Colour = [1, 1, 1, 1];
export const BUOYANCY_CENTRE: Colour = [1, 0.25, 0.85, 1];
export const BUOYANCY: Colour = [0.2, 0.95, 1, 1];
export const LOAD: Colour = [1, 0.6, 0.15, 1];

/** A closed latitude-longitude surface of an ellipsoid, or of a capsule along `frame[1]`, body frame about the centre. */
export function analyticOutline(
  axes: Vec3,
  frame: readonly [Vec3, Vec3, Vec3],
  capsule?: { readonly radius: number; readonly halfHeight: number },
): HullMesh {
  const rings = 12,
    sides = 24,
    vertices: number[] = [],
    indices: number[] = [];
  const at = (u: Vec3): void => {
    for (let k = 0; k < 3; k++) vertices.push(u[0] * frame[0][k]! + u[1] * frame[1][k]! + u[2] * frame[2][k]!);
  };
  // Poles first, then the rings from the top; a capsule's rings split at its equator into two hemispheres.
  const top = capsule ? capsule.halfHeight + capsule.radius : axes[1],
    point = (ring: number, side: number): Vec3 => {
      const theta = (Math.PI * ring) / rings,
        phi = (2 * Math.PI * side) / sides,
        s = sin(theta),
        c = cos(theta);
      if (capsule) {
        const lift = ring <= rings / 2 ? capsule.halfHeight : -capsule.halfHeight;
        return [capsule.radius * s * cos(phi), lift + capsule.radius * c, capsule.radius * s * sin(phi)];
      }
      return [axes[0] * s * cos(phi), axes[1] * c, axes[2] * s * sin(phi)];
    };
  at([0, top, 0]);
  at([0, -top, 0]);
  // A capsule repeats its equator ring so the straight section joins the two hemispheres.
  const ringList: number[] = [];
  for (let r = 1; r < rings; r++) {
    ringList.push(r);
    if (capsule && r === rings / 2) ringList.push(r + 0.5);
  }
  ringList.forEach((r) => {
    for (let s = 0; s < sides; s++) {
      const p =
        r % 1 === 0
          ? point(r, s)
          : (() => {
              const q = point(rings / 2, s);
              return [q[0], -capsule!.halfHeight, q[2]] as Vec3;
            })();
      at(p);
    }
  });
  const ring = (i: number, s: number) => 2 + i * sides + (s % sides);
  for (let s = 0; s < sides; s++) {
    indices.push(0, ring(0, s + 1), ring(0, s));
    indices.push(1, ring(ringList.length - 1, s), ring(ringList.length - 1, s + 1));
  }
  for (let i = 0; i + 1 < ringList.length; i++)
    for (let s = 0; s < sides; s++) {
      indices.push(ring(i, s), ring(i, s + 1), ring(i + 1, s + 1));
      indices.push(ring(i, s), ring(i + 1, s + 1), ring(i + 1, s));
    }
  return { vertices: Float64Array.from(vertices), indices: Uint32Array.from(indices) };
}

/** Collects segments and their colours. */
export class LineSink {
  readonly vertices: number[] = [];
  readonly colors: number[] = [];
  segment(a: readonly number[], b: readonly number[], colour: Colour): void {
    this.vertices.push(a[0]!, a[1]!, a[2]!, b[0]!, b[1]!, b[2]!);
    this.colors.push(...colour, ...colour);
  }
  /** An arrow from `from` along `vector`, its head a fifth of its length (at most 0.15 m). */
  arrow(from: Vec3, vector: Vec3, colour: Colour): void {
    const length = hypot(vector[0], vector[1], vector[2]);
    if (!(length > 1e-6)) return;
    const tip: Vec3 = [from[0] + vector[0], from[1] + vector[1], from[2] + vector[2]],
      d: Vec3 = [vector[0] / length, vector[1] / length, vector[2] / length],
      // Any direction across the arrow.
      side: Vec3 = Math.abs(d[1]) < 0.9 ? normal([d[2], 0, -d[0]]) : normal([0, -d[2], d[1]]),
      head = Math.min(0.15, 0.2 * length);
    this.segment(from, tip, colour);
    for (const s of [1, -1])
      this.segment(
        tip,
        [
          tip[0] - head * d[0] + s * 0.5 * head * side[0],
          tip[1] - head * d[1] + s * 0.5 * head * side[1],
          tip[2] - head * d[2] + s * 0.5 * head * side[2],
        ],
        colour,
      );
  }
  /** A cross of three segments of half size `size`. */
  cross(at: Vec3, size: number, colour: Colour): void {
    for (let k = 0; k < 3; k++) {
      const a = [at[0], at[1], at[2]],
        b = [at[0], at[1], at[2]];
      a[k]! -= size;
      b[k]! += size;
      this.segment(a, b, colour);
    }
  }
  lines(): LoadLines {
    return { vertices: Float32Array.from(this.vertices), colors: Float32Array.from(this.colors) };
  }
}

function normal(v: Vec3): Vec3 {
  const l = hypot(v[0], v[1], v[2]);
  return [v[0] / l, v[1] / l, v[2] / l];
}

/**
 * Draws a body surface at a pose against the water: the parts of its edges below the surface in `submerged`, and where
 * the surface cuts each triangle in `waterline`. Heights are read from `elevation` at every vertex, so a wave shows.
 */
export function drawWetted(
  out: LineSink,
  mesh: HullMesh,
  centre: Vec3,
  rotation: Quat,
  elevation: (x: number, z: number) => number,
  submerged: boolean,
  waterline: boolean,
): void {
  const { vertices, indices } = mesh,
    count = vertices.length / 3,
    world = new Float64Array(vertices.length),
    height = new Float64Array(count);
  for (let i = 0; i < count; i++) {
    const p = turn(rotation, vertices[3 * i]!, vertices[3 * i + 1]!, vertices[3 * i + 2]!);
    world[3 * i] = p[0] + centre[0];
    world[3 * i + 1] = p[1] + centre[1];
    world[3 * i + 2] = p[2] + centre[2];
    height[i] = world[3 * i + 1]! - elevation(world[3 * i]!, world[3 * i + 2]!);
  }
  const at = (i: number): Vec3 => [world[3 * i]!, world[3 * i + 1]!, world[3 * i + 2]!],
    cut = (i: number, j: number): Vec3 => {
      const s = height[i]! / (height[i]! - height[j]!);
      return [
        world[3 * i]! + s * (world[3 * j]! - world[3 * i]!),
        world[3 * i + 1]! + s * (world[3 * j + 1]! - world[3 * i + 1]!),
        world[3 * i + 2]! + s * (world[3 * j + 2]! - world[3 * i + 2]!),
      ];
    },
    drawn = new Set<number>();
  for (let t = 0; t + 2 < indices.length; t += 3) {
    const corner = [indices[t]!, indices[t + 1]!, indices[t + 2]!];
    if (submerged)
      for (let k = 0; k < 3; k++) {
        const i = corner[k]!,
          j = corner[(k + 1) % 3]!,
          key = i < j ? i * count + j : j * count + i;
        if (drawn.has(key)) continue;
        drawn.add(key);
        const wi = height[i]! < 0,
          wj = height[j]! < 0;
        if (wi && wj) out.segment(at(i), at(j), SUBMERGED);
        else if (wi !== wj) out.segment(wi ? at(i) : at(j), cut(i, j), SUBMERGED);
      }
    if (waterline) {
      const crossing: Vec3[] = [];
      for (let k = 0; k < 3; k++) {
        const i = corner[k]!,
          j = corner[(k + 1) % 3]!;
        if (height[i]! < 0 !== height[j]! < 0) crossing.push(cut(i, j));
      }
      if (crossing.length === 2) out.segment(crossing[0]!, crossing[1]!, WATERLINE);
    }
  }
}

function turn(q: Quat, x: number, y: number, z: number): Vec3 {
  const tx = 2 * (q[1] * z - q[2] * y),
    ty = 2 * (q[2] * x - q[0] * z),
    tz = 2 * (q[0] * y - q[1] * x);
  return [
    x + q[3] * tx + (q[1] * tz - q[2] * ty),
    y + q[3] * ty + (q[2] * tx - q[0] * tz),
    z + q[3] * tz + (q[0] * ty - q[1] * tx),
  ];
}
