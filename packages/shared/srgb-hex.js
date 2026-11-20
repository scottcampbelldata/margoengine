// sRGB channels (0..1) as bytes and #rrggbb text, for writers that turn computed colours into CSS or SVG.
/** An sRGB channel (0..1) as a byte, clamped. NaN, which Math.min and Math.max pass through, is 0. */
export const srgbByte = (v) => Math.round((v > 0 ? Math.min(1, v) : 0) * 255);

/** `#rrggbb` of an sRGB triple (0..1), each channel clamped; a NaN channel is 00. */
export const srgbHex = (r, g, b) => `#${[r, g, b].map((v) => srgbByte(v).toString(16).padStart(2, '0')).join('')}`;
