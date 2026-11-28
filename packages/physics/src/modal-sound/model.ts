import { modalSoundError } from './errors.js';

/** Five f64 words per track: impact impulse, scrape power, power × scrape speed, roll power, power × roll speed. */
export const MODAL_CONTACT_WORDS = 5;

export const MAX_LOAD = 1e12;

export function limited(value: number, min: number, max: number, name: string): number {
  if (!Number.isFinite(value) || value < min || value > max)
    throw modalSoundError(`Modal sound ${name} is out of range. Pass a finite value from ${min} through ${max}.`);
  return value;
}

/** Equivalent impulse in N s from released strain energy and the effective mass of a fragment initially at rest. */
export function modalFractureImpulse(energy: number, effectiveMass: number, energyFraction = 1): number {
  const e = limited(energy, 0, MAX_LOAD, 'released energy in J');
  const m = limited(effectiveMass, 1e-9, MAX_LOAD, 'effective mass in kg');
  const eta = limited(energyFraction, 0, 1, 'fracture energy fraction');
  return limited(Math.sqrt(2 * m * e * eta), 0, MAX_LOAD, 'fracture impulse in N s');
}
