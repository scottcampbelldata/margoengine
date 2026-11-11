import type { ColorInput, ColorSpace, NumberArray } from './types.js';
import { SRGBToLinear, LinearToSRGB, decodeSRGB, encodeSRGB } from './srgb.js';

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

export { SRGBToLinear, LinearToSRGB };

/* @__NO_SIDE_EFFECTS__ */ function invert3(m: readonly number[]): number[] {
  const [a, b, c, d, e, f, g, h, i] = m,
    A = e * i - f * h,
    B = f * g - d * i,
    C = d * h - e * g,
    det = a * A + b * B + c * C;
  return [A, c * h - b * i, b * f - c * e, B, a * i - c * g, c * d - a * f, C, b * g - a * h, a * e - b * d].map(
    (v) => v / det,
  );
}
const multiply3 = /* @__NO_SIDE_EFFECTS__ */ (a: readonly number[], b: readonly number[]): number[] =>
  a.map((_, k) => {
    const row = k - (k % 3),
      col = k % 3;
    return a[row] * b[col] + a[row + 1] * b[3 + col] + a[row + 2] * b[6 + col];
  });
/**
 * Linear RGB to CIE XYZ (row-major 3x3) of three primaries and a white point, each a CIE 1931 `[x, y]` chromaticity: the
 * columns are the primaries' XYZ, scaled so that RGB (1, 1, 1) is the white point at luminance Y = 1.
 */
/* @__NO_SIDE_EFFECTS__ */ function rgbToXYZ(r: number[], g: number[], b: number[], white: number[]): number[] {
  const xyz = (p: number[]) => [p[0] / p[1], 1, (1 - p[0] - p[1]) / p[1]],
    [R, G, B, W] = [r, g, b, white].map(xyz),
    m = [R[0], G[0], B[0], R[1], G[1], B[1], R[2], G[2], B[2]],
    inverse = invert3(m),
    s = [0, 1, 2].map((i) => inverse[i * 3] * W[0] + inverse[i * 3 + 1] * W[1] + inverse[i * 3 + 2] * W[2]);
  return m.map((v, i) => v * s[i % 3]);
}
// sRGB / Rec. 709 primaries (IEC 61966-2-1) and Display P3's (the DCI-P3 primaries, SMPTE EG 432-1), both with D65 white.
const D65 = [0.3127, 0.329];
/** Linear Display P3 to linear sRGB, row-major 3x3, derived from the two sets of primaries. */
// Pure, so a bundle that never converts Display P3 drops the derivation.
export const P3_TO_SRGB: readonly number[] = /* @__PURE__ */ Object.freeze(
  multiply3(
    invert3(rgbToXYZ([0.64, 0.33], [0.3, 0.6], [0.15, 0.06], D65)),
    rgbToXYZ([0.68, 0.32], [0.265, 0.69], [0.15, 0.06], D65),
  ),
);
/** Linear sRGB to linear Display P3 (the inverse of {@link P3_TO_SRGB}). */
export const SRGB_TO_P3: readonly number[] = /* @__PURE__ */ Object.freeze(invert3(P3_TO_SRGB));
// Bradford cone response matrix, row-major (Lam 1985, as given by Susstrunk, Holm and Finlayson 2001).
const BRADFORD = [0.8951, 0.2664, -0.1614, -0.7502, 1.7135, 0.0367, 0.0389, -0.0685, 1.0296];
/**
 * Linear RGB in the primaries `[rx, ry, gx, gy, bx, by, wx, wy]` (CIE 1931 xy chromaticities of red, green, blue and
 * white) to linear sRGB with the D65 white, row-major 3x3: RGB to XYZ (SMPTE RP 177-1993), the white adapted to D65
 * with the Bradford transform, then XYZ to sRGB (IEC 61966-2-1). Entries are not finite when the primaries span no
 * colour space.
 */
