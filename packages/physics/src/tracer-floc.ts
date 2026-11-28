import { MargoError } from '@margoengine/math/errors';
import { exp, ln, pow } from '@margoengine/math/pinned';
import { oneMinusExp } from './ageing/processes.js';

/** Local turbulence and dry concentration for cohesive sediment. */
export interface TracerFlocConditions {
  /** Suspended dry sediment concentration, kg/m³. */
  concentration: number;
  /** Turbulent shear rate G = sqrt(dissipation / kinematic viscosity), s⁻¹. */
  shearRate: number;
}

/**
 * The conditions a tracer floc sits in: fixed `TracerFlocConditions`, or a function of position and time that
 * returns them.
 */
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
  shearLimit?: { logStrengthRatio: number; maximumGrowthFactor: number };
  environment: TracerFlocEnvironment;
}

export function checkFlocConditions({ concentration, shearRate }: TracerFlocConditions): void {
  if (!(concentration >= 0 && shearRate >= 0 && Number.isFinite(concentration) && Number.isFinite(shearRate)))
    throw new MargoError(
      'unsupported',
      'Floc conditions are outside range; supply finite nonnegative concentration and shear rate.',
    );
}

export function flocShearLimit(yieldForce: number, density: number, viscosity: number): FlocKinetics['shearLimit'] {
  const ratio = (density * viscosity * viscosity) / yieldForce;
  // The implicit breakup term stays increasing if 3/(e² sqrt(ratio)) is below one.
  if (!(yieldForce > 0 && ratio > 9 * exp(-4) && Number.isFinite(ratio)))
    throw new MargoError(
      'unsupported',
      'The floc yield force is outside the shear-limited model range; use a finite positive yieldForce below e^4 times water density times kinematic viscosity squared divided by 9.',
    );
  return { logStrengthRatio: ln(ratio), maximumGrowthFactor: exp(3 / (Math.E * Math.sqrt(ratio))) };
}

function shearLimitedDiameter(
  limit: NonNullable<FlocKinetics['shearLimit']>,
  primary: number,
  diameter: number,
  inverseMicroscale: number,
  drive: number,
  relaxation: number,
): number {
  // Kuprenas et al. Eq. 9. Freeze the D² mobility but take the breakup factor at the new diameter.
  // The correction has minimum exp(-3/(e sqrt(ratio))). This brackets the positive implicit root.
  const weight = 1 / (1 + 1 / relaxation);
  if (weight === 0) return diameter;
  const logWeight = ln(weight);
  let low = primary;
  let high = Math.max(diameter, primary + drive * limit.maximumGrowthFactor);
  if (!Number.isFinite(high))
    throw new MargoError(
      'unsupported',
      'Shear-limited floc growth exceeds numeric range; use a physical concentration and kinetic coefficients.',
    );
  for (let sweep = 0; sweep < 48; sweep++) {
    const next = low + 0.5 * (high - low);
    if (high - low <= Math.sqrt(Number.EPSILON) * next) return next;
    const relative = inverseMicroscale * next;
    const logCorrection = relative > 0 ? 1.5 * relative * (limit.logStrengthRatio + 2 * ln(relative)) : 0;
    const gain = (1 - weight) * (diameter - next) + weight * drive;
    // Compare breakup and gain in log space so extreme shear cannot overflow the breakup term.
    if (gain <= 0 || logWeight + ln(next - primary) + logCorrection > ln(gain)) high = next;
    else low = next;
  }
  throw new MargoError(
    'unsupported',
    'The shear-limited floc root cannot reach numerical precision; supply physical floc sizes and kinetic coefficients.',
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
  const { environment, primary, aggregation, breakup, shearLimit, waterViscosity } = kinetics;
  const conditions = typeof environment === 'function' ? environment(x, y, z, time) : environment;
  if (typeof environment === 'function') checkFlocConditions(conditions);
  const { concentration, shearRate } = conditions;
  if (shearRate === 0) return d;
  // Winterwerp et al. (2006), Eq. 1 with n_f=2, p=1 and q=1/2.
  const relaxation = 0.5 * breakup * shearRate * Math.sqrt(shearRate) * d * d * dt;
  const drive = (aggregation / breakup) * (concentration / Math.sqrt(shearRate));
  if (shearLimit) {
    if (relaxation === 0) return d;
    return shearLimitedDiameter(
      shearLimit,
      primary,
      d,
      Math.sqrt(shearRate) / Math.sqrt(waterViscosity),
      drive,
      relaxation,
    );
  }
  const equilibrium = primary + drive;
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
