// The water a load reads at a point: the sea's flow plus every other flow (a current, a ship's race, a river), and its
// acceleration as a centred difference of that pure velocity in time over 2 ms. Shared by `LoadSolver` and `segmentLoads`.
import type { FlowField, FlowSample } from '@margoengine/math/fields';
import type { LoadWater } from './solver.js';

type Vec3 = [number, number, number];

/** The water's velocity at (x, y, z) at time `t`, m/s: the sea's water plus each of `flows`, written into `out`. */
export function waterVelocity(
  sea: LoadWater,
  flows: readonly FlowField[],
  x: number,
  y: number,
  z: number,
  t: number,
  sample: FlowSample,
  out: Vec3,
): Vec3 {
  return flowVelocity(sea, flows, x, y, z, t, sample, out);
}

function flowVelocity(
  sea: LoadWater | undefined,
  flows: readonly FlowField[],
  x: number,
  y: number,
  z: number,
  t: number,
  sample: FlowSample,
  out: Vec3,
): Vec3 {
  const s = sea?.water.sample(x, y, z, t, sample);
  out[0] = s?.velocity[0] ?? 0;
  out[1] = s?.velocity[1] ?? 0;
  out[2] = s?.velocity[2] ?? 0;
  for (const flow of flows) {
    const f = flow.sample(x, y, z, t, sample);
    out[0] += f.velocity[0];
    out[1] += f.velocity[1];
    out[2] += f.velocity[2];
  }
  return out;
}

/** The water's acceleration at (x, y, z) at time `t`, m/s^2: a centred difference of its velocity over 2 ms. */
export function waterAcceleration(
  sea: LoadWater,
  flows: readonly FlowField[],
  x: number,
  y: number,
  z: number,
  t: number,
  sample: FlowSample,
  out: Vec3,
): Vec3 {
  return flowAcceleration(sea, flows, x, y, z, t, sample, out);
}

/** Differentiate either a full water query or only the independently supplied flows. */
export function flowAcceleration(
  sea: LoadWater | undefined,
  flows: readonly FlowField[],
  x: number,
  y: number,
  z: number,
  t: number,
  sample: FlowSample,
  out: Vec3,
): Vec3 {
  const a: Vec3 = [0, 0, 0],
    b: Vec3 = [0, 0, 0],
    h = 1e-3;
  flowVelocity(sea, flows, x, y, z, t + h, sample, a);
  flowVelocity(sea, flows, x, y, z, t - h, sample, b);
  out[0] = (a[0] - b[0]) / (2 * h);
  out[1] = (a[1] - b[1]) / (2 * h);
  out[2] = (a[2] - b[2]) / (2 * h);
  return out;
}
