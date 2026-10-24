// KTX2 texture upload helpers without the transcoder: `@margoengine/decoders/texture`. Loaders that upload already
// transcoded textures import these so the codec modules stay out of their startup bundle.
import { transcodeFormats } from './formats.js';
import type { TranscodeTarget, TranscodedKTX2Result } from './protocol.js';

declare const GPUTextureUsage: { TEXTURE_BINDING: number; COPY_DST: number };

/** Pick the best compressed format the device has enabled: BC7 on desktop, ASTC on mobile and Apple, ETC2 on Android, else RGBA8. */
export function getSupportedTranscodeFormat(device?: { features: ReadonlySetLike<string> }): TranscodeTarget {
  const features = device?.features;
  if (features?.has('texture-compression-bc')) return 'bc7';
  if (features?.has('texture-compression-astc')) return 'astc-4x4';
  if (features?.has('texture-compression-etc2')) return 'etc2';
  return 'rgba8';
}

type ReadonlySetLike<T> = { has(value: T): boolean };

/** Bytes per row of one mip level for `writeTexture`. Block formats count 4-pixel blocks. */
export function getBytesPerRow(format: GPUTextureFormat, width: number): number {
  const base = format.replace(/-srgb$/, ''),
    entry = Object.values(transcodeFormats).find((f) => f.gpu === base);
  if (!entry)
    throw new TypeError(
      `Unsupported KTX2 texture format ${format}; use bc7-rgba-unorm, astc-4x4-unorm, etc2-rgba8unorm or rgba8unorm (with or without -srgb)`,
    );
  return Math.ceil(width / entry.block) * entry.blockBytes;
}

export interface KTX2TextureOptions {
  label?: string;
  /** Default: TEXTURE_BINDING | COPY_DST. */
  usage?: number;
}

/** Allocate the texture in its compressed format and write every mip level directly from the transferred buffer. */
export function createKTX2Texture(
  device: GPUDevice,
  result: TranscodedKTX2Result,
  options: KTX2TextureOptions = {},
): GPUTexture {
  const block = transcodeFormats[result.target]?.block ?? 1;
  const texture = device.createTexture({
    label: options.label,
    size: [result.width, result.height, 1],
    mipLevelCount: result.mipmaps.length,
    format: result.format,
    usage: options.usage ?? GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
  });
  try {
    result.mipmaps.forEach((mip, level) => {
      // Small block-compressed mips are copied at their physical (block-rounded) size.
      const width = Math.ceil(mip.width / block) * block,
        height = Math.ceil(mip.height / block) * block;
      device.queue.writeTexture(
        { texture, mipLevel: level },
        mip.data as Uint8Array<ArrayBuffer>,
        { bytesPerRow: getBytesPerRow(result.format, mip.width), rowsPerImage: height },
        [width, height, 1],
      );
    });
  } catch (error) {
    texture.destroy();
    throw error;
  }
  return texture;
}
