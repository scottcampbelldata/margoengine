// Glass and light geometry shared by the global and refracted bakes: convex boundaries as planes, ray clipping,
// Fresnel, Beer absorption and rectangle light frames.
import type { RectAreaLight } from '@margoengine/math';
import type { MutableVec3 as V3 } from '@margoengine/math';
import { cross, dot, length, normalize, scale, sub } from '@margoengine/math/vec3';
import { finiteVector } from '@margoengine/math/validate';
import {
  type TransmissionOptions,
  type VolumeOptions,
  validateTransmission,
} from '@margoengine/materials/transmission';
import { attenuationPower } from '../../shared/attenuation.js';
import { rectFrame } from '../../shared/rect-frame.js';
import { unit } from './bake.js';

/** An outward boundary plane through `point`. */
export interface Plane {
  point: V3;
  normal: V3;
}

/** A validated glass medium: IOR, and Beer attenuation as linear RGB left per `1 / inverseDistance` world units. */
export interface Medium {
  ior: number;
  color: readonly number[];
  inverseDistance: number;
}

/** A glass volume's medium, validated by the transmission material's rules (IOR at least 1, color 0 to 1). */
export function mediumOf(
  value: Pick<TransmissionOptions, 'ior'> & Pick<VolumeOptions, 'attenuationColor' | 'attenuationDistance'>,
): Medium {
  const checked = validateTransmission({
    factor: 1,
    ior: value.ior,
    volume: { attenuationColor: value.attenuationColor, attenuationDistance: value.attenuationDistance },
  });
  return { ior: checked.ior, color: [...checked.color], inverseDistance: checked.inverseDistance };
}

/**
 * The distinct outward planes of a closed convex triangle boundary. Throws unless every edge is shared once in each
 * direction (closed, consistently wound), every triangle is nondegenerate, no vertex lies outside any plane by more
 * than a millionth of the volume's size (convex, outward) and the volume has thickness.
 */
export function convexPlanes(triangles: readonly (readonly V3[])[], label: string): Plane[] {
  const edges = new Map<string, string>(),
    points = triangles.flat(),
    size = Math.max(...points.map((p) => length(sub(p, points[0])))),
    tolerance = 1e-6 * size,
    planes: Plane[] = [];
  for (const [a, b, c] of triangles) {
    const n = cross(sub(b, a), sub(c, a));
    if (!(length(n) > 1e-12 * size * size))
      throw new RangeError(`${label} has a degenerate triangle; repair its corners`);
    for (const [x, y] of [
      [a, b],
      [b, c],
      [c, a],
    ]) {
      const key = `${x}/${y}`;
      if (edges.has(key)) throw new RangeError(`${label} must be closed and outward wound with no repeated faces`);
      edges.set(key, `${y}/${x}`);
    }
    const plane = { point: a, normal: normalize(n) },
      depths = points.map((p) => dot(plane.normal, sub(p, a)));
    if (Math.max(...depths) > tolerance) throw new RangeError(`${label} must be convex with outward winding`);
    if (!(Math.min(...depths) < -tolerance)) throw new RangeError(`${label} needs positive thickness`);
    // Coplanar triangles share one plane, so a ray crossing their shared diagonal meets one boundary.
    if (
      !planes.some(
        (p) => dot(p.normal, plane.normal) > 1 - 1e-9 && Math.abs(dot(p.normal, sub(a, p.point))) <= tolerance,
      )
    )
      planes.push(plane);
  }
  for (const reverse of edges.values())
    if (!edges.has(reverse)) throw new RangeError(`${label} must be closed with matching edges`);
  return planes;
}

/**
 * Where the line origin + t * direction enters and leaves the convex volume: `enter` (or -Infinity) and `exit` (or
 * Infinity), with the planes crossed there (-1 for none). `skip` is a plane the origin lies on (it counts as distance
 * 0, so a ray leaving a boundary does not meet it again). Undefined when the line misses.
 */
export function clip(
  planes: readonly Plane[],
  origin: ArrayLike<number>,
  direction: ArrayLike<number>,
  skip = -1,
): { enter: number; exit: number; entry: number; leaving: number } | undefined {
  let enter = -Infinity,
    exit = Infinity,
    entry = -1,
    leaving = -1;
  for (let i = 0; i < planes.length; i++) {
    const p = planes[i],
      distance = i === skip ? 0 : dot(p.normal, sub(origin, p.point)),
      rate = dot(p.normal, direction);
    if (rate === 0) {
      if (distance > 0) return;
      continue;
    }
    const at = -distance / rate;
    if (rate < 0 && at > enter) {
      enter = at;
      entry = i;
    }
    if (rate > 0 && at < exit) {
      exit = at;
      leaving = i;
    }
  }
  return exit > enter ? { enter, exit, entry, leaving } : undefined;
}

/** Unpolarized Fresnel reflectance at a smooth boundary from IOR `from` into `to`; 1 under total internal reflection. */
export function fresnel(cosine: number, from: number, to: number): number {
  if (from === to) return 0;
  const sin2 = (from / to) ** 2 * Math.max(0, 1 - cosine * cosine);
  if (sin2 >= 1) return 1;
  const ct = Math.sqrt(1 - sin2),
    a = from * cosine,
    b = to * ct,
    c = from * ct,
    d = to * cosine;
  return Math.min(1, 0.5 * (((a - b) / (a + b)) ** 2 + ((c - d) / (c + d)) ** 2));
}

/** Share of one channel left after `distance` inside `medium`. A black channel stays black on any positive path. */
export const beer = (medium: Medium, channel: number, distance: number): number =>
  !medium.inverseDistance || !(distance > 0)
    ? 1
    : medium.color[channel] === 0
      ? 0
      : attenuationPower(medium.color[channel], distance * medium.inverseDistance);

/** A rectangle light as a corner, two edges, a unit emitting normal and linear RGB radiance. */
export interface Rect {
  corner: V3;
  u: V3;
  v: V3;
  normal: V3;
  radiance: V3;
  twoSided: boolean;
}

/** The rectangle of a `RectAreaLight` (math; clustered uses the same type), framed by the same shared `rectFrame` the clustered lights use. */
export function rectOf(light: RectAreaLight, label: string): Rect {
  finiteVector(light.position, 3, `${label} position`);
  finiteVector(light.direction, 3, `${label} direction`);
  finiteVector(light.color ?? [1, 1, 1], 3, `${label} color`);
  if (light.up) finiteVector(light.up, 3, `${label} up`);
  unit(light.direction, `${label} direction`);
  const { normal, right, up } = rectFrame(light.direction, light.up, label),
    intensity = light.intensity ?? 1,
    radiance = scale(light.color ?? [1, 1, 1], intensity);
  if (!(light.width > 0 && light.width < Infinity && light.height > 0 && light.height < Infinity))
    throw new RangeError(`${label} width and height must be finite and positive; give the rectangle a real size`);
  if (!(intensity >= 0) || radiance.some((c) => !(c >= 0 && c < Infinity)))
    throw new RangeError(`${label} color and intensity must be finite and 0 or more; lower or fix them`);
  const u = scale(right, light.width),
    v = scale(up, light.height);
  return {
    corner: sub(sub(light.position, scale(u, 0.5)), scale(v, 0.5)),
    u,
    v,
    normal,
    radiance,
    twoSided: !!light.twoSided,
  };
}
