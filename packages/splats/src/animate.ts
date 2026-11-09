/// <reference lib="esnext.disposable" preserve="true" />
// @margoengine/splats/animate: captured performances as splats. `SplatSequence` plays a 4D capture, a list of frames
// of the same splats, by linear interpolation of centres, covariances, colours and opacity between the two frames
// around the play time (a convex mix of positive-definite covariances stays positive definite). `SplatSkin` poses a
// cloud with a skeleton by linear blend skinning: each splat's centre by the weighted sum of up to four joint
// matrices, and its covariance by the same blended linear part, A S A^T (Magnenat-Thalmann et al. 1988, "Joint-
// dependent local deformations for hand animation and object grasping", Graphics Interface; the covariance transform
// of a Gaussian under a linear map, as in Zwicker et al. 2001, "EWA Splatting"). Both run as one compute pass before
// the cloud projects (order -7.5) and write the cloud's GPU inputs, so depth sorting, lighting and editing see the pose.
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

declare const GPUBufferUsage: { UNIFORM: number; COPY_DST: number; COPY_SRC: number; STORAGE: number };
type Context = Extract<PassContext, { backend: 'webgpu' }>;

/** Options of {@link SplatSequence}. */
export interface SplatSequenceOptions {
  /** Frames per second of the capture. Default 30. */
  fps?: number;
  /** Start again after the last frame (true, the default) or hold it. */
  loop?: boolean;
}

/**
 * WGSL of the sequence pass: frames a and b (per splat: centre and opacity, two covariance vec4s, colour) mixed by
 * `u.mix.x` into the cloud's positions, covariances and colours.
 */
export const sequenceShader = `struct Mix {mix:vec4f,counts:vec4u}
@group(0) @binding(0) var<uniform> u:Mix;
@group(0) @binding(1) var<storage,read> a:array<vec4f>;
@group(0) @binding(2) var<storage,read> b:array<vec4f>;
@group(0) @binding(3) var<storage,read_write> positions:array<vec4f>;
@group(0) @binding(4) var<storage,read_write> covariances:array<vec4f>;
@group(0) @binding(5) var<storage,read_write> colors:array<vec4f>;
@compute @workgroup_size(256) fn main(@builtin(global_invocation_id) id:vec3u) {
  let i=id.x;if(i>=u.counts.x){return;}let t=u.mix.x;
  positions[i]=mix(a[i*4],b[i*4],t);covariances[i*2]=mix(a[i*4+1],b[i*4+1],t);covariances[i*2+1]=mix(a[i*4+2],b[i*4+2],t);
  colors[i]=mix(a[i*4+3],b[i*4+3],t);
}`;

/** Packs a frame as the sequence pass reads it: 16 floats per splat. */
function pack(data: SplatData, count: number): Float32Array {
  if (validateSplats(data) !== count)
    throw new RangeError(
      `Every sequence frame needs ${count} splats, as the cloud has; pass frames of the same splats`,
    );
  const out = new Float32Array(count * 16);
  for (let i = 0; i < count; i++) {
    out.set(data.positions.subarray(i * 3, i * 3 + 3), i * 16);
    out[i * 16 + 3] = data.colors[i * 4 + 3];
    out.set(data.covariances.subarray(i * 6, i * 6 + 6), i * 16 + 4);
    out.set(data.colors.subarray(i * 4, i * 4 + 4), i * 16 + 12);
  }
  return out;
}

