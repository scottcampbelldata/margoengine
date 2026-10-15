// Input checks the packages share (bundled into each, like the rest of @margoengine/math).

// Halfway from the largest Float32 to infinity; rounding at this boundary overflows.
const float32Overflow = (2 - 2 ** -24) * 2 ** 127;

/** Throws a TypeError unless `v` holds exactly `size` numbers that stay finite as Float32 (GPU uploads). `name` labels the message. */
export function finiteVector(v: ArrayLike<number>, size: number, name: string): void {
  if (!v || v.length !== size) throw new TypeError(`${name} must contain ${size} finite numbers`);
  for (let i = 0; i < size; i++) {
    const value = v[i];
    if (typeof value !== 'number' || !(value > -float32Overflow && value < float32Overflow))
      throw new TypeError(`${name} must contain ${size} finite Float32 numbers`);
  }
}
