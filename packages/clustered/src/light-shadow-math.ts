import type { Vec3 } from '@margoengine/core/extension';
import { invertMatrix } from '@margoengine/math/mat4';
import { finiteVector } from '@margoengine/math/validate';
import { shadowCamera } from './local-shadow-math.js';
/** Shadowed lights per `DirectionalLights.setLights` call; each takes one to four layers of LocalShadows' map array. */
export const MAX_DIRECTIONAL_SHADOWS = 4;
/** Shadowed lights per `AreaLights.setLights` call; each takes five cube-face layers (six when two-sided). */
export const MAX_AREA_SHADOWS = 4;
/**
 * Half-angle tangent of an area light's cube faces: each face covers 45 degrees plus a guard band of 0.1 UV per side,
 * so a penumbra filter of up to that radius reads the face's own map near its edge.
 */
export const AREA_FACE_TAN = 1.25;
/** Default far distance of an area light's shadow maps, world units. */
export const AREA_SHADOW_FAR = 100;
/** A castShadow directional light as LocalShadows reads it (`DirectionalLights.shadowLights`). */
export interface DirectionalShadowLight {
  /** Position in the `DirectionalLights` list. */
  readonly index: number;
  /** Unit vector the light travels along. */
  readonly direction: readonly [number, number, number];
  /** The fixed world box of a one-map light; absent for camera-fitted cascades. */
  readonly bounds?: { readonly min: Vec3; readonly max: Vec3 };
  /** Camera-fitted cascades, 1-4. */
  readonly cascades: number;
  /** View distance the cascades cover, and how far toward the light they take casters from. */
  readonly distance: number;
  /** Map width and height in texels, 0 for LocalShadows' resolution. */
  readonly width: number;
  readonly height: number;
}
/** A castShadow area light as LocalShadows reads it (`AreaLights.shadowLights`). */
export interface AreaShadowLight {
  /** Position in the `AreaLights` list. */
  readonly index: number;
  readonly center: Vec3;
  /** Unit normal (the side the light faces), right and up axes. */
  readonly normal: readonly [number, number, number];
  readonly right: readonly [number, number, number];
  readonly up: readonly [number, number, number];
  readonly twoSided: boolean;
  /** Map width and height in texels per cube face, 0 for LocalShadows' resolution. */
  readonly width: number;
  readonly height: number;
  readonly near: number;
  readonly far: number;
}
/** A box in a directional light's space: centre and half extents across the light, depth range along it. */
export interface LightBox {
  cx: number;
  cy: number;
  hx: number;
  hy: number;
  /** Near (toward the light) and far depth along the light's direction. */
  z0: number;
  z1: number;
}
/** Validated settings of a directional light's `shadow` (defaults: three cascades over 100 units). */
export function directionalShadowSettings(shadow: unknown): Omit<DirectionalShadowLight, 'index' | 'direction'> {
  if (shadow !== undefined && (!shadow || typeof shadow !== 'object' || Array.isArray(shadow)))
    throw new TypeError('Directional light shadow must be an object of bounds, cascades, distance and resolution');
  const settings = (shadow ?? {}) as {
      bounds?: { min: Vec3; max: Vec3 };
      cascades?: number;
      distance?: number;
      resolution?: number | readonly [number, number];
    },
    { bounds, cascades = 3, distance = 100 } = settings;
  if (bounds !== undefined) {
    if (!bounds || typeof bounds !== 'object')
      throw new TypeError('Directional shadow bounds must be {min, max}, world-space Vec3s');
    finiteVector(bounds.min, 3, 'Directional shadow bounds min');
    finiteVector(bounds.max, 3, 'Directional shadow bounds max');
    if (bounds.min.some((v, axis) => !(v < bounds.max[axis])))
      throw new RangeError('Directional shadow bounds need min below max on every axis');
  }
  if (!Number.isInteger(cascades) || cascades < 1 || cascades > 4)
    throw new RangeError('Directional shadow cascades must be an integer from 1 to 4');
  if (typeof distance !== 'number' || !(Number.isFinite(Math.fround(distance)) && distance > 0))
    throw new RangeError('Directional shadow distance must be a finite number above 0 (world units)');
  const [width, height] = shadowCamera({ resolution: settings.resolution }, 1);
  return {
    ...(bounds ? { bounds: { min: [...bounds.min] as Vec3, max: [...bounds.max] as Vec3 } } : {}),
    cascades,
    distance,
    width,
    height,
  };
}
/** Validated settings of an area light's `shadow`: map size (0 = LocalShadows' resolution), near and far. */
export function areaShadowSettings(shadow: unknown): { width: number; height: number; near: number; far: number } {
  if (shadow !== undefined && (!shadow || typeof shadow !== 'object' || Array.isArray(shadow)))
    throw new TypeError('Area light shadow must be an object of resolution, near and far');
  const settings = (shadow ?? {}) as { resolution?: number | readonly [number, number]; near?: number; far?: number };
  if (
    (settings.near !== undefined && typeof settings.near !== 'number') ||
    (settings.far !== undefined && typeof settings.far !== 'number')
  )
    throw new TypeError('Area light shadow near and far must be numbers');
  const far = Math.fround(settings.far ?? AREA_SHADOW_FAR),
    near = Math.fround(settings.near ?? far * 1e-3);
  if (!(Number.isFinite(far) && near > 0 && near < far))
    throw new RangeError(
      `Invalid area light shadow near/far: give 0 < near < far, finite (far defaults to ${AREA_SHADOW_FAR})`,
    );
  const [width, height] = shadowCamera({ resolution: settings.resolution }, 1);
  return { width, height, near, far };
}
/** Unit axes across a directional light travelling along unit `f` (they depend on `f` alone, so maps stay put). */
export function lightBasis(f: ArrayLike<number>): [number[], number[]] {
  const hint = Math.abs(f[1]) > 0.99 ? [0, 0, 1] : [0, 1, 0];
  let x = [hint[1] * f[2] - hint[2] * f[1], hint[2] * f[0] - hint[0] * f[2], hint[0] * f[1] - hint[1] * f[0]];
  const length = Math.hypot(x[0], x[1], x[2]);
  x = x.map((v) => v / length);
  return [x, [f[1] * x[2] - f[2] * x[1], f[2] * x[0] - f[0] * x[2], f[0] * x[1] - f[1] * x[0]]];
}
const dot = (a: ArrayLike<number>, b: ArrayLike<number>) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
/**
 * Reversed-depth orthographic view-projection (column-major, into `out` at `o`) of a directional light travelling
 * along unit `f` with axes `x` and `y`: the box's near depth `z0` maps to 1 and `z1` to 0, `hx` and `hy` to NDC 1.
 */
