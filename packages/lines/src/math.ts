/** Column-major 4x4 helpers only lines uses; shared ones come from `@margoengine/math/mat4`. */
export type Mat4 = ArrayLike<number>;

export const identity = (): Float32Array => new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);

/** Writes M * (x, y, z, 1) divided by w into out at offset. */
export function transformPoint(out: Float32Array | number[], offset: number, m: Mat4, x: number, y: number, z: number): void {
  const w = m[3] * x + m[7] * y + m[11] * z + m[15] || 1;
  out[offset] = (m[0] * x + m[4] * y + m[8] * z + m[12]) / w;
  out[offset + 1] = (m[1] * x + m[5] * y + m[9] * z + m[13]) / w;
  out[offset + 2] = (m[2] * x + m[6] * y + m[10] * z + m[14]) / w;
}

/** Copies source into target and reports whether anything changed. */
export function copyIfChanged(target: Float32Array, source: Mat4): boolean {
  let changed = false;
  for (let i = 0; i < target.length; i++) if (target[i] !== source[i]) {target[i] = source[i]; changed = true;}
  return changed;
}

export function finiteArray(values: ArrayLike<number>, label: string): void {
  for (let i = 0; i < values.length; i++) {
    const value = values[i];
    if (typeof value !== 'number' || !Number.isFinite(Math.fround(value))) throw new RangeError(`${label} must be finite Float32 values`);
  }
}
