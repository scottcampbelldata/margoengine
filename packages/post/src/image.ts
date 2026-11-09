import type { EngineKernel } from '@margoengine/core';
import {
  engineRuntime,
  type Engine,
  type EnginePlugin,
  type FrameGraph,
  type PassContext,
} from '@margoengine/core/extension';
import { neutralShader } from '../../shared/display.js';
import { agxShader } from '../../shared/agx.js';
import { acesNarkowiczShader } from '../../shared/aces.js';
import { margoError } from '../../shared/errors.js';
import { render } from '../../shared/gpu.js';
import type { StackHost, StackStage, StageOutput } from '../../shared/stack.js';
import { Bloom, type BloomOptions } from './bloom.js';
import { PostStack } from './stack.js';
import { applyView, viewLoadOp } from '../../shared/view-rect.js';

function imageDevice(engine?: Engine): GPUDevice {
  const device = engine?.gpu;
  if (!device) throw margoError('unsupported', 'ImagePost needs WebGPU; see https://margoengine.com/errors#webgpu');
  return device;
}
declare const GPUBufferUsage: { UNIFORM: number; COPY_DST: number; MAP_READ: number };
declare const GPUTextureUsage: {
  COPY_DST: number;
  COPY_SRC: number;
  TEXTURE_BINDING: number;
  RENDER_ATTACHMENT: number;
};
declare const GPUMapMode: { READ: number };

type Context = Extract<PassContext, { backend: 'webgpu' }>;
type ImageContext = Pick<Context, 'device' | 'encoder' | 'width' | 'height'>;
/** Shared viewport/export display options. A path tracer's HDR viewport already applies exposure and vignette;
 * renderImage's raw linear pixels do not, so the export path applies them once before bloom. */
export interface ImagePostOptions {
  /** Existing Margo Bloom kernel. Its exposure is kept at zero; use the shared exposure below. */
  bloom?: Pick<BloomOptions, 'strength' | 'threshold' | 'radius'>;
  /** Display transform, matching the voxel path tracer's public choices. Default neutral. */
  toneMapping?: 'neutral' | 'linear' | 'aces-narkowicz' | 'agx';
  /** Exposure stops, -20 to 20; default zero. Must match the producer's HDR viewport exposure. */
  exposure?: number;
  /** Display gamma, 1 to 5, or undefined for standard sRGB. */
  gamma?: number;
  /** Cosine-to-the-fourth lens falloff, 0 to 100; default zero. Must match the producer's HDR viewport vignette. */
  vignette?: number;
}
/** Raw linear RGB image, row-major, before exposure and tone mapping. Optional alpha is coverage; RGB then is premultiplied. */
export interface LinearPostImage {
  width: number;
  height: number;
  color: Float32Array;
  alpha?: Float32Array;
}
/** Display-encoded, straight-alpha RGBA8 pixels, ready for a PNG encoder. */
export interface PostImagePixels {
  width: number;
  height: number;
  data: Uint8ClampedArray<ArrayBuffer>;
}
const range = (value: unknown, label: string, min: number, max: number) => {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max)
    throw new RangeError(`ImagePost ${label}: pass a finite value from ${min} to ${max}`);
};
function checkedOptions(value: ImagePostOptions): ImagePostOptions {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new TypeError('ImagePost options: pass an object');
  if (value.toneMapping !== undefined && !['neutral', 'linear', 'aces-narkowicz', 'agx'].includes(value.toneMapping))
    throw new TypeError('ImagePost toneMapping: pass neutral, linear, aces-narkowicz or agx');
  if (value.gamma !== undefined) range(value.gamma, 'gamma', 1, 5);
  if (value.exposure !== undefined) range(value.exposure, 'exposure', -20, 20);
  if (value.vignette !== undefined) range(value.vignette, 'vignette', 0, 100);
  if (value.bloom !== undefined) {
    if (!value.bloom || typeof value.bloom !== 'object' || Array.isArray(value.bloom))
      throw new TypeError('ImagePost bloom: pass an options object');
    if (value.bloom.strength !== undefined) range(value.bloom.strength, 'bloom strength', 0, 4);
    if (value.bloom.threshold !== undefined) range(value.bloom.threshold, 'bloom threshold', 0, 100);
    if (value.bloom.radius !== undefined) range(value.bloom.radius, 'bloom radius', 0, 1);
  }
  return { ...value, ...(value.bloom ? { bloom: { ...value.bloom } } : {}) };
}

