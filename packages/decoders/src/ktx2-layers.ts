// KTX2 cube maps, cube arrays and 2D arrays (`@margoengine/decoders/ktx2-layers`), from the KTX 2.0 specification.
// Basis Universal files (ETC1S and UASTC) transcode in the decoder workers, every level, layer and face; files that
// store a GPU format (vkFormat set) are read here without the Wasm, inflating zlib or Zstandard levels. The Zstandard and
// zlib code loads on first use, so neither costs anything until a file needs it.
import { decodeFailed } from './errors.js';
import { KTX2Decoder, type KTX2DecodeOptions } from './ktx2.js';
import { readKTX2Index, type KTX2Index } from './ktx2-file.js';
import { formatBlock, levelBytes, uploadTexture, type TextureFile, type UploadTextureOptions } from './texture-file.js';

export type { TextureFile, TextureFileLevel, UploadTextureOptions } from './texture-file.js';
export { uploadTexture } from './texture-file.js';

const ASTC = ['4x4', '5x4', '5x5', '6x5', '6x6', '8x5', '8x6', '8x8', '10x5', '10x6', '10x8', '10x10', '12x10', '12x12'],
  // The Vulkan formats a WebGPU texture can hold, by VkFormat number.
  VK: Record<number, string> = {
    9: 'r8unorm',
    10: 'r8snorm',
    16: 'rg8unorm',
    17: 'rg8snorm',
    37: 'rgba8unorm',
    38: 'rgba8snorm',
    43: 'rgba8unorm-srgb',
    44: 'bgra8unorm',
    50: 'bgra8unorm-srgb',
    64: 'rgb10a2unorm',
    76: 'r16float',
    83: 'rg16float',
    97: 'rgba16float',
    100: 'r32float',
    103: 'rg32float',
    109: 'rgba32float',
    122: 'rg11b10ufloat',
    123: 'rgb9e5ufloat',
    131: 'bc1-rgba-unorm',
    132: 'bc1-rgba-unorm-srgb',
    133: 'bc1-rgba-unorm',
    134: 'bc1-rgba-unorm-srgb',
    135: 'bc2-rgba-unorm',
    136: 'bc2-rgba-unorm-srgb',
    137: 'bc3-rgba-unorm',
    138: 'bc3-rgba-unorm-srgb',
    139: 'bc4-r-unorm',
    140: 'bc4-r-snorm',
    141: 'bc5-rg-unorm',
    142: 'bc5-rg-snorm',
    143: 'bc6h-rgb-ufloat',
    144: 'bc6h-rgb-float',
    145: 'bc7-rgba-unorm',
    146: 'bc7-rgba-unorm-srgb',
    147: 'etc2-rgb8unorm',
    148: 'etc2-rgb8unorm-srgb',
    149: 'etc2-rgb8a1unorm',
    150: 'etc2-rgb8a1unorm-srgb',
    151: 'etc2-rgba8unorm',
    152: 'etc2-rgba8unorm-srgb',
    153: 'eac-r11unorm',
    154: 'eac-r11snorm',
    155: 'eac-rg11unorm',
    156: 'eac-rg11snorm',
    ...Object.fromEntries(
      ASTC.flatMap((size, i) => [
        [157 + i * 2, `astc-${size}-unorm`],
        [158 + i * 2, `astc-${size}-unorm-srgb`],
      ]),
    ),
  },
  // Three-channel formats, which WebGPU lacks: the target format, bytes per channel and the alpha value's bytes.
  RGB: Record<number, [string, number, number[]]> = {
    23: ['rgba8unorm', 1, [255]],
    29: ['rgba8unorm-srgb', 1, [255]],
    90: ['rgba16float', 2, [0x00, 0x3c]],
    106: ['rgba32float', 4, [0x00, 0x00, 0x80, 0x3f]],
  };

const refuse = (what: string): Error =>
  decodeFailed(`KTX2 ${what} is not supported; convert the file to a 2D, array or cube texture in a WebGPU format`);

async function levelData(bytes: Uint8Array, index: KTX2Index, level: number, signal?: AbortSignal): Promise<Uint8Array> {
  const { offset, length, uncompressedLength } = index.levels[level],
    stored = bytes.subarray(offset, offset + length);
  if (index.supercompression === 0) return stored;
  if (index.supercompression === 3) {
    const { inflateZlib } = await import('./ktx2-inflate.js');
    return inflateZlib(stored, uncompressedLength);
  }
  if (index.supercompression === 2) {
    const { decompressZstd } = await import('../../shared/zstd.js');
    return decompressZstd(stored, { signal, maxOutputSize: uncompressedLength });
  }
  throw refuse(`supercompression scheme ${index.supercompression} on a vkFormat file`);
}

// Adds an alpha channel after each three-channel texel: WebGPU has no RGB formats.
function expandRGB(data: Uint8Array, channel: number, alpha: number[]): Uint8Array {
  const texel = channel * 3,
    pixels = data.length / texel,
    out = new Uint8Array(pixels * channel * 4);
  for (let i = 0; i < pixels; i++) {
    out.set(data.subarray(i * texel, (i + 1) * texel), i * channel * 4);
    out.set(alpha, i * channel * 4 + texel);
  }
  return out;
}

