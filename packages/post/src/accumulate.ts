/// <reference lib="esnext.disposable" preserve="true" />
// Film accumulation, an HDR PostStack stage. Clean room from the accumulation buffer (Haeberli and Akeley, SIGGRAPH
// 1990, https://doi.org/10.1145/97879.97913): every frame since `begin()` is added, times its weight, into a linear
// rgba32float sum, and the same pass writes sum / total weight to an rgba16float mean that the later stages (Tonemap,
// the display curve) see. So the tone curve is applied once, to the average of linear light, never to an average of
// display values. Two sums ping-pong because rgba32float is not blendable; the fold reads one with textureLoad.
import type { EngineKernel } from '@margoengine/core';
import type { Engine, EnginePlugin, PassContext } from '@margoengine/core/extension';
import type { StackHost, StackStage, StageOutput } from '../../shared/stack.js';
import { fullscreen, render, group } from '../../shared/gpu.js';
import { displayFor, displayShader, premultipliedCanvas } from '../../shared/display.js';
import { margoError } from '../../shared/errors.js';
import { applyView, viewLoadOp } from '../../shared/view-rect.js';
import { PostStack } from './stack.js';
import { OutputKey } from '../../shared/output-key.js';
declare const GPUBufferUsage: { UNIFORM: number; COPY_DST: number };
declare const GPUTextureUsage: { RENDER_ATTACHMENT: number; TEXTURE_BINDING: number; COPY_SRC: number };
type AccumulatePassContext = Extract<PassContext, { backend: 'webgpu' }>;

/** Options of {@link Accumulate}; the object is kept and read every frame. */
export interface AccumulateOptions {
  /** False passes frames through and leaves the sum alone; enabling again starts a new sum. Default true. */
  enabled?: boolean;
  /** Weight of each frame added from now on; finite and 0 or more. Default 1. */
  weight?: number;
}

// sum' = (fresh ? 0 : sum) + now * weight; mean = sum' * (1 / total weight), 0 while the total is 0.
const foldShader = `${fullscreen}
struct Folded { @location(0) sum:vec4f, @location(1) mean:vec4f }
@group(0) @binding(0) var<uniform> fold:vec4f;
@group(0) @binding(1) var current:texture_2d<f32>;
@group(0) @binding(2) var history:texture_2d<f32>;
@fragment fn fragment(@builtin(position) at:vec4f)->Folded {
 let p=vec2i(at.xy);
 var sum=textureLoad(current,p,0)*fold.x;
 if (fold.y==0) {sum+=textureLoad(history,p,0);}
 return Folded(sum,sum*fold.z);
}`;

const presentShader = `${fullscreen}${displayShader}
@group(0) @binding(0) var mean:texture_2d<f32>;
@fragment fn fragment(@builtin(position) at:vec4f)->@location(0) vec4f {
 let linear=textureLoad(mean,vec2i(at.xy),0);
 return vec4f(toDisplay(linear.rgb),linear.a);
}`;

const weightError = () => new RangeError('Accumulate weight must be finite and 0 or more; pass 1 for an equal share');
const enabledError = () => new TypeError('Accumulate enabled must be a boolean; pass true or false');

/**
 * Averages frames in linear HDR (an HDR PostStack effect), for film output: N renders of one frame, each with its
 * own sub-pixel offset and shutter time, become one antialiased, motion-blurred frame. `begin()` starts a new sum;
 * each frame drawn after it is added with the current `weight`, and the effect outputs the running weighted mean, so
 * the last sub-frame's picture is the finished frame. Later HDR effects and the display effect (Tonemap) see the mean,
 * so the tone curve is applied once to the linear average. Alpha is averaged as it comes (premultiplied).
 * `@margoengine/headless/accumulate` drives it: sub-frame jitter, shutter times and readback.
 * The sum is rgba32float (rgba16float on the compatibility layer's half-float tier: about 3 significant digits, so
 * keep to a few hundred sub-frames there); the mean is rgba16float with COPY_SRC, readable with
 * `readTexture` from `@margoengine/headless/formats`. Starts empty, and again after a resize or a device restore.
 * Effects before it that keep their own history (TAA, SSGI multi-bounce) advance once per sub-frame.
 * @throws TypeError when `enabled` is not a boolean; RangeError when `weight` is not finite and 0 or more (checked now,
 * every frame and in the setters); MargoError `'state'` outside a PostStack, `'unsupported'` without WebGPU,
 * `'disposed'` after `dispose()`, `'attached'` when joined twice.
 */