// Both the PostStack display and exported image use this one engine-owned pass. The prepass uses mode 3 to apply
// the producer's exposure/vignette before bloom; the viewport producer has already done that to its HDR target.
// Vignette: the natural-vignetting cos^4 law, 1/(1 + t^2)^2; its 0.2238 field scale is fitted to observed MagicaVoxel
// output (docs/magicavoxel-parity.md). sRGB encode: IEC 61966-2-1.
const shader =
  neutralShader +
  agxShader +
  acesNarkowiczShader +
  `
@group(0) @binding(0) var image:texture_2d<f32>;
@group(0) @binding(1) var<uniform> options:array<vec4f,2>;
@vertex fn vertex(@builtin(vertex_index) i:u32)->@builtin(position) vec4f{
 let p=array<vec2f,3>(vec2f(-1,-1),vec2f(3,-1),vec2f(-1,3));return vec4f(p[i],0,1);
}
fn srgb(c:vec3f)->vec3f{return select(c*12.92,1.055*pow(c,vec3f(1.0/2.4))-0.055,c>=vec3f(0.0031308));}
@fragment fn fragment(@builtin(position) p:vec4f)->@location(0) vec4f{
 let s=textureLoad(image,vec2i(p.xy),0);var c=max(s.rgb,vec3f(0));let mode=u32(options[0].w);
 if(mode==3u){
  var gain=exp2(options[0].x);let t=options[0].z*length((p.xy-options[1].xy*0.5)/(0.2238*options[1].y));
  gain/=(1.0+t*t)*(1.0+t*t);return vec4f(min(c*gain,vec3f(65504)),s.a);
 }
 // Coverage is preserved; a glow on the transparent surround raises alpha so its light survives compositing.
 let a=max(s.a,clamp(max(c.r,max(c.g,c.b)),0.0,1.0));
 if(options[1].z>0.0){c/=max(a,0.000001);}
 if(mode==0u){c=pbrNeutral(c);}else if(mode==2u){c=acesNarkowicz(c);}else if(mode==4u){c=agx(c);}
 c=clamp(c,vec3f(0),vec3f(1));let g=options[0].y;
 if(g==1.0){return vec4f(c,a);}
 c=select(srgb(c),pow(c,vec3f(1.0/max(g,1.0))),g>0.0);
 return vec4f(c,a);
}`;

class ImageDisplay implements EnginePlugin {
  readonly name = 'post:image:display';
  private device?: GPUDevice;
  private uniform?: GPUBuffer;
  private pipelines = new Map<string, GPURenderPipeline>();
  private values = new Float32Array(8);
  private source?: GPUTextureView;
  private pipeline?: GPURenderPipeline;
  private group?: GPUBindGroup;
  constructor(readonly options: ImagePostOptions) {}
  private joinStack(_host: StackHost): StackStage {
    return { kind: 'display', render: (c, input, output) => this.encode(c, input, output, false, false) };
  }
  setup(engine: Engine): void {
    this.initialize(imageDevice(engine));
  }
  registerPasses(_graph: FrameGraph): void {}
  private initialize(device: GPUDevice): void {
    if (this.device === device) return;
    this.dispose();
    this.device = device;
    this.uniform = device.createBuffer({ size: 32, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  }
  encode(c: ImageContext, input: GPUTextureView, output: StageOutput, preprocess: boolean, straight: boolean): void {
    this.initialize(c.device);
    const key = output.format + output.multisample.count;
    let pipeline = this.pipelines.get(key);
    if (!pipeline) {
      pipeline = render(c.device, shader, output.format, { multisample: output.multisample });
      this.pipelines.set(key, pipeline);
    }
    this.values.set([
      this.options.exposure ?? 0,
      this.options.gamma ?? 0,
      this.options.vignette ?? 0,
      preprocess
        ? 3
        : this.options.toneMapping === 'linear'
          ? 1
          : this.options.toneMapping === 'aces-narkowicz'
            ? 2
            : this.options.toneMapping === 'agx'
              ? 4
              : 0,
      c.width,
      c.height,
      +straight,
      0,
    ]);
    c.device.queue.writeBuffer(this.uniform!, 0, this.values);
    if (this.source !== input || this.pipeline !== pipeline) {
      this.group = c.device.createBindGroup({
        layout: pipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: input },
          { binding: 1, resource: { buffer: this.uniform! } },
        ],
      });
      this.source = input;
      this.pipeline = pipeline;
    }
    const pass = c.encoder.beginRenderPass({
      colorAttachments: [{ view: output.view, loadOp: viewLoadOp(c, 'clear'), storeOp: 'store' }],
    });
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, this.group!);
    applyView(pass, c);
    pass.draw(3);
    pass.end();
  }
  onDeviceRestored(engine: Engine): void {
    this.dispose();
    this.setup(engine);
  }
  dispose(): void {
    this.uniform?.destroy();
    this.uniform = undefined;
    this.device = undefined;
    this.pipelines.clear();
    this.source = this.pipeline = this.group = undefined;
  }
}

