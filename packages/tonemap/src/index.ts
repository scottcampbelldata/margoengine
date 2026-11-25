/// <reference lib="esnext.disposable" preserve="true" />
import { SceneTarget } from '../../shared/msaa.js';
import { TextureOption, type TextureSource2D } from '../../shared/texture-option.js';
import type { EngineKernel } from '@margoengine/core';
import {
  engineRuntime,
  type Engine,
  type EnginePlugin,
  type FrameGraph,
  type PassContext,
} from '@margoengine/core/extension';
import { parseCube, validateLUT, type CubeLUT } from './cube.js';
import {
  outputShader,
  tonemapShader,
  sizedLUTShader,
  classicShader,
  shapeShader,
  premultipliedShader,
} from './shaders.js';
export { shapeCurve } from './shaders.js';
import type { StackHost, StackStage } from '../../shared/stack.js';
import { MargoError } from '@margoengine/math/errors';
import { applyView, viewLoadOp, viewRect } from '../../shared/view-rect.js';
import {
  effectsShader,
  meterShader,
  meterValues,
  validMetering,
  usesEffects,
  whiteBalanceMatrix,
  NEUTRAL_TEMPERATURE,
  type AutoExposure,
} from './effects.js';
import { coreShaderRequired, linearShader } from '../../shared/display.js';
export { parseCube };
/** Set on the canvas by environment's TransparentCanvas (no import between the packages). */
const PREMULTIPLIED = Symbol.for('margoengine.premultiplied-canvas');
export { whiteBalanceMatrix, type AutoExposure };
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
/** The extensions and extra bindings of a Tonemap without extensions: shared, so such a frame allocates none. */
const NO_EXTENSIONS: readonly TonemapExtension[] = [],
  NO_BINDINGS: readonly { binding: number; resource: GPUBindingResource }[] = [];
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
  /**
   * Frees the GPU objects the extension made for the Tonemap's device. The Tonemap calls it when it is disposed or
   * removed from its scene and when its device is restored; the extension makes them again on its next encode.
   */
  dispose?(): void;
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
  /**
   * Contrast about 18% gray, 0-4; default 1: display-linear `0.18 * (x / 0.18) ** contrast`, a slope in log exposure
   * like a grading app's contrast, so a contrast above 1 deepens the shadows without clipping them to black. Contrast 0
   * gives flat 18% gray everywhere, black included (`0 ** 0` is 1).
   */
  contrast?: number;
  /**
   * White point, 0-64; default 0 (off). The scene-linear value (after exposure) that lands on exactly 1: the curve output
   * is divided by the curve's value there, and brighter values clip (Hable 2010; Reinhard et al. 2002). Values from 0
   * to 0.01 act as 0.01. Setting it (or `toe` or `shoulder`) away from its default compiles one more program; the
   * default leaves the shader and the output as they were. A `CustomCurve` replaces the curve and the shaping with it.
   */
  whitePoint?: number;
  /**
   * Slope of the display curve at black, 0-3; default 1 (off). Below 1 is a softer toe, above 1 a steeper one: the cubic
   * Hermite spline through (0, 0) and (1, 1) after the white point (`shapeCurve`), monotone over 0 to 3.
   */
  toe?: number;
  /** Slope of the display curve at white, 0-3; default 1 (off). Below 1 rolls the highlights off before white; 0 reaches white flat. */
  shoulder?: number;
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
  /** Vignette colour, linear Rec.709 0-1 per channel; default [0, 0, 0] (black, the classic darkening). */
  vignetteColor?: readonly [number, number, number];
  /** Vignette centre as fractions of the view, x from the left and y from the top, 0-1; default [0.5, 0.5]. */
  vignetteCenter?: readonly [number, number];
  /**
   * Vignette shape, 0-1: 0 (default) stretches it with the view into an ellipse through the corners; 1 makes it a
   * circle. The corner distance stays 1 either way, so `vignetteRadius` keeps its meaning.
   */
  vignetteRoundness?: number;
  /**
   * How the vignette meets the picture: `'multiply'` (default) multiplies the colour by `vignetteColor` as the vignette
   * comes in (black darkens, a tint tints); `'opaque'` blends toward `vignetteColor` itself, like a painted matte.
   */
  vignetteBlend?: 'multiply' | 'opaque';
  /** Animated film grain, 0-1; default 0 (off). Strongest in the mid-tones. */
  grain?: number;
  /**
   * Output dithering against banding in smooth gradients: triangular noise of up to one code value of the target either
   * way, added to the encoded colour just before the target quantises it, and narrowed near 0 and 1 so pure black and
   * white stay exact. `true` is 1; a number 0-1 scales the noise. It changes every frame. One code value is 1/255 on an
   * 8-bit target and 1/1023 on `rgb10a2unorm`; float targets do not band, so there it adds nothing. Default off.
   */
  dither?: boolean | number;
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

