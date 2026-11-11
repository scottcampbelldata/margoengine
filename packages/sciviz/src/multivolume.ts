// Multi-volume and multi-component compositing. Up to four scalar channels, each with its own box (data bounds),
// colour map, range and opacity, are ray marched together in one pass over the union of their boxes, so their samples
// interleave correctly along every ray instead of being drawn one volume over another. At each step every channel
// whose box holds the sample is classified by its own transfer function and the channels are mixed as independent
// absorbers and emitters within the step: opacity 1 - prod(1 - a_i) and colour sum(a_i c_i) / sum(a_i) (the "mix"
// operator of Cai and Sakas, "Data intermixing and multi-volume rendering", Computer Graphics Forum 18(3), 1999,
// at the illumination-model level). The steps then composite front to back (Kruger and Westermann, IEEE
// Visualization 2003) with the step-length opacity correction 1 - (1 - a)^(step / voxel). A multi-component volume is
// the special case of channels that share one box: `componentChannels` splits interleaved tuples into them.
import { invertMatrix, multiplyMatrices } from '@margoengine/math/mat4';
import { fault, rangeError, typeError } from '../../shared/errors.js';
import { resolveColormap, type ColormapSource } from './layer.js';
import { volumeDepthWGSL } from './volume-depth.js';
import type { Figure } from './figure.js';
import type { Bounds } from './layer.js';
import { frameWGSL, type Drawable, type GpuContext, type SciRenderer } from './render.js';
import { halfVoxels, transferTable, type VolumeLayerOptions } from './volume.js';

declare const GPUBufferUsage: { UNIFORM: number; COPY_DST: number };
declare const GPUTextureUsage: { TEXTURE_BINDING: number; COPY_DST: number };
declare const GPUShaderStage: { VERTEX: number; FRAGMENT: number };

/** One scalar channel of a {@link MultiVolumeLayer}. */
export interface VolumeChannel {
  /** Samples, x fastest. */
  readonly data: ArrayLike<number>;
  /** Grid size [nx, ny, nz], at least 2 along each axis. Required. */
  readonly dims: readonly [number, number, number];
  /** Data bounds of this channel's box, first to last sample. Default the voxel indices [0, n - 1] of its own grid. */
  readonly bounds?: Bounds;
  /** Colour map. Default `'gray'`. */
  readonly colormap?: ColormapSource;
  /** Data range the transfer function spans. Default the channel's finite min and max. */
  readonly range?: readonly [number, number];
  /** Opacity per normalised value, as for `fig.volume`. Default `t => t * t`. */
  readonly opacity?: VolumeLayerOptions['opacity'];
}

/** Options of {@link multiVolume}. */
export interface MultiVolumeOptions {
  /** Overall opacity scale. Default 1. */
  readonly density?: number;
  /** Samples per voxel of the finest channel along a ray. Default 1.5. */
  readonly quality?: number;
}

