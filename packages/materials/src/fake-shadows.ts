// Cheap ground shadows without a shadow map: a flattened copy of a mesh (the planar projection every engine's ShadowMesh
// uses, Blinn, "Me and My (Fake) Shadow", IEEE CG&A 8(1), 1988) and a soft blob disc (contact blobs, drei's
// ContactShadows' simplest form). Both are ordinary Material meshes. Clean room from the 1988 paper and the plane and
// homogeneous-light maths in any graphics text; no engine source was read.
import type { EngineKernel } from '@margoengine/core';
import type { ColorInput } from '@margoengine/math/color';
import { Material, createMesh, type MaterialMesh, type MeshGeometry } from './built-material.js';

type Vec3 = readonly [number, number, number];
/** The plane the shadow falls on: the points p with `dot(normal, p) = offset`. `normal` need not be unit length. */
export interface ShadowPlane {
  normal: Vec3;
  /** Default 0. */
  offset?: number;
}
/** A directional light (`direction` points from the scene toward the light) or a point light at `position`. */
export type ShadowLight = { direction: Vec3 } | { position: Vec3 };

const error = (message: string): never => {
  throw new TypeError(message);
};
const vec3 = (v: unknown, name: string): Vec3 => {
  if (!Array.isArray(v) || v.length !== 3 || v.some((x) => !Number.isFinite(x)))
    return error(`Planar shadow ${name} must be three finite numbers; pass [x, y, z]`);
  return v as unknown as Vec3;
};
/** The plane as a unit normal and an offset, and the light as a homogeneous vector (w 0 for a direction). */
function parse(plane: ShadowPlane, light: ShadowLight): { n: Vec3; d: number; l: readonly number[] } {
  const n = vec3(plane?.normal, 'plane normal'),
    length = Math.hypot(n[0], n[1], n[2]);
  if (!(length > 0)) error("Planar shadow plane normal must not be zero; pass the plane's up direction");
  const offset = plane.offset ?? 0;
  if (!Number.isFinite(offset)) error('Planar shadow plane offset must be a finite number');
  const unit: Vec3 = [n[0] / length, n[1] / length, n[2] / length];
  const hasDirection = light && 'direction' in light,
    hasPosition = light && 'position' in light;
  if (hasDirection === hasPosition) return error('Planar shadow light needs exactly one of direction or position');
  const l = hasDirection
    ? [...vec3((light as { direction: Vec3 }).direction, 'light direction'), 0]
    : [...vec3((light as { position: Vec3 }).position, 'light position'), 1];
  const dot = unit[0] * l[0] + unit[1] * l[1] + unit[2] * l[2] - (offset / length) * l[3];
  if (Math.abs(dot) < 1e-9)
    error('Planar shadow light lies in the plane; move it off the plane or the shadow runs to infinity');
  return { n: unit, d: offset / length, l };
}

/**
 * The 4x4 matrix (column-major, 16 numbers) that flattens points onto `plane` along rays from `light`: apply it to a
 * homogeneous point and divide by w. For a directional light every ray is parallel; for a point light they meet at its
 * position, and only points between the light and the plane project to the lit side.
 * @example
 * const m = planarShadowMatrix({ normal: [0, 1, 0] }, { direction: [2, 5, 1] });
 */
export function planarShadowMatrix(plane: ShadowPlane, light: ShadowLight): Float32Array {
  const { n, d, l } = parse(plane, light),
    p = [n[0], n[1], n[2], -d],
    dot = p[0] * l[0] + p[1] * l[1] + p[2] * l[2] + p[3] * l[3],
    out = new Float32Array(16);
  for (let col = 0; col < 4; col++)
    for (let row = 0; row < 4; row++) out[col * 4 + row] = (row === col ? dot : 0) - l[row] * p[col];
  return out;
}

/**
 * `source` flattened onto `plane` as seen from `light`, after `world` (16 numbers, column-major; identity when left out)
 * places it: a new geometry with the same vertices and indices, normals along the plane's normal, lifted `lift` (default
 * 0.002) off the plane against depth fighting. A vertex level with or past a point light projects mirrored or not
 * at all, so keep the caster between the light and the plane.
 */
export function projectGeometry(
  source: MeshGeometry,
  plane: ShadowPlane,
  light: ShadowLight,
  { world, lift = 0.002 }: { world?: ArrayLike<number>; lift?: number } = {},
): MeshGeometry {
  if (!source?.positions || source.positions.length % 3) error('Planar shadow needs a geometry with xyz positions');
  if (world && world.length !== 16) error('Planar shadow world must be a 16-number column-major matrix');
  if (!Number.isFinite(lift)) error('Planar shadow lift must be a finite number');
  const m = planarShadowMatrix(plane, light),
    { n } = parse(plane, light),
    w = world ?? [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
    count = source.positions.length / 3,
    positions = new Float32Array(count * 3),
    normals = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    const x = source.positions[i * 3],
      y = source.positions[i * 3 + 1],
      z = source.positions[i * 3 + 2],
      wx = w[0] * x + w[4] * y + w[8] * z + w[12],
      wy = w[1] * x + w[5] * y + w[9] * z + w[13],
      wz = w[2] * x + w[6] * y + w[10] * z + w[14];
    let px = m[0] * wx + m[4] * wy + m[8] * wz + m[12],
      py = m[1] * wx + m[5] * wy + m[9] * wz + m[13],
      pz = m[2] * wx + m[6] * wy + m[10] * wz + m[14];
    const pw = m[3] * wx + m[7] * wy + m[11] * wz + m[15];
    // Constant for a directional light. For a point light it shrinks to 0 at the light's own height, where the
    // projection runs off to infinity; a point past that height lands mirrored, so keep casters under the light.
    if (Math.abs(pw) > 1e-9) {
      px /= pw;
      py /= pw;
      pz /= pw;
    }
    positions.set([px + n[0] * lift, py + n[1] * lift, pz + n[2] * lift], i * 3);
    normals.set(n, i * 3);
  }
  return { positions, normals, ...(source.indices ? { indices: source.indices } : {}) };
}

