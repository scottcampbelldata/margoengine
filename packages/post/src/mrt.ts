/// <reference lib="esnext.disposable" preserve="true" />
// Several named render targets from one scene pass: each output is a built-in surface value (albedo, normal,
// position, distance, emissive, material) or the caller's WGSL over the same surface, written by core meshes (a replay
// of core's lit shader with its lighting in a dead block, as SSR's material replay) and by gltf-pro models and
// materials meshes added with `add()` (gltf-pro's capture hook, shared with SSR and SSGI through capture.ts). Its own
// single-sample depth is a sampleable depth texture of the same pass.
import type { EngineKernel } from '@margoengine/core';
import type { Engine, EnginePlugin, FrameGraph, PassContext } from '@margoengine/core/extension';
import { margoError } from '../../shared/errors.js';
import { captureModel, drawCapture } from '../../shared/capture.js';
import { currentFrame, retire } from '../../shared/frame-resources.js';
import type { SSRCapture, SSRModel } from './ssr.js';
declare const GPUTextureUsage: { RENDER_ATTACHMENT: number; TEXTURE_BINDING: number; COPY_SRC: number };
type TargetsPassContext = Extract<PassContext, { backend: 'webgpu' }>;
/** The textures of one drawing size, and the frame that last drew into them. */
type TargetSet = { width: number; height: number; textures: GPUTexture[]; depth: GPUTexture; used: number };

/**
 * A built-in output: `albedo` (base colour and alpha), `normal` (world shading normal, w 1), `position` (world, w 1),
 * `distance` (world distance from the camera in x), `emissive` (rgb, w 1), `material` (roughness, metalness,
 * occlusion, 1). Core meshes have no emissive (black) and occlusion 1.
 */
export type TargetValue = 'albedo' | 'normal' | 'position' | 'distance' | 'emissive' | 'material';
/** One named output: a built-in `value` or a `wgsl` expression, and its texture format. */
export interface TargetOutput {
  /** Built-in value written. Default 'albedo' when `wgsl` is unset. */
  value?: TargetValue;
  /**
   * WGSL expression of type `vec4f` over `t: TargetSurface` {position: vec3f, normal: vec3f, albedo: vec4f, roughness:
   * f32, metalness: f32, occlusion: f32, emissive: vec3f, eye: vec3f}, all world space: `vec4f(t.normal.y, 0, 0, 1)`.
   */
  wgsl?: string;
  /**
   * A float or normalised colour format. Default 'rgba8unorm' for albedo, 'r32float' for distance, 'rgba16float'
   * otherwise. 32-bit float targets filter only with `float32-filterable`; read them with `textureLoad`.
   */
  format?: GPUTextureFormat;
  /** Clear value where nothing is drawn. Default transparent black. */
  clear?: GPUColor;
}
/** Options for {@link SceneTargets}. */
export interface SceneTargetsOptions {
  /** Named outputs, 1 to 7, in attachment order: a built-in value name or a {@link TargetOutput}. */
  outputs: Readonly<Record<string, TargetValue | TargetOutput>>;
  /** Frame-graph order of the targets pass. Default -5: before the main pass, so this frame's materials can sample them. */
  order?: number;
}

const values: Record<TargetValue, [string, GPUTextureFormat]> = {
  albedo: ['t.albedo', 'rgba8unorm'],
  normal: ['vec4f(t.normal,1)', 'rgba16float'],
  position: ['vec4f(t.position,1)', 'rgba16float'],
  distance: ['vec4f(distance(t.eye,t.position),0,0,1)', 'r32float'],
  emissive: ['vec4f(t.emissive,1)', 'rgba16float'],
  material: ['vec4f(t.roughness,t.metalness,t.occlusion,1)', 'rgba16float'],
};
const surface =
  'struct TargetSurface {position:vec3f,normal:vec3f,albedo:vec4f,roughness:f32,metalness:f32,occlusion:f32,emissive:vec3f,eye:vec3f}\n';
const identifier = /^[A-Za-z][A-Za-z0-9_]*$/;
// Integer and depth formats would need other WGSL output types; colour-renderable float and unorm formats only.
const floatFormat = /^(r|rg|rgba|bgra)(8unorm|8unorm-srgb|16float|32float)$|^rgb10a2unorm$|^rg11b10ufloat$/;

