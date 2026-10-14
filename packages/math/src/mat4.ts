import type {NumberArray} from './types.js';

// Column-major 4x4 matrices as plain arrays (number[], Float32Array, Float64Array: the layout of core `camera.matrix`
// and mesh world matrices). Arithmetic is float64; a Float32Array `out` rounds once on store. Nothing allocates.
// These are the one copy the packages share and they rely on bit-identical results, so keep every expression's operand
// order as it is (examples/package-benchmarks/proofs/math-consolidation.proof.js checks them against the old copies).

/** out = a * b. `out` must not alias `a` or `b`. */
export function multiplyMatrices<T extends NumberArray>(a: ArrayLike<number>, b: ArrayLike<number>, out: T): T {
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++)
    out[c * 4 + r] = a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3];
  return out;
}
