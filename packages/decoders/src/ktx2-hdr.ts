// HDR KTX2 (`@margoengine/decoders/ktx2-hdr`): UASTC HDR 4x4 files, 2D, array or cube, transcoded by the same Basis worker
// as the 8-bit files to BC6H, half float or shared-exponent texels, or to ASTC HDR blocks for tools that can use them.
import { deviceUnsupported } from './errors.js';
import { hdrFormats, type HDRTranscodeTarget } from './formats.js';
import { KTX2Decoder, type KTX2DecodeOptions, type KTX2Options } from './ktx2.js';
import type { KTX2LayerDecodeOptions } from './ktx2-layers.js';
import { uploadTexture, type TextureFile, type UploadTextureOptions } from './texture-file.js';

export type { HDRTranscodeTarget } from './formats.js';
export type { TextureFile, TextureFileLevel, UploadTextureOptions } from './texture-file.js';
export { uploadTexture } from './texture-file.js';

/** Options of a {@link KTX2HDRDecoder}: those of a KTX2Decoder, with an HDR target. */
export interface KTX2HDROptions extends Omit<KTX2Options, 'target'> {
  /** Override the negotiated target. `'astc-hdr-4x4'` gives blocks for tools; WebGPU has no format to upload them to. */
  target?: HDRTranscodeTarget;
}

/** Pick the best HDR format a device has enabled: BC6H with `texture-compression-bc`, otherwise half float. */
export function getSupportedHDRFormat(device?: { features: { has(value: string): boolean } }): HDRTranscodeTarget {
  return device?.features.has('texture-compression-bc') ? 'bc6h' : 'rgba16float';
}

/**
 * Reads UASTC HDR KTX2 files, so HDR environments ship at a fraction of their EXR size. Transcodes in the decoder workers
 * to BC6H where the device has it, otherwise to half float. Construction is free and SSR-safe.
 *
 * @example
 * const decoder = new KTX2HDRDecoder({device});
 * const sky = await decoder.createTexture(bytes); // bc6h-rgb-ufloat on a desktop GPU, rgba16float elsewhere
 */
export class KTX2HDRDecoder extends KTX2Decoder {
  /** The HDR target this decoder transcodes to. */
  readonly hdrTarget: HDRTranscodeTarget;

  constructor(options: KTX2HDROptions = {}) {
    super({ ...options, target: 'rgba8' });
    this.hdrTarget = options.target ?? getSupportedHDRFormat(options.device);
    if (!hdrFormats[this.hdrTarget])
      throw new TypeError(
        `Unknown HDR target ${this.hdrTarget}; use bc6h, astc-hdr-4x4, rgba16float or rgb9e5 in KTX2HDROptions.target`,
      );
  }

  /**
   * Transcodes a UASTC HDR file to a {@link TextureFile}: every level, face and layer. `transcoded` names the target
   * used: BC6H falls back to `rgba16float` when level 0 is not a multiple of 4, which WebGPU needs of block formats.
   *
   * @throws TypeError `KTX2: invalid file (...)` on a damaged header or level index.
   * @throws MargoError `failed` for a file that is not UASTC HDR 4x4, or that cannot be transcoded.
   */
  decode(data: ArrayBuffer | ArrayBufferView, options: KTX2LayerDecodeOptions = {}): Promise<TextureFile> {
    const target = (options.exactTarget ?? this.hdrTarget) as HDRTranscodeTarget;
    return this.job<TextureFile>('ktx2-hdr', target, data, options, options.exactTarget !== undefined);
  }

  /**
   * Transcodes and uploads to a GPUTexture on the decoder's device; see {@link uploadTexture}.
   *
   * @throws MargoError `unsupported` for the `astc-hdr-4x4` target, which has no WebGPU format.
   */
  override async createTexture(
    data: ArrayBuffer | ArrayBufferView,
    options: KTX2DecodeOptions & UploadTextureOptions = {},
  ): Promise<GPUTexture> {
    if (!this.device) throw new TypeError('KTX2HDRDecoder.createTexture needs a device; pass one in KTX2HDROptions.device');
    if (this.hdrTarget === 'astc-hdr-4x4')
      throw deviceUnsupported('WebGPU has no ASTC HDR texture format; use the bc6h or rgba16float target to upload');
    const file = await this.decode(data, options);
    options.signal?.throwIfAborted();
    return uploadTexture(this.device, file, options);
  }
}

const half = new Float32Array(1 << 16);
function halfTable(): Float32Array {
  if (half[0x3c00]) return half;
  for (let bits = 0; bits < 1 << 16; bits++) {
    const sign = bits & 0x8000 ? -1 : 1,
      exponent = (bits >> 10) & 31,
      fraction = bits & 1023;
    half[bits] =
      sign *
      (exponent === 31
        ? fraction
          ? Number.NaN
          : Number.POSITIVE_INFINITY
        : exponent
          ? 2 ** (exponent - 15) * (1 + fraction / 1024)
          : 2 ** -14 * (fraction / 1024));
  }
  return half;
}

/** Level 0 of a half-float result as linear floats: the shape `Environment.create` takes for an equirect or a cube. */
export type HDREnvironmentImage =
  | { width: number; height: number; data: Float32Array }
  | { size: number; faces: Float32Array[] };

/**
 * Turns level 0 of a `rgba16float` {@link TextureFile} into what `@margoengine/environment` takes: an equirect image, or
 * six cube faces. Decode with the `rgba16float` target first: the environment filters floats on the GPU.
 *
 * @throws TypeError when the file is not `rgba16float`, or is an array.
 * @example
 * const decoder = new KTX2HDRDecoder({target: 'rgba16float'});
 * const environment = await Environment.create(engine, toEnvironmentImage(await decoder.decode(bytes)));
 */
export function toEnvironmentImage(file: TextureFile): HDREnvironmentImage {
  if (file.format !== 'rgba16float')
    throw new TypeError(`toEnvironmentImage needs rgba16float, not ${file.format}; decode with target: 'rgba16float'`);
  if (file.dimension !== '2d' && file.dimension !== 'cube')
    throw new TypeError(`toEnvironmentImage takes a 2D or cube file, not ${file.dimension}; re-encode each array layer as its own file`);
  const { data } = file.mipmaps[0],
    table = halfTable(),
    bits = new Uint16Array(data.slice().buffer),
    floats = Float32Array.from(bits, (value) => table[value]);
  if (file.dimension === '2d') return { width: file.width, height: file.height, data: floats };
  const size = file.width * file.width * 4;
  return { size: file.width, faces: Array.from({ length: 6 }, (_, i) => floats.slice(i * size, (i + 1) * size)) };
}
