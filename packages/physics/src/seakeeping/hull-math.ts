// Helpers of the hull solver that need no solver state: vector and symmetric six-by-six algebra, the slam table copy, the
// sea checks and the interpolation. Split from solver.ts along this seam.
import type { FlowSample, SeaWater } from '@margoengine/math/fields';
import { WET_INERTIA_WORDS } from '../crush/contact-inertia.js';
import { hullError } from './errors.js';
import type { SlamStation } from './slamming.js';
import { type HullSlammingTable, slamMeshHash } from './slamming-table.js';
import type { HullMesh, SeaQuery, Vec3 } from './wetted.js';

export function finiteHullVector(value: readonly number[] | undefined): value is Vec3 {
  return value?.length === 3 && Number.isFinite(value[0]) && Number.isFinite(value[1]) && Number.isFinite(value[2]);
}

export function copySlammingTable(
  table: HullSlammingTable,
  mesh: HullMesh,
  density: number,
  stations: number,
): SlamStation[] {
  if (table.stations !== stations || table.density !== density || table.meshHash !== slamMeshHash(mesh))
    throw hullError(
      'unsupported',
      'The slam table does not match this hull. Bake it with the same body-local mesh, sea density and station count.',
    );
  const { profiles, levels } = table;
  if (
    !Number.isSafeInteger(levels) ||
    levels < 1 ||
    !Array.isArray(profiles) ||
    profiles.length === 0 ||
    profiles.length > stations
  )
    throw hullError('unsupported', 'The slam table has invalid profile counts. Supply a table from bakeHullSlamming.');
  return profiles.map((profile, i) => {
    if (!profile)
      throw hullError('unsupported', 'A slam profile is missing. Supply every profile returned by bakeHullSlamming.');
    const { x, width, keel, heights, wetted, slope } = profile;
    if (
      ![x, width, keel].every(Number.isFinite) ||
      !(width > 0) ||
      (i > 0 && !(x > profiles[i - 1]!.x)) ||
      !(heights instanceof Float64Array && wetted instanceof Float64Array && slope instanceof Float64Array) ||
      heights.length < 2 ||
      heights.length > levels + 1 ||
      heights[0] !== 0 ||
      wetted.length !== heights.length ||
      slope.length !== heights.length ||
      !heights.every((h, k) => Number.isFinite(h) && (k === 0 || h > heights[k - 1]!)) ||
      !wetted.every((w, k) => Number.isFinite(w) && w >= (k > 0 ? wetted[k - 1]! : 0)) ||
      !slope.every((s) => Number.isFinite(s) && s >= 0)
    )
      throw hullError(
        'unsupported',
        'A slam profile is invalid. Supply the ordered finite profiles from bakeHullSlamming.',
      );
    return { x, width, keel, heights: heights.slice(), wetted: wetted.slice(), slope: slope.slice() };
  });
}

export function hullHistoryBytes(words: number): number {
  const bytes = words * Float64Array.BYTES_PER_ELEMENT;
  if (!Number.isSafeInteger(bytes) || bytes > 0x1_0000_0000)
    throw hullError('unsupported', 'Hull wave history exceeds Wasm memory. Reduce the history span or station count.');
  return bytes;
}

export function checkedHullSea(sea: SeaQuery): SeaQuery {
  return {
    get density() {
      const density = sea.density;
      if (density !== undefined && !(density > 0 && Number.isFinite(density)))
        throw hullError('failed', 'The sea density is invalid. Return positive finite kilograms per cubic metre.');
      return density;
    },
    elevation: (x, z, time) => {
      const height = sea.elevation(x, z, time);
      if (!Number.isFinite(height))
        throw hullError('failed', 'The sea elevation is invalid. Return finite local metres for each hull query.');
      return height;
    },
    pressure:
      sea.pressure &&
      ((x, y, z, time) => {
        const pressure = sea.pressure!(x, y, z, time);
        if (!Number.isFinite(pressure))
          throw hullError('failed', 'The sea pressure is invalid. Return finite gauge pascals for each hull query.');
        return pressure;
      }),
  };
}

export function hullWaterVelocity(water: SeaWater, x: number, y: number, z: number, t: number, out: FlowSample): Vec3 {
  const velocity = water.sample(x, y, z, t, out)?.velocity;
  if (!finiteHullVector(velocity))
    throw hullError(
      'failed',
      'Water velocity at the hull is invalid. Return three finite metres-per-second components.',
    );
  return velocity;
}

export function rotate(q: readonly [number, number, number, number], v: Vec3): [number, number, number] {
  const [x, y, z, w] = q,
    tx = 2 * (y * v[2] - z * v[1]),
    ty = 2 * (z * v[0] - x * v[2]),
    tz = 2 * (x * v[1] - y * v[0]);
  return [v[0] + w * tx + (y * tz - z * ty), v[1] + w * ty + (z * tx - x * tz), v[2] + w * tz + (x * ty - y * tx)];
}

