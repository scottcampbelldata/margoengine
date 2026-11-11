import { colorLookupWGSL, colorTextureData } from './color-lookup.js';
// Volume rendering by ray marching (J. Kruger and R. Westermann, "Acceleration techniques for GPU-based volume
// rendering", IEEE Visualization 2003; front-to-back compositing with early ray termination). The data lives in a 3D
// half-float texture normalised to the colour range; a transfer function texture gives colour (from a colour map) and
// opacity per value. Each fragment of the volume's box marches its ray through the box at a fixed step with a jittered
// start (no banding), corrects opacity for the step length, lights samples by the data gradient, and stops once nearly
// opaque. Clip planes cut the volume away; `mode: 'mip'` shows the maximum along each ray instead and `mode: 'minip'` the
// minimum (minimum intensity projection, as used for airways in CT; Wallis et al., Radiology 181(1), 1991). Slices are planes
// through the volume coloured by the same map.
import { invertMatrix, multiplyMatrices } from '@margoengine/math/mat4';
import { fault, rangeError, typeError } from '../../shared/errors.js';
import { f16Bits } from '../../shared/f16.js';
import {
  extent,
  isGpuArray,
  rangeOption,
  resolveColormap,
  sizeOf,
  type Bounds,
  type ColormapSource,
  type DataSource,
} from './layer.js';
import { frameWGSL, type Drawable, type GpuContext, type SciRenderer } from './render.js';
import { volumeDepthWGSL } from './volume-depth.js';
import type { Colormap } from './colormaps.js';

declare const GPUBufferUsage: { UNIFORM: number; COPY_DST: number; STORAGE: number; COPY_SRC: number };
declare const GPUTextureUsage: { TEXTURE_BINDING: number; COPY_DST: number };
declare const GPUShaderStage: { VERTEX: number; FRAGMENT: number; COMPUTE: number };

/** A clip plane in the volume's [0, 1] box coordinates: samples with `dot(normal, p) + offset < 0` are cut away. */
export interface ClipPlane {
  readonly normal: readonly [number, number, number];
  readonly offset: number;
}

/** Options for a volume. */
export interface VolumeLayerOptions {
  /** Grid size [nx, ny, nz] (x fastest in memory). Default: a GpuArray's shape [nz, ny, nx] reversed, else a cube. */
  readonly dims?: readonly [number, number, number];
  /** Data bounds of the box: [xmin, xmax, ymin, ymax, zmin, zmax]. Default the voxel indices [0, n - 1]. */
  readonly bounds?: Bounds;
  /** Colour map. Default `'aurora'`. */
  readonly colormap?: ColormapSource;
  /** Data range the transfer function spans. Default the data's min and max (required for a GpuArray). */
  readonly range?: readonly [number, number];
  /**
   * Opacity per normalised value: `[t, alpha]` points (linear between them), or a function of t in [0, 1].
   * Default `t => t * t` (low values clear, high values solid).
   */
  readonly opacity?: readonly (readonly [number, number])[] | ((t: number) => number);
  /** Overall opacity scale; above 1 makes the volume denser. Default 1. */
  readonly density?: number;
  /**
   * `'composite'` (default) blends along the ray; `'mip'` shows the maximum value along it and `'minip'` the minimum,
   * each coloured and made opaque by the transfer function at that value (MIP also keeps the value as opacity).
   */
  readonly mode?: VolumeMode;
  /** Samples per voxel along a ray. Default 1.5. */
  readonly quality?: number;
  /** Light samples by the data gradient. Default true. */
  readonly shading?: boolean;
  /** Up to four clip planes. Default none. */
  readonly clip?: readonly ClipPlane[];
}

/** How a volume combines the samples along a ray. */
export type VolumeMode = 'composite' | 'mip' | 'minip';

const MAX_PLANES = 4;

/** A snapshotted linear-light RGBA8 classifier, supplied by the optional transfer entry. */
export interface VolumeClassification {
  /** Table width and height, each 2..2048. */
  readonly size: readonly [number, number];
  /** Unpremultiplied linear RGB and opacity, row major. */
  readonly rgba: Uint8Array;
  /** Gradient magnitude or front/back scalar classification. */
  readonly kind: 'gradient' | 'preintegrated';
  /** Maximum gradient in scalar units per data unit. Required for gradient classification. */
  readonly gradientMax?: number;
  /** Preintegration segment length in voxels. Default 1. */
  readonly step?: number;
  /** Density baked into preintegration. Default 1. */
  readonly density?: number;
  /**
   * Scalar range the table's value axes span. A preintegrated table must span the layer's `range` (the shader reads
   * it with values normalised to that range); one built over another range is refused. Default the layer's range.
   */
  readonly range?: readonly [number, number];
}

