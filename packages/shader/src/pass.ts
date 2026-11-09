// Extra material outputs and rendered scene passes as textures. One scene pass draws its models before the frame's colour
// pass into targets of its own, through gltf-pro's capture hook, so anything drawn later this frame can sample them.
import { MargoError } from '@margoengine/math/errors';
import type { EngineKernel } from '@margoengine/core';
import type { Engine, EnginePlugin, FrameGraph, PassContext } from '@margoengine/core/extension';
import { acquireOpaqueColor } from '@margoengine/materials';
import { captureModel, drawCapture } from '../../shared/capture.js';
import { applyView } from '../../shared/view-rect.js';
import { NodeMaterial, fragmentStage, type NodeMaterialOptions } from './material.js';
import {
  cast,
  hdrTarget,
  positionWorld,
  projectionMatrix,
  screenUV,
  select,
  uniform,
  vec2,
  vec4,
  viewMatrix,
  type Node,
  type NodeInput,
  type Program,
} from './node.js';
import { texture, type BindableTexture } from './texture.js';

declare const GPUTextureUsage: { RENDER_ATTACHMENT: number; TEXTURE_BINDING: number };
type Context = Extract<PassContext, { backend: 'webgpu' }>;
const variable = (name: string) => 'margoOut' + name,
  declaration = (name: string) => `var<private> ${variable(name)}:vec4f;\n`,
  checkName = (name: string) => {
    if (!/^[A-Za-z][A-Za-z0-9]*$/.test(name))
      throw new TypeError(`Output name "${name}" must be letters and digits, starting with a letter`);
  };

/** Options for {@link PassMaterial}: a NodeMaterial's, plus what it writes to each output of a {@link ScenePass}. */
export interface PassMaterialOptions extends NodeMaterialOptions {
  /** A `vec4f` node per output name. Outputs left out read as transparent black; the name `color` is the lit colour. */
  outputs?: Record<string, Node<'vec4f'>>;
}
/** A NodeMaterial with extra outputs. It draws as usual in the frame; a {@link ScenePass} it is added to receives `outputs`. */
export class PassMaterial extends NodeMaterial {
  private readonly lines: string;
  private readonly declared: string;
  private readonly patchedOutputs = new Map<string, string>();
  constructor(options: PassMaterialOptions = {}) {
    const { outputs = {}, ...rest } = options;
    const names = Object.keys(outputs);
    names.forEach((name) => {
      checkName(name);
      if (name === 'color') throw new TypeError('The color output is the lit colour; pick another name for a node');
      cast(outputs[name], 'vec4f', `output ${name}`);
    });
    let lines = '';
    super(rest, (program: Program) => {
      const s = program.stage(fragmentStage, Object.values(outputs));
      lines = [...s.lines, ...s.values.map((value, i) => `${variable(names[i])}=${value};`)].join('\n  ');
    });
    this.lines = lines;
    this.declared = names.map(declaration).join('');
  }
  override shader(source: string, group: number): string {
    const code = super.shader(source, group);
    if (!this.lines) return code;
    let out = this.patchedOutputs.get(code);
    if (out === undefined) {
      const site = '\n  return s;';
      if (code.split(site).length !== 2)
        throw new MargoError(
          'unsupported',
          'PassMaterial requires the standard gltf-pro PBR shader; use matching @margoengine/gltf-pro and shader versions',
        );
      // A block, so the graph's generated names cannot meet those of the surface it lands in.
      out = this.declared + code.replace(site, () => `\n  {\n  ${this.lines}\n  }${site}`);
      this.patchedOutputs.set(code, out);
    }
    return out;
  }
}

