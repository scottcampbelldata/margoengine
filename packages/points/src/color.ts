/** A color: '#rrggbb' or '#rgb' (sRGB), a 0xrrggbb number (sRGB), or [r, g, b] in linear RGB 0..1 like PbrMaterial. */
export type ColorInput = string | number | readonly number[];

const linear = (value: number): number => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;

/** Converts a ColorInput to linear RGB. */
export function parseColor(value: ColorInput, out: Float32Array | number[] = [0, 0, 0], offset = 0): Float32Array | number[] {
  let rgb: number[];
  if (typeof value === 'number') {
    if (!Number.isInteger(value) || value < 0 || value > 0xffffff) throw new RangeError('Numeric colors must be 0x000000..0xffffff');
    rgb = [value >> 16 & 255, value >> 8 & 255, value & 255].map(v => linear(v / 255));
  } else if (typeof value === 'string') {
    const short = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/i.exec(value), long = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(value);
    const parts = long ? long.slice(1) : short ? short.slice(1).map(c => c + c) : null;
    if (!parts) throw new TypeError('Color strings must be #rrggbb or #rgb');
    rgb = parts.map(p => linear(parseInt(p, 16) / 255));
  } else if (value && typeof value === 'object' && value.length === 3) {
    rgb = [value[0], value[1], value[2]];
    if (rgb.some(v => typeof v !== 'number' || !Number.isFinite(v) || v < 0)) throw new RangeError('Linear RGB colors must be finite and non-negative');
  } else throw new TypeError('Expected a color');
  out[offset] = rgb[0]; out[offset + 1] = rgb[1]; out[offset + 2] = rgb[2];
  return out;
}
