// glTF meshopt decoding with WebAssembly SIMD (`@margoengine/decoders/meshopt-simd`), beside the TypeScript decoder in
// `@margoengine/decoders/meshopt`. The output is the same, byte for byte. A stream the Wasm will not read, a browser
// without Wasm SIMD and any call before `ready` go to the TypeScript decoder, which also reports every error, so the
// messages stay the same too. The module is built from `native/meshopt-simd` and embedded here; it costs nothing until
// this entry is imported, and it is compiled on the first use of `ready`.
import { MeshoptDecoder, meshoptDecodeGltfBuffer } from './meshopt.js';
import { meshoptMostElements } from './meshopt-limit.js';
import { MESHOPT_SIMD_WASM } from './meshopt-simd-wasm.js';

interface Exports {
  memory: WebAssembly.Memory;
  heap_base(): number;
  decode_attributes(source: number, length: number, target: number, count: number, size: number): number;
  decode_triangles(source: number, length: number, target: number, count: number, wide: number): number;
  decode_sequence(source: number, length: number, target: number, count: number, wide: number): number;
  filter_octahedral(data: number, count: number, stride: number): void;
  filter_quaternion(data: number, count: number): void;
  filter_exponential(data: number, words: number): void;
  filter_color(data: number, count: number, stride: number): void;
}

const PAGE = 65536,
  // The attribute decoder keeps 64 KiB of deltas on the stack, which the module's own memory already holds.
  align = (value: number): number => (value + 15) & ~15;

let wasm: Exports | undefined;
let loading: Promise<void> | undefined;

function moduleBytes(): Uint8Array<ArrayBuffer> {
  const text = atob(MESHOPT_SIMD_WASM),
    bytes = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) bytes[i] = text.charCodeAt(i);
  return bytes;
}

async function load(): Promise<void> {
  const bytes = moduleBytes();
  if (!WebAssembly.validate(bytes)) return;
  wasm = (await WebAssembly.instantiate(bytes)).instance.exports as unknown as Exports;
}

// Runs the Wasm decoder over `src`. Returns where the output is in the module's memory, or -1 when the TypeScript decoder
// should take the call: it decides every case the Wasm does not.
function decode(
  module: Exports,
  src: Uint8Array,
  count: number,
  stride: number,
  mode: string,
  filter: string | undefined,
): number {
  const filtered = filter && filter !== 'NONE',
    indices = mode === 'TRIANGLES' || mode === 'INDICES';
  if (
    !Number.isSafeInteger(count) ||
    count < 0 ||
    !Number.isSafeInteger(stride) ||
    stride <= 0 ||
    count * stride > 2 ** 31 ||
    count > meshoptMostElements(mode, src.length, stride) ||
    (indices && (filtered || (stride !== 2 && stride !== 4))) ||
    (!indices && mode !== 'ATTRIBUTES')
  )
    return -1;
  const source = align(module.heap_base()),
    target = align(source + src.length),
    end = target + count * stride,
    { memory } = module;
  if (end > memory.buffer.byteLength) memory.grow(Math.ceil((end - memory.buffer.byteLength) / PAGE));
  new Uint8Array(memory.buffer).set(src, source);
  const failed =
    mode === 'ATTRIBUTES'
      ? module.decode_attributes(source, src.length, target, count, stride)
      : (mode === 'TRIANGLES' ? module.decode_triangles : module.decode_sequence)(
          source,
          src.length,
          target,
          count,
          stride === 4 ? 1 : 0,
        );
  if (failed) return -1;
  if (!filtered) return target;
  if (filter === 'OCTAHEDRAL' && (stride === 4 || stride === 8)) module.filter_octahedral(target, count, stride);
  else if (filter === 'QUATERNION' && stride === 8) module.filter_quaternion(target, count);
  else if (filter === 'EXPONENTIAL') module.filter_exponential(target, (count * stride) >> 2);
  else if (filter === 'COLOR' && (stride === 4 || stride === 8)) module.filter_color(target, count, stride);
  else return -1;
  return target;
}

/**
 * {@link meshoptDecodeGltfBuffer} on Wasm SIMD once {@link MeshoptSIMDDecoder.ready} has resolved. Same arguments, same
 * bytes, same errors.
 */
export function meshoptDecodeGltfBufferSIMD(
  src: Uint8Array,
  count: number,
  stride: number,
  mode: string,
  filter = 'NONE',
): Uint8Array {
  const at = wasm ? decode(wasm, src, count, stride, mode, filter) : -1;
  if (at < 0) return meshoptDecodeGltfBuffer(src, count, stride, mode, filter);
  return new Uint8Array(wasm!.memory.buffer, at, count * stride).slice();
}

/**
 * The members of `MeshoptDecoder`, on Wasm SIMD: `ready` compiles the module on first use, and after it `supported` says
 * whether this runtime has Wasm SIMD. Without it every call runs the TypeScript decoder, so a page can use this object
 * everywhere.
 *
 * @example
 * await MeshoptSIMDDecoder.ready;
 * const positions = meshoptDecodeGltfBufferSIMD(bytes, 1000, 12, 'ATTRIBUTES');
 */
export const MeshoptSIMDDecoder = {
  /** True once `ready` has resolved on a runtime with Wasm SIMD. */
  get supported(): boolean {
    return wasm !== undefined;
  },
  /** Compiles the module on first use. */
  get ready(): Promise<void> {
    return (loading ??= load());
  },
  /** Decodes into `target`, which needs at least `count * stride` bytes. Throws what `MeshoptDecoder` throws. */
  decodeGltfBuffer(
    target: Uint8Array,
    count: number,
    stride: number,
    source: Uint8Array,
    mode: string,
    filter?: string,
  ): void {
    // A target too small gets the TypeScript decoder's own refusal, so the error stays the same too.
    if (target.byteLength < count * stride) MeshoptDecoder.decodeGltfBuffer(target, count, stride, source, mode, filter);
    else target.set(meshoptDecodeGltfBufferSIMD(source, count, stride, mode, filter));
  },
};
