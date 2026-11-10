// Editing Gaussian splat clouds on the CPU: keep or crop splats, transform a cloud (covariances and view-dependent
// colour included), merge clouds, and build a coarser level of detail by merging the splats of each grid cell with
// matched moments. Kept out of the renderer so a viewer that only draws does not bundle it.
import { validateSplats, type SplatData } from './data.js';

/** A region of {@link cropSplats}: an axis-aligned box or a sphere, world units. */
export type SplatRegion =
  | { box: { min: readonly [number, number, number]; max: readonly [number, number, number] } }
  | { sphere: { center: readonly [number, number, number]; radius: number } };

const coefficients = (data: SplatData, count: number) =>
  data.sphericalHarmonics ? data.sphericalHarmonics.length / count / 3 : 0;

/**
 * The splats for which `keep(index, data)` returns true, as a new cloud (SH included).
 * @throws RangeError when nothing is kept or `data` is invalid.
 */
export function filterSplats(data: SplatData, keep: (index: number, data: SplatData) => boolean): SplatData {
  const count = validateSplats(data);
  if (typeof keep !== 'function') throw new TypeError('filterSplats needs a keep(index) function');
  const kept: number[] = [];
  for (let i = 0; i < count; i++) if (keep(i, data)) kept.push(i);
  return pick(data, kept, coefficients(data, count));
}

function pick(data: SplatData, kept: readonly number[], perSplat: number): SplatData {
  if (!kept.length) throw new RangeError('No splats are left; widen the region or the filter.');
  const n = kept.length,
    positions = new Float32Array(n * 3),
    covariances = new Float32Array(n * 6),
    colors = new Float32Array(n * 4),
    sh = perSplat ? new Float32Array(n * perSplat * 3) : undefined;
  kept.forEach((i, k) => {
    positions.set(data.positions.subarray(i * 3, i * 3 + 3), k * 3);
    covariances.set(data.covariances.subarray(i * 6, i * 6 + 6), k * 6);
    colors.set(data.colors.subarray(i * 4, i * 4 + 4), k * 4);
    if (sh) sh.set(data.sphericalHarmonics!.subarray(i * perSplat * 3, (i + 1) * perSplat * 3), k * perSplat * 3);
  });
  return sh ? { positions, covariances, colors, sphericalHarmonics: sh } : { positions, covariances, colors };
}

/**
 * The splats whose centres lie inside `region` (or outside it, with `invert`): crop a capture to its subject or cut
 * away a floater. Returns a new cloud.
 * @throws RangeError for an invalid region or when no splat is left.
 */
export function cropSplats(data: SplatData, region: SplatRegion, options: { invert?: boolean } = {}): SplatData {
  const invert = options.invert ?? false;
  const finite3 = (v: unknown) =>
    Array.isArray(v) && v.length === 3 && v.every((c) => typeof c === 'number' && Number.isFinite(c));
  let inside: (x: number, y: number, z: number) => boolean;
  if (region && 'box' in region && finite3(region.box?.min) && finite3(region.box?.max)) {
    const { min, max } = region.box;
    inside = (x, y, z) => x >= min[0] && x <= max[0] && y >= min[1] && y <= max[1] && z >= min[2] && z <= max[2];
  } else if (region && 'sphere' in region && finite3(region.sphere?.center) && region.sphere.radius >= 0) {
    const { center: c, radius } = region.sphere;
    inside = (x, y, z) => (x - c[0]) ** 2 + (y - c[1]) ** 2 + (z - c[2]) ** 2 <= radius * radius;
  } else
    throw new RangeError(
      'Invalid crop region; pass {box: {min: [x, y, z], max: [x, y, z]}} or {sphere: {center: [x, y, z], radius}}',
    );
  const p = data?.positions;
  return filterSplats(data, (i) => inside(p[i * 3], p[i * 3 + 1], p[i * 3 + 2]) !== invert);
}

