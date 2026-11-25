import type { Vec3 } from '@margoengine/core';
import { cos, sin } from '@margoengine/math/pinned';
import { scale, sub } from '@margoengine/math/vec3';

import { ASTRONOMICAL_UNIT } from './effects.js';
import { meeusLunarPosition } from '../../../shared/meeus-lunar.js';
import { STANDISH_ORBITS } from '../../../shared/standish-orbits.js';
import { CENTURY_SECONDS, DAY_SECONDS, meanEclipticToJ2000 } from './orientation.js';

const RAD = Math.PI / 180;
const sinDegrees = (angle: number) => sin((angle % 360) * RAD);
const cosDegrees = (angle: number) => cos((angle % 360) * RAD);
const LUNAR_MASS_SHARE = 1 / (1 + 81.30056822149722);
const ANALYTIC_START = (2378496.5 - 2451545) * DAY_SECONDS;
const ANALYTIC_END = (2469807.5 - 2451545) * DAY_SECONDS;

const PLANETS = ['mercury', 'venus', 'earth', 'mars', 'jupiter', 'saturn', 'uranus', 'neptune'] as const;

function solveKepler(mean: number, eccentricity: number): number {
  const m = ((((mean + Math.PI) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI)) - Math.PI;
  let e = m + eccentricity * sin(m);
  // All Table 1 eccentricities are below 0.21, so starting within 0.21 of the root and taking six
  // Newton steps gives a residual set by f64 rounding rather than iteration count.
  for (let i = 0; i < 6; i++) e -= (e - eccentricity * sin(e) - m) / (1 - eccentricity * cos(e));
  return e;
}

function heliocentric(planet: number, t: number): Vec3 {
  const { at: start, rate } = STANDISH_ORBITS[PLANETS[planet - 1]!];
  const a = ASTRONOMICAL_UNIT * (start[0] + rate[0] * t);
  const e = start[1] + rate[1] * t;
  const inclination = RAD * (start[2] + rate[2] * t);
  const longitude = start[3] + rate[3] * t;
  const perihelion = start[4] + rate[4] * t;
  const node = RAD * (start[5] + rate[5] * t);
  const anomaly = solveKepler(RAD * (longitude - perihelion), e);
  const xp = a * (cos(anomaly) - e);
  const yp = a * Math.sqrt(1 - e * e) * sin(anomaly);
  const omega = RAD * perihelion - node;
  const orbitalX = cos(omega) * xp - sin(omega) * yp;
  const orbitalY = sin(omega) * xp + cos(omega) * yp;
  return meanEclipticToJ2000(0, [
    cos(node) * orbitalX - sin(node) * cos(inclination) * orbitalY,
    sin(node) * orbitalX + cos(node) * cos(inclination) * orbitalY,
    sin(inclination) * orbitalY,
  ]);
}

export interface AnalyticPositions {
  readonly sun: Vec3;
  readonly moon: Vec3;
  planet(id: number): Vec3;
}

export function analyticPositions(tdbSeconds: number): AnalyticPositions {
  if (!(tdbSeconds >= ANALYTIC_START && tdbSeconds <= ANALYTIC_END))
    throw new RangeError('Use a JPL SPK file for epochs outside the 1800–2050 range of the bundled orbit elements.');
  const t = tdbSeconds / CENTURY_SECONDS;
  const { latitude, longitude, distance } = meeusLunarPosition(t, sinDegrees, cosDegrees);
  const l = RAD * (longitude % 360);
  const b = RAD * latitude;
  const radius = 1000 * distance;
  const projected = radius * cos(b);
  const moon = meanEclipticToJ2000(t, [projected * cos(l), projected * sin(l), radius * sin(b)]);
  const earth = sub(heliocentric(3, t), scale(moon, LUNAR_MASS_SHARE));
  return { sun: scale(earth, -1), moon, planet: (id) => sub(heliocentric(id, t), earth) };
}