const MAX_CHANNELS = 4;
// Bounds are voxel centres: channel coordinate q samples texel (q (n - 1) + 0.5) / n. Steps are measured in data units
// along the ray against the finest channel voxel (extent is the union box in those voxels), and density scales
// extinction, as in figure.volume. Rays stop at opaque scene depth; inside the box the back faces draw.
const shader = /* wgsl */ `${frameWGSL}
${volumeDepthWGSL}
struct Params { model: mat4x4f, toBox: mat4x4f, lo: array<vec4f, 4>, size: array<vec4f, 4>, info: vec4f, extent: vec4f }
@group(1) @binding(0) var<uniform> u: Params;
@group(1) @binding(1) var c0: texture_3d<f32>;
@group(1) @binding(2) var c1: texture_3d<f32>;
@group(1) @binding(3) var c2: texture_3d<f32>;
@group(1) @binding(4) var c3: texture_3d<f32>;
@group(1) @binding(5) var transfer: texture_2d<f32>;
@group(1) @binding(6) var linearSampler: sampler;
struct Out { @builtin(position) clip: vec4f, @location(0) world: vec3f, @location(1) ndc: vec4f }
fn corner(index: u32) -> vec3f {
  let faces = array<vec3u, 6>(vec3u(0u, 1u, 2u), vec3u(0u, 2u, 1u), vec3u(1u, 2u, 0u), vec3u(1u, 0u, 2u), vec3u(2u, 0u, 1u), vec3u(2u, 1u, 0u));
  let face = index / 6u; let k = index % 6u;
  let quad = array<vec2f, 6>(vec2f(0.0, 0.0), vec2f(1.0, 0.0), vec2f(1.0, 1.0), vec2f(0.0, 0.0), vec2f(1.0, 1.0), vec2f(0.0, 1.0));
  let axes = faces[face]; let uv = quad[k].yx; var p = vec3f(0.0);
  p[axes.x] = uv.x; p[axes.y] = uv.y; p[axes.z] = f32(face % 2u);
  return p;
}
@vertex fn vertex(@builtin(vertex_index) index: u32) -> Out {
  let world = u.model * vec4f(corner(index), 1.0);
  var out: Out; out.world = world.xyz; out.clip = frame.clip * world; out.ndc = out.clip; return out;
}
fn hash(p: vec2f) -> f32 { return fract(sin(dot(p, vec2f(12.9898, 78.233))) * 43758.5453); }
fn channel(i: u32, p: vec3f) -> vec4f {
  // p in union box coordinates; q in this channel's own [0, 1] box.
  let q = (p - u.lo[i].xyz) / u.size[i].xyz;
  if (any(q < vec3f(0.0)) || any(q > vec3f(1.0))) { return vec4f(0.0); }
  var v = 0.0;
  switch i {
    case 0u: { let n = vec3f(textureDimensions(c0)); v = textureSampleLevel(c0, linearSampler, (q * (n - 1.0) + 0.5) / n, 0.0).r; }
    case 1u: { let n = vec3f(textureDimensions(c1)); v = textureSampleLevel(c1, linearSampler, (q * (n - 1.0) + 0.5) / n, 0.0).r; }
    case 2u: { let n = vec3f(textureDimensions(c2)); v = textureSampleLevel(c2, linearSampler, (q * (n - 1.0) + 0.5) / n, 0.0).r; }
    default: { let n = vec3f(textureDimensions(c3)); v = textureSampleLevel(c3, linearSampler, (q * (n - 1.0) + 0.5) / n, 0.0).r; }
  }
  if (!(v == v)) { return vec4f(0.0); }
  return textureSampleLevel(transfer, linearSampler, vec2f(clamp(v, 0.0, 1.0), (f32(i) + 0.5) / 4.0), 0.0);
}
@fragment fn fragment(in: Out) -> @location(0) vec4f {
  let ndc = in.ndc.xy / in.ndc.w;
  let nearWorld = frame.inverse * vec4f(ndc, 1.0, 1.0);
  let origin = (u.toBox * vec4f(nearWorld.xyz / nearWorld.w, 1.0)).xyz;
  let dir = normalize((u.toBox * vec4f(in.world, 1.0)).xyz - origin);
  let inv = 1.0 / dir;
  let t0 = (vec3f(0.0) - origin) * inv; let t1 = (vec3f(1.0) - origin) * inv;
  let enter = max(max(max(min(t0.x, t1.x), min(t0.y, t1.y)), min(t0.z, t1.z)), 0.0);
  var exit = min(min(max(t0.x, t1.x), max(t0.y, t1.y)), max(t0.z, t1.z));
  let opaque = opaquePoint(in.clip.xy, ndc);
  if (opaque.w > 0.0) { let o = (u.toBox * opaque).xyz; exit = min(exit, dot(o - origin, dir)); }
  if (exit <= enter) { discard; }
  let voxel = 1.0 / max(length(dir * u.extent.xyz), 1e-30);
  let stride = max(voxel / u.info.z, (exit - enter) / 2048.0);
  let count = min(u32((exit - enter) / stride) + 1u, 2048u);
  var t = enter + stride * hash(in.clip.xy);
  var colour = vec3f(0.0); var alpha = 0.0;
  let channels = u32(u.info.x);
  for (var s = 0u; s < count; s++) {
    if (t >= exit) { break; }
    let p = origin + dir * t; t += stride;
    var keep = 1.0; var weighted = vec3f(0.0); var total = 0.0;
    for (var i = 0u; i < channels; i++) {
      let tf = channel(i, p);
      // Opacity 1 is infinite extinction: opaque over any positive length (density 0 stays clear).
      let k = u.info.w * stride / voxel;
      let a = select(1.0 - exp(log(max(1.0 - tf.a, 1e-6)) * k), 1.0, tf.a >= 1.0 && k > 0.0);
      keep *= 1.0 - a; weighted += a * tf.rgb; total += a;
    }
    let a = 1.0 - keep;
    if (a < 0.002) { continue; }
    colour += (1.0 - alpha) * a * (weighted / total);
    alpha += (1.0 - alpha) * a;
    if (alpha > 0.99) { break; }
  }
  if (alpha < 0.002) { discard; }
  return vec4f(toOutput(colour / alpha), alpha);
}`;

