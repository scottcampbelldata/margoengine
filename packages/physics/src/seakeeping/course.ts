import { type HullMemory, staticAddedMass } from './memory.js';

/** A near-steady course for forward-speed strip loads and viscous roll. */
export interface HullCourse {
  /** Constant longitudinal water-relative speed, m/s. Default the horizontal speed relative to the sampled mean current. */
  readonly speed?: number;
  /** Steady bow-up trim, radians. Default zero for a level mean waterline. */
  readonly trim?: number;
  /** Fixed course direction in radians from +X towards +Z. Omit to disable the lateral speed terms. */
  readonly lateralHeading?: number;
}

/**
 * STF ordinary strip speed terms for pointed ends. The lateral slope is minus the engine yaw
 * angle, so it plays the same role in sectional sway that pitch plays in heave. Sway and roll
 * use the response to that slope. Yaw uses the response to sway displacement and roll angle.
 */
export function lateralCourseLoad(
  ring: Float64Array,
  lags: number,
  slot: number,
  count: number,
  slope: number,
  roll: number,
  speed: number,
  swayKernel: Float64Array,
  crossKernel: Float64Array,
  swayMass: number,
  crossMass: number,
  dt: number,
): readonly [sway: number, rollMoment: number, yawMoment: number] {
  const now = 6 * slot;
  let yawRate = ring[now + 4]!;
  let rollRate = ring[now + 3]!;
  let relative = ring[now + 2]! - speed * slope;
  const sway = swayMass * relative;
  const rolling = crossMass * rollRate;
  const slopeRate = -yawRate;
  const presentSlope = slope;
  const presentRoll = roll;
  let displacement = 0;
  let yawIntoSway = 0;
  let yawIntoRoll = 0;
  let swayIntoYaw = 0;
  let rollIntoYaw = 0;
  const n = Math.min(lags, count, swayKernel.length, crossKernel.length);
  for (let lag = 1; lag < n; lag++) {
    const at = 6 * ((slot - lag + lags) % lags);
    const olderYaw = ring[at + 4]!;
    const olderRoll = ring[at + 3]!;
    slope += (yawRate + olderYaw) * 0.5 * dt;
    roll -= (rollRate + olderRoll) * 0.5 * dt;
    const olderRelative = ring[at + 2]! - speed * slope;
    displacement -= (relative + olderRelative) * 0.5 * dt;
    const lateral = swayKernel[lag]!;
    const crossed = crossKernel[lag]!;
    // The infinite radiation kernel integrates to zero. Refer held angles to the present
    // so a truncated memory gives no DC load for a constant heading or heel.
    yawIntoSway += lateral * (slope - presentSlope);
    yawIntoRoll += crossed * (slope - presentSlope);
    swayIntoYaw += lateral * displacement;
    rollIntoYaw += crossed * (roll - presentRoll);
    yawRate = olderYaw;
    rollRate = olderRoll;
    relative = olderRelative;
  }
  return [
    speed * (swayMass * slopeRate + dt * yawIntoSway),
    speed * (crossMass * slopeRate + dt * yawIntoRoll),
    speed * (sway + rolling + dt * (swayIntoYaw + rollIntoYaw)),
  ];
}

/** Per hull: a valid-sample count, then the relative heave velocity and pitch at every radiation lag. */
export const courseWords = (lags: number): number => 1 + 2 * lags;

/**
 * The upper course speed with positive zero-frequency longitudinal restoring after heave is free.
 * Finite 2D strip memory can reduce pitch restoring by U² A33(0), particularly on broad hulls.
 */
export function courseSpeedLimit(memory: HullMemory, diagonal: Float64Array, density: number, gravity: number): number {
  let area = 0;
  let first = 0;
  let second = 0;
  let arm = 0;
  for (const strip of memory.strips) {
    const weight = strip.width * memory.stripForms[strip.form]!.breadth;
    area += weight;
    first += weight * strip.x;
    second += weight * strip.x * strip.x;
    arm += weight * strip.heaveDepth * (memory.pivot - strip.swayDepth);
  }
  if (area === 0) return 0;
  const stiffness = density * gravity * (second - (first * first) / area + arm);
  const mass = staticAddedMass(memory.heaveInfinite, diagonal, memory.dt);
  if (stiffness <= 0) return 0;
  return mass > 0 ? Math.sqrt(stiffness / mass) : Infinity;
}

/**
 * Salvesen, Tuck and Faltinsen's ordinary-strip vertical speed terms (Journée and Massie 8.30–8.31).
 * With positive bow-up pitch, the heave and pitch corrections are +U H(theta) and -U H(zRelative)
 * with H = A∞33 d/dt + K33*. The relative velocity is heave less forward speed times dynamic trim.
 */
export function courseLoad(
  history: Float64Array,
  lags: number,
  slot: number,
  heave: number,
  pitch: number,
  pitchRate: number,
  speed: number,
  diagonal: Float64Array,
  addedMass: number,
  dt: number,
): readonly [heaveForce: number, pitchMoment: number] {
  const relative = heave - speed * pitch;
  const at = 1 + 2 * slot;
  history[at] = relative;
  history[at + 1] = pitch;
  const n = Math.min(lags, diagonal.length, history[0]! + 1);
  history[0] = n;
  let last = relative;
  let displacement = 0;
  let angularMemory = 0.5 * diagonal[0]! * pitch;
  let heaveMemory = 0;
  for (let lag = 1; lag < n; lag++) {
    const sample = 1 + 2 * ((slot - lag + lags) % lags);
    const older = history[sample]!;
    // Integrate only over the delay. Cummins' K33 has zero integral in the untruncated model;
    // subtracting the present value avoids a steady force or moment from the finite kernel.
    displacement -= (last + older) * (0.5 * dt);
    last = older;
    const k = diagonal[lag]!;
    angularMemory += k * history[sample + 1]!;
    heaveMemory += k * displacement;
  }
  return [speed * (addedMass * pitchRate + dt * angularMemory), -speed * (addedMass * relative + dt * heaveMemory)];
}
