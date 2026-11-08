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
import { outputShader, tonemapShader, sizedLUTShader, classicShader } from './shaders.js';
import type { StackHost, StackStage } from '../../shared/stack.js';
import { MargoError } from '@margoengine/math/errors';
import { applyView, viewLoadOp, viewRect } from '../../shared/view-rect.js';
import {
  effectsShader,
  meterShader,
  meterValues,
  validMetering,
  usesEffects,
  whiteBalanceGain,
  NEUTRAL_TEMPERATURE,
  type AutoExposure,
} from './effects.js';
import { coreShaderRequired, linearShader } from '../../shared/display.js';
export { parseCube };
export { whiteBalanceGain, type AutoExposure };
export type { CubeLUT };

declare const GPUBufferUsage: { UNIFORM: number; COPY_DST: number; STORAGE: number; COPY_SRC: number };
declare const GPUTextureUsage: { RENDER_ATTACHMENT: number; TEXTURE_BINDING: number; COPY_DST: number };
type Context = Extract<PassContext, { backend: 'webgpu' }>;
// Set on the pass context by @margoengine/environment's ColorOutput while a P3 or HDR canvas is active.
const OUTPUT = Symbol.for('margoengine.color-output');
type Output = { peak: number; p3: boolean; excess?: (width: number, height: number) => GPUTextureView };
/**
 * Display transform: `'neutral'` (Khronos PBR Neutral, core's own curve), `'agx'` (AgX, computed in the shader) or
 * `'acescg'` (ACES fitted RRT/ODT with AP1 handling); the classic `'reinhard'` (x / (1 + x)), `'cineon'` (the
 * Hejl and Burgess-Dawson filmic fit) and `'linear'` (clamp) curves, for scenes ported from engines that use them.
 */
export type TonemapCurve = 'agx' | 'acescg' | 'neutral' | 'reinhard' | 'cineon' | 'linear';
const curves: readonly TonemapCurve[] = ['agx', 'acescg', 'neutral', 'reinhard', 'cineon', 'linear'];
/** What {@link TonemapExtension.encode} gets: the frame's encoder and HDR source, before the presentation pass. */
export interface TonemapPassContext {
  readonly device: GPUDevice;
  readonly encoder: GPUCommandEncoder;
  /** The linear HDR texture Tonemap presents this frame. */
  readonly source: GPUTexture | GPUTextureView;
  readonly width: number;
  readonly height: number;
}
/**
 * A shader extension of Tonemap, such as `Grade` from `@margoengine/tonemap/grade`: it patches the WGSL of the
 * presentation pass, may bind one uniform buffer and up to four more resources of its own, and may encode passes of
 * its own before the presentation pass.
 */