const classifyWGSL = /* wgsl */ `${colorLookupWGSL}

fn gradient(p: vec3f, dims: vec3f, spacing: vec3f) -> vec3f {
  let d = 1.0 / dims;
  let low = clamp(p - d, d * 0.5, 1.0 - d * 0.5);
  let high = clamp(p + d, d * 0.5, 1.0 - d * 0.5);
  let g = vec3f(
    textureSampleLevel(data, linearSampler, vec3f(high.x, p.y, p.z), 0.0).r - textureSampleLevel(data, linearSampler, vec3f(low.x, p.y, p.z), 0.0).r,
    textureSampleLevel(data, linearSampler, vec3f(p.x, high.y, p.z), 0.0).r - textureSampleLevel(data, linearSampler, vec3f(p.x, low.y, p.z), 0.0).r,
    textureSampleLevel(data, linearSampler, vec3f(p.x, p.y, high.z), 0.0).r - textureSampleLevel(data, linearSampler, vec3f(p.x, p.y, low.z), 0.0).r);
  return g / max((high - low) * dims, vec3f(1.0)) / spacing;
}
fn classify(v: f32, y: f32, kind: f32) -> vec4f {
  if (kind < 0.5) { return colourLookup(transfer, v); }
  let n = vec2f(textureDimensions(transfer));
  let p=clamp(vec2f(v,y),vec2f(0.0),vec2f(1.0))*(n-1.0);
  let i=vec2i(floor(p)); let j=min(i+vec2i(1),vec2i(n)-vec2i(1)); let f=fract(p);
  return mix(mix(textureLoad(transfer,i,0),textureLoad(transfer,vec2i(j.x,i.y),0),f.x),
             mix(textureLoad(transfer,vec2i(i.x,j.y),0),textureLoad(transfer,j,0),f.x),f.y);
}`;

// Plain transfer textures retain hardware filtering. Only opted-in scalar encodings
// need explicit float-table lookup. Specialize before compilation and key pipelines
// by this contract, so mixed ordinary/encoded volumes can share a renderer safely.
function volumeCode(code: string, encoded: boolean): string {
  if (encoded) return code;
  return code.replace(
    colorLookupWGSL,
    /* wgsl */ `
fn colourLookup(table:texture_2d<f32>, value:f32)->vec4f {
  return textureSampleLevel(table,linearSampler,vec2f(value,0.5),0.0);
}
`,
  );
}

/** WGSL of the volume pipeline. */
const volumeShader = /* Shader notes kept outside the uploaded source:
 * The 36 vertices of the unit box, counter-clockwise seen from outside.
 * Every face's (u, v, normal) order is left-handed toward its outward side, so the swapped quad winds
 * counter-clockwise seen from outside.
 * The ray through this pixel, from the near plane, in box coordinates.
 * At most 2048 samples: a longer ray takes wider steps, so it still reaches the far side of the box.
 * Opacity was defined per voxel; correct it for the step length (1 - (1 - a)^(step / voxel)).
 * The gradient points up the data; the surface faces the other way.
 */ /* wgsl */ `${frameWGSL}
${volumeDepthWGSL}
struct Volume { model: mat4x4f, toBox: mat4x4f, normalModel: mat4x4f, dims: vec4f, params: vec4f, planes: array<vec4f, 4>, classification: vec4f, spacing: vec4f }
@group(1) @binding(0) var<uniform> volume: Volume;
@group(1) @binding(1) var data: texture_3d<f32>;
@group(1) @binding(2) var transfer: texture_2d<f32>;
@group(1) @binding(3) var linearSampler: sampler;
${classifyWGSL}
struct Out { @builtin(position) clip: vec4f, @location(0) world: vec3f, @location(1) ndc: vec4f }
fn corner(index: u32) -> vec3f {
  let faces = array<vec3u, 6>(vec3u(0u, 1u, 2u), vec3u(0u, 2u, 1u), vec3u(1u, 2u, 0u), vec3u(1u, 0u, 2u), vec3u(2u, 0u, 1u), vec3u(2u, 1u, 0u));
  let face = index / 6u;
  let k = index % 6u;
  let quad = array<vec2f, 6>(vec2f(0.0, 0.0), vec2f(1.0, 0.0), vec2f(1.0, 1.0), vec2f(0.0, 0.0), vec2f(1.0, 1.0), vec2f(0.0, 1.0));
  let axes = faces[face];
  let side = f32(face % 2u);
  var p = vec3f(0.0);
  let uv = quad[k].yx;
  p[axes.x] = uv.x;
  p[axes.y] = uv.y;
  p[axes.z] = side;
  return p;
}
@vertex fn vertex(@builtin(vertex_index) index: u32) -> Out {
  let world = volume.model * vec4f(corner(index), 1.0);
  var out: Out;
  out.world = world.xyz;
  out.clip = frame.clip * world;
  out.ndc = out.clip;
  return out;
}
fn hash(p: vec2f) -> f32 { return fract(sin(dot(p, vec2f(12.9898, 78.233))) * 43758.5453); }
fn sample(p: vec3f) -> f32 { return textureSampleLevel(data, linearSampler, p, 0.0).r; }
fn kept(p: vec3f) -> bool {
  for (var k = 0u; k < u32(volume.dims.w); k++) {
    if (dot(volume.planes[k].xyz, p) + volume.planes[k].w < 0.0) { return false; }
  }
  return true;
}
@fragment fn fragment(in: Out) -> @location(0) vec4f {
  let ndc = in.ndc.xy / in.ndc.w;
  let nearWorld = frame.inverse * vec4f(ndc, 1.0, 1.0);
  let origin = (volume.toBox * vec4f(nearWorld.xyz / nearWorld.w, 1.0)).xyz;
  let hit = (volume.toBox * vec4f(in.world, 1.0)).xyz;
  let dir = normalize(hit - origin);
  let inv = 1.0 / dir;
  let t0 = (vec3f(0.0) - origin) * inv;
  let t1 = (vec3f(1.0) - origin) * inv;
  let enter = max(max(max(min(t0.x, t1.x), min(t0.y, t1.y)), min(t0.z, t1.z)), 0.0);
  var exit = min(min(max(t0.x, t1.x), max(t0.y, t1.y)), max(t0.z, t1.z));
  let opaque=opaquePoint(in.clip.xy,ndc);
  if(opaque.w>0.0) {
    let p=(volume.toBox*opaque).xyz; exit=min(exit,dot(p-origin,dir));
  }
  if (exit <= enter) { discard; }
  let voxel = 1.0 / max(max(volume.dims.x, volume.dims.y), volume.dims.z);
  let stride = max(voxel / volume.params.x, (exit - enter) / 2048.0);
  let count = min(u32((exit - enter) / stride) + 1u, 2048u);
  var t = enter + stride * hash(in.clip.xy);
  var colour = vec3f(0.0);
  var alpha = 0.0;
  var peak = 0.0;
  var hasPeak = false;
  let texel = 1.0 / volume.dims.xyz;
  let toEye = -normalize((volume.normalModel * vec4f(dir, 0.0)).xyz);
  for (var i = 0u; i < count; i++) {
    if(t>=exit) {break;}
    let p = origin + dir * t;
    t += stride;
    if (!kept(p)) { continue; }
    let v = sample(p);
    if (volume.params.y > 0.5) {
      if ((bitcast<u32>(v)&0x7fffffffu)<=0x7f800000u) {
        if(hasPeak){peak=select(max(peak,v),min(peak,v),volume.params.y>1.5);}else{peak=v;hasPeak=true;}
      }else if(!hasPeak){peak=v;}
      continue;
    }
    var coordinate = 0.5;
    if (volume.classification.x == 1.0) { coordinate = length(gradient(p, volume.dims.xyz, volume.spacing.xyz)) * volume.classification.y; }
    if (volume.classification.x == 2.0) { coordinate = sample(origin + dir * min(t, exit)); }
    let tf = classify(v, coordinate, volume.classification.x);
    var a = 1.0 - pow(1.0 - clamp(tf.a * volume.params.z, 0.0, 0.999), stride / voxel);
    if (volume.classification.x == 2.0) {
      a = 1.0 - pow(max(1.0 - tf.a, 0.0), stride / voxel / volume.classification.z * volume.params.z / volume.classification.w);
    }
    if (a < 0.002) { continue; }
    var rgb = tf.rgb;
    if (volume.params.w > 0.5) {
      let g = vec3f(
        sample(p + vec3f(texel.x, 0.0, 0.0)) - sample(p - vec3f(texel.x, 0.0, 0.0)),
        sample(p + vec3f(0.0, texel.y, 0.0)) - sample(p - vec3f(0.0, texel.y, 0.0)),
        sample(p + vec3f(0.0, 0.0, texel.z)) - sample(p - vec3f(0.0, 0.0, texel.z)));
      if (dot(g, g) > 1e-8) {
        let n = normalize((volume.normalModel * vec4f(-g / texel, 0.0)).xyz);
        rgb = shade(rgb, n, toEye);
      }
    }
    colour += (1.0 - alpha) * a * rgb;
    alpha += (1.0 - alpha) * a;
    if (alpha > 0.99) { break; }
  }
  if (volume.params.y > 0.5) {
    let tf = classify(peak, select(0.5, peak, volume.classification.x == 2.0), volume.classification.x);
    let shown = select(max(tf.a, peak), tf.a, volume.params.y > 1.5);
    return vec4f(toOutput(tf.rgb), clamp(shown * volume.params.z, 0.0, 1.0));
  }
  if (alpha < 0.002) { discard; }
  return vec4f(toOutput(colour / alpha), alpha);
}`;

