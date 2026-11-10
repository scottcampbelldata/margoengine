/// <reference lib="esnext.disposable" preserve="true" />
// Canonical-space procedural deformation, followed by a colour hook after view-dependent SH evaluation.
import type { EngineKernel } from '@margoengine/core';
import {
  engineRuntime,
  type Engine,
  type EnginePlugin,
  type FrameGraph,
  type PassContext,
} from '@margoengine/core/extension';
import { MargoError } from '@margoengine/math/errors';
import { validateSplats, type SplatData } from './data.js';
import type { Splats } from './index.js';

declare const GPUBufferUsage: { UNIFORM: number; STORAGE: number; COPY_DST: number; COPY_SRC: number };
type Context = Extract<PassContext, { backend: 'webgpu' }>;

/** WGSL function bodies of a per-frame splat modifier. All hooks can read time, delta and u.parameters[0..15]. */
export interface SplatModifierOptions {
  /** WGSL body returning vec3f; arguments index:u32 and position:vec3f (canonical centre). Default return position. */
  position?: string;
  /** WGSL body returning f32; arguments index:u32, position:vec3f (modified) and opacity:f32 (canonical). Default return opacity. */
  opacity?: string;
  /** WGSL body returning vec3f; arguments index:u32, position:vec3f (modified) and color:vec3f (evaluated linear SH/fog). Default return color. */
  color?: string;
  /** Shared WGSL functions/constants, appended to both modules. Default empty. */
  declarations?: string;
  /** Initial values of the 64 live parameter floats. Default all zero; remaining floats are zero. */
  parameters?: ArrayLike<number>;
  /** Cancels creation and disposes the modifier when aborted. */
  signal?: AbortSignal;
}

/** Builds the pre-projection position/opacity and post-projection colour compute modules. */
export function splatModifierShaders(options: SplatModifierOptions = {}): { position: string; color: string } {
  for (const key of ['position', 'opacity', 'color', 'declarations'] as const)
    if (
      options[key] !== undefined &&
      (typeof options[key] !== 'string' || (key !== 'declarations' && !options[key]!.trim()))
    )
      throw new TypeError(
        'Splat modifier hooks must be nonempty WGSL strings; pass function bodies returning the documented types',
      );
  const header = `struct ModifierFrame {clock:vec4f,counts:vec4u,parameters:array<vec4f,16>}
@group(0) @binding(0) var<uniform> u:ModifierFrame;
${options.declarations ?? ''}`,
    clock = 'let time=u.clock.x;let delta=u.clock.y;';
  return {
    position:
      header +
      `
@group(0) @binding(1) var<storage,read> canonical:array<vec4f>;
@group(0) @binding(2) var<storage,read_write> positions:array<vec4f>;
@group(0) @binding(3) var<storage,read_write> sourceColors:array<vec4f>;
fn modifyPosition(index:u32,position:vec3f)->vec3f {${clock}${options.position ?? 'return position;'}}
fn modifyOpacity(index:u32,position:vec3f,opacity:f32)->f32 {${clock}${options.opacity ?? 'return opacity;'}}
@compute @workgroup_size(256) fn main(@builtin(global_invocation_id) id:vec3u) {
 let index=id.x;if(index>=u.counts.x){return;}let rest=canonical[index];var result=rest;
 if(u.clock.z>0.5){result=vec4f(modifyPosition(index,rest.xyz),rest.w);result.w=clamp(modifyOpacity(index,result.xyz,rest.w),0.0,1.5625);}
 positions[index]=result;
 sourceColors[index]=vec4f(sourceColors[index].rgb,result.w);
}`,
    color:
      header +
      `
@group(0) @binding(1) var<storage,read> positions:array<vec4f>;
@group(0) @binding(2) var<storage,read_write> evaluated:array<vec4f>;
fn modifyColor(index:u32,position:vec3f,color:vec3f)->vec3f {${clock}${options.color ?? 'return color;'}}
@compute @workgroup_size(256) fn main(@builtin(global_invocation_id) id:vec3u) {
 let index=id.x;if(index>=u.counts.x||u.clock.z<0.5){return;}let original=evaluated[index];
 evaluated[index]=vec4f(max(vec3f(0),modifyColor(index,positions[index].xyz,original.rgb)),original.a);
}`,
  };
}

/** One live modifier per cloud, so effects never silently overwrite another modifier's canonical data. */
const owners = new WeakMap<Splats, SplatModifier>();

