/// <reference lib="esnext.disposable" preserve="true" />
// Motion trails, an HDR PostStack stage. Two viewport-sized rgba16float history textures ping-pong: each frame folds
// the current frame over the faded previous history (per channel maximum) into the other one, which is both this
// frame's output and the next frame's history. The fade is a half-life in seconds, so trails last as long at any
// frame rate.
import type { EngineKernel } from '@margoengine/core';
import type { Engine, EnginePlugin, PassContext } from '@margoengine/core/extension';
import type { StackHost, StackStage, StageOutput } from '../../shared/stack.js';
import { fullscreen, render, group } from '../../shared/gpu.js';
import { displayShader } from '../../shared/display.js';
import { margoError } from '../../shared/errors.js';
import { applyView, viewLoadOp } from '../../shared/view-rect.js';
import { PostStack } from './stack.js';
declare const GPUBufferUsage: { UNIFORM: number; COPY_DST: number };
declare const GPUTextureUsage: { RENDER_ATTACHMENT: number; TEXTURE_BINDING: number };
type AfterimagePassContext = Extract<PassContext, { backend: 'webgpu' }>;

/** Options of {@link Afterimage}; the object is kept and read every frame. */
export interface AfterimageOptions {
  /** Seconds for a trail to fade to half its brightness; finite and above 0. Default 0.15. */
  halfLife?: number;
  /**
   * @deprecated Use `halfLife`. Share of the trail kept per frame, 0..1 (1.x compatibility); the trail then depends
   * on the frame rate. Overrides `halfLife` when set.
   */
  damp?: number;
  /** False passes frames through; enabling again starts a new trail. Default true. */
  enabled?: boolean;
}

// 0.15 s: about 9 frames at 60 Hz to half brightness and about 0.5 s until a bright trail is near black on screen,
// long enough to read as motion and short enough not to smear the scene.
const DEFAULT_HALF_LIFE = 0.15;
const RATE = 60; // frames per second at which `damp` is reported as a half-life

// next = max(current, previous x keep) per channel; a fresh history takes the current frame as it is.
const foldShader = `${fullscreen}
@group(0) @binding(0) var<uniform> fade:vec4f;
@group(0) @binding(1) var current:texture_2d<f32>;
@group(0) @binding(2) var history:texture_2d<f32>;
@fragment fn fragment(@builtin(position) at:vec4f)->@location(0) vec4f {
 let p=vec2i(at.xy);
 let now=textureLoad(current,p,0);
 if (fade.y!=0) {return now;}
 return max(now,textureLoad(history,p,0)*fade.x);
}`;

const presentShader = `${fullscreen}${displayShader}
@group(0) @binding(0) var trail:texture_2d<f32>;
@fragment fn fragment(@builtin(position) at:vec4f)->@location(0) vec4f {
 let linear=textureLoad(trail,vec2i(at.xy),0);
 return vec4f(toDisplay(linear.rgb),linear.a);
}`;

const dampError = () => new RangeError('Afterimage damp must be in 0..1; pass a share of the trail kept per frame');
const halfLifeError = () => new RangeError('Afterimage halfLife must be finite and above 0; pass seconds');

/**
 * Motion trails in a PostStack (HDR effect): each channel of the output, alpha too, is the larger of the current
 * frame and the faded history, and the output becomes the next frame's history. The history is linear HDR
 * (`rgba16float`), so trails fade smoothly to black and later HDR effects (Bloom) and the display effect see them.
 * It starts empty, and again after a resize, a device restore, `reset()`, or while disabled. Place it among the HDR
 * effects: before Bloom so trails glow, after it to trail the glow. `attach` runs it alone in its own PostStack.
 * @throws TypeError when `enabled` is not a boolean; RangeError when `halfLife` is not finite and above 0 or `damp`
 * is outside 0..1 (checked now, every frame and in the setters); MargoError `'state'` outside a PostStack,
 * `'unsupported'` without WebGPU, `'disposed'` after `dispose()`, `'attached'` when joined twice.
 */
export class Afterimage implements EnginePlugin {
  readonly name = 'afterimage';
  private engine?: Engine;
  private stack?: PostStack;
  private stacked = false;
  private disposed = false;
  private fresh = true;
  private uniform?: GPUBuffer;
  private readonly values = new Float32Array(4);
  private written = false;
  private history: GPUTexture[] = [];
  private views: GPUTextureView[] = [];
  private last = 0;
  private foldPipeline?: GPURenderPipeline;
  private folds: (GPUBindGroup | undefined)[] = [];
  private input?: GPUTextureView;
  private presentPipeline?: GPURenderPipeline;
  private presentKey = '';
  private presents: (GPUBindGroup | undefined)[] = [];
  private readonly attachment: GPURenderPassColorAttachment = { view: undefined!, loadOp: 'clear', storeOp: 'store' };
  private readonly descriptor: GPURenderPassDescriptor = { colorAttachments: [this.attachment] };

  constructor(readonly options: AfterimageOptions = {}) {
    this.validate();
  }

  /** Attaches a new Afterimage to `engine` alone in its own PostStack. */
  static attach(engine: EngineKernel, options: AfterimageOptions = {}): Afterimage {
    const effect = new Afterimage(options);
    effect.stack = PostStack.attach(engine, [effect]);
    return effect;
  }

  /** Mirrors `options.enabled`; false passes frames through, and enabling again starts a new trail. */
  get enabled(): boolean {
    return this.options.enabled ?? true;
  }
  set enabled(value: boolean) {
    if (typeof value !== 'boolean') throw new TypeError('Afterimage enabled must be a boolean; pass true or false');
    this.options.enabled = value;
  }

