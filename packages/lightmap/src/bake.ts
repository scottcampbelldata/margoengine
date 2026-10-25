// The shared atlas bake behind every entry: validation, chart packing, per-texel materials, shadowed direct light and
// AO, then HDR encoding. Optional passes plug in through `Extension`, so the plain entry carries none of their code.
import { type BakeLight, bakeVertexColors } from '@margoengine/bvh/bake';
import { MeshBVH } from '@margoengine/bvh/tree';
import { packAtlas } from '@margoengine/materials/atlas';
import type { MutableVec3 } from '@margoengine/math';
import { cross, dot, length, normalize } from '@margoengine/math/vec3';
import type { Lightmap, LightmapChart, LightmapOptions, LightmapQuads, LightmapSurface } from './index.js';

interface Settings {
  physical: boolean;
  density: number;
  padding: number;
  maxAtlasSize: number;
  maxCharts: number;
  maxSamples: number;
  maxRays: number;
  maxBytes: number;
  aoRays: number;
  aoDistance: number;
  seed: number;
}

/** A quad's chart size and tangent frame. */
interface Frame {
  w: number;
  h: number;
  t: MutableVec3;
  b: MutableVec3;
  n: MutableVec3;
}

/** The validated input copies an extension plans from, before any texture is allocated. */
export interface BakeInput {
  positions: Float32Array;
  emission?: Float32Array;
  albedo?: Float32Array;
  count: number;
  frames: Frame[];
  samples: number;
  /** Atlas pixels. */
  pixels: number;
}

/** The occluders of the lit pass: shadows (with the quad of each face) and AO. */
export interface Occluders {
  shadow: MeshBVH | null;
  ao: MeshBVH | null;
  quad: (face: number) => number;
}

/** What an extension adds to the bake. */
export interface Plan {
  /** Extra rays and bytes, checked with the plain bake's own before anything is allocated. */
  rays: number;
  bytes: number;
  /** Skip direct light and AO: the caller writes the lightmap. AO stays white. */
  unlit?: boolean;
  /** Builds the shadow and AO occluders from the one over all quads (the default for both). */
  occluders?: (all: MeshBVH) => Occluders;
  /** Sees each texel's index, quad, position, shading normal, albedo and metalness. */
  texel?: (
    i: number,
    q: number,
    position: MutableVec3,
    normal: ArrayLike<number>,
    color: readonly number[],
    metalness: number,
  ) => void;
  /** Replaces direct light, RGBA per point like `bakeVertexColors`. */
  direct?: (
    points: Float32Array,
    normals: Float32Array,
    lights: readonly BakeLight[],
    shadow: MeshBVH | null,
    includeFace: (face: number) => boolean,
  ) => ArrayLike<number>;
  /** Adds to `light` (RGB irradiance per texel) after the direct pass; `raysLeft` is what maxRays still allows. */
  finish?: (light: Float64Array, emitted: Float64Array, raysLeft: number) => Promise<void>;
}

/** Plans an extension from the validated input; runs before the first await. */
type Extension = (input: BakeInput) => Plan;

const byte = (v: number) => Math.round(Math.max(0, Math.min(1, v)) * 255);
// sRGB encoding per IEC 61966-2-1.
const srgbByte = (v: number) => byte(v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055);

/** Yields to the event loop, then throws if `signal` aborted. */
export async function checkpoint(signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  signal?.throwIfAborted();
}

/** Throws a RangeError naming `name` unless `value` is a number (an integer by default) from `min` to `max`. */
export function inRange(value: number, min: number, max: number, name: string, integer = true): number {
  if (!Number.isFinite(value) || value < min || value > max || (integer && !Number.isSafeInteger(value)))
    throw new RangeError(`${name} must be ${integer ? 'an integer' : 'a number'} from ${min} to ${max}`);
  return value;
}

/** The unit vector of `a`; throws when it is zero or not finite. */
export function unit(a: ArrayLike<number>, subject: string): MutableVec3 {
  const l = length(a);
  if (!Number.isFinite(l) || l < 1e-10) throw new RangeError(`${subject} is degenerate; pass nonzero finite vectors`);
  return normalize(a);
}

