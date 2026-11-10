// The texel side of triangle-mesh baking, shared by ./mesh (CPU) and ./gpu: input checks, conservative UV
// rasterization (Hasselgren, Akenine-Moller and Ohlsson, "Conservative Rasterization", GPU Gems 2, ch. 42, 2005), the
// surface point and normal of each covered texel, and dilation and encoding of the result.
import type { BakeLight } from '@margoengine/bvh/bake';
import { inRange } from './checks.js';
import type { LightmapMesh, MeshLightmap, MeshLightmapOptions } from './mesh.js';

const byte = (v: number) => Math.round(Math.max(0, Math.min(1, v)) * 255);

export function indicesOf(
  subject: string,
  name: string,
  positions: unknown,
  indices: unknown,
): { p: Float32Array; ix: Uint32Array } {
  if (!(positions instanceof Float32Array) || !positions.length || positions.length % 3)
    throw new RangeError(`${subject} ${name} positions must hold 3 floats per vertex; pass at least one`);
  for (const v of positions)
    if (!Number.isFinite(v) || Math.abs(v) > 1e7)
      throw new RangeError(`${subject} ${name} positions must be finite within +-10,000,000`);
  const vertices = positions.length / 3;
  let ix: Uint32Array;
  if (indices === undefined) ix = Uint32Array.from({ length: vertices }, (_, i) => i);
  else if (indices instanceof Uint32Array || indices instanceof Uint16Array) ix = Uint32Array.from(indices);
  else throw new TypeError(`${subject} ${name} indices must be a Uint32Array or Uint16Array`);
  if (!ix.length || ix.length % 3)
    throw new RangeError(`${subject} ${name} needs three indices per triangle; pass at least one triangle`);
  for (const i of ix)
    if (i >= vertices)
      throw new RangeError(
        `${subject} ${name} index ${i} is past the last vertex; pass indices below the vertex count`,
      );
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
export function rasterize(uv: Float32Array, ix: Uint32Array, w: number, h: number): Coverage {
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
export function dilate(
  values: Float32Array[],
  channels: number[],
  filled: Uint8Array,
  w: number,
  h: number,
  passes: number,
) {
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

/** Validated input of a triangle-mesh bake and the texels it covers, shared by the CPU (./mesh) and GPU (./gpu) bakers. */
export interface Prepared {
  width: number;
  height: number;
  physical: boolean;
  dilate: number;
  bias: number;
  aoDistance: number;
  seed: number;
  lights: BakeLight[];
  /** Covered pixel indices, row-major. */
  covered: Int32Array;
  /** Sample point, unit shading normal and triangle per covered texel. */
  points: Float32Array;
  normals: Float32Array;
  owner: Uint32Array;
  /** The mesh then each occluder, as one indexed soup: face t below `meshTriangles` is the mesh's triangle t. */
  positions: Float32Array;
  indices: Uint32Array;
  meshTriangles: number;
  occluderTriangles: number[];
  triangle: Int32Array;
  overlaps: number;
  degenerate: number;
}

/**
 * Checks a mesh and options (every budget before allocating), rasterizes the UV charts and finds each covered texel's
 * surface point and normal. `rays` per texel is what the caller will trace, for the maxRays check.
 */
export function prepare(
  mesh: LightmapMesh,
  options: MeshLightmapOptions,
  subject: string,
  raysPerTexel: (lights: BakeLight[]) => number,
): Prepared {
  options.signal?.throwIfAborted();
  if (options.radiometry !== undefined && options.radiometry !== 'legacy' && options.radiometry !== 'physical')
    throw new TypeError(`${subject} radiometry must be 'legacy' or 'physical'`);
  const range = (value: number, min: number, max: number, name: string, integer?: boolean) =>
      inRange(value, min, max, `${subject} ${name}`, integer),
    width = range(options.width ?? 256, 1, 2048, 'width'),
    height = range(options.height ?? width, 1, 2048, 'height'),
    dilate = range(options.dilate ?? 2, 0, 16, 'dilate'),
    aoDistance = range(options.aoDistance ?? 4, 0.001, 1e6, 'aoDistance', false),
    bias = range(options.bias ?? 1e-3, 0, 1, 'bias', false),
    seed = range(options.seed ?? 0, 0, 4294967295, 'seed'),
    maxSamples = range(options.maxSamples ?? 1048576, 1, 4194304, 'maxSamples'),
    maxRays = range(options.maxRays ?? 16777216, 1, 67108864, 'maxRays'),
    maxBytes = range(options.maxBytes ?? 201326592, 1, 268435456, 'maxBytes'),
    { p, ix } = indicesOf(subject, 'mesh', mesh?.positions, mesh?.indices),
    vertices = p.length / 3;
  if (!(mesh.uv1 instanceof Float32Array) || mesh.uv1.length !== vertices * 2)
    throw new RangeError(`${subject} uv1 must hold 2 floats per vertex; pass the mesh TEXCOORD_1`);
  const uv = mesh.uv1.slice();
  for (const v of uv)
    if (!(v >= 0 && v <= 1)) throw new RangeError(`${subject} uv1 values must be 0 to 1; repack the lightmap UVs`);
  let normals: Float32Array | undefined;
  if (mesh.normals !== undefined) {
    if (!(mesh.normals instanceof Float32Array) || mesh.normals.length !== vertices * 3)
      throw new RangeError(`${subject} normals must hold 3 floats per vertex; match the vertex count`);
    for (const v of mesh.normals)
      if (!Number.isFinite(v)) throw new RangeError(`${subject} normals must be finite; fix the mesh normals`);
    normals = mesh.normals.slice();
  }
  const others = (options.occluders ?? []).map((o, i) => indicesOf(subject, `occluder ${i}`, o?.positions, o?.indices)),
    lights = structuredClone([...(options.lights ?? [])]),
    meshTriangles = ix.length / 3;
  let allTriangles = meshTriangles,
    allVertices = vertices;
  for (const o of others) {
    allTriangles += o.ix.length / 3;
    allVertices += o.p.length / 3;
  }
  // Coverage and float planes per pixel, the BVH and its inputs, before anything is allocated.
  const pixels = width * height,
    preBytes = pixels * 45 + allTriangles * 160 + allVertices * 12 + 262144;
  if (preBytes > maxBytes) throw new RangeError(`${subject} needs about ${preBytes} bytes, over maxBytes; bake less`);
  const coverage = rasterize(uv, ix, width, height);
  let samples = 0;
  for (let i = 0; i < pixels; i++) if (coverage.tri[i] >= 0) samples++;
  if (samples > maxSamples)
    throw new RangeError(`${subject} covers ${samples} texels, over maxSamples; lower the size or raise it`);
  const rays = samples * raysPerTexel(lights);
  if (rays > maxRays) throw new RangeError(`${subject} needs ${rays} rays, over maxRays; lower the rays or the size`);
  const positions = new Float32Array(allVertices * 3),
    indices = new Uint32Array(allTriangles * 3);
  positions.set(p);
  indices.set(ix);
  let vertexAt = vertices,
    indexAt = ix.length;
  for (const o of others) {
    positions.set(o.p, vertexAt * 3);
    for (let i = 0; i < o.ix.length; i++) indices[indexAt + i] = o.ix[i] + vertexAt;
    vertexAt += o.p.length / 3;
    indexAt += o.ix.length;
  }
  const covered = new Int32Array(samples),
    points = new Float32Array(samples * 3),
    shading = new Float32Array(samples * 3),
    owner = new Uint32Array(samples),
    corner = (t: number, k: number, a: number, of: Float32Array) => of[ix[t * 3 + k] * 3 + a];
  for (let i = 0, s = 0; i < pixels; i++) {
    const t = coverage.tri[i];
    if (t < 0) continue;
    const b1 = coverage.bary[i * 2],
      b2 = coverage.bary[i * 2 + 1],
      b0 = 1 - b1 - b2,
      e1 = [0, 1, 2].map((a) => corner(t, 1, a, p) - corner(t, 0, a, p)),
      e2 = [0, 1, 2].map((a) => corner(t, 2, a, p) - corner(t, 0, a, p));
    let n = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
    if (normals) {
      const smooth = [0, 1, 2].map(
        (a) => b0 * corner(t, 0, a, normals) + b1 * corner(t, 1, a, normals) + b2 * corner(t, 2, a, normals),
      );
      if (Math.hypot(...smooth) > 1e-10) n = smooth;
    }
    const l = Math.hypot(...n) || 1;
    covered[s] = i;
    owner[s] = t;
    for (let a = 0; a < 3; a++) {
      points[s * 3 + a] = b0 * corner(t, 0, a, p) + b1 * corner(t, 1, a, p) + b2 * corner(t, 2, a, p);
      shading[s * 3 + a] = n[a] / l;
    }
    s++;
  }
  return {
    width,
    height,
    physical: options.radiometry === 'physical',
    dilate,
    bias,
    aoDistance,
    seed,
    lights,
    covered,
    points,
    normals: shading,
    owner,
    positions,
    indices,
    meshTriangles,
    occluderTriangles: others.map((o) => o.ix.length / 3),
    triangle: coverage.tri,
    overlaps: coverage.overlaps,
    degenerate: coverage.degenerate,
  };
}

/** Dilates per-texel light (RGB) and open fraction, then encodes the record both bakers return. */
export function encode(setup: Prepared, light: ArrayLike<number>, open: ArrayLike<number>, rays: number): MeshLightmap {
  const { width, height, covered } = setup,
    pixels = width * height,
    irradiance = new Float32Array(pixels * 3),
    occlusion = new Float32Array(pixels),
    filled = new Uint8Array(pixels);
  covered.forEach((at, i) => {
    filled[at] = 1;
    occlusion[at] = open[i];
    for (let a = 0; a < 3; a++) irradiance[at * 3 + a] = light[i * 3 + a];
  });
  dilate([irradiance, occlusion], [3, 1], filled, width, height, setup.dilate);
  let lightmapScale = 1;
  for (const v of irradiance) {
    if (!Number.isFinite(v)) throw new RangeError('Lightmap lighting overflow; lower the light intensity');
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
  return {
    width,
    height,
    lightmap,
    ao,
    irradiance,
    triangle: setup.triangle,
    lightmapScale,
    samples: covered.length,
    rays,
    overlaps: setup.overlaps,
    degenerate: setup.degenerate,
    ...(setup.physical ? { radiometry: 'physical' as const } : {}),
  };
}
