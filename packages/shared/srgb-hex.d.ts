/** An sRGB channel (0..1) as a byte, clamped. NaN is 0. */
export function srgbByte(v: number): number;
/** `#rrggbb` of an sRGB triple (0..1), each channel clamped; a NaN channel is 00. */
export function srgbHex(r: number, g: number, b: number): string;
