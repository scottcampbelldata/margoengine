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
  /**
   * Light samples to take, then hold the finished texture: an integer 1..1024, or `Infinity` with `blend` to keep
   * sampling every frame (drei's `frames={Infinity}`). Default 64.
   */
  frames?: number;
  /**
   * Moving-average length in samples, an integer of 1 or more. Unset (default): the exact mean of every sample, and a
   * moved caster restarts the sum. Set: sample n is mixed in with weight 1 / min(n + 1, blend), the exact mean for the
   * first `blend` samples and then an exponential average, and a moved caster blends in without a restart (drei's
   * `blend`). Live.
   */
  blend?: number;
  /**
   * `true` (default): one sample per rendered frame. `false`: every remaining sample in the first frame, each but the
   * last in its own submitted command encoder (drei's `temporal={false}`); with `frames: Infinity`, one per frame. Live.
   */
  temporal?: boolean;
  /**
   * Light samples taken per rendered frame, an integer 1..1024 (drei's `amount` lights of each frame): each but the
   * last in its own submitted command encoder. With `temporal: false` the first frame takes every sample anyway. Live.
   * Default 1.
   */
  samples?: number;
  /**
   * Caster fragments whose alpha (texture x factor x vertex alpha, as for `cutoff`) is below this cast no shadow, on
   * top of each caster's own cut-out: a half-transparent glass with alpha 0.3 casts nothing at 0.65 (drei's
   * `alphaTest`). Core 24-byte casters have no alpha and always cast. 0..1, live. Default 0.
   */
  alphaTest?: number;
  /** Must be 0: penumbrae come from light sampling, without a spatial blur. Default 0. */
  blur?: 0;
  /** Must be false: the entry manages progressive caching itself. Default false. */
  static?: false;
}

const sumShader = `${fullscreen}
struct State {count:vec4f,light:vec4f,e1:vec4f,e2:vec4f,plane:vec4f}
@group(0) @binding(0) var<uniform> state:State;
@group(0) @binding(1) var sampleImage:texture_2d<f32>;
@group(0) @binding(2) var previous:texture_2d<f32>;
// A light's shadow camera window (e1.w: half side, 0 = none) and map (e2.w: texels per side, 0 = exact): a receiver
// texel outside the window is lit, and inside it filters the samples where the rays through the four nearest map
// texel centres meet the plane. Vectors are in the receiver frame (u, up, v); plane: width, depth, resolution.
fn texelShadow(c:vec2f)->f32 {
 let r=state.plane.z;let q=c.x*state.e1.xyz+c.y*state.e2.xyz;let hit=q-q.y/state.light.y*state.light.xyz;
 let at=vec2f((hit.x/state.plane.x+0.5)*r,(0.5-hit.z/state.plane.y)*r);
 if(any(at<vec2f(0))||any(at>=vec2f(r))){return 0.0;}
 return textureLoad(sampleImage,vec2i(at),0).r;
}
fn shadowed(pixel:vec2i)->f32 {
 if(state.e1.w<=0.0){return textureLoad(sampleImage,pixel,0).r;}
 let r=state.plane.z;let t=(vec2f(pixel)+0.5)/r;
 let p=vec3f((t.x-0.5)*state.plane.x,0,(0.5-t.y)*state.plane.y);
 let w=vec2f(dot(p,state.e1.xyz),dot(p,state.e2.xyz));let size=state.e1.w;
 if(any(abs(w)>vec2f(size))){return 0.0;}
 if(state.e2.w<=0.0){return textureLoad(sampleImage,pixel,0).r;}
 // Percentage-closer filtering (Reeves, Salesin and Cook 1987): the four nearest texels' shadow tests, weighted
 // bilinearly (a comparison sampler's linear filter); texels past the map's edge clamp to it.
 let n=state.e2.w;let texel=2.0*size/n;let g=(w+size)/texel-0.5;let i=floor(g);let f=g-i;
 let c0=(clamp(i,vec2f(0),vec2f(n-1.0))+0.5)*texel-size;let c1=(clamp(i+1.0,vec2f(0),vec2f(n-1.0))+0.5)*texel-size;
 return mix(mix(texelShadow(c0),texelShadow(vec2f(c1.x,c0.y)),f.x),mix(texelShadow(vec2f(c0.x,c1.y)),texelShadow(c1),f.x),f.y);
}
@fragment fn fragment(v:Vertex)->@location(0) vec4f {
 let pixel=vec2i(v.position.xy);
 var value=shadowed(pixel);
 if(state.count.x>0.0){let old=textureLoad(previous,pixel,0).r;value=select(old+value,mix(old,value,state.count.y),state.count.y>0.0);}
 return vec4f(value,0,0,1);
}`;

