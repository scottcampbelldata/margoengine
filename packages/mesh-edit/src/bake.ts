// @margoengine/mesh-edit/bake: bake a detailed mesh onto a simplified one, so a level of detail keeps its look. Each
// texel of the low mesh's UV layout casts a ray along the low surface's normal to the high mesh and records what it
// finds: tangent-space normal, ambient occlusion and colour.
import type { MutableVec3, Vec3 } from '@margoengine/math';
import { MeshBVH } from '@margoengine/bvh/tree';
import { assertOptions } from './edit-support.js';
import { assertPolygonMesh, compilePolygonMesh } from './polygon.js';
import type { PolygonMesh } from './types.js';

/** An RGBA8 image, rows from the top: `data[(y * width + x) * 4]` is red. */
export interface BakeImage {
  width: number;
  height: number;
  data: Uint8ClampedArray | Uint8Array;
}

/** What a texel's ray found on the high mesh, for {@link BakeMapsOptions.color}. */
export interface BakeSample {
  /** Hit position on the high mesh. */
  point: MutableVec3;
  /** Smooth surface normal at the hit. */
  normal: MutableVec3;
  /** Texture coordinates at the hit, from the high mesh's corner UVs. */
  uv: [number, number];
  /** ID of the high mesh's face. */
  face: string;
}

/** Options for {@link bakeMeshMaps}. */
export interface BakeMapsOptions {
  /** Output width in texels, 1 to 8192. Default 512. */
  width?: number;
  /** Output height in texels, 1 to 8192. Default the width. */
  height?: number;
  /** Which maps to make. Default `['normal']`. */
  maps?: readonly ('normal' | 'ao' | 'color')[];
  /** How far from the low surface rays search, both ways, in mesh units. Default 5% of the high mesh's size. */
  distance?: number;
  /** Colour source: a texture read at the high mesh's UVs, or a function of the hit returning RGBA 0 to 255. Needed for `'color'`. */
  color?: BakeImage | ((sample: BakeSample) => readonly [number, number, number, number]);
  /** Occlusion rays per texel, 1 to 1024. Default 32. */
  aoRays?: number;
  /** Hits farther than this do not occlude. Default the high mesh's size. */
  aoDistance?: number;
  /** Texels grown out of each UV island, 0 to 64, so filtering and mips do not reach the background. Default 4. */
  padding?: number;
  /** Seed for the occlusion rays, so a bake repeats exactly. Default 1. */
  seed?: number;
  /** Checked as the work goes; aborting throws the signal's reason. */
  signal?: AbortSignal;
}

/** Result of {@link bakeMeshMaps}. Maps not asked for are absent. */
export interface BakeMapsResult {
  /** Tangent-space normal map: X in red, Y in green, Z in blue, flat is (128, 128, 255). Green up, as glTF expects. */
  normal?: BakeImage;
  /** Occlusion in all three colour channels: 255 is open. */
  ao?: BakeImage;
  color?: BakeImage;
  /** Texels inside the low mesh's UV islands. */
  covered: number;
  /** Covered texels whose ray found nothing within `distance`; they keep the low surface's own normal. */
  missed: number;
}

const unit = (v: number[]): MutableVec3 => {
  const size = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / size, v[1] / size, v[2] / size];
};
const dot = (u: Vec3, v: Vec3): number => u[0] * v[0] + u[1] * v[1] + u[2] * v[2];
const cross = (u: Vec3, v: Vec3): MutableVec3 => [
  u[1] * v[2] - u[2] * v[1],
  u[2] * v[0] - u[0] * v[2],
  u[0] * v[1] - u[1] * v[0],
];