interface Prepared {
  readonly dims: readonly [number, number, number];
  readonly bounds: Bounds;
  readonly voxels: Uint16Array<ArrayBuffer>;
  readonly table: Uint8Array;
}

function prepare(c: VolumeChannel, index: number): Prepared {
  const bad = (what: string) => rangeError(`Multi-volume channel ${index}: ${what}`, 'sciviz');
  const dims = c?.dims;
  if (!dims || dims.length !== 3 || !dims.every((n) => Number.isSafeInteger(n) && n >= 2 && n <= 2048))
    throw bad('dims must be three integers from 2 to 2048');
  const n = dims[0] * dims[1] * dims[2];
  if (!c.data || c.data.length !== n) throw bad(`data needs ${n} samples, one per grid point`);
  const bounds = c.bounds ?? ([0, dims[0] - 1, 0, dims[1] - 1, 0, dims[2] - 1] as unknown as Bounds);
  if (bounds.length !== 6 || !bounds.every(Number.isFinite) || [0, 2, 4].some((a) => !(bounds[a + 1] > bounds[a])))
    throw bad('bounds must be six finite numbers, increasing along every axis');
  let range = c.range;
  if (!range) {
    let lo = Infinity, hi = -Infinity;
    for (let i = 0; i < n; i++) { const v = c.data[i]; if (Number.isFinite(v)) { if (v < lo) lo = v; if (v > hi) hi = v; } }
    range = lo < hi ? [lo, hi] : lo === hi ? [lo, lo + 1] : [0, 1];
  }
  if (range.length !== 2 || !range.every(Number.isFinite) || !(range[1] > range[0])) throw bad('range must be two increasing finite numbers');
  return { dims, bounds, voxels: halfVoxels(c.data, range[0], range[1]), table: transferTable(resolveColormap(c.colormap ?? 'gray'), c.opacity) };
}

/** Split interleaved tuples (`components` values per grid point) into channels that share one box. */
export function componentChannels(
  data: ArrayLike<number>,
  components: number,
  dims: readonly [number, number, number],
  each: readonly Omit<VolumeChannel, 'data' | 'dims'>[] = [],
): VolumeChannel[] {
  if (!Number.isInteger(components) || components < 1 || components > MAX_CHANNELS)
    throw rangeError(`componentChannels needs 1 to ${MAX_CHANNELS} components`, 'sciviz');
  const n = dims[0] * dims[1] * dims[2];
  if (data.length !== n * components) throw rangeError(`componentChannels needs ${n * components} values, ${components} per grid point`, 'sciviz');
  return Array.from({ length: components }, (_, k) => {
    const values = new Float32Array(n);
    for (let i = 0; i < n; i++) values[i] = data[i * components + k];
    return { ...each[k], data: values, dims };
  });
}

/** Several co-located volumes or the components of one, ray marched and mixed in a single pass. */
export class MultiVolumeLayer implements Drawable {
  readonly transparent = true;
  visible = true;
  /** Union of the channel boxes, in data units. */
  readonly bounds: Bounds;
  /** Overall opacity scale. */
  density: number;
  /** Samples per voxel of the finest channel. */
  quality: number;
  readonly #renderer: SciRenderer;
  readonly #channels: Prepared[];
  /** @internal Rays stop at opaque scene geometry. */
  readonly needsSceneDepth = true;
  readonly #values = new Float32Array(16 + 16 + 16 + 16 + 4 + 4);
  #model = new Float32Array(16);
  #textures: GPUTexture[] = [];
  #transfer?: GPUTexture;
  #uniform?: GPUBuffer;
  #layout?: GPUBindGroupLayout;
  #group?: GPUBindGroup;
  #disposed = false;

