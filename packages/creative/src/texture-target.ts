/// <reference lib="esnext.disposable" preserve="true" />
import { fault, rangeError } from '../../shared/errors.js';

declare const GPUTextureUsage: { RENDER_ATTACHMENT: number; TEXTURE_BINDING: number; COPY_SRC: number };

/** A cube uses the WebGPU face order +X, -X, +Y, -Y, +Z, -Z. */
export interface TextureRenderTargetOptions {
  readonly kind: 'cube' | 'array' | '3d';
  /** Pixel width, bounded by the device. */
  readonly width: number;
  /** Pixel height. Default: width. Cubes must be square. */
  readonly height?: number;
  /** Array layers or volume depth. Default: 1, or 6 for a cube (fixed). */
  readonly depthOrLayers?: number;
  /** Allocated levels. Default: 1. Mips are rendered explicitly, never generated. */
  readonly mipLevelCount?: number;
  /** Linear color format. Default: rgba8unorm. */
  readonly format?: 'rgba8unorm' | 'rgba16float';
}

/** Select one renderable subresource; all defaults address mip 0, layer/slice 0. */
export interface TargetSurface {
  readonly mip?: number;
  /** Cube face, array layer, or depth slice at the selected mip. */
  readonly layer?: number;
  /** Default: clear. Use load to preserve earlier draws to the same surface. */
  readonly loadOp?: 'clear' | 'load';
  /** Default: transparent black. Four finite components, 0..1 (rgba8) or +/-65504 (HDR). */
  readonly clearColor?: readonly [number, number, number, number];
}

const invalid = (message: string) => rangeError(`Texture target ${message}`, 'creative-target');
const integer = (value: number, min: number, max: number, name: string) => {
  if (!Number.isSafeInteger(value) || value < min || value > max)
    throw invalid(`${name} must be an integer in ${min}..${max}`);
};
const webgpu = (device: GPUDevice | null | undefined): GPUDevice => {
  if (!device || typeof device.createTexture !== 'function')
    throw fault('unsupported', 'TextureRenderTarget needs WebGPU; create a WebGPU engine and pass engine.gpu');
  return device;
};

/**
 * Owned color-only cube, array or volume texture. Render with begin(), sample with view.
 * No core scene capture, depth, MSAA, camera updates or automatic mip generation.
 * Call restore(newDevice) after device loss and redraw every surface; dispose is terminal.
 */
export class TextureRenderTarget {
  readonly options: Readonly<Required<TextureRenderTargetOptions>>;
  #device: GPUDevice;
  #texture!: GPUTexture;
  #view!: GPUTextureView;
  #surfaces = new Map<string, GPUTextureView>();
  #disposed = false;

  constructor(device: GPUDevice | null | undefined, options: TextureRenderTargetOptions) {
    this.#device = webgpu(device);
    if (!options || !['cube', 'array', '3d'].includes(options.kind)) throw invalid('kind must be cube, array or 3d');
    this.options = Object.freeze({
      kind: options.kind,
      width: options.width,
      height: options.height ?? options.width,
      depthOrLayers: options.depthOrLayers ?? (options.kind === 'cube' ? 6 : 1),
      mipLevelCount: options.mipLevelCount ?? 1,
      format: options.format ?? 'rgba8unorm',
    });
    this.#validate(this.#device);
    const resource = this.#create(this.#device);
    this.#texture = resource.texture;
    this.#view = resource.view;
  }

