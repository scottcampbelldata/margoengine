// The triangle-mesh lightmap bake shared by @margoengine/lightmap/mesh and the entries built on it (./directional):
// conservative UV-space rasterization (Hasselgren, Akenine-Moller and Ohlsson, "Conservative Rasterization", GPU Gems 2,
// ch. 42, 2005; the rasterizer and dilation live in texels.ts, shared with ./gpu), shadowed direct light and AO through
// @margoengine/bvh, then dilation. Internal: not an entry.
import { type BakeLight, bakeVertexColors } from '@margoengine/bvh/bake';
import { MeshBVH } from '@margoengine/bvh/tree';
import { checkpoint, inRange } from './checks.js';
import type { LightmapMesh, MeshLightmap, MeshLightmapOptions } from './mesh.js';
import { dilate, indicesOf, rasterize } from './texels.js';

const byte = (v: number) => Math.round(Math.max(0, Math.min(1, v)) * 255);

/** Extra per-texel work riding on {@link bakeMesh}: another entry's own planes, traced with the same rays. */
export interface MeshBakeHook {
  /** Direct light of one batch, RGBA per point as bakeVertexColors returns; `trace` bakes a light list at the points. */
  direct(
    points: Float32Array,
    normals: Float32Array,
    trace: (lights: readonly BakeLight[]) => Float32Array,
  ): Float32Array;
  /** Batch point `i` is texel `at`; `scale` is the factor its irradiance got (its AO, or 1 with physical radiometry). */
  texel(i: number, at: number, scale: number): void;
  /** Float planes dilated with the irradiance, and their channels. */
  planes: Float32Array[];
  channels: number[];
}

/** {@link bakeMesh}'s extension: bytes it adds per texel (for the budget) and its hook, made once the size is known. */
export interface MeshBakeExtra {
  bytesPerTexel: number;
  create(pixels: number): MeshBakeHook;
}

/**
 * The triangle-mesh bake behind `bakeMeshLightmap` and the entries built on it; `fn` names the caller in errors.
 */
