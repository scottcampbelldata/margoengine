/// <reference lib="esnext.disposable" preserve="true" />
import type { EngineKernel } from '@margoengine/core';
import type { Engine, EnginePlugin, PassContext } from '@margoengine/core/extension';
import { fullscreen, render, group as bind } from '../../shared/gpu.js';
import { margoError } from '../../shared/errors.js';
import type { StackHost, StackStage, StageOutput } from '../../shared/stack.js';
import { PostStack } from './stack.js';
declare const GPUBufferUsage: { UNIFORM: number; COPY_DST: number };
type Context = Extract<PassContext, { backend: 'webgpu' }>;

/** Options of {@link Glitch}; all may change per frame. */
export interface GlitchOptions {
  /** Scale of the block displacement, colour split and tearing, 0-1. Default 1; 0 passes every frame through. */
  intensity?: number;
  /** True glitches every frame (three.js GlitchPass `goWild`). Default false: a burst after every 120-240 frames. */
  wild?: boolean;
  /** A non-negative integer below 2^32: the same seed gives the same glitches on the same enabled frames. Default a
   * random seed. Changing it restarts the sequence. */
  seed?: number;
  /** False passes the frame through and pauses the sequence. Default true; also `glitch.enabled`. */
  enabled?: boolean;
}

// Per-pixel glitch of a display-encoded frame: rows inside a tear band slide sideways (each line jittered), cells of a
// block grid slide by their own amount, then red and blue are read a split vector apart. Displaced reads wrap
// horizontally and clamp vertically; alpha is the largest of the three reads, so premultiplied colour stays valid.
// Hash: PCG (Jarzynski and Olano, "Hash Functions for GPU Rendering", JCGT 2020).
const shader =
  fullscreen +
  `
struct G {split:vec2f,block:vec2f,chance:f32,shift:f32,seed:u32,on:u32,bands:array<vec4f,3>}
@group(0) @binding(0) var<uniform> g:G;
@group(0) @binding(1) var image:texture_2d<f32>;
fn hash(v:u32)->f32 {let s=v*747796405u+2891336453u;let w=((s>>((s>>28u)+4u))^s)*277803737u;return f32((w>>22u)^w)/4294967296.0;}
fn pixel(p:vec2f)->vec4f {let size=vec2i(textureDimensions(image));let q=vec2i(floor(p));return textureLoad(image,vec2i(((q.x%size.x)+size.x)%size.x,clamp(q.y,0,size.y-1)),0);}
@fragment fn fragment(@builtin(position) p:vec4f)->@location(0) vec4f {
 if(g.on==0u){return textureLoad(image,vec2i(p.xy),0);}
 var x=p.x;
 for(var i=0u;i<3u;i++){let b=g.bands[i];if(p.y>=b.x&&p.y<b.y){x+=b.z+b.w*(hash(u32(p.y)^(g.seed+i*0x9e3779b9u))*2-1);}}
 let cell=bitcast<vec2u>(vec2i(floor(vec2f(x,p.y)/g.block)));
 if(hash((cell.x*73856093u)^(cell.y*19349663u)^g.seed)<g.chance){x+=(hash((cell.x*83492791u)^(cell.y*2654435761u)^g.seed)*2-1)*g.shift;}
 let at=vec2f(x,p.y);let c=pixel(at);let r=pixel(at+g.split);let b=pixel(at-g.split);
 return vec4f(r.r,c.g,b.b,max(c.a,max(r.a,b.a)));
}`;

/**
 * A digital glitch in a {@link PostStack} (LDR effect, after the display effect), like three.js's GlitchPass: after a
 * random wait of 120-240 frames a burst of 4-16 glitched frames, the first the strongest, each with new random block
 * displacement, an RGB channel split and scanline tearing. `wild` glitches every frame. `Glitch.attach` runs it alone.
 * @throws RangeError or TypeError for invalid options; MargoError `'state'` outside a PostStack, `'unsupported'` on a
 * WebGL engine, `'disposed'` after `dispose()`, `'attached'` when it joins a second stack.
 */
