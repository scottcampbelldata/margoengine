// The triangle-mesh lightmap bake shared by @margoengine/lightmap/mesh and the entries built on it (./directional):
// conservative UV-space rasterization (Hasselgren, Akenine-Moller and Ohlsson, "Conservative Rasterization", GPU Gems 2,
// ch. 42, 2005), shadowed direct light and AO through @margoengine/bvh, then dilation. Internal: not an entry.
import { type BakeLight, bakeVertexColors } from '@margoengine/bvh/bake';
import { MeshBVH } from '@margoengine/bvh/tree';
import { checkpoint, inRange } from './checks.js';
import type { LightmapMesh, MeshLightmap, MeshLightmapOptions } from './mesh.js';

const byte = (v: number) => Math.round(Math.max(0, Math.min(1, v)) * 255);

export function indicesOf(
  fn: string,
  name: string,
  positions: unknown,
  indices: unknown,
): { p: Float32Array; ix: Uint32Array } {
  if (!(positions instanceof Float32Array) || !positions.length || positions.length % 3)
    throw new RangeError(`${fn} ${name} positions must hold 3 floats per vertex; pass at least one`);
  for (const v of positions)
    if (!Number.isFinite(v) || Math.abs(v) > 1e7)
      throw new RangeError(`${fn} ${name} positions must be finite within +-10,000,000`);
  const vertices = positions.length / 3;
  let ix: Uint32Array;
  if (indices === undefined) ix = Uint32Array.from({ length: vertices }, (_, i) => i);
  else if (indices instanceof Uint32Array || indices instanceof Uint16Array) ix = Uint32Array.from(indices);
  else throw new TypeError(`${fn} ${name} indices must be a Uint32Array or Uint16Array`);
  if (!ix.length || ix.length % 3)
    throw new RangeError(`${fn} ${name} needs three indices per triangle; pass at least one triangle`);
  for (const i of ix)
    if (i >= vertices)
      throw new RangeError(`${fn} ${name} index ${i} is past the last vertex; pass indices below the vertex count`);
  return { p: positions.slice(), ix };
}

/** Per texel: the triangle it samples, the barycentrics (of vertices 1 and 2) and the UV distance of the sample. */
interface Coverage {
  tri: Int32Array;
  bary: Float32Array;
  dist: Float32Array;
  strict: Uint8Array;
  overlaps: number;
  degenerate: number;
}

/**
 * Rasterizes every triangle in texel space. A texel whose centre is inside a triangle samples that point. A texel only
 * touched by a triangle (overestimated conservative rasterization: each edge function shifted out by the cell's
 * worst-case half extent, inside the triangle's bounds) samples the triangle's point nearest its centre, unless a
 * nearer triangle or a centre hit claims it, so chart borders are lit to their outer texels.
 */
