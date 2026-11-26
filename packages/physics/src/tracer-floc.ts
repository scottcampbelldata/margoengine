import { MargoError } from '@margoengine/math/errors';
import { pow } from '@margoengine/math/pinned';
import { oneMinusExp } from './ageing/processes.js';

/** Local turbulence and dry concentration for cohesive sediment. */
export interface TracerFlocConditions {
  /** Suspended dry sediment concentration, kg/m³. */
  concentration: number;
  /** Turbulent shear rate G = sqrt(dissipation / kinematic viscosity), s⁻¹. */
  shearRate: number;
}

export type TracerFlocEnvironment =
  | TracerFlocConditions
  | ((x: number, y: number, z: number, time: number) => TracerFlocConditions);

export interface FlocKinetics {
  primary: number;
  initial: number;
  aggregation: number;
  breakup: number;
  waterViscosity: number;
  stokesFactor: number;
  environment: TracerFlocEnvironment;
}

export function checkFlocConditions({ concentration, shearRate }: TracerFlocConditions): void {
  if (!(concentration >= 0 && shearRate >= 0 && Number.isFinite(concentration) && Number.isFinite(shearRate)))
    throw new MargoError(
      'unsupported',
      'Floc conditions are outside range; supply finite nonnegative concentration and shear rate.',
    );
}

/** Freeze the positive D² mobility and integrate the competing aggregation and breakup exactly over one step. */
export function flocDiameter(
  kinetics: FlocKinetics,
  d: number,
  dt: number,
  x: number,
  y: number,
  z: number,
  time: number,
): number {
  const { environment, primary, aggregation, breakup } = kinetics;
  const conditions = typeof environment === 'function' ? environment(x, y, z, time) : environment;
  if (typeof environment === 'function') checkFlocConditions(conditions);
  const { concentration, shearRate } = conditions;
  if (shearRate === 0) return d;
  // Winterwerp et al. (2006), Eq. 1 with n_f=2, p=1 and q=1/2.
  const relaxation = 0.5 * breakup * shearRate * Math.sqrt(shearRate) * d * d * dt;
  const equilibrium = primary + (aggregation / breakup) * (concentration / Math.sqrt(shearRate));
  const into = oneMinusExp(relaxation);
  const next = (1 - into) * d + into * equilibrium;
  if (!(next > 0 && Number.isFinite(next)))
    throw new MargoError(
      'unsupported',
      'Floc growth exceeds numeric range; supply physical concentrations, shear and kinetic coefficients.',
    );
  return next;
}

/** Fractal Stokes settling with the Schiller–Naumann correction in Winterwerp et al. (2006), Eq. 9. */
export function flocFallSpeed(kinetics: FlocKinetics, diameter: number): number {
  const stokes = kinetics.stokesFactor * diameter;
  const reScale = diameter / kinetics.waterViscosity;
  let speed = stokes;
  // The residual is increasing and convex on positive speed. Newton from the Stokes upper bound is monotone.
  for (let i = 0; i < 8; i++) {
    const drag = 0.15 * pow(speed * reScale, 0.687);
    const change = (speed * (1 + drag) - stokes) / (1 + 1.687 * drag);
    speed -= change;
    if (Math.abs(change) <= 2 * Number.EPSILON * speed) break;
  }
  if (!(speed > 0 && Number.isFinite(speed) && speed * reScale <= 1000))
    throw new MargoError(
      'unsupported',
      'Floc settling exceeds the drag law range; use cohesive grains and conditions with particle Reynolds number at most 1,000.',
    );
  return speed;
}
