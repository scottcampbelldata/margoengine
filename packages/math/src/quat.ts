// Quaternions as plain [x, y, z, w] arrays, shared by the packages (bundled into each). Keep the operand order: the
// packages rely on bit-identical results (examples/package-benchmarks/proofs/math-consolidation.proof.js).

/** Quaternion for XYZ Euler angles in radians (qX * qY * qZ), the convention of core `Mesh.setRotation`. */
export function eulerToQuaternion(x: number, y: number, z: number): [number, number, number, number] {
  const sx = Math.sin(x / 2),
    cx = Math.cos(x / 2),
    sy = Math.sin(y / 2),
    cy = Math.cos(y / 2),
    sz = Math.sin(z / 2),
    cz = Math.cos(z / 2);
  return [
    sx * cy * cz + cx * sy * sz,
    cx * sy * cz - sx * cy * sz,
    cx * cy * sz + sx * sy * cz,
    cx * cy * cz - sx * sy * sz,
  ];
}

/** a * b (apply b, then a) as a new array. */
export const multiplyQuaternions = (a: ArrayLike<number>, b: ArrayLike<number>): [number, number, number, number] => [
  a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
  a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
  a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
  a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
];

/**
 * Interpolates unit quaternions `a` to `b` (`[x, y, z, w]`) along the shorter arc with an explicit close-angle switch,
 * as a new normalized array. With `dot = a · b` (b negated first when it is negative, then clamped to 1): above
 * `linearAbove` the blend is linear, `a + (b - a) * t`; otherwise it is spherical,
 * `a * sin((1 - t) θ) / sin θ + b * sin(t θ) / sin θ` with `θ = acos(dot)`. The result is divided by its length in
 * both cases, so `t = 0` and `t = 1` return normalized copies of `a` and of `b` on `a`'s side.
 *
 * `linearAbove = 0.9995` reproduces the close-angle curve Margo Voxel Studio saved before version 1 of the engine.
 * `Quaternion.slerp` keeps its own switch; this is the selectable contract for data that depends on this one.
 * @param t Blend factor, usually 0-1 (not checked; values outside extrapolate).
 * @param linearAbove The `dot` above which the blend is linear, from 0 to below 1.
 * @throws RangeError when `linearAbove` is not a number from 0 to below 1.
 */
export function interpolateQuaternions(
  a: ArrayLike<number>,
  b: ArrayLike<number>,
  t: number,
  linearAbove: number,
): [number, number, number, number] {
  if (!(linearAbove >= 0 && linearAbove < 1))
    throw new RangeError(`Quaternion linearAbove ${linearAbove} is invalid; pass a dot from 0 to below 1, e.g. 0.9995`);
  let dot = a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3],
    sign = 1;
  if (dot < 0) {
    sign = -1;
    dot = -dot;
  }
  dot = Math.min(1, dot);
  const out: [number, number, number, number] = [0, 0, 0, 0];
  if (dot > linearAbove) for (let i = 0; i < 4; i++) out[i] = a[i] + (b[i] * sign - a[i]) * t;
  else {
    const angle = Math.acos(dot),
      sin = Math.sin(angle),
      left = Math.sin((1 - t) * angle) / sin,
      right = Math.sin(t * angle) / sin;
    for (let i = 0; i < 4; i++) out[i] = a[i] * left + b[i] * sign * right;
  }
  const length = Math.hypot(out[0], out[1], out[2], out[3]);
  for (let i = 0; i < 4; i++) out[i] /= length;
  return out;
}