export class Accumulate implements EnginePlugin {
  readonly name = 'accumulate';
  private engine?: Engine;
  private stack?: PostStack;
  private stacked = false;
  private disposed = false;
  private fresh = true;
  private frames = 0;
  private sumWeight = 0;
  private uniform?: GPUBuffer;
  private readonly values = new Float32Array(4);
  private written = false;
  private sums: GPUTexture[] = [];
  private sumViews: GPUTextureView[] = [];
  private meanTexture?: GPUTexture;
  private meanView?: GPUTextureView;
  private last = 0;
  private foldPipeline?: GPURenderPipeline;
  private folds: (GPUBindGroup | undefined)[] = [];
  private input?: GPUTextureView;
  private presentPipeline?: GPURenderPipeline;
  private presentKey = new OutputKey();
  private present?: GPUBindGroup;
  private readonly sumAttachment: GPURenderPassColorAttachment = {
    view: undefined!,
    loadOp: 'clear',
    storeOp: 'store',
  };
  private readonly meanAttachment: GPURenderPassColorAttachment = {
    view: undefined!,
    loadOp: 'clear',
    storeOp: 'store',
  };
  private readonly foldDescriptor: GPURenderPassDescriptor = {
    colorAttachments: [this.sumAttachment, this.meanAttachment],
  };
  private readonly presentAttachment: GPURenderPassColorAttachment = {
    view: undefined!,
    loadOp: 'clear',
    storeOp: 'store',
  };
  private readonly presentDescriptor: GPURenderPassDescriptor = { colorAttachments: [this.presentAttachment] };

  constructor(readonly options: AccumulateOptions = {}) {
    this.validate();
  }

  /** Attaches a new Accumulate to `engine` alone in its own PostStack; it presents the mean through the display curve. */
  static attach(engine: EngineKernel, options: AccumulateOptions = {}): Accumulate {
    const effect = new Accumulate(options);
    effect.stack = PostStack.attach(engine, [effect]);
    return effect;
  }

  /** Mirrors `options.enabled`; false passes frames through, and enabling again starts a new sum. */
  get enabled(): boolean {
    return this.options.enabled ?? true;
  }
  set enabled(value: boolean) {
    if (typeof value !== 'boolean') throw enabledError();
    this.options.enabled = value;
  }

  /** Mirrors `options.weight`: the weight of each frame added from now on. Default 1. */
  get weight(): number {
    return this.options.weight ?? 1;
  }
  set weight(value: number) {
    if (!(Number.isFinite(value) && value >= 0)) throw weightError();
    this.options.weight = value;
  }

  /** Frames added since the last `begin()`. */
  get count(): number {
    return this.frames;
  }

  /** The sum of the weights of those frames. */
  get total(): number {
    return this.sumWeight;
  }

  /** The running weighted mean in linear light (rgba16float, COPY_SRC), or undefined before the first frame. */
  get texture(): GPUTexture | undefined {
    return this.meanTexture;
  }

  /** Starts a new sum: the next frame drawn is the first of it. */
  begin(): void {
    this.fresh = true;
    this.frames = 0;
    this.sumWeight = 0;
  }

  /** The same as `begin()`. */
  reset(): void {
    this.begin();
  }

  private joinStack(_host: StackHost): StackStage {
    if (this.engine || this.stacked || this.disposed)
      throw margoError('attached', 'Accumulate is already attached; create a new Accumulate');
    this.stacked = true;
    return { kind: 'hdr', render: (c, input, output) => this.draw(c, input, output) };
  }

  setup(engine: Engine): void {
    if (this.disposed) throw margoError('disposed', 'Accumulate is disposed; create a new Accumulate');
    if (!this.stacked)
      throw margoError(
        'state',
        'Accumulate runs inside a PostStack; use Accumulate.attach(engine) or add it to a PostStack',
      );
    if (!engine.gpu)
      throw margoError('unsupported', 'Accumulate requires WebGPU; it does not run on the WebGL2 fallback');
    this.engine = engine;
    this.uniform = engine.gpu.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.written = false;
    this.begin();
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
    if (o.enabled !== undefined && typeof o.enabled !== 'boolean') throw enabledError();
    if (o.weight !== undefined && !(Number.isFinite(o.weight) && o.weight >= 0)) throw weightError();
  }