/** Real SH basis through degree 3, the sign pattern and order of the splat renderer (Sloan 2008, App. A). */
function basis(x: number, y: number, z: number, out: Float64Array): Float64Array {
  out[0] = 0.2820947918;
  out[1] = -0.4886025119 * y;
  out[2] = 0.4886025119 * z;
  out[3] = -0.4886025119 * x;
  out[4] = 1.0925484306 * x * y;
  out[5] = -1.0925484306 * y * z;
  out[6] = 0.3153915653 * (3 * z * z - 1);
  out[7] = -1.0925484306 * x * z;
  out[8] = 0.5462742153 * (x * x - y * y);
  out[9] = -0.5900435899 * y * (3 * x * x - y * y);
  out[10] = 2.8906114426 * x * y * z;
  out[11] = -0.4570457995 * y * (5 * z * z - 1);
  out[12] = 0.3731763326 * z * (5 * z * z - 3);
  out[13] = -0.4570457995 * x * (5 * z * z - 1);
  out[14] = 1.4453057213 * z * (x * x - y * y);
  out[15] = -0.5900435899 * x * (x * x - 3 * y * y);
  out[16] = 2.5033429418 * x * y * (x * x - y * y);
  out[17] = -1.7701307698 * y * z * (3 * x * x - y * y);
  out[18] = 0.9461746958 * x * y * (7 * z * z - 1);
  out[19] = -0.6690465436 * y * z * (7 * z * z - 3);
  out[20] = 0.1057855469 * (35 * z ** 4 - 30 * z * z + 3);
  out[21] = -0.6690465436 * x * z * (7 * z * z - 3);
  out[22] = 0.4730873479 * (x * x - y * y) * (7 * z * z - 1);
  out[23] = -1.7701307698 * x * z * (x * x - 3 * y * y);
  out[24] = 0.6258357354 * (x ** 4 - 6 * x * x * y * y + y ** 4);
  return out;
}

/**
 * The n x n matrix T with coefficients' = T coefficients for an SH function rotated by `r` (row-major 3x3, applied to
 * directions): least squares on 128 spread directions, exact because a rotation keeps each band.
 */
function shRotation(r: readonly number[], n: number): Float64Array {
  const samples = 128,
    b = new Float64Array(n),
    rows: Float64Array[] = [],
    rotated: Float64Array[] = [];
  for (let s = 0; s < samples; s++) {
    // Fibonacci sphere directions.
    const y = 1 - (2 * (s + 0.5)) / samples,
      radius = Math.sqrt(1 - y * y),
      phi = s * Math.PI * (3 - Math.sqrt(5)),
      d = [Math.cos(phi) * radius, y, Math.sin(phi) * radius];
    rows.push(basis(d[0], d[1], d[2], new Float64Array(n)).slice(0, n));
    // f'(d) = f(R^T d): sample the original basis at the inverse-rotated direction.
    const back = [
      r[0] * d[0] + r[3] * d[1] + r[6] * d[2],
      r[1] * d[0] + r[4] * d[1] + r[7] * d[2],
      r[2] * d[0] + r[5] * d[1] + r[8] * d[2],
    ];
    rotated.push(basis(back[0], back[1], back[2], b).slice(0, n));
  }
  // Normal equations (B^T B) T = B^T B', solved by Gaussian elimination with partial pivoting.
  const m = new Float64Array(n * n),
    rhs = new Float64Array(n * n);
  for (let s = 0; s < samples; s++)
    for (let i = 0; i < n; i++)
      for (let j = 0; j < n; j++) {
        m[i * n + j] += rows[s][i] * rows[s][j];
        rhs[i * n + j] += rows[s][i] * rotated[s][j];
      }
  for (let c = 0; c < n; c++) {
    let pivot = c;
    for (let r2 = c + 1; r2 < n; r2++) if (Math.abs(m[r2 * n + c]) > Math.abs(m[pivot * n + c])) pivot = r2;
    for (let k = 0; k < n; k++) {
      [m[c * n + k], m[pivot * n + k]] = [m[pivot * n + k], m[c * n + k]];
      [rhs[c * n + k], rhs[pivot * n + k]] = [rhs[pivot * n + k], rhs[c * n + k]];
    }
    for (let r2 = 0; r2 < n; r2++) {
      if (r2 === c) continue;
      const f = m[r2 * n + c] / m[c * n + c];
      if (!f) continue;
      for (let k = 0; k < n; k++) {
        m[r2 * n + k] -= f * m[c * n + k];
        rhs[r2 * n + k] -= f * rhs[c * n + k];
      }
    }
  }
  for (let r2 = 0; r2 < n; r2++) for (let k = 0; k < n; k++) rhs[r2 * n + k] /= m[r2 * n + r2];
  return rhs; // row i: new coefficient i from the old ones
}

/**
 * The cloud moved by a 4x4 affine `matrix` (column-major, as Margo's math and glTF use): positions by the matrix,
 * covariances by its linear part (A Σ Aᵀ, so scale and shear stretch the splats), and spherical harmonics turned by
 * the matrix's rotation (from its polar decomposition), so view-dependent colour follows the turn. Returns a new cloud.
 * @throws RangeError for a matrix that is not 16 finite numbers with an invertible linear part.
 */
