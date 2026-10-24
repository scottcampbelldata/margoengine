// Motion-blur intervals: checks a previous/current transform pair and packs the rigid TRS form the shader rebuilds.
import { decomposeAffine } from '@margoengine/math/affine';
import { composeMatrix } from '@margoengine/math/mat4';
import { interpolateQuaternions } from '@margoengine/math/quat';

/** Relative determinant margin: an interval whose normalized determinant comes closer to 0 is refused. */
const DET_MARGIN = 2 ** -15;
const TRS_TOLERANCE = 1e-5;
const LINEAR_ABOVE = 0.9995;

/** A checked motion interval. */
export interface InstanceMotion {
  /** For 'trs': q0, q1, scale0.xyz and angle, scale1.xyz and 1 / sin(angle) (0 when nearly linear); 16 words. */
  readonly payload?: Float32Array;
  /** World bounds `[minX, minY, minZ, maxX, maxY, maxZ]` over the whole interval. */
  readonly bounds: Float64Array;
}

const fail = (name: string, reason: string): never => {
  throw new RangeError(
    `VoxelPathTracer ${name} motion interval ${reason}; pass a previousMatrix that stays invertible, or motionInterpolation 'trs' for rotations`,
  );
};
const LINEAR = [0, 1, 2, 4, 5, 6, 8, 9, 10];
const determinant = (a: number[], b: number[], c: number[]): number =>
  a[0] * (b[1] * c[2] - b[2] * c[1]) - b[0] * (a[1] * c[2] - a[2] * c[1]) + c[0] * (a[1] * b[2] - a[2] * b[1]);
const largest = (r: ArrayLike<number>): number => Math.max(...LINEAR.map((i) => Math.abs(r[i])));
const columns = (r: ArrayLike<number>, scale: number): number[][] =>
  [0, 1, 2].map((c) => [r[c] / scale, r[4 + c] / scale, r[8 + c] / scale]);
/** Column-major 4x4 from 3x4 rows. */
const matrix = (r: ArrayLike<number>): Float64Array =>
  Float64Array.from([r[0], r[4], r[8], 0, r[1], r[5], r[9], 0, r[2], r[6], r[10], 0, r[3], r[7], r[11], 1]);

/**
 * Refuses a componentwise-interpolated interval whose determinant reaches 0 (the inverse would be NaN mid-shutter):
 * det(B + tD) is a cubic in t, so its endpoints and the roots of its derivative bound it on [0, 1].
 */
function checkMatrix(previous: ArrayLike<number>, current: ArrayLike<number>, name: string): void {
  const scale = Math.max(largest(previous), largest(current));
  if (!(scale > 0)) fail(name, 'is singular');
  const b = columns(previous, scale),
    d = columns(current, scale).map((c, i) => c.map((v, k) => v - b[i][k]));
  const c0 = determinant(b[0], b[1], b[2]),
    c1 = determinant(d[0], b[1], b[2]) + determinant(b[0], d[1], b[2]) + determinant(b[0], b[1], d[2]),
    c2 = determinant(d[0], d[1], b[2]) + determinant(d[0], b[1], d[2]) + determinant(b[0], d[1], d[2]),
    c3 = determinant(d[0], d[1], d[2]);
  const times = [0, 1],
    a = 3 * c3,
    q = 2 * c2;
  if (a === 0) {
    if (q !== 0) times.push(-c1 / q);
  } else {
    const disc = q * q - 4 * a * c1;
    if (disc >= 0) times.push((-q + Math.sqrt(disc)) / (2 * a), (-q - Math.sqrt(disc)) / (2 * a));
  }
  const sign = Math.sign(c0);
  for (const t of times)
    if (t >= 0 && t <= 1 && !(sign * (((c3 * t + c2) * t + c1) * t + c0) > DET_MARGIN))
      fail(name, 'becomes singular between the two transforms');
}

