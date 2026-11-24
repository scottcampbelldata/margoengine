/// <reference lib="esnext.disposable" preserve="true" />
// Puff clouds: each cloud is a seeded set of camera-facing textured puffs inside a box, every puff of every cloud drawn
// back to front in one instanced draw. Sources (docs/clean-room.md, "Puff clouds"): W. T. Reeves 1983 (particle systems
// for fuzzy objects) and L. Westover 1991 (splatting), as M. J. Harris, "Real-Time Cloud Rendering for Games", GDC 2002
// (read in full) describes them: puffs drawn as screen-oriented splats sorted far to near with source 1, destination
// 1 - alpha blending, each lit by the light that reaches it through the puffs nearer the light (his equation 4, the
// transmittance product) and scattered toward the eye by the Rayleigh phase 3/4 (1 + cos^2). T. Lorach, "Soft
// Particles", NVIDIA 2007 (read in full): the fade against the scene depth and its symmetric contrast curve.
import type { EngineKernel } from '@margoengine/core';
import type { Engine, EnginePlugin, FrameGraph, PassContext } from '@margoengine/core/extension';
import { parseColor, type ColorInput } from '@margoengine/math/color';
import { createRandom } from '@margoengine/math/mathutils';
import { MargoError } from '@margoengine/math/errors';
import { viewMatrix } from '../../shared/view.js';
import { applyView } from '../../shared/view-rect.js';
import { checkFog, FOG_BYTES, fogWgsl, writeFog, type FogLike } from '../../shared/fog.js';
import { soft, softDepthWgsl } from './soft.js';
import { requireWebGPU } from '../../shared/require-webgpu.js';

export type { FogLike } from '../../shared/fog.js';
export type { ColorInput } from '@margoengine/math/color';
type Vec3 = readonly [number, number, number];
type Context = Extract<PassContext, { backend: 'webgpu' }>;
declare const GPUBufferUsage: { UNIFORM: number; COPY_DST: number; VERTEX: number };
declare const GPUTextureUsage: { TEXTURE_BINDING: number; COPY_DST: number };

/** RGBA8 texels, row-major from the top left, sRGB. */
export interface CloudPixels {
  width: number;
  height: number;
  data: Uint8Array | Uint8ClampedArray;
}
/** A puff texture: pixels, or an image source drawn into a canvas once (in a browser). */
export type CloudTexture =
  | CloudPixels
  | ImageData
  | ImageBitmap
  | HTMLImageElement
  | HTMLCanvasElement
  | OffscreenCanvas;

/** What `distribute` returns for one puff: its centre in the box (-1..1 on each axis) and its size (0..1). */
export interface CloudPuffPlacement {
  point: Vec3;
  /** Size as a fraction of `volume`, 0..1. Default 1. */
  volume?: number;
}

/** Options of one cloud (`Clouds.add`). Read every frame: change a field and the next frame shows it. */
export interface CloudOptions {
  /** Seed of the puff layout: the same seed gives the same cloud. Default: the cloud's number in its Clouds (1, 2, ...). */
  seed?: number;
  /** Number of puffs, an integer 0 or more. Default 20. */
  segments?: number;
  /** Size of the box the puff centres lie in, local units, centred on the cloud. Default [5, 1, 1]. */
  bounds?: Vec3;
  /** 'inside' makes puffs smaller toward the box edges, 'outside' larger, 'random' any size. Default 'inside'. */
  concentrate?: 'inside' | 'outside' | 'random';
  /** Width of a full-size puff, local units, 0 or more. Default 6. */
  volume?: number;
  /** Smallest puff as a fraction of `volume`, 0..1. Default 0.25. */
  smallestVolume?: number;
  /**
   * Places puff `index` itself (overrides `bounds`' layout, `concentrate`, `volume`'s fraction and `smallestVolume`):
   * return its centre in -1..1 box units and its size fraction. `random` is the cloud's seeded stream. Default null.
   */
  distribute?: ((index: number, random: () => number) => CloudPuffPlacement) | null;
  /** With `speed` above 0 each puff breathes by up to 1 / growth of its size. Above 0. Default 4. */
  growth?: number;
  /** Animation rate: puffs turn at up to `speed` radians a second and breathe at `speed` radians of phase a second. Default 0. */
  speed?: number;
  /** Camera distance (world units) under which a puff fades out, to nothing at the camera; 0 turns it off. Default 10. */
  fade?: number;
  /** Opacity, 0..1. Default 1. */
  opacity?: number;
  /** Colour: hex is sRGB, an [r, g, b] array linear. Default white. */
  color?: ColorInput;
}

