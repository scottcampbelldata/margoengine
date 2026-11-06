/// <reference lib="esnext.disposable" preserve="true" />
import { SceneTarget } from '../../shared/msaa.js';
import { compatibilityLevel } from '../../shared/compat.js';
import type { EngineKernel } from '@margoengine/core';
import {
  engineRuntime,
  type Engine,
  type EnginePlugin,
  type FrameGraph,
  type PassContext,
} from '@margoengine/core/extension';
import type { StackHost, StackStage, StageOutput } from '../../shared/stack.js';
import { margoError } from '../../shared/errors.js';
import { coreShaderRequired, linearShader } from '../../shared/display.js';
declare const GPUTextureUsage: { RENDER_ATTACHMENT: number; TEXTURE_BINDING: number; COPY_SRC: number };
type Context = Extract<PassContext, { backend: 'webgpu' }>;
const owners = ['bloom', 'ssao', 'dof', 'tonemap', 'post-processing'],
  rank = { hdr: 0, display: 1, ldr: 2 },
  single = { count: 1 };

/**
 * The HDR capture's format. Linear half floats, except where the capture is multisampled at WebGPU's compatibility level,
 * which cannot multisample them: there rg11b10ufloat, with less precision and no alpha.
 */
const captureFormat = (d: GPUDevice, samples: number): GPUTextureFormat =>
  samples > 1 && compatibilityLevel(d) && d.features.has('rg11b10ufloat-renderable')
    ? 'rg11b10ufloat'
    : 'rgba16float';

/** One HDR scene capture shared by several effects, applied in array order: HDR effects (SSAO, DOF, Bloom, Afterimage),
 * at most one display effect (Tonemap or creative PostProcessing), then LDR effects (SMAA or FXAA, Glitch). Without a
 * display effect the last HDR effect tonemaps as it does alone. The stack attaches, restores and disposes its effects.
 * @throws TypeError when `effects` is empty, repeats a name, holds an effect that cannot join or holds both SMAA and
 * FXAA; RangeError when they are out of order (HDR, display, LDR); MargoError `'attached'` when an effect is already
 * attached or a capture owner is attached alone, `'unsupported'` on a WebGL engine or when another plugin replaced
 * core's lighting shader, `'disposed'` after `dispose()`. */