// Finite nonnegative float32 to nearest-even half, saturated at the rgba16float scene target's finite range.
const halfFloat = new Float32Array(1),
  halfBits = new Uint32Array(halfFloat.buffer);
function half(value: number): number {
  halfFloat[0] = Math.min(65504, Math.max(0, value));
  const bits = halfBits[0],
    exponent = ((bits >>> 23) & 255) - 127 + 15,
    mantissa = bits & 0x7fffff;
  if (exponent <= 0) {
    if (exponent < -10) return 0;
    const full = mantissa | 0x800000,
      shift = 14 - exponent,
      base = full >>> shift,
      remainder = full & ((1 << shift) - 1),
      mid = 1 << (shift - 1);
    return base + +(remainder > mid || (remainder === mid && (base & 1) !== 0));
  }
  const base = (exponent << 10) | (mantissa >>> 13),
    remainder = mantissa & 8191;
  return base + +(remainder > 4096 || (remainder === 4096 && (base & 1) !== 0));
}
function validateImage(image: LinearPostImage, device: GPUDevice, signal?: AbortSignal): void {
  if (!image || typeof image !== 'object')
    throw new TypeError('ImagePost image: pass width, height and a linear RGB buffer');
  for (const value of [image.width, image.height])
    if (
      !Number.isSafeInteger(value) ||
      value < 1 ||
      value > Math.min(16384, device.limits.maxTextureDimension2D ?? 16384)
    )
      throw new RangeError('ImagePost image dimensions: use positive integers within the device texture limit');
  const pixels = image.width * image.height;
  if (pixels > 16_777_216) throw new RangeError('ImagePost image dimensions: at most 16,777,216 pixels per export');
  if (!(image.color instanceof Float32Array) || image.color.length !== pixels * 3)
    throw new TypeError('ImagePost RGB buffer length must be width × height × 3 floats');
  if (image.alpha !== undefined && (!(image.alpha instanceof Float32Array) || image.alpha.length !== pixels))
    throw new TypeError('ImagePost alpha buffer length must match width × height');
  for (let i = 0; i < image.color.length; i++) {
    if ((i & 16383) === 0) signal?.throwIfAborted();
    if (!Number.isFinite(image.color[i]) || image.color[i] < 0)
      throw new RangeError('ImagePost radiance must be finite and nonnegative');
  }
  if (image.alpha) for (const a of image.alpha) range(a, 'alpha', 0, 1);
}

/**
 * Optional Margo bloom and display pipeline for a path-traced HDR viewport and its offscreen PNGs/sequences.
 * The producer must draw linear HDR and apply the same exposure/vignette specified here (the voxel tracer does).
 * Raw renderImage pixels are processed identically on export. The environment owns background colour/lighting;
 * this pass never substitutes either. Dispose before disposing its engine. No source pixels are changed.
 */
