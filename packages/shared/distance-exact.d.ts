/**
 * In-place exact squared Euclidean distance transform on a row-major grid of `dims` (2 or 3 axes, x fastest), after
 * Felzenszwalb and Huttenlocher (2012). Seed cells hold 0, the others a large stand-in for infinity. With `nearest`,
 * each cell also gets the index of its minimising cell. Returns `grid`.
 */
export function squaredDistanceTransformNd(
  grid: Float64Array,
  dims: readonly number[],
  nearest?: Int32Array,
): Float64Array;