export interface TonemapExtension {
  /** Names the extension in the pipeline cache key. */
  readonly key: string;
  /**
   * Returns `shader` with the extension's code in it; its uniform, if any, is `@group(0) @binding(binding)` and its
   * {@link resources} are at `extra` to `extra + 3`.
   */
  patch(shader: string, binding: number, extra: number): string;
  /** The extension uniform's contents, written every frame (a fixed multiple of 16 bytes). Omit for none. */
  values?(): Float32Array;
  /** Up to four more resources (textures, samplers), bound at `extra` on; a new object rebinds. Omit for none. */
  resources?(): readonly GPUBindingResource[];
  /** Encodes the extension's own passes each frame, before the presentation pass reads its resources. */
  encode?(context: TonemapPassContext): void;
}
/** Tonemap settings. Every field except `source` is read each frame, so change them on `tonemap.options`. */
export interface TonemapOptions {
  /**
   * Display curve: 'neutral' (default; Khronos PBR Neutral, the curve core and every package end with, so attaching
   * Tonemap without options keeps the scene's look), 'agx', or 'acescg' (ACES fitted).
   */
  curve?: TonemapCurve;
  /** Exposure in stops, -16-16; default 0. */
  exposure?: number;
  /** Linear contrast about 18% gray, 0-4; default 1. */
  contrast?: number;
  /** Core produces linear-sRGB. Use acescg only for an external AP1/D60 source. */
  inputColorSpace?: 'linear-srgb' | 'acescg';
  /**
   * White balance as the colour temperature of the scene's light in Kelvin, 1667-25000; default 6500 (no change). A low
   * value cools the picture to cancel warm light (3200 for tungsten), a high one warms it.
   */
  temperature?: number;
  /** White-balance tint, -1 (green) to 1 (magenta); default 0. */
  tint?: number;
  /** Corner darkening, 0-1; default 0 (off). */
  vignette?: number;
  /** Where the vignette starts, as a fraction of the corner distance, 0-1; default 0.5. */
  vignetteRadius?: number;
  /** Width of the vignette fall-off, as a fraction of the corner distance, 0-1; default 0.5. */
  vignetteSoftness?: number;
  /** Animated film grain, 0-1; default 0 (off). Strongest in the mid-tones. */
  grain?: number;
  /** Radial red/blue fringing, 0-1 (1 shifts the channels by 2% of the view at its edge); default 0 (off). */
  chromaticAberration?: number;
  /**
   * Eye adaptation: meters the scene's log-average luminance each frame and adapts exposure toward 18% grey, on top of
   * `exposure`. `true` uses the defaults of {@link AutoExposure}. Default off.
   */
  autoExposure?: boolean | AutoExposure;
  /** Shader extensions such as `Grade` (`@margoengine/tonemap/grade`), applied in order. Default none. */
  extensions?: readonly TonemapExtension[];
  /** Optional HDR source, e.g. () => dof.outputTexture. Fixed at attachment. */
  source?: () => GPUTexture | undefined;
}

const inRange = (v: number | undefined, lo: number, hi: number) =>
  v === undefined || (Number.isFinite(v) && v >= lo && v <= hi);
function validAuto(a: boolean | AutoExposure | undefined): boolean {
  if (a === undefined || typeof a === 'boolean') return true;
  const { min = -4, max = 4, speed = 1.5, compensation = 0 } = a;
  return (
    inRange(min, -16, 16) &&
    inRange(max, -16, 16) &&
    min <= max &&
    inRange(speed, 0.01, 100) &&
    inRange(compensation, -8, 8) &&
    validMetering(a)
  );
}

