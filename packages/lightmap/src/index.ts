// @margoengine/lightmap: bakes lighting and material textures for quad meshes into one padded UV atlas, on the CPU.
import { type BakeLight, bakeVertexColors, MeshBVH } from '@margoengine/bvh';
import { packAtlas } from '@margoengine/materials';
import type { MutableVec2, MutableVec3 } from '@margoengine/math';

/** The quads to bake: world-space parallelograms, each its own chart. */
export interface LightmapQuads {
  /** 12 floats per quad: corners p0, p1, p2, p3 counterclockwise, with p2 = p1 + p3 - p0 (a parallelogram). */
  positions: Float32Array;
  /** Linear RGBA per quad, each 0 to 1. Default white. */
  albedo?: Float32Array;
  /** Linear RGB radiance per quad, 0 or more. Default black. */
  emission?: Float32Array;
  /** Roughness and metalness per quad, each 0 to 1. Default 0.5 and 0. */
  roughnessMetalness?: Float32Array;
}

/** A texel centre handed to {@link LightmapOptions.surface}, in the same world space as the quads. */
export interface LightmapTexel {
  position: MutableVec3;
  /** The quad's unit normal. */
  normal: MutableVec3;
  /** Position inside the quad, 0 to 1 along p0 -> p1 and p0 -> p3. */
  uv: MutableVec2;
  /** Index of the quad. */
  quad: number;
}

/** Material values a {@link LightmapOptions.surface} callback returns for one texel; each overrides the quad's own. */
export interface LightmapSurface {
  /** Linear RGBA, each 0 or more. */
  albedo?: readonly number[];
  /** Linear RGB radiance, each 0 or more. */
  emission?: readonly number[];
  /** World-space shading normal; written into the normal texture in the quad's tangent frame. */
  normal?: readonly number[];
  roughness?: number;
  metalness?: number;
  /** Alpha written to the albedo texture, 0 to 1. Default the albedo's alpha. */
  opacity?: number;
}

/** Options of {@link bakeLightmap}. Every budget is checked before any texture is allocated or ray traced. */
export interface LightmapOptions {
  /** Texels per world unit along each quad edge, 0.125 to 16. Default 1. */
  texelsPerUnit?: number;
  /** Gutter texels around each chart, filled from its edge, 1 to 16. Default 2. */
  padding?: number;
  /** Largest atlas side, 8 to 2,048. Default 1,024. */
  maxAtlasSize?: number;
  /** Ambient-occlusion rays per texel, 1 to 128. Default 32. */
  aoRays?: number;
  /** Ambient-occlusion ray length in world units. Default 4. */
  aoDistance?: number;
  /** Unsigned 32-bit seed of the ray directions; the same seed gives the same textures. Default 0. */
  seed?: number;
  /** Direct lights (ambient, directional, point, spot), traced with shadows. Default none. */
  lights?: readonly BakeLight[];
  /** Most quads, 1 to 32,768. Default 32,768. */
  maxCharts?: number;
  /** Most texels, 1 to 1,048,576. Default 262,144. */
  maxSamples?: number;
  /** Most rays, 1 to 67,108,864. Default 16,777,216. */
  maxRays?: number;
  /** Most bytes of textures and working buffers, estimated, 1 to 268,435,456. Default 201,326,592. */
  maxBytes?: number;
  /** Cancels the bake (checked every 256 texels). */
  signal?: AbortSignal;
  /** Called with texels done and texels in all, every 256 texels. */
  onProgress?: (done: number, total: number) => void;
  /** Material at each texel centre, for procedural surfaces; defaults to the quad's own values. */
  surface?: (texel: LightmapTexel) => LightmapSurface;
}

/** Where one quad's texels sit in the atlas, in pixels from the top-left; the gutter lies outside this box. */
export interface LightmapChart {
  x: number;
  y: number;
  width: number;
  height: number;
  padding: number;
}

