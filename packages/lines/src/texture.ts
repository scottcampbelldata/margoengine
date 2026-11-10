import { MargoError } from '@margoengine/math/errors';
import { generateMipmaps } from '../../shared/mipmaps.js';
import { Stroke, type StrokeOptions } from './stroke.js';
import type { LineExtension } from './extension.js';

/** Owned RGBA8 image. Reusable across lines and retained for device restoration. */
export class LineTexture {
  private readonly pixels: Uint8Array;
  constructor(
    readonly width: number,
    readonly height: number,
    rgba: Uint8Array | Uint8ClampedArray,
  ) {
    if (
      !Number.isInteger(width) ||
      !Number.isInteger(height) ||
      width < 1 ||
      height < 1 ||
      width > 16384 ||
      height > 16384
    )
      throw new RangeError('Line texture dimensions must be integers in 1..16384');
    if (!(rgba instanceof Uint8Array || rgba instanceof Uint8ClampedArray) || rgba.length !== width * height * 4)
      throw new RangeError('Line texture needs four RGBA8 bytes per pixel');
    this.pixels = new Uint8Array(rgba);
  }

  /** @internal Uploads linear-filtered, mipmapped sRGB colour and linear alpha. Caller owns the returned texture. */
  upload(device: GPUDevice): GPUTexture {
    if (Math.max(this.width, this.height) > device.limits.maxTextureDimension2D)
      throw new RangeError('Line texture exceeds this device limit; reduce its dimensions');
    const levels = Math.floor(Math.log2(Math.max(this.width, this.height))) + 1;
    const texture = device.createTexture({
      size: [this.width, this.height],
      format: 'rgba8unorm-srgb',
      mipLevelCount: levels,
      usage: 4 | 2 | 16,
    });
    try {
      device.queue.writeTexture({ texture }, this.pixels, { bytesPerRow: this.width * 4 }, [this.width, this.height]);
      generateMipmaps(device, texture, levels, new Map());
      return texture;
    } catch (error) {
      texture.destroy();
      throw error;
    }
  }
}

/** Fetch and decode an image into restoration-safe RGBA8 pixels. The caller owns CORS permission. */
export async function loadLineTexture(url: string | URL, options: { signal?: AbortSignal } = {}): Promise<LineTexture> {
  const { signal } = options;
  signal?.throwIfAborted();
  if (typeof createImageBitmap !== 'function' || typeof OffscreenCanvas !== 'function')
    throw new MargoError(
      'unsupported',
      'Image decoding needs createImageBitmap and OffscreenCanvas; pass RGBA8 pixels to LineTexture instead',
    );
  const response = await fetch(url, { signal });
  if (!response.ok)
    throw new MargoError('failed', `Line texture HTTP ${response.status}; check the URL and CORS permission`);
  const bitmap = await createImageBitmap(await response.blob());
  try {
    signal?.throwIfAborted();
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const context = canvas.getContext('2d');
    if (!context)
      throw new MargoError('unsupported', 'Line texture needs a 2D decoding context; pass RGBA8 pixels instead');
    context.drawImage(bitmap, 0, 0);
    return new LineTexture(bitmap.width, bitmap.height, context.getImageData(0, 0, bitmap.width, bitmap.height).data);
  } finally {
    bitmap.close();
  }
}

/** Textured stroke options. The image's U axis follows cumulative world-space length. */
export interface TexturedLineOptions extends StrokeOptions {
  /** Restoration-safe image, with straight alpha and sRGB colour. */
  texture: LineTexture;
  /** Tiles per world unit along the path. Default 1; negative reverses the image, zero holds one column. */
  repeat?: number;
  /** Tiles across the width. Default 1. */
  repeatAcross?: number;
  /** U/V offsets in tiles. Default [0, 0]. */
  offset?: readonly [number, number];
  /** Fragments at or below this texture alpha are discarded in colour, depth and picking. Default 0.001. */
  alphaCutoff?: number;
}

/** Repeated colour/alpha texture, composable with every Stroke option. */
export class TexturedLine extends Stroke {
  /** Tiles per world unit along the path, live. Default 1. */
  repeat: number;
  /** Tiles across the width, live. Default 1. */
  repeatAcross: number;
  /** U/V offsets in tiles, live. */
  readonly offset: Float32Array;
  /** Texture-alpha cutoff, live. Default 0.001. */
  alphaCutoff: number;

