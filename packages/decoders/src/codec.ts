import { wasmError } from '../../shared/errors.js';
// Worker-side decode functions. Kept free of worker globals so unit tests can drive them with real or mock modules.
import { decodeFailed, guard, release, trapped } from './errors.js';

export { isDecoderCrash } from './errors.js';
export { decodeDraco, decodeDracoPoints, dracoPointsTransferables, dracoTransferables } from './draco-codec.js';
import { hdrFormats, transcodeFormats, type HDRTranscodeTarget } from './formats.js';
import { readKTX2Index, type KTX2Index } from './ktx2-file.js';
import { formatBlock, type TextureFile } from './texture-file.js';
import type { KTX2Mip, TranscodeTarget, TranscodedKTX2Result } from './protocol.js';
import type { BasisFile, BasisModule, DracoModule } from './vendor-codecs.js';

export type ScriptLoader = (url: string) => Promise<void>;

/** Run a classic Emscripten script in module-worker global scope. Indirect eval keeps its top-level `var` global. */
export const evaluateScript: ScriptLoader = async (url) => {
  const response = await fetch(url);
  if (!response.ok) throw decodeFailed(`Could not load ${url} (${response.status})`);
  (0, eval)(await response.text());
};

async function binary(url: string): Promise<ArrayBuffer> {
  const response = await fetch(url);
  if (!response.ok) throw decodeFailed(`Could not load ${url} (${response.status})`);
  return response.arrayBuffer();
}

/** Emscripten module objects are thenable, so they travel inside a box to keep promise resolution finite. */
export interface ModuleBox<T> {
  module: T;
}

export async function initDraco(
  wrapperURL: string,
  wasmURL: string,
  load: ScriptLoader = evaluateScript,
): Promise<ModuleBox<DracoModule>> {
  const [, wasmBinary] = await Promise.all([load(wrapperURL), binary(wasmURL)]);
  const factory = (
    globalThis as typeof globalThis & {
      DracoDecoderModule?: (options: { wasmBinary: ArrayBuffer }) => PromiseLike<DracoModule>;
    }
  ).DracoDecoderModule;
  if (typeof factory !== 'function')
    throw decodeFailed(
      'Draco wrapper did not define DracoDecoderModule; load the unmodified draco_decoder.js from the package assets',
    );
  return new Promise<ModuleBox<DracoModule>>((resolve, reject) => {
    factory({ wasmBinary }).then((module) => resolve({ module }), reject);
  }).catch((error) => {
    throw wasmError(error);
  });
}

export async function initBasis(
  transcoderURL: string,
  wasmURL: string,
  load: ScriptLoader = evaluateScript,
): Promise<ModuleBox<BasisModule>> {
  const [, wasmBinary] = await Promise.all([load(transcoderURL), binary(wasmURL)]);
  const factory = (globalThis as typeof globalThis & { BASIS?: BasisFactory }).BASIS;
  if (typeof factory !== 'function')
    throw decodeFailed(
      'Basis transcoder did not define BASIS; load the unmodified basis_transcoder.js from the package assets',
    );
  return startBasis(factory, wasmBinary);
}

/** The factory `basis_transcoder.js` defines. */
export type BasisFactory = (options: { wasmBinary: ArrayBuffer }) => PromiseLike<BasisModule>;

/** Starts a loaded transcoder: Node requires the wrapper rather than evaluating it, so it joins here. */
export async function startBasis(factory: BasisFactory, wasmBinary: ArrayBuffer): Promise<ModuleBox<BasisModule>> {
  const module = await new Promise<{ m: BasisModule }>((resolve, reject) => {
    factory({ wasmBinary }).then((m) => resolve({ m }), reject);
  })
    .then((box) => box.m)
    .catch((error) => {
      throw wasmError(error);
    });
  module.initializeBasis();
  if (typeof module.KTX2File !== 'function')
    throw decodeFailed(
      'Basis transcoder lacks KTX2 support; use the basis_transcoder build that ships with this release',
    );
  return { module };
}

const transferSRGB = 2;

// Opens a checked KTX2 file for `use`, turning a Wasm trap into the decoder's own error and always freeing the handle.
function withKTX2<T>(basis: BasisModule, bytes: Uint8Array, use: (file: BasisFile) => T): T {
  const file = guard('KTX2', () => new basis.KTX2File(bytes));
  let failure: unknown;
  try {
    if (!file.isValid()) throw decodeFailed('KTX2: invalid or unsupported file; pass an unmodified .ktx2 file');
    return use(file);
  } catch (error) {
    throw (failure = trapped('KTX2', error));
  } finally {
    release(failure, () => {
      file.close();
      file.delete();
    });
  }
}

