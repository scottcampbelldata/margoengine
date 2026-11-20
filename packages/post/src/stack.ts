/// <reference lib="esnext.disposable" preserve="true" />
import { SceneTarget } from '../../shared/msaa.js';
import { requireCompatTier } from '../../shared/compat.js';
import { captureFormat } from './capture.js';
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
type Joiner = { joinStack?: (host: StackHost) => StackStage };
type Item = { effect: EnginePlugin; stage: StackStage; live?: boolean };
const owners = ['bloom', 'ssao', 'dof', 'tonemap', 'post-processing'],
  rank = { hdr: 0, display: 1, ldr: 2 },
  single = { count: 1 },
  ORDER = 'PostStack order: HDR, at most one display, then LDR; reorder the effects';

/** One HDR scene capture shared by several effects, applied in list order: HDR effects (SSAO, DOF, Bloom, Afterimage),
 * at most one display effect (Tonemap or creative PostProcessing), then LDR effects (SMAA or FXAA, Glitch). Without a
 * display effect the last HDR effect tonemaps as it does alone. The stack attaches, restores and disposes its effects;
 * `addEffect`, `removeEffect` and `moveEffect` change the list at any time outside a frame, and an empty stack passes
 * frames through.
 * @throws TypeError when `effects` is not an array or repeats a name, holds an effect that cannot join or holds both
 * SMAA and FXAA; RangeError when they are out of order (HDR, display, LDR); MargoError `'attached'` when an effect is
 * already attached or a capture owner is attached alone, `'unsupported'` on a WebGL engine, for HDR/display effects on
 * the LDR compatibility tier, or when another plugin replaced core's lighting shader, `'disposed'` after `dispose()`. */