/** Options of `createPlanarShadow`. */
export interface PlanarShadowOptions {
  plane: ShadowPlane;
  light: ShadowLight;
  /** Shadow colour (default black). */
  color?: ColorInput;
  /** 0 to 1 (default 0.5). Overlapping parts of one caster darken twice; keep the shadow of a convex caster in mind. */
  opacity?: number;
  /** Lift off the plane (default 0.002). */
  lift?: number;
}
/** A flattened copy of a mesh's geometry on a plane; call `update` when the caster or the light moves. */
export interface PlanarShadow {
  readonly mesh: MaterialMesh;
  /** Re-projects with the caster's `world` matrix (16 numbers, column-major) and, optionally, a new light. */
  update(world?: ArrayLike<number>, light?: ShadowLight): void;
  dispose(): void;
}
/**
 * A planar `ShadowMesh`: `source`'s geometry flattened onto `options.plane` as seen from `options.light`, drawn as a
 * translucent flat colour that does not write depth. The projection runs on the CPU in `update`, so it suits
 * characters and props (thousands of vertices), not whole levels.
 * @example
 * const shadow = createPlanarShadow(engine, geometry, { plane: { normal: [0, 1, 0] }, light: { direction: [2, 5, 1] } });
 * shadow.update(casterWorldMatrix); // each frame the caster moves
 */
export function createPlanarShadow(
  engine: EngineKernel,
  source: MeshGeometry,
  options: PlanarShadowOptions,
): PlanarShadow {
  const { plane, light, color = '#000000', opacity = 0.5, lift } = options ?? ({} as PlanarShadowOptions);
  const mesh = createMesh(
    engine,
    projectGeometry(source, plane, light, { lift }),
    new Material({ shading: 'basic', color, opacity, transparent: true, depthWrite: false }),
  );
  let current = light;
  return {
    mesh,
    update(world, next) {
      current = next ?? current;
      mesh.setGeometry(projectGeometry(source, plane, current, { world, lift }));
    },
    dispose: () => mesh.destroy(),
  };
}

/** Options of `createBlobShadow`. */
export interface BlobShadowOptions {
  /** Radius in world units (default 1). */
  radius?: number;
  /** Centre opacity, 0 to 1 (default 0.5); it falls off smoothly to 0 at the rim. */
  opacity?: number;
  /** Default black. */
  color?: ColorInput;
  /** Segments around the rim (default 32, 3 to 256). */
  segments?: number;
}
/**
 * A soft round blob shadow: a flat disc in the XZ plane facing up, opaque in the middle and clear at the rim (smoothstep
 * falloff through vertex alpha), drawn translucent without writing depth. Move it with `blob.root.setPosition`, a little
 * above the ground under the caster, and scale it with `root.setScale` as the caster rises.
 * @example
 * const blob = createBlobShadow(engine, { radius: 0.6 });
 * blob.root.setPosition([x, groundY + 0.01, z]);
 */
export function createBlobShadow(engine: EngineKernel, options: BlobShadowOptions = {}): MaterialMesh {
  const { radius = 1, opacity = 0.5, color = '#000000', segments = 32 } = options;
  if (!(radius > 0) || !Number.isFinite(radius)) error('Blob shadow radius must be a positive finite number');
  if (!Number.isFinite(opacity) || opacity < 0 || opacity > 1) error('Blob shadow opacity must be between 0 and 1');
  if (!Number.isInteger(segments) || segments < 3 || segments > 256)
    error('Blob shadow segments must be an integer from 3 to 256');
  const rings = 6,
    vertices = 1 + rings * segments,
    positions = new Float32Array(vertices * 3),
    normals = new Float32Array(vertices * 3),
    colors = new Float32Array(vertices * 4);
  colors.set([1, 1, 1, 1], 0);
  normals.set([0, 1, 0], 0);
  for (let r = 1; r <= rings; r++) {
    const t = r / rings,
      alpha = 1 - t * t * (3 - 2 * t);
    for (let s = 0; s < segments; s++) {
      const a = (s / segments) * Math.PI * 2,
        i = 1 + (r - 1) * segments + s;
      positions.set([Math.cos(a) * radius * t, 0, Math.sin(a) * radius * t], i * 3);
      normals.set([0, 1, 0], i * 3);
      colors.set([1, 1, 1, alpha], i * 4);
    }
  }
  const indices: number[] = [];
  for (let s = 0; s < segments; s++) indices.push(0, 1 + ((s + 1) % segments), 1 + s);
  for (let r = 1; r < rings; r++)
    for (let s = 0; s < segments; s++) {
      const a = 1 + (r - 1) * segments + s,
        b = 1 + (r - 1) * segments + ((s + 1) % segments),
        c = a + segments,
        d = b + segments;
      indices.push(a, b, c, b, d, c);
    }
  return createMesh(
    engine,
    { positions, normals, colors, indices: new Uint32Array(indices) },
    new Material({ shading: 'basic', color, opacity, transparent: true, depthWrite: false }),
  );
}
