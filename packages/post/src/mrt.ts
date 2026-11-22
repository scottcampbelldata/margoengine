/// <reference lib="esnext.disposable" preserve="true" />
// Several named render targets from one scene pass: each output is a built-in surface value (albedo, normal,
// position, distance, emissive, material, the sun's shadow visibility and the look masks made from it) or the caller's
// WGSL over the same surface, written by core meshes (a replay of core's lit shader with its lighting in a dead block,
// as SSR's material replay; the sun visibility a shadow plugin wrapped around `direct` stays live), by gltf/pbr models
// and materials meshes added with `add()` (gltf/pbr's capture hook, shared with SSR and SSGI through capture.ts) and by
// terrain (its SSR-style capture hook). Its own single-sample depth is a sampleable depth texture of the same pass.
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
 *
 * Sun light and the look masks (`@margoengine/headless/look` T1, T5, T6): `shadow` (the sun's shadow visibility in x,
 * 1 lit to 0 hidden, the luminance of what a shadow plugin lets through, 1 with none; the cosine to the sun in y),
 * `penumbra` (1 on a surface facing the sun whose visibility is partial), `litGround` (1 on ground, a normal within
 * 45 degrees of up, that faces the sun and is fully lit), `shadedGround` (the same ground with the sun fully hidden)
 * and `subject` (1 on models added with `{subject: true}`). The masks are `r8unorm`; see {@link TARGET_MASK_LIMITS}.
 */
export type TargetValue =
  | 'albedo'
  | 'normal'
  | 'position'
  | 'distance'
  | 'emissive'
  | 'material'
  | 'shadow'
  | 'penumbra'
  | 'litGround'
  | 'shadedGround'
  | 'subject';
/**
 * The limits the built-in look masks use: `partial` is the visibility range a `penumbra` pixel lies strictly inside,
 * `full` how close to 1 (lit) or 0 (hidden) the ground masks need it, `facing` the least cosine to the sun of a
 * penumbra pixel and `groundFacing` of a ground pixel (a grazing sun puts no clear shadow down), `ground` the least
 * up component of a ground normal (45 degrees).
 */
export const TARGET_MASK_LIMITS = Object.freeze({
  partial: [0.02, 0.98],
  full: 0.02,
  facing: 0.05,
  groundFacing: 0.2,
  ground: 0.7071,
});
/** One named output: a built-in `value` or a `wgsl` expression, and its texture format. */
export interface TargetOutput {
  /** Built-in value written. Default 'albedo' when `wgsl` is unset. */
  value?: TargetValue;
  /**
   * WGSL expression of type `vec4f` over `t: TargetSurface` {position: vec3f, normal: vec3f, albedo: vec4f, roughness:
   * f32, metalness: f32, occlusion: f32, emissive: vec3f, eye: vec3f, shadow: f32, light: vec3f, subject: f32}, all
   * world space: `vec4f(t.normal.y, 0, 0, 1)`. `shadow` is the sun's visibility (1 lit, 0 hidden), `light` the unit
   * direction toward the sun, `subject` 1 on models added with `{subject: true}`.
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
  /**
   * Frame-graph order of the targets pass. Default -4.5: after the passes at -5 that change core's shader and draw
   * shadow maps (Shadows, sections), whatever order they were attached in, and before the main pass, so this frame's
   * materials can sample the targets.
   */
  order?: number;
}
/** Options of {@link SceneTargets.add}. */
export interface SceneTargetsAddOptions {
  /** The model is the shot's subject: `t.subject` reads 1 on it (the `subject` value). Default false. */
  subject?: boolean;
}

const L = TARGET_MASK_LIMITS,
  facing = 'dot(t.normal,t.light)',
  ground = `t.normal.y>=${L.ground}&&${facing}>=${L.groundFacing}`,
  mask = (test: string): [string, GPUTextureFormat] => [`vec4f(select(0.0,1.0,${test}),0,0,1)`, 'r8unorm'];
