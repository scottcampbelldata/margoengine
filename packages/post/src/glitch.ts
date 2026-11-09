/// <reference lib="esnext.disposable" preserve="true" />
// Digital glitch, an LDR PostStack stage. A seeded schedule on the CPU decides, frame by frame, whether the frame is
// glitched and with which random parameters; the GPU pass then tears rows sideways, shifts random grid cells sideways
// and splits red and blue away from green. All displacement before the split is horizontal, so the green read stays
// on its own row; quiet frames copy the input texel exactly.
import type { EngineKernel } from '@margoengine/core';
import type { Engine, EnginePlugin, PassContext } from '@margoengine/core/extension';
import type { StackHost, StackStage, StageOutput } from '../../shared/stack.js';
import { fullscreen, render, group } from '../../shared/gpu.js';
import { margoError } from '../../shared/errors.js';
import { applyView, viewLoadOp } from '../../shared/view-rect.js';
import { PostStack } from './stack.js';
declare const GPUBufferUsage: { UNIFORM: number; COPY_DST: number };
type GlitchPassContext = Extract<PassContext, { backend: 'webgpu' }>;

/** Options of {@link Glitch}; the object is kept and read every frame. */
export interface GlitchOptions {
  /** Scales displacement, colour split and tearing, 0..1; 0 passes every frame through. Default 1. */
  intensity?: number;
  /** Glitch every frame (no quiet waits). Default false. */
  wild?: boolean;
  /** Integer 0..2^32-1; the same seed gives the same glitches on the same enabled frames. Default: random. */
  seed?: number;
  /** False passes frames through and pauses the sequence. Default true. */
  enabled?: boolean;
}

// Schedule tuning (frames, at the display rate). Quiet waits of 90-300 frames (1.5-5 s at 60 Hz) keep the glitch an
// occasional event; bursts of 3-10 frames (50-170 ms) read as one hiccup rather than a sustained effect.
const WAIT = [90, 300] as const;
const BURST = [3, 10] as const;
const TEARS = 4; // most horizontal tear bands per glitched frame (the shader's tears array length)
const UNIFORM_BYTES = 48 + TEARS * 16;

const shader = `${fullscreen}
struct Glitch {flags:vec4u,split:vec4f,blocks:vec4f,tears:array<vec4f,4>}
@group(0) @binding(0) var<uniform> g:Glitch;
@group(0) @binding(1) var frame:texture_2d<f32>;
// PCG hash (Jarzynski and Olano, "Hash Functions for GPU Rendering", JCGT 9(3), 2020).
fn pcg(v:u32)->u32 {let s=v*747796405u+2891336453u;let w=((s>>((s>>28u)+4u))^s)*277803737u;return (w>>22u)^w;}
fn unit(v:u32)->f32 {return f32(pcg(v)>>8u)*(1.0/16777216.0);}
// Wraps horizontally, clamps vertically, unfiltered.
fn texel(p:vec2f,size:vec2i)->vec4f {
 let x=((i32(floor(p.x))%size.x)+size.x)%size.x;
 return textureLoad(frame,vec2i(x,clamp(i32(floor(p.y)),0,size.y-1)),0);
}
@fragment fn fragment(@builtin(position) at:vec4f)->@location(0) vec4f {
 if (g.flags.y==0u) {return textureLoad(frame,vec2i(at.xy),0);}
 let size=vec2i(textureDimensions(frame));
 var p=at.xy;
 let row=u32(at.y);
 for (var i=0u;i<g.flags.z;i++) {
  let band=g.tears[i];
  if (p.y>=band.x&&p.y<band.x+band.y) {p.x+=band.z+(unit(g.flags.x^pcg(row+i*7919u))*2-1)*band.w;}
 }
 let cell=bitcast<vec2u>(vec2i(floor(p/g.split.zw)));
 let pick=pcg(g.flags.x+pcg(cell.x^pcg(cell.y)));
 if (unit(pick)<g.blocks.x) {p.x+=(unit(pick^0x68e31da4u)*2-1)*g.blocks.y;}
 let centre=texel(p,size);
 let left=texel(p+g.split.xy,size);
 let right=texel(p-g.split.xy,size);
 return vec4f(left.r,centre.g,right.b,max(max(left.a,centre.a),right.a));
}`;

/** PCG output hash used to scramble a seed into a generator state (Jarzynski and Olano 2020). */
function scramble(seed: number): number {
  const s = (Math.imul(seed >>> 0, 747796405) + 2891336453) >>> 0,
    w = Math.imul(((s >>> ((s >>> 28) + 4)) ^ s) >>> 0, 277803737) >>> 0;
  return ((w >>> 22) ^ w) >>> 0 || 0x9e3779b9; // xorshift needs a non-zero state
}

