/// <reference lib="esnext.disposable" preserve="true" />
import { SceneTarget } from '../../shared/msaa.js';
import type { EngineKernel } from '@margoengine/core';
import {
  engineRuntime,
  type Engine,
  type EnginePlugin,
  type FrameGraph,
  type PassContext,
} from '@margoengine/core/extension';
import { parseCube, validateLUT, type CubeLUT } from './cube.js';
import { outputShader, tonemapShader } from './shaders.js';
import type { StackHost, StackStage } from '../../shared/stack.js';
import { MargoError } from '@margoengine/math/errors';
export { parseCube };
export type { CubeLUT };

declare const GPUBufferUsage: { UNIFORM: number; COPY_DST: number };
declare const GPUTextureUsage: { RENDER_ATTACHMENT: number; TEXTURE_BINDING: number; COPY_DST: number };
type Context = Extract<PassContext, { backend: 'webgpu' }>;
// Set on the pass context by @margoengine/environment's ColorOutput while a P3 or HDR canvas is active.
const OUTPUT = Symbol.for('margoengine.color-output');
type Output = { peak: number; p3: boolean; excess?: (width: number, height: number) => GPUTextureView };
/**
 * Display transform: `'agx'` (Rec.2020 AgX, analytic sigmoid), `'acescg'` (ACES fitted RRT/ODT with AP1 handling) or
 * `'neutral'` (Khronos PBR Neutral).
 */
export type TonemapCurve = 'agx' | 'acescg' | 'neutral';
/** Tonemap settings. Every field except `source` is read each frame, so change them on `tonemap.options`. */
export interface TonemapOptions {
  /** Display transform. Default `'agx'`. */
  curve?: TonemapCurve;
  /** Exposure in stops, -16–16; default 0. */
  exposure?: number;
  /** Linear contrast about 18% gray, 0–4; default 1. */
  contrast?: number;
  /** Core produces linear-sRGB. Use acescg only for an external AP1/D60 source. */
  inputColorSpace?: 'linear-srgb' | 'acescg';
  /** Optional HDR source, e.g. () => dof.outputTexture. Fixed at attachment. */
  source?: () => GPUTexture | undefined;
}

/**
 * HDR presentation and colour grading: captures the scene as linear HDR (order -50), then applies exposure, the
 * curve, contrast and an optional 33³ LUT and writes sRGB (order 31). `Tonemap.attach(engine, options)` or put it last
 * in a `PostStack` (before FXAA). WebGPU only.
 * @throws RangeError from the constructor and each frame when an option is out of range (see {@link TonemapOptions}).
 * @throws MargoError `'unsupported'` on a WebGL engine, `'disposed'` after `dispose()`, `'attached'` when attached
 * twice, `'state'` when the scene capture is shared without a `source`.
 */
export class Tonemap implements EnginePlugin {
  readonly name = 'tonemap';
  private engine?: Engine;
  private uniform?: GPUBuffer;
  private pipeline?: GPURenderPipeline;
  private group?: GPUBindGroup;
  private scene?: GPUTexture;
  private sceneView?: GPUTextureView;
  private sourceTexture?: GPUTexture | GPUTextureView;
  private lutTexture?: GPUTexture;
  private lut?: CubeLUT;
  private original?: GPUTextureView;
  private format?: GPUTextureFormat;
  private readonly source: TonemapOptions['source'];
  private readonly values = new Float32Array(16);
  private readonly shaders = new Map<string, string>();
  private readonly attachment: GPURenderPassColorAttachment = { view: undefined!, loadOp: 'clear', storeOp: 'store' };
  private readonly presentation: GPURenderPassDescriptor = { colorAttachments: [this.attachment] };
  private disposed = false;
  private stacked = false;

