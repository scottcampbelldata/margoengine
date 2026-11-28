import { cos, sin } from '@margoengine/math/pinned';
import type { Vec3 } from '@margoengine/core';
import { dot } from '@margoengine/math/vec3';
import { celestialError } from './errors.js';

export const DAY_SECONDS = 86400;
export const CENTURY_SECONDS = 36525 * DAY_SECONDS;
const TURN = Math.PI * 2;
const RAD = Math.PI / 180;
const ARCSECOND = RAD / 3600;

type Matrix = readonly [Vec3, Vec3, Vec3];

/** Celestial intermediate pole direction cosines and the CIO locator in radians, per IERS Conventions chapter 5. */
export interface CelestialPole {
  readonly x: number;
  readonly y: number;
  readonly cio: number;
}

/** Observed Earth orientation at the sample epoch. Polar motion coordinates and the TIO locator are in radians. */
export interface EarthOrientation {
  /** IERS celestial pole and locator. Defaults to IAU 2006 precession with a four-term nutation model. */
  readonly celestialPole?: CelestialPole;
  /** Terrestrial polar motion xp. Defaults to zero. */
  readonly polarX?: number;
  /** Terrestrial polar motion yp. Defaults to zero. */
  readonly polarY?: number;
  /** Terrestrial intermediate origin locator. Defaults to its IERS secular term. */
  readonly tio?: number;
}

/** The IAU Earth rotation angle in [0, 2π), given UT1 seconds from Julian Date 2451545.0. */
export function earthRotationAngle(ut1Seconds: number): number {
  if (!Number.isFinite(ut1Seconds)) throw celestialError('Pass finite UT1 seconds from Julian Date 2451545.0.');
  const days = ut1Seconds / DAY_SECONDS;
  // IERS equation 5.15 separates the UT1 day fraction to retain precision far from J2000.
  const turns = (days % 1) + 0.779057273264 + 0.00273781191135448 * days;
  return TURN * (turns - Math.floor(turns));
}

function polynomial(t: number, terms: readonly number[]): number {
  let result = 0;
  for (let i = terms.length - 1; i >= 0; i--) result = terms[i]! + t * result;
  return result;
}

function precessionAngles(t: number) {
  // Wallace and Capitaine (2006), equation 4.
  return {
    gamma: ARCSECOND * polynomial(t, [-0.052928, 10.556378, 0.4932044, -0.00031238, -0.000002788, 2.6e-8]),
    phi: ARCSECOND * polynomial(t, [84381.412819, -46.811016, 0.0511268, 0.00053289, -4.4e-7, -1.76e-8]),
    psi: polynomial(t, [-0.041775, 5038.481484, 1.5584175, -0.00018522, -0.000026452, -1.48e-8]),
    obliquity: polynomial(t, [84381.406, -46.836769, -0.0001831, 0.0020034, -5.76e-7, -4.34e-8]),
  };
}

/** Convert a mean ecliptic and equinox of date vector to J2000 equatorial axes. */
export function meanEclipticToJ2000(t: number, [x, y, z]: Vec3): Vec3 {
  const { gamma, phi, psi } = precessionAngles(t);
  // Invert equation 7 without nutation. The obliquity cancels when the input is already ecliptic.
  const longitude = ARCSECOND * psi;
  const u = cos(longitude) * x + sin(longitude) * y;
  const v = -sin(longitude) * x + cos(longitude) * y;
  const w = cos(phi) * v - sin(phi) * z;
  return [cos(gamma) * u - sin(gamma) * w, sin(gamma) * u + cos(gamma) * w, sin(phi) * v + cos(phi) * z];
}

function modeledCelestialPole(t: number): CelestialPole {
  const { gamma, phi, psi: precession, obliquity } = precessionAngles(t);
  // Meeus, Astronomical Algorithms, the four dominant terms in longitude and obliquity.
  const node = RAD * (125.04452 - 1934.136261 * t);
  const sun = 2 * RAD * (280.4665 + 36000.7698 * t);
  const moon = 2 * RAD * (218.3165 + 481267.8813 * t);
  const psi = ARCSECOND * (precession - 17.2 * sin(node) - 1.32 * sin(sun) - 0.23 * sin(moon) + 0.21 * sin(2 * node));
  const epsilon = ARCSECOND * (obliquity + 9.2 * cos(node) + 0.57 * cos(sun) + 0.1 * cos(moon) - 0.09 * cos(2 * node));

  const a = sin(epsilon) * sin(psi);
  const b = sin(epsilon) * cos(psi) * cos(phi) - cos(epsilon) * sin(phi);
  const x = a * cos(gamma) - b * sin(gamma);
  const y = a * sin(gamma) + b * cos(gamma);
  // IERS Table 5.2d, in microarcseconds, including its dominant periodic term.
  const cioPlus =
    polynomial(t, [94, 3808.65, -122.68, -72574.11, 27.98, 15.62]) - 2640.73 * sin(node) + 0.39 * cos(node);
  return { x, y, cio: cioPlus * (ARCSECOND * 1e-6) - 0.5 * x * y };
}

