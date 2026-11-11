/// <reference lib="esnext.disposable" preserve="true" />
// Blend two environments: one Environment whose source cube, prefiltered specular mips and SH irradiance are the
// weighted sum of two others, so a day to night or indoor to outdoor fade lights and draws like any Environment.
// Prefiltering and SH projection are linear in the radiance, so blending their results equals processing the blended
// radiance (up to rgba16float rounding); each source's rotation and intensity are applied while blending.
import type { EngineKernel, EnginePlugin } from '@margoengine/core';
import { engineRuntime } from '@margoengine/core/extension';
import { MargoError } from '@margoengine/math/errors';
import type { Environment, EnvironmentOptions } from './environment.js';
import { evaluateSH, shBasis } from './sh.js';
import { common } from './shader-common.js';

declare const GPUBufferUsage: { UNIFORM: number; STORAGE: number; COPY_DST: number };
declare const GPUTextureUsage: { RENDER_ATTACHMENT: number; COPY_SRC: number };

/** Options of `EnvironmentBlend.create` and `attach`; every one is optional. */
export interface EnvironmentBlendOptions {
  /** Blend factor: 0 is `from`, 1 is `to`, linear between. Default 0. */
  t?: number;
  /** Source cube edge of the blended environment (power of two). Default: the larger of the two sources. */
  size?: number;
  /** Prefiltered mip 0 edge. Default: the larger of the two sources (at most `size`). */
  specularSize?: number;
  /** Prefiltered mip count. Default: the larger of the two sources. */
  specularMips?: number;
  /** BRDF LUT edge of the blended environment. Default 128 (as Environment). */
  brdfSize?: number;
  /** Importance samples per BRDF LUT texel of the blended environment. Default 512 (as Environment). */
  brdfSamples?: number;
  /** Plugin name of the blend; the blended environment is named `${name}-environment`. Default 'environment-blend'. */
  name?: string;
}

// Gauss-Legendre nodes and weights on [-1, 1] (3 points, exact to degree 5) for the polar axis, and 8 even steps in
// azimuth (exact to trigonometric degree 7): the product rule integrates every product of two L2 harmonics (degree 4)
// exactly, so the projection below is the exact rotation of a band-limited function, not an approximation.
const NODES = [-Math.sqrt(0.6), 0, Math.sqrt(0.6)];
const WEIGHTS = [5 / 9, 8 / 9, 5 / 9];
const STEPS = 8;

/**
 * Rotates L2 SH coefficients (27 floats, as `Environment.sh`) by `angle` radians about +Y, with the convention of
 * `Environment.rotation`: the result evaluated at `d` equals the input evaluated at
 * `(cos a d.x - sin a d.z, d.y, sin a d.x + cos a d.z)`. Multiplies by `scale`; adds into `out` when `accumulate`.
 */
export function rotateSH(
  coefficients: ArrayLike<number>,
  angle: number,
  scale = 1,
  out: Float32Array = new Float32Array(27),
  accumulate = false,
): Float32Array {
  if (!accumulate) out.fill(0);
  const c = Math.cos(angle),
    s = Math.sin(angle),
    basis = new Float64Array(9);
  for (let i = 0; i < 3; i++)
    for (let j = 0; j < STEPS; j++) {
      const y = NODES[i],
        r = Math.sqrt(1 - y * y),
        phi = (2 * Math.PI * j) / STEPS,
        x = r * Math.cos(phi),
        z = r * Math.sin(phi);
      const value = evaluateSH(coefficients, [c * x - s * z, y, s * x + c * z]);
      const w = ((WEIGHTS[i] * 2 * Math.PI) / STEPS) * scale;
      shBasis(x, y, z, basis);
      for (let k = 0; k < 9; k++) for (let ch = 0; ch < 3; ch++) out[k * 3 + ch] += w * value[ch] * basis[k];
    }
  return out;
}