/** Options of {@link Clouds}. Read every frame except `limit`, which sizes the instance buffer when it changes. */
export interface CloudsOptions {
  /** Most puffs drawn, over all clouds (later puffs are left out and counted in `stats.dropped`). Integer 1 or more. Default 200. */
  limit?: number;
  /** Draw only the first `range` puffs, in the order clouds were added. Default: all. */
  range?: number;
  /** Puff texture; its alpha is the puff's coverage. Default: a generated soft, lumpy puff. */
  texture?: CloudTexture | null;
  /** Leave out puffs wholly outside the view. Default true. */
  frustumCulled?: boolean;
  /**
   * 'scatter' (default) lights each puff by the light that reaches it through the other puffs of its cloud and the
   * phase toward the eye, plus `ambient`; 'unlit' draws the colour as it is.
   */
  shading?: 'scatter' | 'unlit';
  /** Direction toward the light, world space, not zero. Default [0.4, 1, 0.3]. */
  lightDirection?: Vec3;
  /** Light colour, linear RGB or sRGB hex. Default white. */
  lightColor?: ColorInput;
  /** Light every puff gets whatever is in front of it, 0 or more. Default 0.55. */
  ambient?: number;
  /** Optical depth through the centre of a full-size puff, for the light reaching the puffs behind it, 0 or more. Default 1. */
  density?: number;
  /** World units over which a puff fades out in front of the surface behind it (needs `depth`); 0 is off. Default 0. */
  softness?: number;
  /**
   * The scene depth for `softness`: a function returning a sampleable reversed-Z depth texture the size of the drawing
   * buffer, e.g. `() => depthTexture.texture` with `DepthTexture` from `@margoengine/post/depth`.
   */
  depth?: () => GPUTexture | undefined;
}

/** One puff as drawn this frame (world space), from {@link Clouds.puffs}. */
export interface CloudPuff {
  cloud: Cloud;
  centre: [number, number, number];
  /** Quad width, world units. */
  size: number;
  /** Screen-plane rotation, radians. */
  angle: number;
  /** Share of the light that reaches the puff, 0..1. */
  light: number;
  /** Linear RGB and opacity (before the near fade). */
  color: [number, number, number, number];
  /** The cloud's `fade`. */
  fade: number;
}

/** Counts of the last drawn frame. */
export interface CloudsStats {
  /** Puffs of every cloud. */
  puffs: number;
  /** Puffs past `limit` or `range`. */
  dropped: number;
  /** Puffs outside the view. */
  culled: number;
  /** Puffs drawn. */
  drawn: number;
}

const FLOATS = 12; // centre xyz + size, colour rgb + alpha, angle, light, fade, 0
const UNIFORM_FLOATS = 36;
let nextId = 0;

const fail = (message: string): never => {
  throw new RangeError(message);
};
const number = (value: unknown, fallback: number, label: string, min: number, max = Infinity): number => {
  const v = value === undefined ? fallback : value;
  if (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > max)
    fail(`${label} is ${String(v)}; pass a finite number from ${min} to ${max}`);
  return v as number;
};
const vector = (value: Vec3 | undefined, fallback: Vec3, label: string): Vec3 => {
  const v = value ?? fallback;
  if (!Array.isArray(v) || v.length !== 3 || !v.every((x) => typeof x === 'number' && Number.isFinite(x)))
    throw new TypeError(`${label} must be three finite numbers; pass [x, y, z]`);
  return v;
};

/** One cloud of a {@link Clouds}: its options and world matrix. */
export class Cloud {
  /** Read every frame. */
  readonly options: CloudOptions;
  /** Column-major world matrix of the cloud (position, rotation and scale). Write it any time. */
  readonly matrix = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
  /** @internal */ layout: Float32Array = new Float32Array(0);
  /** @internal */ key = '';
  /** @internal */ distribute: CloudOptions['distribute'] = null;
  /** @internal */ readonly number: number;
  /** @internal */ owner: Clouds | null;

  /** @internal */
  constructor(owner: Clouds, number: number, options: CloudOptions) {
    this.owner = owner;
    this.number = number;
    this.options = options;
  }
  /** Takes the cloud out of its Clouds. */
  remove(): void {
    this.owner?.remove(this);
  }
  /** @internal Checks the options and lays the puffs out again when a layout option changed. */
  update(): void {
    const o = this.options,
      segments = number(o.segments, 20, 'Cloud segments', 0, 1 << 20),
      bounds = vector(o.bounds, [5, 1, 1], 'Cloud bounds'),
      concentrate = o.concentrate ?? 'inside',
      volume = number(o.volume, 6, 'Cloud volume', 0),
      smallest = number(o.smallestVolume, 0.25, 'Cloud smallestVolume', 0, 1),
      seed = number(o.seed, this.number, 'Cloud seed', -Infinity);
    if (!Number.isInteger(segments)) fail(`Cloud segments is ${segments}; pass a whole number`);
    if (!['inside', 'outside', 'random'].includes(concentrate))
      fail(`Cloud concentrate is ${String(concentrate)}; pass 'inside', 'outside' or 'random'`);
    if (bounds.some((b) => b < 0)) fail('Cloud bounds has a negative size; pass sizes of 0 or more');
    const distribute = o.distribute ?? null;
    if (distribute !== null && typeof distribute !== 'function')
      throw new TypeError('Cloud distribute must be a function or null; pass (index, random) => ({point, volume})');
    const key = [segments, bounds.join(), concentrate, volume, smallest, seed].join('|');
    if (key === this.key && distribute === this.distribute) return;
    this.key = key;
    this.distribute = distribute;
    this.layout = layoutPuffs(segments, bounds, concentrate, volume, smallest, seed, distribute);
  }
}