/** The ICRF/J2000 to Earth-fixed transformation, with the associated Earth rotation angle. */
export interface EarthFrame {
  /** Rotation of the Earth from the celestial intermediate origin, in radians. */
  readonly rotation: number;
  /** Row-major matrix taking celestial vectors to Earth-fixed vectors. */
  readonly matrix: Matrix;
}

/**
 * Construct an Earth-fixed frame from separate terrestrial and Earth-rotation times.
 * @param ttSeconds TT seconds since Julian Date 2451545.0.
 * @param ut1Seconds UT1 seconds since Julian Date 2451545.0.
 * @param orientation Optional measured celestial and terrestrial pole terms for this epoch.
 */
export function earthFrame(ttSeconds: number, ut1Seconds: number, orientation: EarthOrientation = {}): EarthFrame {
  if (!Number.isFinite(ttSeconds)) throw celestialError('Pass finite TT seconds from Julian Date 2451545.0.');
  const rotation = earthRotationAngle(ut1Seconds);
  const t = ttSeconds / CENTURY_SECONDS;
  const { x, y, cio } = orientation.celestialPole ?? modeledCelestialPole(t);
  const xp = orientation.polarX ?? 0;
  const yp = orientation.polarY ?? 0;
  const tio = orientation.tio ?? -47e-6 * ARCSECOND * t;
  const radiusSquared = x * x + y * y;
  if (
    !(radiusSquared < 1) ||
    !Number.isFinite(cio) ||
    !Number.isFinite(xp) ||
    !Number.isFinite(yp) ||
    !Number.isFinite(tio)
  )
    throw celestialError('Pass finite IERS orientation values with a celestial pole in the northern unit hemisphere.');

  // Wallace and Capitaine equation 9, followed by R3(ERA) of the IERS convention for CIRS to TIRS.
  const z = Math.sqrt(1 - radiusSquared);
  const a = 1 / (1 + z);
  const c = cos(cio - rotation - tio);
  const s = sin(cio - rotation - tio);
  const polarXCos = cos(xp);
  const polarXSin = sin(xp);
  const polarYCos = cos(yp);
  const polarYSin = sin(yp);

  const column = (i: number, j: number, k: number): Vec3 => {
    const u = c * i - s * j;
    const v = s * i + c * j;
    // Inverse of the terrestrial polar-motion matrix W, IERS equation 5.3.
    const tx = polarXCos * u + polarXSin * k;
    const tz = -polarXSin * u + polarXCos * k;
    return [tx, polarYCos * v - polarYSin * tz, polarYSin * v + polarYCos * tz];
  };

  const first = column(1 - a * x * x, -a * x * y, x);
  const second = column(-a * x * y, 1 - a * y * y, y);
  const third = column(-x, -y, z);
  return {
    rotation,
    matrix: [
      [first[0], second[0], third[0]],
      [first[1], second[1], third[1]],
      [first[2], second[2], third[2]],
    ],
  };
}

/** Rotate a J2000 vector into Earth-fixed Cartesian axes. */
export function toEarthFixed(frame: EarthFrame, vector: Vec3): Vec3 {
  return [dot(frame.matrix[0], vector), dot(frame.matrix[1], vector), dot(frame.matrix[2], vector)];
}

/** Rotate an Earth-fixed Cartesian vector into J2000 axes. */
export function toJ2000(frame: EarthFrame, [x, y, z]: Vec3): Vec3 {
  const [first, second, third] = frame.matrix;
  return [
    x * first[0] + y * second[0] + z * third[0],
    x * first[1] + y * second[1] + z * third[1],
    x * first[2] + y * second[2] + z * third[2],
  ];
}
