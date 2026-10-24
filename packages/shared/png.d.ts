/** The 8-byte PNG signature. */
export const PNG_SIGNATURE: readonly number[];
/** Value predicted for a byte by row filter `type` (0-4) from its left, up and up-left neighbours. */
export function pngPredict(type: number, a: number, b: number, c: number): number;
/** Signature, IHDR, one IDAT holding `zlib` and IEND of an 8-bit PNG (colour 2 RGB, 6 RGBA). */
export function pngParts(width: number, height: number, colour: number, zlib: Uint8Array): Uint8Array<ArrayBuffer>[];