/**
 * Multiple render targets with named outputs: one pass draws the scene's surfaces into a texture per output, plus a
 * sampleable depth (`depth`). `SceneTargets.attach(engine, {outputs: {albedo: 'albedo', normal: 'normal', mask:
 * {wgsl: 'vec4f(t.roughness)', format: 'r8unorm'}}})`; read `targets.texture('normal')` after a frame. Core meshes
 * always draw; add gltf-pro models and materials meshes with `add(model)` so their own materials (maps, skinning,
 * instances) write the outputs. The textures follow the drawing size and are replaced on resize (`onResize`). A
 * material that samples a target must not be added (a pass cannot write and read one texture). WebGPU only.
 */
export class SceneTargets implements EnginePlugin {
  readonly name: string;
  /** Output names in attachment order. */
  readonly names: readonly string[];
  private readonly formats: GPUTextureFormat[];
  private readonly clears: GPUColor[];
  private readonly code: string;
  private engine?: Engine;
  private device?: GPUDevice;
  private textures: GPUTexture[] = [];
  private views: GPUTextureView[] = [];
  private sets: TargetSet[] = [];
  private depthTexture?: GPUTexture;
  private depthView?: GPUTextureView;
  private width = 0;
  private height = 0;
  private pipeline?: GPURenderPipeline;
  private pipelineKey = '';
  private single?: GPURenderPipelineDescriptor;
  private base?: GPURenderPipelineDescriptor;
  private context?: TargetsPassContext;
  private pass?: GPURenderPassEncoder;
  private disposed = false;
  private readonly models = new Map<SSRModel, () => void>();
  private readonly listeners = new Set<() => void>();
  private readonly modelCode = new Map<string, string>();
  private readonly hook: SSRCapture;
  private static serial = 0;