/**
 * Digital glitch in a PostStack: an LDR effect that runs after the display effect (and after SMAA or FXAA, so it
 * stays sharp). After a random quiet wait of 90-300 frames comes a burst of 3-10 glitched frames, the first at full
 * strength and the rest weaker; each glitched frame has new random block displacement, a red/blue colour split and
 * horizontal tearing. `wild` glitches every frame. Quiet frames, `intensity` 0 and disabled frames are exact copies.
 * `attach` runs it alone in its own PostStack, which disposing the Glitch disposes too.
 * @throws TypeError when `wild` or `enabled` is not a boolean, RangeError when `intensity` is outside 0..1 or `seed` is
 * not an integer in 0..2^32-1 (checked now and every frame); MargoError `'state'` when used outside a PostStack,
 * `'unsupported'` on a WebGL engine, `'disposed'` after `dispose()`, `'attached'` when joined twice.
 */
export class Glitch implements EnginePlugin {
  readonly name = 'glitch';
  private engine?: Engine;
  private stack?: PostStack;
  private stacked = false;
  private disposed = false;
  private uniform?: GPUBuffer;
  private pipeline?: GPURenderPipeline;
  private key = '';
  private group?: GPUBindGroup;
  private input?: GPUTextureView;
  private glitched = false;
  // Schedule state: xorshift32 generator, seed in use, quiet frames left, burst frames left, next burst frame first.
  private state = 0;
  private seed?: number;
  private randomSeed?: number;
  private wait = 0;
  private burst = 0;
  private first = false;
  private readonly bytes = new ArrayBuffer(UNIFORM_BYTES);
  private readonly words = new Uint32Array(this.bytes);
  private readonly floats = new Float32Array(this.bytes);
  private readonly attachment: GPURenderPassColorAttachment = { view: undefined!, loadOp: 'clear', storeOp: 'store' };
  private readonly descriptor: GPURenderPassDescriptor = { colorAttachments: [this.attachment] };

  constructor(readonly options: GlitchOptions = {}) {
    this.validate();
  }

  /** Attaches a new Glitch to `engine` alone in its own PostStack. */
  static attach(engine: EngineKernel, options: GlitchOptions = {}): Glitch {
    const effect = new Glitch(options),
      stack = PostStack.attach(engine, [effect]);
    effect.stack = stack;
    return effect;
  }

  /** Whether frames are glitched (mirrors `options.enabled`); false passes them through and pauses the sequence. */
  get enabled(): boolean {
    return this.options.enabled ?? true;
  }
  set enabled(value: boolean) {
    if (typeof value !== 'boolean') throw new TypeError('Glitch enabled must be a boolean; pass true or false');
    this.options.enabled = value;
  }

  /** True when the last frame drawn was glitched. */
  get active(): boolean {
    return this.glitched;
  }

  private joinStack(_host: StackHost): StackStage {
    if (this.engine || this.stacked || this.disposed)
      throw margoError('attached', 'Glitch is already attached; create a new Glitch');
    this.stacked = true;
    return { kind: 'ldr', render: (c, input, output) => this.draw(c, input, output) };
  }