  /**
   * Seconds to half brightness. With the deprecated `damp` set it reports the half-life `damp` gives at 60 frames per
   * second. Setting it clears `damp`, so the trail follows time again.
   */
  get halfLife(): number {
    const damp = this.options.damp;
    if (damp === undefined) return this.options.halfLife ?? DEFAULT_HALF_LIFE;
    return damp === 0 ? 0 : damp === 1 ? Number.POSITIVE_INFINITY : Math.log(0.5) / Math.log(damp) / RATE;
  }
  set halfLife(value: number) {
    if (!(Number.isFinite(value) && value > 0)) throw halfLifeError();
    this.options.halfLife = value;
    delete this.options.damp;
  }

  /** @deprecated Use `halfLife`. The per-frame share of the trail kept, or undefined when the half-life is used. */
  get damp(): number | undefined {
    return this.options.damp;
  }
  set damp(value: number) {
    if (!(value >= 0 && value <= 1)) throw dampError();
    this.options.damp = value;
  }

  /** Starts a new trail on the next frame. */
  reset(): void {
    this.fresh = true;
  }

  private joinStack(_host: StackHost): StackStage {
    if (this.engine || this.stacked || this.disposed)
      throw margoError('attached', 'Afterimage is already attached; create a new Afterimage');
    this.stacked = true;
    return { kind: 'hdr', render: (c, input, output) => this.draw(c, input, output) };
  }

  setup(engine: Engine): void {
    if (this.disposed) throw margoError('disposed', 'Afterimage is disposed; create a new Afterimage');
    if (!this.stacked)
      throw margoError(
        'state',
        'Afterimage runs inside a PostStack; use Afterimage.attach(engine) or add it to a PostStack',
      );
    if (!engine.gpu)
      throw margoError('unsupported', 'Afterimage requires WebGPU; it does not run on the WebGL2 fallback');
    this.engine = engine;
    this.uniform = engine.gpu.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.written = false;
    this.fresh = true;
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
    engine?.removePlugin(this.name);
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
    if (o.enabled !== undefined && typeof o.enabled !== 'boolean')
      throw new TypeError('Afterimage enabled must be a boolean; pass true or false');
    if (o.damp !== undefined && !(o.damp >= 0 && o.damp <= 1)) throw dampError();
    if (o.halfLife !== undefined && !(Number.isFinite(o.halfLife) && o.halfLife > 0)) throw halfLifeError();
  }

  /** The history multiplier of a frame `delta` seconds long. */
  private keep(delta: number): number {
    const o = this.options;
    if (o.damp !== undefined) return o.damp;
    return delta > 0 ? 0.5 ** (delta / (o.halfLife ?? DEFAULT_HALF_LIFE)) : 1;
  }

  private draw(c: AfterimagePassContext, input: GPUTextureView, output: StageOutput): GPUTextureView | void {
    this.validate();
    const device = c.device;
    if (this.history[0]?.width !== c.width || this.history[0].height !== c.height) {
      this.releaseHistory();
      for (let i = 0; i < 2; i++) {
        this.history[i] = device.createTexture({
          size: [c.width, c.height],
          format: 'rgba16float',
          usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
        });
        this.views[i] = this.history[i].createView();
      }
      this.fresh = true;
    }
    const enabled = this.enabled,
      fresh = this.fresh || !enabled,
      keep = Math.fround(this.keep(c.delta));
    // A disabled frame stores the plain frame, so enabling again starts a new trail from it.
    this.fresh = false;
    const v = this.values;
    if (!this.written || v[0] !== keep || v[1] !== +fresh) {
      v[0] = keep;
      v[1] = +fresh;
      device.queue.writeBuffer(this.uniform!, 0, v);
      this.written = true;
    }
    if (this.input !== input) {
      this.input = input;
      this.folds = [];
    }
    const next = this.last ^ 1;
    this.foldPipeline ??= render(device, foldShader, 'rgba16float');
    const fold = (this.folds[next] ??= group(device, this.foldPipeline, [
      { buffer: this.uniform! },
      input,
      this.views[this.last],
    ]));
    this.pass(c, this.foldPipeline, fold, this.views[next]);
    this.last = next;
    if (output.hdr) return this.views[next];
    const key = output.format + ':' + (output.multisample?.count ?? 1);
    if (this.presentKey !== key) {
      this.presentKey = key;
      this.presentPipeline = render(device, presentShader, output.format, { multisample: output.multisample });
      this.presents = [];
    }
    const present = (this.presents[next] ??= group(device, this.presentPipeline!, [this.views[next]]));
    this.pass(c, this.presentPipeline!, present, output.view);
  }

  private pass(c: AfterimagePassContext, pipeline: GPURenderPipeline, bindings: GPUBindGroup, view: GPUTextureView) {
    this.attachment.view = view;
    this.attachment.loadOp = viewLoadOp(c, 'clear');
    const pass = c.encoder.beginRenderPass(this.descriptor);
    try {
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, bindings);
      applyView(pass, c);
      pass.draw(3);
    } finally {
      pass.end();
    }
  }

  private releaseHistory(): void {
    for (const t of this.history) t.destroy();
    this.history = [];
    this.views = [];
    this.folds = [];
    this.presents = [];
    this.last = 0;
  }

  private release(): void {
    this.releaseHistory();
    this.uniform?.destroy();
    this.uniform = this.foldPipeline = this.presentPipeline = this.input = undefined;
    this.presentKey = '';
    this.written = false;
  }
}