/** What {@link bakeLightmap} returns: RGBA8 textures of one atlas and the UVs that address it. */
export interface Lightmap {
  width: number;
  height: number;
  /** 8 floats per quad: the UV of p0, p1, p2, p3, origin top-left (as glTF and PNG rows). */
  uv: Float32Array;
  charts: LightmapChart[];
  textures: {
    /** sRGB albedo, alpha the opacity. */
    albedo: Uint8Array;
    /** Linear emission divided by `emissionScale`. */
    emission: Uint8Array;
    /** Tangent-space normal, 0.5-biased. */
    normal: Uint8Array;
    /** Linear occlusion, roughness, metalness (glTF ORM). */
    orm: Uint8Array;
    /** Linear ambient occlusion, grey. */
    ao: Uint8Array;
    /** Linear direct irradiance times ambient occlusion, divided by `lightmapScale`. */
    lightmap: Uint8Array;
  };
  /** Multiply the lightmap's RGB (0 to 1) by this to get irradiance; at least 1. */
  lightmapScale: number;
  /** Multiply the emission texture's RGB (0 to 1) by this to get radiance; at least 1. */
  emissionScale: number;
  /** Texels baked. */
  samples: number;
  /** Rays reserved (an upper bound of those traced). */
  rays: number;
}

interface Settings {
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

const cross = (a: readonly number[], b: readonly number[]): MutableVec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const dot = (a: readonly number[], b: readonly number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const unit = (a: readonly number[], subject: string): MutableVec3 => {
  const length = Math.hypot(a[0], a[1], a[2]);
  if (!Number.isFinite(length) || length < 1e-10)
    throw new RangeError(`bakeLightmap ${subject} is degenerate; pass nonzero finite vectors`);
  return [a[0] / length, a[1] / length, a[2] / length];
};
const byte = (v: number) => Math.round(Math.max(0, Math.min(1, v)) * 255);
const srgbByte = (v: number) => byte(v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055);
const nextTask = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

function inRange(value: number, min: number, max: number, name: string, integer = true): number {
  if (!Number.isFinite(value) || value < min || value > max || (integer && !Number.isSafeInteger(value)))
    throw new RangeError(`bakeLightmap ${name} must be ${integer ? 'an integer' : 'a number'} from ${min} to ${max}`);
  return value;
}

function settingsOf(o: LightmapOptions): Settings {
  return {
    density: inRange(o.texelsPerUnit ?? 1, 0.125, 16, 'texelsPerUnit', false),
    padding: inRange(o.padding ?? 2, 1, 16, 'padding'),
    maxAtlasSize: inRange(o.maxAtlasSize ?? 1024, 8, 2048, 'maxAtlasSize'),
    maxCharts: inRange(o.maxCharts ?? 32768, 1, 32768, 'maxCharts'),
    maxSamples: inRange(o.maxSamples ?? 262144, 1, 1048576, 'maxSamples'),
    maxRays: inRange(o.maxRays ?? 16777216, 1, 67108864, 'maxRays'),
    maxBytes: inRange(o.maxBytes ?? 201326592, 1, 268435456, 'maxBytes'),
    aoRays: inRange(o.aoRays ?? 32, 1, 128, 'aoRays'),
    aoDistance: inRange(o.aoDistance ?? 4, 0.001, 1e6, 'aoDistance', false),
    seed: inRange(o.seed ?? 0, 0, 4294967295, 'seed'),
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
      t = unit(u, 'quad edge'),
      n = unit(cross(u, v), 'quad'),
      b = unit(cross(n, t), 'quad'),
      tolerance = 1e-4 * Math.max(1, Math.hypot(u[0], u[1], u[2]), Math.hypot(v[0], v[1], v[2]));
    for (let a = 0; a < 3; a++)
      if (Math.abs(positions[o + 6 + a] - positions[o + a] - u[a] - v[a]) > tolerance)
        throw new RangeError(`bakeLightmap quad ${q} is not a parallelogram; split it into parallelograms`);
    const w = Math.max(1, Math.ceil(Math.hypot(u[0], u[1], u[2]) * s.density)),
      h = Math.max(1, Math.ceil(Math.hypot(v[0], v[1], v[2]) * s.density));
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

/** Copies each chart's edge texels outward into its gutter, in every texture. Charts never share texels. */
function fillGutters(textures: Lightmap['textures'], charts: LightmapChart[], width: number): void {
  for (const plane of Object.values(textures))
    for (const c of charts)
      for (let y = -c.padding; y < c.height + c.padding; y++)
        for (let x = -c.padding; x < c.width + c.padding; x++) {
          if (x >= 0 && x < c.width && y >= 0 && y < c.height) continue;
          const from =
              ((c.y + Math.max(0, Math.min(c.height - 1, y))) * width + c.x + Math.max(0, Math.min(c.width - 1, x))) *
              4,
            to = ((c.y + y) * width + c.x + x) * 4;
          plane.copyWithin(to, from, from + 4);
        }
}

/**
 * Bakes a quad mesh's lighting and materials into one atlas: one padded chart per quad, then at each texel centre the
 * material (albedo, emission, normal, ORM), cosine-weighted ambient occlusion and shadowed direct light, traced through
 * @margoengine/bvh. No GPU or DOM is needed. The lightmap holds direct irradiance times ambient occlusion: no indirect
 * bounces, emissive surfaces as lights, area lights or transmission. Inputs are copied before the first await; the bake
 * yields every 256 texels for `signal` and `onProgress`.
 */
export async function bakeLightmap(quads: LightmapQuads, options: LightmapOptions = {}): Promise<Lightmap> {
  options.signal?.throwIfAborted();
  const s = settingsOf(options),
    count = checkQuads(quads, s.maxCharts),
    positions = quads.positions.slice(),
    albedo = quads.albedo?.slice(),
    emission = quads.emission?.slice(),
    roughnessMetalness = quads.roughnessMetalness?.slice(),
    lights = structuredClone(options.lights ?? []),
    frames = framesOf(positions, count, s);
  let samples = 0;
  for (const f of frames) samples += f.w * f.h;
  if (samples > s.maxSamples)
    throw new RangeError(
      `bakeLightmap needs ${samples} texels, over maxSamples; lower texelsPerUnit or bake fewer quads`,
    );
  // bakeVertexColors skips rays for ambient lights and back-facing ones; reserve the upper bound.
  const rays = samples * (s.aoRays + lights.filter((l) => l.type !== 'ambient' && l.visible !== false).length);
  if (rays > s.maxRays)
    throw new RangeError(`bakeLightmap needs ${rays} rays, over maxRays; lower aoRays or texelsPerUnit`);
  const predicted = predictAtlas(frames, s.padding, s.maxAtlasSize),
    // Six RGBA textures, tiles and float scratch, the BVH, input copies, UVs and one work chunk.
    bytes = predicted.width * predicted.height * 24 + samples * 48 + positions.byteLength * 3 + count * 512 + 262144;
  if (bytes > s.maxBytes) throw new RangeError(`bakeLightmap needs about ${bytes} bytes, over maxBytes; bake less`);
  options.onProgress?.(0, samples);
  options.signal?.throwIfAborted();
  await nextTask();
  options.signal?.throwIfAborted();

  const indices = new Uint32Array(count * 6);
  for (let q = 0; q < count; q++) indices.set([q * 4, q * 4 + 1, q * 4 + 2, q * 4, q * 4 + 2, q * 4 + 3], q * 6);
  const occluders = MeshBVH.build({ positions, indices }),
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
    pixels = width * height * 4,
    textures: Lightmap['textures'] = {
      albedo: packed.image.data,
      emission: new Uint8Array(pixels),
      normal: new Uint8Array(pixels),
      orm: new Uint8Array(pixels),
      ao: new Uint8Array(pixels),
      lightmap: new Uint8Array(pixels),
    },
    light = new Float32Array(samples * 3),
    emitted = new Float32Array(samples * 3);
  charts.forEach((c, q) => {
    const x0 = c.x / width,
      y0 = c.y / height,
      x1 = (c.x + c.width) / width,
      y1 = (c.y + c.height) / height;
    uv.set([x0, y0, x1, y0, x1, y1, x0, y1], q * 8);
  });
  let done = 0,
    lightmapScale = 1,
    emissionScale = 1;
  for (let q = 0; q < count; q++) {
    const f = frames[q],
      c = charts[q],
      o = q * 12;
    for (let start = 0; start < f.w * f.h; start += 256) {
      options.signal?.throwIfAborted();
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
          texel = options.surface?.({ position: [...position], normal: [...f.n], uv: [u, v], quad: q }) ?? {},
          color = texel.albedo ?? (albedo ? [...albedo.subarray(q * 4, q * 4 + 4)] : [1, 1, 1, 1]),
          emit = texel.emission ?? (emission ? [...emission.subarray(q * 3, q * 3 + 3)] : [0, 0, 0]),
          normal = texel.normal ? unit(texel.normal, 'surface normal') : f.n;
        if (color.length !== 4 || color.some((n) => !Number.isFinite(n) || n < 0))
          throw new RangeError('bakeLightmap surface albedo must be 4 finite values of 0 or more');
        if (emit.length !== 3 || emit.some((n) => !Number.isFinite(n) || n < 0))
          throw new RangeError('bakeLightmap surface emission must be 3 finite values of 0 or more');
        const roughness = inRange(
            texel.roughness ?? roughnessMetalness?.[q * 2] ?? 0.5,
            0,
            1,
            'surface roughness',
            false,
          ),
          metalness = inRange(
            texel.metalness ?? roughnessMetalness?.[q * 2 + 1] ?? 0,
            0,
            1,
            'surface metalness',
            false,
          ),
          opacity = inRange(texel.opacity ?? color[3], 0, 1, 'surface opacity', false),
          at = ((c.y + y) * width + c.x + x) * 4;
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
        emitted.set(emit, (done + i) * 3);
        emissionScale = Math.max(emissionScale, emit[0], emit[1], emit[2]);
        points.set(position, i * 3);
        normals.set(normal, i * 3);
      }
      const seed = (s.seed + done) >>> 0,
        direct = bakeVertexColors({ positions: points, normals }, occluders, {
          lights,
          shadows: true,
          bias: 1e-3,
          seed,
        }),
        occlusion = bakeVertexColors({ positions: points, normals }, occluders, {
          ao: { strength: 1, rays: s.aoRays, distance: s.aoDistance },
          bias: 1e-3,
          seed,
        });
      for (let i = 0; i < length; i++) {
        const x = (start + i) % f.w,
          y = Math.floor((start + i) / f.w),
          at = ((c.y + y) * width + c.x + x) * 4,
          open = occlusion[i * 4];
        textures.ao.set([byte(open), byte(open), byte(open), 255], at);
        textures.orm[at] = byte(open);
        for (let a = 0; a < 3; a++) {
          const value = direct[i * 4 + a] * open;
          light[(done + i) * 3 + a] = value;
          lightmapScale = Math.max(lightmapScale, value);
        }
      }
      done += length;
      options.onProgress?.(done, samples);
      options.signal?.throwIfAborted();
      await nextTask();
      options.signal?.throwIfAborted();
    }
  }
  // HDR light and emission are stored divided by their largest value; the scales decode them.
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
  fillGutters(textures, charts, width);
  options.signal?.throwIfAborted();
  return { width, height, uv, charts, textures, lightmapScale, emissionScale, samples, rays };
}

export type { BakeLight } from '@margoengine/bvh';