  setup(engine: Engine): void {
    if (this.disposed) throw margoError('disposed', 'Glitch is disposed; create a new Glitch');
    if (!this.stacked)
      throw margoError('state', 'Glitch runs inside a PostStack; use Glitch.attach(engine) or add it to a PostStack');
    if (!engine.gpu) throw margoError('unsupported', 'Glitch requires WebGPU; it does not run on the WebGL2 fallback');
    this.engine = engine;
    this.uniform = engine.gpu.createBuffer({
      size: UNIFORM_BYTES,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
  }

  onDeviceRestored(engine: Engine): void {
    this.release();
    this.engine = undefined;
    this.setup(engine);
  }

  /** Removes the effect, releases its GPU resources and disposes the stack `attach` created. Safe to call twice. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    const engine = this.engine;
    this.engine = undefined;
    engine?.sceneOf(this)?.removePlugin(this.name);
    this.release();
    this.stack?.dispose();
    this.stack = undefined;
  }

  declare [Symbol.dispose]: () => void;
  [(Symbol.dispose ?? Symbol()) as symbol](): void {
    this.dispose();
  }

  private validate(): void {
    const o = this.options;
    if (o.wild !== undefined && typeof o.wild !== 'boolean')
      throw new TypeError('Glitch wild must be a boolean; pass true or false');
    if (o.enabled !== undefined && typeof o.enabled !== 'boolean')
      throw new TypeError('Glitch enabled must be a boolean; pass true or false');
    const intensity = o.intensity ?? 1;
    if (!(intensity >= 0 && intensity <= 1)) throw new RangeError('Glitch intensity must be in 0..1');
    if (o.seed !== undefined && !(Number.isInteger(o.seed) && o.seed >= 0 && o.seed <= 0xffffffff))
      throw new RangeError('Glitch seed must be an integer in 0..2^32-1');
  }

  /** xorshift32 (Marsaglia, "Xorshift RNGs", J. Stat. Softw. 8(14), 2003), as a float in [0, 1). */
  private random(): number {
    let x = this.state;
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    this.state = x >>> 0;
    return this.state / 4294967296;
  }

  private between(range: readonly [number, number]): number {
    return range[0] + Math.floor(this.random() * (range[1] - range[0] + 1));
  }

  /** Advances the schedule one enabled frame; returns this frame's strength (0 = quiet) after drawing its parameters. */
  private step(width: number, height: number): number {
    const o = this.options;
    const seed = o.seed ?? (this.randomSeed ??= Math.floor(Math.random() * 4294967296));
    if (seed !== this.seed) {
      this.seed = seed;
      this.state = scramble(seed);
      this.wait = this.between(WAIT);
      this.burst = 0;
    }
    let strength: number;
    if (o.wild) strength = 0.6 + 0.4 * this.random();
    else if (this.burst > 0) {
      const weaker = 0.2 + 0.6 * this.random();
      strength = this.first ? 1 : weaker;
      this.first = false;
      if (--this.burst === 0) this.wait = this.between(WAIT);
    } else {
      if (--this.wait <= 0) {
        this.burst = this.between(BURST);
        this.first = true;
      }
      return 0;
    }
    this.parameters(width, height, strength * (o.intensity ?? 1));
    return strength;
  }

  /**
   * Draws one glitched frame's parameters into the uniform. The number of draws is fixed (11 + 4 per tear slot), so a
   * seed replays exactly whatever the intensity or frame size.
   */
  private parameters(width: number, height: number, s: number): void {
    const f = this.floats,
      w = this.words,
      r = () => this.random();
    const angle = 2 * Math.PI * r(),
      split = (0.003 + 0.012 * r()) * height * s; // 0.3-1.5% of the frame height
    f[4] = Math.cos(angle) * split;
    f[5] = Math.sin(angle) * split;
    f[6] = Math.max(1, width * (0.03 + 0.22 * r())); // cell width: 3-25% of the frame
    f[7] = Math.max(1, height * (0.015 + 0.1 * r())); // cell height: 1.5-11.5%
    f[8] = (0.08 + 0.37 * r()) * s; // share of cells displaced
    f[9] = width * (0.01 + 0.09 * r()) * s; // largest cell shift: 1-10% of the width
    f[10] = f[11] = 0;
    w[0] = Math.floor(r() * 4294967296) >>> 0; // per-frame shader seed
    const bands = Math.floor(r() * (TEARS + 1));
    w[2] = bands;
    w[3] = 0;
    for (let i = 0; i < TEARS; i++) {
      const o = 12 + i * 4;
      f[o] = r() * height; // first row
      f[o + 1] = height * (0.004 + 0.04 * r()); // thickness
      f[o + 2] = (r() * 2 - 1) * 0.12 * width * s; // sideways shift
      f[o + 3] = 0.015 * width * r() * s; // per-row jitter
    }
  }

  private draw(c: GlitchPassContext, input: GPUTextureView, output: StageOutput): void {
    this.validate();
    const device = c.device;
    const strength = this.enabled ? this.step(c.width, c.height) * (this.options.intensity ?? 1) : 0;
    this.glitched = strength > 0;
    this.words[1] = +this.glitched;
    device.queue.writeBuffer(this.uniform!, 0, this.bytes);
    const key = output.format + ':' + (output.multisample?.count ?? 1);
    if (this.key !== key) {
      this.key = key;
      this.pipeline = render(device, shader, output.format, { multisample: output.multisample });
      this.input = undefined;
    }
    if (this.input !== input) {
      this.input = input;
      this.group = group(device, this.pipeline!, [{ buffer: this.uniform! }, input]);
    }
    this.attachment.view = output.view;
    this.attachment.loadOp = viewLoadOp(c, 'clear');
    const pass = c.encoder.beginRenderPass(this.descriptor);
    try {
      pass.setPipeline(this.pipeline!);
      pass.setBindGroup(0, this.group!);
      applyView(pass, c);
      pass.draw(3);
    } finally {
      pass.end();
    }
  }

  private release(): void {
    this.uniform?.destroy();
    this.uniform = this.pipeline = this.group = this.input = undefined;
    this.key = '';
  }
}
