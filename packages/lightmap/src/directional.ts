// @margoengine/lightmap/directional: directional lightmaps for triangle meshes at their own UV1, so normal maps still
// respond to baked light. Each texel stores, beside the irradiance at its surface normal, the main light direction (the
// "optimal linear" direction of the lights it sees: their luminance-weighted mean direction, which is the direction of
// the linear SH band; Sloan 2008, "Stupid Spherical Harmonic (SH) Tricks", GDC, section "Extracting Conventional Lights
// from SH") and the colour of a directional light along it. As in that section, the light is split into one directional
// light plus ambient; here the split is fitted exactly at the texel's own normal, so the flat lightmap is unchanged.
import type { BakeLight } from '@margoengine/bvh/bake';
import { type MeshBakeHook, bakeMesh } from './mesh-bake.js';
import type { LightmapMesh, MeshLightmap, MeshLightmapOptions } from './mesh.js';

/** Options of {@link bakeDirectionalLightmap}: every option of `bakeMeshLightmap`. */
export type DirectionalLightmapOptions = MeshLightmapOptions;

/**
 * What {@link bakeDirectionalLightmap} returns: the `bakeMeshLightmap` result plus, per texel, a main light direction
 * and a directional colour. The light on a normal-mapped surface whose interpolated (vertex) normal is `n0` and whose
 * mapped normal is `n` is `irradiance + directional * (max(0, n . direction) - max(0, n0 . direction))`, at least 0
 * ({@link directionalIrradiance}): exact at `n0`, and exact for every `n` when one light (plus ambient) reaches the texel.
 */
export interface DirectionalLightmap extends MeshLightmap {
  /** Unit world-space main light direction (towards the light) per texel, xyz; 0 where no direct light arrives. */
  direction: Float32Array;
  /** How much of the light comes from one direction, 0 (opposite lights or none) to 1 (a single direction), per texel. */
  directionality: Float32Array;
  /** Linear RGB per texel: the irradiance a surface facing `direction` gets from the directional part, HDR. */
  directional: Float32Array;
  /** RGBA8 world direction, `direction * 0.5 + 0.5`, alpha `directionality`; alpha 0 where empty, as `lightmap`. */
  directionMap: Uint8Array;
  /** RGBA8 `directional / directionalScale`; alpha as `lightmap`. */
  directionalMap: Uint8Array;
  /** Multiply the directional map's RGB (0 to 1) by this to get `directional`; at least 1. */
  directionalScale: number;
}

const byte = (v: number) => Math.round(Math.max(0, Math.min(1, v)) * 255),
  // Rec. 709 luminance weights, for the luminance-weighted mean direction.
  luminance = (r: number, g: number, b: number) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