/** WGSL of a slice: a plane through the volume at a fixed coordinate, coloured by the transfer function's colours. */
const sliceShader = /* wgsl */ `${frameWGSL}
struct Slice { model: mat4x4f, plane: vec4f, dims: vec4f, classification: vec4f, spacing: vec4f }
@group(1) @binding(0) var<uniform> slice: Slice;
@group(1) @binding(1) var data: texture_3d<f32>;
@group(1) @binding(2) var transfer: texture_2d<f32>;
@group(1) @binding(3) var linearSampler: sampler;
${classifyWGSL}
struct Out { @builtin(position) clip: vec4f, @location(0) box: vec3f }
@vertex fn vertex(@builtin(vertex_index) index: u32) -> Out {
  let quad = array<vec2f, 6>(vec2f(0.0, 0.0), vec2f(1.0, 0.0), vec2f(1.0, 1.0), vec2f(0.0, 0.0), vec2f(1.0, 1.0), vec2f(0.0, 1.0));
  let axis = u32(slice.plane.x);
  var p = vec3f(0.0);
  p[(axis + 1u) % 3u] = quad[index].x;
  p[(axis + 2u) % 3u] = quad[index].y;
  p[axis] = slice.plane.y;
  var out: Out;
  out.box = p;
  out.clip = frame.clip * (slice.model * vec4f(p, 1.0));
  return out;
}
@fragment fn fragment(in: Out) -> @location(0) vec4f {
  let v = textureSampleLevel(data, linearSampler, in.box, 0.0).r;
  var coordinate = 0.5;
  if (slice.classification.x == 1.0) { coordinate = length(gradient(in.box, slice.dims.xyz, slice.spacing.xyz)) * slice.classification.y; }
  if (slice.classification.x == 2.0) { coordinate = v; }
  let rgb = classify(v, coordinate, slice.classification.x).rgb;
  return vec4f(toOutput(rgb), slice.plane.z);
}`;

// Normalised half-float voxels for a CPU array, x fastest.
/** @internal Half-float voxels normalised from [lo, hi] to [0, 1], for the volume entries. */
export function halfVoxels(values: ArrayLike<number>, lo: number, hi: number): Uint16Array<ArrayBuffer> {
  const out = new Uint16Array(values.length),
    scale = 1 / (hi - lo);
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    out[i] = f16Bits(v === v ? Math.min(65504, Math.max(-65504, (v - lo) * scale)) : NaN);
  }
  return out;
}

