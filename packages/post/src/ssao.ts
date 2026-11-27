/// <reference lib="esnext.disposable" preserve="true" />
import { SceneTarget } from '../../shared/msaa.js';
import { requireCompatTier } from '../../shared/compat.js';
import type { EngineKernel } from '@margoengine/core';
import {
  engineRuntime,
  type Engine,
  type EnginePlugin,
  type FrameGraph,
  type PassContext,
} from '@margoengine/core/extension';
import { invertMatrixStable } from '@margoengine/math/mat4';
import { viewMatrix } from '../../shared/view.js';
import { preset } from '../../shared/preset.js';
import { margoError } from '../../shared/errors.js';
import { orthographic } from '../../shared/projection.js';
import { fullscreen, render, group as bind } from '../../shared/gpu.js';
import { drawAmbientVeils, coverMarked, wantUnder, type AmbientVeil } from '../../shared/ambient-veil.js';
import type { StackHost, StackStage, StageOutput } from '../../shared/stack.js';
import {
  extractShader,
  extractUnderShader,
  centreShader,
  underAmbientShader,
  ssaoShader,
  blurShader,
  compositeShader,
} from './shaders.js';
import { applyView, viewLoadOp } from '../../shared/view-rect.js';
import { currentFrame, retire, uniformGroups, writeUniform } from '../../shared/frame-resources.js';
import { displayFor, linearShader, premultipliedCanvas } from '../../shared/display.js';
const linearComposite = compositeShader.replace('return vec4f(toDisplay(c),s.a);', 'return vec4f(c,s.a);');
// The display transform must be gone, or an HDR stage would hand the next effect display-encoded colour.
if (linearComposite.includes('vec4f(toDisplay(c)'))
  throw margoError('failed', 'SSAO: the HDR composite still encodes for display; update its linear-output patch');
declare const GPUBufferUsage: { UNIFORM: number; COPY_DST: number; STORAGE: number };
declare const GPUTextureUsage: {
  RENDER_ATTACHMENT: number;
  TEXTURE_BINDING: number;
  STORAGE_BINDING: number;
  COPY_DST: number;
};
type PostPassContext = Extract<PassContext, { backend: 'webgpu' }>;
/** SSAO settings, read every frame from `ssao.options`; out of range throws RangeError before any GPU command. */
export interface SSAOOptions {
  /** Sampling hemisphere radius in world units, (0, 100]. Default 0.5. */
  radius?: number;
  /** Depth bias against self-occlusion, world units, 0..radius. Default 0.025. */
  bias?: number;
  /** Kernel points per pixel, an integer 1-32. Default 32. */
  samples?: number;
  /** False skips occlusion (the scene still passes through). Default true; also `ssao.enabled`. */
  enabled?: boolean;
}
/**
 * A renderer whose own surfaces SSAO should see and darken, such as a gltf/pbr model; registered with `ssao.add`.
 * Each frame SSAO calls `draw(context, 'occlusion', gbuffer, depth, 'all', external)` inside its open G-buffer pass.
 * Core meshes need no source.
 */
export interface SSAOSource {
  draw(
    context: PostPassContext,
    mode: 'gbuffer' | 'ambient' | 'occlusion',
    color: GPUTextureView,
    depth: GPUTextureView,
    phase?: 'all' | 'opaque' | 'blend',
    external?: { pass: GPURenderPassEncoder; view: ArrayLike<number>; depthCompare: GPUCompareFunction },
  ): void;
}
// 32-sample kernel on a golden-angle spiral (Vogel 1979), lengths lerp(0.1, 1, s^2) toward the centre as in
// J. Chapman, "SSAO Tutorial" (2013).
function hemisphere(): Float32Array {
  const values = new Float32Array(128);
  for (let i = 0; i < 32; i++) {
    const z = (i + 0.5) / 32,
      angle = i * 2.399963229728653,
      r = Math.sqrt(1 - z * z),
      scale = 0.1 + 0.9 * (i / 31) ** 2;
    values.set([Math.cos(angle) * r * scale, Math.sin(angle) * r * scale, z * scale, 0], i * 4);
  }
  return values;
}
/**
 * Screen-space ambient occlusion: a 32-point hemisphere kernel over reconstructed normals and depth, two bilateral
 * blur passes, then it darkens only the captured ambient light (direct light and emission stay). `SSAO.attach(engine,
 * options)` alone, or first in a `PostStack`. WebGPU only.
 * @throws RangeError when an option is out of range; TypeError for an invalid `add` source or a non-boolean `enabled`.
 * @throws MargoError `'unsupported'` on a WebGL engine or when another plugin replaced core's lighting shader,
 * `'disposed'` after `dispose()`, `'attached'` when attached twice, `'state'` when another post effect owns the output
 * target or the camera matrix is not invertible.
 */