/**
 * The puffs of one cloud in its local space, 6 floats each: centre xyz, size, start angle, phase. Puff centres are
 * uniform in the box; the size fraction follows `concentrate` and never drops under `smallestVolume`.
 */
export function layoutPuffs(
  segments: number,
  bounds: Vec3,
  concentrate: 'inside' | 'outside' | 'random',
  volume: number,
  smallestVolume: number,
  seed: number,
  distribute: CloudOptions['distribute'] = null,
): Float32Array {
  const random = createRandom(seed),
    out = new Float32Array(segments * 6);
  for (let i = 0; i < segments; i++) {
    let x = random() * 2 - 1,
      y = random() * 2 - 1,
      z = random() * 2 - 1,
      size = random();
    const angle = random() * Math.PI * 2,
      phase = random() * 2 - 1;
    if (distribute) {
      const placed = distribute(i, random);
      const p = vector(placed?.point, [0, 0, 0], 'Cloud distribute point');
      [x, y, z] = p;
      size = number(placed.volume, 1, 'Cloud distribute volume', 0, 1);
    } else {
      const edge = Math.max(Math.abs(x), Math.abs(y), Math.abs(z));
      size = Math.max(smallestVolume, concentrate === 'inside' ? 1 - edge : concentrate === 'outside' ? edge : size);
    }
    out.set([(x * bounds[0]) / 2, (y * bounds[1]) / 2, (z * bounds[2]) / 2, size * volume, angle, phase], i * 6);
  }
  return out;
}

/** A soft, lumpy puff: a smooth radial falloff times value-noise octaves, white, alpha the coverage. */
export function defaultPuffTexture(size = 128): CloudPixels {
  const data = new Uint8Array(size * size * 4),
    random = createRandom(7),
    grid = 16,
    lattice = new Float32Array(grid * grid);
  for (let i = 0; i < lattice.length; i++) lattice[i] = random();
  const smooth = (t: number) => t * t * (3 - 2 * t),
    noise = (u: number, v: number) => {
      const x = Math.floor(u),
        y = Math.floor(v),
        fx = smooth(u - x),
        fy = smooth(v - y),
        at = (i: number, j: number) => lattice[(((j % grid) + grid) % grid) * grid + (((i % grid) + grid) % grid)];
      const a = at(x, y) + (at(x + 1, y) - at(x, y)) * fx,
        b = at(x, y + 1) + (at(x + 1, y + 1) - at(x, y + 1)) * fx;
      return a + (b - a) * fy;
    };
  for (let j = 0; j < size; j++)
    for (let i = 0; i < size; i++) {
      const u = ((i + 0.5) / size) * 2 - 1,
        v = ((j + 0.5) / size) * 2 - 1,
        r = Math.hypot(u, v);
      let fbm = 0;
      for (let octave = 0, amplitude = 0.5, frequency = 4; octave < 4; octave++, amplitude /= 2, frequency *= 2)
        fbm += amplitude * noise(((i + 0.5) / size) * frequency, ((j + 0.5) / size) * frequency);
      const falloff = r >= 1 ? 0 : (1 - r * r) ** 2,
        alpha = Math.min(1, falloff * (0.55 + 0.9 * fbm));
      const k = (j * size + i) * 4;
      data[k] = data[k + 1] = data[k + 2] = 255;
      data[k + 3] = Math.round(alpha * 255);
    }
  return { width: size, height: size, data };
}

