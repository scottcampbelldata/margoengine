import { decodeFailed, deviceUnsupported } from './errors.js';
import type { AVIFImage } from './avif.js';

export interface AVIFModule {
  memory: WebAssembly.Memory;
  avif_alloc(length: number): number;
  avif_free(pointer: number, length: number): void;
  avif_run(pointer: number, length: number, pixels: number, memory: number): number;
}
export function decodeAVIFModule(
  module: AVIFModule,
  bytes: Uint8Array,
  format: 'rgba8' | 'rgba16',
  maxPixels: number,
  maxMemory: number,
): AVIFImage {
  const pointer = module.avif_alloc(bytes.length);
  if (!pointer) throw decodeFailed('AVIF input allocation failed; reduce the image size');
  let output = 0,
    length = 0;
  try {
    new Uint8Array(module.memory.buffer, pointer, bytes.length).set(bytes);
    output = module.avif_run(pointer, bytes.length, maxPixels, maxMemory);
    const view = new DataView(module.memory.buffer);
    length = view.getUint32(output, true);
    const error = view.getUint32(output + 4, true);
    if (error === 4)
      throw deviceUnsupported(
        'AVIF contains an unsupported item or AV1 coding tool; use an independently coded still image',
      );
    if (error)
      throw decodeFailed(
        error === 3
          ? 'AVIF exceeds maxPixels or maxMemory; increase the configured budget or reduce the image'
          : 'AVIF is malformed or truncated; re-encode the source image',
      );
    const get = (index: number): number => view.getUint32(output + 8 + index * 4, true);
    const width = get(0),
      height = get(1),
      bitDepth = get(2) as AVIFImage['bitDepth'];
    const count = width * height * 4,
      iccLength = get(7),
      flags = get(8);
    if (!width || !height || width * height > maxPixels || length !== 48 + count * 2 + iccLength)
      throw decodeFailed('AVIF worker returned an invalid result layout');
    const samples = new Uint16Array(module.memory.buffer, output + 48, count);
    const data = format === 'rgba16' ? samples.slice() : Uint8Array.from(samples, (value) => Math.round(value / 257));
    return {
      width,
      height,
      data,
      bitDepth,
      color: {
        primaries: get(3),
        transfer: get(4),
        matrix: get(5),
        fullRange: !!get(6),
        monochrome: !!(flags & 1),
        subsamplingX: !!(flags & 2),
        subsamplingY: !!(flags & 4),
        chromaPosition: flags >> 3,
        icc: new Uint8Array(module.memory.buffer, output + 48 + count * 2, iccLength).slice(),
      },
    };
  } finally {
    module.avif_free(pointer, bytes.length);
    if (output) module.avif_free(output, length);
  }
}