// One full-screen triangle per (mip, face): the output texel's direction, rotated into each source, sampled at the
// source mip that matches the output level, weighted. Fragment, not compute: explicit-LOD cube sampling in compute
// reads stale seam texels on some Vulkan implementations (see the prefilter in environment.ts).
const BLEND_WGSL = /* wgsl */ `${common}
struct Level { size: f32, face: u32, lodA: f32, lodB: f32 }
struct Weights { a: vec4f, b: vec4f } // cos(rotation), sin(rotation), weight
@group(0) @binding(0) var sourceA: texture_cube<f32>;
@group(0) @binding(1) var sourceB: texture_cube<f32>;
@group(0) @binding(2) var linearSampler: sampler;
@group(0) @binding(3) var<uniform> level: Level;
@group(0) @binding(4) var<uniform> weights: Weights;
fn rotateY(d: vec3f, w: vec4f) -> vec3f { return vec3f(w.x * d.x - w.y * d.z, d.y, w.y * d.x + w.x * d.z); }
@vertex fn vertexMain(@builtin(vertex_index) index: u32) -> @builtin(position) vec4f {
  return vec4f(vec2f(f32((index << 1u) & 2u), f32(index & 2u)) * 2.0 - 1.0, 0.0, 1.0);
}
@fragment fn fragmentMain(@builtin(position) position: vec4f) -> @location(0) vec4f {
  let d = normalize(faceDirection(level.face, position.xy / level.size * 2.0 - 1.0));
  let a = textureSampleLevel(sourceA, linearSampler, rotateY(d, weights.a), level.lodA).rgb;
  let b = textureSampleLevel(sourceB, linearSampler, rotateY(d, weights.b), level.lodB).rgb;
  return vec4f(a * weights.a.z + b * weights.b.z, 1.0);
}`;
// The SH buffer is storage (no COPY_DST): irradiance at vec4 0..8, radiance at vec4 16..24, as Environment writes it.
const SH_WGSL = /* wgsl */ `
@group(0) @binding(0) var<uniform> values: array<vec4f, 18>;
@group(0) @binding(1) var<storage, read_write> sh: array<vec4f, 32>;
@compute @workgroup_size(18) fn main(@builtin(local_invocation_index) i: u32) {
  sh[select(i + 7u, i, i < 9u)] = values[i];
}`;

interface Pipelines {
  blend: GPURenderPipeline;
  sh: GPUComputePipeline;
}
const pipelines = /* @__PURE__ */ new WeakMap<GPUDevice, Pipelines>();
function pipelinesFor(device: GPUDevice): Pipelines {
  let p = pipelines.get(device);
  if (!p) {
    const module = device.createShaderModule({ label: 'environment blend', code: BLEND_WGSL });
    p = {
      blend: device.createRenderPipeline({
        label: 'environment blend',
        layout: 'auto',
        vertex: { module, entryPoint: 'vertexMain' },
        fragment: { module, entryPoint: 'fragmentMain', targets: [{ format: 'rgba16float' }] },
        primitive: { topology: 'triangle-list' },
      }),
      sh: device.createComputePipeline({
        label: 'environment blend SH',
        layout: 'auto',
        compute: {
          module: device.createShaderModule({ label: 'environment blend SH', code: SH_WGSL }),
          entryPoint: 'main',
        },
      }),
    };
    pipelines.set(device, p);
  }
  return p;
}

// GPU state for one (from, to, output) triple on one device: rebuilt when any of them is replaced or restored.
interface State {
  device: GPUDevice;
  key: readonly unknown[];
  levels: GPUBuffer;
  weights: GPUBuffer;
  values: GPUBuffer;
  scratch: GPUTexture;
  passes: Array<{ group: GPUBindGroup; target: GPUTextureView; copy?: { mip: number; face: number; edge: number } }>;
  shGroup: GPUBindGroup;
}

const STRIDE = 256;
const isPowerOfTwo = (n: number) => Number.isInteger(n) && n > 0 && (n & (n - 1)) === 0;

/**
 * Fades between two environments (day to night, indoor to outdoor) with matching image-based lighting: `environment`
 * is an ordinary Environment holding `(1 - t) x from + t x to` in its source cube, prefiltered specular mips and SH,
 * so `EnvironmentLighting`, `EnvironmentBackground` and `LightProbes` use it unchanged. Setting `t` reblends on the GPU
 * (two texture reads per output texel, no prefiltering); call `update()` after changing a source's rotation or
 * intensity or refreshing it. `engine.use(blend)` (or `attach`) restores the blend after a device loss.
 */
export class EnvironmentBlend implements EnginePlugin {
  readonly name: string;
  /** The blended environment: pass it to EnvironmentLighting, EnvironmentBackground or LightProbes. */
  readonly environment: Environment;
  private fromValue: Environment;
  private toValue: Environment;
  private tValue: number;
  private state?: State;
  private readonly unsubscribe: Array<() => void> = [];
  private readonly weightData = new Float32Array(8);
  private readonly shData = new Float32Array(72);
  private readonly irradiance = new Float32Array(27);
  private readonly radiance = new Float32Array(27);
  private engine?: EngineKernel;
  disposed = false;