function pixelsOf(texture: CloudTexture): CloudPixels {
  if ('data' in texture && texture.data) {
    const { width, height, data } = texture as CloudPixels;
    if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width > 4096 || height > 4096)
      fail(`Clouds texture is ${width} x ${height}; pass whole sizes from 1 to 4096`);
    if (data.length !== width * height * 4)
      fail(`Clouds texture data has ${data.length} bytes for ${width} x ${height}; pass width * height * 4 RGBA bytes`);
    return { width, height, data };
  }
  const source = texture as Exclude<CloudTexture, CloudPixels | ImageData>,
    width = (source as HTMLImageElement).naturalWidth || source.width,
    height = (source as HTMLImageElement).naturalHeight || source.height;
  if (typeof OffscreenCanvas !== 'function')
    throw new MargoError('unsupported', 'Clouds texture image sources need OffscreenCanvas; pass {width, height, data}');
  const canvas = new OffscreenCanvas(width, height),
    context = canvas.getContext('2d')!;
  context.drawImage(source as CanvasImageSource, 0, 0);
  return pixelsOf(context.getImageData(0, 0, width, height));
}

// sRGB byte <-> linear, for mips filtered in linear light (IEC 61966-2-1).
const toLinear = new Float32Array(256).map((_, i) => {
  const c = i / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
});
const toByte = (c: number) =>
  Math.round(255 * (c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055));
/** The mip chain of `pixels`, each level a 2 x 2 box filter of the one above (colour in linear light). */
function mipChain(pixels: CloudPixels): CloudPixels[] {
  const levels = [pixels];
  for (let p = pixels; p.width > 1 || p.height > 1; ) {
    const w = Math.max(1, p.width >> 1),
      h = Math.max(1, p.height >> 1),
      data = new Uint8Array(w * h * 4);
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const sum = [0, 0, 0, 0];
        for (let dy = 0; dy < 2; dy++)
          for (let dx = 0; dx < 2; dx++) {
            const k = (Math.min(y * 2 + dy, p.height - 1) * p.width + Math.min(x * 2 + dx, p.width - 1)) * 4;
            for (let c = 0; c < 3; c++) sum[c] += toLinear[p.data[k + c]];
            sum[3] += p.data[k + 3];
          }
        const k = (y * w + x) * 4;
        for (let c = 0; c < 3; c++) data[k + c] = toByte(sum[c] / 4);
        data[k + 3] = Math.round(sum[3] / 4);
      }
    levels.push((p = { width: w, height: h, data }));
  }
  return levels;
}

const shader = (samples: number, fogged: boolean, encode: boolean) => /* wgsl */ `
struct Frame {camera:mat4x4f,right:vec4f,up:vec4f,eye:vec4f,light:vec4f,lightColor:vec4f}
@group(0) @binding(0) var<uniform> frame:Frame;
@group(0) @binding(1) var puffTexture:texture_2d<f32>;
@group(0) @binding(2) var puffSampler:sampler;
${samples ? softDepthWgsl(samples) : ''}${fogged ? fogWgsl(0, 5) : ''}
struct Out {@builtin(position) clip:vec4f,@location(0) uv:vec2f,@location(1) color:vec4f,@location(2) world:vec3f,@location(3) viewDepth:f32}
@vertex fn vertex(@builtin(vertex_index) v:u32,@location(0) centre:vec4f,@location(1) tint:vec4f,@location(2) extra:vec4f)->Out {
  let corner=vec2f(f32(v&1u),f32(v>>1u))*2.0-1.0;
  let c=cos(extra.x);let s=sin(extra.x);
  let r=vec2f(c*corner.x-s*corner.y,s*corner.x+c*corner.y)*(centre.w*0.5);
  let world=centre.xyz+frame.right.xyz*r.x+frame.up.xyz*r.y;
  var o:Out;
  o.clip=frame.camera*vec4f(world,1);
  o.uv=vec2f(corner.x*0.5+0.5,0.5-corner.y*0.5);
  o.world=world;
  ${samples ? 'o.viewDepth=dot(soft.plane.xyz,world)+soft.plane.w;' : 'o.viewDepth=0.0;'}
  let toPuff=centre.xyz-frame.eye.xyz;let distance=length(toPuff);
  // Near fade: smoothstep from nothing at the camera to full at the cloud's fade distance.
  let near=select(1.0,smoothstep(0.0,extra.z,distance),extra.z>0.0);
  // Rayleigh phase 3/4 (1 + cos^2) between the view ray and the light (Harris 2002, section 2.1).
  let cosine=select(0.0,dot(toPuff/max(distance,1e-6),frame.light.xyz),distance>0.0);
  let lit=vec3f(frame.light.w)+frame.lightColor.rgb*(extra.y*0.75*(1.0+cosine*cosine));
  o.color=vec4f(tint.rgb*select(vec3f(1.0),lit,frame.lightColor.w>0.5),tint.a*near);
  return o;
}
${
  samples
    ? `// Lorach 2007: the symmetric contrast curve 0.5 (2x)^2 below 0.5, mirrored above, keeps the fade smooth at both ends.