export function primariesToLinearSRGB(primaries: readonly number[]): number[] {
  const p = primaries,
    cone = (x: number, y: number) =>
      [0, 3, 6].map((r) => BRADFORD[r] * (x / y) + BRADFORD[r + 1] + (BRADFORD[r + 2] * (1 - x - y)) / y),
    from = cone(p[6], p[7]),
    to = cone(D65[0], D65[1]);
  return multiply3(
    invert3(rgbToXYZ([0.64, 0.33], [0.3, 0.6], [0.15, 0.06], D65)),
    multiply3(
      invert3(BRADFORD),
      multiply3(
        BRADFORD.map((v, k) => (v * to[(k / 3) | 0]) / from[(k / 3) | 0]),
        rgbToXYZ([p[0], p[1]], [p[2], p[3]], [p[4], p[5]], [p[6], p[7]]),
      ),
    ),
  );
}
function apply3(m: readonly number[], v: ArrayLike<number>, out: NumberArray, offset: number): void {
  const x = v[0],
    y = v[1],
    z = v[2];
  out[offset] = m[0] * x + m[1] * y + m[2] * z;
  out[offset + 1] = m[3] * x + m[4] * y + m[5] * z;
  out[offset + 2] = m[6] * x + m[7] * y + m[8] * z;
}
/** Linear Display P3 `rgb` as linear sRGB in `out` (default a new array); colours outside sRGB get negative channels. */
export function linearP3ToLinearSRGB<T extends NumberArray = number[]>(rgb: ArrayLike<number>, out?: T, offset = 0): T {
  const target = out ?? ([0, 0, 0] as unknown as T);
  apply3(P3_TO_SRGB, rgb, target, offset);
  return target;
}
/** Linear sRGB `rgb` as linear Display P3 in `out` (default a new array). */
export function linearSRGBToLinearP3<T extends NumberArray = number[]>(rgb: ArrayLike<number>, out?: T, offset = 0): T {
  const target = out ?? ([0, 0, 0] as unknown as T);
  apply3(SRGB_TO_P3, rgb, target, offset);
  return target;
}
/**
 * Linear sRGB `rgb` brought inside sRGB from below, in `out` (default a new array): a colour with a negative channel (a
 * wide-gamut colour) is desaturated toward its own luminance (Rec. 709 weights) just until no channel is negative, so
 * its luminance and hue stay; channels above 1 (HDR) are kept. For inputs that take only sRGB, such as core's sun.
 */
export function clipToSRGB<T extends NumberArray = number[]>(rgb: ArrayLike<number>, out?: T, offset = 0): T {
  const target = out ?? ([0, 0, 0] as unknown as T),
    r = rgb[0],
    g = rgb[1],
    b = rgb[2],
    y = Math.max(0, 0.2126 * r + 0.7152 * g + 0.0722 * b);
  let t = 1;
  if (r < 0) t = Math.min(t, y / (y - r));
  if (g < 0) t = Math.min(t, y / (y - g));
  if (b < 0) t = Math.min(t, y / (y - b));
  target[offset] = Math.max(0, y + (r - y) * t);
  target[offset + 1] = Math.max(0, y + (g - y) * t);
  target[offset + 2] = Math.max(0, y + (b - y) * t);
  return target;
}
/** Components `r, g, b` in `colorSpace` as linear sRGB at `out[offset..]`. */
function toLinear(r: number, g: number, b: number, colorSpace: ColorSpace, out: NumberArray, offset: number): void {
  const encoded = colorSpace === 'srgb' || colorSpace === 'display-p3',
    v = encoded ? [decodeSRGB(r), decodeSRGB(g), decodeSRGB(b)] : [r, g, b];
  if (colorSpace === 'display-p3' || colorSpace === 'display-p3-linear') apply3(P3_TO_SRGB, v, out, offset);
  else {
    out[offset] = v[0];
    out[offset + 1] = v[1];
    out[offset + 2] = v[2];
  }
}
const spaces: readonly string[] = ['srgb', 'srgb-linear', 'display-p3', 'display-p3-linear'];
/** CSS `color(<space> r g b [/ alpha])` with a space Margo knows: its components (numbers or %) and space; else null. */
function cssColor(text: string): { rgb: number[]; space: ColorSpace } | null {
  const match = /^color\(\s*([a-z0-9-]+)\s+([^)]*)\)$/i.exec(text.trim());
  if (!match) return null;
  const space = match[1].toLowerCase() as ColorSpace,
    parts = match[2]
      .split('/')[0]
      .trim()
      .split(/[\s,]+/);
  if (!spaces.includes(space))
    throw new TypeError(`Color space '${match[1]}' is unknown; use srgb, srgb-linear, display-p3 or display-p3-linear`);
  const rgb = parts.map((part) => (part.endsWith('%') ? parseFloat(part) / 100 : Number(part)));
  if (rgb.length !== 3 || !rgb.every(Number.isFinite))
    throw new TypeError(`Color '${text}' needs three numbers: color(${space} r g b)`);
  return { rgb, space };
}