export function orthographicShadow(
  out: Float32Array,
  o: number,
  f: ArrayLike<number>,
  x: ArrayLike<number>,
  y: ArrayLike<number>,
  box: LightBox,
  hx = box.hx,
  hy = box.hy,
): void {
  const depth = box.z1 - box.z0;
  for (let c = 0; c < 3; c++) {
    out[o + c * 4] = x[c] / hx;
    out[o + c * 4 + 1] = y[c] / hy;
    out[o + c * 4 + 2] = -f[c] / depth;
    out[o + c * 4 + 3] = 0;
  }
  out[o + 12] = -box.cx / hx;
  out[o + 13] = -box.cy / hy;
  out[o + 14] = box.z1 / depth;
  out[o + 15] = 1;
  for (let i = o; i < o + 16; i++)
    if (!Number.isFinite(out[i])) throw new RangeError('Directional shadow matrix overflow; use a smaller box');
}
/** The light-space box around a world box's eight corners. */
export function boundsBox(
  f: ArrayLike<number>,
  x: ArrayLike<number>,
  y: ArrayLike<number>,
  min: ArrayLike<number>,
  max: ArrayLike<number>,
): LightBox {
  const lo = [Infinity, Infinity, Infinity],
    hi = [-Infinity, -Infinity, -Infinity];
  for (let k = 0; k < 8; k++) {
    const p = [k & 1 ? max[0] : min[0], k & 2 ? max[1] : min[1], k & 4 ? max[2] : min[2]],
      v = [dot(x, p), dot(y, p), dot(f, p)];
    for (let a = 0; a < 3; a++) {
      lo[a] = Math.min(lo[a], v[a]);
      hi[a] = Math.max(hi[a], v[a]);
    }
  }
  return {
    cx: (lo[0] + hi[0]) / 2,
    cy: (lo[1] + hi[1]) / 2,
    hx: (hi[0] - lo[0]) / 2,
    hy: (hi[1] - lo[1]) / 2,
    z0: lo[2],
    z1: hi[2],
  };
}
/**
 * World bounding spheres of `count` consecutive slices of a camera's view from its near plane to view depth
 * `distance` (or its far plane if nearer), split half logarithmically and half uniformly. The slice corners come from
 * the inverse view-projection (reversed depth), so any projection works: perspective, orthographic, off-centre.
 */
