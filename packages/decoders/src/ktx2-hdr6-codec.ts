import { decodeFailed } from './errors.js';
import { levelData, readKTX2Index } from './ktx2-file.js';
import type { TextureFile } from './texture-file.js';
import type { HDR6DecodeOptions, HDR6Target } from './ktx2-hdr6.js';

export interface HDR6Module {
  memory: WebAssembly.Memory;
  hdr6_alloc(length: number): number;
  hdr6_free(pointer: number, length: number): void;
  hdr6_run(
    pointer: number,
    length: number,
    width: number,
    height: number,
    intermediate: number,
    pixels: number,
  ): number;
}

function image(
  module: HDR6Module,
  bytes: Uint8Array,
  width: number,
  height: number,
  intermediate: boolean,
  pixels: number,
): Uint8Array {
  const pointer = module.hdr6_alloc(bytes.length);
  if (!pointer) throw decodeFailed('HDR6 input exceeds the allocation limit; reduce the input size');
  let output = 0,
    length = 0;
  try {
    new Uint8Array(module.memory.buffer, pointer, bytes.length).set(bytes);
    output = module.hdr6_run(pointer, bytes.length, width, height, +intermediate, pixels);
    const view = new DataView(module.memory.buffer);
    length = view.getUint32(output, true);
    if (view.getUint32(output + 4, true))
      throw decodeFailed('HDR6 stream is truncated, malformed or exceeds its limits; re-encode the file');
    return new Uint8Array(module.memory.buffer, output + 8, length - 8).slice();
  } finally {
    module.hdr6_free(pointer, bytes.length);
    if (output) module.hdr6_free(output, length);
  }
}

/** Internal clean-room KTX2 HDR6 reader. */
export async function decodeHDR6(
  module: HDR6Module,
  bytes: Uint8Array,
  target: HDR6Target,
  options: HDR6DecodeOptions = {},
): Promise<TextureFile> {
  options.signal?.throwIfAborted();
  const index = readKTX2Index(bytes);
  const { width, height, layerCount, faceCount, dfd, supercompression } = index;
  const maxPixels = options.maxPixels ?? 2 ** 26;
  if (!Number.isSafeInteger(maxPixels) || maxPixels < 1)
    throw new RangeError('maxPixels must be a positive safe integer');
  const layers = Math.max(1, layerCount) * faceCount;
  if (!width || !height || width > 32768 || height > 32768 || width * height * layers > maxPixels)
    throw new RangeError(`HDR6 dimensions exceed maxPixels ${maxPixels}; raise maxPixels or reduce the texture`);
  if (index.depth > 1 || ![1, 6].includes(faceCount) || (faceCount === 6 && width !== height))
    throw decodeFailed('HDR6 needs a 2D texture, array or square cube with one or six faces');
  if (dfd.length < 28) throw decodeFailed('HDR6 data format descriptor is missing or truncated');
  const model = bytes[dfd.offset + 12],
    transfer = bytes[dfd.offset + 14];
  const intermediate = index.vkFormat === 0 && model === 168 && supercompression === 4;
  if (!intermediate && !(index.vkFormat === 1000066004 && model === 162 && [0, 2].includes(supercompression)))
    throw decodeFailed('KTX2 is not ASTC HDR 6x6 or UASTC HDR 6x6i; use the matching decoder entry');
  if (transfer !== 1 || bytes[dfd.offset + 16] !== 5 || bytes[dfd.offset + 17] !== 5)
    throw decodeFailed('HDR6 needs a linear 6x6 data format descriptor');
  if (!['rgba16float', 'rgb9e5', 'astc-hdr-6x6'].includes(target))
    throw new TypeError(`Unknown HDR6 target ${target}; use rgba16float, rgb9e5 or astc-hdr-6x6`);
  const mipmaps: TextureFile['mipmaps'] = [];
  for (let level = 0; level < index.levels.length; level++) {
    options.signal?.throwIfAborted();
    const w = Math.max(1, width >> level),
      h = Math.max(1, height >> level);
    let source: Uint8Array;
    let images: Uint8Array[];
    if (intermediate) {
      const { offset, length } = index.levels[level];
      source = bytes.subarray(offset, offset + length);
      // Scheme 4 keeps a 12-byte offset/length/profile entry per image in supercompression global data.
      const tableBytes = layers * index.levels.length * 12;
      if (index.globalData.length !== tableBytes) throw decodeFailed('HDR6 seek table has the wrong length');
      const view = new DataView(bytes.buffer, bytes.byteOffset + index.globalData.offset, tableBytes);
      images = Array.from({ length: layers }, (_, i) => {
        const entry = (level * layers + i) * 12;
        const at = view.getUint32(entry, true),
          size = view.getUint32(entry + 4, true);
        if (!size || at > source.length || size > source.length - at)
          throw decodeFailed('HDR6 seek table exceeds its mip level');
        return source.subarray(at, at + size);
      });
    } else {
      const size = Math.ceil(w / 6) * Math.ceil(h / 6) * 16;
      if (index.levels[level].uncompressedLength !== size * layers)
        throw decodeFailed('ASTC HDR6 declared level size does not match its dimensions');
      source = await levelData(bytes, index, level, options.signal);
      if (source.length !== size * layers) throw decodeFailed('ASTC HDR6 level size does not match its dimensions');
      images = Array.from({ length: layers }, (_, i) => source.subarray(i * size, (i + 1) * size));
    }
    const results = images.map((bytes) => {
      const decoded = image(
        module,
        bytes,
        w,
        h,
        intermediate,
        target === 'astc-hdr-6x6' ? 0 : target === 'rgb9e5' ? 2 : 1,
      );
      return decoded;
    });
    const data = new Uint8Array(results.reduce((n, image) => n + image.length, 0));
    let at = 0;
    for (const result of results) {
      data.set(result, at);
      at += result.length;
    }
    mipmaps.push({ data, width: w, height: h, byteLength: data.length });
  }
  return {
    width,
    height,
    layers,
    dimension: faceCount === 6 ? (layerCount ? 'cube-array' : 'cube') : layerCount ? '2d-array' : '2d',
    format: (target === 'rgb9e5'
      ? 'rgb9e5ufloat'
      : target === 'astc-hdr-6x6'
        ? 'astc-6x6-hdr'
        : 'rgba16float') as GPUTextureFormat,
    mipmaps,
    srgb: false,
    hasAlpha: !intermediate,
    target: 'ktx2',
    transcoded: target,
  };
}
