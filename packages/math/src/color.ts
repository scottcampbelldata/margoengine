import type { ColorInput, ColorSpace, NumberArray } from './types.js';

export type { ColorInput } from './types.js';

/** Any `{r, g, b}` colour (linear RGB components, 0..1 for displayable colours), such as a {@link Color}. */
export interface ColorLike {
  r: number;
  g: number;
  b: number;
}
/** Hue, saturation and lightness, each 0..1 (hue wraps: 0 and 1 are both red), as `Color.getHSL` writes them. */
export interface HSL {
  h: number;
  s: number;
  l: number;
}

/** sRGB transfer function, decoded (display value to linear light). */
export const SRGBToLinear = (c: number): number => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
/** sRGB transfer function, encoded (linear light to display value). */
export const LinearToSRGB = (c: number): number => (c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055);

/**
 * Converts a {@link ColorInput} to linear RGB at `out[offset..offset + 2]` and returns `out` (default: a new
 * `[0, 0, 0]`; `offset` defaults to 0).
 * @throws RangeError for a number outside 0x000000..0xffffff or a negative/non-finite `[r, g, b]` component.
 * @throws TypeError for a string that is not `#rrggbb`/`#rgb`, or any other value.
 */
export function parseColor(
  value: ColorInput,
  out: Float32Array | number[] = [0, 0, 0],
  offset = 0,
): Float32Array | number[] {
  let rgb: number[];
  if (typeof value === 'number') {
    if (!Number.isInteger(value) || value < 0 || value > 0xffffff)
      throw new RangeError('Numeric colors must be 0x000000..0xffffff');
    rgb = [(value >> 16) & 255, (value >> 8) & 255, value & 255].map((v) => SRGBToLinear(v / 255));
  } else if (typeof value === 'string') {
    const short = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/i.exec(value),
      long = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(value);
    const parts = long ? long.slice(1) : short ? short.slice(1).map((c) => c + c) : null;
    if (!parts) throw new TypeError('Color strings must be #rrggbb or #rgb');
    rgb = parts.map((p) => SRGBToLinear(parseInt(p, 16) / 255));
  } else if (value && typeof value === 'object' && value.length === 3) {
    rgb = [value[0], value[1], value[2]];
    if (rgb.some((v) => typeof v !== 'number' || !Number.isFinite(v) || v < 0))
      throw new RangeError('Linear RGB colors must be finite and non-negative');
  } else throw new TypeError('Expected a color');
  out[offset] = rgb[0];
  out[offset + 1] = rgb[1];
  out[offset + 2] = rgb[2];
  return out;
}

const hue = (p: number, q: number, t: number): number => {
  t = ((t % 1) + 1) % 1;
  return t < 1 / 6 ? p + (q - p) * 6 * t : t < 1 / 2 ? q : t < 2 / 3 ? p + (q - p) * 6 * (2 / 3 - t) : p;
};
const unit = (value: number): number => Math.max(0, Math.min(1, value));

/**
 * RGB color stored in linear sRGB (the working space of core `PbrMaterial` and three.js).
 * Hex, CSS and HSL inputs are treated as sRGB and decoded, as three.js does by default.
 * `toArray()` gives linear `[r, g, b]` for `new PbrMaterial({color})`, and `toArray(mesh.material.data)` recolors a material in place.
 */
export class Color {
  r = 1;
  g = 1;
  b = 1;

  /** `new Color()` is white; `new Color(0xff8800)` and `new Color('#f80')` are sRGB; `new Color(r, g, b)` is linear. */
  constructor(r?: number | string | ColorLike, g?: number, b?: number) {
    if (g !== undefined && b !== undefined) this.setRGB(r as number, g, b);
    else if (r !== undefined) this.set(r);
  }