/** The plugin plumbing both players share: setup checks, the pass at order -7.5, dispose. */
abstract class Player implements EnginePlugin {
  abstract readonly name: string;
  readonly cloud: Splats;
  protected engine?: Engine;
  protected device?: GPUDevice;
  protected uniform?: GPUBuffer;
  protected pipeline?: GPUComputePipeline;
  protected buffers: GPUBuffer[] = [];
  protected dead = false;
  constructor(cloud: Splats, what: string) {
    if (!cloud || typeof cloud !== 'object' || !('gpuState' in cloud))
      throw new TypeError(`${what} needs a Splats cloud`);
    this.cloud = cloud;
  }
  setup(engine: Engine): void {
    if (this.dead || !engine.gpu)
      throw new MargoError(
        this.dead ? 'disposed' : 'unsupported',
        'Splat animation needs WebGPU; attach a new player to a WebGPU engine; see https://margoengine.com/errors#webgpu',
      );
    this.engine = engine;
    this.device = engine.gpu;
    this.uniform = this.buffer(256, GPUBufferUsage.UNIFORM);
  }
  protected buffer(size: number, usage: number, data?: Float32Array | Uint32Array): GPUBuffer {
    const b = this.device!.createBuffer({ size: Math.max(16, size), usage: usage | GPUBufferUsage.COPY_DST });
    if (data) this.device!.queue.writeBuffer(b, 0, data as Float32Array<ArrayBuffer>);
    this.buffers.push(b);
    return b;
  }
  protected compute(code: string): GPUComputePipeline {
    return (this.pipeline ??= this.device!.createComputePipeline({
      layout: 'auto',
      compute: { module: this.device!.createShaderModule({ code }), entryPoint: 'main' },
    }));
  }
  registerPasses(graph: FrameGraph): void {
    graph.add({
      name: this.name,
      order: -7.5,
      execute: (c) => {
        if (c.backend === 'webgpu' && this.cloud.attached) this.pose(c, !c.view?.index);
      },
    });
  }
  /** Writes the pose into the cloud's inputs; `first` is the frame's first view (time advances once a frame). */
  protected abstract pose(c: Context, first: boolean): void;
  protected run(e: GPUCommandEncoder, group: GPUBindGroup): void {
    const pass = e.beginComputePass();
    pass.setPipeline(this.pipeline!);
    pass.setBindGroup(0, group);
    pass.dispatchWorkgroups(Math.ceil(this.cloud.count / 256));
    pass.end();
  }
  protected release(): void {
    for (const b of this.buffers) b.destroy();
    this.buffers = [];
    this.uniform = this.pipeline = undefined;
  }
  onDeviceRestored(engine: Engine): void {
    this.release();
    this.setup(engine);
  }
  /** True once disposed. */
  get disposed(): boolean {
    return this.dead;
  }
  dispose(): void {
    if (this.dead) return;
    this.dead = true;
    this.engine?.removePlugin(this.name);
    this.release();
    this.engine = this.device = undefined;
  }
  declare [Symbol.dispose]: () => void;
  [(Symbol.dispose ?? Symbol()) as symbol](): void {
    this.dispose();
  }
}

/**
 * Plays a 4D splat capture: `SplatSequence.attach(engine, cloud, frames, { fps })`, with `frames` a list of clouds of
 * the cloud's splats in the same order. Each frame the cloud draws the mix of the two frames around `time` (centres,
 * covariances, colours and opacity; SH stays the cloud's). `playing`, `time` and `speed` are live. All frames live on
 * the GPU, 64 bytes per splat each. WebGPU only, as `Splats`.
 * @throws TypeError when `cloud` is not a Splats; RangeError for no frames, a frame of another splat count or an
 * invalid one, or an fps that is not above 0; MargoError `'unsupported'` on a WebGL engine.
 */
export class SplatSequence extends Player {
  private static next = 0;
  readonly name = 'splats-sequence:' + SplatSequence.next++;
  /** Frames per second of the capture. */
  readonly fps: number;
  /** Start again after the last frame, or hold it. Live. */
  loop: boolean;
  /** Play time in seconds, advanced by each frame's delta times `speed` while `playing`. Live. */
  time = 0;
  /** Play rate (1 real time, negative backwards). Live. */
  speed = 1;
  /** Advance `time` each frame. Live. */
  playing = true;
  private readonly frames: Float32Array[];
  private readonly values = new Float32Array(8);
  private readonly integers = new Uint32Array(this.values.buffer);
  private groups: Array<{ group: GPUBindGroup; positions: GPUBuffer } | undefined> = [];
  private gpuFrames: GPUBuffer[] = [];
  constructor(cloud: Splats, frames: readonly SplatData[], options: SplatSequenceOptions = {}) {
    super(cloud, 'SplatSequence');
    if (!Array.isArray(frames) || !frames.length)
      throw new RangeError('SplatSequence needs one frame or more; pass a list of clouds');
    const fps = options.fps ?? 30;
    if (!(fps > 0 && Number.isFinite(fps)))
      throw new RangeError('SplatSequence fps must be above 0; pass the capture rate');
    this.fps = fps;
    this.loop = options.loop ?? true;
    this.frames = frames.map((f) => pack(f, cloud.count));
  }
  /** Same as `engine.use(new SplatSequence(cloud, frames, options))`; returns it. */
  static attach(
    engine: EngineKernel,
    cloud: Splats,
    frames: readonly SplatData[],
    options: SplatSequenceOptions = {},
  ): SplatSequence {
    const sequence = new SplatSequence(cloud, frames, options);
    engineRuntime(engine).use(sequence);
    return sequence;
  }
  /** Number of frames. */
  get length(): number {
    return this.frames.length;
  }
  /** Length of the capture in seconds: frames / fps. */
  get duration(): number {
    return this.frames.length / this.fps;
  }
  /** The two frames and the mix between them at `time` (looped or held). */
  sample(time = this.time): { from: number; to: number; mix: number } {
    const n = this.frames.length;
    let f = time * this.fps;
    if (this.loop) f = ((f % n) + n) % n;
    else f = Math.min(Math.max(f, 0), n - 1);
    const from = Math.floor(f),
      to = this.loop ? (from + 1) % n : Math.min(from + 1, n - 1);
    return { from, to, mix: f - from };
  }
  override setup(engine: Engine): void {
    super.setup(engine);
    this.gpuFrames = this.frames.map((f) => this.buffer(f.byteLength, GPUBufferUsage.STORAGE, f));
    this.groups = [];
  }
  protected pose(c: Context, first: boolean): void {
    if (first && this.playing) this.time += c.delta * this.speed;
    const { from, to, mix } = this.sample(),
      state = this.cloud.gpuState,
      pipeline = this.compute(sequenceShader);
    // A group per frame pair (from, from + 1), remade when the cloud hands new buffers.
    let record = this.groups[from * this.frames.length + to];
    if (!record || record.positions !== state.positions) {
      record = {
        group: this.device!.createBindGroup({
          layout: pipeline.getBindGroupLayout(0),
          entries: [
            this.uniform!,
            this.gpuFrames[from],
            this.gpuFrames[to],
            state.positions,
            state.covariances,
            state.inputColors,
          ].map((buffer, binding) => ({ binding, resource: { buffer } })),
        }),
        positions: state.positions,
      };
      this.groups[from * this.frames.length + to] = record;
    }
    this.values[0] = mix;
    this.integers[4] = this.cloud.count;
    this.device!.queue.writeBuffer(this.uniform!, 0, this.values);
    this.run(c.encoder, record.group);
  }
  protected override release(): void {
    super.release();
    this.gpuFrames = [];
    this.groups = [];
  }
}