// Bounded to 11 iterations at the 1024-frame cap; no mesh or image processing on the CPU.
const radicalInverse = (value: number): number => {
  let result = 0,
    weight = 0.5;
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
  override readonly name: string = 'accumulated-shadows';
  declare readonly options: AccumulatedShadowOptions;
  private count = 0;
  private lightKey = '';
  private result?: GPUTextureView;
  private history?: { size: number; textures: GPUTexture[]; views: GPUTextureView[] };
  private sums?: GPURenderPipeline;
  private uniform?: GPUBuffer;
  private bindings?: GPUBindGroup[];
  private readonly state = new Float32Array(20);
  /**
   * The current sample's light camera, set by `projection`: unit `light` direction to the light and window axes
   * `e1`, `e2` in the receiver frame (u, up, v), the window half side `size` and map texels `map` (0 = exact).
   */
  protected window?: {
    light: readonly number[];
    e1: readonly number[];
    e2: readonly number[];
    size: number;
    map: number;
  };
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
  get samples(): number {
    return this.count;
  }

  /** Resets history for an in-place geometry or pose edit that has no changed transform/buffer. */
  override invalidate(): void {
    this.count = 0;
    super.invalidate();
  }

  override setup(engine: Engine): void {
    if (!engine.gpu)
      throw fault(
        'unsupported',
        'AccumulatedShadows needs WebGPU or the WebGL2 compatibility layer; select one of those backends',
      );
    super.setup(engine);
    this.uniform = engine.gpu.createBuffer({ size: 80, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
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

  protected override coverage(_depth: string): string {
    return '1';
  }
  protected override casterCutoff(): number {
    return this.options.alphaTest ?? 0;
  }
  protected override coverageScale(): number {
    return this.count && this.options.blend === undefined ? 1 / this.count : 1;
  }
  protected override needsUpdate(_s: ReturnType<AccumulatedShadows['settings']>, changed: boolean): boolean {
    return changed || this.count < (this.options.frames ?? 64);
  }

  protected override changed(
    draws: readonly ContactPrimitive[],
    s: ReturnType<AccumulatedShadows['settings']>,
  ): boolean {
    this.validate();
    const changed = super.changed(draws, s);
    const key = this.lightingKey(s) + '|' + (this.options.frames ?? 64);
    // A blend follows moving casters without a restart; option changes always restart.
    if ((changed && this.options.blend === undefined) || key !== this.lightKey) this.count = 0;
    this.lightKey = key;
    return changed;
  }

  protected override projection(s: ReturnType<AccumulatedShadows['settings']>): Float32Array {
    const light = this.light(s),
      center = [s.x, s.ground, s.z];
    const local = (axis: readonly number[]) => axis.reduce((sum, v, i) => sum + v * (light[i] - center[i]), 0);
    const H = local(s.normal);
    const r = (this.options.lightRadius ?? 2) * Math.sqrt(radicalInverse(this.count + 1));
    const angle = (this.count + 1) * Math.PI * (3 - Math.sqrt(5));
    const x = local(s.u) + r * Math.cos(angle),
      z = local(s.v) + r * Math.sin(angle);
    const m = this.matrix;
    m.fill(0);
    for (let i = 0; i < 3; i++) {
      m[4 * i] = (2 * (H * s.u[i] - x * s.normal[i])) / s.width;
      m[4 * i + 1] = (2 * (H * s.v[i] - z * s.normal[i])) / s.depth;
      m[4 * i + 2] = ((H - s.height) * s.normal[i]) / s.height;
      m[4 * i + 3] = -s.normal[i];
    }
    for (let row = 0; row < 4; row++)
      m[12 + row] = (row === 3 ? H : 0) - center.reduce((sum, v, i) => sum + m[4 * i + row] * v, 0);
    return m;
  }

  protected override update(
    c: Context,
    draws: readonly ContactPrimitive[],
    s: ReturnType<AccumulatedShadows['settings']>,
  ): GPUTextureView {
    const frames = this.options.frames ?? 64;
    // temporal false: every remaining sample now; otherwise `samples` this frame. Caster uniforms and the sum state go
    // through queue.writeBuffer, so each sample but the last is encoded in its own encoder and submitted before the
    // next one's values are written; queue order then gives each sample its own values, with no extra buffers. The
    // last uses the frame's encoder.
    const last =
      this.options.temporal === false && frames !== Infinity
        ? frames - 1
        : Math.min(frames, this.count + (this.options.samples ?? 1)) - 1;
    while (this.count < last) {
      const encoder = c.device.createCommandEncoder();
      this.sample(Object.create(c, { encoder: { value: encoder } }) as Context, draws, s);
      c.device.queue.submit([encoder.finish()]);
    }
    return this.sample(c, draws, s);
  }

  /** Takes one light sample into the history; holds once `frames` are in. */
  private sample(
    c: Context,
    draws: readonly ContactPrimitive[],
    s: ReturnType<AccumulatedShadows['settings']>,
  ): GPUTextureView {
    if (this.count >= (this.options.frames ?? 64)) return this.result!;
    const sample = super.update(c, draws, s);
    if (!this.history || this.history.size !== s.resolution) {
      for (const t of this.history?.textures ?? []) t.destroy();
      const textures = [0, 1].map(() =>
        c.device.createTexture({
          size: [s.resolution, s.resolution],
          format: 'r16float',
          usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_SRC,
        }),
      );
      this.history = { size: s.resolution, textures, views: textures.map((t) => t.createView()) };
      this.bindings = undefined;
    }
    this.sums ??= render(c.device, sumShader, 'r16float');
    this.bindings ??= [0, 1].map((i) =>
      group(c.device, this.sums!, [{ buffer: this.uniform! }, sample, this.history!.views[1 - i]]),
    );
    const blend = this.options.blend;
    const w = this.window,
      st = this.state;
    st.fill(0);
    st[0] = this.count;
    st[1] = blend === undefined ? 0 : 1 / Math.min(this.count + 1, blend);
    if (w) {
      st.set(w.light, 4);
      st.set(w.e1, 8);
      st.set(w.e2, 12);
      st[11] = w.size;
      st[15] = w.map;
      st[16] = s.width;
      st[17] = s.depth;
      st[18] = s.resolution;
    }
    c.device.queue.writeBuffer(this.uniform!, 0, this.state);
    const index = this.count & 1;
    // view-state: offscreen receiver history sum, full local target.
    const pass = c.encoder.beginRenderPass({
      colorAttachments: [{ view: this.history.views[index], loadOp: 'clear', storeOp: 'store' }],
    });
    pass.setPipeline(this.sums);
    pass.setBindGroup(0, this.bindings[index]);
    pass.draw(3);
    pass.end();
    this.count++;
    return (this.result = this.history.views[index]);
  }

  private validate(): void {
    const s = this.settings(),
      o = this.options;
    this.validateLighting(s);
    const frames = o.frames ?? 64,
      samples = o.samples ?? 1,
      alphaTest = o.alphaTest ?? 0;
    if (
      !Number.isInteger(samples) ||
      samples < 1 ||
      samples > 1024 ||
      typeof alphaTest !== 'number' ||
      !(alphaTest >= 0 && alphaTest <= 1)
    )
      throw rangeError(
        'Invalid accumulated shadow options; use samples an integer 1..1024 and alphaTest 0..1',
        'arguments',
      );
    if (
      !(Number.isInteger(frames) || (frames === Infinity && o.blend !== undefined)) ||
      frames < 1 ||
      (frames > 1024 && frames !== Infinity) ||
      (o.blend !== undefined && (!Number.isInteger(o.blend) || o.blend < 1)) ||
      (o.temporal !== undefined && typeof o.temporal !== 'boolean') ||
      s.blur !== 0 ||
      Boolean(o.static) ||
      ![s.x, s.ground, s.z, s.width, s.depth, s.height].every((v) => Math.abs(v) <= 1e6) ||
      Math.min(s.width, s.depth, s.height) < 1e-6
    )
      throw rangeError(
        'Invalid accumulated shadow options; use frames 1..1024 (or Infinity with blend), blend an integer of 1 or more, temporal a boolean, blur 0, static false, receiver sizes 1e-6..1e6 and a finite disk light above the caster height',
        'arguments',
      );
  }

  /** Validates the optional entry's light distribution before rendering or allocation. */
  protected validateLighting(s: ReturnType<AccumulatedShadows['settings']>): void {
    const light = this.light(s),
      radius = this.options.lightRadius ?? 2;
    if (
      !Array.isArray(light) ||
      light.length !== 3 ||
      ![0, 1, 2].every((i) => Number.isFinite(light[i]) && Math.abs(light[i]) <= 1e6) ||
      !(
        Math.fround(s.normal.reduce((sum, v, i) => sum + v * (light[i] - [s.x, s.ground, s.z][i]), 0)) >
        Math.fround(s.height)
      ) ||
      !Number.isFinite(radius) ||
      radius < 0 ||
      radius > 1e6
    )
      throw rangeError(
        'Invalid accumulated shadow light; use a finite disk above the caster height and radius 0..1e6',
        'arguments',
      );
  }

  /** History identity of a light distribution; live edits restart the sum. */
  protected lightingKey(s: ReturnType<AccumulatedShadows['settings']>): string {
    return [...this.light(s), this.options.lightRadius ?? 2].join('|');
  }

  private light(s: ReturnType<AccumulatedShadows['settings']>): readonly number[] {
    return this.options.lightPosition ?? s.normal.map((v) => 8 * v);
  }

  private releaseHistory(): void {
    for (const t of this.history?.textures ?? []) t.destroy();
    this.uniform?.destroy();
    this.history = this.bindings = this.sums = this.uniform = this.result = undefined;
    this.count = 0;
    this.lightKey = '';
  }
}
