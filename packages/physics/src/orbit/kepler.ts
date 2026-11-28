import { MargoError } from '@margoengine/math/errors';
import { cos, sin } from '@margoengine/math/pinned';
import type { OrbitVector } from './index.js';

const TAU = 2 * Math.PI;

/** Orbital elements of a bound Kepler ellipse, referred to the inertial xy plane. */
export interface KeplerElements {
  /** Gravitational parameter G times the total central and secondary mass in m³/s². */
  readonly gravitationalParameter: number;
  /** Semimajor axis in metres. */
  readonly semimajorAxis: number;
  /** Orbital eccentricity in [0, 1). Defaults to zero. */
  readonly eccentricity?: number;
  /** Inclination in radians. Defaults to zero. */
  readonly inclination?: number;
  /** Longitude of the ascending node in radians. Defaults to zero. */
  readonly ascendingNode?: number;
  /** Argument of periapsis in radians. Defaults to zero. */
  readonly argumentOfPeriapsis?: number;
  /** Mean anomaly at the reference epoch in radians. Defaults to zero. */
  readonly meanAnomalyAtEpoch?: number;
}

/** Position and velocity relative to the primary in metres and m/s. */
export interface KeplerState {
  readonly position: OrbitVector;
  readonly velocity: OrbitVector;
}

function angle(value: number): number {
  if (!Number.isFinite(value))
    throw new MargoError('state', 'Orbital angle is outside numeric range; use a finite angle or time.');
  return value % TAU;
}

function positive(value: number, name: string): number {
  if (!(Number.isFinite(value) && value > 0))
    throw new MargoError('state', `Invalid ${name}; pass a finite positive value in SI units.`);
  return value;
}

// Evaluate E - sin(E) directly from its convergent series near the singular corner.
function keplerResidual(eccentric: number, e: number, mean: number): number {
  if (Math.abs(eccentric) >= 0.125) return eccentric - e * sin(eccentric) - mean;
  const square = eccentric * eccentric;
  const difference =
    eccentric *
    square *
    (1 / 6 + square * (-1 / 120 + square * (1 / 5040 + square * (-1 / 362880 + square / 39916800))));
  return (1 - e) * eccentric + e * difference - mean;
}

function circularSpeed(mu: number, radius: number): number {
  const speed = Math.sqrt(mu / radius);
  return speed > 0 && Number.isFinite(speed) ? speed : Math.sqrt(mu) / Math.sqrt(radius);
}

function phaseAdvance(speed: number, radius: number, seconds: number): number {
  if (seconds === 0) return 0;
  const direct = (speed / radius) * seconds;
  if (direct !== 0 && Number.isFinite(direct)) return direct;
  const reverse = (seconds / radius) * speed;
  if (reverse !== 0 && Number.isFinite(reverse)) return reverse;
  const product = (speed * seconds) / radius;
  return Number.isFinite(product) ? product : direct;
}

function eccentricAnomaly(mean: number, eccentricity: number): number {
  if (mean === 0 || eccentricity === 0) return mean;
  // E - e sin(E) is strictly increasing for e < 1. Its root is in [M - e, M + e].
  let lower = mean - eccentricity;
  let upper = mean + eccentricity;
  while (true) {
    const middle = (lower + upper) * 0.5;
    if (middle === lower || middle === upper) return middle;
    const residual = keplerResidual(middle, eccentricity, mean);
    if (residual === 0) return middle;
    if (residual > 0) upper = middle;
    else lower = middle;
  }
}