/** Splits a transform's linear part into rotation and signed scale, refusing shear. */
function decompose(rows: ArrayLike<number>, name: string): { q: number[]; scale: number[] } {
  const magnitude = largest(rows),
    m = matrix(rows);
  if (!(magnitude > 0)) fail(name, 'has a singular endpoint');
  for (const c of LINEAR) m[c] /= magnitude;
  m[12] = m[13] = m[14] = 0;
  const parts = decomposeAffine(m, TRS_TOLERANCE);
  if (!parts.lossless || parts.shear.some((v) => !(Math.abs(v) <= TRS_TOLERANCE)))
    fail(name, "has shear, which motionInterpolation 'trs' does not support");
  const scale = parts.scale.map((v) => v * magnitude),
    q = parts.rotation.slice(),
    rebuilt = composeMatrix([0, 0, 0], q, scale, new Float64Array(16)),
    original = matrix(rows);
  for (const i of LINEAR)
    if (!(Math.abs(rebuilt[i] - original[i]) <= TRS_TOLERANCE * magnitude)) fail(name, 'is not a rotation and scale');
  return { q, scale };
}

/**
 * Checks the interval from `previousRows` (shutter open) to `currentRows` (close), both 3x4 row-major, and returns
 * conservative world bounds over it plus, for 'trs', the packed rotation/scale the shader interpolates.
 * @throws RangeError when the interval becomes singular ('matrix'), or has shear or changes handedness ('trs').
 */
export function instanceMotion(
  previousRows: ArrayLike<number>,
  currentRows: ArrayLike<number>,
  size: readonly number[],
  mode: 'matrix' | 'trs',
  name: string,
): InstanceMotion {
  const bounds = new Float64Array([Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity]);
  let payload: Float32Array | undefined;
  if (mode === 'trs') {
    const open = decompose(previousRows, name),
      close = decompose(currentRows, name);
    if (open.scale.some((v, i) => Math.sign(v) !== Math.sign(close.scale[i]))) fail(name, 'changes handedness');
    const q0 = interpolateQuaternions(open.q, open.q, 0, LINEAR_ABOVE),
      q1 = interpolateQuaternions(q0, close.q, 1, LINEAR_ABOVE),
      dot = Math.max(
        0,
        Math.min(
          1,
          q0.reduce((sum, v, i) => sum + v * q1[i], 0),
        ),
      ),
      angle = Math.acos(dot);
    payload = new Float32Array(16);
    payload.set(q0, 0);
    payload.set(q1, 4);
    payload.set(open.scale, 8);
    payload.set(close.scale, 12);
    payload[11] = angle;
    payload[15] = dot > LINEAR_ABOVE ? 0 : 1 / Math.sin(angle);
    if (!payload.every(Number.isFinite)) fail(name, 'is out of Float32 range');
    // A rotating box stays within its largest scaled diagonal around the moving origin.
    const radius = Math.hypot(...size.map((v, i) => v * Math.max(Math.abs(open.scale[i]), Math.abs(close.scale[i]))));
    for (let a = 0; a < 3; a++) {
      bounds[a] = Math.min(previousRows[a * 4 + 3], currentRows[a * 4 + 3]) - radius;
      bounds[a + 3] = Math.max(previousRows[a * 4 + 3], currentRows[a * 4 + 3]) + radius;
    }
  } else checkMatrix(previousRows, currentRows, name);
  // Componentwise interpolation keeps each corner on the segment between its endpoint positions.
  for (const rows of [previousRows, currentRows])
    for (let corner = 0; corner < 8; corner++)
      for (let a = 0; a < 3; a++) {
        const o = a * 4,
          v =
            rows[o] * (corner & 1 ? size[0] : 0) +
            rows[o + 1] * (corner & 2 ? size[1] : 0) +
            rows[o + 2] * (corner & 4 ? size[2] : 0) +
            rows[o + 3];
        bounds[a] = Math.min(bounds[a], v);
        bounds[a + 3] = Math.max(bounds[a + 3], v);
      }
  // Pad outward for Float32 rounding in the shader.
  for (let a = 0; a < 3; a++) {
    const pad = 2 ** -16 * Math.max(1, Math.abs(bounds[a]), Math.abs(bounds[a + 3]));
    bounds[a] -= pad;
    bounds[a + 3] += pad;
  }
  return { payload, bounds };
}
