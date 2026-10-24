// The shape the DDS and KTX readers (`@margoengine/decoders/dds`, `/ktx`) return, and its GPU upload. Each mip level
// holds every layer back to back, so one writeTexture per level uploads a whole cube map or array.
import { deviceUnsupported } from './errors.js';

declare const GPUTextureUsage: { TEXTURE_BINDING: number; COPY_DST: number };

/**
 * One mip level of a {@link TextureFile}: every layer back to back (cube faces in WebGPU layer order +X, -X, +Y, -Y,
 * +Z, -Z; a cube array repeats that per cube), each layer's rows (or rows of 4x4 blocks) packed tight, top row first
 * as stored in the file.
 */
export interface TextureFileLevel {
  data: Uint8Array;
  width: number;
  height: number;
  byteLength: number;
}

/**
 * A texture read from a DDS or KTX file in a WebGPU format, for {@link uploadTexture}. A single-layer 2D result in
 * `rgba8unorm`, `bc7-rgba-unorm`, `astc-4x4-unorm` or `etc2-rgba8unorm` (with or without `-srgb`) is also a
 * `@margoengine/materials` `TranscodedTexture`, so `new Texture(file)` takes it as it takes `KTX2Decoder.transcode`
 * output.
 */
export interface TextureFile {
  /** Level 0 size in texels. */
  width: number;
  height: number;
  /** Array layers, counting each cube face: 1 for a 2D texture, 6 for a cube, 6 per cube for a cube array. */
  layers: number;
  /** The view dimension the layers make. */
  dimension: '2d' | '2d-array' | 'cube' | 'cube-array';
  /** Level 0 first; at least one. */
  mipmaps: TextureFileLevel[];
  format: GPUTextureFormat;
  /** The device feature `format` needs (`texture-compression-bc`, `-etc2` or `-astc`), or undefined for none. */
  feature?: GPUFeatureName;
  /** The file type read. */
  target: 'dds' | 'ktx';
  srgb: boolean;
  hasAlpha: boolean;
}

/** Options for {@link uploadTexture}. */
export interface UploadTextureOptions {
  label?: string;
  /** Default: TEXTURE_BINDING | COPY_DST. */
  usage?: number;
}

const TEXEL: Record<string, number> = {
  'r8unorm': 1,
  'r8snorm': 1,
  'rg8unorm': 2,
  'rg8snorm': 2,
  'rgba8unorm': 4,
  'rgba8unorm-srgb': 4,
  'rgba8snorm': 4,
  'r16float': 2,
  'rg16float': 4,
  'rgba16float': 8,
  'r32float': 4,
  'rg32float': 8,
  'rgba32float': 16,
  'rgb10a2unorm': 4,
  'rg11b10ufloat': 4,
  'rgb9e5ufloat': 4,
};

/** Block width, block height, bytes per block and needed device feature of `format`, or undefined if unknown. */
export function formatBlock(format: string): [number, number, number, GPUFeatureName?] | undefined {
  if (TEXEL[format]) return [1, 1, TEXEL[format]];
  if (/^bc[1-7]h?-/.test(format)) return [4, 4, /^bc[14]-/.test(format) ? 8 : 16, 'texture-compression-bc'];
  if (/^(etc2|eac)-/.test(format))
    return [4, 4, /^(etc2-rgb8|eac-r11)/.test(format) ? 8 : 16, 'texture-compression-etc2'];
  const astc = /^astc-(\d+)x(\d+)-/.exec(format);
  if (astc) return [+astc[1], +astc[2], 16, 'texture-compression-astc'];
  return undefined;
}

/** Bytes of one layer of a `width` x `height` level of `block`, and its bytes per row of blocks. */
export function levelBytes(
  block: readonly [number, number, number, unknown?],
  width: number,
  height: number,
): [number, number] {
  const row = Math.ceil(width / block[0]) * block[2];
  return [row * Math.ceil(height / block[1]), row];
}

/** Gathers `layers[layer][level]` (the file's layer-major order) into one level-major {@link TextureFileLevel} list. */
export function levelMajor(layers: Uint8Array[][], width: number, height: number): TextureFileLevel[] {
  return layers[0].map((_, level) => {
    const size = layers[0][level].length,
      data = new Uint8Array(size * layers.length);
    layers.forEach((faces, layer) => data.set(faces[level], layer * size));
    return {
      data,
      width: Math.max(1, width >> level),
      height: Math.max(1, height >> level),
      byteLength: data.byteLength,
    };
  });
}

/**
 * Allocates a GPU texture for `file` (every layer and mip level) and writes it.
 *
 * @throws TypeError when `file.format` is not one the DDS and KTX readers produce.
 * @throws MargoError `unsupported` when the device lacks `file.feature`.
 * @throws RangeError when a block-compressed level 0 is not a whole number of blocks, or the size exceeds the device.
 */
export function uploadTexture(device: GPUDevice, file: TextureFile, options: UploadTextureOptions = {}): GPUTexture {
  const block = formatBlock(file.format);
  if (!block)
    throw new TypeError(`Texture format ${String(file.format)} is unknown; pass a parseDDS or parseKTX result`);
  const [bw, bh, , feature] = block;
  if (feature && !device.features.has(feature))
    throw deviceUnsupported(
      `Texture format ${file.format} needs the device feature ${feature}; request it with adapter.requestDevice({requiredFeatures: ['${feature}']}) where adapter.features has it, or convert the file to an uncompressed format`,
    );
  if (file.width % bw || file.height % bh)
    throw new RangeError(
      `Texture ${file.width}x${file.height} is not a whole number of ${bw}x${bh} ${file.format} blocks; resize the source to a multiple of ${bw}x${bh}`,
    );
  if (Math.max(file.width, file.height) > device.limits.maxTextureDimension2D)
    throw new RangeError(
      `Texture ${file.width}x${file.height} exceeds the device's maxTextureDimension2D; use a smaller file`,
    );
  const texture = device.createTexture({
    label: options.label,
    size: [file.width, file.height, file.layers],
    mipLevelCount: file.mipmaps.length,
    format: file.format,
    usage: options.usage ?? GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
  });
  try {
    for (const [level, mip] of file.mipmaps.entries()) {
      const rows = Math.ceil(mip.height / bh);
      device.queue.writeTexture(
        { texture, mipLevel: level },
        mip.data as Uint8Array<ArrayBuffer>,
        { bytesPerRow: levelBytes(block, mip.width, mip.height)[1], rowsPerImage: rows },
        [Math.ceil(mip.width / bw) * bw, rows * bh, file.layers],
      );
    }
  } catch (error) {
    texture.destroy();
    throw error;
  }
  return texture;
}