export class Glitch implements EnginePlugin {
  readonly name = 'glitch';
  private engine?: Engine;
  private host?: StackHost;
  private stack?: PostStack;
  private disposed = false;
  private uniform?: GPUBuffer;
  private pipeline?: GPURenderPipeline;
  private group?: GPUBindGroup;
  private input?: GPUTextureView;
  private key = '';
  private given?: number;
  private state = 0;
  private wait = 0;
  private burst = 0;
  private readonly values = new Float32Array(20);
  private readonly words = new Uint32Array(this.values.buffer);
  private readonly attachment: GPURenderPassColorAttachment = { view: undefined!, loadOp: 'clear', storeOp: 'store' };
  private readonly pass: GPURenderPassDescriptor = { colorAttachments: [this.attachment] };
  constructor(readonly options: GlitchOptions = {}) {
    this.validate();
  }
  /** Alone, Glitch runs in its own one-effect PostStack; to combine it, put it in your PostStack after the display
   * effect (and after SMAA or FXAA, so the glitch stays sharp). */
  static attach(engine: EngineKernel, options: GlitchOptions = {}): Glitch {
    const effect = new Glitch(options);
    effect.stack = PostStack.attach(engine, [effect]);
    return effect;
  }
  /** False passes the frame through; the same as `options.enabled`. */
  get enabled(): boolean {
    return this.options.enabled ?? true;
  }
  set enabled(value: boolean) {
    if (typeof value !== 'boolean') throw new TypeError('Glitch enabled must be boolean');
    this.options.enabled = value;
  }
  /** True when the last frame drawn was glitched. */
  get active(): boolean {
    return this.words[7] === 1;
  }
  private joinStack(host: StackHost): StackStage {
    if (this.engine || this.host || this.disposed)
      throw margoError('attached', 'Glitch is already attached; create another Glitch for another stack');
    this.host = host;
    return { kind: 'ldr', render: (c, input, output) => this.stage(c, input, output) };
  }
  private validate(): void {
    const o = this.options,
      i = o.intensity ?? 1,
      s = o.seed ?? 0;
    if (
      (o.wild !== undefined && typeof o.wild !== 'boolean') ||
      (o.enabled !== undefined && typeof o.enabled !== 'boolean')
    )
      throw new TypeError('Invalid Glitch options: wild and enabled must be boolean');
    if (!(i >= 0 && i <= 1) || !(Number.isInteger(s) && s >= 0 && s < 2 ** 32))
      throw new RangeError('Invalid Glitch options: intensity 0-1, seed an integer from 0 to 2^32 - 1');
  }
  setup(engine: Engine): void {
    if (this.disposed) throw margoError('disposed', 'Glitch is disposed; create a new Glitch');
    if (!this.host)
      throw margoError(
        'state',
        'Glitch runs in a PostStack: use Glitch.attach(engine) or PostStack.attach(engine, [..., new Glitch()])',
      );
    if (!engine.gpu) throw margoError('unsupported', 'Glitch requires WebGPU');
    this.engine = engine;
    this.uniform = engine.gpu.createBuffer({ size: 80, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  }
  // xorshift32 (Marsaglia 2003), in [0, 1).
  private random(): number {
    let x = this.state;
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    this.state = x;
    return (x >>> 0) / 4294967296;
  }
  private between(low: number, high: number): number {
    return low + Math.floor(this.random() * (high - low + 1));
  }
  // Advances the sequence one frame and fills the uniform: the strength of this frame's glitch (0 for none), then its
  // random shape. Every glitched frame draws the same count of numbers, so a seed replays exactly.
  private step(width: number, height: number): void {
    const o = this.options,
      v = this.values,
      u = this.words;
    if (!this.state || o.seed !== this.given) {
      this.given = o.seed;
      let x = Math.imul((o.seed ?? Math.floor(Math.random() * 4294967296)) ^ 0x5bd1e995, 0x45d9f3b);
      x = Math.imul(x ^ (x >>> 16), 0x45d9f3b);
      this.state = x ^ (x >>> 16) || 1;
      this.wait = this.between(120, 240);
      this.burst = 0;
    }
    let strength = 0;
    if (o.wild) strength = 0.5 + 0.5 * this.random();
    else if (this.burst > 0) {
      strength = 0.15 + 0.45 * this.random();
      if (!--this.burst) this.wait = this.between(120, 240);
    } else if (this.wait > 0) this.wait--;
    else {
      strength = 1;
      this.burst = this.between(3, 15);
    }
    u[7] = 0;
    if (!strength) return;
    const s = strength * (o.intensity ?? 1),
      angle = 2 * Math.PI * this.random(),
      split = s * (0.004 + 0.016 * this.random()) * height;
    v[0] = Math.cos(angle) * split;
    v[1] = Math.sin(angle) * split;
    v[2] = (0.04 + 0.2 * this.random()) * width;
    v[3] = (0.01 + 0.06 * this.random()) * height;
    v[4] = s * (0.15 + 0.35 * this.random());
    v[5] = s * (0.05 + 0.25 * this.random()) * width;
    u[6] = Math.floor(this.random() * 4294967296);
    u[7] = +(s > 0);
    const bands = Math.floor(this.random() * 4);
    for (let i = 0; i < 3; i++) {
      const y = this.random() * height,
        thick = (0.004 + 0.05 * this.random()) * height,
        shift = (this.random() * 2 - 1) * s * 0.3 * width,
        jitter = s * 0.02 * width * this.random();
      if (i < bands) v.set([y, y + thick, shift, jitter], 8 + 4 * i);
      else v.fill(0, 8 + 4 * i, 12 + 4 * i);
    }
  }
  private stage(c: Context, input: GPUTextureView, output: StageOutput): void {
    this.validate();
    if (this.enabled) this.step(c.width, c.height);
    else this.words[7] = 0;
    c.device.queue.writeBuffer(this.uniform!, 0, this.values as Float32Array<ArrayBuffer>);
    const key = output.format + output.multisample.count;
    if (this.key !== key) {
      this.key = key;
      this.pipeline = render(c.device, shader, output.format, { multisample: output.multisample });
      this.input = undefined;
    }
    if (this.input !== input) {
      this.input = input;
      this.group = bind(c.device, this.pipeline!, [{ buffer: this.uniform! }, input]);
    }
    this.attachment.view = output.view;
    const pass = c.encoder.beginRenderPass(this.pass);
    pass.setPipeline(this.pipeline!);
    pass.setBindGroup(0, this.group!);
    pass.draw(3);
    pass.end();
  }
  private release(): void {
    this.uniform?.destroy();
    this.uniform = this.pipeline = this.group = this.input = undefined;
    this.key = '';
    this.attachment.view = undefined!;
  }
  onDeviceRestored(engine: Engine): void {
    this.release();
    this.setup(engine);
  }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    const stack = this.stack;
    this.stack = undefined;
    this.engine?.removePlugin(this.name);
    this.release();
    this.engine = undefined;
    stack?.dispose();
  }
  declare [Symbol.dispose]: () => void;
  [(Symbol.dispose ?? Symbol()) as symbol](): void {
    this.dispose();
  }
}