function hook(lights: readonly BakeLight[], pixels: number) {
  const direction = new Float32Array(pixels * 3),
    directionality = new Float32Array(pixels),
    directional = new Float32Array(pixels * 3),
    active = lights.filter((l) => l.visible !== false),
    // Per batch point: the fitted direction, directionality and colour, before the AO scale.
    batch = { d: new Float32Array(768), k: new Float32Array(256), c: new Float32Array(768) };
  const self: MeshBakeHook = {
    planes: [direction, directionality, directional],
    channels: [3, 1, 3],
    direct(points, normals, trace) {
      const n = points.length / 3,
        total = new Float32Array(n * 4),
        // Per light: its irradiance at each point (shadowed, times N.L) and its unit direction there.
        parts = active.map((light) => ({ light, e: trace([light]) }));
      for (const { e } of parts) for (let i = 0; i < total.length; i++) total[i] += e[i];
      if (batch.d.length < n * 3) batch.d = new Float32Array(n * 3);
      if (batch.k.length < n) batch.k = new Float32Array(n);
      if (batch.c.length < n * 3) batch.c = new Float32Array(n * 3);
      const strength: number[][] = [],
        toward: number[][] = [];
      for (let i = 0; i < n; i++) {
        const nx = normals[i * 3],
          ny = normals[i * 3 + 1],
          nz = normals[i * 3 + 2];
        strength.length = toward.length = 0;
        let vx = 0,
          vy = 0,
          vz = 0,
          sum = 0;
        for (const { light, e } of parts) {
          if (light.type === 'ambient') continue;
          let dx: number, dy: number, dz: number;
          if (light.type === 'directional') [dx, dy, dz] = light.direction ?? [0, 1, 0];
          else {
            const p = light.position ?? [0, 0, 0];
            dx = p[0] - points[i * 3];
            dy = p[1] - points[i * 3 + 1];
            dz = p[2] - points[i * 3 + 2];
          }
          const l = Math.hypot(dx, dy, dz);
          if (!(l > 0)) continue;
          dx /= l;
          dy /= l;
          dz /= l;
          const cos = nx * dx + ny * dy + nz * dz;
          // E = s * cos: the light's strength on a surface facing it. Below about 1e-4 the light adds nothing here.
          if (!(cos > 1e-4)) continue;
          const s = [e[i * 4] / cos, e[i * 4 + 1] / cos, e[i * 4 + 2] / cos],
            y = luminance(s[0], s[1], s[2]);
          if (!(y > 0)) continue;
          strength.push(s);
          toward.push([dx, dy, dz]);
          vx += y * dx;
          vy += y * dy;
          vz += y * dz;
          sum += y;
        }
        const length = Math.hypot(vx, vy, vz);
        if (!(length > 1e-12 * sum) || !(sum > 0)) {
          batch.d.fill(0, i * 3, i * 3 + 3);
          batch.k[i] = 0;
          batch.c.fill(0, i * 3, i * 3 + 3);
          continue;
        }
        const d = [vx / length, vy / length, vz / length],
          facing = Math.max(0, nx * d[0] + ny * d[1] + nz * d[2]),
          colour = [0, 0, 0];
        // Each light projected onto the main direction (a light behind it adds nothing).
        strength.forEach((s, j) => {
          const along = Math.max(0, toward[j][0] * d[0] + toward[j][1] * d[1] + toward[j][2] * d[2]);
          for (let a = 0; a < 3; a++) colour[a] += s[a] * along;
        });
        // Exact at the texel's normal: the directional part there may not pass the irradiance there (ambient >= 0).
        for (let a = 0; a < 3; a++)
          if (colour[a] * facing > total[i * 4 + a]) colour[a] = facing > 0 ? total[i * 4 + a] / facing : 0;
        batch.d.set(d, i * 3);
        batch.k[i] = length / sum;
        batch.c.set(colour, i * 3);
      }
      return total;
    },
    texel(i, at, scale) {
      for (let a = 0; a < 3; a++) {
        direction[at * 3 + a] = batch.d[i * 3 + a];
        directional[at * 3 + a] = batch.c[i * 3 + a] * scale;
      }
      directionality[at] = batch.k[i];
    },
  };
  return self;
}

/**
 * Bakes a directional lightmap for a triangle mesh at its own second UV set (`uv1`): the `bakeMeshLightmap` lightmap
 * (the same irradiance, rays and options) plus a main light direction and a directional colour per texel, so a
 * normal-mapped surface still answers baked light ({@link directionalIrradiance}). Every non-ambient light is traced
 * once per texel, as in `bakeMeshLightmap`; the direction is the luminance-weighted mean of the directions of the
 * lights that reach the texel (Sloan 2008's optimal linear direction), and the directional colour is each light's
 * strength projected onto it, fitted so the result is exact at the texel's own normal. Ambient light, AO and lights the
 * surface faces away from stay non-directional.
 */