/** Copies each chart's edge texels outward into its gutter. `channels` values per pixel; charts never share texels. */
export function fillGutters(data: Uint8Array | Float64Array, channels: number, charts: LightmapChart[], width: number) {
  for (const c of charts)
    for (let y = -c.padding; y < c.height + c.padding; y++)
      for (let x = -c.padding; x < c.width + c.padding; x++) {
        if (x >= 0 && x < c.width && y >= 0 && y < c.height) continue;
        const from =
            ((c.y + Math.max(0, Math.min(c.height - 1, y))) * width + c.x + Math.max(0, Math.min(c.width - 1, x))) *
            channels,
          to = ((c.y + y) * width + c.x + x) * channels;
        data.copyWithin(to, from, from + channels);
      }
}

/** Six indices per listed quad, its two triangles (0, 1, 2) and (0, 2, 3). */
export const quadIndices = (quads: ArrayLike<number>): Uint32Array => {
  const out = new Uint32Array(quads.length * 6);
  for (let i = 0; i < quads.length; i++) {
    const q = quads[i] * 4;
    out.set([q, q + 1, q + 2, q, q + 2, q + 3], i * 6);
  }
  return out;
};

function settingsOf(o: LightmapOptions): Settings {
  if (o.radiometry !== undefined && o.radiometry !== 'legacy' && o.radiometry !== 'physical')
    throw new TypeError("bakeLightmap radiometry must be 'legacy' or 'physical'");
  const range = (value: number, min: number, max: number, name: string, integer?: boolean) =>
    inRange(value, min, max, 'bakeLightmap ' + name, integer);
  return {
    physical: o.radiometry === 'physical',
    density: range(o.texelsPerUnit ?? 1, 0.125, 16, 'texelsPerUnit', false),
    padding: range(o.padding ?? 2, 1, 16, 'padding'),
    maxAtlasSize: range(o.maxAtlasSize ?? 1024, 8, 2048, 'maxAtlasSize'),
    maxCharts: range(o.maxCharts ?? 32768, 1, 32768, 'maxCharts'),
    maxSamples: range(o.maxSamples ?? 262144, 1, 1048576, 'maxSamples'),
    maxRays: range(o.maxRays ?? 16777216, 1, 67108864, 'maxRays'),
    maxBytes: range(o.maxBytes ?? 201326592, 1, 268435456, 'maxBytes'),
    aoRays: range(o.aoRays ?? 32, 1, 128, 'aoRays'),
    aoDistance: range(o.aoDistance ?? 4, 0.001, 1e6, 'aoDistance', false),
    seed: range(o.seed ?? 0, 0, 4294967295, 'seed'),
  };
}

function checkQuads(quads: LightmapQuads, maxCharts: number): number {
  if (!(quads?.positions instanceof Float32Array) || !quads.positions.length || quads.positions.length % 12)
    throw new RangeError('bakeLightmap positions must hold 12 floats per quad; pass at least one quad');
  const count = quads.positions.length / 12;
  if (count > maxCharts)
    throw new RangeError(`bakeLightmap has ${count} quads, over maxCharts; raise it or bake fewer`);
  for (const [values, stride, name, max] of [
    [quads.albedo, 4, 'albedo', 1],
    [quads.emission, 3, 'emission', Infinity],
    [quads.roughnessMetalness, 2, 'roughnessMetalness', 1],
  ] as const) {
    if (values === undefined) continue;
    if (!(values instanceof Float32Array) || values.length !== count * stride)
      throw new RangeError(`bakeLightmap ${name} must hold ${stride} floats per quad; match the quad count`);
    for (const v of values)
      if (!Number.isFinite(v) || v < 0 || v > max)
        throw new RangeError(`bakeLightmap ${name} values must be 0${max === 1 ? ' to 1' : ' or more'} and finite`);
  }
  for (const v of quads.positions)
    if (!Number.isFinite(v) || Math.abs(v) > 1e7)
      throw new RangeError('bakeLightmap positions must be finite within +-10,000,000; move or scale the mesh');
  return count;
}