  private constructor(environment: Environment, from: Environment, to: Environment, t: number, name: string) {
    this.environment = environment;
    this.fromValue = from;
    this.toValue = to;
    this.tValue = t;
    this.name = name;
    const changed = () => this.restored();
    this.unsubscribe.push(environment.onChange(changed));
    this.watch();
  }

  /** Creates the blended environment on the device of `from` and `to` (a GPUDevice or a WebGPU engine) and blends. */
  static async create(
    target: GPUDevice | EngineKernel,
    from: Environment,
    to: Environment,
    options: EnvironmentBlendOptions = {},
  ): Promise<EnvironmentBlend> {
    const t = checkT(options.t ?? 0);
    const device = isDevice(target) ? target : engineRuntime(target).gpu;
    if (!device) throw new MargoError('unsupported', 'EnvironmentBlend requires the WebGPU backend');
    checkSources(device, from, to);
    const size = options.size ?? Math.max(from.size, to.size);
    const specularSize = options.specularSize ?? Math.min(size, Math.max(from.specularSize, to.specularSize));
    if (!isPowerOfTwo(size)) throw new RangeError('EnvironmentBlend size must be a power of two');
    const name = options.name ?? 'environment-blend';
    const environmentOptions: EnvironmentOptions = {
      size,
      specularSize,
      specularMips:
        options.specularMips ?? Math.min(Math.log2(specularSize) + 1, Math.max(from.specularMips, to.specularMips)),
      brdfSize: options.brdfSize,
      brdfSamples: options.brdfSamples,
      // The seed is black and is overwritten by every blend: one sample, no equirect kept, tiny CPU source to restore.
      samples: 1,
      keepEquirect: false,
      keepSource: true,
      name: `${name}-environment`,
    };
    // The sources' own class, so the output shares their module (BRDF LUT pool, pipelines) and this entry bundles none of it.
    const factory = from.constructor as unknown as { create: typeof Environment.create };
    const environment = await factory.create(
      device,
      { width: 4, height: 2, data: new Float32Array(32) },
      environmentOptions,
    );
    const blend = new EnvironmentBlend(environment, from, to, t, name);
    try {
      blend.update();
    } catch (error) {
      blend.dispose();
      throw error;
    }
    return blend;
  }

  /** `create(engine, from, to, options)` then `engine.use(blend)`. */
  static async attach(
    engine: EngineKernel,
    from: Environment,
    to: Environment,
    options?: EnvironmentBlendOptions,
  ): Promise<EnvironmentBlend> {
    const blend = await EnvironmentBlend.create(engine, from, to, options);
    try {
      engine.use(blend);
      return blend;
    } catch (error) {
      blend.dispose();
      throw error;
    }
  }

  get t(): number {
    return this.tValue;
  }
  /** Sets the blend factor (0..1) and reblends. */
  set t(value: number) {
    this.tValue = checkT(value);
    this.update();
  }
  get from(): Environment {
    return this.fromValue;
  }
  get to(): Environment {
    return this.toValue;
  }

  /** Replaces the two sources (for example dusk to night after day to dusk) and reblends at `t` (default: unchanged). */
  set(from: Environment, to: Environment, t = this.tValue): void {
    const value = checkT(t);
    const device = this.live();
    checkSources(device, from, to);
    if (from === this.environment || to === this.environment)
      throw new RangeError('EnvironmentBlend cannot blend its own environment; pass two other Environments');
    this.fromValue = from;
    this.toValue = to;
    this.tValue = value;
    this.watch();
    this.update();
  }