fn contrast(x:f32)->f32 {let y=0.5*pow(2.0*select(x,1.0-x,x>0.5),2.0);return select(y,1.0-y,x>0.5);}`
    : ''
}
fn encodeSrgb(c:vec3f)->vec3f {return select(1.055*pow(c,vec3f(1.0/2.4))-0.055,c*12.92,c<=vec3f(0.0031308));}
@fragment fn fragment(i:Out)->@location(0) vec4f {
  let t=textureSample(puffTexture,puffSampler,i.uv);
  var a=t.a*i.color.a;
  ${samples ? 'a*=contrast(clamp(softGap(i.clip,i.viewDepth),0.0,1.0));' : ''}
  var rgb=i.color.rgb*t.rgb;
  ${fogged ? 'rgb=mix(rgb,margoFog.color.rgb,fogAmount(i.world));' : ''}
  ${encode ? 'rgb=encodeSrgb(max(rgb,vec3f(0.0)));' : ''}
  return vec4f(rgb*a,a);
}
`;

/**
 * drei's Clouds and Cloud for Margo: puff clouds, every puff of every cloud drawn back to front in one instanced draw
 * (frame-graph order 6, with the other transparent billboards). Puffs are camera-facing quads of a soft texture, laid
 * out by seed in each cloud's box, turned and breathing with `speed`, fading out near the camera, lit by the light that
 * reaches them through the puffs between them and the light, optionally soft against the scene depth and fogged.
 * WebGPU and the WebGL2 compatibility layer.
 */
export class Clouds implements EnginePlugin {
  readonly name = 'clouds:' + nextId++;
  /** Read every frame (`limit` reallocates when it changes). */
  readonly options: CloudsOptions;
  /** Counts of the last drawn frame. */
  readonly stats: CloudsStats = { puffs: 0, dropped: 0, culled: 0, drawn: 0 };
  private readonly list: Cloud[] = [];
  private added = 0;
  private seconds = 0;
  private engine?: Engine;
  private instances?: GPUBuffer;
  private capacity = 0;
  private uniform?: GPUBuffer;
  private fogBuffer?: GPUBuffer;
  private texture?: GPUTexture;
  private textureSource: CloudTexture | null | undefined = undefined;
  private sampler?: GPUSampler;
  private owned: { destroy(): void }[] = [];
  private softRuntime?: ReturnType<NonNullable<typeof soft>['create']>;
  private readonly pipelines = new Map<string, GPURenderPipeline>();
  private readonly groups = new Map<GPURenderPipeline, GPUBindGroup>();
  private fogSource: FogLike | null = null;
  private readonly fogData = new Float32Array(FOG_BYTES / 4);
  private readonly values = new Float32Array(UNIFORM_FLOATS);
  private readonly view = new Float32Array(16);
  private data = new Float32Array(0);
  private disposed = false;
  private readonly attachment: GPURenderPassColorAttachment = { view: undefined!, loadOp: 'load', storeOp: 'store' };
  private readonly depthAttachment: GPURenderPassDepthStencilAttachment = { view: undefined!, depthReadOnly: true };

