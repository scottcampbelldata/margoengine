// GPU morph weight evaluation: the weight tracks of one clip live on the GPU and one dispatch a frame samples them for
// every copy, straight into the deformation arena's weights, so the CPU writes 16 bytes a frame however many copies
// play. The deformation pass (order -10) then blends the morph deltas as usual.
import { requireWebGPU } from '../../shared/require-webgpu.js';
import type { EngineKernel } from '@margoengine/core';
import type { Engine, EnginePlugin, FrameGraph, PassContext } from '@margoengine/core/extension';
import { MargoError } from '@margoengine/math/errors';
import type { Animation } from './index.js';
import type { Interpolation } from './sampling.js';

declare const GPUBufferUsage: { STORAGE: number; UNIFORM: number; COPY_DST: number };

/** Options for {@link MorphWeightPlayer}. */
export interface MorphWeightOptions {
  /** Wrap time at the end of the clip. Default true; false holds the first and last keys. */
  loop?: boolean;
}
/** One copy's place in the crowd, for {@link MorphWeightPlayer.add}. */
export interface MorphWeightMember {
  /** Seconds added to the player's time, so copies do not move in step. Default 0. */
  offset?: number;
  /** This copy's rate multiplier, finite and >= 0. Default 1. */
  speed?: number;
}

/** Weight tracks sampled per thread; the arithmetic is `sampleTrackInto`'s, term for term. */
export const morphWeightShader = /* wgsl */ `
struct Track {times:u32,keys:u32,values:u32,width:u32,mode:u32,pad0:u32,pad1:u32,pad2:u32}
struct Item {weight:u32,track:u32,component:u32,member:u32}
struct Params {time:f32,duration:f32,loops:u32,pad:u32}
@group(0) @binding(0) var<uniform> p:Params;
@group(0) @binding(1) var<storage,read> tracks:array<Track>;
@group(0) @binding(2) var<storage,read> times:array<f32>;
@group(0) @binding(3) var<storage,read> values:array<f32>;
@group(0) @binding(4) var<storage,read> items:array<Item>;
@group(0) @binding(5) var<storage,read> members:array<vec2f>;
@group(0) @binding(6) var<storage,read_write> weights:array<f32>;
@compute @workgroup_size(64) fn main(@builtin(global_invocation_id) id:vec3u,@builtin(num_workgroups) groups:vec3u) {
  let i=id.y*groups.x*64u+id.x;
  if(i>=arrayLength(&items)){return;}
  let item=items[i];let member=members[item.member];let track=tracks[item.track];
  var at=p.time*member.y+member.x;
  if(p.loops>0u&&p.duration>0.0) {
    // f32 division may round across a whole lap: pull the result back into [0,duration), as time % duration lands.
    at=at-floor(at/p.duration)*p.duration;
    if(at<0.0){at+=p.duration;}
    if(at>=p.duration){at-=p.duration;}
  } else {at=clamp(at,0.0,p.duration);}
  var lo=0u;var hi=track.keys-1u;
  while(lo<hi) {
    let mid=(lo+hi+1u)/2u;
    if(times[track.times+mid]<=at){lo=mid;}else{hi=mid-1u;}
  }
  let a=lo;let b=min(a+1u,track.keys-1u);
  let span=times[track.times+b]-times[track.times+a];
  var t=0.0;
  if(span>0.0){t=clamp((at-times[track.times+a])/span,0.0,1.0);}
  let w=track.width;let c=item.component;let cubic=track.mode==2u;
  let ai=track.values+(a*select(1u,3u,cubic)+select(0u,1u,cubic))*w+c;
  let bi=track.values+(b*select(1u,3u,cubic)+select(0u,1u,cubic))*w+c;
  var out=values[ai];
  if(track.mode!=0u&&a!=b) {
    if(cubic) {
      let t2=t*t;let t3=t2*t;
      out=(2.0*t3-3.0*t2+1.0)*values[ai]+(t3-2.0*t2+t)*span*values[track.values+(a*3u+2u)*w+c]
        +(-2.0*t3+3.0*t2)*values[bi]+(t3-t2)*span*values[track.values+b*3u*w+c];
    } else {out=values[ai]*(1.0-t)+values[bi]*t;}
  }
  weights[item.weight]=out;
}
`;

const modes: Record<Interpolation, number> = { STEP: 0, LINEAR: 1, CUBICSPLINE: 2 };
/** Words of one record in the shader's `tracks` array. */
const TRACK = 8;
let serial = 0;

interface PageWork {
  group: GPUBindGroup;
  items: GPUBuffer;
  x: number;
  y: number;
}
interface Gpu {
  device: GPUDevice;
  pipeline: GPUComputePipeline;
  params: GPUBuffer;
  tracks: GPUBuffer;
  times: GPUBuffer;
  values: GPUBuffer;
  members?: GPUBuffer;
  pages: PageWork[];
  /** The arena state `pages` was built from. */
  version: number;
}