  /**
   * Blends `from` and `to` into `environment` at `t` with their current rotation and intensity. Submits one command
   * buffer; `environment.sh` and `irradianceAt` change at once. Bind groups of the environment stay valid.
   * Throws MargoError `state` while a source or the output is restoring or on another device.
   */
  update(): void {
    const device = this.live();
    checkSources(device, this.fromValue, this.toValue);
    const state = this.stateFor(device);
    const a = this.fromValue,
      b = this.toValue,
      sa = a.radianceScale,
      sb = b.radianceScale,
      // A source divided into half-float range (a sun) holds a stored peak of 60,000 at most, so the output is
      // divided by the weighted sum of the source scales and stays in range; otherwise the output is unscaled.
      bound = sa > 1 || sb > 1 ? Math.max(1, (1 - this.tValue) * a.intensity * sa + this.tValue * b.intensity * sb) : 1;
    this.environment.radianceScale = bound;
    // The stored factor (a float32), so the texels and SH below are divided by exactly what lighting multiplies back.
    const scale = this.environment.radianceScale,
      wa = ((1 - this.tValue) * a.intensity * sa) / scale,
      wb = (this.tValue * b.intensity * sb) / scale;
    const w = this.weightData;
    w.set([Math.cos(a.rotation), Math.sin(a.rotation), wa, 0, Math.cos(b.rotation), Math.sin(b.rotation), wb, 0]);
    device.queue.writeBuffer(state.weights, 0, w);
    for (const [target, key] of [
      [this.irradiance, 'irradiance'],
      [this.radiance, 'radiance'],
    ] as const) {
      rotateSH(a.sh[key], a.rotation, wa, target);
      rotateSH(b.sh[key], b.rotation, wb, target, true);
    }
    for (let k = 0; k < 9; k++)
      for (let c = 0; c < 3; c++) {
        this.shData[k * 4 + c] = this.irradiance[k * 3 + c];
        this.shData[36 + k * 4 + c] = this.radiance[k * 3 + c];
      }
    device.queue.writeBuffer(state.values, 0, this.shData);
    const sh = this.environment.sh;
    sh.irradiance.set(this.irradiance);
    sh.radiance.set(this.radiance);
    const p = pipelinesFor(device);
    const encoder = device.createCommandEncoder({ label: 'environment blend' });
    for (const pass of state.passes) {
      // view-state: offscreen blend target, independent of camera views.
      const render = encoder.beginRenderPass({
        label: 'environment blend',
        colorAttachments: [{ view: pass.target, loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 1] }],
      });
      render.setPipeline(p.blend);
      render.setBindGroup(0, pass.group);
      render.draw(3);
      render.end();
      if (pass.copy)
        encoder.copyTextureToTexture(
          { texture: state.scratch, mipLevel: pass.copy.mip },
          { texture: this.environment.cubeTexture, mipLevel: pass.copy.mip, origin: { x: 0, y: 0, z: pass.copy.face } },
          [pass.copy.edge, pass.copy.edge, 1],
        );
    }
    const compute = encoder.beginComputePass({ label: 'environment blend SH' });
    compute.setPipeline(p.sh);
    compute.setBindGroup(0, state.shGroup);
    compute.dispatchWorkgroups(1);
    compute.end();
    device.queue.submit([encoder.finish()]);
  }

  setup(engine: EngineKernel): void {
    if (this.disposed) throw new MargoError('disposed', 'EnvironmentBlend is disposed; create a new EnvironmentBlend');
    this.engine = engine;
    const device = engineRuntime(engine).gpu;
    if (!device) throw new MargoError('unsupported', 'EnvironmentBlend requires the WebGPU backend');
    if (this.environment.device !== device) this.onDeviceRestored(engine);
  }
  /** Restores both sources and the blended environment on the new device, then blends again. */
  onDeviceRestored(engine: EngineKernel): void {
    const device = engineRuntime(engine).gpu;
    if (!device || this.disposed) return;
    Promise.all([this.fromValue.restore(device), this.toValue.restore(device), this.environment.restore(device)]).then(
      () => this.restored(),
      (error) => engine.onError(error),
    );
  }
  /** Disposes the blended environment and the blend's GPU state; the two sources stay with their owner. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const off of this.unsubscribe) off();
    this.unsubscribe.length = 0;
    this.drop();
    this.environment.dispose();
  }
  declare [Symbol.dispose]: () => void;
  [(Symbol.dispose ?? Symbol()) as symbol](): void {
    this.dispose();
  }

  private live(): GPUDevice {
    if (this.disposed) throw new MargoError('disposed', 'EnvironmentBlend is disposed; create a new EnvironmentBlend');
    const device = this.environment.device;
    if (!device)
      throw new MargoError('state', 'EnvironmentBlend is being restored; wait for the device restore to finish');
    return device;
  }
  // Reblend once every part has resources on the output's device (sources and output restore in any order).
  private restored(): void {
    const device = this.environment.device;
    if (this.disposed || !device || this.fromValue.device !== device || this.toValue.device !== device) return;
    try {
      this.update();
    } catch (error) {
      if (this.engine) this.engine.onError(error);
      else throw error;
    }
  }
  private watch(): void {
    while (this.unsubscribe.length > 1) this.unsubscribe.pop()!();
    const changed = () => this.restored();
    this.unsubscribe.push(this.fromValue.onChange(changed));
    if (this.toValue !== this.fromValue) this.unsubscribe.push(this.toValue.onChange(changed));
  }
  private drop(): void {
    const s = this.state;
    if (!s) return;
    s.levels.destroy();
    s.weights.destroy();
    s.values.destroy();
    s.scratch.destroy();
    this.state = undefined;
  }
  private stateFor(device: GPUDevice): State {
    const a = this.fromValue,
      b = this.toValue,
      out = this.environment;
    const key = [device, a, a.version, a.cubeView, b, b.version, b.cubeView, out.version, out.cubeTexture];
    const s = this.state;
    if (s && s.key.length === key.length && s.key.every((v, i) => v === key[i])) return s;
    this.drop();
    const p = pipelinesFor(device);
    const cubeMips = out.cubeTexture.mipLevelCount,
      specularMips = out.specularMips;
    const levels = device.createBuffer({
      label: 'environment blend levels',
      size: (cubeMips + specularMips) * 6 * STRIDE,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    const weights = device.createBuffer({
      label: 'environment blend weights',
      size: 32,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    const values = device.createBuffer({
      label: 'environment blend SH',
      size: 288,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    const scratch = device.createTexture({
      label: 'environment blend scratch',
      size: [out.size, out.size],
      mipLevelCount: cubeMips,
      format: 'rgba16float',
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
    });
    const data = new DataView(new ArrayBuffer((cubeMips + specularMips) * 6 * STRIDE));
    const passes: State['passes'] = [];
    const layout = p.blend.getBindGroupLayout(0);
    // The cube passes read the sources' cubes, the specular passes their prefiltered specular cubes.
    const group = (index: number, specular: boolean) =>
      device.createBindGroup({
        layout,
        entries: [
          { binding: 0, resource: specular ? a.specularView : a.cubeView },
          { binding: 1, resource: specular ? b.specularView : b.cubeView },
          { binding: 2, resource: out.sampler },
          { binding: 3, resource: { buffer: levels, offset: index * STRIDE, size: 16 } },
          { binding: 4, resource: { buffer: weights } },
        ],
      });
    let index = 0;
    const level = (edge: number, face: number, lodA: number, lodB: number, specular = false) => {
      const o = index * STRIDE;
      data.setFloat32(o, edge, true);
      data.setUint32(o + 4, face, true);
      data.setFloat32(o + 8, lodA, true);
      data.setFloat32(o + 12, lodB, true);
      return group(index++, specular);
    };
    // Source cube: each output mip reads the source mip of the same texel size (exact when the sizes match).
    for (let mip = 0; mip < cubeMips; mip++) {
      const edge = Math.max(1, out.size >> mip),
        target = scratch.createView({ baseMipLevel: mip, mipLevelCount: 1 });
      const lodA = Math.max(0, Math.log2(a.size / edge)),
        lodB = Math.max(0, Math.log2(b.size / edge));
      for (let face = 0; face < 6; face++)
        passes.push({ group: level(edge, face, lodA, lodB), target, copy: { mip, face, edge } });
    }
    // Prefiltered specular: each output mip reads each source at the same roughness.
    for (let mip = 0; mip < specularMips; mip++) {
      const edge = Math.max(1, out.specularSize >> mip),
        roughness = specularMips > 1 ? mip / (specularMips - 1) : 0;
      for (let face = 0; face < 6; face++)
        passes.push({
          group: level(edge, face, a.roughnessToLod(roughness), b.roughnessToLod(roughness), true),
          target: out.specularTexture.createView({
            dimension: '2d',
            baseMipLevel: mip,
            mipLevelCount: 1,
            baseArrayLayer: face,
            arrayLayerCount: 1,
          }),
        });
    }
    device.queue.writeBuffer(levels, 0, data);
    const shGroup = device.createBindGroup({
      layout: p.sh.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: values } },
        { binding: 1, resource: { buffer: out.shBuffer } },
      ],
    });
    return (this.state = { device, key, levels, weights, values, scratch, passes, shGroup });
  }
}

const isDevice = (target: GPUDevice | EngineKernel): target is GPUDevice =>
  typeof (target as GPUDevice).createTexture === 'function';

function checkT(t: number): number {
  if (!(t >= 0 && t <= 1)) throw new RangeError('EnvironmentBlend t must be a number from 0 to 1');
  return t;
}

function checkSources(device: GPUDevice, from: Environment, to: Environment): void {
  for (const source of [from, to]) {
    if (!source || typeof source.onChange !== 'function')
      throw new TypeError('EnvironmentBlend needs two Environments');
    if (source.disposed)
      throw new MargoError('disposed', 'EnvironmentBlend source is disposed; pass a live Environment');
    if (source.device !== device)
      throw new MargoError(
        'state',
        source.device
          ? 'EnvironmentBlend sources must live on the blend device; create them on the same engine or device'
          : 'EnvironmentBlend source is being restored; wait for its device restore to finish',
      );
  }
}