/** The inverse of a symmetric 3 by 3 matrix given as xx, xy, xz, yy, yz, zz, row-major 3 by 3 (zeros where it is singular). */
export function invertSymmetric(e: readonly number[]): Float64Array {
  const [a, b, c, d, f, g] = e as [number, number, number, number, number, number],
    // [[a b c] [b d f] [c f g]]
    A = d * g - f * f,
    B = c * f - b * g,
    C = b * f - c * d,
    det = a * A + b * B + c * C,
    out = new Float64Array(9);
  if (!(det !== 0 && Number.isFinite(det))) return out;
  const k = 1 / det;
  out.set([
    A * k,
    B * k,
    C * k,
    B * k,
    (a * g - c * c) * k,
    (b * c - a * f) * k,
    C * k,
    (b * c - a * f) * k,
    (a * d - b * b) * k,
  ]);
  return out;
}

/** Solves the 6 by 6 system (row-major) by Gaussian elimination with partial pivoting, in a fixed order. */
export function solve6(matrix: Float64Array, rhs: Float64Array): Float64Array {
  const a = matrix.slice(),
    b = rhs.slice(),
    n = 6;
  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let row = col + 1; row < n; row++)
      if (Math.abs(a[row * n + col]!) > Math.abs(a[pivot * n + col]!)) pivot = row;
    if (a[pivot * n + col] === 0) continue;
    if (pivot !== col) {
      for (let k = 0; k < n; k++) [a[col * n + k], a[pivot * n + k]] = [a[pivot * n + k]!, a[col * n + k]!];
      [b[col], b[pivot]] = [b[pivot]!, b[col]!];
    }
    for (let row = col + 1; row < n; row++) {
      const f = a[row * n + col]! / a[col * n + col]!;
      if (f === 0) continue;
      for (let k = col; k < n; k++) a[row * n + k]! -= f * a[col * n + k]!;
      b[row]! -= f * b[col]!;
    }
  }
  const x = new Float64Array(n);
  for (let row = n - 1; row >= 0; row--) {
    let sum = b[row]!;
    for (let k = row + 1; k < n; k++) sum -= a[row * n + k]! * x[k]!;
    x[row] = a[row * n + row]! !== 0 ? sum / a[row * n + row]! : 0;
  }
  return x;
}

/** Publishes world twist mobility and its mapping to the dry kernel's impulse. */
export function writeWetMobility(out: Float64Array, row: number, dry: Float64Array, system: Float64Array): void {
  const at = row * WET_INERTIA_WORDS;
  const basis = new Float64Array(6);
  for (let column = 0; column < 6; column++) {
    basis[column] = 1;
    const columnMobility = solve6(system, basis);
    basis[column] = 0;
    if (!(columnMobility[column]! > 0 && columnMobility.every(Number.isFinite)))
      throw hullError('failed', 'Use a hull with finite positive effective rigid and water inertia.');
    for (let i = 0; i < 6; i++) {
      let mapped = 0;
      for (let j = 0; j < 6; j++) mapped += dry[i * 6 + j]! * columnMobility[j]!;
      out[at + 1 + i * 6 + column] = columnMobility[i]!;
      out[at + 37 + i * 6 + column] = mapped;
    }
  }
  out[at] = 1;
}

/** The rotation `q` turned by the angular velocity `w` (world axes) for `h` seconds: q + (h / 2) [w, 0] q, made a unit. */
export function turn(
  q: readonly [number, number, number, number],
  w: readonly number[],
  h: number,
): [number, number, number, number] {
  const [x, y, z, s] = q,
    a = (w[0]! * h) / 2,
    b = (w[1]! * h) / 2,
    c = (w[2]! * h) / 2,
    nx = x + (s * a + b * z - c * y),
    ny = y + (s * b + c * x - a * z),
    nz = z + (s * c + a * y - b * x),
    ns = s - (a * x + b * y + c * z),
    length = Math.sqrt(nx * nx + ny * ny + nz * nz + ns * ns);
  return [nx / length, ny / length, nz / length, ns / length];
}

/** Complex numbers as [re, im]. */
export function add(a: readonly [number, number], b: readonly [number, number]): [number, number] {
  return [a[0] + b[0], a[1] + b[1]];
}
export function sub(a: readonly [number, number], b: readonly [number, number]): [number, number] {
  return [a[0] - b[0], a[1] - b[1]];
}
export function times(a: readonly [number, number], b: readonly [number, number]): [number, number] {
  return [a[0] * b[0] - a[1] * b[1], a[0] * b[1] + a[1] * b[0]];
}
export function divide(a: readonly [number, number], b: readonly [number, number]): [number, number] {
  const m = b[0] * b[0] + b[1] * b[1];
  return m > 0 ? [(a[0] * b[0] + a[1] * b[1]) / m, (a[1] * b[0] - a[0] * b[1]) / m] : [0, 0];
}

/** `values` at `x`, linear between `at`'s samples (rising), held at the ends. */
export function interpolate(at: Float64Array, values: Float64Array, x: number): number {
  const n = at.length;
  if (n === 0) return 0;
  if (x <= at[0]!) return values[0]!;
  if (x >= at[n - 1]!) return values[n - 1]!;
  let lo = 0,
    hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (at[mid]! <= x) lo = mid;
    else hi = mid;
  }
  const t = (x - at[lo]!) / (at[hi]! - at[lo]!);
  return values[lo]! + t * (values[hi]! - values[lo]!);
}