export class PostStack implements EnginePlugin {
  readonly name = 'post:stack';
  private engine?: Engine;
  private color?: GPUTexture;
  private colorView?: GPUTextureView;
  private readonly host: StackHost = {};
  private readonly items: Item[] = [];
  // Effects that joined this stack but were refused a place; they may only be added here again.
  private readonly joined = new WeakMap<EnginePlugin, StackStage>();
  private view: readonly EnginePlugin[] = [];
  private count = 0;
  private composing = false;
  private used = 0;
  private owned = false;
  private disposed = false;
  private source?: string;
  private linear = '';
  private slots: (GPUTexture | undefined)[] = [];
  private views: GPUTextureView[] = [];
  private readonly hdr: StageOutput = { view: undefined!, format: 'rgba16float', multisample: single, hdr: true };
  private readonly ldr: StageOutput = { view: undefined!, format: 'bgra8unorm', multisample: single, hdr: false };
  private readonly final: StageOutput = { view: undefined!, format: 'bgra8unorm', multisample: single, hdr: false };
  constructor(effects: readonly EnginePlugin[] = []) {
    if (!Array.isArray(effects)) throw new TypeError('PostStack needs distinct effects');
    if (effects.some((e) => e?.name === 'smaa') && effects.some((e) => e?.name === 'fxaa'))
      throw new TypeError('PostStack: use SMAA or FXAA, never both');
    for (const effect of effects) this.place(effect, this.items.length, true);
  }
  static attach(engine: EngineKernel, effects: readonly EnginePlugin[] = []): PostStack {
    const runtime = engineRuntime(engine);
    // A scene holds one stack (a sky preset, water caustics or a camera may have made it): name the way to add to it.
    if (runtime.hasPlugin('post:stack'))
      throw margoError('attached', 'This scene already has a PostStack; add effects to it with addEffect or PostStack.join');
    const stack = new PostStack(effects);
    runtime.use(stack);
    return stack;
  }
  /**
   * Adds `effect` to the PostStack of the engine's scene, or attaches a new stack holding it when the scene has none;
   * returns the stack. A stack made here disposes itself when its last effect is removed. `index` as in
   * {@link PostStack.addEffect}.
   */
  static join(engine: EngineKernel, effect: EnginePlugin, index?: number): PostStack {
    const runtime = engineRuntime(engine),
      stack = runtime.plugins.get('post:stack');
    if (stack) {
      if (!(stack instanceof PostStack)) throw new TypeError('post:stack is not a PostStack; remove it first');
      return stack.addEffect(effect, index);
    }
    const own = new PostStack();
    own.owned = true;
    own.place(effect, index, false);
    runtime.use(own);
    return own;
  }
  /** The effects in drawing order (a read-only copy, replaced on every change). */
  get effects(): readonly EnginePlugin[] {
    return this.view;
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
  /**
   * Adds `effect` at `index`, or with no index after the last effect of its kind (HDR, display, LDR), and attaches it
   * when the stack is attached; it draws from the next frame and compiles only its own pipelines. Returns the stack.
   * A refused call changes nothing.
   * @throws TypeError (cannot join, repeated name, SMAA with FXAA), RangeError (index out of range or breaking the
   * order), MargoError `'attached'` (the effect is attached or in another stack), `'unsupported'` (an HDR or display
   * effect on the LDR tier), `'disposed'`, `'state'` (called while a frame draws).
   */
  addEffect(effect: EnginePlugin, index?: number): this {
    if (this.disposed) throw margoError('disposed', 'This PostStack is disposed; attach a new PostStack');
    this.place(effect, index, false);
    return this;
  }
  /** Takes `effect` out of the stack and disposes it, as `scene.removePlugin` does; true when it was in the stack.
   * To switch an effect off and on without disposing it, set its `enabled` option. A disposed stack returns false. */
  removeEffect(effect: EnginePlugin): boolean {
    if (this.disposed || this.at(effect) < 0) return false;
    this.idle();
    const scene = this.engine?.sceneOf(effect);
    // Core removes it before anything else changes: during a frame it throws 'state' and the list stays as it was.
    // The effect's dispose may call removeEffect again (a factory's own stack), which then takes it out first.
    scene?.removePlugin(effect.name);
    const i = this.at(effect);
    if (i >= 0) this.splice(i, 1);
    if (!scene) effect.dispose?.();
    if (this.owned && !this.items.length) this.dispose();
    return true;
  }
  /** Moves `effect` to `index` without disposing it; the order rule (HDR, display, LDR) still holds. Returns the stack.
   * @throws TypeError when `effect` is not in the stack, RangeError for an index that is out of range or breaks the
   * order, MargoError `'disposed'`, `'state'` while the stack composes. */
  moveEffect(effect: EnginePlugin, index: number): this {
    if (this.disposed) throw margoError('disposed', 'This PostStack is disposed; attach a new PostStack');
    const i = this.at(effect);
    if (i < 0) throw new TypeError(`${effect?.name} is not in this PostStack; use addEffect`);
    this.idle();
    const item = this.items[i],
      kinds = this.kinds();
    kinds.splice(i, 1);
    check(kinds, item.stage.kind, index);
    // The live flag moves with its effect, so a move between this frame's capture and compose stays consistent.
    this.splice(i, 1);
    this.splice(index, 0, item);
    return this;
  }
  private idle(): void {
    if (this.composing) throw margoError('state', 'PostStack is composing a frame; change it outside the frame');
  }
  private at(effect: EnginePlugin): number {
    return this.items.findIndex((item) => item.effect === effect);
  }
  private kinds(): StackStage['kind'][] {
    return this.items.map((item) => item.stage.kind);
  }
  private splice(i: number, remove: number, item?: Item): void {
    if (item) this.items.splice(i, remove, item);
    else this.items.splice(i, remove);
    this.view = Object.freeze(this.items.map((x) => x.effect));
  }
  /** Validates, joins, checks the tier, inserts and attaches; anything that throws leaves the list as it was. */
  private place(effect: EnginePlugin, index: number | undefined, strict: boolean): void {
    const name = effect?.name;
    if (!name || this.view.some((e) => e.name === name)) throw new TypeError('PostStack needs distinct effects');
    if ((name === 'smaa' || name === 'fxaa') && this.view.some((e) => e.name === (name === 'smaa' ? 'fxaa' : 'smaa')))
      throw new TypeError('PostStack: use SMAA or FXAA, never both');
    // A plugin of the same name elsewhere in the scene: core's use throws TypeError below and the splice is undone.
    const scene = this.engine?.sceneOf(this);
    this.idle();
    let stage = this.joined.get(effect);
    if (!stage) {
      const join = (effect as Joiner).joinStack;
      if (typeof join !== 'function') throw new TypeError(`${name} cannot join a PostStack; pass a post effect.`);
      stage = join.call(effect, this.host);
      this.joined.set(effect, stage);
    }
    const kinds = this.kinds(),
      kind = stage.kind;
    const at = index ?? (strict ? kinds.length : kinds.filter((k) => rank[k] <= rank[kind]).length);
    check(kinds, kind, at);
    const gpu = this.engine?.gpu;
    if (gpu && kind !== 'ldr') requireCompatTier(gpu, 'PostStack HDR/display effects', 'half-float');
    this.splice(at, 0, { effect, stage });
    try {
      scene?.use(effect);
    } catch (error) {
      this.splice(at, 1);
      throw error;
    }
    this.joined.delete(effect);
  }
  setup(engine: Engine): void {
    if (this.disposed || !engine.gpu)
      throw margoError(
        this.disposed ? 'disposed' : 'unsupported',
        'Attach a new PostStack on WebGPU; see https://margoengine.com/errors#webgpu',
      );
    this.requireTier(engine.gpu);
    for (const name of owners)
      if (engine.hasPlugin(name))
        throw margoError('attached', `Add ${name} to the PostStack instead of attaching it alone`);
    this.engine = engine;
    for (const effect of this.view) engine.use(effect);
  }
  private requireTier(device: GPUDevice): void {
    if (this.kinds().some((kind) => kind !== 'ldr'))
      requireCompatTier(device, 'PostStack HDR/display effects', 'half-float');
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
    const scene = this.engine!.sceneOf(this);
    this.count = 0;
    for (const item of this.items)
      if ((item.live = this.engine!.sceneOf(item.effect) === scene)) {
        this.count++;
        hdr ||= item.stage.kind !== 'ldr';
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
    this.composing = true;
    try {
      this.host.target!.resolve(c.encoder, true);
      let input = this.colorView!,
        last = 0,
        display = -1,
        h = 0,
        l = 2;
      this.used = 0;
      const items = this.items;
      for (let i = 0; i < items.length; i++)
        if (items[i].live) {
          last = i;
          if (items[i].stage.kind !== 'ldr') display = i;
        }
      for (let i = 0; i <= last; i++) {
        if (!items[i].live) continue;
        const out = i === last ? this.final : i < display ? this.hdr : this.ldr;
        // Ping-pong per kind so no stage reads the texture it writes.
        if (out === this.hdr) {
          out.view = this.slot(c, h, 'rgba16float');
          h ^= 1;
        } else if (out === this.ldr) {
          out.view = this.slot(c, l, out.format);
          l ^= 1;
        }
        input = items[i].stage.render(c, input, out) || out.view;
      }
      // A ping-pong target no stage wrote this frame (its effects were removed or moved) is freed now.
      for (let i = 0; i < 4; i++)
        if (this.slots[i] && !(this.used & (1 << i))) {
          this.slots[i]!.destroy();
          this.slots[i] = undefined;
        }
    } finally {
      this.composing = false;
      this.host.target!.restore(c);
    }
  }
  private slot(c: Context, i: number, format: GPUTextureFormat): GPUTextureView {
    this.used |= 1 << i;
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
    if (this.disposed) return;
    this.release();
    try {
      if (this.engine?.gpu) this.requireTier(this.engine.gpu);
    } catch (error) {
      this.dispose();
      throw error;
    }
  }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    const engine = this.engine;
    this.engine = undefined;
    engine?.sceneOf(this)?.removePlugin(this.name);
    // Only the effects that attached: a setup that failed part way leaves the rest to their owner, as before.
    for (const effect of this.view) engine?.sceneOf(effect)?.removePlugin(effect.name);
    this.release();
  }
  declare [Symbol.dispose]: () => void;
  [(Symbol.dispose ?? Symbol()) as symbol](): void {
    this.dispose();
  }
}
/** Throws RangeError unless a `kind` effect may go at `at` among `kinds` (HDR, at most one display, then LDR). */
function check(kinds: StackStage['kind'][], kind: StackStage['kind'], at: number): void {
  if (!Number.isInteger(at) || at < 0 || at > kinds.length)
    throw new RangeError(`PostStack index ${at}; pass 0 to ${kinds.length}`);
  const before = kinds[at - 1],
    after = kinds[at];
  if (
    (before && rank[before] > rank[kind]) ||
    (after && rank[after] < rank[kind]) ||
    (kind === 'display' && kinds.includes('display'))
  )
    throw new RangeError(ORDER);
}
