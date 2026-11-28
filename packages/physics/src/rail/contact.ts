import { MargoError } from '@margoengine/math/errors';
import { exp, hypot } from '@margoengine/math/pinned';

const PI = 3.141592653589793;
const REDUCE = 0.41421356237309503;

/** Polach contact parameters measured at one rail surface condition. */
export interface RailAdhesion {
  /** Maximum contact friction coefficient at zero sliding speed. */
  readonly friction: number;
  /** High-slip to zero-slip friction ratio A, from 0 to 1. */
  readonly highSlipRatio: number;
  /** Friction decay B, in s/m. */
  readonly decay: number;
  /** Reduction of adhesion area shear stiffness, from 0 to 1. */
  readonly adhesionFactor: number;
  /** Reduction of sliding area shear stiffness, from 0 to adhesionFactor. */
  readonly slipFactor: number;
}

export interface RailCreep {
  /** Wheel-surface speed relative to the rail, in the longitudinal and lateral directions, m/s. */
  readonly slip: readonly [number, number];
  /** Reference rolling speed magnitude, m/s. Choose a positive near-zero regularisation. */
  readonly rollingSpeed: number;
  /** Current normal reaction, N. */
  readonly normal: number;
  /** Combined Kalker coefficient G a b C11, N per unit creepage. */
  readonly creepStiffness: number;
  readonly adhesion: RailAdhesion;
}

export function railNumber(value: number, description: string, min = -Infinity, max = Infinity): number {
  if (!Number.isFinite(value) || value < min || value > max) {
    throw new MargoError('state', `Choose ${description} in [${min}, ${max}].`);
  }
  return value;
}

export function checkedAdhesion(values: RailAdhesion): RailAdhesion {
  return {
    friction: railNumber(values.friction, 'rail friction', 0, 1),
    highSlipRatio: railNumber(values.highSlipRatio, 'high-slip friction ratio', 0, 1),
    decay: railNumber(values.decay, 'slide friction decay', 0),
    adhesionFactor: railNumber(values.adhesionFactor, 'adhesion area reduction', 0, 1),
    slipFactor: railNumber(values.slipFactor, 'sliding area reduction', 0, values.adhesionFactor),
  };
}

function reducedAtan(x: number): number {
  const square = -(x * x);
  let series = 0;
  // Alternating Taylor remainder below 1e-17 for |x| at most tan(pi/8).
  for (let n = 19; n >= 0; n--) series = 1 / (2 * n + 1) + square * series; // float division: series denominator
  return x * series;
}

function positiveAtan(value: number): number {
  if (value > 1) return PI * 0.5 - positiveAtan(1 / value); // float division: reciprocal range reduction
  if (value > REDUCE) return PI * 0.25 + reducedAtan((value - 1) / (value + 1)); // float division: pi/4 shift
  return reducedAtan(value);
}

function adhesionTerm(value: number): number {
  return value <= 1 ? value / (1 + value * value) : 1 / (value + 1 / value); // float division: saturation term
}

/** Polach's resultant tangential wheel force without spin creepage, in newtons. */
export function railCreepForce({
  slip,
  rollingSpeed,
  normal,
  creepStiffness,
  adhesion,
}: RailCreep): readonly [number, number];
export function railCreepForce(input: RailCreep): readonly [number, number] {
  if (input?.slip?.length !== 2 || !input.adhesion)
    throw new MargoError('state', 'Supply two rail slip velocities and one rail adhesion record.');
  const slip = [
    railNumber(input.slip[0], 'longitudinal slip velocity in metres per second'),
    railNumber(input.slip[1], 'lateral slip velocity in metres per second'),
  ] as const;
  const result = evaluatedRailCreep({
    slip,
    rollingSpeed: railNumber(input.rollingSpeed, 'positive rail rolling speed', Number.MIN_VALUE),
    normal: railNumber(input.normal, 'nonnegative rail reaction', 0),
    creepStiffness: railNumber(input.creepStiffness, 'nonnegative rail creep stiffness', 0),
    adhesion: checkedAdhesion(input.adhesion),
  });
  if (!result.every(Number.isFinite))
    throw new MargoError(
      'state',
      'Rail creep force exceeds numeric range. Reduce slip or use a representable rolling speed.',
    );
  return result;
}

export function evaluatedRailCreep({
  slip,
  rollingSpeed,
  normal,
  creepStiffness,
  adhesion,
}: RailCreep): readonly [number, number] {
  const speed = hypot(slip[0], slip[1]);
  if (!(speed > 0 && normal > 0 && adhesion.friction > 0 && rollingSpeed > 0)) return [0, 0];
  const mu = adhesion.friction * (adhesion.highSlipRatio + (1 - adhesion.highSlipRatio) * exp(-adhesion.decay * speed));
  if (mu === 0) return [0, 0];
  const radius = (0.25 * PI * creepStiffness * (speed / rollingSpeed)) / (normal * mu); // float division: dimensionless creep
  const ka = adhesion.adhesionFactor === 0 ? 0 : adhesion.adhesionFactor * radius;
  const ks = adhesion.slipFactor === 0 ? 0 : adhesion.slipFactor * radius;
  const force = (2 / PI) * normal * mu * (adhesionTerm(ka) + positiveAtan(ks));
  const direction = -force / speed; // float division: force opposing relative slip
  return [slip[0] * direction, slip[1] * direction];
}

/** Scale longitudinal and lateral slip forces together before their update can reverse the sliding speed. */
export function railSlipLimit(
  force: readonly [number, number],
  slip: readonly [number, number],
  inverseMass: readonly [number, number],
  dt: number,
): number {
  const x = dt * Math.abs(force[0] * inverseMass[0]);
  const y = dt * Math.abs(force[1] * inverseMass[1]);
  return Math.min(1, x > 0 ? Math.abs(slip[0]) / x : 1, y > 0 ? Math.abs(slip[1]) / y : 1); // float division: component impulse limit
}