export function viewSlices(
  matrix: ArrayLike<number>,
  eye: ArrayLike<number>,
  target: ArrayLike<number>,
  distance: number,
  count: number,
): { center: number[]; radius: number }[] {
  const inverse = invertMatrix(matrix, new Float64Array(16));
  if (!inverse) throw new RangeError('Directional shadow cascades need an invertible camera matrix; check the camera');
  const unproject = (x: number, y: number, z: number) => {
      const p = [0, 1, 2, 3].map((r) => inverse[r] * x + inverse[4 + r] * y + inverse[8 + r] * z + inverse[12 + r]);
      return [p[0] / p[3], p[1] / p[3], p[2] / p[3]];
    },
    forward = [target[0] - eye[0], target[1] - eye[1], target[2] - eye[2]],
    length = Math.hypot(forward[0], forward[1], forward[2]),
    depth = (p: number[]) =>
      ((p[0] - eye[0]) * forward[0] + (p[1] - eye[1]) * forward[1] + (p[2] - eye[2]) * forward[2]) / length;
  if (!length) throw new RangeError('Directional shadow cascades need a camera whose target differs from its position');
  // Each corner ray through the near plane (NDC z 1) and a second point (z 0.5), parameterised by view depth.
  const rays = [
      [-1, -1],
      [1, -1],
      [1, 1],
      [-1, 1],
    ].map(([x, y]) => {
      const a = unproject(x, y, 1),
        b = unproject(x, y, 0.5);
      return { a, b, da: depth(a), db: depth(b) };
    }),
    near = rays[0].da,
    farCorner = depth(unproject(-1, -1, 0)),
    far = Number.isFinite(farCorner) && farCorner > near ? farCorner : Infinity,
    end = Math.max(Math.min(distance, far), near + 1e-4 * Math.max(1, Math.abs(near))),
    split = (i: number) => {
      const t = i / count,
        uniform = near + (end - near) * t;
      return near > 0 ? 0.5 * near * (end / near) ** t + 0.5 * uniform : uniform;
    };
  if (rays.some((r) => ![...r.a, ...r.b, r.db - r.da].every(Number.isFinite) || r.db === r.da))
    throw new RangeError('Directional shadow cascades need a camera with a finite near plane; check the projection');
  const slices: { center: number[]; radius: number }[] = [];
  for (let i = 0; i < count; i++) {
    const points: number[][] = [];
    for (const s of [i ? split(i) : near, i + 1 === count ? end : split(i + 1)])
      for (const r of rays) {
        const t = (s - r.da) / (r.db - r.da);
        points.push([0, 1, 2].map((k) => r.a[k] + (r.b[k] - r.a[k]) * t));
      }
    const center = [0, 1, 2].map((k) => points.reduce((sum, p) => sum + p[k], 0) / 8),
      radius = Math.max(...points.map((p) => Math.hypot(p[0] - center[0], p[1] - center[1], p[2] - center[2])));
    slices.push({ center, radius });
  }
  return slices;
}
/**
 * Light-space boxes of a camera's cascades for a map of `width` x `height` texels: each slice's sphere, its radius
 * rounded up to 1/16 unit and widened so a centre snapped to whole texels still holds it (stable under camera motion
 * and rotation). The near depth reaches `distance` past the sphere toward the light, for casters outside the view.
 */
export function cascadeBoxes(
  camera: { matrix: ArrayLike<number>; position: ArrayLike<number>; target: ArrayLike<number> },
  f: ArrayLike<number>,
  x: ArrayLike<number>,
  y: ArrayLike<number>,
  count: number,
  distance: number,
  width: number,
  height: number,
): LightBox[] {
  return viewSlices(camera.matrix, camera.position, camera.target, distance, count).map(({ center, radius }) => {
    const r = Math.ceil(radius * 16) / 16,
      hx = r * (1 + 2 / (width - 4)),
      hy = r * (1 + 2 / (height - 4)),
      tx = (2 * hx) / (width - 4),
      ty = (2 * hy) / (height - 4),
      cz = dot(f, center);
    return {
      cx: Math.round(dot(x, center) / tx) * tx,
      cy: Math.round(dot(y, center) / ty) * ty,
      hx,
      hy,
      z0: cz - r - distance,
      z1: cz + r,
    };
  });
}