  constructor(options: TexturedLineOptions) {
    const { texture, repeat = 1, repeatAcross = 1, offset = [0, 0], alphaCutoff = 0.001, ...stroke } = options;
    super(stroke);
    if (!(texture instanceof LineTexture)) throw new TypeError('TexturedLine texture must be a LineTexture');
    this.repeat = repeat;
    this.repeatAcross = repeatAcross;
    this.offset = new Float32Array(offset);
    this.alphaCutoff = alphaCutoff;
    this.validateTexture();
    const base = this.strokeExtension();
    this.extension = {
      key: 'texture',
      entries: [
        ...base.entries,
        { binding: 4, visibility: 2, texture: { sampleType: 'float' } },
        { binding: 5, visibility: 2, sampler: { type: 'filtering' } },
        { binding: 6, visibility: 2, buffer: { type: 'uniform', minBindingSize: 32 } },
      ],
      shader: (code, picking) => textureShader(base.shader(code, picking), picking),
      create: (device) => this.createTextureResources(device, base, texture),
    };
  }

  private validateTexture(): void {
    if (
      this.offset.length !== 2 ||
      ![this.repeat, this.repeatAcross, ...this.offset, this.alphaCutoff].every(
        (v) => Number.isFinite(v) && Math.abs(v) <= 3.4e38,
      )
    )
      throw new RangeError('Texture repeat and offset must be finite numbers; use a two-value offset');
    if (this.alphaCutoff < 0 || this.alphaCutoff > 1) throw new RangeError('Texture alphaCutoff must be 0..1');
  }

  private createTextureResources(
    device: GPUDevice,
    base: LineExtension,
    source: LineTexture,
  ): ReturnType<LineExtension['create']> {
    const stroke = base.create(device);
    let texture: GPUTexture | undefined, uniform: GPUBuffer | undefined;
    try {
      texture = source.upload(device);
      uniform = device.createBuffer({ size: 32, usage: 64 | 8 });
      const data = new Float32Array(8),
        previous = new Float32Array(8).fill(NaN);
      return {
        entries: [
          ...stroke.entries,
          { binding: 4, resource: texture.createView() },
          {
            binding: 5,
            resource: device.createSampler({
              addressModeU: 'repeat',
              addressModeV: 'repeat',
              magFilter: 'linear',
              minFilter: 'linear',
              mipmapFilter: 'linear',
            }),
          },
          { binding: 6, resource: { buffer: uniform } },
        ],
        update: () => {
          this.validateTexture();
          stroke.update();
          data.set([this.repeat, this.repeatAcross, ...this.offset, this.alphaCutoff]);
          if (data.some((v, i) => v !== previous[i])) {
            device.queue.writeBuffer(uniform!, 0, data);
            previous.set(data);
          }
        },
        dispose: () => {
          stroke.dispose();
          texture!.destroy();
          uniform!.destroy();
        },
      };
    } catch (error) {
      stroke.dispose();
      texture?.destroy();
      uniform?.destroy();
      throw error;
    }
  }
}

/** @internal Texture sampling is outside reveal/dash control flow, with continuous UV derivatives. */
export function textureShader(code: string, picking = false): string {
  const sample = `
  let uv=vec2f(i.dist*lineTexParams.x+lineTexParams.z,(i.edge.x/max(i.edge.y,1e-6)*0.5+0.5)*lineTexParams.y+lineTexParams.w);
  let texel=textureSampleGrad(lineImage,lineSampler,uv,dpdx(uv),dpdy(uv));
  if(texel.a<=lineTexAlpha.x){discard;}
`;
  return (
    `@group(1) @binding(4) var lineImage:texture_2d<f32>;
@group(1) @binding(5) var lineSampler:sampler;
struct LineTexUniform { uv:vec4f, alpha:vec4f }
@group(1) @binding(6) var<uniform> lineTexUniform:LineTexUniform;
` + code
  )
    .replace(
      /(@fragment fn fragment\(i:Out\)[^{]+\{)/,
      '$1' + sample.replaceAll('lineTexParams', 'lineTexUniform.uv').replaceAll('lineTexAlpha', 'lineTexUniform.alpha'),
    )
    .replace('let alpha=i.color.a*cover;', 'let alpha=i.color.a*cover*texel.a;')
    .replace(
      'var rgb=max(i.color.rgb,vec3f(0.0));',
      picking ? 'var rgb=max(i.color.rgb,vec3f(0.0));' : 'var rgb=max(i.color.rgb*texel.rgb,vec3f(0.0));',
    );
}