/** Vertex normals shared across a mesh's smooth surface: area-weighted, by position so UV seams do not crease. */
function smoothNormals(positions: readonly number[], indices: readonly number[]): Float32Array {
  const sums = new Map<string, MutableVec3>(),
    keys: string[] = [];
  for (let i = 0; i < positions.length; i += 3) keys.push(`${positions[i]},${positions[i + 1]},${positions[i + 2]}`);
  for (let t = 0; t < indices.length; t += 3) {
    const [a, b, c] = [indices[t], indices[t + 1], indices[t + 2]],
      p = (i: number): MutableVec3 => [positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2]],
      A = p(a),
      B = p(b),
      C = p(c),
      n = cross([B[0] - A[0], B[1] - A[1], B[2] - A[2]], [C[0] - A[0], C[1] - A[1], C[2] - A[2]]);
    for (const i of [a, b, c]) {
      const sum = sums.get(keys[i]) ?? [0, 0, 0];
      sums.set(keys[i], [sum[0] + n[0], sum[1] + n[1], sum[2] + n[2]]);
    }
  }
  const out = new Float32Array(positions.length);
  keys.forEach((key, i) => {
    const n = unit(sums.get(key) ?? [0, 0, 1]);
    out[i * 3] = n[0];
    out[i * 3 + 1] = n[1];
    out[i * 3 + 2] = n[2];
  });
  return out;
}

function sampleImage(image: BakeImage, u: number, v: number): [number, number, number, number] {
  const { width, height, data } = image,
    x = Math.min(width - 1, Math.max(0, Math.floor(u * width))),
    y = Math.min(height - 1, Math.max(0, Math.floor(v * height))),
    at = (y * width + x) * 4;
  return [data[at], data[at + 1], data[at + 2], data[at + 3]];
}