  private draw(c: AccumulatePassContext, input: GPUTextureView, output: StageOutput): GPUTextureView | void {
    this.validate();
    if (!this.enabled) {
      this.begin();
      return input;
    }
    const device = c.device;
    if (this.sums[0]?.width !== c.width || this.sums[0].height !== c.height) {
      this.releaseTargets();
      for (let i = 0; i < 2; i++) {
        this.sums[i] = device.createTexture({
          size: [c.width, c.height],
          format: 'rgba32float',
          usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_SRC,
        });
        this.sumViews[i] = this.sums[i].createView();
      }
      this.meanTexture = device.createTexture({
        size: [c.width, c.height],
        format: 'rgba16float',
        usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_SRC,
      });
      this.meanView = this.meanTexture.createView();
      this.begin();
    }
    const fresh = this.fresh,
      weight = this.weight;
    this.fresh = false;
    this.frames++;
    // The total is kept in float64 and inverted once, so the mean's scale has one float32 rounding.
    this.sumWeight += weight;
    const v = this.values,
      w = Math.fround(weight),
      inverse = Math.fround(this.sumWeight > 0 ? 1 / this.sumWeight : 0);
    if (!this.written || v[0] !== w || v[1] !== +fresh || v[2] !== inverse) {
      v[0] = w;
      v[1] = +fresh;
      v[2] = inverse;
      device.queue.writeBuffer(this.uniform!, 0, v);
      this.written = true;
    }
    if (this.input !== input) {
      this.input = input;
      this.folds = [];
    }
    const next = this.last ^ 1;
    if (!this.foldPipeline) {
      const module = device.createShaderModule({ code: foldShader });
      this.foldPipeline = device.createRenderPipeline({
        layout: 'auto',
        vertex: { module, entryPoint: 'vertex' },
        fragment: { module, entryPoint: 'fragment', targets: [{ format: 'rgba32float' }, { format: 'rgba16float' }] },
      });
    }
    const fold = (this.folds[next] ??= group(device, this.foldPipeline, [
      { buffer: this.uniform! },
      input,
      this.sumViews[this.last],
    ]));
    this.sumAttachment.view = this.sumViews[next];
    this.meanAttachment.view = this.meanView!;
    this.pass(c, this.foldPipeline, fold, this.foldDescriptor, [this.sumAttachment, this.meanAttachment]);
    this.last = next;
    if (output.hdr) return this.meanView;
    if (this.presentKey.changed(output, premultipliedCanvas(this.engine))) {
      this.presentPipeline = render(device, displayFor(this.engine, presentShader), output.format, {
        multisample: output.multisample,
      });
      this.present = undefined;
      this.presentKey.done();
    }
    this.present ??= group(device, this.presentPipeline!, [this.meanView!]);
    this.presentAttachment.view = output.view;
    this.pass(c, this.presentPipeline!, this.present, this.presentDescriptor, [this.presentAttachment]);
  }

  private pass(
    c: AccumulatePassContext,
    pipeline: GPURenderPipeline,
    bindings: GPUBindGroup,
    descriptor: GPURenderPassDescriptor,
    attachments: GPURenderPassColorAttachment[],
  ) {
    for (const a of attachments) a.loadOp = viewLoadOp(c, 'clear');
    const pass = c.encoder.beginRenderPass(descriptor);
    try {
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, bindings);
      applyView(pass, c);
      pass.draw(3);
    } finally {
      pass.end();
    }
  }

  private releaseTargets(): void {
    for (const t of this.sums) t.destroy();
    this.meanTexture?.destroy();
    this.sums = [];
    this.sumViews = [];
    this.meanTexture = this.meanView = this.present = undefined;
    this.folds = [];
    this.last = 0;
  }

  private release(): void {
    this.releaseTargets();
    this.uniform?.destroy();
    this.uniform = this.foldPipeline = this.presentPipeline = this.input = undefined;
    this.presentKey.reset();
    this.written = false;
  }
}