const BLACK = [0, 0, 0],
  CENTRE = [0.5, 0.5];
// One code value of a render target: the step its quantisation leaves, 0 for float targets.
const codeValue = (format: GPUTextureFormat) =>
  format.includes('8unorm') ? 1 / 255 : format === 'rgb10a2unorm' ? 1 / 1023 : 0;
const inRange = (v: number | undefined, lo: number, hi: number) =>
  v === undefined || (Number.isFinite(v) && v >= lo && v <= hi);
const triple = (v: readonly number[] | undefined, n: number) =>
  v === undefined || (Array.isArray(v) && v.length === n && v.every((x) => inRange(x, 0, 1)));
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
  /** The grain and dither pattern's frame number: set by each frame update, or by each draw when no update reaches it. */
  private grainFrame = 0;
  private clocked = false;
  /** A zero-delta update came since the last grain step: the next draw steps it (KB-FILM-TAAPHASE1). */
  private pending = false;
  private seconds = 0;
  private extBuffers: (GPUBuffer | undefined)[] = [];
  private extResources: GPUBindingResource[] = [];
  private readonly fxValues = new Float32Array(32);
  private balanceKelvin = NaN;
  private balanceTint = NaN;
  private readonly meterValues = new Float32Array(16);
  private meterMask?: GPUTexture;
  /** The auto exposure `mask`, held by the borrowed-object rule (docs/conventions.md); made on first use. */
  private maskOption?: TextureOption;
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
  /** Seconds on the grain clock: the sum of the frame deltas its updates moved it by. */
  get time(): number {
    return this.seconds;
  }
  /** Back to time 0 and a fresh one's state, history dropped (GAP-FILM-RESET; `resetClocks` in `@margoengine/cutscene/seek`). */
  resetTime(): void {
    this.frameCount = this.grainFrame = this.seconds = 0;
    this.clocked = this.pending = false;
    this.resetExposure();
  }
  /**
   * Moves the grain and dither pattern one frame on, and the clock by `delta` seconds: the CPU part of its frame update,
   * which a seek from `@margoengine/cutscene/seek` replays, so the next drawn frame shows the grain a continuous run
   * shows there. Every view drawn in that frame shows the same grain. A Tonemap that no update reaches (one stacked in
   * a PostStack) moves its grain at each draw instead. A `delta` of 0 is the same instant drawn again (a capture's
   * render inside the frame): it moves nothing at once, and the next draw moves the grain if no timed update came
   * first (KB-FILM-TAAPHASE1). Auto exposure is view history: a cut snaps it to the metered scene on its first frame
   * (docs/limits.md, class C).
   */
  advanceTime(delta: number): void {
    if (this.disposed) return;
    this.clocked = true;
    if (!(delta > 0)) {
      this.pending = true;
      return;
    }
    this.seconds += delta;
    this.grainFrame = this.frameCount++ & 0xffffff;
    this.pending = false;
  }
  onPreUpdate(delta: number): void {
    this.advanceTime(delta);
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
      !inRange(o.vignetteRoundness, 0, 1) ||
      !(o.vignetteBlend === undefined || o.vignetteBlend === 'multiply' || o.vignetteBlend === 'opaque') ||
      !triple(o.vignetteColor, 3) ||
      !triple(o.vignetteCenter, 2) ||
      !(typeof o.dither === 'boolean' || inRange(o.dither, 0, 1)) ||
      !inRange(o.chromaticAberration, 0, 1) ||
      !inRange(o.whitePoint, 0, 64) ||
      !inRange(o.toe, 0, 3) ||
      !inRange(o.shoulder, 0, 3) ||
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
        'Invalid Tonemap options; use curve agx, acescg, neutral, reinhard, cineon or linear, exposure within -16..16, contrast within 0..4, whitePoint within 0..64, toe and shoulder within 0..3, and keep source unchanged after attach.',
      );
    if (!this.source && o.inputColorSpace === 'acescg')
      throw new MargoError('state', 'ACEScg input requires an external ACEScg source; pass options.source');
  }
  setup(engine: Engine): void {
    if (this.disposed || !engine.gpu)
      throw new MargoError(
        this.disposed ? 'disposed' : 'unsupported',
        'Tonemap requires WebGPU and a live effect; attach a new Tonemap to a WebGPU engine; see https://margoengine.com/errors#webgpu',
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
    // The capture's 1x depth is private and unread from here on: depth readers of a 4x capture bind its multisampled
    // depth, a mid-frame reader resolves first, and restore() ends the capture. Only colour and the outer depth remain.
    if (!this.source) this.captureTarget!.resolve(c.encoder, true, false);
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
      exts = o.extensions ?? NO_EXTENSIONS,
      classic = curves.indexOf(o.curve!) > 2,
      shaped = (o.whitePoint ?? 0) > 0 || (o.toe ?? 1) !== 1 || (o.shoulder ?? 1) !== 1,
      premultiplied = !!(this.engine!.canvas as { [PREMULTIPLIED]?: boolean } | undefined)?.[PREMULTIPLIED],
      flags = exts.length
        ? -1
        : (excess ? 1 : 0) |
          (variableLUT ? 2 : 0) |
          (fxOn ? (auto ? 12 : 4) : 0) |
          (classic ? 16 : 0) |
          (shaped ? 32 : 0) |
          (premultiplied ? 64 : 0),
      // The key string is built only when what it names may have changed (a frame with extensions always builds it):
      // a steady frame builds no string.
      key =
        this.pipeline &&
        flags >= 0 &&
        flags === this.keyFlags &&
        format === this.keyFormat &&
        multisample?.count === this.keySamples
          ? this.pipelineFormat!
          : format +
            ':' +
            multisample?.count +
            (excess ? ':output' : '') +
            (variableLUT ? ':lut-size' : '') +
            (fxOn ? (auto ? ':fx-auto' : ':fx') : '') +
            (classic ? ':classic' : '') +
            (shaped ? ':shape' : '') +
            (premultiplied ? ':premultiplied' : '') +
            (exts.length ? ':' + exts.map((e) => e.key).join(',') : '');
    this.keyFlags = flags;
    this.keyFormat = format;
    this.keySamples = multisample?.count;
    if (!this.pipeline || this.pipelineFormat !== key) {
      let code = excess ? outputShader : tonemapShader;
      if (variableLUT) code = sizedLUTShader(code);
      if (fxOn) code = effectsShader(code, auto);
      if (classic) code = classicShader(code);
      if (shaped) code = shapeShader(code);
      for (const [i, e] of exts.entries()) code = e.patch(code, 5 + i, 16 + 4 * i);
      if (premultiplied) code = premultipliedShader(code);
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
    // A frame without extensions makes no array, closure or iterator here (the frame-allocation floors).
    for (let i = 0; i < exts.length; i++)
      exts[i].encode?.({ device: c.device, encoder: c.encoder, source, width: c.width, height: c.height });
    const extra = exts.length
      ? exts.flatMap((e, i) =>
          (e.resources?.() ?? []).slice(0, 4).map((resource, k) => ({ binding: 16 + 4 * i + k, resource })),
        )
      : NO_BINDINGS;
    if (
      !this.group ||
      this.sourceTexture !== source ||
      extra.length !== this.extResources.length ||
      (extra.length > 0 && extra.some((r, i) => r.resource !== this.extResources[i]))
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
    // White point, then toe and shoulder minus 1: the slots are 0 for the defaults, as they always were.
    v[7] = o.whitePoint ?? 0;
    v[11] = (o.toe ?? 1) - 1;
    v[15] = (o.shoulder ?? 1) - 1;
    for (let i = 0; i < 3; i++) {
      v[4 + i] = this.lut?.domainMin[i] ?? 0;
      v[8 + i] = this.lut?.domainMax[i] ?? 1;
    }
    v[12] = +(o.inputColorSpace === 'acescg');
    v[13] = excess ? out!.peak : 0;
    v[14] = +!!(excess && out!.p3);
    c.device.queue.writeBuffer(this.uniform!, 0, v as Float32Array<ArrayBuffer>);
    for (let i = 0; i < exts.length; i++) {
      const buffer = this.extBuffers[i],
        e = exts[i];
      if (buffer && e.values) c.device.queue.writeBuffer(buffer, 0, e.values() as Float32Array<ArrayBuffer>);
    }
    if (fxOn) this.applyEffects(c, source, auto, format);
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
      size: 128,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    }));
  }
  /** Zeroes the adapted exposure, as a new buffer starts: the next metered frame snaps to the scene. */
  private resetExposure(): void {
    if (this.aeBuffer && this.engine?.gpu) this.engine.gpu.queue.writeBuffer(this.aeBuffer, 0, new Float32Array(2));
  }
  private stateBuffer(device: GPUDevice): GPUBuffer {
    return (this.aeBuffer ??= device.createBuffer({
      size: 8,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC,
    }));
  }
  // Writes the effects uniform and, with auto-exposure, meters the source into the adapted-exposure buffer.
  private applyEffects(c: Context, source: GPUTexture | GPUTextureView, auto: boolean, format: GPUTextureFormat): void {
    const o = this.options,
      f = this.fxValues,
      rect = viewRect(c) ?? [0, 0, c.width, c.height],
      kelvin = o.temperature ?? NEUTRAL_TEMPERATURE,
      tint = o.tint ?? 0;
    // The white-balance matrix as three vec4 columns (the first column's w is the vignette amount), rebuilt only when
    // the temperature or tint changes, so a steady frame allocates nothing.
    if (kelvin !== this.balanceKelvin || tint !== this.balanceTint) {
      const m = whiteBalanceMatrix(kelvin, tint);
      for (let i = 0; i < 9; i++) f[4 * Math.floor(i / 3) + (i % 3)] = m[i];
      this.balanceKelvin = kelvin;
      this.balanceTint = tint;
    }
    f[3] = o.vignette ?? 0;
    f[12] = o.vignetteRadius ?? 0.5;
    f[13] = Math.max(o.vignetteSoftness ?? 0.5, 1e-4);
    f[14] = o.grain ?? 0;
    f[15] = (o.chromaticAberration ?? 0) * 0.02;
    f.set(rect, 16);
    if (!this.clocked || this.pending) this.grainFrame = this.frameCount++ & 0xffffff;
    this.pending = false;
    f[20] = this.grainFrame;
    const colour = o.vignetteColor ?? BLACK,
      centre = o.vignetteCenter ?? CENTRE;
    f.set(colour, 24);
    f[27] = +(o.vignetteBlend === 'opaque');
    f.set(centre, 28);
    f[30] = o.vignetteRoundness ?? 0;
    f[31] = +(o.dither ?? 0) * codeValue(format);
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
    let mask = this.blankMask!;
    if (a.metering === 'mask' && a.mask !== undefined) {
      // The options object is read every frame: a `mask` assigned straight onto it is taken like the setter.
      if (!this.maskOption) this.holdMask(a.mask, c.device);
      else if (this.maskOption.value !== a.mask) this.maskOption.set(a.mask as TextureSource2D, c.device);
      // A mask lost with its device weighs nothing: the exposure holds until a new one arrives.
      mask = this.maskOption?.get(c.device, this.engine) ?? mask;
    }
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
  /** What {@link pipelineFormat} was built from, so a steady frame can reuse it without building its string. */
  private keyFlags = -1;
  private keyFormat?: GPUTextureFormat;
  private keySamples?: number;
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
    // What the extensions made on this device goes with it (KB-OWN-TONE1).
    for (const extension of this.options.extensions ?? NO_EXTENSIONS) extension.dispose?.();
    this.meterPipeline = this.meterGroup = undefined;
    this.original = undefined;
    this.shaders.clear();
  }
  private holdMask(mask: AutoExposure['mask'], device: GPUDevice | null | undefined): void {
    this.maskOption = new TextureOption(mask as TextureSource2D, 'Tonemap autoExposure mask', 'setAutoExposureMask');
    this.maskOption.fix(device);
  }
  /**
   * Sets the metering mask from the next frame (`autoExposure.mask`), a texture of the engine's current device or a
   * function giving one. Call it from `onDeviceRestored` with a texture of the new device after a restore.
   */
  setAutoExposureMask(mask: NonNullable<AutoExposure['mask']>): this {
    if (typeof mask !== 'function' && typeof mask?.createView !== 'function')
      throw new TypeError('autoExposure mask must be a GPUTexture or a function giving one');
    const options = this.options,
      auto = typeof options.autoExposure === 'object' ? options.autoExposure : (options.autoExposure = {});
    auto.mask = mask;
    if (this.maskOption) this.maskOption.set(mask as TextureSource2D, this.engine?.gpu);
    else this.holdMask(mask, this.engine?.gpu);
    return this;
  }
  onDeviceRestored(engine: Engine): void {
    this.release();
    this.setup(engine);
  }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.engine?.sceneOf(this)?.removePlugin(this.name);
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