/** A cosine-weighted direction around unit `n`. */
function hemisphere(n: Vec3, r1: number, r2: number): MutableVec3 {
  const t = unit(cross(Math.abs(n[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0], n)),
    b = cross(n, t),
    radius = Math.sqrt(r1),
    angle = Math.PI * 2 * r2,
    x = radius * Math.cos(angle),
    y = radius * Math.sin(angle),
    z = Math.sqrt(Math.max(0, 1 - r1));
  return [t[0] * x + b[0] * y + n[0] * z, t[1] * x + b[1] * y + n[1] * z, t[2] * x + b[2] * y + n[2] * z];
}

/** Grow covered texels outward, `steps` rings, each copying the mean of its covered neighbors. */
function dilate(images: readonly BakeImage[], mask: Uint8Array, width: number, height: number, steps: number): void {
  let current = mask;
  for (let step = 0; step < steps; step++) {
    const next = current.slice();
    for (let y = 0; y < height; y++)
      for (let x = 0; x < width; x++) {
        const at = y * width + x;
        if (current[at]) continue;
        const around: number[] = [];
        for (let dy = -1; dy <= 1; dy++)
          for (let dx = -1; dx <= 1; dx++) {
            const nx = x + dx,
              ny = y + dy;
            if ((dx || dy) && nx >= 0 && ny >= 0 && nx < width && ny < height && current[ny * width + nx])
              around.push(ny * width + nx);
          }
        if (!around.length) continue;
        next[at] = 1;
        for (const image of images)
          for (let k = 0; k < 4; k++)
            image.data[at * 4 + k] = around.reduce((sum, i) => sum + image.data[i * 4 + k], 0) / around.length;
      }
    current = next;
  }
}

/**
 * Bake normal, ambient occlusion and colour maps from `high` onto `low`, whose corner UVs give the layout (use
 * `unwrapMesh` first if they overlap). For each covered texel a ray leaves the low surface along its smooth normal, in
 * both directions up to `distance`, and the nearest hit on `high` (found through a BVH) is recorded. Normals are in the
 * low surface's tangent frame, built from its UVs, so they work with any material that takes a glTF normal map.
 * @throws TypeError for bad meshes or options, or `'color'` without `color`; RangeError for an option outside its
 * limits; the signal's reason when aborted.
 */
export function bakeMeshMaps(low: PolygonMesh, high: PolygonMesh, options: BakeMapsOptions = {}): BakeMapsResult {
  assertPolygonMesh(low);
  assertPolygonMesh(high);
  assertOptions(options, 'Bake');
  const { width = 512, height = width, maps = ['normal'], aoRays = 32, padding = 4, seed = 1, signal, color } = options;
  for (const size of [width, height])
    if (!Number.isInteger(size) || size < 1 || size > 8192)
      throw new RangeError('Bake width and height must be integers from 1 to 8192; choose a texture size.');
  if (!Array.isArray(maps) || maps.some((map) => map !== 'normal' && map !== 'ao' && map !== 'color'))
    throw new TypeError("Bake maps must list 'normal', 'ao' or 'color'; choose from those.");
  if (!Number.isInteger(aoRays) || aoRays < 1 || aoRays > 1024)
    throw new RangeError('Bake aoRays must be an integer from 1 to 1024; choose a ray count.');
  if (!Number.isInteger(padding) || padding < 0 || padding > 64)
    throw new RangeError('Bake padding must be an integer from 0 to 64; choose a texel count.');
  if (signal !== undefined && !(signal instanceof AbortSignal))
    throw new TypeError('Bake signal must be an AbortSignal; pass controller.signal or omit it.');
  if (maps.includes('color')) {
    const image = color as BakeImage | undefined;
    if (typeof color !== 'function' && !(image && image.data?.length === image.width * image.height * 4))
      throw new TypeError("Bake 'color' needs a color image or function; supply one or leave out 'color'.");
  }
  const target = compilePolygonMesh(high),
    source = compilePolygonMesh(low),
    targetNormals = smoothNormals(target.positions, target.indices),
    sourceNormals = smoothNormals(source.positions, source.indices),
    bvh = MeshBVH.build({
      positions: new Float64Array(target.positions),
      indices: target.indices,
      precision: 'float64',
    }),
    box = bvh.getBoundingBox(),
    size = Math.hypot(box.max[0] - box.min[0], box.max[1] - box.min[1], box.max[2] - box.min[2]),
    distance = options.distance ?? size * 0.05,
    aoDistance = options.aoDistance ?? size;
  if (!(distance > 0) || !(aoDistance > 0))
    throw new RangeError('Bake distance and aoDistance must be positive; choose lengths in mesh units.');
  const pixels = width * height,
    image = (): BakeImage => ({ width, height, data: new Uint8ClampedArray(pixels * 4) }),
    normal = maps.includes('normal') ? image() : undefined,
    ao = maps.includes('ao') ? image() : undefined,
    colorMap = maps.includes('color') ? image() : undefined,
    mask = new Uint8Array(pixels),
    bias = size * 1e-5;
  let state = seed >>> 0 || 1,
    covered = 0,
    missed = 0;
  const random = (): number => {
      state ^= state << 13;
      state ^= state >>> 17;
      state ^= state << 5;
      state >>>= 0;
      return state / 4294967296;
    },
    /** The hit nearest the low surface, either way along the normal: one ray through the whole search range. */
    probe = (origin: Vec3, direction: Vec3) => {
      const start = [0, 1, 2].map((k) => origin[k] + direction[k] * distance),
        hits = bvh.raycast(
          { origin: start, direction: [-direction[0], -direction[1], -direction[2]] },
          { far: distance * 2 },
        );
      let best = null,
        gap = Infinity;
      for (const hit of hits)
        if (Math.abs(hit.distance - distance) < gap) {
          best = hit;
          gap = Math.abs(hit.distance - distance);
        }
      return best;
    },
    write = (map: BakeImage | undefined, at: number, r: number, g: number, b: number, a = 255) => {
      if (!map) return;
      map.data[at * 4] = r;
      map.data[at * 4 + 1] = g;
      map.data[at * 4 + 2] = b;
      map.data[at * 4 + 3] = a;
    };
  for (let t = 0; t < source.indices.length; t += 3) {
    signal?.throwIfAborted();
    const corner = [source.indices[t], source.indices[t + 1], source.indices[t + 2]],
      uv = corner.map((c) => [source.uvs[c * 2] * width, source.uvs[c * 2 + 1] * height]),
      P = corner.map(
        (c): MutableVec3 => [source.positions[c * 3], source.positions[c * 3 + 1], source.positions[c * 3 + 2]],
      ),
      N = corner.map((c): MutableVec3 => [sourceNormals[c * 3], sourceNormals[c * 3 + 1], sourceNormals[c * 3 + 2]]),
      area = (uv[1][0] - uv[0][0]) * (uv[2][1] - uv[0][1]) - (uv[1][1] - uv[0][1]) * (uv[2][0] - uv[0][0]);
    if (!area) continue;
    // The UV gradient of position gives the tangent frame (image V runs down, so the green axis is the minus V way).
    const e1 = [P[1][0] - P[0][0], P[1][1] - P[0][1], P[1][2] - P[0][2]],
      e2 = [P[2][0] - P[0][0], P[2][1] - P[0][1], P[2][2] - P[0][2]],
      du1 = uv[1][0] - uv[0][0],
      dv1 = uv[1][1] - uv[0][1],
      du2 = uv[2][0] - uv[0][0],
      dv2 = uv[2][1] - uv[0][1],
      tangent = [0, 1, 2].map((k) => (e1[k] * dv2 - e2[k] * dv1) / area),
      bitangent = [0, 1, 2].map((k) => -(e2[k] * du1 - e1[k] * du2) / area),
      minX = Math.max(0, Math.floor(Math.min(uv[0][0], uv[1][0], uv[2][0]))),
      maxX = Math.min(width - 1, Math.ceil(Math.max(uv[0][0], uv[1][0], uv[2][0]))),
      minY = Math.max(0, Math.floor(Math.min(uv[0][1], uv[1][1], uv[2][1]))),
      maxY = Math.min(height - 1, Math.ceil(Math.max(uv[0][1], uv[1][1], uv[2][1])));
    for (let y = minY; y <= maxY; y++)
      for (let x = minX; x <= maxX; x++) {
        const at = y * width + x;
        if (mask[at]) continue;
        const px = x + 0.5 - uv[0][0],
          py = y + 0.5 - uv[0][1],
          s = (px * dv2 - py * du2) / area,
          r = (du1 * py - dv1 * px) / area,
          w = 1 - s - r;
        // Slack keeps texel centers on a shared edge from falling between its two triangles to rounding.
        if (s < -1e-9 || r < -1e-9 || w < -1e-9) continue;
        mask[at] = 1;
        covered++;
        const point = [0, 1, 2].map((k) => P[0][k] * w + P[1][k] * s + P[2][k] * r) as MutableVec3,
          n = unit([0, 1, 2].map((k) => N[0][k] * w + N[1][k] * s + N[2][k] * r)),
          hit = probe(point, n);
        // Gram-Schmidt against the smooth normal, with the UV frame's own handedness.
        const along = dot(tangent as MutableVec3, n),
          T = unit([0, 1, 2].map((k) => tangent[k] - n[k] * along)),
          B = dot(cross(n, T), bitangent as MutableVec3) >= 0 ? cross(n, T) : (cross(T, n) as MutableVec3);
        if (!hit) {
          missed++;
          write(normal, at, 128, 128, 255);
          write(ao, at, 255, 255, 255);
          write(colorMap, at, 0, 0, 0, 0);
          continue;
        }
        const [a, b, c] = hit.face,
          [wa, wb, wc] = hit.barycoord,
          smooth = unit(
            [0, 1, 2].map(
              (k) => targetNormals[a * 3 + k] * wa + targetNormals[b * 3 + k] * wb + targetNormals[c * 3 + k] * wc,
            ),
          );
        if (normal) {
          const tx = dot(smooth, T),
            ty = dot(smooth, B),
            tz = dot(smooth, n);
          write(normal, at, (tx * 0.5 + 0.5) * 255, (ty * 0.5 + 0.5) * 255, (tz * 0.5 + 0.5) * 255);
        }
        if (ao) {
          const from: MutableVec3 = [
            hit.point[0] + smooth[0] * bias,
            hit.point[1] + smooth[1] * bias,
            hit.point[2] + smooth[2] * bias,
          ];
          let open = 0;
          for (let ray = 0; ray < aoRays; ray++)
            if (
              !bvh.raycastFirst(
                { origin: from, direction: hemisphere(smooth, random(), random()) },
                { far: aoDistance },
              )
            )
              open++;
          const value = (open / aoRays) * 255;
          write(ao, at, value, value, value);
        }
        if (colorMap) {
          const face = target.triangleFaces[hit.faceIndex],
            u = target.uvs[a * 2] * wa + target.uvs[b * 2] * wb + target.uvs[c * 2] * wc,
            v = target.uvs[a * 2 + 1] * wa + target.uvs[b * 2 + 1] * wb + target.uvs[c * 2 + 1] * wc,
            rgba =
              typeof color === 'function'
                ? color({ point: hit.point, normal: smooth, uv: [u, v], face })
                : sampleImage(color as BakeImage, u, v);
          write(colorMap, at, rgba[0], rgba[1], rgba[2], rgba[3]);
        }
      }
  }
  const images = [normal, ao, colorMap].filter((item): item is BakeImage => item !== undefined);
  dilate(images, mask, width, height, padding);
  return { normal, ao, color: colorMap, covered, missed };
}