/** Tangent frames and chart sizes; checks each quad is a parallelogram and fits the atlas. */
function framesOf(positions: Float32Array, count: number, s: Settings): Frame[] {
  const frames: Frame[] = [];
  for (let q = 0; q < count; q++) {
    const o = q * 12,
      u = [0, 1, 2].map((a) => positions[o + 3 + a] - positions[o + a]),
      v = [0, 1, 2].map((a) => positions[o + 9 + a] - positions[o + a]),
      t = unit(u, 'bakeLightmap quad edge'),
      n = unit(cross(u, v), 'bakeLightmap quad'),
      b = unit(cross(n, t), 'bakeLightmap quad'),
      tolerance = 1e-4 * Math.max(1, length(u), length(v));
    for (let a = 0; a < 3; a++)
      if (Math.abs(positions[o + 6 + a] - positions[o + a] - u[a] - v[a]) > tolerance)
        throw new RangeError(`bakeLightmap quad ${q} is not a parallelogram; split it into parallelograms`);
    const w = Math.max(1, Math.ceil(length(u) * s.density)),
      h = Math.max(1, Math.ceil(length(v) * s.density));
    if (w + s.padding * 2 > s.maxAtlasSize || h + s.padding * 2 > s.maxAtlasSize)
      throw new RangeError(
        `bakeLightmap quad ${q} does not fit maxAtlasSize; lower texelsPerUnit or raise maxAtlasSize`,
      );
    frames.push({ w, h, t, b, n });
  }
  return frames;
}

/** The atlas size packAtlas will choose (same shelf packing, tallest first), predicted before it allocates. */
function predictAtlas(frames: Frame[], padding: number, maxSize: number): { width: number; height: number } {
  let area = 0,
    widest = 0;
  for (const f of frames) {
    area += (f.w + padding * 2) * (f.h + padding * 2);
    widest = Math.max(widest, f.w + padding * 2);
  }
  const order = frames.map((_, i) => i).sort((a, b) => frames[b].h - frames[a].h);
  for (let width = 2 ** Math.ceil(Math.log2(Math.max(widest, Math.sqrt(area)))); width <= maxSize; width *= 2) {
    let x = 0,
      y = 0,
      shelf = 0;
    for (const i of order) {
      const w = frames[i].w + padding * 2,
        h = frames[i].h + padding * 2;
      if (x + w > width) {
        y += shelf;
        x = shelf = 0;
      }
      x += w;
      shelf = Math.max(shelf, h);
    }
    if (y + shelf <= maxSize) return { width, height: y + shelf };
  }
  throw new RangeError('bakeLightmap charts do not fit maxAtlasSize; lower texelsPerUnit or raise maxAtlasSize');
}

/** Every component present, finite and 0 or more; Array.from turns holes into undefined, which fails. */
const validValues = (values: ArrayLike<number>, length: number) =>
  values.length === length && Array.from(values).every((v) => v >= 0 && v < Infinity);

function materialOf(
  texel: LightmapSurface,
  q: number,
  f: Frame,
  quads: LightmapQuads,
  physical: boolean,
): {
  color: readonly number[];
  emit: readonly number[];
  normal: MutableVec3;
  roughness: number;
  metalness: number;
  opacity: number;
} {
  const color = texel.albedo ?? (quads.albedo ? [...quads.albedo.subarray(q * 4, q * 4 + 4)] : [1, 1, 1, 1]),
    emit = texel.emission ?? (quads.emission ? [...quads.emission.subarray(q * 3, q * 3 + 3)] : [0, 0, 0]),
    normal = texel.normal ? unit(texel.normal, 'bakeLightmap surface normal') : f.n,
    range = (value: number, name: string) => inRange(value, 0, 1, 'bakeLightmap surface ' + name, false);
  if (!validValues(color, 4)) throw new RangeError('bakeLightmap surface albedo must be 4 finite values of 0 or more');
  if (physical && (color[0] > 1 || color[1] > 1 || color[2] > 1))
    throw new RangeError('bakeLightmap physical surface albedo RGB must be 0 to 1; lower the reflectance');
  if (!validValues(emit, 3)) throw new RangeError('bakeLightmap surface emission must be 3 finite values of 0 or more');
  return {
    color,
    emit,
    normal,
    roughness: range(texel.roughness ?? quads.roughnessMetalness?.[q * 2] ?? 0.5, 'roughness'),
    metalness: range(texel.metalness ?? quads.roughnessMetalness?.[q * 2 + 1] ?? 0, 'metalness'),
    opacity: range(texel.opacity ?? color[3], 'opacity'),
  };
}

