// Quaternions as plain [x, y, z, w] arrays, shared by the packages (bundled into each). Keep the operand order: the
// packages rely on bit-identical results (examples/package-benchmarks/proofs/math-consolidation.proof.js).

/** Quaternion for XYZ Euler angles in radians (qX * qY * qZ), the convention of core `Mesh.setRotation`. */
export function eulerToQuaternion(x: number, y: number, z: number): [number, number, number, number] {
  const sx = Math.sin(x / 2), cx = Math.cos(x / 2), sy = Math.sin(y / 2), cy = Math.cos(y / 2), sz = Math.sin(z / 2), cz = Math.cos(z / 2);
  return [sx * cy * cz + cx * sy * sz, cx * sy * cz - sx * cy * sz, cx * cy * sz + sx * sy * cz, cx * cy * cz - sx * sy * sz];
}

/** a * b (apply b, then a) as a new array. */
export const multiplyQuaternions = (a: ArrayLike<number>, b: ArrayLike<number>): [number, number, number, number] => [
  a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
  a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
  a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
  a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
];