/**
 * Plays the morph weight tracks of one glTF clip on many copies of a model with no per-copy CPU work: the tracks upload
 * once, and each frame one compute dispatch per deformation buffer page samples every copy's weights from the player's
 * time and that copy's offset and speed. Only weights are driven: a copy's `Animation` keeps playing its own clip for
 * the body, and weights the player drives are overwritten each frame, so `setMorph` on them has no effect.
 *
 * @example
 * ```ts
 * const talk = MorphWeightPlayer.attach(stage.engine, 'Talk');
 * for (const [i, animation] of faces.entries()) talk.add(animation, {offset: i * 0.13});
 * ```
 */
export class MorphWeightPlayer implements EnginePlugin {
  readonly name = 'morph-gpu:' + serial++;
  /** Seconds played; a copy samples `time * speed + offset`. */
  time = 0;
  /** Rate multiplier for every copy, finite and >= 0. Default 1. */
  speed = 1;
  playing = true;
  private readonly members = new Map<Animation, Required<MorphWeightMember>>();
  private readonly loop: boolean;
  private engine?: Engine;
  private gpu?: Gpu;
  private dirty = true;
  private disposed = false;
  private readonly params = new ArrayBuffer(16);
  private readonly paramFloats = new Float32Array(this.params);
  private readonly paramWords = new Uint32Array(this.params);

