import type { EngineKernel } from '@margoengine/core';
import { engineRuntime, type Engine } from '@margoengine/core/extension';
import { fullscreen } from '../../shared/gpu.js';
import { fault } from '../../shared/errors.js';
import { Transitions } from './index.js';
declare const GPUTextureUsage: { TEXTURE_BINDING: number; COPY_DST: number; RENDER_ATTACHMENT: number };

/** Texture-mask edge settings. The red channel of a greyscale image sets reveal order. */
export interface MaskTransitionOptions {
  /** Threshold half-width, default 0.02. Zero is hard; otherwise finite 0.000001..1. */
  softness?: number;
}
type Source = { width: number; height: number; data: Uint8ClampedArray } | ImageBitmap;
class MaskTransition extends Transitions {
  private mask?: GPUTexture;
  private view?: GPUTextureView;
  constructor(
    private source: Source | undefined,
    softness: number,
  ) {
    super();
    this.shaderCode = `${fullscreen}
@group(0) @binding(0) var<uniform> settings:vec4f;
@group(0) @binding(1) var before:texture_2d<f32>;
@group(0) @binding(2) var after:texture_2d<f32>;
@group(0) @binding(3) var mask:texture_2d<f32>;
// Integer centre addressing avoids interpolated-UV rounding at exact nearest-texel ties after odd-size resizes.
fn sample(t:texture_2d<f32>,pixel:vec2u,extent:vec2u)->vec4f {
 let n=textureDimensions(t);let q=(pixel*n+n/2u)/extent;
 return textureLoad(t,vec2i(min(q,n-1u)),0);
}
@fragment fn fragment(i:Vertex)->@location(0) vec4f {
 let p=settings.x;let pixel=vec2u(i.position.xy);let extent=textureDimensions(after);
 if(p<=0.0){return sample(before,pixel,extent);}if(p>=1.0){return sample(after,pixel,extent);}
 let edge=sample(mask,pixel,extent).r;
 let weight=${softness === 0 ? 'select(0.0,1.0,edge<=p)' : `1.0-smoothstep(p-f32(${softness}),p+f32(${softness}),edge)`};
 return mix(sample(before,pixel,extent),sample(after,pixel,extent),weight);
}`;
  }
  override setup(engine: Engine): void {
    if (this.source && (this.source.width < 1 || this.source.height < 1))
      throw fault('state', 'Mask image was closed; create a transition with an open ImageBitmap');
    super.setup(engine);
    const source = this.source!;
    this.mask = engine.gpu!.createTexture({
      size: [source.width, source.height],
      format: 'rgba8unorm',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT,
    });
    if ('data' in source) {
      engine.gpu!.queue.writeTexture(
        { texture: this.mask },
        source.data as Uint8ClampedArray<ArrayBuffer>,
        { bytesPerRow: source.width * 4 },
        [source.width, source.height],
      );
    } else {
      engine.gpu!.queue.copyExternalImageToTexture({ source }, { texture: this.mask }, [source.width, source.height]);
    }
    this.view = this.mask.createView();
  }
  protected override transitionBindings(before: GPUTexture, after: GPUTexture): GPUBindingResource[] {
    if (Math.max(before.width, before.height, after.width, after.height) > 65535)
      throw new RangeError('Mask capture exceeds integer addressing limits; keep capture dimensions at most 65535');
    return [...super.transitionBindings(before, after), this.view!];
  }
  override onDeviceRestored(engine: Engine): void {
    this.mask?.destroy();
    this.mask = undefined;
    this.view = undefined;
    super.onDeviceRestored(engine);
  }
  override dispose(): void {
    this.mask?.destroy();
    this.mask = undefined;
    this.view = undefined;
    this.source = undefined;
    super.dispose();
  }
}

/**
 * Attaches a greyscale texture wipe. Black reveals first and white last; alpha is ignored.
 * ImageData bytes are snapshotted. A borrowed ImageBitmap must remain open until disposal, for device restoration.
 * Images stretch to the full capture using clamped nearest sampling, top-left origin; image dimensions 1..min(4096, device limit).
 * Capture dimensions must be at most 65535 for overflow-free integer centre addressing.
 * Call the returned start('wipe', seconds); kind and displacement do not affect the mask.
 * @throws TypeError for anything except 8-bit ImageData or an open ImageBitmap.
 * @throws RangeError for invalid softness or image dimensions.
 * @throws MargoError `unsupported` with help on WebGL2.
 */
export function createMaskTransition(
  engine: EngineKernel,
  image: ImageData | ImageBitmap,
  options: MaskTransitionOptions = {},
): Transitions {
  const runtime = engineRuntime(engine);
  if (!runtime.gpu) throw fault('unsupported', 'Texture mask transitions require WebGPU; select a WebGPU engine');
  const data = typeof ImageData !== 'undefined' && image instanceof ImageData;
  const bitmap = typeof ImageBitmap !== 'undefined' && image instanceof ImageBitmap;
  if ((!data && !bitmap) || (data && !(image.data instanceof Uint8ClampedArray)))
    throw new TypeError('Mask transition needs 8-bit ImageData or an open ImageBitmap; decode the image first');
  const limit = Math.min(4096, runtime.gpu.limits.maxTextureDimension2D);
  if (![image.width, image.height].every((n) => Number.isSafeInteger(n) && n >= 1 && n <= limit))
    throw new RangeError('Mask transition dimensions exceed limits; use 1..min(4096, device maxTextureDimension2D)');
  const softness = options.softness ?? 0.02;
  if (!Number.isFinite(softness) || softness < 0 || softness > 1 || (softness > 0 && softness < 0.000001))
    throw new RangeError('Mask softness is out of range; use zero or 0.000001..1');
  const effect = new MaskTransition(
    data ? { width: image.width, height: image.height, data: image.data.slice() } : image,
    softness,
  );
  runtime.use(effect);
  return effect;
}
