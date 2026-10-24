// Assist helpers an editor can offer: a random fill, a starting palette and palette usage counts.
import { checkGrid, type VoxelGrid } from './grid.js';

/**
 * A new grid of `size` where each cell is filled with `palette` (default 1) when a seeded random value in [0, 1)
 * exceeds `threshold` (default 0.5). Cells are independent (white noise, not smooth noise); the same `seed` (a 32-bit
 * integer, default 1) gives the same grid.
 * @throws RangeError when `size` is not three positive integers or holds more than 16,777,216 cells, `threshold` is
 * outside [0, 1], `seed` is not an integer, or `palette` is not an integer from 1 to 255.
 */
export function noiseFill(
  size: [number, number, number],
  options: { threshold?: number; seed?: number; palette?: number } = {},
): VoxelGrid {
  const [sx, sy, sz] = size;
  if (!Number.isInteger(sx) || !Number.isInteger(sy) || !Number.isInteger(sz) || sx < 1 || sy < 1 || sz < 1)
    throw new RangeError('noiseFill size must be positive integers');
  const cells = sx * sy * sz;
  if (cells > 16_777_216) throw new RangeError('noiseFill size exceeds 16,777,216 cells');
  const { threshold = 0.5, seed = 1, palette = 1 } = options;
  if (!(threshold >= 0 && threshold <= 1)) throw new RangeError('noiseFill threshold must be from 0 to 1');
  if (!Number.isInteger(seed)) throw new RangeError('noiseFill seed must be an integer');
  if (!Number.isInteger(palette) || palette < 1 || palette > 255)
    throw new RangeError('noiseFill palette must be an integer from 1 to 255');
  const voxels = new Uint8Array(cells);
  let n = seed >>> 0;
  for (let i = 0; i < cells; i++) {
    n = (n * 1664525 + 1013904223) >>> 0;
    if (n / 4294967296 > threshold) voxels[i] = palette;
  }
  return { size: [sx, sy, sz], voxels };
}

/**
 * `count` (1 to 16) colours of seeded random hue at fixed saturation and lightness, as a quick starting palette.
 * Returns linear sRGB `[r, g, b]` colours, 0 to 1, the engine's linear colour convention.
 * @throws RangeError when `count` is not an integer from 1 to 16.
 */
export function suggestPalette(count: number, seed = 1): [number, number, number][] {
  if (!Number.isInteger(count) || count < 1 || count > 16)
    throw new RangeError('suggestPalette count must be an integer from 1 to 16');
  const out: [number, number, number][] = [];
  let n = seed >>> 0;
  for (let i = 0; i < count; i++) {
    n = (n * 1664525 + 1013904223) >>> 0;
    const h = (n % 360) / 360;
    out.push(hslToRgb(h, 0.6, 0.5));
  }
  return out;
}

/** HSL to linear sRGB. */
function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => {
    const k = (n + h * 12) % 12;
    const c = l - a * Math.max(Math.min(k - 3, 9 - k, 1), -1);
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return [f(0), f(8), f(4)];
}

/** How many cells of each palette index a grid uses, 256 counts. Index 0 is air and is included. */
export function paletteUsage(grid: VoxelGrid): Uint32Array {
  checkGrid(grid, 16_777_216, 'Usage grid');
  const counts = new Uint32Array(256);
  for (const v of grid.voxels) counts[v]++;
  return counts;
}