export function transformSplats(data: SplatData, matrix: ArrayLike<number>): SplatData {
  const count = validateSplats(data);
  if (!matrix || matrix.length !== 16 || !Array.from(matrix).every(Number.isFinite))
    throw new RangeError('Invalid splat transform; pass a 4x4 column-major matrix of 16 finite numbers');
  const m = matrix,
    a = [m[0], m[4], m[8], m[1], m[5], m[9], m[2], m[6], m[10]], // row-major linear part
    det = a[0] * (a[4] * a[8] - a[5] * a[7]) - a[1] * (a[3] * a[8] - a[5] * a[6]) + a[2] * (a[3] * a[7] - a[4] * a[6]);
  if (!(Math.abs(det) > 1e-12))
    throw new RangeError('A splat transform needs an invertible linear part (no zero scale); fix the matrix.');
  const positions = new Float32Array(count * 3),
    covariances = new Float32Array(count * 6),
    colors = data.colors.slice();
  for (let i = 0; i < count; i++) {
    const x = data.positions[i * 3],
      y = data.positions[i * 3 + 1],
      z = data.positions[i * 3 + 2];
    for (let r = 0; r < 3; r++) positions[i * 3 + r] = a[r * 3] * x + a[r * 3 + 1] * y + a[r * 3 + 2] * z + m[12 + r];
    const c = data.covariances.subarray(i * 6, i * 6 + 6),
      s = [c[0], c[1], c[2], c[1], c[3], c[4], c[2], c[4], c[5]],
      as = new Float64Array(9);
    for (let r = 0; r < 3; r++)
      for (let k = 0; k < 3; k++) as[r * 3 + k] = a[r * 3] * s[k] + a[r * 3 + 1] * s[3 + k] + a[r * 3 + 2] * s[6 + k];
    let n = 0;
    for (let r = 0; r < 3; r++)
      for (let k = r; k < 3; k++)
        covariances[i * 6 + n++] = as[r * 3] * a[k * 3] + as[r * 3 + 1] * a[k * 3 + 1] + as[r * 3 + 2] * a[k * 3 + 2];
  }
  const out: SplatData = { positions, covariances, colors };
  const sh = data.sphericalHarmonics;
  if (sh) {
    const n = coefficients(data, count),
      t = shRotation(polarRotation(a), n),
      turned = new Float32Array(sh.length);
    for (let i = 0; i < count; i++)
      for (let c = 0; c < 3; c++)
        for (let row = 0; row < n; row++) {
          let v = 0;
          for (let k = 0; k < n; k++) v += t[row * n + k] * sh[(i * n + k) * 3 + c];
          turned[(i * n + row) * 3 + c] = v;
        }
    out.sphericalHarmonics = turned;
  }
  validateSplats(out);
  return out;
}

/** The orthogonal factor of a row-major 3x3 matrix (polar decomposition by Newton iteration Q ← (Q + Q⁻ᵀ) / 2). */
function polarRotation(a: readonly number[]): number[] {
  let q = a.slice();
  for (let iteration = 0; iteration < 64; iteration++) {
    const det =
        q[0] * (q[4] * q[8] - q[5] * q[7]) - q[1] * (q[3] * q[8] - q[5] * q[6]) + q[2] * (q[3] * q[7] - q[4] * q[6]),
      // Inverse transpose = cofactor matrix / det.
      cof = [
        q[4] * q[8] - q[5] * q[7],
        q[5] * q[6] - q[3] * q[8],
        q[3] * q[7] - q[4] * q[6],
        q[2] * q[7] - q[1] * q[8],
        q[0] * q[8] - q[2] * q[6],
        q[1] * q[6] - q[0] * q[7],
        q[1] * q[5] - q[2] * q[4],
        q[2] * q[3] - q[0] * q[5],
        q[0] * q[4] - q[1] * q[3],
      ],
      next = q.map((v, i) => (v + cof[i] / det) / 2);
    const change = next.reduce((sum, v, i) => sum + Math.abs(v - q[i]), 0);
    q = next;
    if (change < 1e-14) break;
  }
  return q;
}

/**
 * One cloud from several (a scan in parts, a prop placed in a capture). The clouds must all have spherical harmonics
 * of the same degree or none.
 * @throws RangeError for an empty list, mixed SH degrees, or more than 3,000,000 splats in all.
 */
