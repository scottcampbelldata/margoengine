// @margoengine/lightmap/probes: irradiance probes baked from the same scene, lights and lightmap as a mesh bake, so moving
// objects (characters) are lit like the baked room. Each probe holds order-3 spherical harmonics of the radiance
// arriving at it (Ramamoorthi and Hanrahan, "An Efficient Representation for Irradiance Environment Maps", SIGGRAPH
// 2001: nine coefficients give irradiance for any normal), projected from the shadowed direct lights, from the baked
// lightmap seen along gather rays (bounce light off the room) and from the ambient sky where rays escape. Probes sit at
// the cell centres of a box, as an irradiance volume (Greger, Shirley, Hubbard and Greenberg, "The Irradiance Volume",
// IEEE CG&A 1998), and are read trilinearly.
import { type BakeLight, bakeVertexColors } from '@margoengine/bvh/bake';
import { MeshBVH } from '@margoengine/bvh/tree';
import { SH3 } from '@margoengine/math/sh';
import { createRandom } from '@margoengine/math/mathutils';
import { checkpoint, inRange } from './checks.js';
import { indicesOf } from './texels.js';
import type { LightmapMesh, LightmapOccluder, MeshLightmap } from './mesh.js';

/** A box of probes, one at the centre of each cell (the layout of `@margoengine/environment/probes`' volume). */
export interface ProbeVolume {
  min: readonly [number, number, number];
  max: readonly [number, number, number];
  /** Probes along x, y and z, 1 to 64 each. */
  counts: readonly [number, number, number];
}

/** The baked room the probes see: the mesh and its lightmap, which light the probes by bouncing off its surfaces. */
export interface ProbeRoom {
  /** The baked mesh (its `uv1` addresses `lightmap`). */
  mesh: LightmapMesh;
  /** The mesh's bake (`bakeMeshLightmap` or `bakeDirectionalLightmap`), read through its `irradiance`. */
  lightmap: Pick<MeshLightmap, 'width' | 'height' | 'irradiance' | 'lightmap'>;
  /** Linear diffuse albedo, RGB 0 to 1: one triple for the whole mesh or one per triangle. Default 0.8 grey. */
  albedo?: ArrayLike<number>;
}

/** Options of {@link bakeLightProbes}. */
export interface LightProbeBakeOptions {
  /** Where the probes go. */
  volume: ProbeVolume;
  /** The baked room: its surfaces reflect their lightmap light onto the probes, and block light. Default none. */
  room?: ProbeRoom;
  /** The same lights as the lightmap bake. Ambient lights shine from every direction where a gather ray escapes. */
  lights?: readonly BakeLight[];
  /** More geometry that blocks light but reflects none. Default none. */
  occluders?: readonly LightmapOccluder[];
  /** Gather rays per probe, 16 to 16,384. Default 256. */
  rays?: number;
  /** Unsigned 32-bit seed of the gather rotation; the same seed gives the same probes. Default 0. */
  seed?: number;
  /** Most rays in all, 1 to 67,108,864. Default 16,777,216. */
  maxRays?: number;
  /** Cancels the bake (checked every 64 probes). */
  signal?: AbortSignal;
  /** Called with probes done and probes in all, every 64 probes. */
  onProgress?: (done: number, total: number) => void;
}

/** What {@link bakeLightProbes} returns. */
export interface LightProbeGrid {
  volume: ProbeVolume;
  /** Probes in all, x fastest then y then z. */
  count: number;
  /** World position of each probe, xyz. */
  positions: Float32Array;
  /**
   * 27 floats per probe: order-3 SH of incident radiance, coefficient-major RGB (`k * 3 + channel`), the layout of
   * `@margoengine/math/sh`'s `SH3` and of the environment package's coefficients.
   */
  coefficients: Float32Array;
  /** Rays traced (gather plus shadow rays), an upper bound. */
  rays: number;
}

const FLOOR = 0.8,
  // A delta light projected into three SH bands peaks at 17/16 of its irradiance after the cosine convolution; Sloan
  // 2008 ("Stupid Spherical Harmonics Tricks", normalization of directional lights) scales it by 16/17.
  DIRECTIONAL = 16 / 17;

/**
 * Bakes a grid of irradiance probes from the scene a lightmap was baked from, so characters and other moving objects
 * match the baked room. At each probe: every direct light, shadowed against the room and `occluders`, as a delta light;
 * `rays` gather directions (a seeded, rotated Fibonacci sphere) that read the room's lightmap where they hit its front
 * faces (radiance = albedo * irradiance / pi) and the ambient lights where they escape. Read the result with
 * {@link probeIrradiance}. Inputs are copied before the first await; the bake yields every 64 probes.
 */