  constructor(readonly options: SceneTargetsOptions) {
    const outputs = options?.outputs;
    if (!outputs || typeof outputs !== 'object')
      throw new TypeError("SceneTargets needs outputs; pass {outputs: {name: 'albedo', ...}}");
    const entries = Object.entries(outputs);
    if (entries.length < 1 || entries.length > 7)
      throw new RangeError(`SceneTargets takes 1 to 7 outputs, not ${entries.length}; pass fewer`);
    const order = options.order ?? -5;
    if (typeof order !== 'number' || !Number.isFinite(order))
      throw new TypeError('SceneTargets order must be a finite number; pass a frame-graph order');
    this.name = 'scene-targets:' + SceneTargets.serial++;
    this.names = entries.map(([name]) => name);
    this.formats = [];
    this.clears = [];
    const lines: string[] = [];
    entries.forEach(([name, given], i) => {
      if (!identifier.test(name))
        throw new TypeError(`SceneTargets output '${name}' needs a plain identifier name; use letters and digits`);
      const output: TargetOutput = typeof given === 'string' ? { value: given } : given;
      if (!output || typeof output !== 'object')
        throw new TypeError(`SceneTargets output '${name}' must be a value name or {value | wgsl, format}`);
      if (output.value !== undefined && !(output.value in values))
        throw new TypeError(
          `SceneTargets output '${name}' value '${output.value}' is unknown; use ${Object.keys(values).join(', ')}`,
        );
      if (output.wgsl !== undefined && (typeof output.wgsl !== 'string' || !output.wgsl.trim()))
        throw new TypeError(`SceneTargets output '${name}' wgsl must be a WGSL vec4f expression over t`);
      const [expression, format] = values[output.value ?? 'albedo'],
        chosen = output.format ?? (output.wgsl ? 'rgba16float' : format);
      if (!floatFormat.test(chosen))
        throw new TypeError(
          `SceneTargets output '${name}' format '${chosen}' is not a float or unorm colour format; use rgba16float or rgba8unorm`,
        );
      this.formats.push(chosen);
      this.clears.push(output.clear ?? { r: 0, g: 0, b: 0, a: 0 });
      lines.push(`o.o${i}=vec4f(${output.wgsl ?? expression});`);
    });
    this.code =
      surface +
      `struct MargoCapture {${this.formats.map((_, i) => `@location(${i}) o${i}:vec4f`).join(',')}}\n` +
      `fn margoTargets(t:TargetSurface)->MargoCapture {var o:MargoCapture;${lines.join('')}return o;}\n`;
    this.hook = {
      targets: this.formats.map((format) => ({ format })),
      declarations: (code) => {
        let out = this.modelCode.get(code);
        if (out === undefined) {
          if (!code.includes('struct Surface'))
            throw margoError(
              'unsupported',
              'SceneTargets captures gltf-pro surfaces only; add gltf-pro models or materials meshes',
            );
          if (this.modelCode.size >= 64) this.modelCode.clear();
          out =
            'var<private> margoPosition:vec3f;\n' +
            this.code +
            'fn margoCapture(s:Surface,v:vec3f,k:vec3f)->MargoCapture {_=k;_=v;return margoTargets(TargetSurface(margoPosition,s.n,s.base,s.roughness,s.metal,s.occlusion,s.emissive,f.eye.xyz));}\n';
          this.modelCode.set(code, out);
        }
        return out;
      },
      begin: () => {
        if (this.pass) return this.pass;
        const pass = (this.pass = this.context!.encoder.beginRenderPass({
          colorAttachments: this.views.map((view) => ({ view, loadOp: 'load', storeOp: 'store' })),
          depthStencilAttachment: { view: this.depthView!, depthLoadOp: 'load', depthStoreOp: 'store' },
        }));
        const rect = this.context!.view?.viewport;
        if (rect) {
          pass.setViewport(rect[0], rect[1], rect[2], rect[3], 0, 1);
          const scissor = this.context!.view!.scissor ?? rect;
          pass.setScissorRect(scissor[0], scissor[1], scissor[2], scissor[3]);
        }
        return pass;
      },
    };
  }
  /** Same as `engine.use(new SceneTargets(options))`; returns the targets. */
  static attach(engine: EngineKernel, options: SceneTargetsOptions): SceneTargets {
    const targets = new SceneTargets(options);
    engine.use(targets);
    return targets;
  }
  /** The texture of output `name` (1 sample, RENDER_ATTACHMENT and TEXTURE_BINDING); undefined before the first frame. */
  texture(name: string): GPUTexture | undefined {
    return this.textures[this.index(name)];
  }
  /** A view of output `name`'s texture; undefined before the first frame. */
  view(name: string): GPUTextureView | undefined {
    return this.views[this.index(name)];
  }
  /**
   * The pass's depth (depth32float, 1 sample, reversed Z: 1 near, 0 far or empty), sampleable as `texture_depth_2d`;
   * undefined before the first frame.
   */
  get depth(): GPUTexture | undefined {
    return this.depthTexture;
  }
  /**
   * Calls `listener` after the current textures change: the first frame, a resize, a restored device, and between views
   * of one frame that draw at other sizes (the canvas and a view `target`; each size keeps its own textures). Returns a
   * remover.
   */
  onResize(listener: () => void): () => void {
    if (typeof listener !== 'function') throw new TypeError('SceneTargets onResize needs a function');
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  /**
   * Draws `model` (a gltf-pro model or materials mesh) into the targets with its own materials; returns a remover.
   * Models not added still draw in the scene but leave the targets alone.
   */
  add(model: SSRModel): () => void {
    if (this.disposed) throw margoError('disposed', 'SceneTargets is disposed; create new SceneTargets');
    if (!model || typeof model.setCapture !== 'function')
      throw new TypeError('SceneTargets.add needs a gltf-pro model or materials mesh');
    return captureModel(this.models, model, this.hook);
  }
  setup(engine: Engine): void {
    if (this.disposed) throw margoError('disposed', 'SceneTargets is disposed; create new SceneTargets');
    if (!engine.gpu) throw margoError('unsupported', 'SceneTargets needs WebGPU; create the engine with webgpu');
    this.engine = engine;
    this.device = engine.gpu;
  }
  registerPasses(graph: FrameGraph): void {
    graph.add({
      name: this.name,
      order: this.options.order ?? -5,
      execute: (c) => {
        if (c.backend === 'webgpu') this.draw(c);
      },
    });
  }
  private index(name: string): number {
    const i = this.names.indexOf(name);
    if (i < 0) throw new RangeError(`SceneTargets has no output '${name}'; use one of ${this.names.join(', ')}`);
    return i;
  }
  private draw(c: TargetsPassContext): void {
    if (this.disposed) return;
    this.resize(c);
    if (this.base !== c.descriptor) {
      this.base = c.descriptor;
      this.single = {
        ...c.descriptor,
        multisample: { count: 1 },
        depthStencil: { format: 'depth32float', depthWriteEnabled: true, depthCompare: 'greater-equal' },
      };
    }
    // Core's lit shader with its lighting in a dead block: every binding stays statically used, none of it computed.
    const key = c.shader;
    if (this.pipelineKey !== key) {
      const code = c.shader
        .replace(/(@fragment[^{]*)->@location\(0\) vec4f/, '$1->MargoCapture')
        .replace(
          /(let direct=[\s\S]*)return (vec4f\([^\n]+\));/,
          'if(false){$1_=$2;}return margoTargets(TargetSurface(i.position,n,vec4f(i.color,1),i.material.x,i.material.y,1.0,vec3f(0),frame.eye.xyz));',
        );
      if (!code.includes('->MargoCapture') || !code.includes('return margoTargets('))
        throw margoError(
          'unsupported',
          "SceneTargets needs the standard core lighting shader; remove the plugin that replaced core's shader",
        );
      const module = c.device.createShaderModule({ code: code + '\n' + this.code });
      this.pipeline = c.device.createRenderPipeline({
        ...this.single!,
        layout: 'auto',
        vertex: { ...c.descriptor.vertex, module },
        fragment: { module, entryPoint: 'fragment', targets: this.formats.map((format) => ({ format })) },
      });
      this.pipelineKey = key;
    }
    // The first view of a frame clears every target; later views draw over it.
    if (!c.view?.index)
      c.encoder
        .beginRenderPass({
          colorAttachments: this.views.map((view, i) => ({
            view,
            clearValue: this.clears[i],
            loadOp: 'clear',
            storeOp: 'store',
          })),
          depthStencilAttachment: {
            view: this.depthView!,
            depthClearValue: 0,
            depthLoadOp: 'clear',
            depthStoreOp: 'store',
          },
        })
        .end();
    const { color, depth, descriptor } = c;
    c.color = this.views[0];
    c.depth = this.depthView!;
    c.descriptor = this.single!;
    try {
      c.draw({
        pipeline: this.pipeline,
        clear: false,
        clearDepth: false,
        bindings: c.bindings,
        colorAttachments: this.views.slice(1).map((view) => ({ view, loadOp: 'load', storeOp: 'store' })),
      });
      if (this.models.size) {
        this.context = c;
        for (const model of this.models.keys()) drawCapture(model, this.hook, c);
      }
    } finally {
      this.pass?.end();
      this.pass = this.context = undefined;
      Object.assign(c, { color, depth, descriptor });
    }
  }
  private resize(c: TargetsPassContext): void {
    const frame = currentFrame(c.device, c.view ?? c);
    let set = this.sets.find((s) => s.width === c.width && s.height === c.height);
    if (!set) {
      const usage = GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_SRC,
        textures = this.formats.map((format, i) =>
          c.device.createTexture({ size: [c.width, c.height], format, usage, label: this.names[i] }),
        ),
        depth = c.device.createTexture({ size: [c.width, c.height], format: 'depth32float', usage });
      set = { width: c.width, height: c.height, textures, depth, used: frame };
      this.sets.push(set);
    }
    set.used = frame;
    // Views into destinations of other sizes (the canvas and a view target) keep a set each, so they draw every frame
    // without recreating textures; a size no view drew last frame or this one is released.
    for (const old of this.sets.filter((s) => s.used < frame - 1)) this.drop(old);
    if (set.textures[0] === this.textures[0]) return;
    this.width = set.width;
    this.height = set.height;
    this.textures = set.textures;
    this.views = set.textures.map((texture) => texture.createView());
    this.depthTexture = set.depth;
    this.depthView = set.depth.createView();
    for (const listener of this.listeners) listener();
  }
  private drop(set: TargetSet): void {
    this.sets.splice(this.sets.indexOf(set), 1);
    if (this.device) for (const t of [...set.textures, set.depth]) retire(this.device, t);
  }
  private release(): void {
    for (const set of [...this.sets]) this.drop(set);
    this.textures = [];
    this.views = [];
    this.depthTexture = this.depthView = undefined;
    this.width = this.height = 0;
  }
  onDeviceRestored(engine: Engine): void {
    this.sets = [];
    this.textures = [];
    this.views = [];
    this.depthTexture = this.depthView = undefined;
    this.pipelineKey = '';
    this.base = undefined;
    this.width = this.height = 0;
    this.setup(engine);
  }
  /** Releases the textures and stops drawing added models' captures. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const release of [...this.models.values()]) release();
    this.release();
    this.listeners.clear();
    const engine = this.engine;
    this.engine = undefined;
    if (engine?.plugins?.has?.(this.name)) engine.removePlugin(this.name);
  }
  declare [Symbol.dispose]: () => void;
  [(Symbol.dispose ?? Symbol()) as symbol](): void {
    this.dispose();
  }
}
