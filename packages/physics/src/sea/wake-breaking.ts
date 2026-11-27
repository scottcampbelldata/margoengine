import { MargoError } from '@margoengine/math/errors';
import type { FieldDescriptor } from '../world/solver.js';

export const WAKE_BREAKING_FIELD: FieldDescriptor = Object.freeze({
  name: 'wakeBreaking',
  kind: 'surfaceSampleSet',
  quantity: 'wakeBreakingCrest',
  unit: 'SI',
  centring: 'particle',
});

/** f64 header [written rows, total detected rows, cell width in metres], followed by compact rows. */
export const WAKE_BREAKING_LAYOUT = 1;
export const WAKE_BREAKING_HEADER_WORDS = 3;
/** [x, z, height, directionX, directionZ, crestSpeed, particleSpeed, ratio], metres and seconds. */
export const WAKE_BREAKING_WORDS = 8;

/** Central threshold in Derakhti et al. (2020), following Barthélemy et al. (2018). */
export const WAKE_BREAKING_THRESHOLD = 0.85;

interface WakeBreakingGrid {
  readonly cells: readonly [number, number];
  readonly cellSize: number;
  readonly origin: readonly [number, number];
}

function slopeAlong(field: Float64Array, i: number, stride: number, x: number, z: number): number {
  return (x * (field[i + 1]! - field[i - 1]!) + z * (field[i + stride]! - field[i - stride]!)) / 2;
}

function crossCurvature(field: Float64Array, i: number, stride: number): number {
  return (field[i + stride + 1]! - field[i + stride - 1]! - (field[i - stride + 1]! - field[i - stride - 1]!)) / 4;
}

function curvatureAlong(field: Float64Array, i: number, stride: number, x: number, z: number): number {
  const centre = field[i]!;
  return (
    x * x * (field[i - 1]! - centre + (field[i + 1]! - centre)) +
    2 * x * z * crossCurvature(field, i, stride) +
    z * z * (field[i - stride]! - centre + (field[i + stride]! - centre))
  );
}

function touchesExcluded(field: Float64Array | undefined, i: number, stride: number): boolean {
  if (!field) return false;
  for (let offset = -stride; offset <= stride; offset += stride) {
    const row = i + offset;
    if (field[row - 1] || field[row] || field[row + 1]) return true;
  }
  return false;
}

/**
 * Sample the above-threshold part of the crest lines using two consecutive accepted elevation grids and the latest
 * wave-perturbation surface potential. Each local quadratic gives a crest in the direction of largest concavity.
 * Difference its two subcell positions and project the surface potential gradient along the same axis at the new crest.
 * Subtract the declared uniform current from the ground-relative crest speed. The potential already describes motion
 * relative to this current. Both output speeds and direction use that water frame.
 *
 * The surface ratio applies to resolved, moving crests with no applied surface pressure (Barthélemy et al. 2018,
 * DOI 10.1017/jfm.2018.93; Derakhti et al. 2020, DOI 10.1029/2019JC015886). Decline stencils touching applied pressure
 * or damping when supplied. Edges, almost isotropic curvature, unresolved inter-tick motion or a missing prior crest
 * inside the stencil yield no observation. This linear-wake diagnostic does not resolve air entrainment or overturning.
 * Rows describe active candidates at the current tick. Overflow retains the first rows in grid order and records the
 * full count in the header. The output must be separate from the input grids.
 */
