// The host side of the Wasm interface in jpeg2000-kernel/src/wasm.rs: six little-endian words (length, error code, width,
// height, depth, truncated flag), then the RGBA samples.
import { fault, rangeError, typeError } from '../../shared/errors.js';
import { guard } from './errors.js';
import type { JPEG2000DecodeOptions, JPEG2000Image } from './jpeg2000.js';

export interface JPEG2000Module {
  memory: WebAssembly.Memory;
  jpeg2000_alloc(length: number): number;
  jpeg2000_free(pointer: number, length: number): void;
  jpeg2000_decode(
    pointer: number,
    length: number,
    reduce: number,
    layers: number,
    depth: number,
    maxPixels: number,
  ): number;
}

/** The decode options, checked, with their defaults. */
export interface JPEG2000Settings {
  reduce: number;
  layers: number;
  depth: 8 | 16;
  maxPixels: number;
}

const HEADER = 24;
const MAX_INPUT = 2 ** 30;

export function jpeg2000Settings(options: Omit<JPEG2000DecodeOptions, 'signal' | 'transfer'>): JPEG2000Settings {
  const { reduce = 0, layers = 0, depth = 8, maxPixels = 2 ** 26 } = options;
  if (!Number.isInteger(reduce) || reduce < 0 || reduce > 32)
    throw rangeError('JPEG 2000 reduce must be an integer from 0 to 32', 'limits');
  if (!Number.isInteger(layers) || layers < 0 || layers > 65535)
    throw rangeError('JPEG 2000 layers must be an integer from 0 (every layer) to 65535', 'limits');
  if (depth !== 8 && depth !== 16) throw typeError('JPEG 2000 depth must be 8 or 16', 'limits');
  if (!Number.isInteger(maxPixels) || maxPixels < 1 || maxPixels > 2 ** 28)
    throw rangeError('JPEG 2000 maxPixels must be an integer from 1 to 268435456', 'limits');
  return { reduce, layers, depth, maxPixels };
}

/** The failure a result's error code names (Error::code in the crate). */
function failure(code: number): Error {
  if (code === 1)
    return fault('failed', 'JPEG 2000 ends inside a header it needs; pass the complete bytes of the file');
  if (code === 3)
    return fault(
      'unsupported',
      'JPEG 2000 uses a coding tool outside Part 1 (for example the HT block coder of Part 15); re-encode as Part 1',
    );
  if (code === 4)
    return rangeError(
      'JPEG 2000 is over a limit: more pixels than maxPixels (raise it for trusted data or pass a larger reduce), ' +
        'too many tiles, precincts, code-blocks or packet visits, or a code-block over 31 bit-planes',
      'limits',
    );
  return fault('failed', 'JPEG 2000 is malformed, or reduce exceeds its decomposition levels; re-encode the image');
}

export function checkInput(length: number): void {
  if (!length) throw fault('failed', 'JPEG 2000 input is empty; pass the bytes of a JP2 file or a codestream');
  if (length > MAX_INPUT) throw rangeError('JPEG 2000 input exceeds 1 GiB; split or reduce the image', 'limits');
}

/** One decode on a module instance. After a `WebAssembly.RuntimeError` the instance is not to be used again. */
export function decodeJPEG2000Module(
  module: JPEG2000Module,
  bytes: Uint8Array,
  settings: JPEG2000Settings,
): JPEG2000Image {
  checkInput(bytes.length);
  const pointer = module.jpeg2000_alloc(bytes.length) >>> 0;
  if (!pointer) throw fault('failed', 'JPEG 2000 input allocation failed; reduce the image size');
  new Uint8Array(module.memory.buffer, pointer, bytes.length).set(bytes);
  // A trap leaves the instance's allocator in an unknown state, so nothing is freed after one: the instance is dropped.
  const output = guard(
    'JPEG 2000',
    () =>
      module.jpeg2000_decode(
        pointer,
        bytes.length,
        settings.reduce,
        settings.layers,
        settings.depth,
        settings.maxPixels,
      ) >>> 0,
  );
  const header = new DataView(module.memory.buffer, output, HEADER),
    [length, code, width, height, depth, truncated] = Array.from({ length: 6 }, (_, i) =>
      header.getUint32(i * 4, true),
    );
  try {
    if (code) throw failure(code);
    const samples = width * height * 4;
    if (depth !== settings.depth || !samples || length !== HEADER + samples * (depth / 8))
      throw fault('failed', 'JPEG 2000 decoder returned an invalid result layout');
    // A copy of the samples: it starts at offset 0 whatever the result's address, and outlives the instance.
    const raw = new Uint8Array(module.memory.buffer, output + HEADER, length - HEADER).slice();
    return {
      width,
      height,
      depth: settings.depth,
      data: depth === 16 ? new Uint16Array(raw.buffer) : raw,
      truncated: truncated !== 0,
    };
  } finally {
    module.jpeg2000_free(pointer, bytes.length);
    module.jpeg2000_free(output, length);
  }
}