export function mergeSplats(...clouds: SplatData[]): SplatData {
  if (!clouds.length) throw new RangeError('mergeSplats needs at least one cloud');
  const counts = clouds.map((cloud) => validateSplats(cloud)),
    degrees = new Set(clouds.map((cloud, i) => coefficients(cloud, counts[i])));
  if (degrees.size > 1)
    throw new RangeError(
      'Merged clouds need the same spherical-harmonics degree; drop sphericalHarmonics from all or give all the same degree.',
    );
  const total = counts.reduce((a, b) => a + b, 0),
    n = [...degrees][0],
    positions = new Float32Array(total * 3),
    covariances = new Float32Array(total * 6),
    colors = new Float32Array(total * 4),
    sh = n ? new Float32Array(total * n * 3) : undefined;
  let at = 0;
  clouds.forEach((cloud, k) => {
    positions.set(cloud.positions, at * 3);
    covariances.set(cloud.covariances, at * 6);
    colors.set(cloud.colors, at * 4);
    if (sh) sh.set(cloud.sphericalHarmonics!, at * n * 3);
    at += counts[k];
  });
  const out: SplatData = sh
    ? { positions, covariances, colors, sphericalHarmonics: sh }
    : { positions, covariances, colors };
  validateSplats(out);
  return out;
}

/**
 * A coarser level of detail: the splats of each `cellSize` grid cell merge into one Gaussian with the same weighted
 * mean and second moment (covariance of the mixture), weighted by opacity times volume. Colour, opacity and SH are
 * the weighted means. Use it for distant views or a quick preview; `cellSize` sets the detail kept.
 * @throws RangeError for a cellSize that is not a positive finite number.
 */
export function decimateSplats(data: SplatData, options: { cellSize: number }): SplatData {
  const count = validateSplats(data),
    size = options?.cellSize;
  if (!(size > 0 && size < Infinity)) throw new RangeError('decimateSplats needs a cellSize above 0, world units');
  const n = coefficients(data, count),
    cells = new Map<string, number[]>(),
    p = data.positions;
  for (let i = 0; i < count; i++) {
    const key = `${Math.floor(p[i * 3] / size)},${Math.floor(p[i * 3 + 1] / size)},${Math.floor(p[i * 3 + 2] / size)}`;
    let list = cells.get(key);
    if (!list) cells.set(key, (list = []));
    list.push(i);
  }
  const total = cells.size,
    positions = new Float32Array(total * 3),
    covariances = new Float32Array(total * 6),
    colors = new Float32Array(total * 4),
    sh = n ? new Float32Array(total * n * 3) : undefined;
  let out = 0;
  for (const members of cells.values()) {
    const weights = members.map((i) => {
      const c = data.covariances.subarray(i * 6, i * 6 + 6),
        det =
          c[0] * (c[3] * c[5] - c[4] * c[4]) - c[1] * (c[1] * c[5] - c[4] * c[2]) + c[2] * (c[1] * c[4] - c[3] * c[2]);
      return Math.max(data.colors[i * 4 + 3], 1e-6) * Math.sqrt(Math.max(det, 0));
    });
    const sum = weights.reduce((a, b) => a + b, 0) || 1,
      mean = [0, 0, 0];
    members.forEach((i, k) => {
      for (let a = 0; a < 3; a++) mean[a] += (weights[k] / sum) * p[i * 3 + a];
    });
    const second = new Float64Array(6);
    members.forEach((i, k) => {
      const w = weights[k] / sum,
        d = [p[i * 3] - mean[0], p[i * 3 + 1] - mean[1], p[i * 3 + 2] - mean[2]],
        c = data.covariances.subarray(i * 6, i * 6 + 6);
      let j = 0;
      for (let r = 0; r < 3; r++) for (let q = r; q < 3; q++, j++) second[j] += w * (c[j] + d[r] * d[q]);
      for (let a = 0; a < 4; a++) colors[out * 4 + a] += w * data.colors[i * 4 + a];
      if (sh) for (let a = 0; a < n * 3; a++) sh[out * n * 3 + a] += w * data.sphericalHarmonics![i * n * 3 + a];
    });
    positions.set(mean, out * 3);
    covariances.set(second, out * 6);
    out++;
  }
  const result: SplatData = sh
    ? { positions, covariances, colors, sphericalHarmonics: sh }
    : { positions, covariances, colors };
  for (let i = 0; i < total * 4; i++)
    result.colors[i] = Math.min(i % 4 === 3 ? 1.5625 : 1, Math.max(0, result.colors[i]));
  validateSplats(result);
  return result;
}
