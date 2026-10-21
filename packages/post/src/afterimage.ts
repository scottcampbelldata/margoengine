/// <reference lib="esnext.disposable" preserve="true" />
import type { EngineKernel } from '@margoengine/core';
import type { Engine, EnginePlugin, PassContext } from '@margoengine/core/extension';
import { fullscreen, render, group as bind } from '../../shared/gpu.js';
import { margoError } from '../../shared/errors.js';
import type { StackHost, StackStage, StageOutput } from '../../shared/stack.js';
import { displayShader } from '../../shared/display.js';
import { PostStack } from './stack.js';
declare const GPUBufferUsage: { UNIFORM: number; COPY_DST: number };
declare const GPUTextureUsage: { RENDER_ATTACHMENT: number; TEXTURE_BINDING: number };
type Context = Extract<PassContext, { backend: 'webgpu' }>;

/** Options of {@link Afterimage}; all may change per frame. */
export interface AfterimageOptions {
  /** Share of the trail kept each frame, 0-1 (three.js AfterimagePass `damp`). Default 0.96; 0 shows no trail. */
  damp?: number;
  /** False passes the frame through and drops the trail. Default true; also `afterimage.enabled`. */
  enabled?: boolean;
}

// Each channel, alpha too, keeps the larger of the current frame and the damped history; on a fresh history (first
// frame, resize, device restore, reset, disabled) the current frame alone.
const foldShader =
  fullscreen +
  `
@group(0) @binding(0) var<uniform> a:vec4f;
@group(0) @binding(1) var current:texture_2d<f32>;
@group(0) @binding(2) var previous:texture_2d<f32>;
@fragment fn fragment(@builtin(position) p:vec4f)->@location(0) vec4f {
 let q=vec2i(p.xy);let c=textureLoad(current,q,0);
 if(a.y>0.5){return c;}
 return max(c,textureLoad(previous,q,0)*a.x);
}`;
// When the stack needs display-encoded colour from this stage: the folded linear frame through Margo's display curve.
const presentShader =
  fullscreen +
  displayShader +
  `
@group(0) @binding(0) var history:texture_2d<f32>;
@fragment fn fragment(@builtin(position) p:vec4f)->@location(0) vec4f {let h=textureLoad(history,vec2i(p.xy),0);return vec4f(toDisplay(h.rgb),h.a);}`;

/**
 * Motion trails in a {@link PostStack} (HDR effect), like three.js's AfterimagePass: each channel of the output is
 * `max(current, history * damp)`, and the output becomes the next frame's history. The history is linear HDR
 * (`rgba16float`), so trails fade smoothly to black instead of sticking at a low 8-bit level, and later HDR effects
 * (Bloom) and the display effect see them. It starts empty, and again after a resize, a device restore or `reset()`.
 * `Afterimage.attach` runs it alone.
 * @throws RangeError or TypeError for invalid options; MargoError `'state'` outside a PostStack, `'unsupported'` on a
 * WebGL engine, `'disposed'` after `dispose()`, `'attached'` when it joins a second stack.
 */
