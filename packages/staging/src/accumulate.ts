/// <reference lib="esnext.disposable" preserve="true" />
import type { EngineKernel } from '@margoengine/core';
import { engineRuntime, type Engine, type PassContext, type Vec3 } from '@margoengine/core/extension';
import { ContactShadows, type ContactPrimitive, type ContactShadowOptions } from './index.js';
import { fullscreen, group, render } from '../../shared/gpu.js';
import { fault, rangeError } from '../../shared/errors.js';

declare const GPUBufferUsage: { UNIFORM: number; COPY_DST: number };
declare const GPUTextureUsage: { RENDER_ATTACHMENT: number; TEXTURE_BINDING: number; COPY_SRC: number };
type Context = Extract<PassContext, { backend: 'webgpu' }>;

/** Accumulated planar shadow settings; the inherited receiver options keep their defaults. */
export interface AccumulatedShadowOptions extends ContactShadowOptions {
  /** World centre of a disk light parallel to the receiver, above all casters along `up`. Default 8 * normalized up. */
  lightPosition?: Vec3;
  /** Disk radius in world units; 0 gives one hard-shadow projection. Default 2. */
  lightRadius?: number;
  /** One light sample per rendered frame, then hold the finished texture. Integer 1..1024; default 64. */
  frames?: number;
  /** Must be 0: penumbrae come from light sampling, without a spatial blur. Default 0. */
  blur?: 0;
  /** Must be false: the entry manages progressive caching itself. Default false. */
  static?: false;
}

const sumShader = `${fullscreen}
struct State {count:vec4f}
@group(0) @binding(0) var<uniform> state:State;
@group(0) @binding(1) var sampleImage:texture_2d<f32>;
@group(0) @binding(2) var previous:texture_2d<f32>;
@fragment fn fragment(v:Vertex)->@location(0) vec4f {
 let pixel=vec2i(v.position.xy);
 var sum=textureLoad(sampleImage,pixel,0).r;
 if(state.count.x>0.0){sum+=textureLoad(previous,pixel,0).r;}
 return vec4f(sum,0,0,1);
}`;

// Bounded to 11 iterations at the 1024-frame cap; no mesh or image processing on the CPU.
const radicalInverse = (value: number): number => {
  let result = 0, weight = 0.5;
  while (value > 0) {
    result += (value & 1) * weight;
    value = Math.floor(value / 2);
    weight *= 0.5;
  }
  return result;
};

/**
 * Averages hard shadows from a disk of light positions over frames. The penumbra grows with distance
 * above the receiving plane. Equal visibility weights, not a full radiometric area-light solution.
 */
export class AccumulatedShadows extends ContactShadows {
  override readonly name = 'accumulated-shadows';
  declare readonly options: AccumulatedShadowOptions;
  private count = 0;
  private lightKey = '';
  private result?: GPUTextureView;
  private history?: { size: number; textures: GPUTexture[]; views: GPUTextureView[] };
  private sums?: GPURenderPipeline;
  private uniform?: GPUBuffer;
  private bindings?: GPUBindGroup[];
  private readonly state = new Float32Array(4);
  private readonly matrix = new Float32Array(16);

  /** Validates options before attachment; input is copied, then `options` can be edited live. */
  constructor(options: AccumulatedShadowOptions = {}) {
    if (!options || typeof options !== 'object' || Array.isArray(options))
      throw rangeError('Invalid accumulated shadow options; pass an options object', 'arguments');
    super({ ...options, blur: options.blur ?? 0, static: options.static ?? false });
    this.validate();
  }

  /** Creates and registers the accumulator; native WebGL2 rejects with linked `unsupported`. */
  static override attach(engine: EngineKernel, options: AccumulatedShadowOptions = {}): AccumulatedShadows {
    const value = new AccumulatedShadows(options);
    engineRuntime(engine).use(value);
    return value;
  }

  /** Samples in the current history, reset by invalidation, geometry changes or light/receiver edits. */
  get samples(): number { return this.count; }

  /** Resets history for an in-place geometry or pose edit that has no changed transform/buffer. */
  override invalidate(): void {
    this.count = 0;
    super.invalidate();
  }

  override setup(engine: Engine): void {
    if (!engine.gpu) throw fault('unsupported', 'AccumulatedShadows needs WebGPU or the WebGL2 compatibility layer; select one of those backends');
    super.setup(engine);
    this.uniform = engine.gpu.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  }

  override onDeviceRestored(engine: Engine): void {
    this.releaseHistory();
    super.onDeviceRestored(engine);
  }

  /** Removes the plugin and releases all owned resources; repeat calls are safe. */
  override dispose(): void {
    this.releaseHistory();
    super.dispose();
  }