  #validate(device: GPUDevice): void {
    const o = this.options;
    const limit = o.kind === '3d' ? device.limits.maxTextureDimension3D : device.limits.maxTextureDimension2D;
    integer(o.width, 1, limit, 'width');
    integer(o.height, 1, limit, 'height');
    integer(o.depthOrLayers, 1, o.kind === '3d' ? limit : device.limits.maxTextureArrayLayers, 'depthOrLayers');
    if (o.kind === 'cube' && (o.width !== o.height || o.depthOrLayers !== 6))
      throw invalid('cube must be square with exactly six faces');
    const levels = 1 + Math.floor(Math.log2(Math.max(o.width, o.height, o.kind === '3d' ? o.depthOrLayers : 1)));
    integer(o.mipLevelCount, 1, levels, 'mipLevelCount');
    if (o.format !== 'rgba8unorm' && o.format !== 'rgba16float')
      throw invalid('format must be rgba8unorm or rgba16float');
    let bytes = 0;
    for (let mip = 0; mip < o.mipLevelCount; mip++) {
      const [w, h, d] = this.mipSize(mip);
      bytes += w * h * d * (o.format === 'rgba16float' ? 8 : 4);
    }
    if (bytes > 256 * 1024 * 1024) throw invalid('allocation exceeds 256 MiB; reduce dimensions or mip levels');
  }

  #create(device: GPUDevice): { texture: GPUTexture; view: GPUTextureView } {
    const o = this.options;
    const texture = device.createTexture({
      label: 'creative texture target',
      dimension: o.kind === '3d' ? '3d' : '2d',
      size: [o.width, o.height, o.depthOrLayers],
      mipLevelCount: o.mipLevelCount,
      format: o.format,
      usage: this.textureUsage(),
    });
    try {
      return { texture, view: texture.createView({ dimension: o.kind === 'array' ? '2d-array' : o.kind }) };
    } catch (error) {
      texture.destroy();
      throw error;
    }
  }

  /** Attachment extensions may request additional copy usages before allocation. */
  protected textureUsage(): number {
    return GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_SRC;
  }

  #live(): void {
    if (this.#disposed) throw fault('disposed', 'TextureRenderTarget is disposed; create a new target');
  }

  /** Live owned texture, also usable for copyTextureToBuffer readback. */
  get texture(): GPUTexture {
    this.#live();
    return this.#texture;
  }
  /** Whole-resource sampling view, with dimension cube, 2d-array or 3d. */
  get view(): GPUTextureView {
    this.#live();
    return this.#view;
  }
  /** Logical width, height and depth/layer count at a mip. Array and cube layers never shrink. */
  mipSize(mip = 0): readonly [number, number, number] {
    this.#live();
    const o = this.options;
    integer(mip, 0, o.mipLevelCount - 1, 'mip');
    const scale = 2 ** mip;
    return [
      Math.max(1, Math.floor(o.width / scale)),
      Math.max(1, Math.floor(o.height / scale)),
      o.kind === '3d' ? Math.max(1, Math.floor(o.depthOrLayers / scale)) : o.depthOrLayers,
    ];
  }

  /** Begin a color pass. The caller sets a matching single-sample pipeline, draws and ends the pass. */
  begin(encoder: GPUCommandEncoder, surface: TargetSurface = {}): GPURenderPassEncoder {
    this.#live();
    const { mip = 0, layer = 0, loadOp = 'clear', clearColor = [0, 0, 0, 0] } = surface;
    const size = this.mipSize(mip);
    integer(layer, 0, size[2] - 1, 'layer');
    if (loadOp !== 'clear' && loadOp !== 'load') throw invalid('loadOp must be clear or load');
    const max = this.options.format === 'rgba16float' ? 65504 : 1;
    const min = this.options.format === 'rgba16float' ? -65504 : 0;
    if (
      !Array.isArray(clearColor) ||
      clearColor.length !== 4 ||
      Array.from(clearColor).some((v) => !Number.isFinite(v) || v < min || v > max)
    )
      throw invalid(`clearColor must contain four finite components in ${min}..${max}`);
    const volume = this.options.kind === '3d';
    const key = `${mip}:${volume ? 0 : layer}`;
    let view = this.#surfaces.get(key);
    if (!view) {
      view = this.#texture.createView({
        dimension: volume ? '3d' : '2d',
        baseMipLevel: mip,
        mipLevelCount: 1,
        ...(volume ? {} : { baseArrayLayer: layer, arrayLayerCount: 1 }),
      });
      this.#surfaces.set(key, view);
    }
    return encoder.beginRenderPass({
      colorAttachments: [
        { view, ...(volume ? { depthSlice: layer } : {}), loadOp, storeOp: 'store', clearValue: [...clearColor] },
      ],
    });
  }

  /** Replace device resources, preserving only options. Fetch fresh texture/view handles and redraw afterward. */
  restore(device: GPUDevice | null | undefined): void {
    this.#live();
    const next = webgpu(device);
    this.#validate(next);
    const resource = this.#create(next);
    this.#texture.destroy();
    this.#texture = resource.texture;
    this.#view = resource.view;
    this.#device = next;
    this.#surfaces.clear();
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#texture.destroy();
    this.#surfaces.clear();
  }
  declare [Symbol.dispose]: () => void;
  [(Symbol.dispose ?? Symbol()) as symbol](): void {
    this.dispose();
  }
}
