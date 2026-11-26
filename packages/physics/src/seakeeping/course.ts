import type { HullMemory } from './memory.js';

/** A near-steady course for forward-speed heave, pitch and viscous roll loads. */
export interface HullCourse {
  /** Constant longitudinal water-relative speed, m/s. Default the hull's horizontal forward velocity. */
  readonly speed?: number;
  /** Steady bow-up trim, radians. Default zero for a level mean waterline. */
  readonly trim?: number;
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
  let mass = memory.heaveInfinite;
  // A33(0) is A∞33 minus the first time moment of the finite radiation kernel.
  for (let i = 1; i < diagonal.length; i++) mass -= diagonal[i]! * i * memory.dt * memory.dt;
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