  /** Same as `engine.use(new MorphWeightPlayer(...))`; returns the player. */
  static attach(engine: EngineKernel, clip: string | number = 0, options?: MorphWeightOptions): MorphWeightPlayer {
    const player = new MorphWeightPlayer(clip, options);
    engine.use(player);
    return player;
  }
  /** `clip` is a name or index every added copy's model has. */
  constructor(
    readonly clip: string | number = 0,
    { loop = true }: MorphWeightOptions = {},
  ) {
    if (typeof loop !== 'boolean') throw new TypeError('MorphWeightPlayer loop must be a boolean');
    if (typeof clip !== 'string' && !(Number.isInteger(clip) && clip >= 0))
      throw new RangeError('MorphWeightPlayer clip must be a clip name or an index from animation.clips');
    this.loop = loop;
  }
  /** Copies playing. */
  get count(): number {
    return this.members.size;
  }
  private tracksOf(animation: Animation) {
    const clips = animation.clips,
      id = typeof this.clip === 'string' ? clips.findIndex((c) => c.name === this.clip) : this.clip,
      clip = clips[id];
    if (!clip) throw new RangeError('Unknown animation clip; pass a clip name or an index from animation.clips');
    const tracks = clip.tracks.filter((t) => t.path === 'weights');
    if (!tracks.length) throw new RangeError(`Clip ${clip.name} has no morph weight tracks; pick a clip that has them`);
    return { duration: clip.duration, tracks };
  }
  /** Adds a copy, or changes its offset and speed. Every copy must come from one asset: they share the tracks. */
  add(animation: Animation, { offset = 0, speed = 1 }: MorphWeightMember = {}): this {
    if (this.disposed) throw new MargoError('disposed', 'MorphWeightPlayer is disposed; create a new one');
    if (!Number.isFinite(offset) || !Number.isFinite(speed) || speed < 0)
      throw new RangeError('Invalid morph member; offset must be finite and speed a finite number >= 0');
    const first = this.members.keys().next().value;
    if (first && first !== animation && first.model.asset !== animation.model.asset)
      throw new TypeError('MorphWeightPlayer copies must share one asset; clone them with cloneModel');
    this.tracksOf(animation);
    this.members.set(animation, { offset, speed });
    this.dirty = true;
    return this;
  }
  /** Stops driving a copy; its weights stay at the last value the GPU wrote until something else writes them. */
  remove(animation: Animation): boolean {
    const removed = this.members.delete(animation);
    this.dirty ||= removed;
    return removed;
  }
  setup(engine: Engine): void {
    if (this.disposed) throw new MargoError('disposed', 'MorphWeightPlayer is disposed; create a new player before attaching');
    requireWebGPU(engine, 'MorphWeightPlayer');
    this.engine = engine;
  }
  onPreUpdate(delta: number): void {
    if (!Number.isFinite(delta) || delta < 0)
      throw new RangeError('Invalid animation delta; pass a finite delta >= 0 seconds');
    if (!Number.isFinite(this.speed) || this.speed < 0)
      throw new RangeError('Invalid morph player speed; use a finite number >= 0');
    if (this.playing) this.time += delta * this.speed;
  }
  registerPasses(graph: FrameGraph): void {
    // Before the deformation pass at -10, which reads what this writes.
    graph.add({ name: this.name, order: -11, execute: (c) => this.evaluate(c) });
  }
  /** The live copies, in order; a disposed copy leaves by itself. */
  private live(): Animation[] {
    for (const animation of this.members.keys())
      if (animation['disposed'] || animation.model.disposed) {
        this.members.delete(animation);
        this.dirty = true;
      }
    return [...this.members.keys()];
  }
  private upload(device: GPUDevice, data: ArrayBufferView): GPUBuffer {
    const buffer = device.createBuffer({
      size: Math.max(16, Math.ceil(data.byteLength / 4) * 4),
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(buffer, 0, data as BufferSource);
    return buffer;
  }
  /** Uploads the tracks once per device and asset. */
  private prepare(device: GPUDevice, animation: Animation): Gpu {
    const { tracks } = this.tracksOf(animation),
      table = new Uint32Array(tracks.length * TRACK);
    let times = 0,
      values = 0;
    tracks.forEach((track, i) => {
      table.set([times, track.times.length, values, track.width, modes[track.interpolation]], i * TRACK);
      times += track.times.length;
      values += track.values.length;
    });
    const allTimes = new Float32Array(times),
      allValues = new Float32Array(values);
    tracks.forEach((track, i) => {
      allTimes.set(track.times, table[i * TRACK]);
      allValues.set(track.values, table[i * TRACK + 2]);
    });
    return {
      device,
      pipeline: device.createComputePipeline({
        layout: 'auto',
        compute: { module: device.createShaderModule({ code: morphWeightShader }), entryPoint: 'main' },
      }),
      params: device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST }),
      tracks: this.upload(device, table),
      times: this.upload(device, allTimes),
      values: this.upload(device, allValues),
      pages: [],
      version: -1,
    };
  }
  private dropPages(gpu: Gpu): void {
    for (const page of gpu.pages) page.items.destroy();
    gpu.pages = [];
    gpu.members?.destroy();
    gpu.members = undefined;
  }
  /** One item per copy, primitive and target, grouped by the buffer page the weights live in. */
  private build(gpu: Gpu, copies: readonly Animation[], version: number): void {
    this.dropPages(gpu);
    const { tracks } = this.tracksOf(copies[0]),
      byPage = new Map<GPUBuffer, number[]>(),
      members = new Float32Array(copies.length * 2);
    copies.forEach((animation, m) => {
      const member = this.members.get(animation)!;
      members[m * 2] = member.offset;
      members[m * 2 + 1] = member.speed;
      for (const resource of animation['resources']) {
        const buffer = resource.weights,
          list = byPage.get(buffer) ?? [];
        byPage.set(buffer, list);
        tracks.forEach((track, t) => {
          if (track.node !== resource.primitive.nodeIndex) return;
          for (let c = 0; c < track.width; c++) list.push(resource.slot.weights.offset + c, t, c, m);
        });
      }
    });
    gpu.members = this.upload(gpu.device, members);
    const max = gpu.device.limits.maxComputeWorkgroupsPerDimension ?? 65535;
    for (const [weights, list] of byPage) {
      if (!list.length) continue;
      const items = this.upload(gpu.device, Uint32Array.from(list)),
        groups = Math.ceil(list.length / 4 / 64),
        x = Math.min(groups, max);
      gpu.pages.push({
        items,
        x,
        y: Math.ceil(groups / x),
        group: gpu.device.createBindGroup({
          layout: gpu.pipeline.getBindGroupLayout(0),
          entries: [gpu.params, gpu.tracks, gpu.times, gpu.values, items, gpu.members, weights].map(
            (buffer, binding) => ({ binding, resource: { buffer } }),
          ),
        }),
      });
    }
    gpu.version = version;
    this.dirty = false;
  }
  private evaluate(context: PassContext): void {
    if (context.backend !== 'webgpu') return;
    const copies = this.live(),
      arena = copies[0]?.['arena'];
    // Copies not attached to an engine yet have no place in the arena.
    if (!arena) return;
    if (this.gpu && this.gpu.device !== context.device) this.release();
    const gpu = (this.gpu ??= this.prepare(context.device, copies[0]));
    if (this.dirty || gpu.version !== arena.version) this.build(gpu, copies, arena.version);
    if (!gpu.pages.length) return;
    this.paramFloats[0] = this.time;
    this.paramFloats[1] = this.tracksOf(copies[0]).duration;
    this.paramWords[2] = +this.loop;
    context.device.queue.writeBuffer(gpu.params, 0, this.params);
    const pass = context.encoder.beginComputePass();
    try {
      pass.setPipeline(gpu.pipeline);
      for (const page of gpu.pages) {
        pass.setBindGroup(0, page.group);
        pass.dispatchWorkgroups(page.x, page.y);
      }
    } finally {
      pass.end();
    }
  }
  private release(): void {
    const gpu = this.gpu;
    if (!gpu) return;
    this.dropPages(gpu);
    for (const buffer of [gpu.params, gpu.tracks, gpu.times, gpu.values]) buffer.destroy();
    this.gpu = undefined;
    this.dirty = true;
  }
  onDeviceRestored(): void {
    // The old device's buffers are gone with it; everything is made again on the next frame.
    this.gpu = undefined;
    this.dirty = true;
  }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.engine?.sceneOf(this)?.removePlugin(this.name);
    this.release();
    this.members.clear();
  }
  declare [Symbol.dispose]: () => void;
  [(Symbol.dispose ?? Symbol()) as symbol](): void {
    this.dispose();
  }
}