/**
 * Reads a KTX2 file that stores a GPU format (`vkFormat` set): 2D, array, cube or cube array, every level, undoing zlib
 * or Zstandard supercompression. Block data passes through untouched; 8-, 16- and 32-bit RGB files gain an opaque alpha
 * channel because WebGPU has no three-channel formats. Basis Universal files go through {@link KTX2LayerDecoder}.
 *
 * @throws TypeError `KTX2: invalid file (...)` on a damaged header or level index.
 * @throws MargoError `failed` for a format or layout WebGPU cannot sample (3D, integer and depth formats) or level sizes
 * that do not match the header.
 */
export async function parseKTX2(bytes: Uint8Array, options: { signal?: AbortSignal } = {}): Promise<TextureFile> {
  if (!(bytes instanceof Uint8Array)) throw new TypeError('parseKTX2 needs the KTX2 file as a Uint8Array');
  const index = readKTX2Index(bytes),
    { width, height, layerCount, faceCount, vkFormat } = index;
  if (!vkFormat) throw decodeFailed('KTX2 holds a Basis Universal payload; read it with KTX2LayerDecoder.decode');
  const rgb = RGB[vkFormat],
    format = VK[vkFormat] ?? rgb?.[0];
  if (!format) throw refuse(`vkFormat ${vkFormat}`);
  if (index.depth > 1) throw refuse('3D texture');
  if (!height) throw refuse('1D texture');
  if (faceCount !== 1 && faceCount !== 6) throw decodeFailed(`KTX2 faceCount ${faceCount} is invalid; use 1 or 6`);
  if (faceCount === 6 && width !== height) throw decodeFailed('KTX2 cube faces are not square; re-encode the file');
  const block = formatBlock(format)!,
    layers = Math.max(1, layerCount) * faceCount,
    mipmaps: TextureFile['mipmaps'] = [];
  for (let level = 0; level < index.levels.length; level++) {
    const w = Math.max(1, width >> level),
      h = Math.max(1, height >> level),
      expected = levelBytes(block, w, h)[0] * layers * (rgb ? 3 / 4 : 1);
    let data = await levelData(bytes, index, level, options.signal);
    if (data.length !== expected)
      throw decodeFailed(`KTX2 level ${level} holds ${data.length} bytes, expected ${expected}; re-encode the file`);
    if (rgb) data = expandRGB(data, rgb[1], rgb[2]);
    mipmaps.push({ data, width: w, height: h, byteLength: data.length });
  }
  return {
    width,
    height,
    layers,
    dimension: faceCount === 6 ? (layerCount ? 'cube-array' : 'cube') : layerCount ? '2d-array' : '2d',
    mipmaps,
    format: format as GPUTextureFormat,
    ...(block[3] ? { feature: block[3] } : {}),
    target: 'ktx2',
    transcoded: 'native',
    srgb: format.endsWith('-srgb'),
    hasAlpha: !rgb && /^(rgba|bgra|rgb10a2|bc[1237]|etc2-rgba|etc2-rgb8a1|astc)/.test(format),
  };
}

/**
 * Reads cube maps, cube arrays and 2D arrays from KTX2 files, compressed or not. Basis Universal files transcode in the
 * decoder workers to the format the device has (BC7, ASTC 4x4, ETC2, RGBA8); files that store a GPU format are read
 * directly. Construction is free and SSR-safe.
 *
 * @example
 * const decoder = new KTX2LayerDecoder({device});
 * const sky = await decoder.createTexture(bytes); // a cube file: 6 layers, every mip
 * const view = sky.createView({dimension: 'cube'});
 */
export class KTX2LayerDecoder extends KTX2Decoder {
  /**
   * Decodes a KTX2 file to a {@link TextureFile}: each mip level holds every layer back to back in WebGPU order, ready
   * for {@link uploadTexture}. A plain 2D file works too and comes back with one layer.
   *
   * @throws TypeError `KTX2: invalid file (...)` on a damaged header or level index.
   * @throws MargoError `failed` when the file cannot be transcoded or holds a layout WebGPU cannot sample.
   */
  async decode(data: ArrayBuffer | ArrayBufferView, options: KTX2DecodeOptions = {}): Promise<TextureFile> {
    const bytes =
      data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    if (readKTX2Index(bytes).vkFormat) return parseKTX2(bytes, options);
    return this.job<TextureFile>('ktx2-layers', this.target, data, options);
  }

  /** Uploads a {@link KTX2LayerDecoder.decode} result to `device`, as {@link uploadTexture} does, for any device. */
  upload(device: GPUDevice, file: TextureFile, options?: UploadTextureOptions): GPUTexture {
    return uploadTexture(device, file, options);
  }

  /** Decodes and uploads to a GPUTexture on the decoder's device; see {@link uploadTexture}. */
  override async createTexture(
    data: ArrayBuffer | ArrayBufferView,
    options: KTX2DecodeOptions & UploadTextureOptions = {},
  ): Promise<GPUTexture> {
    if (!this.device)
      throw new TypeError('KTX2LayerDecoder.createTexture needs a device; pass one in KTX2Options.device');
    const file = await this.decode(data, options);
    options.signal?.throwIfAborted();
    return uploadTexture(this.device, file, options);
  }
}