/**
 * sRGB components (0..1) `[r, g, b, a]` of a CSS hex colour: `#rgb`, `#rrggbb` or `#rrggbbaa` (alpha is 1
 * when absent), or undefined when `text` is not one. The one hex
 * parser: parseColor, Color, environment's colours, the 3MF loader, materials, mesh-edit palettes and shader colours use it.
 */
export function hexColor(text: string): [number, number, number, number] | undefined {
  const digits = /^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(text)?.[1];
  return digits
    ? ((digits.length < 4 ? digits.replace(/./g, '$&$&') : digits)
        .padEnd(8, 'f')
        .match(/../g)!
        .map((h) => parseInt(h, 16) / 255) as [number, number, number, number])
    : undefined;
}

/**
 * Converts a {@link ColorInput} to linear RGB at `out[offset..offset + 2]` and returns `out` (default: a new
 * `[0, 0, 0]`; `offset` defaults to 0). Strings are hex (sRGB, see {@link hexColor}; alpha is ignored) or CSS `color(display-p3 r g b)` (also
 * `srgb`, `srgb-linear` and `display-p3-linear`; components 0..1 or %): a Display P3 colour outside sRGB keeps its
 * negative linear sRGB channels, for the shaders that carry them to a wide-gamut canvas (tonemap, ColorOutput).
 * @throws RangeError for a number outside 0x000000..0xffffff or a negative/non-finite `[r, g, b]` component (linear
 * sRGB arrays stay non-negative: a negative one is a mistake far more often than a wide-gamut colour, which is given as
 * `color(display-p3 ...)`).
 * @throws TypeError for a string that is none of those, or any other value.
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
  } else if (typeof value === 'string' && /^\s*color\(/i.test(value)) {
    const { rgb: parts, space } = cssColor(value)!;
    rgb = [0, 0, 0];
    toLinear(parts[0], parts[1], parts[2], space, rgb, 0);
  } else if (typeof value === 'string') {
    const hex = hexColor(value);
    if (!hex) throw new TypeError('Color strings must be #rrggbb or #rgb');
    rgb = hex.slice(0, 3).map(SRGBToLinear);
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
 * RGB color stored in linear sRGB (the working space of core `PbrMaterial`).
 * Hex, CSS and HSL inputs are treated as sRGB and decoded.
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
  /** Sets the colour from components in `colorSpace` (default linear sRGB); Display P3 outside sRGB gives negative channels. */
  setRGB(r: number, g: number, b: number, colorSpace: ColorSpace = 'srgb-linear'): this {
    const v = [0, 0, 0];
    toLinear(r, g, b, colorSpace, v, 0);
    this.r = v[0];
    this.g = v[1];
    this.b = v[2];
    return this;
  }
  /** The colour's components in `colorSpace` (default linear sRGB), not clamped, into `out` (default a new array). */
  getRGB<T extends NumberArray = number[]>(out?: T, colorSpace: ColorSpace = 'srgb-linear'): T {
    const target = out ?? ([0, 0, 0] as unknown as T),
      v = [this.r, this.g, this.b];
    if (colorSpace === 'display-p3' || colorSpace === 'display-p3-linear')
      apply3(SRGB_TO_P3, [this.r, this.g, this.b], v, 0);
    const encode = colorSpace === 'srgb' || colorSpace === 'display-p3';
    for (let k = 0; k < 3; k++) target[k] = encode ? encodeSRGB(v[k]) : v[k];
    return target;
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
  /** Parses hex (`#rgb`, `#rrggbb`, see {@link hexColor}), `rgb()`/`rgba()` (0-255 or %) and `hsl()`/`hsla()`. Alpha is ignored. Named colors are not supported. */
  setStyle(style: string, colorSpace: ColorSpace = 'srgb'): this {
    const text = style.trim(),
      css = cssColor(text);
    if (css) return this.setRGB(css.rgb[0], css.rgb[1], css.rgb[2], css.space);
    const hex = hexColor(text);
    if (hex) return this.setRGB(hex[0], hex[1], hex[2], colorSpace);
    const match = /^(rgb|hsl)a?\(([^)]*)\)$/i.exec(text);
    const parts = match?.[2].split(/[\s,/]+/).filter(Boolean);
    if (match && parts && parts.length >= 3 && parts.length <= 4) {
      const numbers = parts.map((part) => parseFloat(part));
      if (numbers.every(Number.isFinite)) {
        if (match[1].toLowerCase() === 'rgb') {
          const channel = (i: number): number => unit(parts[i].endsWith('%') ? numbers[i] / 100 : numbers[i] / 255);
          return this.setRGB(channel(0), channel(1), channel(2), colorSpace);
        }
        // A CSS <hue> is a number (degrees) or an <angle>: deg, grad (400 a turn), rad or turn.
        const hue = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?(deg|grad|rad|turn)?$/i.exec(parts[0]);
        if (!hue) throw new TypeError(`Invalid hue '${parts[0]}'; use a number or deg, grad, rad or turn`);
        const turns = { deg: 360, grad: 400, rad: 2 * Math.PI, turn: 1 }[(hue[1] ?? 'deg').toLowerCase() as 'deg'];
        return this.setHSL(numbers[0] / turns, numbers[1] / 100, numbers[2] / 100, colorSpace);
      }
    }
    throw new TypeError(`Invalid color '${style}'; use hex, rgb() or hsl()`);
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
    this.r = decodeSRGB(this.r);
    this.g = decodeSRGB(this.g);
    this.b = decodeSRGB(this.b);
    return this;
  }
  convertLinearToSRGB(): this {
    this.r = encodeSRGB(this.r);
    this.g = encodeSRGB(this.g);
    this.b = encodeSRGB(this.b);
    return this;
  }

  /** 0xRRGGBB, encoded to sRGB by default (or the components in `colorSpace`). Channels are clamped to [0, 1]. */
  getHex(colorSpace: ColorSpace = 'srgb'): number {
    const [r, g, b] = this.getRGB([0, 0, 0], colorSpace),
      encode = (c: number): number => Math.round(unit(c) * 255);
    return (encode(r) << 16) | (encode(g) << 8) | encode(b);
  }
  /** `rrggbb` without `#`. `'#' + color.getHexString()` is accepted by core `PbrMaterial`. */
  getHexString(colorSpace: ColorSpace = 'srgb'): string {
    return this.getHex(colorSpace).toString(16).padStart(6, '0');
  }
  getHSL<T extends HSL>(target: T, colorSpace: ColorSpace = 'srgb'): T {
    const [r, g, b] = this.getRGB([0, 0, 0], colorSpace),
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
  /** Subtracts per channel, each result clamped below at 0 (NaN stays NaN). */
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

/** A display-space colour grade for {@link gradeSRGB}; every field is optional and defaults to no change. */
export interface ColorGrade {
  /** Added after contrast, in display units (1 = full white). Default 0. */
  brightness?: number;
  /** Scale about mid-grey 0.5. Default 1. */
  contrast?: number;
  /** Hue rotation in degrees, through HSL. Default 0. */
  hue?: number;
  /** sRGB display colour, 0..1 per channel, multiplied in by `tintStrength`. Default white. */
  tint?: ArrayLike<number>;
  /** 0 (no tint) to 1 (full tint). Default 0. */
  tintStrength?: number;
}

/**
 * Grades an sRGB display colour (0..1 per channel, as stored in hex and image files): rotate the hue, scale contrast
 * about 0.5, add brightness, then multiply by white blended toward `tint`. The result is not clamped.
 * @throws RangeError for a non-finite channel or grade value.
 */
export function gradeSRGB<T extends NumberArray = number[]>(
  rgb: ArrayLike<number>,
  grade: ColorGrade,
  out?: T,
  offset = 0,
): T {
  const { brightness = 0, contrast = 1, hue = 0, tint = [1, 1, 1], tintStrength = 0 } = grade,
    values = [rgb[0], rgb[1], rgb[2], brightness, contrast, hue, tint[0], tint[1], tint[2], tintStrength];
  if (!values.every(Number.isFinite)) throw new RangeError('Colour and grade values must be finite numbers');
  const color = new Color().setRGB(rgb[0], rgb[1], rgb[2], 'srgb-linear'),
    target = out ?? ([] as unknown as T);
  if (hue) {
    // Raw display values in and out, so HSL is taken of the sRGB channels as given.
    const hsl = color.getHSL({ h: 0, s: 0, l: 0 }, 'srgb-linear');
    color.setHSL(hsl.h + hue / 360, hsl.s, hsl.l, 'srgb-linear');
  }
  const graded = [color.r, color.g, color.b];
  for (let i = 0; i < 3; i++)
    target[offset + i] = ((graded[i] - 0.5) * contrast + 0.5 + brightness) * (1 + (tint[i] - 1) * tintStrength);
  return target;
}
