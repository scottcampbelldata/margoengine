import { hexColor } from '@margoengine/math/color';
import { rangeError, typeError } from '../../shared/errors.js';

/** Straight (non-premultiplied) sRGB colour, each channel in 0..1. */
export type Rgba = readonly [number, number, number, number];

/**
 * Parse `#rgb`, `#rrggbb` or `#rrggbbaa` into sRGB channels in 0..1. An {@link Rgba} passes through after a
 * range check. Throws a TypeError for any other string and a RangeError for a channel outside 0..1.
 */
export function parseRgba(value: string | Rgba): Rgba {
  if (typeof value !== 'string') {
    if (!Array.isArray(value) || value.length !== 4)
      throw typeError('A colour is a #rrggbb string or [r, g, b, a]', 'ui');
    if (value.some((c) => typeof c !== 'number' || !(c >= 0 && c <= 1)))
      throw rangeError('Colour channels must be numbers from 0 to 1', 'ui');
    return value;
  }
  const color = hexColor(value.trim());
  if (!color) throw typeError(`Unsupported colour '${value}'; use #rgb, #rrggbb or #rrggbbaa`, 'ui');
  return color;
}

/** `color` with its alpha multiplied by `alpha` (0..1). */
export function withAlpha(color: Rgba, alpha: number): Rgba {
  return [color[0], color[1], color[2], color[3] * alpha];
}

/** Linear blend from `a` to `b` in sRGB, `t` in 0..1. */
export function mixColors(a: Rgba, b: Rgba, t: number): Rgba {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t, a[3] + (b[3] - a[3]) * t];
}

const linear = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);

/** WCAG 2 relative luminance of an opaque colour. */
export function luminance(color: string | Rgba): number {
  const c = parseRgba(color);
  return 0.2126 * linear(c[0]) + 0.7152 * linear(c[1]) + 0.0722 * linear(c[2]);
}

/**
 * WCAG 2 contrast ratio of two colours, from 1 (identical) to 21 (black on white). Text needs 4.5 (AA) or 7 (AAA);
 * the boundary of a control against its surroundings needs 3.
 */
export function contrastRatio(a: string | Rgba, b: string | Rgba): number {
  const x = luminance(a),
    y = luminance(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

/** The kinds of colour-vision deficiency {@link simulateColorBlindness} can show. */
export type ColorBlindness = 'protanopia' | 'deuteranopia' | 'tritanopia';

// Linear-light RGB transforms for complete dichromacy, from Machado, Oliveira and Fernandes (2009), "A Physiologically-based Model for Simulation of Color Vision Deficiency".
const MATRICES: Record<ColorBlindness, readonly number[]> = {
  protanopia: [0.152286, 1.052583, -0.204868, 0.114503, 0.786281, 0.099216, -0.003882, -0.048116, 1.051998],
  deuteranopia: [0.367322, 0.860646, -0.227968, 0.280085, 0.672501, 0.047413, -0.01182, 0.04294, 0.968881],
  tritanopia: [1.255528, -0.076749, -0.178779, -0.078411, 0.930809, 0.147602, 0.004733, 0.691367, 0.3039],
};
const encode = (c: number) => {
  const v = Math.max(0, Math.min(1, c));
  return v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055;
};

/** How `color` looks to a viewer with the given dichromacy (a Machado et al. 2009 model at full severity). */
export function simulateColorBlindness(color: string | Rgba, kind: ColorBlindness): Rgba {
  const c = parseRgba(color),
    m = MATRICES[kind],
    r = linear(c[0]),
    g = linear(c[1]),
    b = linear(c[2]);
  return [
    encode(m[0] * r + m[1] * g + m[2] * b),
    encode(m[3] * r + m[4] * g + m[5] * b),
    encode(m[6] * r + m[7] * g + m[8] * b),
    c[3],
  ];
}

/** CIE76 colour difference of two opaque sRGB colours (D65). About 2.3 is just noticeable; 20 or more reads as different colours. */
export function colorDifference(a: string | Rgba, b: string | Rgba): number {
  const lab = (color: string | Rgba) => {
    const c = parseRgba(color),
      r = linear(c[0]),
      g = linear(c[1]),
      bl = linear(c[2]);
    const f = (t: number) => (t > 216 / 24389 ? Math.cbrt(t) : ((24389 / 27) * t + 16) / 116);
    const x = f((0.4124564 * r + 0.3575761 * g + 0.1804375 * bl) / 0.95047),
      y = f(0.2126729 * r + 0.7151522 * g + 0.072175 * bl),
      z = f((0.0193339 * r + 0.119192 * g + 0.9503041 * bl) / 1.08883);
    return [116 * y - 16, 500 * (x - y), 200 * (y - z)];
  };
  const p = lab(a),
    q = lab(b);
  return Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);
}
