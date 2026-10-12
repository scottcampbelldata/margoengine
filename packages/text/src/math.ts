/** Column-major 4x4 helpers kept local so the package does not depend on other packages' internals. */
export type Mat4 = ArrayLike<number>;

export const identity = (): Float32Array => new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);

/** out = a * b. `out` may not alias `a` or `b`. */
export function multiply(out: Float32Array, a: Mat4, b: Mat4): Float32Array {
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++)
    out[c * 4 + r] = a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3];
  return out;
}

/** Writes translation * rotation(quaternion x, y, z, w) * scale into out. */
export function compose(out: Float32Array, p: ArrayLike<number>, q: ArrayLike<number>, s: ArrayLike<number>): Float32Array {
  const [x, y, z, w] = [q[0], q[1], q[2], q[3]], x2 = x + x, y2 = y + y, z2 = z + z;
  const xx = x * x2, xy = x * y2, xz = x * z2, yy = y * y2, yz = y * z2, zz = z * z2, wx = w * x2, wy = w * y2, wz = w * z2;
  out[0] = (1 - (yy + zz)) * s[0]; out[1] = (xy + wz) * s[0]; out[2] = (xz - wy) * s[0]; out[3] = 0;
  out[4] = (xy - wz) * s[1]; out[5] = (1 - (xx + zz)) * s[1]; out[6] = (yz + wx) * s[1]; out[7] = 0;
  out[8] = (xz + wy) * s[2]; out[9] = (yz - wx) * s[2]; out[10] = (1 - (xx + yy)) * s[2]; out[11] = 0;
  out[12] = p[0]; out[13] = p[1]; out[14] = p[2]; out[15] = 1;
  return out;
}

/** Quaternion for XYZ Euler angles in radians, matching the core Mesh.setRotation convention. */
export function eulerToQuaternion(e: ArrayLike<number>): [number, number, number, number] {
  const sx = Math.sin(e[0] / 2), cx = Math.cos(e[0] / 2), sy = Math.sin(e[1] / 2), cy = Math.cos(e[1] / 2), sz = Math.sin(e[2] / 2), cz = Math.cos(e[2] / 2);
  return [sx * cy * cz + cx * sy * sz, cx * sy * cz - sx * cy * sz, cx * cy * sz + sx * sy * cz, cx * cy * cz - sx * sy * sz];
}

export function finiteArray(values: ArrayLike<number>, length: number, label: string): void {
  if (!values || values.length !== length) throw new TypeError(`${label} needs ${length} values`);
  for (let i = 0; i < length; i++) {
    const value = values[i];
    if (typeof value !== 'number' || !Number.isFinite(Math.fround(value))) throw new RangeError(`${label} must be finite Float32 values`);
  }
}
