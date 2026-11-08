import { LinearToSRGB, parseColor } from '@margoengine/math/color';

/** `#rrggbb` (sRGB) of a linear colour's first three channels, each clamped to 0..1, for a colour input. */
export function hexOf(data: ArrayLike<number>): string {
  let out = '#';
  for (let i = 0; i < 3; i++)
    out += Math.round(LinearToSRGB(Math.max(0, Math.min(1, data[i]))) * 255)
      .toString(16)
      .padStart(2, '0');
  return out;
}

/** Linear rgb of a colour input's `#rrggbb` (sRGB) value. */
export const linearOf = (hex: string): number[] => Array.from(parseColor(hex));