const values: Record<TargetValue, [string, GPUTextureFormat]> = {
  albedo: ['t.albedo', 'rgba8unorm'],
  normal: ['vec4f(t.normal,1)', 'rgba16float'],
  position: ['vec4f(t.position,1)', 'rgba16float'],
  distance: ['vec4f(distance(t.eye,t.position),0,0,1)', 'r32float'],
  emissive: ['vec4f(t.emissive,1)', 'rgba16float'],
  material: ['vec4f(t.roughness,t.metalness,t.occlusion,1)', 'rgba16float'],
  shadow: [`vec4f(t.shadow,max(${facing},0.0),0,1)`, 'rg16float'],
  penumbra: mask(`${facing}>${L.facing}&&t.shadow>${L.partial[0]}&&t.shadow<${L.partial[1]}`),
  litGround: mask(`${ground}&&t.shadow>=${1 - L.full}`),
  shadedGround: mask(`${ground}&&t.shadow<=${L.full}`),
  subject: ['vec4f(t.subject,0,0,1)', 'r8unorm'],
};
const surface =
  'struct TargetSurface {position:vec3f,normal:vec3f,albedo:vec4f,roughness:f32,metalness:f32,occlusion:f32,emissive:vec3f,eye:vec3f,shadow:f32,light:vec3f,subject:f32}\n';
// Rec. 709 luminance: a coloured shadow (tinted glass) counts by how much light it lets through.
const luminance = 'vec3f(0.2126,0.7152,0.0722)';
/** The sun visibility a lit shader computes, `direct` (the light a shadow plugin wraps) set to 1; 1.0 when unshadowed. */
const sunVisibility = (code: string, position: string, normal: string): string =>
  code.includes('fn shadowLit(') ? `dot(shadowLit(vec3f(1),${position},${normal}),${luminance})` : '1.0';
