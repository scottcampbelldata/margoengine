// Clean-room spectral analysis and ordinary log-linear diffusion fitting. Sources: docs/clean-room.md.
import { rangeError } from '../../shared/errors.js';

/** Symmetric coefficients in xx, yy, zz, xy, xz, yz order. Units remain caller defined. */
export type SymmetricTensor = readonly [number, number, number, number, number, number];
/** Descending algebraic eigenvalues and column-major, right-handed orthonormal eigenvectors. */
export interface TensorEigen {
  readonly values: Float64Array;
  readonly vectors: Float64Array;
  /** sqrt(3/2 sum((lambda-mean)^2)/sum(lambda^2)); zero for a zero tensor. */
  readonly fa: number;
  /** Absolute Euclidean eigen residual, measured against the supplied tensor. */
  readonly residual: number;
}
/** @internal One coded, actionable error contract for tensor entries. */
export function tensorError(message: string): never {
  throw rangeError(`Tensor field: ${message}; correct the tensors or options`, 'sciviz');
}
/** Stable scaled largest-pivot Jacobi decomposition, including zero, repeated and signed spectra. */
export function tensorEigen(tensor: ArrayLike<number>): TensorEigen {
  if (tensor.length !== 6 || Array.from(tensor).some((v) => !Number.isFinite(v)))
    tensorError('symmetric samples need six finite coefficients');
  const scale = Math.max(...Array.from(tensor, Math.abs)),
    original = [tensor[0], tensor[3], tensor[4], tensor[3], tensor[1], tensor[5], tensor[4], tensor[5], tensor[2]],
    a = original.map((v) => (scale ? v / scale : 0)),
    v = [1, 0, 0, 0, 1, 0, 0, 0, 1];
  for (let iteration = 0; iteration < 48; iteration++) {
    let p = 0,
      q = 1;
    for (let i = 0; i < 3; i++)
      for (let j = i + 1; j < 3; j++)
        if (Math.abs(a[i * 3 + j]) > Math.abs(a[p * 3 + q])) {
          p = i;
          q = j;
        }
    const b = a[p * 3 + q];
    if (Math.abs(b) <= 2e-15) break;
    const tau = (a[q * 3 + q] - a[p * 3 + p]) / (2 * b),
      tangent = (tau >= 0 ? 1 : -1) / (Math.abs(tau) + Math.hypot(1, tau)),
      c = 1 / Math.hypot(1, tangent),
      s = tangent * c;
    for (let k = 0; k < 3; k++)
      if (k !== p && k !== q) {
        const x = a[k * 3 + p],
          y = a[k * 3 + q];
        a[k * 3 + p] = a[p * 3 + k] = c * x - s * y;
        a[k * 3 + q] = a[q * 3 + k] = s * x + c * y;
      }
    a[p * 3 + p] -= tangent * b;
    a[q * 3 + q] += tangent * b;
    a[p * 3 + q] = a[q * 3 + p] = 0;
    for (let k = 0; k < 3; k++) {
      const x = v[p * 3 + k],
        y = v[q * 3 + k];
      v[p * 3 + k] = c * x - s * y;
      v[q * 3 + k] = s * x + c * y;
    }
  }
  const order = [0, 1, 2].sort((p, q) => a[q * 3 + q] - a[p * 3 + p]),
    values = Float64Array.from(order, (i) => a[i * 3 + i] * scale),
    vectors = Float64Array.from(order.flatMap((i) => v.slice(i * 3, i * 3 + 3)));
  if (values.some((value) => !Number.isFinite(value)))
    tensorError('eigenvalues exceed float64 range; rescale tensor units');
  for (let col = 0; col < 2; col++) {
    const offset = col * 3,
      axis = [0, 1, 2].sort((x, y) => Math.abs(vectors[offset + y]) - Math.abs(vectors[offset + x]))[0];
    if (vectors[offset + axis] < 0) for (let k = 0; k < 3; k++) vectors[offset + k] *= -1;
  }
  vectors[6] = vectors[1] * vectors[5] - vectors[2] * vectors[4];
  vectors[7] = vectors[2] * vectors[3] - vectors[0] * vectors[5];
  vectors[8] = vectors[0] * vectors[4] - vectors[1] * vectors[3];
  let residual = 0;
  for (let col = 0; col < 3; col++)
    for (let row = 0; row < 3; row++)
      residual = Math.hypot(
        residual,
        original[row * 3] * vectors[col * 3] +
          original[row * 3 + 1] * vectors[col * 3 + 1] +
          original[row * 3 + 2] * vectors[col * 3 + 2] -
          values[col] * vectors[col * 3 + row],
      );
  const normalized = scale ? Array.from(values, (n) => n / scale) : [0, 0, 0],
    mean = normalized.reduce((a, v) => a + v, 0) / 3,
    denom = normalized.reduce((a, v) => a + v * v, 0),
    fa = denom ? Math.sqrt((1.5 * normalized.reduce((a, v) => a + (v - mean) ** 2, 0)) / denom) : 0;
  return { values, vectors, fa, residual };
}

