import { parseDDS, uploadTexture, type TextureFile } from '@margoengine/decoders/dds';
import { decodeBC, decodeBCFloat } from '@margoengine/decoders/bc';
import { margoError } from '../../shared/errors.js';
import type { GLTFCompressedImage, GLTFDecoderHooks } from './asset.js';

// Round binary16 ties to even. BC6H outputs are already exact binary16 values.
function half(value: number): number {
  const sign = value < 0 ? 0x8000 : 0,
    v = Math.abs(value);
  if (!v) return sign;
  const e = Math.max(-14, Math.floor(Math.log2(v))),
    scaled = v * 2 ** (10 - e),
    lo = Math.floor(scaled),
    rounded = lo + (scaled - lo > 0.5 || (scaled - lo === 0.5 && lo % 2) ? 1 : 0);
  return sign | (e === -14 && rounded < 1024 ? rounded : ((e + 14) << 10) + rounded);
}

/** Parse a single-layer 2D DDS, retaining every mip for upload, device restoration and model clones. */
export function decodeDDSImage(data: Uint8Array, options: { signal?: AbortSignal } = {}): GLTFCompressedImage {
  options.signal?.throwIfAborted();
  const file = parseDDS(data);
  if (file.dimension !== '2d' || file.layers !== 1)
    throw margoError('unsupported', 'glTF material DDS images must be single-layer 2D textures; export a 2D image');
  if (file.width * file.height > 16_777_216)
    throw new RangeError('glTF DDS image exceeds decoded size limit; export a smaller texture');
  let fallback: TextureFile | undefined;
  const select = (device: GPUDevice): TextureFile => {
    if (!file.feature || (device.features.has(file.feature) && file.width % 4 === 0 && file.height % 4 === 0))
      return file;
    if (!fallback) {
      const float = /^bc[456]/.test(file.format);
      const mipmaps = file.mipmaps.map((mip) => {
        const decoded = float
            ? decodeBCFloat(file.format, mip.data, mip.width, mip.height)
            : decodeBC(file.format, mip.data, mip.width, mip.height),
          pixels = float ? Uint16Array.from(decoded.data, half) : decoded.data,
          bytes = new Uint8Array(pixels.buffer, pixels.byteOffset, pixels.byteLength);
        return { ...mip, data: bytes, byteLength: bytes.length };
      });
      fallback = { ...file, format: float ? 'rgba16float' : 'rgba8unorm', feature: undefined, mipmaps };
    }
    return fallback;
  };
  const gpuFormat = (device: GPUDevice, srgb: boolean): GPUTextureFormat => {
    const base = select(device).format.replace(/-srgb$/, '');
    return (base + (srgb && /^(rgba8unorm|bc[1237]-)/.test(base) ? '-srgb' : '')) as GPUTextureFormat;
  };
  return {
    width: file.width,
    height: file.height,
    format: file.format,
    mipmaps: file.mipmaps,
    gpuFormat,
    upload(device, srgb) {
      const selected = select(device),
        format = gpuFormat(device, srgb);
      if (/^(r|rg|rgba)32float$/.test(format) && !device.features.has('float32-filterable'))
        throw margoError(
          'unsupported',
          '32-bit float DDS material textures require float32-filterable; request that device feature or export 16-bit float DDS',
        );
      return uploadTexture(device, { ...selected, format });
    },
  };
}

/** MSFT_texture_dds decoder hook. Async glTF loaders select it lazily when a file uses the extension. */
export const ddsTextures: NonNullable<GLTFDecoderHooks['dds']> = { decode: decodeDDSImage };