  set(value: number | string | ColorLike): this {
    return typeof value === 'number'
      ? this.setHex(value)
      : typeof value === 'string'
        ? this.setStyle(value)
        : this.copy(value);
  }
  setScalar(s: number): this {
    this.r = this.g = this.b = s;
    return this;
  }
  setRGB(r: number, g: number, b: number, colorSpace: ColorSpace = 'srgb-linear'): this {
    this.r = r;
    this.g = g;
    this.b = b;
    return colorSpace === 'srgb' ? this.convertSRGBToLinear() : this;
  }
  setHex(hex: number, colorSpace: ColorSpace = 'srgb'): this {
    hex = Math.floor(hex);
    return this.setRGB(((hex >> 16) & 255) / 255, ((hex >> 8) & 255) / 255, (hex & 255) / 255, colorSpace);
  }
  /** Hue in [0, 1) (wraps), saturation and lightness in [0, 1]. */
  setHSL(h: number, s: number, l: number, colorSpace: ColorSpace = 'srgb'): this {
    h = ((h % 1) + 1) % 1;
    s = unit(s);
    l = unit(l);
    if (s === 0) return this.setRGB(l, l, l, colorSpace);
    const q = l <= 0.5 ? l * (1 + s) : l + s - l * s,
      p = 2 * l - q;
    return this.setRGB(hue(p, q, h + 1 / 3), hue(p, q, h), hue(p, q, h - 1 / 3), colorSpace);
  }
  /** Parses `#rgb`, `#rrggbb`, `rgb()`/`rgba()` (0-255 or %) and `hsl()`/`hsla()`. Alpha is ignored. Named colors are not supported. */
  setStyle(style: string, colorSpace: ColorSpace = 'srgb'): this {
    const text = style.trim();
    let match = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(text);
    if (match) {
      const hex = match[1].length === 3 ? match[1].replace(/./g, '$&$&') : match[1];
      return this.setHex(parseInt(hex, 16), colorSpace);
    }
    match = /^(rgb|hsl)a?\(([^)]*)\)$/i.exec(text);
    const parts = match?.[2].split(/[\s,/]+/).filter(Boolean);
    if (match && parts && parts.length >= 3 && parts.length <= 4) {
      const numbers = parts.map((part) => parseFloat(part));
      if (numbers.every(Number.isFinite)) {
        if (match[1].toLowerCase() === 'rgb') {
          const channel = (i: number): number => unit(parts[i].endsWith('%') ? numbers[i] / 100 : numbers[i] / 255);
          return this.setRGB(channel(0), channel(1), channel(2), colorSpace);
        }
        return this.setHSL(numbers[0] / 360, numbers[1] / 100, numbers[2] / 100, colorSpace);
      }
    }
    throw new TypeError(`Invalid color: ${style}`);
  }
  copy(c: ColorLike): this {
    this.r = c.r;
    this.g = c.g;
    this.b = c.b;
    return this;
  }
  clone(): Color {
    return new Color().copy(this);
  }
  copySRGBToLinear(c: ColorLike): this {
    return this.copy(c).convertSRGBToLinear();
  }
  copyLinearToSRGB(c: ColorLike): this {
    return this.copy(c).convertLinearToSRGB();
  }
  convertSRGBToLinear(): this {
    this.r = SRGBToLinear(this.r);
    this.g = SRGBToLinear(this.g);
    this.b = SRGBToLinear(this.b);
    return this;
  }
  convertLinearToSRGB(): this {
    this.r = LinearToSRGB(this.r);
    this.g = LinearToSRGB(this.g);
    this.b = LinearToSRGB(this.b);
    return this;
  }

  /** 0xRRGGBB, encoded to sRGB by default. Channels are clamped to [0, 1]. */
  getHex(colorSpace: ColorSpace = 'srgb'): number {
    const encode = (c: number): number => Math.round(unit(colorSpace === 'srgb' ? LinearToSRGB(c) : c) * 255);
    return (encode(this.r) << 16) | (encode(this.g) << 8) | encode(this.b);
  }
  /** `rrggbb` without `#`. `'#' + color.getHexString()` is accepted by core `PbrMaterial`. */
  getHexString(colorSpace: ColorSpace = 'srgb'): string {
    return this.getHex(colorSpace).toString(16).padStart(6, '0');
  }
  getHSL<T extends HSL>(target: T, colorSpace: ColorSpace = 'srgb'): T {
    const convert = (c: number): number => (colorSpace === 'srgb' ? LinearToSRGB(c) : c);
    const r = convert(this.r),
      g = convert(this.g),
      b = convert(this.b),
      max = Math.max(r, g, b),
      min = Math.min(r, g, b),
      l = (min + max) / 2;
    let h = 0,
      s = 0;
    if (max !== min) {
      const d = max - min;
      s = l <= 0.5 ? d / (max + min) : d / (2 - max - min);
      h = (max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4) / 6;
    }
    target.h = h;
    target.s = s;
    target.l = l;
    return target;
  }

  add(c: ColorLike): this {
    this.r += c.r;
    this.g += c.g;
    this.b += c.b;
    return this;
  }
  addScalar(s: number): this {
    this.r += s;
    this.g += s;
    this.b += s;
    return this;
  }
  sub(c: ColorLike): this {
    this.r = Math.max(0, this.r - c.r);
    this.g = Math.max(0, this.g - c.g);
    this.b = Math.max(0, this.b - c.b);
    return this;
  }
  multiply(c: ColorLike): this {
    this.r *= c.r;
    this.g *= c.g;
    this.b *= c.b;
    return this;
  }
  multiplyScalar(s: number): this {
    this.r *= s;
    this.g *= s;
    this.b *= s;
    return this;
  }
  lerp(c: ColorLike, t: number): this {
    this.r += (c.r - this.r) * t;
    this.g += (c.g - this.g) * t;
    this.b += (c.b - this.b) * t;
    return this;
  }
  lerpColors(a: ColorLike, b: ColorLike, t: number): this {
    return this.copy(a).lerp(b, t);
  }
  equals(c: ColorLike, epsilon = 0): boolean {
    return Math.abs(this.r - c.r) <= epsilon && Math.abs(this.g - c.g) <= epsilon && Math.abs(this.b - c.b) <= epsilon;
  }

  fromArray(array: ArrayLike<number>, offset = 0): this {
    this.r = array[offset];
    this.g = array[offset + 1];
    this.b = array[offset + 2];
    return this;
  }
  toArray(): [number, number, number];
  toArray<T extends NumberArray>(out: T, offset?: number): T;
  toArray(out: NumberArray = [], offset = 0): NumberArray {
    out[offset] = this.r;
    out[offset + 1] = this.g;
    out[offset + 2] = this.b;
    return out;
  }
}
