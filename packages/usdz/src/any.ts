import type { BinaryInput } from '@margoengine/loaders';
import { parseUSDA, parseUSDC, parseUSDZ, type USDAsset, type USDOptions } from './index.js';
/** USDZ, USDC or USDA by content (ZIP magic, Crate magic, else text). */
export async function parseUSD(input: string | BinaryInput, options: USDOptions): Promise<USDAsset> {
  if (typeof input === 'string') return parseUSDA(input, options);
  const bytes =
    input instanceof ArrayBuffer
      ? new Uint8Array(input)
      : new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  if (bytes[0] === 0x50 && bytes[1] === 0x4b) return parseUSDZ(bytes, options);
  return new TextDecoder().decode(bytes.subarray(0, 8)) === 'PXR-USDC'
    ? parseUSDC(bytes, options)
    : parseUSDA(bytes, options);
}