/**
 * Transcode every mip level of a 2D KTX2 file into one buffer. The Basis file handle is closed and deleted on every path.
 * The header and level index are checked first (readKTX2Index); a Wasm trap on corrupt data throws `Error('KTX2: ...')`
 * with the trap as its cause (isDecoderCrash).
 */
export function transcodeKTX2(basis: BasisModule, bytes: Uint8Array, target: TranscodeTarget): TranscodedKTX2Result {
  if (!transcodeFormats[target])
    throw new TypeError(`Unknown transcode target ${target}; use one of the targets listed in KTX2Options.target`);
  readKTX2Index(bytes);
  return withKTX2(basis, bytes, (file) => {
    if (file.isHDR?.())
      throw decodeFailed(
        'KTX2: HDR textures are not supported here; use KTX2HDRDecoder from @margoengine/decoders/ktx2-hdr',
      );
    if (file.getFaces() > 1 || file.getLayers() > 1)
      throw decodeFailed(
        'KTX2: cube maps and texture arrays are not supported here; use KTX2LayerDecoder from @margoengine/decoders/ktx2-layers',
      );
    const width: number = file.getWidth(),
      height: number = file.getHeight(),
      levels: number = file.getLevels();
    if (!width || !height || !levels || width > 16384 || height > 16384)
      throw new RangeError('KTX2: invalid dimensions; re-encode the texture with non-zero dimensions');
    const chosen: TranscodeTarget = target !== 'rgba8' && (width % 4 || height % 4) ? 'rgba8' : target,
      format = transcodeFormats[chosen];
    if (!file.startTranscoding())
      throw decodeFailed('KTX2: startTranscoding failed; re-encode the file with Basis Universal');
    const sizes: number[] = [];
    for (let level = 0; level < levels; level++)
      sizes.push(file.getImageTranscodedSizeInBytes(level, 0, 0, format.basis));
    const out = new Uint8Array(sizes.reduce((a, b) => a + b, 0)),
      mipmaps: KTX2Mip[] = [];
    for (let level = 0, offset = 0; level < levels; offset += sizes[level++]) {
      const data = out.subarray(offset, offset + sizes[level]);
      if (!file.transcodeImage(data, level, 0, 0, format.basis, 0, -1, -1))
        throw decodeFailed(`KTX2: could not transcode level ${level}; re-encode the file, the level data is damaged`);
      mipmaps.push({
        data,
        width: Math.max(1, width >> level),
        height: Math.max(1, height >> level),
        byteLength: sizes[level],
      });
    }
    const srgb = file.getDFDTransferFunc?.() === transferSRGB;
    return {
      width,
      height,
      mipmaps,
      format: (format.gpu + (srgb ? '-srgb' : '')) as GPUTextureFormat,
      target: chosen,
      hasAlpha: !!file.getHasAlpha(),
      srgb,
    };
  });
}

/** What transcodeImages writes: the Basis enum, the WebGPU format and the name the result reports. */
interface ImageTarget {
  basis: number;
  gpu: string;
  name: string;
}