/** Options of {@link SplatSkin}. */
export interface SplatSkinOptions {
  /** Joint count: `matrices` holds 16 floats for each. */
  joints: number;
  /** Four joint indices per splat (unused slots take weight 0). */
  indices: ArrayLike<number>;
  /** Four weights per splat; each splat's are normalised to sum 1 (all zero keeps the splat at rest). */
  weights: ArrayLike<number>;
}

/**
 * WGSL of the skinning pass: the rest pose (copied from the cloud when bound) times the blend of up to four joint
 * matrices per splat, centres by the whole matrix and covariances by its linear part, A S A^T.
 */
export const skinShader = `struct Skin {counts:vec4u}
@group(0) @binding(0) var<uniform> u:Skin;
@group(0) @binding(1) var<storage,read> matrices:array<mat4x4f>;
@group(0) @binding(2) var<storage,read> influence:array<vec4f>;
@group(0) @binding(3) var<storage,read> restPositions:array<vec4f>;
@group(0) @binding(4) var<storage,read> restCovariances:array<vec4f>;
@group(0) @binding(5) var<storage,read_write> positions:array<vec4f>;
@group(0) @binding(6) var<storage,read_write> covariances:array<vec4f>;
@compute @workgroup_size(256) fn main(@builtin(global_invocation_id) id:vec3u) {
  let i=id.x;if(i>=u.counts.x){return;}let j=bitcast<vec4u>(influence[i*2]);let w=influence[i*2+1];
  var m=matrices[j.x]*w.x+matrices[j.y]*w.y+matrices[j.z]*w.z+matrices[j.w]*w.w;
  if(w.x+w.y+w.z+w.w<=0){m=mat4x4f(vec4f(1,0,0,0),vec4f(0,1,0,0),vec4f(0,0,1,0),vec4f(0,0,0,1));}
  let p=restPositions[i];positions[i]=vec4f((m*vec4f(p.xyz,1)).xyz,positions[i].w);
  let a=restCovariances[i*2];let b=restCovariances[i*2+1];let s=mat3x3f(vec3f(a.x,a.y,a.z),vec3f(a.y,a.w,b.x),vec3f(a.z,b.x,b.y));
  let l=mat3x3f(m[0].xyz,m[1].xyz,m[2].xyz);let c=l*s*transpose(l);
  covariances[i*2]=vec4f(c[0].x,c[0].y,c[0].z,c[1].y);covariances[i*2+1]=vec4f(c[1].z,c[2].z,0,0);
}`;

/**
 * Poses a splat cloud with a skeleton by linear blend skinning: `const skin = SplatSkin.attach(engine, cloud,
 * { joints, indices, weights })`, then set `skin.matrices` (16 floats per joint, column-major, rest space to posed
 * world) each frame, from `@margoengine/animation` or your own rig. The cloud's centres and covariances when it is
 * first posed (or after `rebind()`) are the rest pose; opacity and colours are kept. WebGPU only, as `Splats`.
 * @throws TypeError when `cloud` is not a Splats; RangeError for a joint count outside 1 to 65,536, indices or
 * weights of another length than 4 per splat, an index outside the joints, or a negative or non-finite weight;
 * MargoError `'unsupported'` on a WebGL engine.
 */