/** The bake behind `bakeLightmap` and the optional entries. */
export async function bake(input: LightmapQuads, options: LightmapOptions, extension?: Extension): Promise<Lightmap> {
  options.signal?.throwIfAborted();
  const s = settingsOf(options),
    count = checkQuads(input, s.maxCharts),
    quads: LightmapQuads = {
      positions: input.positions.slice(),
      albedo: input.albedo?.slice(),
      emission: input.emission?.slice(),
      roughnessMetalness: input.roughnessMetalness?.slice(),
    },
    positions = quads.positions,
    lights = structuredClone(options.lights ?? []),
    frames = framesOf(positions, count, s);
  let samples = 0;
  for (const f of frames) samples += f.w * f.h;
  if (samples > s.maxSamples)
    throw new RangeError(
      `bakeLightmap needs ${samples} texels, over maxSamples; lower texelsPerUnit or bake fewer quads`,
    );
  const predicted = predictAtlas(frames, s.padding, s.maxAtlasSize),
    pixels = predicted.width * predicted.height,
    plan = extension?.({ ...quads, positions, count, frames, samples, pixels }),
    lit = !plan?.unlit,
    // bakeVertexColors skips rays for ambient lights and back-facing ones; reserve the upper bound.
    rays =
      (lit ? samples * (s.aoRays + lights.filter((l) => l.type !== 'ambient' && l.visible !== false).length) : 0) +
      (plan?.rays ?? 0);
  if (rays > s.maxRays)
    throw new RangeError(`bakeLightmap needs ${rays} rays, over maxRays; lower aoRays or texelsPerUnit`);
  // Six RGBA8 textures, Float64 light and emission scratch, the BVH, input copies, UVs and one work chunk.
  const bytes = pixels * 24 + samples * 72 + positions.byteLength * 3 + count * 512 + 262144 + (plan?.bytes ?? 0);
  if (bytes > s.maxBytes) throw new RangeError(`bakeLightmap needs about ${bytes} bytes, over maxBytes; bake less`);
  options.onProgress?.(0, samples);
  await checkpoint(options.signal);

  const occluder = lit
      ? MeshBVH.build({ positions, indices: quadIndices(Array.from({ length: count }, (_, q) => q)) })
      : null,
    {
      shadow,
      ao,
      quad: shadowQuad,
    } = (occluder && plan?.occluders?.(occluder)) || {
      shadow: occluder,
      ao: occluder,
      quad: (face: number) => face >> 1,
    },
    packed = packAtlas(
      frames.map((f) => ({ width: f.w, height: f.h, data: new Uint8Array(f.w * f.h * 4) })),
      { padding: s.padding, maxSize: s.maxAtlasSize },
    ),
    width = packed.image.width,
    height = packed.image.height,
    charts: LightmapChart[] = packed.regions.map((r, i) => ({
      x: Math.round(r.offset![0] * width),
      y: Math.round(r.offset![1] * height),
      width: frames[i].w,
      height: frames[i].h,
      padding: s.padding,
    })),
    uv = new Float32Array(count * 8),
    size = width * height * 4,
    textures: Lightmap['textures'] = {
      albedo: packed.image.data,
      emission: new Uint8Array(size),
      normal: new Uint8Array(size),
      orm: new Uint8Array(size),
      ao: new Uint8Array(size),
      lightmap: new Uint8Array(size),
    },
    light = new Float64Array(samples * 3),
    emitted = new Float64Array(samples * 3);
  charts.forEach((c, q) => {
    const x0 = c.x / width,
      y0 = c.y / height,
      x1 = (c.x + c.width) / width,
      y1 = (c.y + c.height) / height;
    uv.set([x0, y0, x1, y0, x1, y1, x0, y1], q * 8);
  });
  let done = 0;
  for (let q = 0; q < count; q++) {
    const f = frames[q],
      c = charts[q],
      o = q * 12;
    for (let start = 0; start < f.w * f.h; start += 256) {
      const length = Math.min(256, f.w * f.h - start),
        points = new Float32Array(length * 3),
        normals = new Float32Array(length * 3);
      for (let i = 0; i < length; i++) {
        const x = (start + i) % f.w,
          y = Math.floor((start + i) / f.w),
          u = (x + 0.5) / f.w,
          v = (y + 0.5) / f.h,
          position = [0, 1, 2].map(
            (a) =>
              positions[o + a] +
              u * (positions[o + 3 + a] - positions[o + a]) +
              v * (positions[o + 9 + a] - positions[o + a]),
          ) as MutableVec3,
          { color, emit, normal, roughness, metalness, opacity } = materialOf(
            options.surface?.({ position: [...position], normal: [...f.n], uv: [u, v], quad: q }) ?? {},
            q,
            f,
            quads,
            s.physical,
          ),
          at = ((c.y + y) * width + c.x + x) * 4,
          texel = done + i;
        textures.albedo.set([srgbByte(color[0]), srgbByte(color[1]), srgbByte(color[2]), byte(opacity)], at);
        textures.normal.set(
          [
            byte(dot(normal, f.t) * 0.5 + 0.5),
            byte(dot(normal, f.b) * 0.5 + 0.5),
            byte(dot(normal, f.n) * 0.5 + 0.5),
            255,
          ],
          at,
        );
        textures.orm.set([255, byte(roughness), byte(metalness), 255], at);
        textures.ao.set([255, 255, 255, 255], at);
        emitted.set(emit, texel * 3);
        plan?.texel?.(texel, q, position, normal, color, metalness);
        points.set(position, i * 3);
        normals.set(normal, i * 3);
      }
      if (lit) {
        const seed = (s.seed + done) >>> 0,
          includeFace = (face: number) => shadowQuad(face) !== q,
          direct = plan?.direct
            ? plan.direct(points, normals, lights, shadow, includeFace)
            : bakeVertexColors({ positions: points, normals }, shadow, {
                lights,
                segmentShadows: true,
                shadowFaceFilter: includeFace,
                bias: 1e-3,
                seed,
              }),
          occlusion = bakeVertexColors({ positions: points, normals }, ao, {
            ao: { strength: 1, rays: s.aoRays, distance: s.aoDistance },
            bias: 1e-3,
            seed,
          });
        for (let i = 0; i < length; i++) {
          const at = ((c.y + Math.floor((start + i) / f.w)) * width + c.x + ((start + i) % f.w)) * 4,
            open = occlusion[i * 4];
          textures.ao.set([byte(open), byte(open), byte(open)], at);
          textures.orm[at] = byte(open);
          for (let a = 0; a < 3; a++) light[(done + i) * 3 + a] = direct[i * 4 + a] * (s.physical ? 1 : open);
        }
      }
      done += length;
      options.onProgress?.(done, samples);
      await checkpoint(options.signal);
    }
  }
  await plan?.finish?.(light, emitted, s.maxRays - rays);
  // HDR light and emission are stored divided by their largest value; the scales decode them.
  let lightmapScale = 1,
    emissionScale = 1;
  for (let i = 0; i < light.length; i++) {
    if (!Number.isFinite(light[i]))
      throw new RangeError('bakeLightmap lighting overflow; lower light intensity or surface values');
    lightmapScale = Math.max(lightmapScale, light[i]);
    emissionScale = Math.max(emissionScale, emitted[i]);
  }
  let texel = 0;
  for (const c of charts)
    for (let y = 0; y < c.height; y++)
      for (let x = 0; x < c.width; x++, texel++) {
        const at = ((c.y + y) * width + c.x + x) * 4;
        for (let a = 0; a < 3; a++) {
          textures.lightmap[at + a] = byte(light[texel * 3 + a] / lightmapScale);
          textures.emission[at + a] = byte(emitted[texel * 3 + a] / emissionScale);
        }
        textures.lightmap[at + 3] = textures.emission[at + 3] = 255;
      }
  for (const plane of Object.values(textures)) fillGutters(plane, 4, charts, width);
  options.signal?.throwIfAborted();
  return {
    width,
    height,
    uv,
    charts,
    textures,
    lightmapScale,
    emissionScale,
    samples,
    rays,
    ...(s.physical ? { radiometry: 'physical' as const } : {}),
  };
}