// Terrain's capture hook (SSR's contract for shaders without the PBR Surface): its Frame names eye and light.
const terrainFrame = /struct Frame \{camera:mat4x4f,eye:vec4f,light:vec4f,/;
const identifier = /^[A-Za-z][A-Za-z0-9_]*$/;
// Integer and depth formats would need other WGSL output types; colour-renderable float and unorm formats only.
const floatFormat = /^(r|rg|rgba|bgra)(8unorm|8unorm-srgb|16float|32float)$|^rgb10a2unorm$|^rg11b10ufloat$/;

/**
 * Multiple render targets with named outputs: one pass draws the scene's surfaces into a texture per output, plus a
 * sampleable depth (`depth`). `SceneTargets.attach(engine, {outputs: {albedo: 'albedo', normal: 'normal', mask:
 * {wgsl: 'vec4f(t.roughness)', format: 'r8unorm'}}})`; read `targets.texture('normal')` after a frame. Core meshes
 * always draw; add gltf/pbr models and materials meshes with `add(model)` so their own materials (maps, skinning,
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
  private readonly hooks = new WeakMap<SSRModel, SSRCapture>();
  private readonly listeners = new Set<() => void>();
  private readonly hook: SSRCapture;
  private readonly subjectHook: SSRCapture;
  private static serial = 0;

  constructor(readonly options: SceneTargetsOptions) {
    const outputs = options?.outputs;
    if (!outputs || typeof outputs !== 'object')
      throw new TypeError("SceneTargets needs outputs; pass {outputs: {name: 'albedo', ...}}");
    const entries = Object.entries(outputs);
    if (entries.length < 1 || entries.length > 7)
      throw new RangeError(`SceneTargets takes 1 to 7 outputs, not ${entries.length}; pass fewer`);
    const order = options.order ?? -4.5;
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
    this.hook = this.makeHook(0);
    this.subjectHook = this.makeHook(1);
  }
  /** The capture hook of models whose `t.subject` reads `subject`. */
  private makeHook(subject: 0 | 1): SSRCapture {
    const cache = new Map<string, string>(),
      flag = subject ? '1.0' : '0.0',
      fields = this.formats.map((_, i) => `o.o${i}`).join(',');
    return {
      targets: this.formats.map((format) => ({ format })),
      declarations: (code) => {
        let out = cache.get(code);
        if (out === undefined) {
          let capture: string;
          if (code.includes('struct Surface'))
            capture = `fn margoCapture(s:Surface,v:vec3f,k:vec3f)->MargoCapture {_=k;_=v;return margoTargets(TargetSurface(margoPosition,s.n,s.base,s.roughness,s.metal,s.occlusion,s.emissive,f.eye.xyz,${sunVisibility(code, 'margoPosition', 's.n')},f.light.xyz,${flag}));}\n`;
          else if (terrainFrame.test(code))
            // Terrain returns `margoSSR(n, v, base, metal, rough)` as a MargoSSR: the same outputs under that name.
            capture =
              `struct MargoSSR {${this.formats.map((_, i) => `@location(${i}) o${i}:vec4f`).join(',')}}\n` +
              `fn margoSSR(n:vec3f,v:vec3f,base:vec3f,metal:f32,rough:f32)->MargoSSR {_=v;let o=margoTargets(TargetSurface(margoPosition,n,vec4f(base,1),rough,metal,1.0,vec3f(0),frame.eye.xyz,${sunVisibility(code, 'margoPosition', 'n')},frame.light.xyz,${flag}));return MargoSSR(${fields});}\n`;
          else
            throw margoError(
              'unsupported',
              'SceneTargets captures gltf/pbr surfaces and terrain only; add gltf/pbr models, materials meshes or a Terrain',
            );
          if (cache.size >= 64) cache.clear();
          out = 'var<private> margoPosition:vec3f;\n' + this.code + capture;
          cache.set(code, out);
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
   * Draws `model` (a gltf/pbr model, materials mesh or Terrain) into the targets with its own materials; returns a
   * remover. Models not added still draw in the scene but leave the targets alone. `{subject: true}` marks the model as
   * the shot's subject (`t.subject` 1, the `subject` value); adding a model again with the other choice moves it.
   */
  add(model: SSRModel, { subject = false }: SceneTargetsAddOptions = {}): () => void {
    if (this.disposed) throw margoError('disposed', 'SceneTargets is disposed; create new SceneTargets');
    if (!model || typeof model.setCapture !== 'function')
      throw new TypeError('SceneTargets.add needs a gltf/pbr model, materials mesh or Terrain');
    if (typeof subject !== 'boolean') throw new TypeError('SceneTargets.add subject must be true or false');
    const hook = subject ? this.subjectHook : this.hook;
    const current = this.models.get(model);
    if (current && this.hooks.get(model) !== hook) current();
    this.hooks.set(model, hook);
    return captureModel(this.models, model, hook);
  }
  setup(engine: Engine): void {
    if (this.disposed) throw margoError('disposed', 'SceneTargets is disposed; create new SceneTargets');
    if (!engine.gpu)
      throw margoError(
        'unsupported',
        'SceneTargets needs WebGPU; create the engine with webgpu; see https://margoengine.com/errors#webgpu',
      );
    this.engine = engine;
    this.device = engine.gpu;
  }
  registerPasses(graph: FrameGraph): void {
    graph.add({
      name: this.name,
      order: this.options.order ?? -4.5,
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
    // Core's lit shader with its lighting in a dead block: every binding stays statically used, none of it computed but
    // the sun's visibility: what a shadow plugin wrapped around `direct` in `let linear=`, with `direct` set to 1.
    const key = c.shader;
    if (this.pipelineKey !== key) {
      const wrapped = /let linear=(.+?)\*frame\.radiance\.xyz\*frame\.light\.w/.exec(c.shader)?.[1] ?? 'direct',
        sun =
          wrapped !== 'direct' && /\bdirect\b/.test(wrapped)
            ? `dot(${wrapped.replace(/\bdirect\b/g, 'vec3f(1)')},${luminance})`
            : '1.0',
        code = c.shader
          .replace(/(@fragment[^{]*)->@location\(0\) vec4f/, '$1->MargoCapture')
          .replace(
            /(let direct=[\s\S]*)return (vec4f\([^\n]+\));/,
            (_, dead: string, colour: string) =>
              `if(false){${dead}_=${colour};}return margoTargets(TargetSurface(i.position,n,vec4f(i.color,1),i.material.x,i.material.y,1.0,vec3f(0),frame.eye.xyz,${sun},frame.light.xyz,0.0));`,
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
        for (const model of this.models.keys()) drawCapture(model, this.hooks.get(model) ?? this.hook, c);
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
    this.release();
    this.pipeline = undefined;
    this.pipelineKey = '';
    this.base = undefined;
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
    engine?.sceneOf(this)?.removePlugin(this.name);
  }
  declare [Symbol.dispose]: () => void;
  [(Symbol.dispose ?? Symbol()) as symbol](): void {
    this.dispose();
  }
}