export async function bakeLightProbes(options: LightProbeBakeOptions): Promise<LightProbeGrid> {
  options?.signal?.throwIfAborted();
  const range = (value: number, min: number, max: number, name: string, integer?: boolean) =>
      inRange(value, min, max, 'bakeLightProbes ' + name, integer),
    volume = options?.volume;
  if (!volume || !Array.isArray(volume.min) || !Array.isArray(volume.max) || !Array.isArray(volume.counts))
    throw new TypeError('bakeLightProbes volume needs min, max and counts arrays of three');
  const min = [0, 1, 2].map((a) => range(volume.min[a], -1e7, 1e7, 'volume.min', false)),
    max = [0, 1, 2].map((a) => range(volume.max[a], -1e7, 1e7, 'volume.max', false)),
    counts = [0, 1, 2].map((a) => range(volume.counts[a], 1, 64, 'volume.counts'));
  if (max.some((v, a) => !(v > min[a]))) throw new RangeError('bakeLightProbes volume.max must exceed volume.min');
  const count = counts[0] * counts[1] * counts[2],
    gather = range(options.rays ?? 256, 16, 16384, 'rays'),
    seed = range(options.seed ?? 0, 0, 4294967295, 'seed'),
    maxRays = range(options.maxRays ?? 16777216, 1, 67108864, 'maxRays'),
    lights = structuredClone(options.lights ?? []).filter((l) => l.visible !== false),
    direct = lights.filter((l) => l.type !== 'ambient'),
    rays = count * (gather + direct.length);
  if (rays > maxRays)
    throw new RangeError(`bakeLightProbes needs ${rays} rays, over maxRays; lower rays or the probe counts`);

  // Scene: the room's triangles first (face t is the room's triangle t), then the occluders.
  const room = options.room,
    parts = (options.occluders ?? []).map((o, i) =>
      indicesOf('bakeLightProbes', `occluder ${i}`, o?.positions, o?.indices),
    );
  let roomTriangles = 0,
    uv: Float32Array | undefined,
    albedo: Float32Array | undefined,
    irradiance: Float32Array | undefined,
    filled: Uint8Array | undefined,
    lw = 0,
    lh = 0,
    roomIx: Uint32Array | undefined;
  if (room) {
    const r = indicesOf('bakeLightProbes', 'room', room.mesh?.positions, room.mesh?.indices),
      vertices = r.p.length / 3;
    if (!(room.mesh.uv1 instanceof Float32Array) || room.mesh.uv1.length !== vertices * 2)
      throw new RangeError('bakeLightProbes room uv1 must hold 2 floats per vertex; pass the baked mesh TEXCOORD_1');
    const map = room.lightmap;
    lw = range(map?.width, 1, 2048, 'room lightmap width');
    lh = range(map?.height, 1, 2048, 'room lightmap height');
    if (!(map.irradiance instanceof Float32Array) || map.irradiance.length !== lw * lh * 3)
      throw new RangeError('bakeLightProbes room lightmap irradiance must hold 3 floats per texel');
    if (!(map.lightmap instanceof Uint8Array) || map.lightmap.length !== lw * lh * 4)
      throw new RangeError('bakeLightProbes room lightmap must hold RGBA8 per texel');
    roomTriangles = r.ix.length / 3;
    const a = room.albedo ?? [FLOOR, FLOOR, FLOOR];
    if (a.length !== 3 && a.length !== roomTriangles * 3)
      throw new RangeError('bakeLightProbes room albedo needs 3 values, or 3 per triangle');
    albedo = Float32Array.from(a.length === 3 ? Array.from({ length: roomTriangles * 3 }, (_, i) => a[i % 3]) : a);
    for (const v of albedo) if (!(v >= 0 && v <= 1)) throw new RangeError('bakeLightProbes room albedo must be 0 to 1');
    uv = room.mesh.uv1.slice();
    irradiance = map.irradiance.slice();
    filled = new Uint8Array(lw * lh);
    for (let i = 0; i < lw * lh; i++) filled[i] = map.lightmap[i * 4 + 3] ? 1 : 0;
    roomIx = r.ix;
    parts.unshift(r);
  }
  let sky = [0, 0, 0];
  for (const l of lights)
    if (l.type === 'ambient') {
      // Ambient irradiance E from uniform radiance E / pi; parse the colour the way the baker does, through one vertex.
      const e = bakeVertexColors({ positions: [0, 0, 0], normals: [0, 1, 0] }, emptyBVH(), {
        lights: [l],
        shadows: false,
      });
      sky = sky.map((v, c) => v + e[c] / Math.PI);
    }
  const positions = new Float32Array(count * 3);
  for (let z = 0, i = 0; z < counts[2]; z++)
    for (let y = 0; y < counts[1]; y++)
      for (let x = 0; x < counts[0]; x++, i++)
        [x, y, z].forEach((g, a) => {
          positions[i * 3 + a] = min[a] + ((g + 0.5) * (max[a] - min[a])) / counts[a];
        });
  options.onProgress?.(0, count);
  await checkpoint(options.signal);

  let bvh: MeshBVH | undefined;
  if (parts.length) {
    const vertices = parts.reduce((s, p) => s + p.p.length / 3, 0),
      all = new Float32Array(vertices * 3),
      indices = new Uint32Array(parts.reduce((s, p) => s + p.ix.length, 0));
    let v = 0,
      k = 0;
    for (const p of parts) {
      all.set(p.p, v * 3);
      for (let i = 0; i < p.ix.length; i++) indices[k + i] = p.ix[i] + v;
      v += p.p.length / 3;
      k += p.ix.length;
    }
    bvh = MeshBVH.build({ positions: all, indices });
  }
  const scene = bvh ?? emptyBVH(),
    coefficients = new Float32Array(count * 27),
    sh = new SH3(),
    random = createRandom(seed),
    golden = Math.PI * (3 - Math.sqrt(5)),
    weight = (4 * Math.PI) / gather,
    colour = { r: 0, g: 0, b: 0 },
    ray = { origin: [0, 0, 0], direction: [0, 0, 0] },
    lookup = (t: number, b: ArrayLike<number>) => {
      // Lightmap irradiance at the hit's UV1: bilinear over the filled texels (texel centres at (x + 0.5) / width).
      const ix = roomIx as Uint32Array,
        u =
          (uv as Float32Array)[ix[t * 3] * 2] * b[0] +
          (uv as Float32Array)[ix[t * 3 + 1] * 2] * b[1] +
          (uv as Float32Array)[ix[t * 3 + 2] * 2] * b[2],
        w =
          (uv as Float32Array)[ix[t * 3] * 2 + 1] * b[0] +
          (uv as Float32Array)[ix[t * 3 + 1] * 2 + 1] * b[1] +
          (uv as Float32Array)[ix[t * 3 + 2] * 2 + 1] * b[2],
        fx = u * lw - 0.5,
        fy = w * lh - 0.5,
        x0 = Math.floor(fx),
        y0 = Math.floor(fy),
        out = [0, 0, 0];
      let total = 0;
      for (let dy = 0; dy < 2; dy++)
        for (let dx = 0; dx < 2; dx++) {
          const x = Math.min(lw - 1, Math.max(0, x0 + dx)),
            y = Math.min(lh - 1, Math.max(0, y0 + dy)),
            at = y * lw + x;
          if (!(filled as Uint8Array)[at]) continue;
          const f = (dx ? fx - x0 : 1 - fx + x0) * (dy ? fy - y0 : 1 - fy + y0);
          total += f;
          for (let c = 0; c < 3; c++) out[c] += f * (irradiance as Float32Array)[at * 3 + c];
        }
      return total > 0 ? out.map((v) => v / total) : out;
    };
  for (let start = 0; start < count; start += 64) {
    const length = Math.min(64, count - start),
      points = positions.subarray(start * 3, (start + length) * 3);
    sh.zero();
    const batch = new Float64Array(length * 27);
    // Direct lights: one shadowed sample per light, the normal facing it so the baker returns its full strength.
    for (const light of direct) {
      const normals = new Float32Array(length * 3),
        toward = new Float32Array(length * 3);
      for (let i = 0; i < length; i++) {
        let d: readonly number[];
        if (light.type === 'directional') d = light.direction ?? [0, 1, 0];
        else {
          const p = light.position ?? [0, 0, 0];
          d = [0, 1, 2].map((a) => p[a] - points[i * 3 + a]);
        }
        const l = Math.hypot(d[0], d[1], d[2]) || 1;
        for (let a = 0; a < 3; a++) toward[i * 3 + a] = normals[i * 3 + a] = d[a] / l;
      }
      const e = bakeVertexColors({ positions: points, normals }, scene, {
        lights: [light],
        segmentShadows: true,
        bias: 0,
        seed,
      });
      for (let i = 0; i < length; i++) {
        if (!(e[i * 4] + e[i * 4 + 1] + e[i * 4 + 2] > 0)) continue;
        sh.zero();
        colour.r = e[i * 4] * DIRECTIONAL;
        colour.g = e[i * 4 + 1] * DIRECTIONAL;
        colour.b = e[i * 4 + 2] * DIRECTIONAL;
        sh.addSample({ x: toward[i * 3], y: toward[i * 3 + 1], z: toward[i * 3 + 2] }, colour, 1);
        for (let k = 0; k < 27; k++) batch[i * 27 + k] += sh.coefficients[k];
      }
    }
    // Gather: equal-area Fibonacci directions, turned by a seeded angle per probe.
    for (let i = 0; i < length; i++) {
      sh.zero();
      const turn = random() * 2 * Math.PI;
      for (let a = 0; a < 3; a++) ray.origin[a] = points[i * 3 + a];
      for (let j = 0; j < gather; j++) {
        const y = 1 - ((j + 0.5) * 2) / gather,
          r = Math.sqrt(Math.max(0, 1 - y * y)),
          phi = j * golden + turn;
        ray.direction[0] = r * Math.cos(phi);
        ray.direction[1] = y;
        ray.direction[2] = r * Math.sin(phi);
        const hit = bvh ? bvh.raycastFirst(ray) : null;
        let rgb: readonly number[] = sky;
        if (hit) {
          rgb = [0, 0, 0];
          if (hit.faceIndex < roomTriangles && hit.frontFace) {
            const e = lookup(hit.faceIndex, hit.barycoord),
              t = hit.faceIndex * 3,
              al = albedo as Float32Array;
            rgb = [(al[t] * e[0]) / Math.PI, (al[t + 1] * e[1]) / Math.PI, (al[t + 2] * e[2]) / Math.PI];
          }
        }
        if (!(rgb[0] || rgb[1] || rgb[2])) continue;
        colour.r = rgb[0];
        colour.g = rgb[1];
        colour.b = rgb[2];
        sh.addSample({ x: ray.direction[0], y, z: ray.direction[2] }, colour, weight);
      }
      for (let k = 0; k < 27; k++) batch[i * 27 + k] += sh.coefficients[k];
    }
    coefficients.set(batch, start * 27);
    options.onProgress?.(start + length, count);
    await checkpoint(options.signal);
  }
  for (const v of coefficients)
    if (!Number.isFinite(v)) throw new RangeError('bakeLightProbes lighting overflow; lower light intensity');
  return {
    volume: { min: [min[0], min[1], min[2]], max: [max[0], max[1], max[2]], counts: [counts[0], counts[1], counts[2]] },
    count,
    positions,
    coefficients,
    rays,
  };
}