export class ImagePost implements EnginePlugin {
  readonly name = 'post:image';
  private engine?: Engine;
  private stack?: PostStack;
  private displayOptions: ImagePostOptions;
  private bloomOptions: BloomOptions;
  private display: ImageDisplay;
  private previewBloom: Bloom;
  private active?: AbortController;
  private disposed = false;
  constructor(options: ImagePostOptions = {}) {
    this.displayOptions = checkedOptions(options);
    this.bloomOptions = { ...this.displayOptions.bloom, exposure: 0 };
    this.display = new ImageDisplay(this.displayOptions);
    this.previewBloom = new Bloom(this.bloomOptions);
  }
  /** Attach one HDR capture shared by Margo Bloom and the matching display transform. */
  static attach(engine: EngineKernel, options: ImagePostOptions = {}): ImagePost {
    const effect = new ImagePost(options);
    engineRuntime(engine).use(effect);
    return effect;
  }
  /** Defensive snapshot of the current preset. */
  get options(): ImagePostOptions {
    return { ...this.displayOptions, bloom: { ...this.displayOptions.bloom } };
  }
  /** Replace the preset atomically. Captures hold their preset; changing one while rendering is refused. */
  setOptions(options: ImagePostOptions): void {
    this.alive();
    if (this.active)
      throw margoError('state', 'ImagePost options cannot change during a capture; finish or cancel it first');
    const next = checkedOptions(options);
    for (const key of Object.keys(this.displayOptions)) delete (this.displayOptions as Record<string, unknown>)[key];
    Object.assign(this.displayOptions, next);
    for (const key of Object.keys(this.bloomOptions)) delete (this.bloomOptions as Record<string, unknown>)[key];
    Object.assign(this.bloomOptions, next.bloom, { exposure: 0 });
  }
  setup(engine: Engine): void {
    this.alive();
    imageDevice(engine);
    this.engine = engine;
    this.stack = PostStack.attach(engine, [this.previewBloom, this.display]);
  }
  /** No additional passes: the owned PostStack performs the HDR capture and ordered effects. */
  registerPasses(_graph: FrameGraph): void {}
  /** Render a raw linear image through the same Bloom kernel and display pass used by the viewport. */
  async renderImage(image: LinearPostImage, controls: { signal?: AbortSignal } = {}): Promise<PostImagePixels> {
    this.alive();
    controls.signal?.throwIfAborted();
    if (this.active) throw margoError('state', 'ImagePost is already capturing; await or cancel it first');
    const device = imageDevice(this.engine);
    validateImage(image, device, controls.signal);
    const controller = new AbortController(),
      cancel = () => controller.abort(controls.signal!.reason);
    controls.signal?.addEventListener('abort', cancel, { once: true });
    this.active = controller;
    const textures: GPUTexture[] = [],
      buffers: GPUBuffer[] = [],
      bloom = new Bloom({ ...this.bloomOptions }),
      display = new ImageDisplay({ ...this.displayOptions }),
      preprocess = new ImageDisplay({ ...this.displayOptions });
    const { width, height } = image,
      row = Math.ceil((width * 4) / 256) * 256;
    let failure: unknown;
    device.pushErrorScope('validation');
    try {
      if (row * height > device.limits.maxBufferSize)
        throw new RangeError('ImagePost readback exceeds the GPU buffer limit; reduce image dimensions');
      const rgba = new Uint16Array(width * height * 4);
      for (let i = 0; i < width * height; i++) {
        if ((i & 16383) === 0) controller.signal.throwIfAborted();
        for (let c = 0; c < 3; c++) rgba[i * 4 + c] = half(image.color[i * 3 + c]);
        rgba[i * 4 + 3] = half(image.alpha?.[i] ?? 1);
      }
      const texture = (format: GPUTextureFormat, usage: GPUTextureUsageFlags) => {
        const t = device.createTexture({ size: [width, height], format, usage });
        textures.push(t);
        return t;
      };
      const source = texture('rgba16float', GPUTextureUsage.COPY_DST | GPUTextureUsage.TEXTURE_BINDING),
        prepared = texture('rgba16float', GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING),
        glow = texture('rgba16float', GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING),
        output = texture('rgba8unorm', GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC);
      device.queue.writeTexture({ texture: source }, rgba, { bytesPerRow: width * 8, rowsPerImage: height }, [
        width,
        height,
      ]);
      const readback = device.createBuffer({
        size: row * height,
        usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
      });
      buffers.push(readback);
      const encoder = device.createCommandEncoder(),
        context = { device, encoder, width, height },
        hdr = (view: GPUTextureView): StageOutput => ({
          view,
          format: 'rgba16float',
          multisample: { count: 1 },
          hdr: true,
        });
      preprocess.encode(context, source.createView(), hdr(prepared.createView()), true, false);
      bloom.encodeImage(context, prepared.createView(), glow.createView());
      display.encode(
        context,
        glow.createView(),
        { view: output.createView(), format: 'rgba8unorm', multisample: { count: 1 }, hdr: false },
        false,
        !!image.alpha,
      );
      encoder.copyTextureToBuffer({ texture: output }, { buffer: readback, bytesPerRow: row, rowsPerImage: height }, [
        width,
        height,
      ]);
      device.queue.submit([encoder.finish()]);
      await readback.mapAsync(GPUMapMode.READ);
      controller.signal.throwIfAborted();
      const mapped = new Uint8Array(readback.getMappedRange()),
        data = new Uint8ClampedArray(width * height * 4);
      for (let y = 0; y < height; y++) data.set(mapped.subarray(y * row, y * row + width * 4), y * width * 4);
      readback.unmap();
      return { width, height, data };
    } catch (error) {
      failure = error;
      throw error;
    } finally {
      let validationError: GPUError | null = null,
        scopeFailure: unknown;
      try {
        validationError = await device.popErrorScope();
      } catch (error) {
        scopeFailure = error;
      }
      controls.signal?.removeEventListener('abort', cancel);
      for (const buffer of buffers) buffer.destroy();
      for (const texture of textures) texture.destroy();
      bloom.dispose();
      display.dispose();
      preprocess.dispose();
      if (this.active === controller) this.active = undefined;
      if (failure === undefined) {
        controller.signal.throwIfAborted();
        if (scopeFailure !== undefined) throw scopeFailure;
        if (validationError)
          throw margoError(
            'failed',
            `ImagePost GPU validation failed (${validationError.message}); check the input and device limits.`,
          );
      }
    }
  }
  /** PNG of the processed linear image, including alpha when supplied. The caller's cancellation is checked after encoding. */
  async capture(image: LinearPostImage, controls: { signal?: AbortSignal } = {}): Promise<Blob> {
    const pixels = await this.renderImage(image, controls);
    controls.signal?.throwIfAborted();
    this.alive();
    const canvas = new OffscreenCanvas(pixels.width, pixels.height),
      context = canvas.getContext('2d');
    if (!context) throw margoError('unsupported', 'ImagePost PNG capture requires a 2D OffscreenCanvas');
    context.putImageData(new ImageData(pixels.data, pixels.width, pixels.height), 0, 0);
    const blob = await canvas.convertToBlob({ type: 'image/png' });
    controls.signal?.throwIfAborted();
    this.alive();
    return blob;
  }
  /** Cancel exports made for a lost device; the PostStack restores its own GPU resources. */
  onDeviceRestored(_engine: Engine): void {
    this.active?.abort(margoError('failed', 'ImagePost GPU device changed during capture; start a new export'));
  }
  /** Remove owned passes/effects and cancel any pending export. Safe to repeat. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.active?.abort(margoError('disposed', 'ImagePost was disposed during capture'));
    this.engine?.removePlugin(this.name);
    this.stack?.dispose();
    this.previewBloom.dispose();
    this.display.dispose();
    this.stack = undefined;
    this.engine = undefined;
  }
  private alive(): void {
    if (this.disposed) throw margoError('disposed', 'ImagePost: create a new effect after disposal');
  }
  declare [Symbol.dispose]: () => void;
  [(Symbol.dispose ?? Symbol()) as symbol](): void {
    this.dispose();
  }
}