// Packs a GpuArray's f32 voxels into rows of half floats padded to 256 bytes, for copyBufferToTexture.
const packShader = /* wgsl */ `struct Pack { nx: u32, rows: u32, rowWords: u32, pad: u32, lo: f32, scale: f32, pad2: vec2f }
@group(0) @binding(0) var<storage, read> src: array<f32>;
@group(0) @binding(1) var<storage, read_write> dst: array<u32>;
@group(0) @binding(2) var<uniform> pack: Pack;
@compute @workgroup_size(64) fn main(@builtin(global_invocation_id) id: vec3u) {
  let word = id.x;
  let row = id.y + id.z * 65535u;
  if (word >= pack.rowWords || row >= pack.rows) { return; }
  let i = word * 2u;
  var pair = vec2f(0.0);
  for (var k = 0u; k < 2u; k++) {
    if (i + k < pack.nx) {
      let v = src[row * pack.nx + i + k];
      if((bitcast<u32>(v)&0x7fffffffu)>0x7f800000u){pair[k]=v;}
      else{pair[k]=clamp((v - pack.lo) * pack.scale, -65504.0, 65504.0);}
    }
  }
  dst[row * pack.rowWords + word] = pack2x16float(pair);
}`;

/** The transfer function as 256 RGBA bytes (sRGB colour from the map, opacity from the curve). */
export function transferTable(map: Colormap, opacity: VolumeLayerOptions['opacity']): Uint8Array<ArrayBuffer> {
  const curve =
    typeof opacity === 'function'
      ? opacity
      : opacity
        ? (t: number) => {
            const points = [...opacity].sort((a, b) => a[0] - b[0]);
            if (t <= points[0][0]) return points[0][1];
            for (let k = 1; k < points.length; k++)
              if (t <= points[k][0]) {
                const [t0, a0] = points[k - 1],
                  [t1, a1] = points[k];
                return a0 + ((a1 - a0) * (t - t0)) / (t1 - t0 || 1);
              }
            return points[points.length - 1][1];
          }
        : (t: number) => t * t;
  const table = map.table(256),
    bytes = new Uint8Array(1024);
  for (let k = 0; k < 256; k++) {
    for (let c = 0; c < 3; c++) bytes[k * 4 + c] = Math.round(table[k * 4 + c] * 255);
    const a = curve(k / 255);
    if (!Number.isFinite(a))
      throw rangeError(`Volume opacity at ${k / 255} is ${a}; return numbers in [0, 1]`, 'sciviz');
    bytes[k * 4 + 3] = Math.round(Math.min(1, Math.max(0, a)) * 255);
  }
  return bytes;
}

