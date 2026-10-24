import type { PaintAtlas, PaintTexture } from './paint-types.js';
import { validatePaintTexture } from './paint-common.js';
import { paintColorBytes } from './paint.js';
import { hexColor } from '@margoengine/math/color';

const rgbHex = (r: number, g: number, b: number): string =>
  `#${[r, g, b].map((value) => value.toString(16).padStart(2, '0')).join('')}`;
const normalizedHex = (value: string): string => {
  const rgb = typeof value === 'string' ? hexColor(value) : undefined;
  if (!rgb || rgb[3] !== 1)
    throw new TypeError('Palette colors must be hexadecimal RGB colors; use six-digit #rrggbb or three-digit #rgb.');
  return rgbHex(...(rgb.slice(0, 3).map((v) => Math.round(v * 255)) as [number, number, number]));
};

/** Most frequent opaque RGB colors, with deterministic hex ordering when frequencies tie. */
export function dominantMeshPaintColors(texture: PaintTexture, limit = 12): string[] {
  validatePaintTexture(texture);
  if (!Number.isFinite(limit) || limit < 0)
    throw new RangeError('Palette limit must be finite and nonnegative; choose a color count.');
  const counts = new Map<string, number>(),
    pixels = texture.pixels;
  for (let i = 0; i < pixels.length; i += 4) {
    if (pixels[i + 3] !== 255) continue;
    const hex = rgbHex(pixels[i], pixels[i + 1], pixels[i + 2]);
    counts.set(hex, (counts.get(hex) ?? 0) + 1);
  }
  return [...counts]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, Math.floor(limit))
    .map(([hex]) => hex);
}

/** Supported hue-only clothing variants, retaining source saturation, brightness and non-green colors. */
export type PaintPalettePreset = 'blue' | 'red' | 'toxic' | 'copy';

function presetRGB(source: number[], preset: PaintPalettePreset): number[] {
  if (preset === 'copy') return source;
  const [r, g, b] = source.map((value) => value / 255),
    max = Math.max(r, g, b),
    min = Math.min(r, g, b),
    chroma = max - min;
  if (chroma < 0.025 || chroma / (max || 1) < 0.15 || max !== g) return source;
  const hue = ((b - r) / chroma + 2) * 60;
  if (hue < 65 || hue > 170) return source;
  const targetHue = preset === 'blue' ? 215 : preset === 'red' ? 2 : 115,
    sector = targetHue / 60,
    x = chroma * (1 - Math.abs((sector % 2) - 1));
  const channels =
    sector < 1
      ? [chroma, x, 0]
      : sector < 2
        ? [x, chroma, 0]
        : sector < 3
          ? [0, chroma, x]
          : sector < 4
            ? [0, x, chroma]
            : sector < 5
              ? [x, 0, chroma]
              : [chroma, 0, x];
  return channels.map((value) => Math.round((value + min) * 255));
}

/** Build a simultaneous RGB map for every source color, including RGB stored under transparent texels. */
export function createMeshPaintPalette(
  texture: PaintTexture,
  preset: PaintPalettePreset = 'copy',
): Record<string, string> {
  validatePaintTexture(texture);
  if (!['blue', 'red', 'toxic', 'copy'].includes(preset))
    throw new TypeError('Choose a supported palette preset: blue, red, toxic or copy.');
  const colors = new Map<string, string>(),
    pixels = texture.pixels;
  for (let i = 0; i < pixels.length; i += 4) {
    const source = [pixels[i], pixels[i + 1], pixels[i + 2]],
      key = rgbHex(...(source as [number, number, number]));
    if (colors.has(key)) continue;
    colors.set(key, rgbHex(...(presetRGB(source, preset) as [number, number, number])));
  }
  return Object.fromEntries(colors);
}

/** Apply simultaneous RGB substitutions to owned pixels; all alpha bytes and source data remain exact. */
export function applyMeshPaintPalette(texture: PaintTexture, colors: Readonly<Record<string, string>>): PaintAtlas {
  validatePaintTexture(texture);
  if (!colors || typeof colors !== 'object' || Array.isArray(colors))
    throw new TypeError('Palette substitutions need an RGB map; supply #rrggbb source and target colors.');
  const substitutions = new Map(
    Object.entries(colors).map(([from, to]) => [normalizedHex(from), paintColorBytes(normalizedHex(to))]),
  );
  const pixels = Array.from(texture.pixels);
  for (let i = 0; i < pixels.length; i += 4) {
    const replacement = substitutions.get(rgbHex(pixels[i], pixels[i + 1], pixels[i + 2]));
    if (replacement) for (let channel = 0; channel < 3; channel++) pixels[i + channel] = replacement[channel];
  }
  return { width: texture.width, height: texture.height, pixels };
}