export class PostStack implements EnginePlugin {
  readonly name = 'post:stack';
  private engine?: Engine;
  private color?: GPUTexture;
  private colorView?: GPUTextureView;
  private readonly host: StackHost = {};
  private readonly stages: StackStage[];
  private readonly live: boolean[] = [];
  private count = 0;
  private attached = 0;
  private disposed = false;
  private source?: string;
  private linear = '';
  private slots: (GPUTexture | undefined)[] = [];
  private views: GPUTextureView[] = [];
  private readonly hdr: StageOutput = { view: undefined!, format: 'rgba16float', multisample: single, hdr: true };
  private readonly ldr: StageOutput = { view: undefined!, format: 'bgra8unorm', multisample: single, hdr: false };
  private readonly final: StageOutput = { view: undefined!, format: 'bgra8unorm', multisample: single, hdr: false };
  constructor(readonly effects: readonly EnginePlugin[]) {
    if (
      !Array.isArray(effects) ||
      !effects.length ||
      new Set(effects.map((effect) => effect?.name)).size !== effects.length
    )
      throw new TypeError('PostStack needs distinct effects');
    if (effects.some((effect) => effect?.name === 'smaa') && effects.some((effect) => effect?.name === 'fxaa'))
      throw new TypeError('PostStack takes one anti-aliasing effect; keep SMAA or FXAA, not both');
    let last = 0,
      displays = 0;
    this.stages = effects.map((effect) => {
      const join = (effect as { joinStack?: (host: StackHost) => StackStage }).joinStack;
      if (typeof join !== 'function')
        throw new TypeError(`${effect.name} cannot join a PostStack; pass a post effect.`);
      const stage = join.call(effect, this.host);
      if (rank[stage.kind] < last || (displays += +(stage.kind === 'display')) > 1)
        throw new RangeError('PostStack order: HDR effects, at most one display effect, then LDR effects');
      last = rank[stage.kind];
      return stage;
    });
  }
  static attach(engine: EngineKernel, effects: readonly EnginePlugin[]): PostStack {
    const stack = new PostStack(effects);
    engineRuntime(engine).use(stack);
    return stack;
  }
  /** Resolved 1x scene depth, e.g. for TAA({depth:()=>stack.depthTexture}). */
  get depthTexture(): GPUTexture | undefined {
    return this.host.depthTexture;
  }
  /** The 1x linear HDR scene capture (rgba16float) while the stack has an HDR or display effect, e.g. for
   * Water({sceneColor:()=>stack.sceneTexture}) refraction alongside SSAO; undefined with only LDR effects or before the first frame. */
  get sceneTexture(): GPUTexture | undefined {
    const format = this.color?.format;
    return format === 'rgba16float' || format === 'rg11b10ufloat' ? this.color : undefined;
  }
  setup(engine: Engine): void {
    if (this.disposed || !engine.gpu)
      throw margoError(
        this.disposed ? 'disposed' : 'unsupported',
        'PostStack requires WebGPU and a live stack; attach a new PostStack to a WebGPU engine',
      );
    for (const name of owners)
      if (engine.hasPlugin(name))
        throw margoError('attached', `Add ${name} to the PostStack instead of attaching it alone`);
    this.engine = engine;
    for (const effect of this.effects) {
      engine.use(effect);
      this.attached++;
    }
  }
  registerPasses(graph: FrameGraph): void {
    graph.add({
      name: 'post:stack:capture',
      order: -65,
      execute: (c) => {
        if (c.backend === 'webgpu') this.capture(c);
      },
    });
    graph.add({
      name: 'post:stack:compose',
      order: 30,
      execute: (c) => {
        if (c.backend === 'webgpu') this.compose(c);
      },
    });
  }
  private capture(c: Context): void {
    let hdr = false;
    this.count = 0;
    for (let i = 0; i < this.stages.length; i++)
      if ((this.live[i] = this.engine!.hasPlugin(this.effects[i].name))) {
        this.count++;
        hdr ||= this.stages[i].kind !== 'ldr';
      }
    if (!this.count) return;
    if (hdr && this.source !== c.shader) {
      const linear = linearShader(c.shader);
      if (linear === c.shader) throw margoError('unsupported', coreShaderRequired('PostStack'));
      this.source = c.shader;
      this.linear = linear;
    }
    const samples = c.descriptor.multisample?.count ?? 4,
      depth = c.descriptor.depthStencil!.format,
      format = hdr ? captureFormat(c.device, samples) : c.format,
      h = this.host;
    if (
      this.color?.width !== c.width ||
      this.color.height !== c.height ||
      this.color.format !== format ||
      h.depthTexture!.format !== depth ||
      h.target!.samples !== samples
    ) {
      this.release();
      const usage = GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING;
      this.color = c.device.createTexture({
        size: [c.width, c.height],
        format,
        usage: usage | GPUTextureUsage.COPY_SRC,
      });
      this.colorView = this.color.createView();
      h.depthTexture = c.device.createTexture({ size: [c.width, c.height], format: depth, usage });
      h.target = new SceneTarget(c.device, this.color, h.depthTexture, samples);
    }
    const f = this.final;
    f.view = c.color;
    f.format = this.ldr.format = c.format;
    f.multisample = c.descriptor.multisample ?? single;
    h.target!.begin(c);
    if (hdr) c.shader = this.linear;
  }
  private compose(c: Context): void {
    if (!this.count) return;
    try {
      this.host.target!.resolve(c.encoder, true);
      let input = this.colorView!,
        last = 0,
        display = -1,
        h = 0,
        l = 2;
      for (let i = 0; i < this.stages.length; i++)
        if (this.live[i]) {
          last = i;
          if (this.stages[i].kind !== 'ldr') display = i;
        }
      for (let i = 0; i <= last; i++) {
        if (!this.live[i]) continue;
        const out = i === last ? this.final : i < display ? this.hdr : this.ldr;
        // Ping-pong per kind so no stage reads the texture it writes.
        if (out === this.hdr) {
          out.view = this.slot(c, h, 'rgba16float');
          h ^= 1;
        } else if (out === this.ldr) {
          out.view = this.slot(c, l, out.format);
          l ^= 1;
        }
        input = this.stages[i].render(c, input, out) || out.view;
      }
    } finally {
      this.host.target!.restore(c);
    }
  }
  private slot(c: Context, i: number, format: GPUTextureFormat): GPUTextureView {
    const t = this.slots[i];
    if (t?.width !== c.width || t.height !== c.height || t.format !== format) {
      t?.destroy();
      const n = (this.slots[i] = c.device.createTexture({
        size: [c.width, c.height],
        format,
        usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
      }));
      this.views[i] = n.createView();
    }
    return this.views[i];
  }
  private release(): void {
    this.host.target?.dispose();
    this.color?.destroy();
    this.host.depthTexture?.destroy();
    for (const t of this.slots) t?.destroy();
    this.slots = [];
    this.views = [];
    this.host.target = this.host.depthTexture = this.color = this.colorView = undefined;
  }
  onDeviceRestored(): void {
    this.release();
  }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    const engine = this.engine;
    this.engine = undefined;
    engine?.removePlugin(this.name);
    for (let i = 0; i < this.attached; i++)
      if (engine?.hasPlugin(this.effects[i].name)) engine.removePlugin(this.effects[i].name);
    this.release();
  }
  declare [Symbol.dispose]: () => void;
  [(Symbol.dispose ?? Symbol()) as symbol](): void {
    this.dispose();
  }
}
