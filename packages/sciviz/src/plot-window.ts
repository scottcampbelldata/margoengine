// The 2D chart window's pan and zoom steps, kept inside what the GPU's float32 plot coordinates can draw.

// The largest float32. Plot coordinates and the data-to-scene transform reach the GPU as 32-bit floats, so a 2D
// window that pans or zooms stays inside it.
const F32_MAX = 3.4028234663852886e38;

/**
 * @internal One axis of a 2D window zoomed by `factor` (below 1 zooms in) about the fraction `at` (0 = lo, 1 = hi) of
 * it. Zooming in stops at 2^-17 of the window's largest coordinate (64 float32 steps; 2^-100 near zero), where the
 * float32 positions the GPU draws stop telling points apart; zooming out stops where an end would pass the largest
 * float32. Without those stops a repeated wheel zoom collapsed the window to zero width (nothing to pan) or overflowed.
 */
export function zoomWindow(lo: number, hi: number, factor: number, at: number): [number, number] {
  if (!(factor > 0) || !Number.isFinite(factor)) return [lo, hi];
  // Weighted sums, not differences, so a window wider than the largest double still has a finite centre.
  const t = Math.min(1, Math.max(0, at)),
    c = t === 0 ? lo : t === 1 ? hi : (1 - t) * lo + t * hi,
    span = hi - lo,
    least = Math.max(2 ** -100, Math.max(Math.abs(lo), Math.abs(hi)) * 2 ** -17);
  let f = factor;
  if (f < 1) f = span > least ? Math.max(f, least / span) : 1;
  else {
    // Each end moves away from c in proportion to its distance; the nearer limit decides.
    let most = Infinity;
    if (c > lo) most = Math.min(most, (c + F32_MAX) / (c - lo));
    if (hi > c) most = Math.min(most, (F32_MAX - c) / (hi - c));
    f = Math.min(f, Math.max(1, most));
  }
  if (f === 1) return [lo, hi];
  if (f < 1) return [(1 - f) * c + f * lo, (1 - f) * c + f * hi];
  return [Math.max(-F32_MAX, c - (c - lo) * f), Math.min(F32_MAX, c + (hi - c) * f)];
}

/** @internal One axis of a 2D window moved by `delta`, stopping where an end would pass the largest float32. */
export function panWindow(lo: number, hi: number, delta: number): [number, number] {
  if (!Number.isFinite(delta)) return [lo, hi];
  const d = Math.min(Math.max(delta, Math.min(0, -F32_MAX - lo)), Math.max(0, F32_MAX - hi));
  return [lo + d, hi + d];
}
