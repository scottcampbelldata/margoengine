// Display mapping shared by `capture` (PNG rows) and the sequence entry (`TracedFrame.pixels`): exposure 2^EV, cos^4
// vignetting, a tone curve and an 8-bit encode. Pure CPU code with no GPU state, so an entry that imports it carries
// only these few functions.
import { acesNarkowicz } from '../../shared/aces.js';
import { agx } from '../../shared/agx.js';

/** The tracer options the display mapping reads. */
export interface DisplaySettings {
  exposure: number;
  toneMapping: 'neutral' | 'linear' | 'aces-narkowicz' | 'agx';
  gamma?: number;
  vignette: number;
}

// Khronos PBR Neutral tone mapper (Khronos specification, 2024), CPU twin of shared/display.js.
export const neutral = (c: number[]): number[] => {
  const x = Math.min(c[0], c[1], c[2]),
    offset = x < 0.08 ? x - 6.25 * x * x : 0.04,
    v = c.map((y) => y - offset),
    peak = Math.max(v[0], v[1], v[2]);
  if (peak < 0.76) return v;
  const top = 1 - (0.24 * 0.24) / (peak + 0.24 - 0.76),
    t = 1 - 1 / (0.15 * (peak - top) + 1);
  return v.map((y) => (y * top) / peak + (top - (y * top) / peak) * t);
};

export const toneCurve = (mode: DisplaySettings['toneMapping']): ((c: number[]) => number[]) =>
  mode === 'linear' ? (c: number[]) => c : mode === 'aces-narkowicz' ? acesNarkowicz : mode === 'agx' ? agx : neutral;

/** 8-bit display value: sRGB (IEC 61966-2-1), or the power 1 / gamma. */
export const encode = (v: number, gamma?: number): number => {
  const x = Math.min(1, Math.max(0, v));
  return Math.round(255 * (gamma ? x ** (1 / gamma) : x <= 0.0031308 ? x * 12.92 : 1.055 * x ** (1 / 2.4) - 0.055));
};

/**
 * Maps `rows` rows of linear colour (3 floats per pixel, with optional coverage `alpha`) starting at image row `y0`
 * of a `width` x `height` image to 8-bit display values with `channels` (3 or 4) bytes per pixel in `out`.
 * Transparent pixels are unpremultiplied (colour / alpha) and carry alpha in the fourth byte.
 */
export function displayRows(
  settings: DisplaySettings,
  width: number,
  height: number,
  y0: number,
  rows: number,
  color: ArrayLike<number>,
  alpha: ArrayLike<number> | undefined,
  channels: 3 | 4,
  out: Uint8Array | Uint8ClampedArray,
): void {
  const exposure = 2 ** settings.exposure,
    tone = toneCurve(settings.toneMapping),
    { gamma, vignette } = settings,
    c = [0, 0, 0];
  for (let i = 0; i < width * rows; i++) {
    // Transparent: the colour of what the pixel's rays hit (premultiplied by coverage in the render).
    const a = alpha ? alpha[i] : 1;
    let gain = a > 0 ? exposure / a : 0;
    if (vignette > 0) {
      const x = (i % width) + 0.5 - width / 2,
        y = y0 + Math.floor(i / width) + 0.5 - height / 2,
        // cos^4 natural vignetting, 1 / (1 + t^2)^2; the 0.2238 scale is fitted to observed MagicaVoxel output.
        t = (vignette * Math.hypot(x, y)) / (0.2238 * height);
      gain /= (1 + t * t) ** 2;
    }
    for (let k = 0; k < 3; k++) c[k] = Math.max(0, color[i * 3 + k] * gain);
    const v = tone(c);
    for (let k = 0; k < 3; k++) out[i * channels + k] = encode(v[k], gamma);
    if (channels === 4) out[i * 4 + 3] = Math.round(255 * Math.min(1, Math.max(0, a)));
  }
}