function rasterize(uv: Float32Array, ix: Uint32Array, w: number, h: number): Coverage {
  const tri = new Int32Array(w * h).fill(-1),
    bary = new Float32Array(w * h * 2),
    dist = new Float32Array(w * h).fill(Infinity),
    strict = new Uint8Array(w * h);
  let overlaps = 0,
    degenerate = 0;
  const xs = [0, 0, 0],
    ys = [0, 0, 0],
    // Overlaps thinner than this many texels count as touching: float32 UVs at 2,048 texels are off by about 1e-4.
    touch = 1e-3;
  for (let t = 0; t < ix.length / 3; t++) {
    for (let k = 0; k < 3; k++) {
      xs[k] = uv[ix[t * 3 + k] * 2] * w;
      ys[k] = uv[ix[t * 3 + k] * 2 + 1] * h;
    }
    const area = (xs[1] - xs[0]) * (ys[2] - ys[0]) - (ys[1] - ys[0]) * (xs[2] - xs[0]);
    if (!(Math.abs(area) > 1e-9)) {
      degenerate++;
      continue;
    }
    const sign = area > 0 ? 1 : -1,
      // Edge k runs from vertex k to k + 1; e_k(p) >= 0 inside, and e_k / |area| is the barycentric of vertex k + 2.
      edge = (k: number, px: number, py: number) => {
        const a = k,
          b = (k + 1) % 3;
        return sign * ((xs[b] - xs[a]) * (py - ys[a]) - (ys[b] - ys[a]) * (px - xs[a]));
      },
      // The cell's worst-case half extent along each edge's normal, less the touch tolerance, in edge-function units.
      half = [0, 1, 2].map((k) => {
        const ex = xs[(k + 1) % 3] - xs[k],
          ey = ys[(k + 1) % 3] - ys[k];
        return 0.5 * (Math.abs(ex) + Math.abs(ey)) - touch * Math.hypot(ex, ey);
      }),
      tolerance = 1e-7 * Math.abs(area),
      x0 = Math.max(0, Math.floor(Math.min(...xs) + touch)),
      x1 = Math.min(w - 1, Math.ceil(Math.max(...xs) - touch) - 1),
      y0 = Math.max(0, Math.floor(Math.min(...ys) + touch)),
      y1 = Math.min(h - 1, Math.ceil(Math.max(...ys) - touch) - 1);
    for (let y = y0; y <= y1; y++)
      for (let x = x0; x <= x1; x++) {
        const px = x + 0.5,
          py = y + 0.5,
          e0 = edge(0, px, py),
          e1 = edge(1, px, py),
          e2 = edge(2, px, py);
        // Cells that only touch the triangle along a line or a corner are not covered.
        if (e0 + half[0] <= 0 || e1 + half[1] <= 0 || e2 + half[2] <= 0) continue;
        const at = y * w + x;
        let b1: number, b2: number, d: number;
        if (e0 >= -tolerance && e1 >= -tolerance && e2 >= -tolerance) {
          // Centre inside: barycentric of vertex 1 is e2 / area, of vertex 2 is e0 / area.
          b1 = Math.max(0, e2) / Math.abs(area);
          b2 = Math.max(0, e0) / Math.abs(area);
          d = 0;
          if (e0 > tolerance && e1 > tolerance && e2 > tolerance) {
            if (strict[at]) overlaps++;
            strict[at] = 1;
          }
        } else {
          // Nearest point on the triangle's border to the centre.
          d = Infinity;
          b1 = b2 = 0;
          for (let k = 0; k < 3; k++) {
            const a = k,
              b = (k + 1) % 3,
              ex = xs[b] - xs[a],
              ey = ys[b] - ys[a],
              s = Math.max(0, Math.min(1, ((px - xs[a]) * ex + (py - ys[a]) * ey) / (ex * ex + ey * ey))),
              qx = xs[a] + s * ex - px,
              qy = ys[a] + s * ey - py,
              q = qx * qx + qy * qy;
            if (q < d) {
              d = q;
              const weights = [0, 0, 0];
              weights[a] = 1 - s;
              weights[b] = s;
              b1 = weights[1];
              b2 = weights[2];
            }
          }
          d = Math.sqrt(d);
        }
        if (d < dist[at]) {
          dist[at] = d;
          tri[at] = t;
          bary[at * 2] = b1;
          bary[at * 2 + 1] = b2;
        }
      }
  }
  return { tri, bary, dist, strict, overlaps, degenerate };
}

/** Grows filled texels into empty neighbours, `passes` times, averaging the filled 8-neighbours of each. */
function dilate(values: Float32Array[], channels: number[], filled: Uint8Array, w: number, h: number, passes: number) {
  for (let pass = 0; pass < passes; pass++) {
    const next = filled.slice();
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        if (filled[y * w + x]) continue;
        const near: number[] = [];
        for (let dy = -1; dy <= 1; dy++)
          for (let dx = -1; dx <= 1; dx++) {
            const nx = x + dx,
              ny = y + dy;
            if (nx >= 0 && ny >= 0 && nx < w && ny < h && filled[ny * w + nx]) near.push(ny * w + nx);
          }
        const n = near.length;
        if (!n) continue;
        next[y * w + x] = 1;
        values.forEach((plane, v) => {
          const k = channels[v];
          for (let c = 0; c < k; c++) {
            let sum = 0;
            for (const from of near) sum += plane[from * k + c];
            plane[(y * w + x) * k + c] = sum / n;
          }
        });
      }
    filled.set(next);
  }
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
