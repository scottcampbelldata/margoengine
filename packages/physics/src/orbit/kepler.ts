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
    throw new RangeError('Orbital angle is outside numeric range; use a finite angle or time.');
  return value % TAU;
}

function positive(value: number, name: string): number {
  if (!(Number.isFinite(value) && value > 0))
    throw new RangeError(`Invalid ${name}; pass a finite positive value in SI units.`);
  return value;
}

function eccentricAnomaly(mean: number, eccentricity: number): number {
  if (mean === 0 || eccentricity === 0) return mean;
  // E - e sin(E) is strictly increasing for e < 1. Its root is in [M - e, M + e].
  let lower = mean - eccentricity;
  let upper = mean + eccentricity;
  while (true) {
    const middle = (lower + upper) * 0.5;
    if (middle === lower || middle === upper) return middle;
    const residual = middle - eccentricity * sin(middle) - mean;
    if (residual === 0) return middle;
    if (residual > 0) upper = middle;
    else lower = middle;
  }
}

/** Evaluates a bound two-body orbit at a signed time relative to the epoch in seconds. */
export function keplerState(elements: KeplerElements, seconds = 0): KeplerState {
  const mu = positive(elements.gravitationalParameter, 'gravitational parameter');
  const a = positive(elements.semimajorAxis, 'semimajor axis');
  const e = elements.eccentricity ?? 0;
  if (!(e >= 0 && e < 1))
    throw new RangeError('A Kepler ellipse requires eccentricity in [0, 1); choose a bound orbit.');
  const inclination = angle(elements.inclination ?? 0);
  const node = angle(elements.ascendingNode ?? 0);
  const periapsis = angle(elements.argumentOfPeriapsis ?? 0);
  const eccentric = eccentricAnomaly(
    angle(angle(elements.meanAnomalyAtEpoch ?? 0) + angle((Math.sqrt(mu / a) / a) * seconds)),
    e,
  );
  const cE = cos(eccentric);
  const sE = sin(eccentric);
  const ratio = Math.sqrt((1 - e) * (1 + e));
  const rate = Math.sqrt(mu / a) / (1 - e * cE);
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
  const position = rotate(a * (cE - e), a * ratio * sE);
  const velocity = rotate(-rate * sE, rate * ratio * cE);
  if (!position.every(Number.isFinite) || !velocity.every(Number.isFinite))
    throw new RangeError('Orbital state exceeds numeric range; use representable size and mass.');
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
  const mu = positive(options.gravitationalParameter, 'disk gravitational parameter');
  const initial = positive(options.radius, 'initial disk radius');
  const radial = options.radialVelocity ?? 0;
  const radius = positive(initial + radial * seconds, 'advanced disk radius');
  const a = Math.sqrt(initial);
  const b = Math.sqrt(radius);
  const change = (((2 * Math.sqrt(mu)) / a / b) * seconds) / (a + b);
  const azimuth = angle(angle(options.azimuth ?? 0) + angle(change));
  const tangential = Math.sqrt(mu / radius);
  const c = cos(azimuth);
  const s = sin(azimuth);
  return {
    radius,
    azimuth,
    position: [radius * c, radius * s, 0],
    velocity: [radial * c - tangential * s, radial * s + tangential * c, 0],
  };
}
