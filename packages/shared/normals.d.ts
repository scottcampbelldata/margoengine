/** Adds each triangle's unnormalized face normal (length twice its area) to its three vertices in `out` (xyz each). */
export function accumulateNormals<T extends Float64Array | Float32Array>(
  positions: ArrayLike<number>,
  indices: ArrayLike<number>,
  out: T,
): T;