export class SSAO implements EnginePlugin {
  readonly name: string = 'ssao';
  /** Tier-preset key (@margoengine/quality) read by the constructor; GTAO reads its own. */
  protected static readonly presetKey: string = 'ssao';
  /** Name in error messages. */
  protected readonly label: string = 'SSAO';
  private engine?: Engine;
  private device?: GPUDevice;
  private uniform?: GPUBuffer;
  private samples?: GPUBuffer;
  private noise?: GPUTexture;
  private extract?: GPUComputePipeline;
  private occlusion?: GPUComputePipeline;
  private blur?: GPUComputePipeline;
  private composite?: GPURenderPipeline;
  /** The canvas was premultiplied when the solo composite was built (it then encodes straight colour). */
  private straight = false;
  private captureTarget?: SceneTarget;
  private textures: GPUTexture[] = [];
  private directions: GPUBuffer[] = [];
  private groups: GPUBindGroup[] = [];
  /** Extract and occlusion groups per uniform binding: a second view of a frame binds its own uniform slice. */
  private viewGroups?: { get(copy?: GPUBufferBinding): GPUBindGroup[] };
  private slice?: GPUBufferBinding;
  private width = 0;
  private height = 0;
  private original?: GPUTextureView;
  private originalFormat?: GPUTextureFormat;
  private scene?: GPUTextureView;
  private depth?: GPUTextureView;
  private gbuffer?: GPUTextureView;
  private ambient?: GPUTextureView;
  private ambientPipeline?: GPURenderPipeline;
  private ambientShader = '';
  private readonly sources = new Set<SSAOSource>();
  private replayViews: GPUTextureView[] = [];
  private replayCopy?: GPURenderPipeline;
  private replayGroup?: GPUBindGroup;
  private disposed = false;
  private host?: StackHost;
  private ao?: GPUTextureView;
  private raw?: GPUTextureView;
  private viewDepth?: GPUTextureView;
  private depthOnly?: GPUTextureView;
  private depthFormat?: GPUTextureFormat;
  private input?: GPUTextureView;
  private key = '';
  // Shader patches are cached per source string; pass descriptors are rebuilt with their targets in resize().
  private captureSource?: string;
  private captureShader = '';
  private ambientSource?: string;
  private ambientCode = '';
  private readonly compositeAttachment: GPURenderPassColorAttachment = {
    view: undefined!,
    loadOp: 'clear',
    storeOp: 'store',
    clearValue: { r: 0, g: 0, b: 0, a: 1 },
  };
  private readonly compositePass: GPURenderPassDescriptor = { colorAttachments: [this.compositeAttachment] };
  private replayPass?: GPURenderPassDescriptor;
  private clearPass?: GPURenderPassDescriptor;
  private resolvePass?: GPURenderPassDescriptor;
  private readonly geometryColors: GPURenderPassColorAttachment[] = [
    { view: undefined!, loadOp: 'load', storeOp: 'store' },
    {
      view: undefined!,
      loadOp: 'clear',
      storeOp: 'store',
      clearValue: { r: 0, g: 0, b: 0, a: 0 },
    },
  ];
  private readonly geometryDepth: GPURenderPassDepthStencilAttachment = {
    view: undefined!,
    depthLoadOp: 'load',
    depthStoreOp: 'store',
  };
  private readonly geometryPass: GPURenderPassDescriptor = {
    colorAttachments: this.geometryColors,
    depthStencilAttachment: this.geometryDepth,
  };
  private readonly drawView = new Float32Array(16);
  private readonly values = new Float32Array(56);
  private readonly inverseWorkspace = new Float64Array(52);
  private readonly inverse = this.values.subarray(0, 16);
  private readonly view = this.values.subarray(16, 32);
  private readonly projection = this.values.subarray(32, 48);
  private readonly directionValues = [new Float32Array([1, 0, 0.5, 0]), new Float32Array([0, 1, 0.5, 0])];
  /** Removes this effect from the device's readers of the surface under covered blades (KB-SCATTER-AOFRINGE1). */
  private leaveUnder?: () => void;
  private extractUnder?: GPUComputePipeline;
  /**
   * The targets of a frame whose covered blade depth was held back (packages/shared/ambient-veil.js), made on the first
   * such frame: the depth under the blades (U), with the blades' depth (Dc), the centre depth (C), the occluders' view
   * depth, the ambient replay of the surface under the blades (4x while the scene is, resolved into `ambient`), and the
   * passes and groups that use them.
   */
  private under?: {
    depth: GPUTextureView;
    cover: GPUTextureView;
    centre: GPUTextureView;
    ambient: GPUTextureView;
    target: GPUTextureView;
    groups: { get(copy?: GPUBufferBinding): GPUBindGroup[] };
    centrePipeline: GPURenderPipeline;
    centreGroup: GPUBindGroup;
    centrePass: GPURenderPassDescriptor;
    mergePipeline: GPURenderPipeline;
    mergeGroup: GPUBindGroup;
    mergePass: GPURenderPassDescriptor;
    clearPass: GPURenderPassDescriptor;
    resolvePass?: GPURenderPassDescriptor;
    geometryPass: GPURenderPassDescriptor;
  };
  /** The frame and view whose surface under the blades was kept (`ssao:under`), and whether its blades' depth was. */
  private readonly underFrame = {
    encoder: undefined as GPUCommandEncoder | undefined,
    view: undefined as object | undefined,
    covered: false,
  };
  /** This frame's occlusion kernel reads the centre and occluder depths of `under`. */
  private centred = false;
  /** The veils that drew over the replay of the surface under the blades before their depth landed. */
  private readonly veiledUnder = new Set<AmbientVeil>();
  constructor(readonly options: SSAOOptions = {}) {
    this.options = preset((new.target as typeof SSAO).presetKey, options);
    this.validate();
  }
  static attach(instance: EngineKernel, options: SSAOOptions = {}): SSAO {
    const effect = new SSAO(options);
    engineRuntime(instance).use(effect);
    return effect;
  }
  get enabled(): boolean {
    return this.options.enabled ?? true;
  }
  /** True once a PostStack has taken this effect (joinStack). */
  protected get stacked(): boolean {
    return !!this.host;
  }
  /**
   * The last frame's blurred visibility (an `r32float` view at the drawing size, 1 open, 0 fully occluded; read with
   * `textureLoad`), the factor the composite darkens the ambient light by; undefined before the first frame. For checks
   * and debug views.
   */
  get occlusionView(): GPUTextureView | undefined {
    return this.ao;
  }
  get depthTexture(): GPUTexture | undefined {
    return this.host ? this.host.depthTexture : this.textures[1];
  }
  private joinStack(host: StackHost): StackStage {
    if (this.engine || this.host || this.disposed)
      throw margoError('attached', `${this.label} is already attached; create a new ${this.label}`);
    this.host = host;
    return { kind: 'hdr', render: (c, input, output) => this.stage(c, input, output) };
  }
  set enabled(value: boolean) {
    if (typeof value !== 'boolean') throw new TypeError(`${this.label} enabled must be boolean`);
    this.options.enabled = value;
  }
  add(source: SSAOSource): () => void {
    if (!source || typeof source.draw !== 'function')
      throw new TypeError('Invalid SSAO source; pass an object with a draw() method.');
    this.sources.add(source);
    return () => this.sources.delete(source);
  }
  protected validate(): void {
    const o = this.options,
      r = o.radius ?? 0.5,
      b = o.bias ?? 0.025,
      s = o.samples ?? 32;
    if (
      !Number.isFinite(Math.fround(r)) ||
      r <= 0 ||
      r > 100 ||
      !Number.isFinite(b) ||
      b < 0 ||
      b > r ||
      !Number.isInteger(s) ||
      s < 1 ||
      s > 32 ||
      (o.enabled !== undefined && typeof o.enabled !== 'boolean')
    )
      throw new RangeError('Invalid SSAO options; radius must be in (0, 100], bias 0 up to radius, samples 1-32.');
  }
  /**
   * The occlusion kernel (compute, bindings: frame, the centre depth, gbuffer, 4x4 noise, the `kernel()` buffer, r32float
   * output, r32float view depth with 0 for no surface, then the occluders' depth and their r32float view depth). The
   * centre and occluder depths are the same textures except where covered blades' depth lies over another surface
   * (KB-SCATTER-AOFRINGE1): there the centre is that surface and the occluders are the scene, blades included.
   */
  protected occlusionShader(): string {
    return ssaoShader;
  }
  /** 512 bytes for the kernel's storage buffer, written once at setup. */
  protected kernel(): Float32Array {
    return hemisphere();
  }
  /** The kernel's settings in the frame uniform: `params.xyz` (values 48-50) and `size.zw` (54-55). */
  protected pack(v: Float32Array): void {
    v[48] = this.options.radius ?? 0.5;
    v[49] = this.options.bias ?? 0.025;
    v[50] = this.options.samples ?? 32;
    v[54] = v[55] = 0;
  }
  setup(engine: Engine): void {
    if (this.disposed) throw margoError('disposed', `${this.label} is disposed; create a new ${this.label}`);
    if (!engine.gpu)
      throw margoError('unsupported', `${this.label} requires WebGPU; see https://margoengine.com/errors#webgpu`);
    requireCompatTier(engine.gpu, `${this.label} geometry/HDR processing`, 'half-float');
    if (!this.host && (engine.hasPlugin('post-processing') || engine.hasPlugin('bloom')))
      throw margoError('state', 'SSAO owns the output target; remove the other post effect first');
    this.engine = engine;
    this.device = engine.gpu;
    this.uniform = this.device.createBuffer({ size: 224, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.samples = this.device.createBuffer({ size: 512, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    this.device.queue.writeBuffer(this.samples, 0, this.kernel() as Float32Array<ArrayBuffer>);
    const create = (code: string) =>
      this.device!.createComputePipeline({
        layout: 'auto',
        compute: { module: this.device!.createShaderModule({ code }), entryPoint: 'main' },
      });
    this.extract = create(extractShader);
    this.extractUnder = create(extractUnderShader);
    this.occlusion = create(this.occlusionShader());
    this.blur = create(blurShader);
    this.noise = this.device.createTexture({
      size: [4, 4],
      format: 'rgba8unorm',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    // 4x4 tiled rotation vectors (Chapman 2013), angles on the golden-angle spiral.
    const noise = new Uint8Array(64);
    for (let i = 0; i < 16; i++) {
      const a = i * 2.399963229728653;
      noise.set(
        [Math.round((Math.cos(a) * 0.5 + 0.5) * 255), Math.round((Math.sin(a) * 0.5 + 0.5) * 255), 128, 255],
        i * 4,
      );
    }
    this.device.queue.writeTexture({ texture: this.noise }, noise, { bytesPerRow: 16 }, [4, 4]);
    for (const data of this.directionValues) {
      data[2] = 0.5;
      const b = this.device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
      this.directions.push(b);
      this.device.queue.writeBuffer(b, 0, data);
    }
    this.leaveUnder = wantUnder(this.device);
  }
  registerPasses(graph: FrameGraph): void {
    graph.add({
      name: 'ssao:capture',
      order: -60,
      execute: (c) => {
        if (c.backend !== 'webgpu') return;
        this.validate();
        if (!this.host && (this.engine!.hasPlugin('post-processing') || this.engine!.hasPlugin('bloom')))
          throw margoError(
            'state',
            'SSAO cannot share the output target with another post effect; put both effects in one PostStack',
          );
        this.resize(c);
        if (!this.host) {
          this.original = c.color;
          this.originalFormat = c.format;
          this.captureTarget!.begin(c);
          if (this.captureSource !== c.shader) {
            this.captureSource = c.shader;
            this.captureShader = linearShader(c.shader);
          }
          c.shader = this.captureShader;
        }
        if (!invertMatrixStable(c.camera.matrix, this.inverse, this.inverseWorkspace))
          throw margoError('state', 'Invalid SSAO camera; give the camera a finite, invertible projection');
        viewMatrix(this.view, c.camera);
        // View-space projection for the samples: the camera's own when it is orthographic (constant clip w, signed near/far), else core's perspective.
        const p = this.projection,
          o = orthographic(c.camera.matrix, c.camera.position);
        p.fill(0);
        if (o) {
          p[0] = o.sx;
          p[5] = o.sy;
          p[10] = o.sz;
          p[12] = o.ox;
          p[13] = o.oy;
          p[14] = o.far * o.sz;
          p[15] = 1;
        } else {
          const near = c.camera.near,
            far = c.camera.far,
            f = 1 / Math.tan((c.camera.fov * Math.PI) / 360);
          p[0] = (f * c.height) / c.width;
          p[5] = f;
          p[10] = near / (far - near);
          p[11] = -1;
          p[14] = (far * near) / (far - near);
        }
        const v = this.values;
        this.pack(v);
        v[51] = +this.enabled;
        v[52] = c.width;
        v[53] = c.height;
        this.slice = writeUniform(c.device, this.uniform!, this.values as Float32Array<ArrayBuffer>, c.view ?? c);
        for (let i = 0; i < 2; i++) {
          this.directionValues[i][2] = this.options.radius ?? 0.5;
          // 1: an orthographic view, where view depth itself (not its inverse) is affine across a plane.
          this.directionValues[i][3] = o ? 1 : 0;
          c.device.queue.writeBuffer(this.directions[i], 0, this.directionValues[i]);
        }
      },
    });
    // Covered blades hold their depth back from 1.5 to 1.52 while this effect reads (see packages/shared/ambient-veil.js).
    graph.add({
      name: 'ssao:under',
      order: 1.51,
      execute: (c) => {
        if (c.backend === 'webgpu') this.keepUnder(c);
      },
    });
    graph.add({
      name: 'ssao:covered',
      order: 1.53,
      execute: (c) => {
        if (c.backend !== 'webgpu') return;
        const frame = this.underFrame;
        if (frame.encoder !== c.encoder || frame.view !== c.view) return;
        this.captureTarget!.copyDepth(c.encoder, this.under!.cover, 1);
        frame.covered = true;
      },
    });
    graph.add({
      name: 'ssao:extract',
      order: 10,
      execute: (c) => {
        if (c.backend !== 'webgpu') return;
        try {
          this.extractScene(c);
        } catch (error) {
          if (!this.host) this.captureTarget!.restore(c);
          throw error;
        }
      },
    });
    graph.add({
      name: 'ssao:occlusion',
      order: 11,
      execute: (c) => {
        if (c.backend === 'webgpu')
          this.dispatch(c, this.occlusion!, (this.centred ? this.under!.groups : this.viewGroups!).get(this.slice)[1]);
      },
    });
    graph.add({
      name: 'ssao:blur-x',
      order: 12,
      execute: (c) => {
        if (c.backend === 'webgpu') this.dispatch(c, this.blur!, this.groups[2]);
      },
    });
    graph.add({
      name: 'ssao:blur-y',
      order: 13,
      execute: (c) => {
        if (c.backend === 'webgpu') this.dispatch(c, this.blur!, this.groups[3]);
      },
    });
    graph.add({
      name: 'ssao:composite',
      order: 30,
      execute: (c) => {
        if (c.backend !== 'webgpu' || this.host) return;
        this.present(c, this.original!);
        this.captureTarget!.restore(c);
      },
    });
  }
  private present(c: PostPassContext, view: GPUTextureView): void {
    this.compositeAttachment.view = view;
    this.compositeAttachment.loadOp = viewLoadOp(c, 'clear');
    const pass = c.encoder.beginRenderPass(this.compositePass);
    pass.setPipeline(this.composite!);
    pass.setBindGroup(0, this.groups[4]);
    applyView(pass, c);
    pass.draw(3);
    pass.end();
  }
  /** Stacked: darken the ambient term of `input`; Khronos PBR Neutral encoded only as the display output. */
  private stage(c: PostPassContext, input: GPUTextureView, output: StageOutput): void {
    const key = output.format + output.multisample.count + output.hdr + premultipliedCanvas(this.engine);
    if (this.key !== key) {
      this.key = key;
      this.composite = render(
        c.device,
        output.hdr ? linearComposite : displayFor(this.engine, compositeShader),
        output.format,
        {
          multisample: output.multisample,
        },
      );
      this.groups.length = 4;
    }
    if (this.input !== input || !this.groups[4]) {
      this.input = input;
      this.groups[4] = bind(c.device, this.composite!, [input, this.ambient!, this.ao!]);
    }
    this.present(c, output.view);
  }
  private resize(c: PostPassContext): void {
    // This view draws in the frame: what it releases waits while another view's commands still need it.
    currentFrame(c.device, c.view ?? c);
    const host = this.host;
    if (
      this.width === c.width &&
      this.height === c.height &&
      (host || this.straight === premultipliedCanvas(this.engine)) &&
      (host
        ? this.captureTarget === host.target
        : this.originalFormat === c.format &&
          this.textures[1]?.format === c.descriptor.depthStencil!.format &&
          this.captureTarget?.samples === (c.descriptor.multisample?.count ?? 4))
    )
      return;
    if (!host) this.captureTarget?.dispose();
    for (const t of this.textures) retire(this.device!, t);
    this.textures = [];
    this.under = undefined;
    this.underFrame.encoder = this.underFrame.view = undefined;
    this.width = c.width;
    this.height = c.height;
    const texture = (format: GPUTextureFormat, usage: number) => {
      const t = c.device.createTexture({ size: [c.width, c.height], format, usage });
      this.textures.push(t);
      return t;
    };
    const sampled = GPUTextureUsage.TEXTURE_BINDING,
      render = sampled | GPUTextureUsage.RENDER_ATTACHMENT,
      storage = sampled | GPUTextureUsage.STORAGE_BINDING;
    let depth: GPUTexture;
    // Stacked, the scene and depth belong to the PostStack.
    if (host) {
      this.captureTarget = host.target;
      depth = host.depthTexture!;
    } else {
      this.scene = texture('rgba16float', render).createView();
      depth = texture(c.descriptor.depthStencil!.format, render);
      this.captureTarget = new SceneTarget(c.device, this.textures[0], depth, c.descriptor.multisample?.count ?? 4);
    }
    this.depth = depth.createView();
    this.depthFormat = depth.format;
    const depthOnly = depth.createView({ aspect: 'depth-only' });
    // Normals plus a half-float view depth (what sources write); the kernels read view depth at full precision from
    // viewDepth, so orthographic eye moves and scenes past 65,504 units keep their occlusion (KB1900).
    this.gbuffer = texture('rgba16float', storage | GPUTextureUsage.RENDER_ATTACHMENT).createView();
    const viewDepth = texture('r32float', storage).createView();
    this.ambient = texture('rgba16float', render).createView();
    const raw = texture('r32float', storage).createView(),
      x = texture('r32float', storage).createView(),
      y = texture('r32float', storage).createView();
    this.replayViews = [];
    this.replayCopy = undefined;
    this.replayGroup = undefined;
    if (this.captureTarget!.samples === 4) {
      for (let i = 0; i < 2; i++) {
        const t = c.device.createTexture({
          size: [c.width, c.height],
          format: 'rgba16float',
          sampleCount: 4,
          usage: GPUTextureUsage.RENDER_ATTACHMENT,
        });
        this.textures.push(t);
        this.replayViews.push(t.createView());
      }
      const module = c.device.createShaderModule({
        code:
          fullscreen +
          '@group(0) @binding(0) var source:texture_2d<f32>;@fragment fn fragment(@builtin(position) p:vec4f)->@location(0) vec4f{return textureLoad(source,vec2i(p.xy),0);}',
      });
      this.replayCopy = c.device.createRenderPipeline({
        layout: 'auto',
        vertex: { module, entryPoint: 'vertex' },
        fragment: { module, entryPoint: 'fragment', targets: [{ format: 'rgba16float' }] },
        multisample: c.descriptor.multisample,
      });
      this.replayGroup = c.device.createBindGroup({
        layout: this.replayCopy.getBindGroupLayout(0),
        entries: [{ binding: 0, resource: this.gbuffer }],
      });
    }
    const group = (p: GPUComputePipeline | GPURenderPipeline, resources: (GPUTextureView | GPUBufferBinding)[]) =>
      c.device.createBindGroup({
        layout: p.getBindGroupLayout(0),
        entries: resources.map((resource, binding) => ({ binding, resource })),
      });
    if (!host) {
      this.straight = premultipliedCanvas(this.engine);
      const module = c.device.createShaderModule({ code: displayFor(this.engine, compositeShader) });
      this.composite = c.device.createRenderPipeline({
        layout: 'auto',
        vertex: { module, entryPoint: 'vertex' },
        fragment: { module, entryPoint: 'fragment', targets: [{ format: c.format }] },
        multisample: c.descriptor.multisample,
      });
    }
    let noise: GPUTextureView | undefined;
    this.viewGroups = uniformGroups(this.uniform!, (uniform) => [
      group(this.extract!, [uniform, depthOnly, this.gbuffer!, viewDepth]),
      group(this.occlusion!, [
        uniform,
        depthOnly,
        this.gbuffer!,
        (noise ??= this.noise!.createView()),
        { buffer: this.samples! },
        raw,
        viewDepth,
        depthOnly,
        viewDepth,
      ]),
    ]);
    this.raw = raw;
    this.viewDepth = viewDepth;
    this.depthOnly = depthOnly;
    this.groups = [
      ...this.viewGroups.get(),
      group(this.blur!, [raw, this.gbuffer, x, { buffer: this.directions[0] }, viewDepth]),
      group(this.blur!, [x, this.gbuffer, y, { buffer: this.directions[1] }, viewDepth]),
    ];
    if (!host) this.groups.push(group(this.composite!, [this.scene!, this.ambient, y]));
    this.ao = y;
    this.ambientPipeline = undefined;
    this.replayPass = {
      colorAttachments: [{ view: this.replayViews[0] ?? this.gbuffer, loadOp: 'clear', storeOp: 'store' }],
    };
    this.clearPass = {
      colorAttachments: [
        {
          view: this.replayViews[1] ?? this.ambient,
          loadOp: 'clear',
          storeOp: 'store',
          clearValue: { r: 0, g: 0, b: 0, a: 0 },
        },
      ],
    };
    this.resolvePass = {
      colorAttachments: this.replayViews.map((view, i) => ({
        view,
        resolveTarget: i === 0 ? this.gbuffer! : this.ambient!,
        loadOp: 'load',
        storeOp: 'discard',
      })),
    };
    this.geometryColors[0].view = this.replayViews[0] ?? this.gbuffer!;
    this.geometryColors[1].view = this.replayViews[1] ?? this.ambient!;
  }
  private dispatch(c: PostPassContext, pipeline: GPUComputePipeline, group: GPUBindGroup): void {
    const pass = c.encoder.beginComputePass();
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, group);
    pass.dispatchWorkgroups(Math.ceil(c.width / 8), Math.ceil(c.height / 8));
    pass.end();
  }
  private extractDepth(c: PostPassContext): void {
    // Extraction and the ambient replay read depth, not scene colour. The capture's owner resolves colour
    // after the replays, before composition; resolving it here would write the same HDR target twice.
    if (this.captureTarget!.samples === 4) this.captureTarget!.copyDepth(c.encoder, this.depth!, 1);
  }
  private extractScene(c: PostPassContext): void {
    this.extractDepth(c);
    const frame = this.underFrame,
      under = frame.encoder === c.encoder && frame.view === c.view && frame.covered ? this.under : undefined;
    frame.encoder = frame.view = undefined;
    this.centred = !!under;
    if (under) {
      // The centre depth: the surface under the blades where their depth is the scene's (see shaders.ts).
      under.centrePass.depthStencilAttachment!.depthLoadOp = c.view ? 'load' : 'clear';
      const centre = c.encoder.beginRenderPass(under.centrePass);
      applyView(centre, c);
      centre.setPipeline(under.centrePipeline);
      centre.setBindGroup(0, under.centreGroup);
      centre.draw(3);
      centre.end();
      // Strips blended after 1.51 (smoke) veil the light under the blades as they veil the scene's.
      const color = c.color;
      c.color = under.target;
      try {
        drawAmbientVeils(c, 'rgba16float', this.veiledUnder);
      } finally {
        c.color = color;
      }
      if (under.resolvePass) c.encoder.beginRenderPass(under.resolvePass).end();
      this.dispatch(c, this.extractUnder!, under.groups.get(this.slice)[0]);
    } else this.dispatch(c, this.extract!, this.viewGroups!.get(this.slice)[0]);
    const gbuffer = this.replayViews[0] ?? this.gbuffer!,
      ambient = this.replayViews[1] ?? this.ambient!;
    // Replays must test the same coverage samples as the scene; their sampled outputs stay 1x.
    if (this.replayCopy) {
      const pass = c.encoder.beginRenderPass(this.replayPass!);
      pass.setPipeline(this.replayCopy);
      pass.setBindGroup(0, this.replayGroup!);
      pass.draw(3);
      pass.end();
    }
    if (this.sources.size) {
      this.geometryDepth.view = c.depth;
      const stencil = c.descriptor.depthStencil!.format.includes('stencil');
      this.geometryDepth.stencilLoadOp = stencil ? 'load' : undefined;
      this.geometryDepth.stencilStoreOp = stencil ? 'store' : undefined;
      const pass = c.encoder.beginRenderPass(this.geometryPass);
      try {
        applyView(pass, c);
        for (const source of this.sources)
          source.draw(c, 'occlusion', gbuffer, c.depth, 'all', {
            pass,
            view: viewMatrix(this.drawView, c.camera),
            depthCompare: 'equal',
          });
      } finally {
        pass.end();
      }
    } else c.encoder.beginRenderPass(this.clearPass!).end();
    const color = c.color;
    c.color = ambient;
    try {
      c.draw({ pipeline: this.replayPipeline(c), clear: false, bindings: c.bindings });
      // Blades and other strips blended over those surfaces leave only part of that light in a pixel.
      drawAmbientVeils(c, 'rgba16float');
    } finally {
      c.color = color;
    }
    if (this.replayViews.length) c.encoder.beginRenderPass(this.resolvePass!).end();
    if (under) {
      // Where the centre is the surface under the blades, so is the ambient light the composite takes out.
      const merge = c.encoder.beginRenderPass(under.mergePass);
      applyView(merge, c);
      merge.setPipeline(under.mergePipeline);
      merge.setBindGroup(0, under.mergeGroup);
      merge.draw(3);
      merge.end();
    }
    // A PostStack resolves its shared capture once, after every effect has replayed into it.
    if (!this.host) this.captureTarget!.resolve(c.encoder, true);
  }
  /** Core's lit shader for `c`, returning only its ambient term, drawn depth-equal over the scene. */
  private replayPipeline(c: PostPassContext): GPURenderPipeline {
    // The replay keeps the whole lit shader and returns only the ambient term, so it statically uses every binding the
    // scene's shader uses and binds all of c.bindings, as SSGI's and SSR's replays do. A plugin binding read above
    // `let direct=` (TerrainColors' look uniform, KB-POST-GTAO-TERRAINLOOK1) fits the layout as well as one read below.
    // Convention: a plugin that replaces the ambient light (environment IBL) names it `let margoAmbient=`; then the
    // lighting runs (`_=`) and the replay returns margoAmbient. Otherwise the lighting sits in a dead block.
    if (this.ambientSource !== c.shader) {
      this.ambientSource = c.shader;
      const all = c.shader.includes('let margoAmbient=');
      // environment's HemisphereLight writes its light as `*margoSkyLight(n)` in place of the ambient term, or beside
      // margoAmbient where image-based light replaced that term.
      const sky = /let linear=[^;]*i\.color\*\(1\.0-i\.material\.y\)\*margoSkyLight\(n\)/.test(c.shader),
        skyLight = 'i.color*(1.0-i.material.y)*margoSkyLight(n)',
        term = all
          ? `margoAmbient${sky ? '+' + skyLight : ''}`
          : sky
            ? skyLight
            : c.shader.includes('skyAmbient.rgb')
              ? 'i.color*(1.0-i.material.y)*skyAmbient.rgb'
              : 'i.color*(1.0-i.material.y)*frame.radiance.w*frame.ambient.rgb';
      this.ambientCode = c.shader.replace(
        /(let direct=[\s\S]*)return (vec4f\([^\n]+\));/,
        (_, lit: string, colour: string) =>
          `${all ? `${lit}_=${colour};` : `if(false){${lit}_=${colour};}`}return vec4f(${term},1);`,
      );
    }
    const code = this.ambientCode;
    if (!this.ambientPipeline || this.ambientShader !== code) {
      if (code === c.shader)
        throw margoError(
          'unsupported',
          "SSAO requires the standard core lighting shader; remove the plugin that replaced core's shader",
        );
      const module = c.device.createShaderModule({ code });
      this.ambientPipeline = c.device.createRenderPipeline({
        ...c.descriptor,
        layout: 'auto',
        vertex: { ...c.descriptor.vertex, module },
        fragment: { module, entryPoint: 'fragment', targets: [{ format: 'rgba16float' }] },
        depthStencil: { ...c.descriptor.depthStencil!, depthWriteEnabled: false, depthCompare: 'equal' },
      });
      this.ambientShader = code;
    }
    return this.ambientPipeline;
  }
  /**
   * `ssao:under` (1.51), in a frame whose covered blades hold their depth back: keeps the depth under the blades and the
   * ambient light of that surface, veiled by the blades' coverage (KB-SCATTER-AOFRINGE1).
   */
  private keepUnder(c: PostPassContext): void {
    const frame = this.underFrame;
    frame.encoder = frame.view = undefined;
    frame.covered = false;
    if (!this.enabled || !this.captureTarget || !coverMarked(c)) return;
    const under = (this.under ??= this.underTargets(c));
    this.captureTarget.copyDepth(c.encoder, under.depth, 1);
    if (this.sources.size) {
      const g = under.geometryPass,
        depth = g.depthStencilAttachment!,
        stencil = c.descriptor.depthStencil!.format.includes('stencil');
      depth.view = c.depth;
      depth.stencilLoadOp = stencil ? 'load' : undefined;
      depth.stencilStoreOp = stencil ? 'store' : undefined;
      const pass = c.encoder.beginRenderPass(g);
      try {
        applyView(pass, c);
        // Their normals go to the G-buffer, which ssao:extract writes again whole.
        for (const source of this.sources)
          source.draw(c, 'occlusion', this.replayViews[0] ?? this.gbuffer!, c.depth, 'all', {
            pass,
            view: viewMatrix(this.drawView, c.camera),
            depthCompare: 'equal',
          });
      } finally {
        pass.end();
      }
    } else c.encoder.beginRenderPass(under.clearPass).end();
    const color = c.color;
    c.color = under.target;
    this.veiledUnder.clear();
    try {
      c.draw({ pipeline: this.replayPipeline(c), clear: false, bindings: c.bindings });
      drawAmbientVeils(c, 'rgba16float', undefined, this.veiledUnder);
    } finally {
      c.color = color;
    }
    frame.encoder = c.encoder;
    frame.view = c.view;
  }
  /** The targets, passes and groups of `under`, at this size and depth format. */
  private underTargets(c: PostPassContext): NonNullable<SSAO['under']> {
    const device = c.device,
      format = this.depthFormat!,
      size = [this.width, this.height],
      sampled = GPUTextureUsage.TEXTURE_BINDING,
      attachment = GPUTextureUsage.RENDER_ATTACHMENT;
    const texture = (f: GPUTextureFormat, usage: number, sampleCount = 1) => {
      const t = device.createTexture({ size, format: f, usage, sampleCount });
      this.textures.push(t);
      return t;
    };
    const depthTexture = () => texture(format, sampled | attachment);
    const u = depthTexture(),
      k = depthTexture(),
      centre = depthTexture(),
      only = (t: GPUTexture) => t.createView({ aspect: 'depth-only' }),
      ambient = texture('rgba16float', sampled | attachment).createView(),
      occluders = texture('r32float', sampled | GPUTextureUsage.STORAGE_BINDING).createView(),
      many = this.captureTarget!.samples === 4 ? texture('rgba16float', attachment, 4).createView() : undefined,
      target = many ?? ambient;
    const module = (code: string) => device.createShaderModule({ code });
    const centreModule = module(centreShader),
      centrePipeline = device.createRenderPipeline({
        layout: 'auto',
        vertex: { module: centreModule, entryPoint: 'vertex' },
        fragment: { module: centreModule, entryPoint: 'fragment', targets: [] },
        depthStencil: { format, depthWriteEnabled: true, depthCompare: 'always' },
      });
    const mergeModule = module(underAmbientShader),
      mergePipeline = device.createRenderPipeline({
        layout: 'auto',
        vertex: { module: mergeModule, entryPoint: 'vertex' },
        fragment: { module: mergeModule, entryPoint: 'fragment', targets: [{ format: 'rgba16float' }] },
      });
    const bindGroup = (p: GPUComputePipeline | GPURenderPipeline, resources: (GPUTextureView | GPUBufferBinding)[]) =>
      device.createBindGroup({
        layout: p.getBindGroupLayout(0),
        entries: resources.map((resource, binding) => ({ binding, resource })),
      });
    const centreView = only(centre),
      noise = this.noise!.createView(),
      clear = { r: 0, g: 0, b: 0, a: 0 };
    return {
      depth: u.createView(),
      cover: k.createView(),
      centre: centre.createView(),
      ambient,
      target,
      groups: uniformGroups(this.uniform!, (uniform) => [
        bindGroup(this.extractUnder!, [
          uniform,
          centreView,
          this.gbuffer!,
          this.viewDepth!,
          this.depthOnly!,
          occluders,
        ]),
        bindGroup(this.occlusion!, [
          uniform,
          centreView,
          this.gbuffer!,
          noise,
          { buffer: this.samples! },
          this.raw!,
          this.viewDepth!,
          this.depthOnly!,
          occluders,
        ]),
      ]),
      centrePipeline,
      centreGroup: bindGroup(centrePipeline, [only(u), only(k), this.depthOnly!]),
      centrePass: {
        colorAttachments: [],
        depthStencilAttachment: {
          view: centre.createView(),
          depthLoadOp: 'clear',
          depthClearValue: 0,
          depthStoreOp: 'store',
          ...(format.includes('stencil') ? { stencilReadOnly: true } : {}),
        },
      },
      mergePipeline,
      mergeGroup: bindGroup(mergePipeline, [ambient, centreView, this.depthOnly!]),
      mergePass: { colorAttachments: [{ view: this.ambient!, loadOp: 'load', storeOp: 'store' }] },
      clearPass: { colorAttachments: [{ view: target, loadOp: 'clear', storeOp: 'store', clearValue: clear }] },
      resolvePass: many
        ? { colorAttachments: [{ view: many, resolveTarget: ambient, loadOp: 'load', storeOp: 'discard' }] }
        : undefined,
      geometryPass: {
        colorAttachments: [
          { view: this.replayViews[0] ?? this.gbuffer!, loadOp: 'load', storeOp: 'store' },
          { view: target, loadOp: 'clear', storeOp: 'store', clearValue: clear },
        ],
        depthStencilAttachment: { view: undefined!, depthLoadOp: 'load', depthStoreOp: 'store' },
      },
    };
  }
  private release(): void {
    if (!this.host) this.captureTarget?.dispose();
    this.captureTarget = undefined;
    this.ao = this.input = undefined;
    this.key = '';
    for (const t of this.textures) retire(this.device!, t);
    for (const b of this.directions) retire(this.device!, b);
    retire(this.device!, this.uniform);
    retire(this.device!, this.samples);
    retire(this.device!, this.noise);
    this.textures = [];
    this.directions = [];
    this.groups = [];
    this.width = this.height = 0;
    this.uniform = this.samples = undefined;
    this.noise = undefined;
    this.extract = this.extractUnder = this.occlusion = this.blur = undefined;
    this.leaveUnder?.();
    this.leaveUnder = this.under = this.raw = this.viewDepth = this.depthOnly = undefined;
    this.underFrame.encoder = this.underFrame.view = undefined;
    this.centred = false;
    this.veiledUnder.clear();
    this.composite = this.ambientPipeline = undefined;
    this.original = this.scene = this.depth = this.gbuffer = this.ambient = undefined;
    this.originalFormat = undefined;
    this.replayViews = [];
    this.replayCopy = undefined;
    this.replayGroup = undefined;
    this.replayPass = this.clearPass = this.resolvePass = undefined;
    this.geometryColors[0].view = this.geometryColors[1].view = this.geometryDepth.view = undefined!;
    this.geometryDepth.stencilLoadOp = this.geometryDepth.stencilStoreOp = undefined;
    this.compositeAttachment.view = undefined!;
  }
  onDeviceRestored(engine: Engine): void {
    if (this.disposed) return;
    this.release();
    try {
      this.setup(engine);
    } catch (error) {
      this.dispose();
      throw error;
    }
  }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.engine?.sceneOf(this)?.removePlugin(this.name);
    this.release();
    this.sources.clear();
    this.engine = this.device = undefined;
  }
  declare [Symbol.dispose]: () => void;
  [(Symbol.dispose ?? Symbol()) as symbol](): void {
    this.dispose();
  }
  /** @deprecated Use dispose(); kept as an alias until 1.0. */
  destroy(): void {
    this.dispose();
  }
}