export class SplatSkin extends Player {
  private static next = 0;
  readonly name = 'splats-skin:' + SplatSkin.next++;
  /** Joint matrices, 16 floats per joint (identity at first), read every frame. Live: write into it. */
  readonly matrices: Float32Array;
  private readonly influence: Float32Array;
  private matrixBuffer?: GPUBuffer;
  private restPositions?: GPUBuffer;
  private restCovariances?: GPUBuffer;
  private bound?: { group: GPUBindGroup; positions: GPUBuffer };
  private stale = true;
  constructor(cloud: Splats, options: SplatSkinOptions) {
    super(cloud, 'SplatSkin');
    const { joints, indices, weights } = options ?? ({} as SplatSkinOptions),
      n = cloud.count;
    if (!Number.isInteger(joints) || joints < 1 || joints > 65536)
      throw new RangeError('SplatSkin needs 1 to 65,536 joints; pass the joint count');
    if (indices?.length !== n * 4 || weights?.length !== n * 4)
      throw new RangeError(
        `SplatSkin needs 4 joint indices and 4 weights per splat (${n * 4} each); pass one set per splat`,
      );
    this.matrices = new Float32Array(joints * 16);
    for (let k = 0; k < joints; k++)
      this.matrices[k * 16] = this.matrices[k * 16 + 5] = this.matrices[k * 16 + 10] = this.matrices[k * 16 + 15] = 1;
    this.influence = new Float32Array(n * 8);
    const index = new Uint32Array(this.influence.buffer);
    for (let i = 0; i < n; i++) {
      let sum = 0;
      for (let k = 0; k < 4; k++) {
        const j = indices[i * 4 + k],
          w = weights[i * 4 + k];
        if (!Number.isInteger(j) || j < 0 || j >= joints)
          throw new RangeError(`SplatSkin joint index ${j} is outside 0 to ${joints - 1}; fix the indices`);
        if (!(w >= 0 && Number.isFinite(w)))
          throw new RangeError('SplatSkin weights must be finite and 0 or more; fix the weights');
        index[i * 8 + k] = j;
        sum += w;
      }
      for (let k = 0; k < 4; k++) this.influence[i * 8 + 4 + k] = sum > 0 ? weights[i * 4 + k] / sum : 0;
    }
  }
  /** Same as `engine.use(new SplatSkin(cloud, options))`; returns it. */
  static attach(engine: EngineKernel, cloud: Splats, options: SplatSkinOptions): SplatSkin {
    const skin = new SplatSkin(cloud, options);
    engineRuntime(engine).use(skin);
    return skin;
  }
  /** Takes the cloud's current centres and covariances as the rest pose on the next frame (after `Splats.write`). */
  rebind(): this {
    this.stale = true;
    return this;
  }
  override setup(engine: Engine): void {
    super.setup(engine);
    this.matrixBuffer = this.buffer(this.matrices.byteLength, GPUBufferUsage.STORAGE);
    this.restPositions = this.buffer(this.cloud.count * 16, GPUBufferUsage.STORAGE);
    this.restCovariances = this.buffer(this.cloud.count * 32, GPUBufferUsage.STORAGE);
    this.bound = undefined;
    this.stale = true;
  }
  protected pose(c: Context): void {
    const state = this.cloud.gpuState,
      d = this.device!,
      pipeline = this.compute(skinShader),
      n = this.cloud.count;
    if (!this.bound || this.bound.positions !== state.positions) {
      const influence = this.buffer(this.influence.byteLength, GPUBufferUsage.STORAGE, this.influence);
      this.bound = {
        group: d.createBindGroup({
          layout: pipeline.getBindGroupLayout(0),
          entries: [
            this.uniform!,
            this.matrixBuffer!,
            influence,
            this.restPositions!,
            this.restCovariances!,
            state.positions,
            state.covariances,
          ].map((buffer, binding) => ({ binding, resource: { buffer } })),
        }),
        positions: state.positions,
      };
      this.stale = true;
    }
    if (this.stale) {
      // The rest pose: the cloud's centres and covariances as they are now.
      c.encoder.copyBufferToBuffer(state.positions, 0, this.restPositions!, 0, n * 16);
      c.encoder.copyBufferToBuffer(state.covariances, 0, this.restCovariances!, 0, n * 32);
      this.stale = false;
    }
    d.queue.writeBuffer(this.uniform!, 0, new Uint32Array([n, 0, 0, 0]));
    d.queue.writeBuffer(this.matrixBuffer!, 0, this.matrices as Float32Array<ArrayBuffer>);
    this.run(c.encoder, this.bound.group);
  }
  protected override release(): void {
    super.release();
    this.matrixBuffer = this.restPositions = this.restCovariances = this.bound = undefined;
  }
}