  constructor(readonly options: TonemapOptions = {}) {
    this.source = options.source;
    this.validate();
  }
  static attach(instance: EngineKernel, options: TonemapOptions = {}): Tonemap {
    const effect = new Tonemap(options);
    engineRuntime(instance).use(effect);
    return effect;
  }
  /** In a PostStack, grades the stack's HDR result as its display effect. */
  private joinStack(_host: StackHost): StackStage {
    if (this.engine || this.stacked || this.disposed || this.source)
      throw new MargoError('attached', 'Tonemap is already attached or has its own source; create a new Tonemap');
    this.stacked = true;
    return {
      kind: 'display',
      render: (c, input, output) => {
        this.validate();
        this.paint(c, input, output.format, output.multisample, output.view);
      },
    };
  }
  private validate(): void {
    const o = this.options,
      e = o.exposure ?? 0,
      k = o.contrast ?? 1;
    if (
      (o.curve !== undefined && o.curve !== 'agx' && o.curve !== 'acescg' && o.curve !== 'neutral') ||
      (o.inputColorSpace !== undefined && o.inputColorSpace !== 'linear-srgb' && o.inputColorSpace !== 'acescg') ||
      !Number.isFinite(e) ||
      e < -16 ||
      e > 16 ||
      !Number.isFinite(k) ||
      k < 0 ||
      k > 4 ||
      o.source !== this.source ||
      (o.source !== undefined && typeof o.source !== 'function')
    )
      throw new RangeError('Invalid Tonemap options');
    if (!this.source && o.inputColorSpace === 'acescg')
      throw new MargoError('state', 'ACEScg input requires an external ACEScg source; pass options.source');
  }
  setup(engine: Engine): void {
    if (this.disposed || !engine.gpu)
      throw new MargoError(
        this.disposed ? 'disposed' : 'unsupported',
        'Tonemap requires WebGPU and a live effect; attach a new Tonemap to a WebGPU engine',
      );
    if (
      !this.source &&
      !this.stacked &&
      (engine.hasPlugin('dof') || engine.hasPlugin('ssao') || engine.hasPlugin('post-processing'))
    )
      throw new MargoError(
        'state',
        'Tonemap needs an explicit HDR source when another effect owns scene capture; pass options.source',
      );
    this.engine = engine;
    this.uniform = engine.gpu.createBuffer({ size: 64, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.uploadLUT();
  }
  /** Replace or clear the grading LUT; upload happens only here and on device restoration. */
  setLUT(lut: CubeLUT | string | null): void {
    if (this.disposed) throw new MargoError('disposed', 'Tonemap is disposed; create a new Tonemap');
    const parsed = typeof lut === 'string' ? parseCube(lut) : lut;
    if (parsed) validateLUT(parsed);
    this.lut = parsed
      ? { data: parsed.data.slice(), domainMin: parsed.domainMin.slice(), domainMax: parsed.domainMax.slice() }
      : undefined;
    if (this.engine) this.uploadLUT();
  }
  private uploadLUT(): void {
    const device = this.engine!.gpu!,
      previous = this.lutTexture;
    const texture = device.createTexture({
      dimension: '3d',
      size: [33, 33, 33],
      format: 'rgba32float',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    try {
      if (this.lut)
        device.queue.writeTexture(
          { texture },
          this.lut.data as Float32Array<ArrayBuffer>,
          { bytesPerRow: 33 * 16, rowsPerImage: 33 },
          [33, 33, 33],
        );
    } catch (error) {
      texture.destroy();
      throw error;
    }
    this.lutTexture = texture;
    this.group = undefined;
    previous?.destroy();
  }
  registerPasses(graph: FrameGraph): void {
    if (this.stacked) return;
    graph.add({
      name: 'tonemap:capture',
      order: -50,
      execute: (c) => {
        if (c.backend === 'webgpu') this.capture(c);
      },
    });
    graph.add({
      name: 'tonemap:grade',
      order: 31,
      execute: (c) => {
        if (c.backend === 'webgpu') this.grade(c);
      },
    });
  }
  private capture(c: Context): void {
    this.validate();
    if (this.source) return;
    if (this.engine!.hasPlugin('dof') || this.engine!.hasPlugin('ssao') || this.engine!.hasPlugin('post-processing'))
      throw new MargoError('state', 'Tonemap cannot share scene capture without an HDR source; pass options.source');
    this.original = c.color;
    if (
      this.scene?.width !== c.width ||
      this.scene.height !== c.height ||
      this.depth?.format !== c.descriptor.depthStencil!.format ||
      this.captureTarget?.samples !== (c.descriptor.multisample?.count ?? 4)
    ) {
      this.captureTarget?.dispose();
      this.depth?.destroy();
      this.scene?.destroy();
      this.scene = c.device.createTexture({
        size: [c.width, c.height],
        format: 'rgba16float',
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT,
      });
      this.sceneView = this.scene.createView();
      this.depth = c.device.createTexture({
        size: [c.width, c.height],
        format: c.descriptor.depthStencil!.format,
        usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
      });
      this.captureTarget = new SceneTarget(c.device, this.scene, this.depth, c.descriptor.multisample?.count ?? 4);
    }
    let shader = this.shaders.get(c.shader);
    if (shader === undefined) {
      shader = c.shader.replace(/let mapped=linear\/[\s\S]*?return vec4f\([^\n]+\);/, 'return vec4f(linear,1);');
      if (shader === c.shader)
        throw new MargoError(
          'unsupported',
          "Tonemap requires the standard core lighting shader; remove the plugin that replaced core's shader",
        );
      this.shaders.set(c.shader, shader);
    }
    c.shader = shader;
    this.format = c.format;
    this.captureTarget!.begin(c);
  }
  private grade(c: Context): void {
    if (!this.source) this.captureTarget!.resolve(c.encoder, true);
    const texture = this.source ? this.source() : this.scene;
    if (
      !texture ||
      texture.width !== c.width ||
      texture.height !== c.height ||
      texture.dimension !== '2d' ||
      texture.sampleCount !== 1 ||
      (texture.format !== 'rgba16float' && texture.format !== 'rgba32float') ||
      !(texture.usage & GPUTextureUsage.TEXTURE_BINDING)
    )
      throw new MargoError(
        'state',
        'Tonemap requires a viewport-sized, sampleable linear HDR texture; return such a texture from options.source',
      );
    this.paint(
      c,
      texture,
      this.source ? c.format : this.format!,
      c.descriptor.multisample,
      this.source ? c.color : this.original!,
    );
    if (!this.source) this.captureTarget!.restore(c);
  }
  private paint(
    c: Context,
    source: GPUTexture | GPUTextureView,
    format: GPUTextureFormat,
    multisample: GPUMultisampleState | undefined,
    view: GPUTextureView,
  ): void {
    const out = (c as { [OUTPUT]?: Output })[OUTPUT],
      excess = out?.excess,
      key = format + ':' + multisample?.count + (excess ? ':output' : '');
    if (!this.pipeline || this.pipelineFormat !== key) {
      const module = c.device.createShaderModule({ code: excess ? outputShader : tonemapShader });
      this.pipeline = c.device.createRenderPipeline({
        layout: 'auto',
        vertex: { module, entryPoint: 'vertex' },
        fragment: { module, entryPoint: 'fragment', targets: [{ format }] },
        multisample,
      });
      this.excessPipeline =
        excess &&
        c.device.createRenderPipeline({
          layout: 'auto',
          vertex: { module, entryPoint: 'vertex' },
          fragment: { module, entryPoint: 'excess', targets: [{ format: 'rgba16float' }] },
        });
      this.pipelineFormat = key;
      this.group = undefined;
    }
    if (!this.group || this.sourceTexture !== source) {
      const group = {
        layout: this.pipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: this.uniform! } },
          { binding: 1, resource: 'createView' in source ? source.createView() : source },
          { binding: 2, resource: this.lutTexture!.createView() },
        ],
      };
      this.group = c.device.createBindGroup(group);
      this.sourceTexture = source;
      this.excessGroup =
        this.excessPipeline &&
        c.device.createBindGroup({ ...group, layout: this.excessPipeline.getBindGroupLayout(0) });
    }
    const v = this.values,
      o = this.options;
    v[0] = o.exposure ?? 0;
    v[1] = o.contrast ?? 1;
    v[2] = o.curve === 'acescg' ? 1 : o.curve === 'neutral' ? 2 : 0;
    v[3] = +!!this.lut;
    for (let i = 0; i < 3; i++) {
      v[4 + i] = this.lut?.domainMin[i] ?? 0;
      v[8 + i] = this.lut?.domainMax[i] ?? 1;
    }
    v[12] = +(o.inputColorSpace === 'acescg');
    v[13] = excess ? out!.peak : 0;
    v[14] = +!!(excess && out!.p3);
    c.device.queue.writeBuffer(this.uniform!, 0, v as Float32Array<ArrayBuffer>);
    this.attachment.view = view;
    const pass = c.encoder.beginRenderPass(this.presentation);
    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, this.group);
    pass.draw(3);
    pass.end();
    // Highlights above SDR white and colours outside sRGB, for ColorOutput to add back on the P3/HDR canvas.
    if (excess) {
      this.excessPass.view = excess(c.width, c.height);
      const extra = c.encoder.beginRenderPass(this.excessDescriptor);
      extra.setPipeline(this.excessPipeline!);
      extra.setBindGroup(0, this.excessGroup!);
      extra.draw(3);
      extra.end();
    }
  }
  private excessPipeline?: GPURenderPipeline;
  private excessGroup?: GPUBindGroup;
  private readonly excessPass: GPURenderPassColorAttachment = { view: undefined!, loadOp: 'clear', storeOp: 'store' };
  private readonly excessDescriptor: GPURenderPassDescriptor = { colorAttachments: [this.excessPass] };
  private captureTarget?: SceneTarget;
  private depth?: GPUTexture;
  private pipelineFormat?: string;
  private release(): void {
    this.captureTarget?.dispose();
    this.captureTarget = undefined;
    this.depth?.destroy();
    this.depth = undefined;
    this.uniform?.destroy();
    this.scene?.destroy();
    this.lutTexture?.destroy();
    this.uniform = undefined;
    this.scene = undefined;
    this.sceneView = undefined;
    this.lutTexture = undefined;
    this.sourceTexture = undefined;
    this.pipeline = undefined;
    this.group = undefined;
    this.excessPipeline = undefined;
    this.excessGroup = undefined;
    this.original = undefined;
    this.shaders.clear();
  }
  onDeviceRestored(engine: Engine): void {
    this.release();
    this.setup(engine);
  }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.engine?.removePlugin(this.name);
    this.release();
    this.lut = undefined;
    this.engine = undefined;
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