/** What gltf-pro's `PBRCapture` needs; the model side of it. */
interface CaptureHook {
  declarations(code: string): string;
  readonly targets: readonly GPUColorTargetState[];
  begin(): GPURenderPassEncoder;
}
/** A model a {@link ScenePass} draws: a gltf-pro model or a mesh from `createMesh`. */
export interface ScenePassModel {
  setCapture(hook: CaptureHook): () => void;
  onDispose(callback: () => void): () => void;
  draw(context: Context, mode: 'capture', color: GPUTextureView, depth: GPUTextureView): void;
}
/** Options for {@link ScenePass.attach}. */
export interface ScenePassOptions {
  /** A texture format per output name, for example `{glow: 'rgba16float', mask: 'rgba8unorm'}`. The name `color` holds the lit colour. */
  outputs: Record<string, GPUTextureFormat>;
  /** Frame graph order: below 1 runs before the colour pass, so surfaces drawn in it can sample this pass. Default 0.5. */
  order?: number;
}
let serial = 0;
/** Draws its models into textures of their own before the frame's colour pass. Read them with `texture(pass.texture(name), screenUV)`. */
export class ScenePass implements EnginePlugin {
  readonly name = 'shader:scene:' + serial++;
  readonly order: number;
  private readonly names: string[];
  private readonly formats: GPUTextureFormat[];
  private readonly hook: CaptureHook;
  private readonly models = new Map<ScenePassModel, () => void>();
  private readonly views = new Map<string, GPUTextureView>();
  private readonly bound = new Map<string, BindableTexture>();
  private readonly tails = new Map<string, string>();
  private readonly previous = uniform(new Array(16).fill(0), { type: 'mat4x4f' });
  private textures: GPUTexture[] = [];
  private depth?: GPUTexture;
  private depthView?: GPUTextureView;
  private sampler?: GPUSampler;
  private device?: GPUDevice;
  private width = 0;
  private height = 0;
  private depthFormat = '';
  private context?: Context;
  private pass?: GPURenderPassEncoder;
  private last?: number[];
  private disposed = false;
  private engine?: Engine;
  /** Makes the pass and adds it to `engine`. */
  static attach(engine: EngineKernel, options: ScenePassOptions): ScenePass {
    const value = new ScenePass(options);
    engine.use(value);
    return value;
  }
  constructor({ outputs, order = 0.5 }: ScenePassOptions) {
    this.names = Object.keys(outputs ?? {});
    this.formats = Object.values(outputs ?? {});
    if (!this.names.length) throw new TypeError('ScenePass needs at least one output: {glow: "rgba16float"}');
    this.names.forEach(checkName);
    for (const format of this.formats)
      if (/32float|int$|depth|stencil/.test(format))
        throw new TypeError(`ScenePass output format ${format} must be a filterable colour format such as rgba16float`);
    if (!Number.isFinite(order) || order <= 0) throw new RangeError('ScenePass order must be a number > 0');
    this.order = order;
    this.hook = {
      targets: this.formats.map((format) => ({ format })),
      declarations: (code) => this.tail(code),
      begin: () => this.begin(),
    };
  }
  /** Module-scope WGSL for the capture shader of `code`: a variable per output a material did not declare, and the outputs. */
  private tail(code: string): string {
    let out = this.tails.get(code);
    if (out === undefined) {
      const lit = this.names.includes('color'),
        missing = this.names.filter((name) => name !== 'color' && !code.includes(declaration(name)));
      out =
        missing.map(declaration).join('') +
        (lit ? 'var<private> margoBeauty:vec4f;\n' : '') +
        // Members by number: an output may be named `loop`, which WGSL reserves.
        `struct MargoCapture {${this.names.map((_, i) => `@location(${i}) o${i}:vec4f`).join(',')}}\n` +
        `fn margoCapture(s:Surface,v:vec3f,k:vec3f)->MargoCapture {return MargoCapture(${this.names
          .map((name) => (name === 'color' ? 'margoBeauty' : variable(name)))
          .join(',')});}\n`;
      if (this.tails.size >= 64) this.tails.clear();
      this.tails.set(code, out);
    }
    return out;
  }
  private begin(): GPURenderPassEncoder {
    if (this.pass) return this.pass;
    const c = this.context!,
      first = !c.view?.index,
      stencil = this.depthFormat.includes('stencil')
        ? ({ stencilClearValue: 0, stencilLoadOp: 'clear', stencilStoreOp: 'store' } as const)
        : {};
    const pass = (this.pass = c.encoder.beginRenderPass({
      label: this.name,
      colorAttachments: this.names.map((name) => ({
        view: this.views.get(name)!,
        clearValue: [0, 0, 0, 0],
        loadOp: first ? 'clear' : 'load',
        storeOp: 'store',
      })),
      // Reversed depth: 0 is the far plane.
      depthStencilAttachment: {
        view: this.depthView!,
        depthClearValue: 0,
        depthLoadOp: first ? 'clear' : 'load',
        depthStoreOp: 'store',
        ...stencil,
      },
    }));
    applyView(pass, c);
    return pass;
  }
  /** Draws `model` in this pass from the next frame, beside any SSR, SSGI or other ScenePass that captures it. Returns a remover. */
  add(model: ScenePassModel): () => void {
    if (this.disposed) throw new MargoError('disposed', 'ScenePass is disposed; create a new ScenePass.');
    return captureModel(this.models, model, this.hook);
  }
  /** Output `name` as a texture for `texture()` in a NodeMaterial or NodePass. Linear, the size of the drawing buffer. */
  texture(name: string): BindableTexture {
    if (!this.names.includes(name))
      throw new RangeError(`ScenePass has no output "${name}"; it has ${this.names.join(', ')}`);
    let t = this.bound.get(name);
    if (!t) {
      t = { bind: () => (this.views.has(name) ? [this.views.get(name)!, this.sampler!] : undefined) };
      this.bound.set(name, t);
    }
    return t;
  }
  /**
   * How far a surface moved on screen since the last frame, in UV units: camera motion from the matrices of both frames.
   * A moving mesh gives where it was as `previous`, a world position. Write it to an output with `vec4(pass.velocity(), 0, 1)`.
   */
  velocity(previous: NodeInput<'vec3f'> = positionWorld): Node<'vec2f'> {
    const was = this.previous.mul(vec4(cast(previous, 'vec3f', 'previous position'), 1)),
      now = projectionMatrix.mul(viewMatrix).mul(vec4(positionWorld, 1));
    // Clip space runs y up and UV y down.
    return now.xy.div(now.w).sub(was.xy.div(was.w)).mul(vec2(0.5, -0.5));
  }
  setup(engine: Engine): void {
    if (this.disposed) throw new MargoError('disposed', 'ScenePass is disposed; create a new ScenePass.');
    if (!engine.gpu)
      throw new MargoError('unsupported', 'ScenePass requires WebGPU; see https://margoengine.com/errors#webgpu');
    this.engine = engine;
  }
  registerPasses(graph: FrameGraph): void {
    graph.add({
      name: this.name,
      order: this.order,
      execute: (c) => {
        if (c.backend === 'webgpu' && !this.disposed) this.render(c);
      },
    });
  }
  private resize(c: Context): void {
    const format = c.descriptor.depthStencil!.format;
    if (this.device === c.device && this.width === c.width && this.height === c.height && this.depthFormat === format)
      return;
    this.release();
    this.device = c.device;
    this.width = c.width;
    this.height = c.height;
    this.depthFormat = format;
    const usage = GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING;
    this.textures = this.formats.map((target, i) =>
      c.device.createTexture({
        label: `${this.name}:${this.names[i]}`,
        size: [c.width, c.height],
        format: target,
        usage,
      }),
    );
    this.textures.forEach((texture, i) => this.views.set(this.names[i], texture.createView()));
    this.depth = c.device.createTexture({ label: this.name + ':depth', size: [c.width, c.height], format, usage });
    this.depthView = this.depth.createView();
    this.sampler ??= c.device.createSampler({ minFilter: 'linear', magFilter: 'linear' });
  }
  private render(c: Context): void {
    this.resize(c);
    // Uniforms upload when drawn, ahead of the frame's commands, so `previous` holds last frame's matrix for the whole
    // frame. The first frame has no last frame, so it reads as still.
    this.previous.value = this.last ?? Array.from(c.camera.matrix);
    this.last = Array.from(c.camera.matrix);
    // The targets are single-sampled, whatever the frame's multisampling, and hold linear light, whatever the canvas
    // encodes: `format` sets the shading's HDR flag. A view object of its own keeps that flag out of the frame's view block.
    const single = Object.create(c, {
      descriptor: { value: { ...c.descriptor, multisample: { count: 1 } } },
      format: { value: 'rgba16float' },
      view: { value: c.view && { ...c.view } },
    }) as Context;
    this.context = single;
    const pass = this.hook.begin();
    try {
      for (const model of this.models.keys()) drawCapture(model, this.hook, single);
    } finally {
      pass.end();
      this.pass = this.context = undefined;
    }
  }
  private release(): void {
    this.textures.forEach((texture) => texture.destroy());
    this.depth?.destroy();
    this.textures = [];
    this.depth = undefined;
    this.views.clear();
    this.sampler = undefined;
  }
  /** Frees the textures and lets go of the models; `engine.removePlugin(pass.name)` calls it. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    const engine = this.engine;
    this.engine = undefined;
    for (const release of [...this.models.values()]) release();
    this.release();
    engine?.sceneOf(this)?.removePlugin(this.name);
  }
  [Symbol.dispose](): void {
    this.dispose();
  }
}

/** What {@link sceneColor} returns. */
export interface SceneColor {
  /** The frame as it stands, in the format it is drawn in, for `texture()`. Display-encoded without an HDR PostStack. */
  readonly texture: BindableTexture;
  /** The frame at `coord` (default the pixel itself) in linear light, whatever the target encodes. */
  read(coord?: NodeInput<'vec2f'>): Node<'vec3f'>;
  /** Lets go of the shared snapshot; the frame stops paying for it with the last holder. */
  dispose(): void;
  [Symbol.dispose](): void;
}
/**
 * The finished frame behind a surface: core meshes, sky, water, fog and every plugin drawn so far, resolved from MSAA, in the
 * snapshot `@margoengine/materials` transmission uses. It is taken after the opaque phase, so a surface reading it is
 * `transparent: true`, which draws after the snapshot; other blended surfaces are not in it.
 * @example new NodeMaterial({ transparent: true, toneMapped: false, emissiveNode: sceneColor(engine).read(screenUV.add(wobble)) })
 * @throws MargoError on an engine without WebGPU.
 */
export function sceneColor(engine: EngineKernel): SceneColor {
  const capture = acquireOpaqueColor(engine as unknown as Engine, () => {}),
    samplers = new WeakMap<GPUDevice, GPUSampler>(),
    source: BindableTexture = {
      bind(device) {
        let sampler = samplers.get(device);
        if (!sampler)
          samplers.set(device, (sampler = device.createSampler({ minFilter: 'linear', magFilter: 'linear' })));
        return [capture.view, sampler];
      },
    },
    dispose = () => capture.release();
  return {
    texture: source,
    read(coord = screenUV) {
      const c = texture(source, cast(coord, 'vec2f', 'sceneColor coordinate')).rgb;
      // The exact sRGB curve, undone only where the target is display-encoded.
      return select(
        hdrTarget.greaterThan(0.5),
        c,
        select(c.lessThanEqual(0.04045), c.div(12.92), c.add(0.055).div(1.055).pow(2.4)),
      );
    },
    dispose,
    [Symbol.dispose]: dispose,
  };
}