  constructor(options: CloudsOptions = {}) {
    this.options = options;
    this.validate();
  }
  /** Same as `engine.use(new Clouds(options))`; returns it. */
  static attach(engine: EngineKernel, options: CloudsOptions = {}): Clouds {
    const clouds = new Clouds(options);
    engine.use(clouds);
    return clouds;
  }
  /** The clouds, in the order they were added. */
  get clouds(): readonly Cloud[] {
    return this.list;
  }
  /** Seconds on the clouds' clock: the sum of frame deltas (and `advanceTime` calls). */
  get time(): number {
    return this.seconds;
  }
  /** Adds a cloud and returns it; its options are read every frame. */
  add(options: CloudOptions = {}): Cloud {
    if (this.disposed) throw new MargoError('disposed', 'Clouds is disposed; create a new Clouds');
    const cloud = new Cloud(this, ++this.added, options);
    cloud.update();
    this.list.push(cloud);
    return cloud;
  }
  /** Takes `cloud` out; returns false when it is not one of these. */
  remove(cloud: Cloud): boolean {
    const at = this.list.indexOf(cloud);
    if (at < 0) return false;
    this.list.splice(at, 1);
    cloud.owner = null;
    return true;
  }
  /** Moves the clock by `delta` seconds; the same deltas give the same animation. */
  advanceTime(delta: number): void {
    if (delta > 0) this.seconds += delta;
  }
  onPreUpdate(delta: number): void {
    this.advanceTime(delta);
  }
  /** The fog the puffs are drawn in (see `setFog`), or null. */
  get fog(): FogLike | null {
    return this.fogSource;
  }
  /** Fogs the puffs with `@margoengine/environment`'s `Fog` (or any object with its fields), read every frame; null for none. */
  setFog(fog: FogLike | null): this {
    this.fogSource = checkFog(fog);
    return this;
  }
  private validate(): { limit: number; range: number } {
    const o = this.options,
      limit = number(o.limit, 200, 'Clouds limit', 1, 1 << 20),
      range = o.range === undefined ? Infinity : number(o.range, 0, 'Clouds range', 0);
    if (!Number.isInteger(limit)) fail(`Clouds limit is ${limit}; pass a whole number`);
    if (range !== Infinity && !Number.isInteger(range)) fail(`Clouds range is ${range}; pass a whole number`);
    number(o.ambient, 0.55, 'Clouds ambient', 0);
    number(o.density, 1, 'Clouds density', 0);
    const softness = number(o.softness, 0, 'Clouds softness', 0);
    if (softness > 0 && typeof o.depth !== 'function')
      throw new TypeError(
        'Clouds softness needs the scene depth; pass depth: () => depthTexture.texture (DepthTexture from @margoengine/post/depth)',
      );
    const light = vector(o.lightDirection, [0.4, 1, 0.3], 'Clouds lightDirection');
    if (!Math.hypot(...light)) fail('Clouds lightDirection is zero; pass a direction toward the light');
    if (o.shading !== undefined && o.shading !== 'scatter' && o.shading !== 'unlit')
      fail(`Clouds shading is ${String(o.shading)}; pass 'scatter' or 'unlit'`);
    if (o.frustumCulled !== undefined && typeof o.frustumCulled !== 'boolean')
      throw new TypeError('Clouds frustumCulled must be true or false; pass a boolean');
    parseColor(o.lightColor ?? [1, 1, 1]);
    return { limit, range };
  }
  /**
   * Every puff at the current time, world space, in the order the clouds were added (before `range`, `limit` and
   * culling). The light term is computed for each cloud along `lightDirection` (Harris 2002, equation 4: the light
   * reaching a puff is the product of the transmittances of the puffs nearer the light, each weighted by how far the
   * puff lies off that puff's light ray).
   */
  puffs(): CloudPuff[] {
    const o = this.options,
      density = o.density ?? 1,
      direction = vector(o.lightDirection, [0.4, 1, 0.3], 'Clouds lightDirection'),
      length = Math.hypot(...direction),
      L = direction.map((x) => x / length),
      out: CloudPuff[] = [],
      t = this.seconds;
    for (const cloud of this.list) {
      cloud.update();
      const c = cloud.options,
        m = cloud.matrix,
        growth = number(c.growth, 4, 'Cloud growth', Number.MIN_VALUE),
        speed = number(c.speed, 0, 'Cloud speed', -Infinity),
        fade = number(c.fade, 10, 'Cloud fade', 0),
        opacity = number(c.opacity, 1, 'Cloud opacity', 0, 1),
        rgb = parseColor(c.color ?? [1, 1, 1]) as number[],
        // A puff's size follows the cloud's mean axis scale.
        scale =
          (Math.hypot(m[0], m[1], m[2]) + Math.hypot(m[4], m[5], m[6]) + Math.hypot(m[8], m[9], m[10])) / 3,
        layout = cloud.layout,
        first = out.length;
      for (let i = 0; i < layout.length; i += 6) {
        const x = layout[i],
          y = layout[i + 1],
          z = layout[i + 2],
          phase = layout[i + 5],
          breathe = speed ? Math.sin(phase * Math.PI + speed * t) / growth : 0;
        out.push({
          cloud,
          centre: [
            m[0] * x + m[4] * y + m[8] * z + m[12],
            m[1] * x + m[5] * y + m[9] * z + m[13],
            m[2] * x + m[6] * y + m[10] * z + m[14],
          ],
          size: layout[i + 3] * scale * (1 + breathe),
          angle: layout[i + 4] + phase * speed * t,
          light: 1,
          color: [rgb[0], rgb[1], rgb[2], opacity],
          fade,
        });
      }
      // Light through the cloud: puff j shades puff k when j is nearer the light; the optical depth falls off as a
      // Gaussian of k's distance from j's light ray, in units of j's radius.
      for (let k = first; k < out.length; k++) {
        const pk = out[k].centre;
        let depth = 0;
        for (let j = first; j < out.length; j++) {
          if (j === k) continue;
          const pj = out[j].centre,
            d = [pj[0] - pk[0], pj[1] - pk[1], pj[2] - pk[2]],
            along = d[0] * L[0] + d[1] * L[1] + d[2] * L[2];
          if (along <= 0) continue;
          const radius = out[j].size / 2;
          if (!(radius > 0)) continue;
          const off = d[0] * d[0] + d[1] * d[1] + d[2] * d[2] - along * along;
          depth += density * Math.exp(-off / (radius * radius));
        }
        out[k].light = Math.exp(-depth);
      }
    }
    return out;
  }
  setup(engine: Engine): void {
    // One WebGPU instanced draw and no WebGL2 route: the small preview is refused here instead of drawing no clouds.
    requireWebGPU(engine, 'Clouds');
    this.engine = engine;
  }
  registerPasses(graph: FrameGraph): void {
    graph.add({
      name: this.name + ':draw',
      order: 6,
      execute: (c) => {
        if (c.backend === 'webgpu') this.draw(c as Context);
      },
    });
  }
  /** Lays the frame's puffs out in `data`, culled and sorted far to near; returns how many. */
  private collect(c: Context): number {
    const { limit, range } = this.validate(),
      all = this.puffs(),
      s = this.stats,
      eye = c.camera.position,
      v = viewMatrix(this.view, c.camera),
      fx = -v[2],
      fy = -v[6],
      fz = -v[10],
      m = c.camera.matrix,
      planes: number[][] = [];
    // Side and near planes of the view-projection (Gribb and Hartmann 2001), unit normals; z <= w is the near plane
    // under reversed Z.
    if (this.options.frustumCulled ?? true)
      for (const [sign, row] of [
        [1, 0],
        [-1, 0],
        [1, 1],
        [-1, 1],
        [-1, 2],
      ]) {
        const p = [0, 1, 2, 3].map((col) => m[col * 4 + 3] + sign * m[col * 4 + row]),
          length = Math.hypot(p[0], p[1], p[2]);
        if (length > 0) planes.push(p.map((x) => x / length));
      }
    const kept = Math.min(all.length, range, limit);
    s.puffs = all.length;
    s.dropped = all.length - kept;
    const order: { puff: CloudPuff; depth: number; index: number }[] = [];
    for (let i = 0; i < kept; i++) {
      const puff = all[i],
        [x, y, z] = puff.centre,
        reach = puff.size * Math.SQRT1_2;
      if (planes.some((p) => p[0] * x + p[1] * y + p[2] * z + p[3] < -reach)) continue;
      order.push({ puff, depth: (x - eye[0]) * fx + (y - eye[1]) * fy + (z - eye[2]) * fz, index: i });
    }
    s.culled = kept - order.length;
    // Far to near; equal depths keep the order the clouds and puffs were added in, so every run draws the same.
    order.sort((a, b) => b.depth - a.depth || a.index - b.index);
    if (this.data.length < order.length * FLOATS) this.data = new Float32Array(Math.max(limit, order.length) * FLOATS);
    const d = this.data;
    order.forEach(({ puff }, i) => {
      d.set(puff.centre, i * FLOATS);
      d[i * FLOATS + 3] = puff.size;
      d.set(puff.color, i * FLOATS + 4);
      d[i * FLOATS + 8] = puff.angle;
      d[i * FLOATS + 9] = puff.light;
      d[i * FLOATS + 10] = puff.fade;
      d[i * FLOATS + 11] = 0;
    });
    s.drawn = order.length;
    return order.length;
  }
  private textureFor(device: GPUDevice): GPUTexture {
    const source = this.options.texture ?? null;
    if (this.texture && source === this.textureSource) return this.texture;
    const levels = mipChain(source ? pixelsOf(source) : defaultPuffTexture()),
      texture = device.createTexture({
        size: [levels[0].width, levels[0].height],
        format: 'rgba8unorm-srgb',
        mipLevelCount: levels.length,
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
      });
    levels.forEach((level, mipLevel) =>
      device.queue.writeTexture(
        { texture, mipLevel },
        level.data as Uint8Array<ArrayBuffer>,
        { bytesPerRow: level.width * 4 },
        [level.width, level.height],
      ),
    );
    this.texture?.destroy();
    this.texture = texture;
    this.textureSource = source;
    this.groups.clear();
    return texture;
  }
  private draw(c: Context): void {
    if (this.disposed) return;
    const count = this.collect(c);
    if (!count) return;
    const device = c.device,
      { limit } = this.validate();
    if (!this.instances || this.capacity < Math.min(limit, count)) {
      this.instances?.destroy();
      this.capacity = Math.max(limit, count);
      this.instances = device.createBuffer({
        size: this.capacity * FLOATS * 4,
        usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
      });
    }
    device.queue.writeBuffer(this.instances, 0, this.data as Float32Array<ArrayBuffer>, 0, count * FLOATS);
    const o = this.options,
      v = this.view,
      u = this.values,
      light = vector(o.lightDirection, [0.4, 1, 0.3], 'Clouds lightDirection'),
      length = Math.hypot(...light);
    u.set(c.camera.matrix);
    for (let i = 0; i < 3; i++) {
      u[16 + i] = v[i * 4];
      u[20 + i] = v[i * 4 + 1];
      u[24 + i] = c.camera.position[i];
      u[28 + i] = light[i] / length;
    }
    u[31] = o.ambient ?? 0.55;
    parseColor(o.lightColor ?? [1, 1, 1], u, 32);
    u[35] = (o.shading ?? 'scatter') === 'scatter' ? 1 : 0;
    this.uniform ??= device.createBuffer({ size: UNIFORM_FLOATS * 4, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    device.queue.writeBuffer(this.uniform, 0, u as Float32Array<ArrayBuffer>);
    const fog = this.fogSource,
      encode = !c.format.includes('float') && !c.format.endsWith('-srgb');
    if (fog) {
      // Fog mixes in linear light here; the shader encodes the result for an 8-bit target.
      writeFog(fog, c.camera.position, this.fogData);
      this.fogBuffer ??= device.createBuffer({ size: FOG_BYTES, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
      device.queue.writeBuffer(this.fogBuffer, 0, this.fogData as Float32Array<ArrayBuffer>);
    }
    const softness = o.softness ?? 0;
    let samples = 0;
    if (softness > 0) {
      this.softRuntime ??= soft.create(device, this.owned);
      samples = this.softRuntime.write(c as never, o.depth!(), v, softness);
      if (this.softRuntime.changed) this.groups.clear();
    }
    const texture = this.textureFor(device),
      multisample = c.descriptor.multisample?.count ?? 1,
      depthFormat = c.descriptor.depthStencil!.format,
      key = [c.format, depthFormat, multisample, samples, !!fog].join(':');
    let pipeline = this.pipelines.get(key);
    if (!pipeline) {
      const module = device.createShaderModule({ code: shader(samples, !!fog, encode) });
      pipeline = device.createRenderPipeline({
        layout: 'auto',
        vertex: {
          module,
          entryPoint: 'vertex',
          buffers: [
            {
              arrayStride: FLOATS * 4,
              stepMode: 'instance',
              attributes: [0, 1, 2].map((shaderLocation) => ({
                shaderLocation,
                offset: shaderLocation * 16,
                format: 'float32x4' as const,
              })),
            },
          ],
        },
        fragment: {
          module,
          entryPoint: 'fragment',
          targets: [
            {
              format: c.format,
              // Premultiplied over (Porter and Duff 1984), source 1 and destination 1 - alpha as Harris 2002 blends.
              blend: {
                color: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' },
                alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' },
              },
            },
          ],
        },
        primitive: { topology: 'triangle-strip' },
        multisample: c.descriptor.multisample,
        depthStencil: { format: depthFormat, depthWriteEnabled: false, depthCompare: 'greater-equal' },
      });
      this.pipelines.set(key, pipeline);
    }
    let group = this.groups.get(pipeline);
    if (!group) {
      this.sampler ??= device.createSampler({
        magFilter: 'linear',
        minFilter: 'linear',
        mipmapFilter: 'linear',
      });
      group = device.createBindGroup({
        layout: pipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: this.uniform } },
          { binding: 1, resource: texture.createView() },
          { binding: 2, resource: this.sampler },
          ...(fog ? [{ binding: 5, resource: { buffer: this.fogBuffer! } }] : []),
          ...(samples ? this.softRuntime!.entries : []),
        ],
      });
      this.groups.set(pipeline, group);
    }
    this.attachment.view = c.color;
    this.depthAttachment.view = c.depth;
    this.depthAttachment.stencilReadOnly = depthFormat.includes('stencil') ? true : undefined;
    const pass = c.encoder.beginRenderPass({
      colorAttachments: [this.attachment],
      depthStencilAttachment: this.depthAttachment,
    });
    applyView(pass, c);
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, group);
    pass.setVertexBuffer(0, this.instances);
    pass.draw(4, count);
    pass.end();
    if (this.engine) this.engine.stats.drawCalls++;
  }
  private release(): void {
    for (const resource of [this.instances, this.uniform, this.fogBuffer, this.texture, ...this.owned])
      resource?.destroy();
    this.instances = this.uniform = this.fogBuffer = this.texture = this.sampler = this.softRuntime = undefined;
    this.textureSource = undefined;
    this.capacity = 0;
    this.owned = [];
    this.pipelines.clear();
    this.groups.clear();
  }
  onDeviceRestored(engine: Engine): void {
    this.release();
    this.setup(engine);
  }
  /** Releases the GPU objects and leaves the engine. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.engine?.sceneOf(this)?.removePlugin(this.name);
    this.release();
    for (const cloud of this.list) cloud.owner = null;
    this.list.length = 0;
    this.engine = undefined;
  }
  declare [Symbol.dispose]: () => void;
  [(Symbol.dispose ?? Symbol()) as symbol](): void {
    this.dispose();
  }
}