export async function bakeDirectionalLightmap(
  mesh: LightmapMesh,
  options: DirectionalLightmapOptions = {},
): Promise<DirectionalLightmap> {
  // Lights are cloned by the bake before the first await; the hook reads the same list.
  let planes: MeshBakeHook | undefined;
  const lights = structuredClone(options.lights ?? []) as BakeLight[],
    baked = await bakeMesh('bakeDirectionalLightmap', mesh, options, {
      bytesPerTexel: 28 + 8,
      create(pixels) {
        planes = hook(lights, pixels);
        return planes;
      },
    });
  // planes is set: the bake made its hook before tracing.
  const [direction, directionality, directional] = (planes as MeshBakeHook).planes,
    pixels = baked.width * baked.height,
    directionMap = new Uint8Array(pixels * 4),
    directionalMap = new Uint8Array(pixels * 4);
  let directionalScale = 1;
  for (const v of directional) {
    if (!Number.isFinite(v)) throw new RangeError('bakeDirectionalLightmap lighting overflow; lower light intensity');
    directionalScale = Math.max(directionalScale, v);
  }
  for (let i = 0; i < pixels; i++) {
    // Dilation averages directions: bring them back to unit length (a zero mean stays zero).
    const l = Math.hypot(direction[i * 3], direction[i * 3 + 1], direction[i * 3 + 2]);
    for (let a = 0; a < 3; a++) direction[i * 3 + a] = l > 1e-6 ? direction[i * 3 + a] / l : 0;
    if (!baked.lightmap[i * 4 + 3]) continue;
    for (let a = 0; a < 3; a++) {
      directionMap[i * 4 + a] = byte(direction[i * 3 + a] * 0.5 + 0.5);
      directionalMap[i * 4 + a] = byte(directional[i * 3 + a] / directionalScale);
    }
    directionMap[i * 4 + 3] = byte(directionality[i]);
    directionalMap[i * 4 + 3] = 255;
  }
  return { ...baked, direction, directionality, directional, directionMap, directionalMap, directionalScale };
}

/**
 * The baked light at texel `index` of `baked` on a surface whose unmapped (interpolated vertex) normal is `normal0` and
 * whose normal-mapped normal is `normal`, both world space: `irradiance + directional * (max(0, n . d) - max(0, n0 .
 * d))`, each channel at least 0. Exact at `normal0`; exact for every normal when one light plus ambient reaches the
 * texel. Writes RGB into `out` (default a new array). Normals need not be unit length.
 * @throws RangeError for an index outside the lightmap or a zero or non-finite normal.
 */
export function directionalIrradiance(
  baked: Pick<DirectionalLightmap, 'irradiance' | 'direction' | 'directional' | 'width' | 'height'>,
  index: number,
  normal: readonly number[],
  normal0: readonly number[],
  out: number[] = [0, 0, 0],
): number[] {
  if (!Number.isSafeInteger(index) || index < 0 || index >= baked.width * baked.height)
    throw new RangeError(
      `directionalIrradiance index ${index} is outside the ${baked.width} x ${baked.height} lightmap; pass an index below width * height`,
    );
  const unit = (v: readonly number[], name: string) => {
      const l = Math.hypot(v[0], v[1], v[2]);
      if (!(l > 0) || l === Infinity)
        throw new RangeError(`directionalIrradiance ${name} must be finite and not zero; pass a surface normal`);
      return [v[0] / l, v[1] / l, v[2] / l];
    },
    n = unit(normal, 'normal'),
    n0 = unit(normal0, 'normal0'),
    d = [0, 1, 2].map((a) => baked.direction[index * 3 + a]),
    change =
      Math.max(0, n[0] * d[0] + n[1] * d[1] + n[2] * d[2]) - Math.max(0, n0[0] * d[0] + n0[1] * d[1] + n0[2] * d[2]);
  for (let a = 0; a < 3; a++)
    out[a] = Math.max(0, baked.irradiance[index * 3 + a] + baked.directional[index * 3 + a] * change);
  return out;
}

export type { LightmapMesh, LightmapOccluder, MeshLightmap, MeshLightmapOptions } from './mesh.js';
export type { BakeLight } from '@margoengine/bvh/bake';
