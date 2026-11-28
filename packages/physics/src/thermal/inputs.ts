import type { Region } from '../world/solver.js';
import { thermalError } from './errors.js';

/** Checks a registered bank before a world-native reader uses its words. */
export function thermalInputWords(memory: WebAssembly.Memory, region: Region): Float64Array {
  const owner = region.memory ?? memory;
  const { byteOffset, byteLength } = region;
  if (
    !Number.isSafeInteger(byteOffset) ||
    !Number.isSafeInteger(byteLength) ||
    byteOffset < 0 ||
    byteLength < 0 ||
    byteOffset % Float64Array.BYTES_PER_ELEMENT ||
    byteLength % Float64Array.BYTES_PER_ELEMENT ||
    byteOffset + byteLength > owner.buffer.byteLength
  ) {
    throw thermalError(
      'A thermal input bank is outside or unaligned in its owning memory. Publish an allocated f64 grid.',
    );
  }
  return new Float64Array(owner.buffer, byteOffset, byteLength / Float64Array.BYTES_PER_ELEMENT);
}
