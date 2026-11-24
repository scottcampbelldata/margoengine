// The triangle-mesh lightmap bake shared by @margoengine/lightmap/mesh and the entries built on it (./directional):
// conservative UV-space rasterization (Hasselgren, Akenine-Moller and Ohlsson, "Conservative Rasterization", GPU Gems 2,
// ch. 42, 2005; the rasterizer and dilation live in texels.ts, shared with ./gpu), shadowed direct light and AO through
// @margoengine/bvh, optional path-traced diffuse bounces, then dilation. Internal: not an entry.
//
// Bounces: each texel's irradiance gains pi times the mean incoming radiance over `bounceRays` cosine-weighted paths.
// With cosine sampling the pdf cos/pi cancels the cosine of the irradiance integral, so a path reaching a Lambertian
// hit of reflectance rho with irradiance E there adds rho * E; continuing the path from that hit and multiplying the
// reflectances along it estimates the later bounces (Kajiya, "The Rendering Equation", SIGGRAPH 1986; Pharr, Jakob and
// Humphreys, "Physically Based Rendering", 4th ed., 2023, sections 13.2 "Path Tracing" and 13.3 "A Simple Path
// Tracer"). E at a hit is its direct light by next-event estimation: shadow rays to the lights plus ambient light, as
// for the texel itself. Hit normals are the geometric normal turned toward the arriving ray, as in ./gpu.
import { type BakeLight, bakeVertexColors } from '@margoengine/bvh/bake';
import { MeshBVH } from '@margoengine/bvh/tree';
import { checkpoint, inRange } from './checks.js';
import type { LightmapMesh, MeshLightmap, MeshLightmapOptions } from './mesh.js';
import { dilate, indicesOf, rasterize } from './texels.js';

const byte = (v: number) => Math.round(Math.max(0, Math.min(1, v)) * 255);

