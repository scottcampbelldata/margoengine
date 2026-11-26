/**
 * The level to show for `value` (a distance, or any metric that grows as detail may drop): the coarsest of the `count`
 * levels at `thresholds[base...]` whose threshold `value` has reached, except that a finer level than `shown` (-1 for
 * none) is taken only once `value` is below `thresholds[base + shown] * (1 - bands[base + shown])`.
 */
export function pickLevel(
  thresholds: ArrayLike<number>,
  bands: ArrayLike<number>,
  base: number,
  count: number,
  shown: number,
  value: number,
): number;