/** Evaluates a bound two-body orbit at a signed time relative to the epoch in seconds. */
export function keplerState(elements: KeplerElements, seconds = 0): KeplerState {
  if (elements === null || typeof elements !== 'object')
    throw new MargoError(
      'state',
      'Invalid Kepler elements. Pass an object with a gravitational parameter and semimajor axis.',
    );
  if (!Number.isFinite(seconds))
    throw new MargoError('state', 'Invalid Kepler epoch offset. Pass finite signed seconds.');
  const mu = positive(elements.gravitationalParameter, 'gravitational parameter');
  const a = positive(elements.semimajorAxis, 'semimajor axis');
  const e = elements.eccentricity ?? 0;
  if (!Number.isFinite(e) || e < 0 || e >= 1)
    throw new MargoError('state', 'A Kepler ellipse requires eccentricity in [0, 1); choose a bound orbit.');
  const inclination = angle(elements.inclination ?? 0);
  const node = angle(elements.ascendingNode ?? 0);
  const periapsis = angle(elements.argumentOfPeriapsis ?? 0);
  const speed = circularSpeed(mu, a);
  const eccentric = eccentricAnomaly(
    angle(angle(elements.meanAnomalyAtEpoch ?? 0) + angle(phaseAdvance(speed, a, seconds))),
    e,
  );
  const cE = cos(eccentric);
  const sE = sin(eccentric);
  const ratio = Math.sqrt((1 - e) * (1 + e));
  // 1 - cos(E) = 2 sin²(E/2) avoids losing the small periapsis radius and the time derivative.
  const halfSine = Math.abs(eccentric) < 0.125 ? sin(eccentric / 2) : undefined;
  const oneMinusCosine = halfSine === undefined ? 1 - cE : 2 * halfSine * halfSine;
  const xFactor = halfSine === undefined ? cE - e : 1 - e - oneMinusCosine;
  const denominator = halfSine === undefined ? 1 - e * cE : 1 - e + e * oneMinusCosine;
  const rate = speed / denominator;
  const ci = cos(inclination);
  const si = sin(inclination);
  const cn = cos(node);
  const sn = sin(node);
  const cp = cos(periapsis);
  const sp = sin(periapsis);
  const rotate = (x: number, y: number): OrbitVector => {
    const p = cp * x - sp * y;
    const q = sp * x + cp * y;
    return [cn * p - sn * ci * q, sn * p + cn * ci * q, si * q];
  };
  const position = rotate(a * xFactor, a * ratio * sE);
  const velocity = Number.isFinite(rate)
    ? rotate(-rate * sE, rate * ratio * cE)
    : rotate(-speed * (sE / denominator), speed * ((ratio * cE) / denominator));
  if (!position.every(Number.isFinite) || !velocity.every(Number.isFinite))
    throw new MargoError('state', 'Orbital state exceeds numeric range; use representable size and mass.');
  return { position, velocity };
}

/** A moving sample of a thin circular disk with a prescribed constant radial drift. */
export interface KeplerDiskOptions {
  /** Central gravitational parameter in m³/s². */
  readonly gravitationalParameter: number;
  /** Radius of the tracer at the reference time in metres. */
  readonly radius: number;
  /** Initial azimuth in radians. Defaults to zero. */
  readonly azimuth?: number;
  /** Constant radial velocity in m/s. Defaults to zero. Negative values drift inward. */
  readonly radialVelocity?: number;
}

/** Disk sample in its xy plane relative to the primary. */
export interface KeplerDiskSample extends KeplerState {
  readonly radius: number;
  readonly azimuth: number;
}

/** Advances a thin-disk tracer's radius and integrates Kepler angular speed along the drift. */
export function keplerDiskSample(options: KeplerDiskOptions, seconds = 0): KeplerDiskSample {
  if (options === null || typeof options !== 'object')
    throw new MargoError(
      'state',
      'Invalid Kepler disk options. Pass an object with a gravitational parameter and radius.',
    );
  const mu = positive(options.gravitationalParameter, 'disk gravitational parameter');
  const initial = positive(options.radius, 'initial disk radius');
  const radial = options.radialVelocity ?? 0;
  if (!Number.isFinite(radial) || !Number.isFinite(seconds))
    throw new MargoError('state', 'Invalid disk motion. Pass a finite radial velocity and signed seconds.');
  const radius = positive(initial + radial * seconds, 'advanced disk radius');
  const a = Math.sqrt(initial);
  const b = Math.sqrt(radius);
  const direct = (((2 * Math.sqrt(mu)) / a / b) * seconds) / (a + b);
  const change =
    initial === radius && radial === 0 && (!Number.isFinite(direct) || direct === 0)
      ? phaseAdvance(circularSpeed(mu, radius), radius, seconds)
      : direct;
  const azimuth = angle(angle(options.azimuth ?? 0) + angle(change));
  const tangential = circularSpeed(mu, radius);
  const c = cos(azimuth);
  const s = sin(azimuth);
  const velocity: OrbitVector = [radial * c - tangential * s, radial * s + tangential * c, 0];
  if (!velocity.every(Number.isFinite))
    throw new MargoError('state', 'Disk velocity exceeds numeric range. Choose a larger radius or smaller mass.');
  return { radius, azimuth, position: [radius * c, radius * s, 0], velocity };
}