/** A seeded uniform generator in [0, 1): Mulberry32 (Tommy Ettinger, 2017, public domain), for repeatable paths. */
function uniform(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), a | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Linear RGB reflectance, each 0 to 1; default 0.8 grey. */
function rgbOf(value: readonly number[] | undefined, name: string): number[] {
  const rgb = value ?? [0.8, 0.8, 0.8];
  if (!Array.isArray(rgb) || rgb.length !== 3 || !rgb.every((v) => v >= 0 && v <= 1))
    throw new RangeError(`${name} must be 3 values from 0 to 1; pass linear RGB reflectance`);
  return [...rgb];
}

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
    bounces = range(options.bounces ?? 0, 0, 8, 'bounces'),
    bounceRays = range(options.bounceRays ?? 16, 1, 1024, 'bounceRays'),
    { p: positions, ix } = indicesOf(fn, 'mesh', mesh?.positions, mesh?.indices),
    vertices = positions.length / 3;
  if (bounces > 0 && !physical)
    throw new TypeError(`${fn} bounces need radiometry 'physical'; set it or bake without bounces`);
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
  const albedo = rgbOf(options.albedo, `${fn} albedo`),
    others = (options.occluders ?? []).map((o, i) => ({
      ...indicesOf(fn, `occluder ${i}`, o?.positions, o?.indices),
      albedo: rgbOf(o?.albedo ?? albedo, `${fn} occluder ${i} albedo`),
    })),
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
    preBytes =
      pixels * (45 + (extra?.bytesPerTexel ?? 0)) +
      occluderTriangles * (160 + (bounces ? 12 : 0)) +
      occluderVertices * 12 +
      262144 +
      (bounces ? 256 * bounceRays * 64 : 0);
  if (preBytes > maxBytes) throw new RangeError(`${fn} needs about ${preBytes} bytes, over maxBytes; bake less`);
  const coverage = rasterize(uv, ix, w, h),
    covered: number[] = [];
  for (let i = 0; i < pixels; i++) if (coverage.tri[i] >= 0) covered.push(i);
  const samples = covered.length;
  if (samples > maxSamples)
    throw new RangeError(`${fn} covers ${samples} texels, over maxSamples; lower the size or raise it`);
  // A bounce path casts one ray per bounce and, at each hit, one shadow ray per light.
  const shadowed = lights.filter((l) => l.type !== 'ambient' && l.visible !== false).length,
    rays = samples * (aoRays + shadowed + bounceRays * bounces * (1 + shadowed));
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
  // Each face's reflectance, for bounces: the mesh's, then each occluder's.
  const reflectance = new Float32Array(bounces ? occluderTriangles * 3 : 0);
  if (bounces) {
    let face = 0;
    for (const [count, rgb] of [
      [triangles, albedo] as const,
      ...others.map((o) => [o.ix.length / 3, o.albedo] as const),
    ])
      for (let k = 0; k < count; k++, face++) reflectance.set(rgb, face * 3);
  }
  const bvh = MeshBVH.build({ positions: all, indices: allIndices }),
    hook = extra?.create(pixels),
    irradiance = new Float32Array(pixels * 3),
    occlusion = new Float32Array(pixels),
    corner = (t: number, k: number, a: number, of: Float32Array) => of[ix[t * 3 + k] * 3 + a];
  // Bounce light of one batch: `bounceRays` paths per point, all paths of a depth traced together so the direct light at
  // their hits is one bakeVertexColors call. Returns RGB irradiance per point.
  const bounce = (points: Float32Array, normals: Float32Array, owner: Int32Array, batchSeed: number) => {
    const n = points.length / 3,
      paths = n * bounceRays,
      random = uniform(batchSeed ^ 0x9e3779b9),
      out = new Float32Array(n * 3),
      origin = new Float32Array(paths * 3),
      normal = new Float32Array(paths * 3),
      weight = new Float32Array(paths * 3).fill(1),
      face = new Int32Array(paths),
      alive: number[] = [],
      direction = [0, 0, 0];
    for (let q = 0; q < paths; q++) {
      const i = Math.floor(q / bounceRays);
      origin.set(points.subarray(i * 3, i * 3 + 3), q * 3);
      normal.set(normals.subarray(i * 3, i * 3 + 3), q * 3);
      face[q] = owner[i];
      alive.push(q);
    }
    for (let depth = 0; depth < bounces && alive.length; depth++) {
      const hits: number[] = [],
        at = new Float32Array(alive.length * 3),
        facing = new Float32Array(alive.length * 3);
      for (const q of alive) {
        // A cosine-weighted direction about the normal (Malley's method: a uniform disk point lifted to the hemisphere),
        // in the orthonormal frame of Duff et al., "Building an Orthonormal Basis, Revisited", JCGT 6(1), 2017.
        const nx = normal[q * 3],
          ny = normal[q * 3 + 1],
          nz = normal[q * 3 + 2],
          sign = nz >= 0 ? 1 : -1,
          k = -1 / (sign + nz),
          m = nx * ny * k,
          u = random(),
          phi = 2 * Math.PI * random(),
          r = Math.sqrt(u),
          x = r * Math.cos(phi),
          y = r * Math.sin(phi),
          z = Math.sqrt(Math.max(0, 1 - u));
        direction[0] = (1 + sign * nx * nx * k) * x + m * y + nx * z;
        direction[1] = sign * m * x + (sign + ny * ny * k) * y + ny * z;
        direction[2] = -sign * nx * x - ny * y + nz * z;
        const from = face[q],
          hit = bvh.raycastFirst(
            {
              origin: [origin[q * 3] + nx * bias, origin[q * 3 + 1] + ny * bias, origin[q * 3 + 2] + nz * bias],
              direction,
            },
            { includeFace: (f) => f !== from },
          );
        if (!hit) continue;
        const g = hit.faceNormal,
          turn = g[0] * direction[0] + g[1] * direction[1] + g[2] * direction[2] > 0 ? -1 : 1,
          j = hits.length;
        hits.push(q);
        at.set(hit.point, j * 3);
        for (let a = 0; a < 3; a++) {
          facing[j * 3 + a] = g[a] * turn;
          weight[q * 3 + a] *= reflectance[hit.faceIndex * 3 + a];
        }
        face[q] = hit.faceIndex;
      }
      const count = hits.length,
        positions = at.subarray(0, count * 3),
        hitNormals = facing.subarray(0, count * 3),
        light = count
          ? bakeVertexColors({ positions, normals: hitNormals }, bvh, {
              lights,
              segmentShadows: true,
              shadowFaceFilter: (f, j) => f !== face[hits[j]],
              bias,
              seed: (batchSeed + depth + 1) >>> 0,
            })
          : new Float32Array(0);
      for (let j = 0; j < count; j++) {
        const q = hits[j],
          i = Math.floor(q / bounceRays);
        for (let a = 0; a < 3; a++) out[i * 3 + a] += (weight[q * 3 + a] * light[j * 4 + a]) / bounceRays;
        origin.set(positions.subarray(j * 3, j * 3 + 3), q * 3);
        normal.set(hitNormals.subarray(j * 3, j * 3 + 3), q * 3);
      }
      alive.length = 0;
      alive.push(...hits);
    }
    return out;
  };
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
    if (bounces) {
      const indirect = bounce(points, shading, owner, batchSeed);
      for (let i = 0; i < length; i++)
        for (let a = 0; a < 3; a++) irradiance[covered[start + i] * 3 + a] += indirect[i * 3 + a];
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
