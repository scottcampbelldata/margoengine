/** The 8-byte PNG signature. */
export const PNG_SIGNATURE: readonly number[];
/** Value predicted for a byte by row filter `type` (0-4) from its left, up and up-left neighbours. */
export function pngPredict(type: number, a: number, b: number, c: number): number;
/** IHDR fields when `bytes` start with the PNG signature and a 13-byte IHDR chunk, else undefined (CRC not checked). */
export function pngHeader(bytes: Uint8Array):
  | {
      width: number;
      height: number;
      depth: number;
      colour: number;
      compression: number;
      filter: number;
      interlace: number;
    }
  | undefined;
/** Signature, IHDR, one IDAT holding `zlib` and IEND of an 8-bit PNG (colour 2 RGB, 6 RGBA). */
export function pngParts(width: number, height: number, colour: number, zlib: Uint8Array): Uint8Array<ArrayBuffer>[];