export async function bakeMesh(
  fn: string,
  mesh: LightmapMesh,
  options: MeshLightmapOptions = {},
  extra?: MeshBakeExtra,
): Promise<MeshLightmap> {
  options.signal?.throwIfAborted();
  if (options.radiometry !== undefined && options.radiometry !== 'legacy' && options.radiometry !== 'physical')
    throw new TypeError(`${fn} radiometry must be 'legacy' or 'physical'`);
  const range = (value: number, min: number, max: number, name: string, integer?: boolean) =>
      inRange(value, min, max, `${fn} ` + name, integer),
    physical = options.radiometry === 'physical',
    w = range(options.width ?? 256, 1, 2048, 'width'),
    h = range(options.height ?? w, 1, 2048, 'height'),
    passes = range(options.dilate ?? 2, 0, 16, 'dilate'),
    aoRays = range(options.aoRays ?? 32, 1, 128, 'aoRays'),
    aoDistance = range(options.aoDistance ?? 4, 0.001, 1e6, 'aoDistance', false),
    bias = range(options.bias ?? 1e-3, 0, 1, 'bias', false),
    seed = range(options.seed ?? 0, 0, 4294967295, 'seed'),
    maxSamples = range(options.maxSamples ?? 1048576, 1, 4194304, 'maxSamples'),
    maxRays = range(options.maxRays ?? 16777216, 1, 67108864, 'maxRays'),
    maxBytes = range(options.maxBytes ?? 201326592, 1, 268435456, 'maxBytes'),
    { p: positions, ix } = indicesOf(fn, 'mesh', mesh?.positions, mesh?.indices),
    vertices = positions.length / 3;
  if (!(mesh.uv1 instanceof Float32Array) || mesh.uv1.length !== vertices * 2)
    throw new RangeError(`${fn} uv1 must hold 2 floats per vertex; pass the mesh TEXCOORD_1`);
  const uv = mesh.uv1.slice();
  for (const v of uv)
    if (!(v >= 0 && v <= 1)) throw new RangeError(`${fn} uv1 values must be 0 to 1; repack the lightmap UVs`);
  let normals: Float32Array | undefined;
  if (mesh.normals !== undefined) {
    if (!(mesh.normals instanceof Float32Array) || mesh.normals.length !== vertices * 3)
      throw new RangeError(`${fn} normals must hold 3 floats per vertex`);
    for (const v of mesh.normals) if (!Number.isFinite(v)) throw new RangeError(`${fn} normals must be finite`);
    normals = mesh.normals.slice();
  }
  const others = (options.occluders ?? []).map((o, i) => indicesOf(fn, `occluder ${i}`, o?.positions, o?.indices)),
    lights = structuredClone(options.lights ?? []),
    triangles = ix.length / 3;
  let occluderTriangles = triangles,
    occluderVertices = vertices;
  for (const o of others) {
    occluderTriangles += o.ix.length / 3;
    occluderVertices += o.p.length / 3;
  }
  // Coverage and float planes per pixel, the BVH and its inputs, before anything is allocated.
  const pixels = w * h,
    preBytes = pixels * (45 + (extra?.bytesPerTexel ?? 0)) + occluderTriangles * 160 + occluderVertices * 12 + 262144;
  if (preBytes > maxBytes) throw new RangeError(`${fn} needs about ${preBytes} bytes, over maxBytes; bake less`);
  const coverage = rasterize(uv, ix, w, h),
    covered: number[] = [];
  for (let i = 0; i < pixels; i++) if (coverage.tri[i] >= 0) covered.push(i);
  const samples = covered.length;
  if (samples > maxSamples)
    throw new RangeError(`${fn} covers ${samples} texels, over maxSamples; lower the size or raise it`);
  const rays = samples * (aoRays + lights.filter((l) => l.type !== 'ambient' && l.visible !== false).length);
  if (rays > maxRays) throw new RangeError(`${fn} needs ${rays} rays, over maxRays; lower aoRays or the lightmap size`);
  options.onProgress?.(0, samples);
  await checkpoint(options.signal);

  // One BVH over the mesh then each occluder, so face t is the mesh's triangle t.
  const all = new Float32Array(occluderVertices * 3),
    allIndices = new Uint32Array(occluderTriangles * 3);
  all.set(positions);
  allIndices.set(ix);
  let vertexAt = vertices,
    indexAt = ix.length;
  for (const o of others) {
    all.set(o.p, vertexAt * 3);
    for (let i = 0; i < o.ix.length; i++) allIndices[indexAt + i] = o.ix[i] + vertexAt;
    vertexAt += o.p.length / 3;
    indexAt += o.ix.length;
  }
  const bvh = MeshBVH.build({ positions: all, indices: allIndices }),
    hook = extra?.create(pixels),
    irradiance = new Float32Array(pixels * 3),
    occlusion = new Float32Array(pixels),
    corner = (t: number, k: number, a: number, of: Float32Array) => of[ix[t * 3 + k] * 3 + a];
  let done = 0;
  for (let start = 0; start < samples; start += 256) {
    const length = Math.min(256, samples - start),
      points = new Float32Array(length * 3),
      shading = new Float32Array(length * 3),
      owner = new Int32Array(length);
    for (let i = 0; i < length; i++) {
      const at = covered[start + i],
        t = coverage.tri[at],
        b1 = coverage.bary[at * 2],
        b2 = coverage.bary[at * 2 + 1],
        b0 = 1 - b1 - b2,
        e1 = [0, 1, 2].map((a) => corner(t, 1, a, positions) - corner(t, 0, a, positions)),
        e2 = [0, 1, 2].map((a) => corner(t, 2, a, positions) - corner(t, 0, a, positions));
      let n = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
      if (normals) {
        const smooth = [0, 1, 2].map(
          (a) => b0 * corner(t, 0, a, normals) + b1 * corner(t, 1, a, normals) + b2 * corner(t, 2, a, normals),
        );
        if (Math.hypot(...smooth) > 1e-10) n = smooth;
      }
      const l = Math.hypot(...n) || 1;
      owner[i] = t;
      for (let a = 0; a < 3; a++) {
        points[i * 3 + a] =
          b0 * corner(t, 0, a, positions) + b1 * corner(t, 1, a, positions) + b2 * corner(t, 2, a, positions);
        shading[i * 3 + a] = n[a] / l;
      }
    }
    const batchSeed = (seed + done) >>> 0,
      trace = (list: readonly BakeLight[]) =>
        bakeVertexColors({ positions: points, normals: shading }, bvh, {
          lights: list,
          segmentShadows: true,
          shadowFaceFilter: (face, i) => face !== owner[i],
          bias,
          seed: batchSeed,
        }),
      direct = hook ? hook.direct(points, shading, trace) : trace(lights),
      open = bakeVertexColors({ positions: points, normals: shading }, bvh, {
        ao: { strength: 1, rays: aoRays, distance: aoDistance },
        bias,
        seed: batchSeed,
      });
    for (let i = 0; i < length; i++) {
      const at = covered[start + i],
        o = open[i * 4];
      occlusion[at] = o;
      for (let a = 0; a < 3; a++) irradiance[at * 3 + a] = direct[i * 4 + a] * (physical ? 1 : o);
      hook?.texel(i, at, physical ? 1 : o);
    }
    done += length;
    options.onProgress?.(done, samples);
    await checkpoint(options.signal);
  }
  const filled = new Uint8Array(pixels);
  for (const at of covered) filled[at] = 1;
  dilate([irradiance, occlusion, ...(hook?.planes ?? [])], [3, 1, ...(hook?.channels ?? [])], filled, w, h, passes);
  let lightmapScale = 1;
  for (const v of irradiance) {
    if (!Number.isFinite(v)) throw new RangeError(`${fn} lighting overflow; lower light intensity`);
    lightmapScale = Math.max(lightmapScale, v);
  }
  const lightmap = new Uint8Array(pixels * 4),
    ao = new Uint8Array(pixels * 4);
  for (let i = 0; i < pixels; i++) {
    if (!filled[i]) continue;
    for (let a = 0; a < 3; a++) {
      lightmap[i * 4 + a] = byte(irradiance[i * 3 + a] / lightmapScale);
      ao[i * 4 + a] = byte(occlusion[i]);
    }
    lightmap[i * 4 + 3] = ao[i * 4 + 3] = 255;
  }
  options.signal?.throwIfAborted();
  return {
    width: w,
    height: h,
    lightmap,
    ao,
    irradiance,
    triangle: coverage.tri,
    lightmapScale,
    samples,
    rays,
    overlaps: coverage.overlaps,
    degenerate: coverage.degenerate,
    ...(physical ? { radiometry: 'physical' as const } : {}),
  };
}