let empty: MeshBVH | undefined;
/** A scene with one far, tiny triangle: what the baker traces against when nothing blocks light. */
function emptyBVH(): MeshBVH {
  empty ??= MeshBVH.build({ positions: new Float32Array([1e6, 1e6, 1e6, 1e6, 1e6, 1e6 + 1, 1e6 + 1, 1e6, 1e6]) });
  return empty;
}

/**
 * Irradiance at `position` for a surface facing `normal` (world space, need not be unit), from the probes: the SH of
 * the eight probes around it, weighted trilinearly (clamped to the outer probes outside their centres), convolved with
 * the clamped cosine (Ramamoorthi and Hanrahan 2001). Multiply by albedo / pi for the diffuse light reflected, as with
 * a physical lightmap. Each channel is clamped at 0 (three bands can ring below 0). Writes RGB into `out`.
 * @throws RangeError for a non-finite position or a zero or non-finite normal.
 */
export function probeIrradiance(
  grid: Pick<LightProbeGrid, 'volume' | 'coefficients'>,
  position: readonly number[],
  normal: readonly number[],
  out: number[] = [0, 0, 0],
): number[] {
  if (!position || ![0, 1, 2].every((a) => Number.isFinite(position[a])))
    throw new RangeError('probeIrradiance position must be three finite numbers');
  const { min, max, counts } = grid.volume,
    g = [0, 1, 2].map((a) =>
      Math.min(counts[a] - 1, Math.max(0, ((position[a] - min[a]) / (max[a] - min[a])) * counts[a] - 0.5)),
    ),
    i0 = g.map(Math.floor),
    sum = new SH3(),
    one = new SH3();
  for (let c = 0; c < 8; c++) {
    const corner = [0, 1, 2].map((a) => Math.min(i0[a] + ((c >> a) & 1), counts[a] - 1)),
      w = [0, 1, 2].reduce((t, a) => t * ((c >> a) & 1 ? g[a] - i0[a] : 1 - g[a] + i0[a]), 1);
    if (!w) continue;
    one.fromArray(grid.coefficients, (corner[0] + counts[0] * (corner[1] + counts[1] * corner[2])) * 27);
    sum.addScaledSH(one, w);
  }
  const length = normal ? Math.hypot(normal[0], normal[1], normal[2]) : Number.NaN;
  if (!(length > 0) || length === Infinity)
    throw new RangeError('probeIrradiance normal must be finite and not zero; pass a surface normal');
  const e = sum.getIrradianceAt({ x: normal[0], y: normal[1], z: normal[2] }, { r: 0, g: 0, b: 0 });
  out[0] = Math.max(0, e.r);
  out[1] = Math.max(0, e.g);
  out[2] = Math.max(0, e.b);
  return out;
}

export type { LightmapMesh, LightmapOccluder, MeshLightmap } from './mesh.js';
export type { BakeLight } from '@margoengine/bvh/bake';