/** Diffusion measurements in volume-major order, matching NIfTI frame storage. */
export interface DiffusionMeasurements {
  readonly signals: ArrayLike<number>;
  readonly voxels: number;
  /** s/mm^2, one value per volume. */
  readonly bValues: ArrayLike<number>;
  /** Unit direction xyz per volume, in the coordinate basis of the desired tensors. */
  readonly gradients: ArrayLike<number>;
}
/** Ordinary linear least squares, not a constrained or weighted nonlinear fit. */
export interface DiffusionFitOptions {
  /** Positive signal floor before log, default 1 in the input signal units. */
  readonly minSignal?: number;
  /** Optional voxel mask, zero excludes a voxel. Default all voxels. */
  readonly mask?: ArrayLike<number>;
  readonly signal?: AbortSignal;
}
/** Raw unconstrained tensor estimates, in mm^2/s for b-values in s/mm^2. */
export interface DiffusionFit {
  readonly method: 'ordinary-linear-least-squares';
  /** Six coefficients per voxel in xx,yy,zz,xy,xz,yz order. Excluded voxels contain NaN. */
  readonly tensors: Float64Array;
  readonly baseline: Float64Array;
  /** RMS residual in log-signal units. */
  readonly residual: Float64Array;
  readonly valid: Uint8Array;
  /** Negative eigenvalues are preserved, with a flag for scientific interpretation. */
  readonly nonPositive: Uint8Array;
}
/** Fit log S = log S0 - b g^T D g by a shared, twice-reorthogonalized QR factorization. */
export async function fitDiffusionTensor(
  input: DiffusionMeasurements,
  options: DiffusionFitOptions = {},
): Promise<DiffusionFit> {
  options.signal?.throwIfAborted();
  const { voxels, bValues, gradients, signals } = input,
    m = bValues.length,
    floor = options.minSignal ?? 1;
  if (
    !Number.isSafeInteger(voxels) ||
    voxels < 1 ||
    m < 7 ||
    m > 4096 ||
    signals.length !== voxels * m ||
    gradients.length !== m * 3 ||
    !(floor > 0) ||
    !Number.isFinite(floor) ||
    (options.mask && options.mask.length !== voxels)
  )
    tensorError('check measurement, gradient and mask shapes and a positive minSignal');
  const columns = Array.from({ length: 7 }, () => new Float64Array(m));
  for (let i = 0; i < m; i++) {
    const b = bValues[i],
      g = [gradients[i * 3], gradients[i * 3 + 1], gradients[i * 3 + 2]],
      norm = Math.hypot(...g);
    if (!Number.isFinite(b) || b < 0 || g.some((v) => !Number.isFinite(v)) || (b > 0 && Math.abs(norm - 1) > 1e-4))
      tensorError('b-values must be nonnegative and diffusion gradients unit length');
    if (b > 0) for (let k = 0; k < 3; k++) g[k] /= norm;
    const row =
      b === 0
        ? [1, 0, 0, 0, 0, 0, 0]
        : [
            1,
            -b * g[0] ** 2,
            -b * g[1] ** 2,
            -b * g[2] ** 2,
            -2 * b * g[0] * g[1],
            -2 * b * g[0] * g[2],
            -2 * b * g[1] * g[2],
          ];
    row.forEach((v, k) => (columns[k][i] = v));
  }
  const q: Float64Array[] = [],
    r = Array.from({ length: 7 }, () => new Float64Array(7));
  for (let k = 0; k < 7; k++) {
    const column = columns[k].slice(),
      originalNorm = Math.hypot(...column);
    for (let pass = 0; pass < 2; pass++)
      for (let j = 0; j < k; j++) {
        let dot = 0;
        for (let i = 0; i < m; i++) dot += q[j][i] * column[i];
        r[j][k] += dot;
        for (let i = 0; i < m; i++) column[i] -= dot * q[j][i];
      }
    const norm = Math.hypot(...column);
    if (norm <= Math.max(1, originalNorm) * 1e-10)
      tensorError('the diffusion design is rank deficient; supply baseline and six independent tensor directions');
    r[k][k] = norm;
    for (let i = 0; i < m; i++) column[i] /= norm;
    q.push(column);
  }
  const tensors = new Float64Array(voxels * 6).fill(NaN),
    baseline = new Float64Array(voxels).fill(NaN),
    residual = new Float64Array(voxels).fill(NaN),
    valid = new Uint8Array(voxels),
    nonPositive = new Uint8Array(voxels),
    y = new Float64Array(m),
    beta = new Float64Array(7);
  for (let voxel = 0; voxel < voxels; voxel++) {
    if (voxel % 2048 === 0) {
      options.signal?.throwIfAborted();
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }
    if (options.mask && !options.mask[voxel]) continue;
    for (let i = 0; i < m; i++) {
      const s = signals[i * voxels + voxel];
      if (!Number.isFinite(s)) tensorError('signals must be finite; exclude missing voxels with a mask');
      y[i] = Math.log(Math.max(floor, s));
    }
    for (let k = 0; k < 7; k++) {
      beta[k] = 0;
      for (let i = 0; i < m; i++) beta[k] += q[k][i] * y[i];
    }
    for (let k = 6; k >= 0; k--) {
      for (let j = k + 1; j < 7; j++) beta[k] -= r[k][j] * beta[j];
      beta[k] /= r[k][k];
    }
    tensors.set(beta.subarray(1), voxel * 6);
    baseline[voxel] = Math.exp(beta[0]);
    let sum = 0;
    for (let i = 0; i < m; i++) {
      let predicted = 0;
      for (let k = 0; k < 7; k++) predicted += columns[k][i] * beta[k];
      sum += (predicted - y[i]) ** 2;
    }
    residual[voxel] = Math.sqrt(sum / m);
    valid[voxel] = 1;
    const scale = Math.max(...Array.from(beta.subarray(1), Math.abs)),
      [a, b, c, d, e, f] = Array.from(beta.subarray(1), (v) => (scale ? v / scale : 0));
    nonPositive[voxel] =
      a > 0 && a * b - d * d > 0 && a * b * c + 2 * d * e * f - a * f * f - b * e * e - c * d * d > 0 ? 0 : 1;
  }
  options.signal?.throwIfAborted();
  return { method: 'ordinary-linear-least-squares', tensors, baseline, residual, valid, nonPositive };
}