  protected override coverage(_depth: string): string { return '1'; }
  protected override coverageScale(): number { return this.count ? 1 / this.count : 1; }
  protected override needsUpdate(_s: ReturnType<AccumulatedShadows['settings']>, changed: boolean): boolean {
    return changed || this.count < (this.options.frames ?? 64);
  }

  protected override changed(draws: readonly ContactPrimitive[], s: ReturnType<AccumulatedShadows['settings']>): boolean {
    this.validate();
    const changed = super.changed(draws, s);
    const key = [...this.light(s), this.options.lightRadius ?? 2, this.options.frames ?? 64].join('|');
    if (changed || key !== this.lightKey) this.count = 0;
    this.lightKey = key;
    return changed;
  }

  protected override projection(s: ReturnType<AccumulatedShadows['settings']>): Float32Array {
    const light = this.light(s), center = [s.x,s.ground,s.z];
    const local = (axis: readonly number[]) => axis.reduce((sum, v, i) => sum + v*(light[i]-center[i]), 0);
    const H = local(s.normal);
    const r = (this.options.lightRadius ?? 2) * Math.sqrt(radicalInverse(this.count + 1));
    const angle = (this.count + 1) * Math.PI * (3 - Math.sqrt(5));
    const x = local(s.u) + r * Math.cos(angle), z = local(s.v) + r * Math.sin(angle);
    const m = this.matrix;
    m.fill(0);
    for (let i=0;i<3;i++) {
      m[4*i] = 2*(H*s.u[i]-x*s.normal[i])/s.width;
      m[4*i+1] = 2*(H*s.v[i]-z*s.normal[i])/s.depth;
      m[4*i+2] = (H-s.height)*s.normal[i]/s.height;
      m[4*i+3] = -s.normal[i];
    }
    for (let row=0;row<4;row++) m[12+row] = (row===3?H:0)-center.reduce((sum,v,i)=>sum+m[4*i+row]*v,0);
    return m;
  }

  protected override update(c: Context, draws: readonly ContactPrimitive[], s: ReturnType<AccumulatedShadows['settings']>): GPUTextureView {
    if (this.count >= (this.options.frames ?? 64)) return this.result!;
    const sample = super.update(c, draws, s);
    if (!this.history || this.history.size !== s.resolution) {
      for (const t of this.history?.textures ?? []) t.destroy();
      const textures = [0,1].map(() => c.device.createTexture({size: [s.resolution,s.resolution], format: 'r16float',
        usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_SRC}));
      this.history = {size: s.resolution, textures, views: textures.map(t => t.createView())};
      this.bindings = undefined;
    }
    this.sums ??= render(c.device, sumShader, 'r16float');
    this.bindings ??= [0,1].map(i => group(c.device, this.sums!, [{buffer: this.uniform!},sample,this.history!.views[1-i]]));
    this.state[0] = this.count;
    c.device.queue.writeBuffer(this.uniform!, 0, this.state);
    const index = this.count & 1;
    // view-state: offscreen receiver history sum, full local target.
    const pass = c.encoder.beginRenderPass({colorAttachments: [{view: this.history.views[index],loadOp:'clear',storeOp:'store'}]});
    pass.setPipeline(this.sums);
    pass.setBindGroup(0, this.bindings[index]);
    pass.draw(3);
    pass.end();
    this.count++;
    return this.result = this.history.views[index];
  }

  private validate(): void {
    const s = this.settings(), o = this.options, light = this.light(s);
    if (!Array.isArray(light) || light.length !== 3 || ![0,1,2].every(i => Number.isFinite(light[i]) && Math.abs(light[i]) <= 1e6) ||
      !(Math.fround(s.normal.reduce((sum,v,i)=>sum+v*(light[i]-[s.x,s.ground,s.z][i]),0)) > Math.fround(s.height)) ||
      !Number.isFinite(o.lightRadius ?? 2) || (o.lightRadius ?? 2) < 0 || (o.lightRadius ?? 2) > 1e6 ||
      !Number.isInteger(o.frames ?? 64) || (o.frames ?? 64) < 1 || (o.frames ?? 64) > 1024 ||
      s.blur !== 0 || Boolean(o.static) ||
      ![s.x,s.ground,s.z,s.width,s.depth,s.height].every(v => Math.abs(v) <= 1e6) ||
      Math.min(s.width,s.depth,s.height) < 1e-6)
      throw rangeError('Invalid accumulated shadow options; use frames 1..1024, blur 0, static false, receiver sizes 1e-6..1e6 and a finite disk light above the caster height', 'arguments');
  }

  private light(s: ReturnType<AccumulatedShadows['settings']>): readonly number[] {
    return this.options.lightPosition ?? s.normal.map(v => 8*v);
  }

  private releaseHistory(): void {
    for (const t of this.history?.textures ?? []) t.destroy();
    this.uniform?.destroy();
    this.history = this.bindings = this.sums = this.uniform = this.result = undefined;
    this.count = 0;
    this.lightKey = '';
  }
}