export class Afterimage implements EnginePlugin {
  readonly name = 'afterimage';
  private engine?: Engine;
  private host?: StackHost;
  private stack?: PostStack;
  private disposed = false;
  private uniform?: GPUBuffer;
  private fold?: GPURenderPipeline;
  private present?: GPURenderPipeline;
  private history: GPUTexture[] = [];
  private views: GPUTextureView[] = [];
  private folds: (GPUBindGroup | undefined)[] = [];
  private presents: (GPUBindGroup | undefined)[] = [];
  private input?: GPUTextureView;
  private index = 0;
  private fresh = true;
  private key = '';
  private readonly values = new Float32Array(4);
  private readonly written = new Float32Array(4).fill(NaN);
  private readonly attachment: GPURenderPassColorAttachment = { view: undefined!, loadOp: 'clear', storeOp: 'store' };
  private readonly pass: GPURenderPassDescriptor = { colorAttachments: [this.attachment] };
  constructor(readonly options: AfterimageOptions = {}) {
    this.validate();
  }
  /** Alone, Afterimage runs in its own one-effect PostStack; to combine it, put it in your PostStack among the HDR
   * effects (before Bloom so trails glow, after it to trail the glow). */
  static attach(engine: EngineKernel, options: AfterimageOptions = {}): Afterimage {
    const effect = new Afterimage(options);
    effect.stack = PostStack.attach(engine, [effect]);
    return effect;
  }
  /** False passes the frame through; the same as `options.enabled`. */
  get enabled(): boolean {
    return this.options.enabled ?? true;
  }
  set enabled(value: boolean) {
    if (typeof value !== 'boolean') throw new TypeError('Afterimage enabled must be boolean');
    this.options.enabled = value;
  }
  /** Share of the trail kept each frame, 0-1 (three.js `damp`). */
  get damp(): number {
    return this.options.damp ?? 0.96;
  }
  set damp(value: number) {
    if (!(value >= 0 && value <= 1)) throw new RangeError('Afterimage damp must be 0-1');
    this.options.damp = value;
  }
  /** Drops the trail: the next frame starts a new history (for a camera cut). */
  reset(): void {
    this.fresh = true;
  }
  private joinStack(host: StackHost): StackStage {
    if (this.engine || this.host || this.disposed)
      throw margoError('attached', 'Afterimage is already attached; create another Afterimage for another stack');
    this.host = host;
    return { kind: 'hdr', render: (c, input, output) => this.stage(c, input, output) };
  }
  private validate(): void {
    const o = this.options;
    if (o.enabled !== undefined && typeof o.enabled !== 'boolean')
      throw new TypeError('Invalid Afterimage options: enabled must be boolean');
    if (!(this.damp >= 0 && this.damp <= 1)) throw new RangeError('Invalid Afterimage options: damp 0-1');
  }
  setup(engine: Engine): void {
    if (this.disposed) throw margoError('disposed', 'Afterimage is disposed; create a new Afterimage');
    if (!this.host)
      throw margoError(
        'state',
        'Afterimage runs in a PostStack: use Afterimage.attach(engine) or PostStack.attach(engine, [new Afterimage(), ...])',
      );
    if (!engine.gpu) throw margoError('unsupported', 'Afterimage requires WebGPU');
    this.engine = engine;
    this.uniform = engine.gpu.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.written.fill(NaN);
    this.fresh = true;
  }
  private stage(c: Context, input: GPUTextureView, output: StageOutput): GPUTextureView | void {
    this.validate();
    const d = c.device,
      v = this.values;
    if (this.history[0]?.width !== c.width || this.history[0].height !== c.height) {
      this.releaseHistory();
      for (let i = 0; i < 2; i++) {
        this.history[i] = d.createTexture({
          size: [c.width, c.height],
          format: 'rgba16float',
          usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
        });
        this.views[i] = this.history[i].createView();
      }
      this.fresh = true;
    }
    v[0] = this.damp;
    v[1] = +(this.fresh || !this.enabled);
    if (v[0] !== this.written[0] || v[1] !== this.written[1]) {
      this.written.set(v);
      d.queue.writeBuffer(this.uniform!, 0, v as Float32Array<ArrayBuffer>);
    }
    this.fold ??= render(d, foldShader, 'rgba16float');
    if (this.input !== input) {
      this.input = input;
      this.folds = [];
    }
    const next = this.index ^ 1;
    this.folds[next] ??= bind(d, this.fold, [{ buffer: this.uniform! }, input, this.views[this.index]]);
    this.draw(c, this.views[next], this.fold, this.folds[next]);
    this.index = next;
    this.fresh = false;
    if (output.hdr) return this.views[next];
    const key = output.format + output.multisample.count;
    if (this.key !== key) {
      this.key = key;
      this.present = render(d, presentShader, output.format, { multisample: output.multisample });
      this.presents = [];
    }
    this.presents[next] ??= bind(d, this.present!, [this.views[next]]);
    this.draw(c, output.view, this.present!, this.presents[next]);
  }
  private draw(c: Context, view: GPUTextureView, pipeline: GPURenderPipeline, bindings: GPUBindGroup): void {
    this.attachment.view = view;
    const pass = c.encoder.beginRenderPass(this.pass);
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, bindings);
    pass.draw(3);
    pass.end();
  }
  private releaseHistory(): void {
    for (const texture of this.history) texture.destroy();
    this.history = [];
    this.views = [];
    this.folds = [];
    this.presents = [];
  }
  private release(): void {
    this.releaseHistory();
    this.uniform?.destroy();
    this.uniform = this.fold = this.present = this.input = undefined;
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