export function writeWakeBreaking(
  out: Float64Array,
  { cells: [nx, nz], cellSize, origin: [x0, z0] }: WakeBreakingGrid,
  previous: Float64Array,
  height: Float64Array,
  potential: Float64Array,
  dt: number,
  current: readonly [number, number] = [0, 0],
  surfacePressure?: Float64Array,
  damping?: Float64Array,
): void {
  const count = nx * nz;
  const available = out.length - WAKE_BREAKING_HEADER_WORDS;
  if (
    !Number.isSafeInteger(nx) ||
    !Number.isSafeInteger(nz) ||
    nx < 3 ||
    nz < 3 ||
    !(Number.isFinite(cellSize) && cellSize > 0 && Number.isFinite(dt) && dt > 0) ||
    ![x0, z0, current[0], current[1], cellSize / dt].every(Number.isFinite) ||
    previous.length !== count ||
    height.length !== count ||
    potential.length !== count ||
    (surfacePressure && surfacePressure.length !== count) ||
    (damping && damping.length !== count) ||
    available < 0 ||
    available % WAKE_BREAKING_WORDS !== 0
  )
    throw new MargoError(
      'state',
      'Match the breaking grid, finite wake step and current to the layout-1 crest region.',
    );
  for (const input of [previous, height, potential, surfacePressure, damping]) {
    if (
      input?.buffer === out.buffer &&
      input.byteOffset < out.byteOffset + out.byteLength &&
      out.byteOffset < input.byteOffset + input.byteLength
    )
      throw new MargoError('state', 'Keep the breaking crest region disjoint from its input grid regions.');
  }

  out.fill(0);
  const speedPerCell = cellSize / dt;
  let detected = 0;
  let written = 0;
  for (let row = 1; row < nz - 1; row++) {
    for (let column = 1; column < nx - 1; column++) {
      const i = row * nx + column;
      const centre = height[i]!;
      const xx = height[i - 1]! - centre + (height[i + 1]! - centre);
      const zz = height[i - nx]! - centre + (height[i + nx]! - centre);
      const xz = crossCurvature(height, i, nx);
      const difference = xx - zz;
      const gap = Math.sqrt(difference * difference + 4 * xz * xz);
      const curvature = (xx + zz - gap) / 2;
      const noise = 32 * Number.EPSILON * Math.abs(centre);
      // The major axis of an almost circular crest cannot define a reliable propagation direction.
      if (!(curvature < -noise && gap > -curvature / 8)) continue;
      const vectorX = xx <= zz ? zz - curvature : -xz;
      const vectorZ = xx <= zz ? -xz : xx - curvature;
      const length = Math.sqrt(vectorX * vectorX + vectorZ * vectorZ);
      const normalX = vectorX / length;
      const normalZ = vectorZ / length;
      const halfWidth = 0.5 / Math.max(Math.abs(normalX), Math.abs(normalZ));
      const slope = slopeAlong(height, i, nx, normalX, normalZ);
      const offset = -slope / curvature;
      if (!(offset >= -halfWidth && offset < halfWidth)) continue;
      if (touchesExcluded(surfacePressure, i, nx) || touchesExcluded(damping, i, nx)) continue;

      const oldCurvature = curvatureAlong(previous, i, nx, normalX, normalZ);
      if (!(oldCurvature < -32 * Number.EPSILON * Math.abs(previous[i]!))) continue;
      const oldOffset = -slopeAlong(previous, i, nx, normalX, normalZ) / oldCurvature;
      if (!(Math.abs(oldOffset) <= 2 * halfWidth)) continue;
      const speed = (offset - oldOffset) * speedPerCell - (normalX * current[0] + normalZ * current[1]);
      // Below a thousandth of a cell in one tick, the ratio's denominator is unresolved.
      if (!(Math.abs(speed) >= 0.001 * speedPerCell)) continue;
      const particle =
        (slopeAlong(potential, i, nx, normalX, normalZ) + offset * curvatureAlong(potential, i, nx, normalX, normalZ)) /
        cellSize;
      const ratio = particle / speed;
      if (!(ratio >= WAKE_BREAKING_THRESHOLD && Number.isFinite(ratio))) continue;
      detected++;
      const start = WAKE_BREAKING_HEADER_WORDS + written * WAKE_BREAKING_WORDS;
      if (start === out.length) continue;
      const direction = Math.sign(speed);
      out[start] = x0 + (column + 0.5 + normalX * offset) * cellSize;
      out[start + 1] = z0 + (row + 0.5 + normalZ * offset) * cellSize;
      out[start + 2] = centre + 0.5 * offset * slope;
      out[start + 3] = normalX * direction;
      out[start + 4] = normalZ * direction;
      out[start + 5] = Math.abs(speed);
      out[start + 6] = particle * direction;
      out[start + 7] = ratio;
      written++;
    }
  }
  out[0] = written;
  out[1] = detected;
  out[2] = cellSize;
}
