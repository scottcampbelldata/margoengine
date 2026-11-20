// One Basis Universal encode, run by the encoder worker in a browser and in process in Node: image bytes or pixels in,
// a .ktx2 file out. Reading the PNG or JPEG happens here too (basis-image.ts), so a page never decodes a large image on
// its own frame.
import { MargoError } from '@margoengine/math/errors';
import { imageForBasisJob } from './basis-image.js';

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

/**
 * The most bytes the file can take. Both formats code each 4x4 block on every mip level, down to 1 x 1, and an edge
 * block is whole however few texels it holds: UASTC stores 16 bytes a block, which Zstandard can grow by well under a
 * quarter; ETC1S codes a block in less, with codebooks of at most one entry a block. 64 KiB covers the headers. A
 * pixel count does not bound it: a 1-texel-tall strip has a quarter of a block a texel, so 4 bytes a texel.
 */
function fileBound(width: number, height: number, mipmaps: boolean): number {
  let blocks = 0;
  for (let w = width, h = height; ; w = Math.max(1, w >> 1), h = Math.max(1, h >> 1)) {
    blocks += Math.ceil(w / 4) * Math.ceil(h / 4);
    if (!mipmaps || (w === 1 && h === 1)) break;
  }
  return blocks * 20 + 65536;
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
    const out = new Uint8Array(fileBound(width, height, job.mipmaps)),
      size = encoder.encode(out);
    if (!size) throw new MargoError('failed', `Basis could not encode a ${width} x ${height} image; check the pixels`);
    const file = out.slice(0, size);
    finishDescriptor(file, job.mode, job.srgb);
    return { data: file, width, height };
  } finally {
    encoder.delete();
  }
}