  /** @internal Use {@link multiVolume}. */
  constructor(renderer: SciRenderer, channels: readonly VolumeChannel[], options: MultiVolumeOptions = {}) {
    if (!Array.isArray(channels) || channels.length < 1 || channels.length > MAX_CHANNELS)
      throw rangeError(`A multi-volume takes 1 to ${MAX_CHANNELS} channels`, 'sciviz');
    this.#channels = channels.map(prepare);
    this.density = options.density ?? 1;
    this.quality = options.quality ?? 1.5;
    if (!(this.density >= 0) || !Number.isFinite(this.density) || !(this.quality > 0) || !Number.isFinite(this.quality))
      throw rangeError('Multi-volume density must be finite and at least 0, quality finite and above 0', 'sciviz');
    const b = [Infinity, -Infinity, Infinity, -Infinity, Infinity, -Infinity];
    for (const c of this.#channels) for (let a = 0; a < 3; a++) { b[2 * a] = Math.min(b[2 * a], c.bounds[2 * a]); b[2 * a + 1] = Math.max(b[2 * a + 1], c.bounds[2 * a + 1]); }
    this.bounds = b as unknown as Bounds;
    this.#renderer = renderer;
    this.restore();
    renderer.add(this);
  }

  /** Rebuild GPU resources after device replacement. */
  restore(): void {
    if (this.#disposed) return;
    const device = this.#renderer.device!;
    for (const t of this.#textures) t.destroy();
    this.#transfer?.destroy();
    this.#uniform?.destroy();
    this.#textures = Array.from({ length: MAX_CHANNELS }, (_, i) => {
      const c = this.#channels[i], dims = c?.dims ?? [1, 1, 1];
      const texture = device.createTexture({ size: [...dims], dimension: '3d', format: 'r16float', usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST });
      device.queue.writeTexture({ texture }, c?.voxels ?? new Uint16Array(1), { bytesPerRow: dims[0] * 2, rowsPerImage: dims[1] }, [...dims]);
      return texture;
    });
    // One 256-entry transfer row per channel; unused rows are clear.
    const rows = new Uint8Array(256 * 4 * MAX_CHANNELS);
    this.#channels.forEach((c, i) => rows.set(c.table, i * 1024));
    this.#transfer = device.createTexture({ size: [256, MAX_CHANNELS], format: 'rgba8unorm-srgb', usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST });
    device.queue.writeTexture({ texture: this.#transfer }, rows, { bytesPerRow: 1024 }, [256, MAX_CHANNELS]);
    const sampler = device.createSampler({ magFilter: 'linear', minFilter: 'linear', addressModeU: 'clamp-to-edge', addressModeV: 'clamp-to-edge', addressModeW: 'clamp-to-edge' });
    this.#uniform = device.createBuffer({ size: this.#values.byteLength, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.#layout = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
        ...[1, 2, 3, 4].map((binding) => ({ binding, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' as const, viewDimension: '3d' as const } })),
        { binding: 5, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
        { binding: 6, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
      ],
    });
    this.#group = device.createBindGroup({
      layout: this.#layout,
      entries: [
        { binding: 0, resource: { buffer: this.#uniform } },
        ...this.#textures.map((t, i) => ({ binding: i + 1, resource: t.createView({ dimension: '3d' }) })),
        { binding: 5, resource: this.#transfer.createView() },
        { binding: 6, resource: sampler },
      ],
    });
  }

  /** @internal The figure's data-to-scene transform. */
  setModel(figure: Float32Array): void {
    const [x0, x1, y0, y1, z0, z1] = this.bounds;
    multiplyMatrices(figure, new Float32Array([x1 - x0, 0, 0, 0, 0, y1 - y0, 0, 0, 0, 0, z1 - z0, 0, x0, y0, z0, 1]), this.#model);
  }

  /** @internal */
  center(): readonly [number, number, number] {
    const m = this.#model;
    return [m[12] + (m[0] + m[4] + m[8]) / 2, m[13] + (m[1] + m[5] + m[9]) / 2, m[14] + (m[2] + m[6] + m[10]) / 2];
  }

  /** @internal */
  draw(pass: GPURenderPassEncoder, context: GpuContext, renderer: SciRenderer): void {
    if (this.#disposed) throw fault('state', 'Multi-volume is disposed; create a new one', 'sciviz');
    const v = this.#values, u = this.bounds;
    v.set(this.#model, 0);
    invertMatrix(this.#model, v.subarray(16, 32));
    let voxel = Infinity;
    this.#channels.forEach((c, i) => {
      for (let a = 0; a < 3; a++) {
        const span = u[2 * a + 1] - u[2 * a];
        v[32 + 4 * i + a] = (c.bounds[2 * a] - u[2 * a]) / span;
        v[48 + 4 * i + a] = (c.bounds[2 * a + 1] - c.bounds[2 * a]) / span;
        voxel = Math.min(voxel, Math.abs(c.bounds[2 * a + 1] - c.bounds[2 * a]) / (c.dims[a] - 1));
      }
    });
    v.set([this.#channels.length, voxel, this.quality * (renderer.samplingScale ?? 1), this.density], 64);
    for (let a = 0; a < 3; a++) v[68 + a] = Math.abs(u[2 * a + 1] - u[2 * a]) / voxel;
    // Outside the box: front faces, tested against the scene's depth. Inside it: back faces, always.
    const eye = context.camera.position,
      toBox = v.subarray(16, 32),
      p = [0, 1, 2].map((r) => toBox[r] * eye[0] + toBox[4 + r] * eye[1] + toBox[8 + r] * eye[2] + toBox[12 + r]),
      inside = p.every((c) => c > 0 && c < 1);
    renderer.device!.queue.writeBuffer(this.#uniform!, 0, v);
    const pipeline = renderer.pipeline(`multi-volume|${inside}`, context, (target) => {
      const module = renderer.device!.createShaderModule({ code: shader, label: 'multi-volume' });
      return {
        layout: renderer.device!.createPipelineLayout({ bindGroupLayouts: [renderer.frameLayout!, this.#layout!, renderer.depthLayout!] }),
        vertex: { module, entryPoint: 'vertex' },
        fragment: { module, entryPoint: 'fragment', targets: [{ format: target.format, blend: { color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha' }, alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' } } }] },
        primitive: { topology: 'triangle-list', cullMode: inside ? 'front' : 'back' },
        multisample: target.multisample,
        depthStencil: { format: target.depth, depthWriteEnabled: false, depthCompare: inside ? 'always' : 'greater-equal' },
      };
    });
    pass.setPipeline(pipeline);
    pass.setBindGroup(1, this.#group!);
    pass.setBindGroup(2, renderer.depthGroup!);
    pass.draw(36);
  }

  /** Free the textures and leave the figure. */
  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#renderer.remove(this);
    for (const t of this.#textures) t.destroy();
    this.#transfer?.destroy();
    this.#uniform?.destroy();
  }

  /** Same as `dispose()`, for `using`. */
  [Symbol.dispose](): void {
    this.dispose();
  }
}

/**
 * Add up to four volumes, or the components of one, to a figure as one ray-marched layer. Each channel keeps its own
 * box, colour map, range and opacity; where boxes overlap their samples mix within each step.
 * @example
 * const layer = multiVolume(fig, [
 *   { data: ct, dims: [64, 64, 64], colormap: 'gray' },
 *   { data: pet, dims: [32, 32, 32], bounds: [0, 63, 0, 63, 0, 63], colormap: 'inferno' },
 * ]);
 */
export function multiVolume(figure: Figure, channels: readonly VolumeChannel[], options: MultiVolumeOptions = {}): MultiVolumeLayer {
  if (!figure?.renderer) throw typeError('multiVolume needs a Figure; create one with Figure.create', 'sciviz');
  const layer = new MultiVolumeLayer(figure.renderer, channels, options);
  figure.addLayer(layer);
  return layer;
}