/** A volume layer. Create it with `figure.volume(data, options)`. */
export class VolumeLayer implements Drawable {
  /** Scalar source in data units, borrowed on CPU or read from the GPU. No transfer-function conversion. */
  async readValues(options: { readonly signal?: AbortSignal } = {}): Promise<ArrayLike<number>> {
    options.signal?.throwIfAborted();
    if (this.#disposed) throw fault('disposed', 'Volume disposed; read values before disposal', 'sciviz');
    const values = isGpuArray(this.#data) ? await this.#data.read(options) : this.#data;
    options.signal?.throwIfAborted();
    return values;
  }
  /** @internal Inventory for the optional monitor entry. */
  get memoryResources(): import('./resources.js').LayerResources {
    return {
      children: this.#disposed ? [] : [...this.#slices],
      cpu: [
        isGpuArray(this.#data) ? undefined : this.#data,
        this.#values,
        this.#table,
        this.#classification?.rgba,
        this.#model,
        this.#figure,
      ],
      gpu: this.#disposed
        ? []
        : [
            this.#uniform,
            ...(this.#texture ? [{ texture: this.#texture, bytesPerTexel: 2 }] : []),
            ...(this.#transfer
              ? [{ texture: this.#transfer, bytesPerTexel: !this.#classification && this.colormap.encoding ? 16 : 4 }]
              : []),
          ],
    };
  }
  /** False hides the layer. */
  visible = true;
  /** Blended over opaque layers. */
  readonly transparent = true;
  /** @internal */
  readonly needsSceneDepth = true;
  /** Grid size [nx, ny, nz]. */
  readonly dims: readonly [number, number, number];
  /** Data bounds of the box. */
  readonly bounds: Bounds;
  /** Data range of the transfer function. */
  readonly range: readonly [number, number];
  /** The colour map. */
  readonly colormap: Colormap;
  /** `'composite'`, `'mip'` or `'minip'`. */
  mode: VolumeMode;
  /** Overall opacity scale. */
  density: number;
  /** Samples per voxel along a ray. */
  quality: number;
  /** Gradient lighting. */
  shading: boolean;
  #clip: ClipPlane[];
  readonly #renderer: SciRenderer;
  readonly #data: DataSource;
  #texture: GPUTexture | undefined;
  #transfer: GPUTexture | undefined;
  #sampler: GPUSampler | undefined;
  #uniform: GPUBuffer | undefined;
  #layout: GPUBindGroupLayout | undefined;
  #group: GPUBindGroup | undefined;
  readonly #opacity: VolumeLayerOptions['opacity'];
  readonly #values = new Float32Array(80);
  readonly #toBox = this.#values.subarray(16, 32);
  readonly #normal = this.#values.subarray(32, 48);
  #classification: VolumeClassification | undefined;
  #table = new Uint8Array(0);
  #model = new Float32Array(16);
  #figure: Float32Array = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
  readonly #slices = new Set<SliceLayer>();
  #disposed = false;

  /** @internal Use `figure.volume()`. */
  constructor(renderer: SciRenderer, data: DataSource, options: VolumeLayerOptions = {}) {
    this.#renderer = renderer;
    this.#data = data;
    const size = sizeOf(data),
      shape = isGpuArray(data) ? data.shape : undefined;
    const side = Math.round(Math.cbrt(size));
    const dims = options.dims ?? (shape?.length === 3 ? [shape[2], shape[1], shape[0]] : [side, side, side]);
    if (dims.some((d) => !Number.isInteger(d) || d < 2))
      throw rangeError(
        `Volume dims [${dims.join(', ')}] need an integer of at least 2 samples on each axis; a single slice is an image, use a 2D figure.heatmap(values, { nx, ny })`,
        'sciviz',
      );
    if (dims[0] * dims[1] * dims[2] !== size)
      throw rangeError(
        `Volume dims [${dims.join(', ')}] do not hold ${size} values; pass dims: [nx, ny, nz]`,
        'sciviz',
      );
    const max = renderer.device!.limits.maxTextureDimension3D;
    if (dims.some((d) => d > max))
      throw rangeError(
        `Volume dims [${dims.join(', ')}] exceed this GPU's 3D texture limit of ${max}; draw it with brickedVolume from @margoengine/sciviz/bricks`,
        'sciviz',
      );
    this.dims = [dims[0], dims[1], dims[2]];
    this.bounds = options.bounds ? ([...options.bounds] as Bounds) : [0, dims[0] - 1, 0, dims[1] - 1, 0, dims[2] - 1];
    const given = rangeOption(options.range, 'Volume range');
    if (!given && isGpuArray(data))
      throw typeError('A GpuArray volume needs range: [min, max] (read it with data.min().item())', 'sciviz');
    let range = given ?? extent(data as ArrayLike<number>);
    if (range[0] === range[1]) range = [range[0] - 0.5, range[1] + 0.5];
    this.range = range;
    this.colormap = resolveColormap(options.colormap);
    this.#opacity = options.opacity;
    this.mode = options.mode ?? 'composite';
    if (this.mode !== 'composite' && this.mode !== 'mip' && this.mode !== 'minip')
      throw typeError(`Volume mode must be 'composite', 'mip' or 'minip', got ${String(this.mode)}`, 'sciviz');
    this.density = options.density ?? 1;
    this.quality = options.quality ?? 1.5;
    this.shading = options.shading ?? true;
    if (!(this.density > 0) || !(this.quality > 0))
      throw rangeError('Volume density and quality must be positive', 'sciviz');
    this.#clip = this.#checkClip(options.clip ?? []);
    this.#build();
  }

  #checkClip(planes: readonly ClipPlane[]): ClipPlane[] {
    if (planes.length > MAX_PLANES)
      throw rangeError(`A volume takes at most ${MAX_PLANES} clip planes, got ${planes.length}`, 'sciviz');
    for (const p of planes)
      if (!p || p.normal?.length !== 3 || ![...p.normal, p.offset].every(Number.isFinite))
        throw typeError('A clip plane is { normal: [x, y, z], offset } with finite numbers', 'sciviz');
    return [...planes];
  }

  /** The clip planes (box coordinates). Assign to change them. */
  get clip(): readonly ClipPlane[] {
    return this.#clip;
  }
  set clip(planes: readonly ClipPlane[]) {
    this.#clip = this.#checkClip(planes);
  }

  #build(): void {
    const device = this.#renderer.device!,
      [nx, ny, nz] = this.dims;
    this.#texture = device.createTexture({
      size: [nx, ny, nz],
      dimension: '3d',
      format: 'r16float',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    const [lo, hi] = this.range;
    if (isGpuArray(this.#data)) this.#uploadGpu(device, lo, hi);
    else
      device.queue.writeTexture(
        { texture: this.#texture },
        halfVoxels(this.#data, lo, hi),
        { bytesPerRow: nx * 2, rowsPerImage: ny },
        [nx, ny, nz],
      );
    const classification = this.#classification,
      size = classification?.size ?? [256, this.colormap.encoding ? 4 : 1];
    this.#transfer = device.createTexture({
      size: [...size],
      format: classification ? 'rgba8unorm' : this.colormap.encoding ? 'rgba32float' : 'rgba8unorm-srgb',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    this.#table = new Uint8Array(classification?.rgba ?? transferTable(this.colormap, this.#opacity));
    const pixels =
      !classification && this.colormap.encoding ? colorTextureData(this.colormap, this.#table) : this.#table;
    device.queue.writeTexture(
      { texture: this.#transfer },
      pixels,
      { bytesPerRow: size[0] * pixels.BYTES_PER_ELEMENT * 4 },
      size,
    );
    this.#sampler = device.createSampler({
      magFilter: 'linear',
      minFilter: 'linear',
      addressModeU: 'clamp-to-edge',
      addressModeV: 'clamp-to-edge',
      addressModeW: 'clamp-to-edge',
    });
    this.#uniform = device.createBuffer({
      size: this.#values.byteLength,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this.#layout = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
        {
          binding: 1,
          visibility: GPUShaderStage.FRAGMENT | GPUShaderStage.VERTEX,
          texture: { sampleType: 'float', viewDimension: '3d' },
        },
        {
          binding: 2,
          visibility: GPUShaderStage.FRAGMENT,
          texture: { sampleType: this.colormap.encoding ? 'unfilterable-float' : 'float' },
        },
        { binding: 3, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
      ],
    });
    this.#bind();
  }

  #bind(): void {
    this.#group = this.#renderer.device!.createBindGroup({
      layout: this.#layout!,
      entries: [
        { binding: 0, resource: { buffer: this.#uniform! } },
        { binding: 1, resource: this.#texture!.createView({ dimension: '3d' }) },
        { binding: 2, resource: this.#transfer!.createView() },
        { binding: 3, resource: this.#sampler! },
      ],
    });
  }

  /** Owned snapshot of the custom classification, or undefined for the original map and opacity. */
  getClassification(): VolumeClassification | undefined {
    const value = this.#classification;
    return value && { ...value, size: [...value.size], rgba: new Uint8Array(value.rgba) };
  }

  /** Replace classification on an existing layer, or pass undefined to restore its original map and opacity. */
  setClassification(value?: VolumeClassification): void {
    if (this.#disposed)
      throw typeError('Volume is disposed; create a new volume before editing classification', 'sciviz');
    if (value) {
      const { size, rgba, kind } = value;
      if (
        size.length !== 2 ||
        size.some(
          (n) =>
            !Number.isInteger(n) || n < 2 || n > Math.min(2048, this.#renderer.device!.limits.maxTextureDimension2D),
        ) ||
        rgba.length !== size[0] * size[1] * 4
      )
        throw rangeError(
          'Classification needs 2..2048 texels per axis and four bytes per texel; resize the table',
          'sciviz',
        );
      if (
        !['gradient', 'preintegrated'].includes(kind) ||
        (kind === 'gradient' && !(Number.isFinite(value.gradientMax) && value.gradientMax! > 0)) ||
        ![value.step ?? 1, value.density ?? 1].every((n) => Number.isFinite(n) && n > 0)
      )
        throw rangeError(
          'Classification needs a positive gradientMax, step and density; correct the table metadata',
          'sciviz',
        );
      if (kind === 'preintegrated' && value.range && (value.range[0] !== this.range[0] || value.range[1] !== this.range[1]))
        throw rangeError(
          `Preintegrated table spans [${value.range.join(', ')}] but the volume range is [${this.range.join(', ')}]; build it with preintegrateTransfer(tf, { range: layer.range })`,
          'sciviz',
        );
      this.#classification = { ...value, size: [...size], rgba: new Uint8Array(rgba) };
    } else this.#classification = undefined;
    const size = value?.size ?? [256, this.colormap.encoding ? 4 : 1],
      device = this.#renderer.device!;
    const texture = device.createTexture({
      size: [...size],
      format: value ? 'rgba8unorm' : this.colormap.encoding ? 'rgba32float' : 'rgba8unorm-srgb',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    this.#table = new Uint8Array(this.#classification?.rgba ?? transferTable(this.colormap, this.#opacity));
    const pixels = !value && this.colormap.encoding ? colorTextureData(this.colormap, this.#table) : this.#table;
    device.queue.writeTexture({ texture }, pixels, { bytesPerRow: size[0] * pixels.BYTES_PER_ELEMENT * 4 }, size);
    this.#transfer?.destroy();
    this.#transfer = texture;
    this.#bind();
    for (const slice of this.#slices) slice.restore();
  }

  /** @internal Snapshot of the uploaded classifier for conservative optional opacity bounds. */
  classificationData(): { readonly size: readonly [number, number]; readonly rgba: Uint8Array } {
    return { size: this.#classification?.size ?? [256, 1], rgba: new Uint8Array(this.#table) };
  }

  /** @internal Classification uniforms shared with slices. */
  classificationUniforms(): readonly number[] {
    const c = this.#classification,
      b = this.bounds,
      d = this.dims;
    return [
      c ? (c.kind === 'gradient' ? 1 : 2) : 0,
      (this.range[1] - this.range[0]) / (c?.gradientMax ?? 1),
      c?.step ?? 1,
      c?.density ?? 1,
      ...d.map((n, i) => Math.abs(b[2 * i + 1] - b[2 * i]) / (n - 1)),
      0,
    ];
  }

  #uploadGpu(device: GPUDevice, lo: number, hi: number): void {
    const array = this.#data as Exclude<DataSource, ArrayLike<number>>;
    if (array.dtype !== 'f32' || !array.contiguous || array.offset)
      throw typeError("Volume GpuArray must be contiguous f32; pass data.astype('f32').eval()", 'sciviz');
    if (array.context.device !== device)
      throw typeError('Volume GpuArray must live on the engine device: createCompute({ engine })', 'sciviz');
    const [nx, ny, nz] = this.dims,
      rowBytes = Math.ceil((nx * 2) / 256) * 256,
      rowWords = rowBytes / 4,
      rows = ny * nz;
    const staging = device.createBuffer({
      size: rowBytes * rows,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
    });
    const params = new DataView(new ArrayBuffer(32));
    [nx, rows, rowWords, 0].forEach((v, k) => params.setUint32(k * 4, v, true));
    params.setFloat32(16, lo, true);
    params.setFloat32(20, 1 / (hi - lo), true);
    const uniform = device.createBuffer({ size: 32, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    device.queue.writeBuffer(uniform, 0, params.buffer);
    const module = device.createShaderModule({ code: packShader, label: 'sciviz volume pack' });
    const pipeline = device.createComputePipeline({ layout: 'auto', compute: { module, entryPoint: 'main' } });
    const group = device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: array.buffer } },
        { binding: 1, resource: { buffer: staging } },
        { binding: 2, resource: { buffer: uniform } },
      ],
    });
    const encoder = device.createCommandEncoder(),
      pass = encoder.beginComputePass();
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, group);
    pass.dispatchWorkgroups(Math.ceil(rowWords / 64), Math.min(rows, 65535), Math.ceil(rows / 65535));
    pass.end();
    encoder.copyBufferToTexture(
      { buffer: staging, bytesPerRow: rowBytes, rowsPerImage: ny },
      { texture: this.#texture! },
      [nx, ny, nz],
    );
    device.queue.submit([encoder.finish()]);
    staging.destroy();
    uniform.destroy();
  }

  /** @internal The device was restored: rebuild from the CPU data (a GpuArray source must be rebuilt by you). */
  restore(): void {
    if (!isGpuArray(this.#data)) this.#build();
    else {
      this.#group = undefined;
      this.visible = false;
      for (const slice of this.#slices) slice.visible = false;
    }
  }

  /** @internal The figure's data-to-scene transform. */
  setModel(figure: Float32Array): void {
    this.#figure = figure;
    // Box [0, 1]^3 to data units, then into the scene.
    const [x0, x1, y0, y1, z0, z1] = this.bounds,
      box = [x1 - x0, 0, 0, 0, 0, y1 - y0, 0, 0, 0, 0, z1 - z0, 0, x0, y0, z0, 1];
    multiplyMatrices(figure, box, this.#model);
    for (const s of this.#slices) s.setModel(this.#model);
  }

  /** @internal The box-to-scene transform. */
  get model(): Float32Array {
    return this.#model;
  }

  /** @internal */
  center(): readonly [number, number, number] {
    const m = this.#model;
    return [m[12] + (m[0] + m[4] + m[8]) / 2, m[13] + (m[1] + m[5] + m[9]) / 2, m[14] + (m[2] + m[6] + m[10]) / 2];
  }

  /** @internal Texture, transfer and sampler for slices. */
  resources(): { data: GPUTexture; transfer: GPUTexture; sampler: GPUSampler } {
    return { data: this.#texture!, transfer: this.#transfer!, sampler: this.#sampler! };
  }

  /** @internal Whether the source texture belongs to the current device. */
  get valid(): boolean {
    return !this.#disposed && !!this.#group;
  }

  /**
   * A slice through the volume: the plane `axis = position` (position in [0, 1] across the box), coloured by the
   * volume's colour map. Returns the slice layer; move it with `slice.position = ...`.
   */
  slice(axis: 'x' | 'y' | 'z', position = 0.5, options: { readonly opacity?: number } = {}): SliceLayer {
    const slice = new SliceLayer(this.#renderer, this, axis, position, options.opacity ?? 1);
    slice.setModel(this.#model);
    this.#slices.add(slice);
    this.#renderer.add(slice);
    return slice;
  }

  /** @internal */
  forgetSlice(slice: SliceLayer): void {
    this.#slices.delete(slice);
  }

  /** @internal */
  prepare(): void {
    if (!this.valid) return;
    const v = this.#values,
      m = this.#model;
    v.set(m, 0);
    const toBox = this.#toBox;
    toBox.fill(0);
    invertMatrix(m, toBox);
    // Normals: inverse transpose of the box-to-scene linear part.
    const n = this.#normal;
    n.fill(0);
    for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) n[c * 4 + r] = toBox[r * 4 + c];
    n[15] = 1;
    v.set([this.dims[0], this.dims[1], this.dims[2], this.#clip.length], 48);
    v.set(
      [
        this.quality * (this.#renderer.samplingScale ?? 1),
        this.mode === 'mip' ? 1 : this.mode === 'minip' ? 2 : 0,
        this.density,
        this.shading ? 1 : 0,
      ],
      52,
    );
    v.fill(0, 56);
    this.#clip.forEach((p, k) => v.set([...p.normal, p.offset], 56 + k * 4));
    v.set(this.classificationUniforms(), 72);
    this.#renderer.device!.queue.writeBuffer(this.#uniform!, 0, v);
  }

  /** @internal */
  draw(pass: GPURenderPassEncoder, context: GpuContext, renderer: SciRenderer): void {
    if (!this.valid) return;
    // Outside the box: front faces, tested against the scene's depth. Inside it: back faces, always.
    const eye = context.camera.position,
      toBox = this.#values.subarray(16, 32),
      p = [0, 1, 2].map((r) => toBox[r] * eye[0] + toBox[4 + r] * eye[1] + toBox[8 + r] * eye[2] + toBox[12 + r]),
      inside = p.every((c) => c > 0 && c < 1);
    const pipeline = renderer.pipeline(`volume|${inside}|${!!this.colormap.encoding}`, context, (target) => {
      const module = renderer.device!.createShaderModule({
        code: volumeCode(volumeShader, !!this.colormap.encoding),
        label: 'sciviz volume',
      });
      return {
        label: 'sciviz volume',
        layout: renderer.device!.createPipelineLayout({
          bindGroupLayouts: [renderer.frameLayout!, this.#layout!, renderer.depthLayout!],
        }),
        vertex: { module, entryPoint: 'vertex' },
        fragment: {
          module,
          entryPoint: 'fragment',
          targets: [
            {
              format: target.format,
              blend: {
                color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha' },
                alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' },
              },
            },
          ],
        },
        primitive: { topology: 'triangle-list', cullMode: inside ? 'front' : 'back' },
        multisample: target.multisample,
        depthStencil: {
          format: target.depth,
          depthWriteEnabled: false,
          depthCompare: inside ? 'always' : 'greater-equal',
        },
      };
    });
    pass.setPipeline(pipeline);
    pass.setBindGroup(1, this.#group!);
    pass.setBindGroup(2, renderer.depthGroup!);
    pass.draw(36);
  }

  /** Frees the GPU resources and the volume's slices. */
  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    for (const s of [...this.#slices]) s.dispose();
    this.#renderer.remove(this);
    this.#texture?.destroy();
    this.#transfer?.destroy();
    this.#uniform?.destroy();
  }

  /** Same as `dispose()`, for `using`. */
  [Symbol.dispose](): void {
    this.dispose();
  }
}

/** A plane through a volume. Create it with `volume.slice(axis, position)`. */
export class SliceLayer implements Drawable {
  /** @internal Shared volume textures are attributed to the volume, never duplicated on each slice. */
  get memoryResources(): import('./resources.js').LayerResources {
    return { cpu: [this.#values, this.#model], gpu: this.#disposed ? [] : [this.#uniform] };
  }
  /** False hides the slice. */
  visible = true;
  /** The axis the plane is perpendicular to. */
  readonly axis: 'x' | 'y' | 'z';
  /** Position across the box, 0 to 1. */
  position: number;
  /** Opacity, 0 to 1. */
  readonly opacity: number;
  readonly #renderer: SciRenderer;
  readonly #volume: VolumeLayer;
  #uniform: GPUBuffer | undefined;
  #layout: GPUBindGroupLayout | undefined;
  #group: GPUBindGroup | undefined;
  #model = new Float32Array(16);
  readonly #values = new Float32Array(32);
  #disposed = false;

  /** @internal Use `volume.slice()`. */
  constructor(renderer: SciRenderer, volume: VolumeLayer, axis: 'x' | 'y' | 'z', position: number, opacity: number) {
    if (!['x', 'y', 'z'].includes(axis))
      throw typeError(`Slice axis must be 'x', 'y' or 'z', got ${String(axis)}`, 'sciviz');
    if (!(position >= 0 && position <= 1))
      throw rangeError(`Slice position must be in [0, 1], got ${position}`, 'sciviz');
    if (!(opacity >= 0 && opacity <= 1)) throw rangeError(`Slice opacity must be in [0, 1], got ${opacity}`, 'sciviz');
    this.#renderer = renderer;
    this.#volume = volume;
    this.axis = axis;
    this.position = position;
    this.opacity = opacity;
    this.#build();
  }

  #build(): void {
    const device = this.#renderer.device!,
      { data, transfer, sampler } = this.#volume.resources();
    this.#uniform?.destroy();
    this.#uniform = device.createBuffer({
      size: this.#values.byteLength,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this.#layout = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float', viewDimension: '3d' } },
        {
          binding: 2,
          visibility: GPUShaderStage.FRAGMENT,
          texture: { sampleType: this.#volume.colormap.encoding ? 'unfilterable-float' : 'float' },
        },
        { binding: 3, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
      ],
    });
    this.#group = device.createBindGroup({
      layout: this.#layout!,
      entries: [
        { binding: 0, resource: { buffer: this.#uniform! } },
        { binding: 1, resource: data.createView({ dimension: '3d' }) },
        { binding: 2, resource: transfer.createView() },
        { binding: 3, resource: sampler },
      ],
    });
  }

  /** @internal */
  restore(): void {
    if (this.#volume.valid) this.#build();
    else this.visible = false;
  }

  /** Opaque slices write depth; translucent ones blend. */
  get transparent(): boolean {
    return this.opacity < 1;
  }

  /** @internal */
  setModel(model: Float32Array): void {
    this.#model.set(model);
  }

  /** @internal */
  center(): readonly [number, number, number] {
    return this.#volume.center();
  }

  /** @internal */
  prepare(): void {
    if (!this.#volume.valid) return;
    if (!(this.position >= 0 && this.position <= 1))
      throw rangeError(`Slice position must be in [0, 1], got ${this.position}`, 'sciviz');
    this.#values.set(this.#model, 0);
    this.#values.set([{ x: 0, y: 1, z: 2 }[this.axis], this.position, this.opacity, 0], 16);
    this.#values.set([...this.#volume.dims, 0], 20);
    this.#values.set(this.#volume.classificationUniforms(), 24);
    this.#renderer.device!.queue.writeBuffer(this.#uniform!, 0, this.#values);
  }

  /** @internal */
  draw(pass: GPURenderPassEncoder, context: GpuContext, renderer: SciRenderer): void {
    if (!this.#volume.valid) return;
    const transparent = this.transparent;
    const pipeline = renderer.pipeline(
      `slice|${transparent}|${!!this.#volume.colormap.encoding}`,
      context,
      (target) => {
        const module = renderer.device!.createShaderModule({
          code: volumeCode(sliceShader, !!this.#volume.colormap.encoding),
          label: 'sciviz slice',
        });
        return {
          label: 'sciviz slice',
          layout: renderer.device!.createPipelineLayout({ bindGroupLayouts: [renderer.frameLayout!, this.#layout!] }),
          vertex: { module, entryPoint: 'vertex' },
          fragment: {
            module,
            entryPoint: 'fragment',
            targets: [
              {
                format: target.format,
                blend: transparent
                  ? {
                      color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha' },
                      alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' },
                    }
                  : undefined,
              },
            ],
          },
          primitive: { topology: 'triangle-list', cullMode: 'none' },
          multisample: target.multisample,
          depthStencil: { format: target.depth, depthWriteEnabled: !transparent, depthCompare: 'greater-equal' },
        };
      },
    );
    pass.setPipeline(pipeline);
    pass.setBindGroup(1, this.#group!);
    pass.draw(6);
  }

  /** Removes the slice. */
  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#renderer.remove(this);
    this.#volume.forgetSlice(this);
    this.#uniform?.destroy();
  }

  /** Same as `dispose()`, for `using`. */
  [Symbol.dispose](): void {
    this.dispose();
  }
}
