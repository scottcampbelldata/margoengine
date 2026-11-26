import { exp } from '@margoengine/math/pinned';
import { invalidLoad } from './errors.js';

/** One passive exponential of Cummins's radiation kernel in a principal degree of freedom. */
export interface LoadRadiationMode {
  /** 0–2 are translation and 3–5 are rotation along the three load axes at the rigid centre of mass. */
  readonly axis: 0 | 1 | 2 | 3 | 4 | 5;
  /** K(0) in N/m for translation or N m/rad for rotation. */
  readonly strength: number;
  /** Time constant in seconds, above zero. */
  readonly decayTime: number;
}

export interface RadiationMode {
  readonly axis: LoadRadiationMode['axis'];
  readonly strength: number;
  readonly decay: number;
  readonly integral: number;
  readonly index: number;
}

/** Discretize the kernel for a held velocity over each world step. */
export function prepareRadiation(mode: LoadRadiationMode, dt: number, index: number): RadiationMode {
  if (!mode || !(Number.isInteger(mode.axis) && mode.axis >= 0 && mode.axis < 6))
    throw invalidLoad('Invalid radiation axis; choose an integer from 0 to 5.');
  if (!(mode.strength >= 0 && Number.isFinite(mode.strength)))
    throw invalidLoad('Invalid radiation strength; use a finite nonnegative kernel amplitude.');
  if (!(mode.decayTime > 0 && Number.isFinite(mode.decayTime)))
    throw invalidLoad('Invalid radiation decay time; supply positive finite seconds.');
  const interval = dt / mode.decayTime;
  const decay = exp(-interval);
  // The Taylor interval avoids cancellation when the time constant spans many steps.
  const integral = interval < 1e-4 ? dt * (1 - interval / 2 + (interval * interval) / 6) : mode.decayTime * (1 - decay);
  if (!Number.isFinite(mode.strength * integral * dt))
    throw invalidLoad('Radiation inertia exceeds numeric range; scale the kernel to physical SI loads.');
  return { axis: mode.axis, strength: mode.strength, decay, integral, index };
}
