// One Basis Universal encode, run by the encoder worker in a browser and in process in Node: image bytes or pixels in,
// a .ktx2 file out. Reading the PNG or JPEG happens here too, so a page never decodes a large image on its own frame.
import { decodePNG } from '@margoengine/decoders/png';
import { MargoError } from '@margoengine/math/errors';
import { decodeJPEG } from './jpeg-read.js';

/** RGBA8 rows, top row first, `width * height * 4` bytes. */
export interface RGBAImage {
  width: number;
  height: number;
  data: Uint8Array | Uint8ClampedArray;
}

/** The two texture formats of a Basis Universal KTX2 file. */
export type KTX2Mode = 'etc1s' | 'uastc';

/** What the encoder needs for one image. `source` is a PNG or JPEG file, or pixels. */
export interface BasisJob {
  source: Uint8Array | RGBAImage;
  mode: KTX2Mode;
  srgb: boolean;
  normalMap: boolean;
  mipmaps: boolean;
  quality: number;
  effort: number;
  uastcLevel: number;
  /** Rate-distortion pass of UASTC, from 0, off, up: higher is smaller on the wire and further from the source. */
  uastcRDO: number;
  /** Grows the image to multiples of 4, which KHR_texture_basisu requires of a glTF texture. */
  wholeBlocks: boolean;
}

/** One encoded file and the size it holds. */
export interface BasisResult {
  data: Uint8Array;
  width: number;
  height: number;
}

interface BasisEncoderInstance {
  setCreateKTX2File(on: boolean): void;
  setKTX2UASTCSupercompression(on: boolean): void;
  setKTX2SRGBTransferFunc(on: boolean): void;
  setSliceSourceImage(slice: number, rgba: Uint8Array, width: number, height: number, isPNG: boolean): void;
  setPerceptual(on: boolean): void;
  setMipSRGB(on: boolean): void;
  setMipGen(on: boolean): void;
  setMipRenormalize(on: boolean): void;
  setQualityLevel(level: number): void;
  setCompressionLevel(level: number): void;
  setUASTC(on: boolean): void;
  setPackUASTCFlags(flags: number): void;
  setRDOUASTC(on: boolean): void;
  setRDOUASTCQualityScalar(quality: number): void;
  setNormalMap(): void;
  encode(out: Uint8Array): number;
  delete(): void;
}

/** The part of the Basis encoder module this package calls. */
export interface BasisEncoderModule {
  initializeBasis(): void;
  BasisEncoder: new () => BasisEncoderInstance;
}

const started = new WeakSet<BasisEncoderModule>();

/** Reads a PNG or JPEG file, picked by signature. */
function readImage(bytes: Uint8Array): RGBAImage {
  if (bytes[0] === 0x89 && bytes[1] === 0x50) return decodePNG(bytes);
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return decodeJPEG(bytes);
  throw new TypeError('KTX2 encoding reads PNG and JPEG files; pass pixels for anything else');
}

/** The image at the next multiples of 4, filtered linearly, with each new pixel's centre placed in the old image. */
function grownToBlocks(image: RGBAImage): RGBAImage {
  const { width, height, data } = image,
    W = (width + 3) & ~3,
    H = (height + 3) & ~3;
  if (W === width && H === height) return image;
  const out = new Uint8Array(W * H * 4);
  for (let y = 0; y < H; y++) {
    const v = Math.min(Math.max(((y + 0.5) * height) / H - 0.5, 0), height - 1),
      y0 = v | 0,
      y1 = Math.min(y0 + 1, height - 1),
      fy = v - y0;
    for (let x = 0; x < W; x++) {
      const u = Math.min(Math.max(((x + 0.5) * width) / W - 0.5, 0), width - 1),
        x0 = u | 0,
        x1 = Math.min(x0 + 1, width - 1),
        fx = u - x0;
      for (let c = 0; c < 4; c++) {
        const top = data[(y0 * width + x0) * 4 + c] * (1 - fx) + data[(y0 * width + x1) * 4 + c] * fx,
          bottom = data[(y1 * width + x0) * 4 + c] * (1 - fx) + data[(y1 * width + x1) * 4 + c] * fx;
        out[(y * W + x) * 4 + c] = top * (1 - fy) + bottom * fy + 0.5;
      }
    }
  }
  return { width: W, height: H, data: out };
}

/** Shared image preparation for the bundled encoder and custom encoderPath. */
export function imageForBasisJob(job: BasisJob): RGBAImage {
  const image = job.source instanceof Uint8Array ? readImage(job.source) : job.source;
  return job.wholeBlocks ? grownToBlocks(image) : image;
}

/**
 * The encoder's data format descriptor leaves two things to the file's use. `bytesPlane` holds the size of a block, one
 * entry for each ETC1S slice (colour, and alpha when there is any) and one for UASTC, as KTX-Software's validator
 * requires; and a file of non-colour data has no colour primaries.
 */
function finishDescriptor(file: Uint8Array, mode: KTX2Mode, srgb: boolean): void {
  const view = new DataView(file.buffer, file.byteOffset, file.byteLength),
    descriptor = view.getUint32(48, true),
    samples = (view.getUint16(descriptor + 10, true) - 24) / 16;
  if (mode === 'uastc') file[descriptor + 20] = 16;
  else file.fill(8, descriptor + 20, descriptor + 20 + samples);
  if (!srgb) file[descriptor + 13] = 0;
}

/** Encodes one image to a .ktx2 file. */
export function encodeBasis(module: BasisEncoderModule, job: BasisJob): BasisResult {
  if (!started.has(module)) {
    module.initializeBasis();
    started.add(module);
  }
  const { width, height, data } = imageForBasisJob(job),
    pixels = data instanceof Uint8Array ? data : new Uint8Array(data.buffer, data.byteOffset, data.byteLength),
    encoder = new module.BasisEncoder();
  try {
    encoder.setCreateKTX2File(true);
    encoder.setKTX2UASTCSupercompression(true);
    encoder.setKTX2SRGBTransferFunc(job.srgb);
    encoder.setSliceSourceImage(0, pixels, width, height, false);
    encoder.setPerceptual(job.srgb);
    encoder.setMipSRGB(job.srgb);
    encoder.setQualityLevel(job.quality);
    encoder.setCompressionLevel(job.effort);
    encoder.setUASTC(job.mode === 'uastc');
    encoder.setPackUASTCFlags(job.uastcLevel);
    encoder.setMipGen(job.mipmaps);
    if (job.mode === 'uastc' && job.uastcRDO > 0) {
      encoder.setRDOUASTC(true);
      encoder.setRDOUASTCQualityScalar(job.uastcRDO);
    }
    if (job.normalMap) {
      encoder.setNormalMap();
      encoder.setMipRenormalize(true);
    }
    // UASTC holds a byte a pixel and a mip chain a third more; ETC1S less. Twice the pixels leaves room for the headers.
    const out = new Uint8Array(width * height * 2 + 65536),
      size = encoder.encode(out);
    if (!size) throw new MargoError('failed', `Basis could not encode a ${width} x ${height} image; check the pixels`);
    const file = out.slice(0, size);
    finishDescriptor(file, job.mode, job.srgb);
    return { data: file, width, height };
  } finally {
    encoder.delete();
  }
}