/**
 * HDR presentation and colour grading: captures the scene as linear HDR (order -50), then applies exposure, the curve,
 * contrast and an optional 3D LUT and writes sRGB (order 31). `Tonemap.attach(engine, options)`, or the display effect
 * of a `PostStack` (before FXAA). WebGPU only.
 * @throws RangeError from the constructor and each frame when an option is out of range (see {@link TonemapOptions}),
 * or when a LUT exceeds the device's 3D texture limit; `setLUT` also throws what `parseCube` throws.
 * @throws MargoError `'unsupported'` on a WebGL engine or when another plugin replaced core's lighting shader,
 * `'disposed'` after `dispose()`, `'attached'` when attached twice, `'state'` for ACEScg input without a `source`, a
 * scene capture shared without a `source`, or a `source` texture that is not viewport-sized linear HDR.
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
  private fxBuffer?: GPUBuffer;
  private aeBuffer?: GPUBuffer;
  private meterPipeline?: GPUComputePipeline;
  private meterGroup?: GPUBindGroup;
  private meterBuffer?: GPUBuffer;
  private frameCount = 0;
  private extBuffers: (GPUBuffer | undefined)[] = [];
  private extResources: GPUBindingResource[] = [];
  private readonly fxValues = new Float32Array(16);
  private readonly meterValues = new Float32Array(16);
  private meterMask?: GPUTexture;
  private blankMask?: GPUTexture;

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
      throw new MargoError(
        'attached',
        'Tonemap is already attached or has its own source; stack a new Tonemap without options.source',
      );
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
      !inRange(o.vignette, 0, 1) ||
      !inRange(o.vignetteRadius, 0, 1) ||
      !inRange(o.vignetteSoftness, 0, 1) ||
      !inRange(o.grain, 0, 1) ||
      !inRange(o.chromaticAberration, 0, 1) ||
      !inRange(o.tint, -1, 1) ||
      !inRange(o.temperature, 1667, 25000) ||
      !validAuto(o.autoExposure) ||
      (o.extensions !== undefined &&
        !(
          Array.isArray(o.extensions) &&
          o.extensions.every((x) => typeof x?.patch === 'function' && typeof x.key === 'string')
        )) ||
      (o.curve !== undefined && !curves.includes(o.curve)) ||
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
      throw new RangeError(
        'Invalid Tonemap options; use curve agx, acescg, neutral, reinhard, cineon or linear, exposure within -16..16, contrast within 0..4, and keep source unchanged after attach.',
      );
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
      (engine.hasPlugin('dof') ||
        engine.hasPlugin('ssao') ||
        engine.hasPlugin('post-processing') ||
        engine.hasPlugin('bloom'))
    )
      throw new MargoError(
        'state',
        'Tonemap needs an explicit HDR source when another effect owns scene capture; pass options.source',
      );
    this.checkLUTSize(engine.gpu, this.lut);
    const previousEngine = this.engine;
    this.engine = engine;
    try {
      this.uniform = engine.gpu.createBuffer({ size: 64, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
      this.uploadLUT(this.lut);
    } catch (error) {
      this.uniform?.destroy();
      this.uniform = undefined;
      this.engine = previousEngine;
      throw error;
    }
  }
  /** Replace or clear the grading LUT; upload happens only here and on device restoration. */
  setLUT(lut: CubeLUT | string | null): void {
    if (this.disposed) throw new MargoError('disposed', 'Tonemap is disposed; create a new Tonemap');
    const parsed = typeof lut === 'string' ? parseCube(lut) : lut;
    if (parsed !== null) validateLUT(parsed);
    const next = parsed
      ? {
          size: parsed.size ?? 33,
          data: parsed.data.slice(),
          domainMin: parsed.domainMin.slice(),
          domainMax: parsed.domainMax.slice(),
        }
      : undefined;
    if (this.engine) this.uploadLUT(next);
    else this.lut = next;
  }
  private checkLUTSize(device: GPUDevice, lut: CubeLUT | undefined): void {
    const size = lut?.size ?? 33,
      limit = device.limits?.maxTextureDimension3D;
    if (limit !== undefined && size > limit)
      throw new RangeError('Tonemap LUT size exceeds the device 3D texture limit; use a smaller LUT');
  }
  private uploadLUT(lut: CubeLUT | undefined): void {
    const device = this.engine!.gpu!,
      previous = this.lutTexture,
      size = lut?.size ?? 33;
    this.checkLUTSize(device, lut);
    const texture = device.createTexture({
      dimension: '3d',
      size: [size, size, size],
      format: 'rgba32float',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    try {
      if (lut)
        device.queue.writeTexture(
          { texture },
          lut.data as Float32Array<ArrayBuffer>,
          { bytesPerRow: size * 16, rowsPerImage: size },
          [size, size, size],
        );
    } catch (error) {
      texture.destroy();
      throw error;
    }
    this.lut = lut;
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
    if (
      this.engine!.hasPlugin('dof') ||
      this.engine!.hasPlugin('ssao') ||
      this.engine!.hasPlugin('post-processing') ||
      this.engine!.hasPlugin('bloom')
    )
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
      shader = linearShader(c.shader);
      if (shader === c.shader) throw new MargoError('unsupported', coreShaderRequired('Tonemap'));
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
        'Tonemap requires a viewport-sized, sampleable linear HDR texture; return one from options.source',
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
      variableLUT = (this.lut?.size ?? 33) !== 33,
      o = this.options,
      auto = !!o.autoExposure,
      fxOn = usesEffects(o),
      exts = o.extensions ?? [],
      classic = curves.indexOf(o.curve!) > 2,
      key =
        format +
        ':' +
        multisample?.count +
        (excess ? ':output' : '') +
        (variableLUT ? ':lut-size' : '') +
        (fxOn ? (auto ? ':fx-auto' : ':fx') : '') +
        (classic ? ':classic' : '') +
        (exts.length ? ':' + exts.map((e) => e.key).join(',') : '');
    if (!this.pipeline || this.pipelineFormat !== key) {
      let code = excess ? outputShader : tonemapShader;
      if (variableLUT) code = sizedLUTShader(code);
      if (fxOn) code = effectsShader(code, auto);
      if (classic) code = classicShader(code);
      for (const [i, e] of exts.entries()) code = e.patch(code, 5 + i, 16 + 4 * i);
      for (const b of this.extBuffers) b?.destroy();
      this.extBuffers = exts.map(
        (e) =>
          e.values &&
          c.device.createBuffer({
            size: e.values().byteLength,
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
          }),
      );
      const module = c.device.createShaderModule({ code });
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
    for (const e of exts) e.encode?.({ device: c.device, encoder: c.encoder, source, width: c.width, height: c.height });
    const extra = exts.flatMap((e, i) =>
      (e.resources?.() ?? []).slice(0, 4).map((resource, k) => ({ binding: 16 + 4 * i + k, resource })),
    );
    if (
      !this.group ||
      this.sourceTexture !== source ||
      extra.length !== this.extResources.length ||
      extra.some((r, i) => r.resource !== this.extResources[i])
    ) {
      this.extResources = extra.map((r) => r.resource);
      const group = {
        layout: this.pipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: this.uniform! } },
          { binding: 1, resource: 'createView' in source ? source.createView() : source },
          { binding: 2, resource: this.lutTexture!.createView() },
          ...(fxOn ? [{ binding: 3, resource: { buffer: this.effectsBuffer(c.device) } }] : []),
          ...(auto ? [{ binding: 4, resource: { buffer: this.stateBuffer(c.device) } }] : []),
          ...this.extBuffers.flatMap((buffer, i) => (buffer ? [{ binding: 5 + i, resource: { buffer } }] : [])),
          ...extra,
        ],
      };
      this.meterGroup = undefined;
      this.group = c.device.createBindGroup(group);
      this.sourceTexture = source;
      this.excessGroup =
        this.excessPipeline &&
        c.device.createBindGroup({ ...group, layout: this.excessPipeline.getBindGroupLayout(0) });
    }
    const v = this.values;
    v[0] = o.exposure ?? 0;
    v[1] = o.contrast ?? 1;
    v[2] = o.curve === 'acescg' ? 1 : o.curve === 'agx' ? 0 : o.curve === undefined ? 2 : curves.indexOf(o.curve);
    v[3] = +!!this.lut;
    for (let i = 0; i < 3; i++) {
      v[4 + i] = this.lut?.domainMin[i] ?? 0;
      v[8 + i] = this.lut?.domainMax[i] ?? 1;
    }
    v[12] = +(o.inputColorSpace === 'acescg');
    v[13] = excess ? out!.peak : 0;
    v[14] = +!!(excess && out!.p3);
    c.device.queue.writeBuffer(this.uniform!, 0, v as Float32Array<ArrayBuffer>);
    exts.forEach((e, i) => {
      const buffer = this.extBuffers[i];
      if (buffer && e.values) c.device.queue.writeBuffer(buffer, 0, e.values() as Float32Array<ArrayBuffer>);
    });
    if (fxOn) this.applyEffects(c, source, auto);
    this.attachment.view = view;
    this.attachment.loadOp = viewLoadOp(c, 'clear');
    const pass = c.encoder.beginRenderPass(this.presentation);
    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, this.group);
    applyView(pass, c);
    pass.draw(3);
    pass.end();
    // Highlights above SDR white and colours outside sRGB, for ColorOutput to add back on the P3/HDR canvas.
    if (excess) {
      this.excessPass.view = excess(c.width, c.height);
      this.excessPass.loadOp = viewLoadOp(c, 'clear');
      const extra = c.encoder.beginRenderPass(this.excessDescriptor);
      extra.setPipeline(this.excessPipeline!);
      extra.setBindGroup(0, this.excessGroup!);
      applyView(extra, c);
      extra.draw(3);
      extra.end();
    }
  }
  private effectsBuffer(device: GPUDevice): GPUBuffer {
    return (this.fxBuffer ??= device.createBuffer({
      size: 64,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    }));
  }
  private stateBuffer(device: GPUDevice): GPUBuffer {
    return (this.aeBuffer ??= device.createBuffer({
      size: 8,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC,
    }));
  }
  // Writes the effects uniform and, with auto-exposure, meters the source into the adapted-exposure buffer.
  private applyEffects(c: Context, source: GPUTexture | GPUTextureView, auto: boolean): void {
    const o = this.options,
      f = this.fxValues,
      rect = viewRect(c) ?? [0, 0, c.width, c.height],
      gain = whiteBalanceGain(o.temperature ?? NEUTRAL_TEMPERATURE, o.tint ?? 0);
    f.set(gain, 0);
    f[3] = o.vignette ?? 0;
    f[4] = o.vignetteRadius ?? 0.5;
    f[5] = Math.max(o.vignetteSoftness ?? 0.5, 1e-4);
    f[6] = o.grain ?? 0;
    f[7] = (o.chromaticAberration ?? 0) * 0.02;
    f.set(rect, 8);
    f[12] = this.frameCount++ & 0xffffff;
    c.device.queue.writeBuffer(this.effectsBuffer(c.device), 0, f as Float32Array<ArrayBuffer>);
    if (!auto) return;
    const a = typeof o.autoExposure === 'object' ? o.autoExposure : {},
      m = this.meterValues;
    if (!this.meterPipeline) {
      this.meterPipeline = c.device.createComputePipeline({
        layout: 'auto',
        compute: { module: c.device.createShaderModule({ code: meterShader }), entryPoint: 'main' },
      });
      this.meterBuffer = c.device.createBuffer({ size: 64, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
      this.blankMask = c.device.createTexture({
        size: [1, 1],
        format: 'r8unorm',
        usage: GPUTextureUsage.TEXTURE_BINDING,
      });
    }
    const mask = a.metering === 'mask' ? a.mask! : this.blankMask!;
    if (!this.meterGroup || this.meterMask !== mask) {
      this.meterMask = mask;
      this.meterGroup = c.device.createBindGroup({
        layout: this.meterPipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: this.meterBuffer! } },
          { binding: 1, resource: 'createView' in source ? source.createView() : source },
          { binding: 2, resource: { buffer: this.stateBuffer(c.device) } },
          { binding: 3, resource: mask.createView() },
        ],
      });
    }
    meterValues(m, rect, a, 1 - Math.exp(-(a.speed ?? 1.5) * Math.max(0, Math.min(c.delta, 0.25))));
    c.device.queue.writeBuffer(this.meterBuffer!, 0, m as Float32Array<ArrayBuffer>);
    const pass = c.encoder.beginComputePass();
    pass.setPipeline(this.meterPipeline);
    pass.setBindGroup(0, this.meterGroup);
    pass.dispatchWorkgroups(1);
    pass.end();
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
    this.fxBuffer?.destroy();
    this.aeBuffer?.destroy();
    this.meterBuffer?.destroy();
    this.blankMask?.destroy();
    this.fxBuffer = this.aeBuffer = this.meterBuffer = this.blankMask = this.meterMask = undefined;
    for (const b of this.extBuffers) b?.destroy();
    this.extBuffers = [];
    this.extResources = [];
    this.meterPipeline = this.meterGroup = undefined;
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