// Every image of every level into one buffer: a level's images back to back in WebGPU layer order (layer * faces + face),
// so one writeTexture per level uploads them.
function transcodeImages(
  file: BasisFile,
  index: KTX2Index,
  target: ImageTarget,
  srgb: boolean,
  hasAlpha: boolean,
): TextureFile {
  const { width, height, layerCount, faceCount } = index,
    arrayLayers = Math.max(1, layerCount),
    images = arrayLayers * faceCount,
    levels = index.levels.length;
  if (index.depth > 1) throw decodeFailed('KTX2: 3D textures are not supported; re-encode the file as a 2D array');
  if (!width || !height || width > 16384 || height > 16384 || images > 2048)
    throw new RangeError('KTX2: invalid dimensions; re-encode the texture with non-zero dimensions');
  if (faceCount !== 1 && faceCount !== 6) throw new RangeError(`KTX2: invalid face count ${faceCount}; use 1 or 6`);
  if (faceCount === 6 && width !== height) throw new RangeError('KTX2: cube faces are not square; re-encode the file');
  if (!file.startTranscoding())
    throw decodeFailed('KTX2: startTranscoding failed; re-encode the file with Basis Universal');
  const sizes: number[] = [];
  for (let level = 0; level < levels; level++)
    sizes.push(file.getImageTranscodedSizeInBytes(level, 0, 0, target.basis));
  const out = new Uint8Array(sizes.reduce((a, b) => a + b * images, 0)),
    mipmaps: TextureFile['mipmaps'] = [];
  for (let level = 0, offset = 0; level < levels; level++) {
    const start = offset;
    for (let layer = 0; layer < arrayLayers; layer++)
      for (let face = 0; face < faceCount; face++, offset += sizes[level]) {
        const image = out.subarray(offset, offset + sizes[level]);
        if (!file.transcodeImage(image, level, layer, face, target.basis, 0, -1, -1))
          throw decodeFailed(
            `KTX2: could not transcode level ${level} layer ${layer} face ${face}; re-encode the file, the data is damaged`,
          );
      }
    mipmaps.push({
      data: out.subarray(start, offset),
      width: Math.max(1, width >> level),
      height: Math.max(1, height >> level),
      byteLength: offset - start,
    });
  }
  const feature = formatBlock(target.gpu)?.[3];
  return {
    width,
    height,
    layers: images,
    dimension: faceCount === 6 ? (layerCount ? 'cube-array' : 'cube') : layerCount ? '2d-array' : '2d',
    mipmaps,
    format: target.gpu as GPUTextureFormat,
    ...(feature ? { feature } : {}),
    target: 'ktx2',
    transcoded: target.name,
    srgb,
    hasAlpha,
  };
}

/**
 * Transcode every level, array layer and cube face of an 8-bit KTX2 file. A 2D file comes back as a one-layer texture.
 * `exact` keeps `target` whatever the size: a one-level file of a stream is part of a larger texture.
 * Checks, handle release and trap handling as in {@link transcodeKTX2}.
 */
export function transcodeKTX2Layers(
  basis: BasisModule,
  bytes: Uint8Array,
  target: TranscodeTarget,
  exact = false,
): TextureFile {
  if (!transcodeFormats[target])
    throw new TypeError(`Unknown transcode target ${target}; use one of the targets listed in KTX2Options.target`);
  const index = readKTX2Index(bytes);
  return withKTX2(basis, bytes, (file) => {
    if (file.isHDR?.())
      throw decodeFailed('KTX2: HDR textures need KTX2HDRDecoder from @margoengine/decoders/ktx2-hdr');
    const chosen: TranscodeTarget =
        !exact && target !== 'rgba8' && (index.width % 4 || index.height % 4) ? 'rgba8' : target,
      format = transcodeFormats[chosen],
      srgb = file.getDFDTransferFunc?.() === transferSRGB;
    return transcodeImages(
      file,
      index,
      { basis: format.basis, gpu: format.gpu + (srgb ? '-srgb' : ''), name: chosen },
      srgb,
      !!file.getHasAlpha(),
    );
  });
}

/**
 * Transcode every level, array layer and cube face of a UASTC HDR file. BC6H falls back to half float when level 0 is
 * not a multiple of 4, as WebGPU needs of block formats. Checks, handle release and trap handling as in {@link transcodeKTX2}.
 */
export function transcodeKTX2HDR(
  basis: BasisModule,
  bytes: Uint8Array,
  target: HDRTranscodeTarget,
  exact = false,
): TextureFile {
  if (!hdrFormats[target])
    throw new TypeError(`Unknown HDR target ${target}; use bc6h, astc-hdr-4x4, rgba16float or rgb9e5`);
  const index = readKTX2Index(bytes);
  return withKTX2(basis, bytes, (file) => {
    if (!file.isHDR?.()) throw decodeFailed('KTX2: this file is not HDR; read it with KTX2LayerDecoder or KTX2Decoder');
    const chosen = !exact && target === 'bc6h' && (index.width % 4 || index.height % 4) ? 'rgba16float' : target,
      format = hdrFormats[chosen];
    const result = transcodeImages(file, index, { basis: format.basis, gpu: format.gpu, name: chosen }, false, false);
    // WebGPU has no ASTC HDR format, so no device feature can stand for it.
    return chosen === 'astc-hdr-4x4' ? { ...result, feature: undefined } : result;
  });
}