/**
 * A GPU modifier with independent position, opacity and evaluated-colour hooks. Create/attach asynchronously to
 * snapshot canonical centres and opacity once. Geometry runs before projection/sorting; colour runs after SH/fog
 * and before relighting. Source colours, SH and covariances are preserved. Each frame starts at the canonical data.
 */
export class SplatModifier implements EnginePlugin {
  private static next = 0;
  readonly name = 'splats-modifier:' + SplatModifier.next++;
  readonly cloud: Splats;
  /** 64 live floats, exposed to WGSL as u.parameters:array<vec4f,16>. */
  readonly parameters = new Float32Array(64);
  /** Effect clock in seconds; manually seek while playing is false. Default 0. */
  time = 0;
  /** Advance time once per frame. Default true. */
  playing = true;
  /** Clock multiplier, including negative playback. Default 1. */
  speed = 1;
  /** False restores canonical geometry and skips colour modification. Default true. */
  enabled = true;
  private readonly canonical: Float32Array;
  private readonly shaders: { position: string; color: string };
  private readonly values = new Float32Array(72);
  private readonly integers = new Uint32Array(this.values.buffer);
  private engine?: Engine;
  private device?: GPUDevice;
  private uniform?: GPUBuffer;
  private rest?: GPUBuffer;
  private pipelines: GPUComputePipeline[] = [];
  private groups: GPUBindGroup[] = [];
  private bound?: GPUBuffer;
  private evaluated?: GPUBuffer;
  private dead = false;
  private readonly signal?: AbortSignal;
  private readonly abort?: () => void;
  private constructor(cloud: Splats, data: SplatData, options: SplatModifierOptions) {
    this.cloud = cloud;
    this.shaders = splatModifierShaders(options);
    this.canonical = new Float32Array(cloud.count * 4);
    this.setRest(data);
    if (options.parameters !== undefined) {
      if (
        !Number.isSafeInteger(options.parameters.length) ||
        options.parameters.length > 64 ||
        options.parameters.length < 0
      )
        throw new RangeError('Splat modifier takes up to 64 parameter floats; shorten the parameter list');
      for (let i = 0; i < options.parameters.length; i++) {
        if (!Number.isFinite(Math.fround(options.parameters[i])))
          throw new RangeError('Splat modifier parameters must be finite; fix the parameter values');
        this.parameters[i] = options.parameters[i];
      }
    }
    this.signal = options.signal;
    this.abort = options.signal ? () => this.dispose() : undefined;
    options.signal?.addEventListener('abort', this.abort!, { once: true });
  }
  /** Snapshots a cloud's current GPU/CPU data once, with caller cancellation; returns an unattached plugin. */
  static async create(cloud: Splats, options: SplatModifierOptions = {}): Promise<SplatModifier> {
    if (!cloud || typeof cloud.read !== 'function' || !Number.isInteger(cloud.count))
      throw new TypeError('SplatModifier needs a Splats cloud; pass the cloud to modify');
    options.signal?.throwIfAborted();
    splatModifierShaders(options);
    const signal = options.signal,
      read = cloud.read();
    const data = await new Promise<SplatData>((resolve, reject) => {
      const abort = () => {
        signal?.removeEventListener('abort', abort);
        reject(signal!.reason);
      };
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) abort();
      read.then(resolve, reject).finally(() => signal?.removeEventListener('abort', abort));
    });
    signal?.throwIfAborted();
    return new SplatModifier(cloud, data, options);
  }
  /** Creates the canonical snapshot, then attaches the modifier to engine. */
  static async attach(engine: EngineKernel, cloud: Splats, options: SplatModifierOptions = {}): Promise<SplatModifier> {
    const modifier = await SplatModifier.create(cloud, options);
    try {
      options.signal?.throwIfAborted();
      engineRuntime(engine).use(modifier);
      return modifier;
    } catch (error) {
      modifier.dispose();
      throw error;
    }
  }
  /** Replaces canonical centres/opacity from a complete cloud of the same count. Other attributes remain the cloud's. */
  setRest(data: SplatData): this {
    if (this.dead) throw new MargoError('disposed', 'Splat modifier was disposed; create a new modifier');
    if (validateSplats(data) !== this.cloud.count)
      throw new RangeError('Canonical splat count differs from the cloud; pass a full cloud of the same count');
    for (let i = 0; i < this.cloud.count; i++) {
      this.canonical.set(data.positions.subarray(i * 3, i * 3 + 3), i * 4);
      this.canonical[i * 4 + 3] = data.colors[i * 4 + 3];
    }
    if (this.rest) this.device!.queue.writeBuffer(this.rest, 0, this.canonical as Float32Array<ArrayBuffer>);
    return this;
  }
  setup(engine: Engine): void {
    if (this.dead || !engine.gpu)
      throw new MargoError(
        this.dead ? 'disposed' : 'unsupported',
        'SplatModifier needs a live WebGPU engine; see https://margoengine.com/errors#webgpu',
      );
    if (owners.has(this.cloud) && owners.get(this.cloud) !== this)
      throw new MargoError('attached', 'This cloud already has a modifier; combine its WGSL hooks or dispose it first');
    const device = engine.gpu;
    this.engine = engine;
    this.device = device;
    this.uniform = device.createBuffer({
      size: this.values.byteLength,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this.rest = device.createBuffer({
      size: this.canonical.byteLength,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(this.rest, 0, this.canonical as Float32Array<ArrayBuffer>);
    this.pipelines = [this.shaders.position, this.shaders.color].map((code) =>
      device.createComputePipeline({
        layout: 'auto',
        compute: { module: device.createShaderModule({ code }), entryPoint: 'main' },
      }),
    );
    owners.set(this.cloud, this);
  }
  registerPasses(graph: FrameGraph): void {
    for (const [stage, order] of [
      [0, -7.25],
      [1, -6.95],
    ] as const)
      graph.add({
        name: this.name + ':' + stage,
        order,
        execute: (c) => {
          if (c.backend === 'webgpu' && this.cloud.attached) this.run(c, stage);
        },
      });
  }
  private run(c: Context, stage: number): void {
    if (stage === 0) {
      if (!c.view?.index && this.playing) this.time += c.delta * this.speed;
      if (
        !Number.isFinite(Math.fround(this.time)) ||
        !Number.isFinite(Math.fround(c.delta)) ||
        !Number.isFinite(this.speed) ||
        !this.parameters.every(Number.isFinite)
      )
        throw new RangeError('Modifier clock and parameters must be finite; fix time, speed or parameter values');
      this.values.set([this.time, c.delta, +this.enabled, 0]);
      this.integers[4] = this.cloud.count;
      this.values.set(this.parameters, 8);
      c.device.queue.writeBuffer(this.uniform!, 0, this.values);
    }
    const state = this.cloud.gpuState;
    if (this.bound !== state.positions || this.evaluated !== state.colors) {
      this.groups = [
        [this.uniform!, this.rest!, state.positions, state.inputColors],
        [this.uniform!, state.positions, state.colors],
      ].map((buffers, i) =>
        c.device.createBindGroup({
          layout: this.pipelines[i].getBindGroupLayout(0),
          entries: buffers.map((buffer, binding) => ({ binding, resource: { buffer } })),
        }),
      );
      this.bound = state.positions;
      this.evaluated = state.colors;
    }
    const pass = c.encoder.beginComputePass();
    pass.setPipeline(this.pipelines[stage]);
    pass.setBindGroup(0, this.groups[stage]);
    pass.dispatchWorkgroups(Math.ceil(this.cloud.count / 256));
    pass.end();
  }
  /** True after disposal. */
  get disposed(): boolean {
    return this.dead;
  }
  private release(): void {
    this.uniform?.destroy();
    this.rest?.destroy();
    this.uniform = this.rest = this.bound = this.evaluated = undefined;
    this.groups = [];
    this.pipelines = [];
  }
  onDeviceRestored(engine: Engine): void {
    this.release();
    this.setup(engine);
  }
  /** Restores canonical centres/opacity, removes the passes and releases GPU buffers. Idempotent. */
  dispose(): void {
    if (this.dead) return;
    this.dead = true;
    if (this.cloud.attached && this.bound === this.cloud.gpuState.positions && this.device && this.rest) {
      const encoder = this.device.createCommandEncoder();
      this.values[2] = 0;
      this.integers[4] = this.cloud.count;
      this.device.queue.writeBuffer(this.uniform!, 0, this.values);
      const pass = encoder.beginComputePass();
      pass.setPipeline(this.pipelines[0]);
      pass.setBindGroup(0, this.groups[0]);
      pass.dispatchWorkgroups(Math.ceil(this.cloud.count / 256));
      pass.end();
      this.device.queue.submit([encoder.finish()]);
    }
    if (owners.get(this.cloud) === this) owners.delete(this.cloud);
    this.signal?.removeEventListener('abort', this.abort!);
    this.engine?.sceneOf(this)?.removePlugin(this.name);
    this.release();
    this.engine = this.device = undefined;
  }
  declare [Symbol.dispose]: () => void;
  [(Symbol.dispose ?? Symbol()) as symbol](): void {
    this.dispose();
  }
}
