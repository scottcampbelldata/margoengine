/// <reference lib="esnext.disposable" preserve="true" />
// The sun, moon, planets and stars for a date, time and place, from published astronomy: Meeus, "Astronomical
// Algorithms" (2nd ed., 1998) for time, sidereal time, nutation, precession, the sun (ch. 25), the moon (ch. 47 and 48)
// and planet magnitudes (ch. 41); Standish, "Keplerian Elements for Approximate Positions of the Major Planets" (JPL
// Solar System Dynamics) for the planets; Espenak and Meeus (NASA, 2006) for Delta T; Saemundsson (Sky and Telescope
// 72, 1986) for refraction; Kasten and Young (Applied Optics 28, 1989) for air mass; Ballesteros (EPL 97, 2012) for a
// star's temperature from B-V. The star catalogue is read in the byte layout of the Yale Bright Star Catalogue, 5th
// edition (Hoffleit and Warren, 1991, CDS V/50).
import type { EngineKernel } from '@margoengine/core';
import {
  engineRuntime,
  type Engine,
  type EnginePlugin,
  type FrameGraph,
  type PassContext,
} from '@margoengine/core/extension';
import { MargoError } from '@margoengine/math/errors';
import type { Vec3 } from '@margoengine/math';
import { ParticleOverlay } from '../../shared/particle-overlay.js';
import { viewSize } from '../../shared/view-rect.js';
import { degrees, isAngle, type Angle } from './sun.js';
import type { SkyNightOptions } from './base.js';

declare const GPUBufferUsage: { UNIFORM: number; COPY_DST: number; STORAGE: number };
type Context = Extract<PassContext, { backend: 'webgpu' }>;

const rad = Math.PI / 180,
  sin = (d: number) => Math.sin(d * rad),
  cos = (d: number) => Math.cos(d * rad),
  turn = (d: number) => ((d % 360) + 360) % 360,
  /** Kilometres in one astronomical unit (IAU 2012). */
  au = 149597870.7,
  /** Equatorial radius of the Earth in km (IAU 1976, as Meeus uses), for the moon's parallax. */
  earthRadius = 6378.14;

/** Where on the Earth the sky is seen from. */
export interface Observer {
  /** Latitude, `degrees(-90)` (south pole) to `degrees(90)` (north pole). */
  latitude: Angle;
  /** Longitude, positive east of Greenwich, -180 to 180 degrees. */
  longitude: Angle;
}

/** Options shared by the position functions. */
export interface AstroOptions {
  /** Terrestrial minus universal time in seconds. Default {@link deltaT} of the date. */
  deltaT?: number;
  /** Lift each body by the atmosphere's refraction (Saemundsson 1986, standard air). Default true. */
  refraction?: boolean;
}

/** A body's place in the sky. */
export interface CelestialPosition {
  /** Apparent right ascension, geocentric, equator and equinox of date, 0 to 360 degrees. */
  rightAscension: Angle;
  /** Apparent declination, geocentric, equator of date. */
  declination: Angle;
  /** Distance from the Earth's centre in km. */
  distance: number;
  /** Compass angle seen from the observer, in the convention of `@margoengine/sky/sun`: 0 is +Z (south), 90 is +X (east). */
  azimuth: Angle;
  /** Height above the horizon seen from the observer (topocentric), refracted unless `refraction` is false. */
  elevation: Angle;
  /** Unit world vector toward the body, as `sunDirectionFrom(azimuth, elevation)` gives: east +X, up +Y, north -Z. */
  direction: Vec3;
}

/** The moon's place, with its phase. */
export interface MoonPosition extends CelestialPosition {
  /** Lit fraction of the disc seen from the Earth, 0 (new) to 1 (full) (Meeus 48.1). */
  illumination: number;
  /** Sun-moon-Earth angle: 180 degrees at new moon, 0 at full. */
  phaseAngle: Angle;
  /** True while the lit fraction grows (new to full). */
  waxing: boolean;
  /** Angular radius of the disc seen from the observer. */
  angularRadius: Angle;
}

/** The planets {@link planetPositions} returns, in this order. */
export const planetNames = ['mercury', 'venus', 'mars', 'jupiter', 'saturn', 'uranus', 'neptune'] as const;
/** One of {@link planetNames}. */
export type PlanetName = (typeof planetNames)[number];

/** A planet's place and brightness. */
export interface PlanetPosition extends CelestialPosition {
  name: PlanetName;
  /** Visual magnitude (Meeus 41; Saturn without its rings). */
  magnitude: number;
  /** Unit geocentric vector in the J2000 mean equator and equinox, light time included: what {@link skyMatrix} maps. */
  j2000: Vec3;
}

const checkDate = (date: unknown): Date => {
  if (!(date instanceof Date) || !Number.isFinite(date.getTime()))
    throw new TypeError('Pass the time as a valid Date, for example new Date("2026-11-07T22:00:00Z").');
  return date;
};

const checkObserver = (observer: Observer): { phi: number; lambda: number } => {
  if (typeof observer !== 'object' || observer === null || !isAngle(observer.latitude) || !isAngle(observer.longitude))
    throw new TypeError('Pass the observer as { latitude: degrees(..), longitude: degrees(..) }.');
  const phi = observer.latitude.degrees,
    lambda = observer.longitude.degrees;
  if (Math.abs(phi) > 90) throw new RangeError(`Invalid latitude ${observer.latitude}; use -90 to 90 degrees.`);
  if (Math.abs(lambda) > 180) throw new RangeError(`Invalid longitude ${observer.longitude}; use -180 to 180 degrees.`);
  return { phi, lambda };
};

/**
 * Julian Day of a moment (universal time): days since noon of 1 January 4713 BC in the proleptic Julian calendar.
 * @throws TypeError when `date` is not a valid Date.
 * @example julianDay(new Date(Date.UTC(2000, 0, 1, 12))); // 2451545
 */
export function julianDay(date: Date): number {
  return checkDate(date).getTime() / 86400000 + 2440587.5;
}

/**
 * Terrestrial minus universal time in seconds for a date, from the polynomials of Espenak and Meeus (NASA, "Five
 * Millennium Canon of Solar Eclipses", 2006) between 1961 and 2150, and their long-term parabola outside. Past the
 * last measured year it is a prediction, uncertain by seconds.
 * @example deltaT(new Date('2026-01-01')); // about 72
 */
export function deltaT(date: Date): number {
  const y = 2000 + (julianDay(date) - 2451545) / 365.25;
  if (y >= 2005 && y < 2050) {
    const t = y - 2000;
    return 62.92 + 0.32217 * t + 0.005589 * t * t;
  }
  if (y >= 1986 && y < 2005) {
    const t = y - 2000;
    return 63.86 + t * (0.3345 + t * (-0.060374 + t * (0.0017275 + t * (0.000651814 + t * 0.00002373599))));
  }
  if (y >= 1961 && y < 1986) {
    const t = y - 1975;
    return 45.45 + 1.067 * t - (t * t) / 260 - (t * t * t) / 718;
  }
  const u = (y - 1820) / 100;
  return y >= 2050 && y < 2150 ? -20 + 32 * u * u - 0.5628 * (2150 - y) : -20 + 32 * u * u;
}

/** Julian Day in universal time and Julian centuries of terrestrial time from J2000.0. */
const timeOf = (date: Date, options: AstroOptions = {}) => {
  const jd = julianDay(date),
    dt = options.deltaT ?? deltaT(date);
  if (!Number.isFinite(dt))
    throw new RangeError(`Invalid deltaT ${dt}; pass seconds of terrestrial minus universal time.`);
  return { jd, t: (jd + dt / 86400 - 2451545) / 36525 };
};

/** Mean obliquity of the ecliptic in degrees (Meeus 22.2), for `t` Julian centuries of TT from J2000.0. */
const meanObliquity = (t: number) => 23.4392911111 - (46.815 * t + 0.00059 * t * t - 0.001813 * t * t * t) / 3600;

/** Nutation in longitude and obliquity in degrees, to 0.5 and 0.1 arcseconds (Meeus 22, the short series). */
const nutationOf = (t: number) => {
  const omega = 125.04452 - 1934.136261 * t,
    l = 280.4665 + 36000.7698 * t,
    m = 218.3165 + 481267.8813 * t;
  return {
    psi: (-17.2 * sin(omega) - 1.32 * sin(2 * l) - 0.23 * sin(2 * m) + 0.21 * sin(2 * omega)) / 3600,
    epsilon: (9.2 * cos(omega) + 0.57 * cos(2 * l) + 0.1 * cos(2 * m) - 0.09 * cos(2 * omega)) / 3600,
  };
};

/** Nutation of the Earth's axis for a date, and the obliquity of the ecliptic. */
export interface Nutation {
  /** Nutation in longitude (delta psi). */
  longitude: Angle;
  /** Nutation in obliquity (delta epsilon). */
  obliquity: Angle;
  /** Mean obliquity of the ecliptic (Meeus 22.2). */
  meanObliquity: Angle;
  /** True obliquity: the mean plus the nutation in obliquity. */
  trueObliquity: Angle;
}

/**
 * Nutation and obliquity for a date (Meeus 22, the short series: within 0.5 arcseconds in longitude and 0.1 in obliquity
 * of the full IAU 1980 theory).
 * @throws TypeError for an invalid Date; RangeError for a non-finite `deltaT`.
 */
export function nutation(date: Date, options: AstroOptions = {}): Nutation {
  const { t } = timeOf(date, options),
    n = nutationOf(t),
    e = meanObliquity(t);
  return {
    longitude: degrees(n.psi),
    obliquity: degrees(n.epsilon),
    meanObliquity: degrees(e),
    trueObliquity: degrees(e + n.epsilon),
  };
}

/** Row-major 3 x 3 product. */
const mul = (a: ArrayLike<number>, b: ArrayLike<number>) => {
  const o = new Float64Array(9);
  for (let r = 0; r < 3; r++)
    for (let c = 0; c < 3; c++) o[r * 3 + c] = a[r * 3] * b[c] + a[r * 3 + 1] * b[3 + c] + a[r * 3 + 2] * b[6 + c];
  return o;
};
/** Frame rotations about x and z by `d` degrees (Meeus' R1 and R3 conventions). */
const rot1 = (d: number) => Float64Array.of(1, 0, 0, 0, cos(d), sin(d), 0, -sin(d), cos(d));
const rot2 = (d: number) => Float64Array.of(cos(d), 0, -sin(d), 0, 1, 0, sin(d), 0, cos(d));
const rot3 = (d: number) => Float64Array.of(cos(d), sin(d), 0, -sin(d), cos(d), 0, 0, 0, 1);
const apply = (m: ArrayLike<number>, v: ArrayLike<number>): Vec3 => [
  m[0] * v[0] + m[1] * v[1] + m[2] * v[2],
  m[3] * v[0] + m[4] * v[1] + m[5] * v[2],
  m[6] * v[0] + m[7] * v[1] + m[8] * v[2],
];

/** Precession from the J2000.0 mean equator to the mean equator of `t` (Meeus 21.2 and 21.3, rigorous, row-major). */
const precessionOf = (t: number) => {
  const zeta = (2306.2181 * t + 0.30188 * t * t + 0.017998 * t * t * t) / 3600,
    z = (2306.2181 * t + 1.09468 * t * t + 0.018203 * t * t * t) / 3600,
    theta = (2004.3109 * t - 0.42665 * t * t - 0.041833 * t * t * t) / 3600;
  return mul(rot3(-z), mul(rot2(theta), rot3(-zeta)));
};

/**
 * The rotation from the J2000.0 mean equator and equinox to the mean equator and equinox of a date (Meeus 21, the
 * rigorous method with the IAU 1976 angles): a row-major 3 x 3 matrix for equatorial unit vectors (x toward the
 * equinox, z toward the north pole).
 * @throws TypeError for an invalid Date; RangeError for a non-finite `deltaT`.
 */
export function precessionMatrix(date: Date, options: AstroOptions = {}): Float64Array {
  return precessionOf(timeOf(date, options).t);
}

/** Greenwich mean sidereal time in degrees (Meeus 12.4) for a Julian Day of universal time. */
const meanSidereal = (jd: number) => {
  const d = jd - 2451545,
    t = d / 36525;
  return turn(280.46061837 + 360.98564736629 * d + 0.000387933 * t * t - (t * t * t) / 38710000);
};

/**
 * Greenwich sidereal time: the hour angle of the equinox, 0 to 360 degrees. `apparent` adds the equation of the
 * equinoxes (nutation in longitude times the cosine of the obliquity). Add the east longitude for local sidereal time.
 * @throws TypeError for an invalid Date; RangeError for a non-finite `deltaT`.
 * @example greenwichSiderealTime(new Date(Date.UTC(1987, 3, 10))).degrees; // 197.693195 (Meeus 12.a)
 */
export function greenwichSiderealTime(date: Date, options: AstroOptions & { apparent?: boolean } = {}): Angle {
  const { jd, t } = timeOf(date, options);
  if (!options.apparent) return degrees(meanSidereal(jd));
  const n = nutationOf(t);
  return degrees(turn(meanSidereal(jd) + n.psi * cos(meanObliquity(t) + n.epsilon)));
}

/** The frame shared by one moment and place: nutation, true obliquity, local apparent sidereal time and latitude. */
const frameOf = (date: Date, observer: Observer, options: AstroOptions = {}) => {
  const { jd, t } = timeOf(date, options),
    { phi, lambda } = checkObserver(observer),
    n = nutationOf(t),
    e0 = meanObliquity(t),
    e = e0 + n.epsilon,
    local = turn(meanSidereal(jd) + n.psi * cos(e) + lambda),
    // Equatorial of date to world (x east, y up, z south): the hour angle is local sidereal time minus right ascension.
    horizon = Float64Array.of(
      -sin(local),
      cos(local),
      0,
      cos(phi) * cos(local),
      cos(phi) * sin(local),
      sin(phi),
      sin(phi) * cos(local),
      sin(phi) * sin(local),
      -cos(phi),
    ),
    // Mean of date to true of date: to the ecliptic, along it by delta psi, back with the true obliquity.
    nutate = mul(rot1(-e), mul(rot3(-n.psi), rot1(e0)));
  return { t, n, e, horizon, nutate, refraction: options.refraction ?? true };
};

/**
 * The rotation from J2000.0 equatorial unit vectors to world directions for a moment and place: precession, nutation,
 * the Earth's turn and the observer's latitude, row-major. World axes are those of `@margoengine/sky/sun`: east +X, up
 * +Y, north -Z. Stars are this matrix times their catalogue vector, before refraction; `AstroSky` draws them so.
 * @throws TypeError for an invalid Date or observer; RangeError for an observer out of range or a non-finite `deltaT`.
 */
export function skyMatrix(date: Date, observer: Observer, options: AstroOptions = {}): Float64Array {
  const f = frameOf(date, observer, options);
  return mul(f.horizon, mul(f.nutate, precessionOf(f.t)));
}

/**
 * Raises a true altitude by the refraction of standard air (Saemundsson 1986, with his zenith constant), in degrees.
 * Applied above -1 degree, where the formula holds; anything lower is still below the horizon after it.
 */
export function refract(altitude: number): number {
  if (!(altitude > -1)) return altitude;
  // Saemundsson's constant 0.0019279 arcminutes makes the refraction 0 at the zenith.
  return Math.min(90, altitude + (1.02 / Math.tan((altitude + 10.3 / (altitude + 5.11)) * rad) + 0.0019279) / 60);
}

/** A position from an apparent equatorial vector of date (unit) and its distance in km. */
const place = (
  frame: ReturnType<typeof frameOf>,
  equatorial: Vec3,
  distance: number,
): CelestialPosition & { range: number } => {
  const [ex, ey, ez] = equatorial,
    ra = turn(Math.atan2(ey, ex) / rad),
    dec = Math.asin(Math.max(-1, Math.min(1, ez))) / rad,
    // Topocentric: the observer stands one Earth radius up from the centre (a sphere: the flattening moves the moon by
    // under 0.2% of its parallax, about 7 arcseconds).
    g = apply(frame.horizon, equatorial),
    v: Vec3 = [g[0] * distance, g[1] * distance - earthRadius, g[2] * distance],
    length = Math.hypot(v[0], v[1], v[2]),
    trueAltitude = Math.asin(Math.max(-1, Math.min(1, v[1] / length))) / rad,
    altitude = frame.refraction ? refract(trueAltitude) : trueAltitude,
    azimuth = turn(Math.atan2(v[0], v[2]) / rad),
    level = Math.cos(altitude * rad);
  return {
    rightAscension: degrees(ra),
    declination: degrees(dec),
    distance,
    azimuth: degrees(azimuth),
    elevation: degrees(altitude),
    direction: [Math.sin(azimuth * rad) * level, Math.sin(altitude * rad), Math.cos(azimuth * rad) * level],
    range: length,
  };
};
const strip = ({ range: _, ...p }: CelestialPosition & { range: number }): CelestialPosition => p;

/** Ecliptic (of date) to equatorial unit vector with obliquity `e`. */
const fromEcliptic = (longitude: number, latitude: number, e: number): Vec3 => {
  const x = cos(latitude) * cos(longitude),
    y = cos(latitude) * sin(longitude),
    z = sin(latitude);
  return [x, y * cos(e) - z * sin(e), y * sin(e) + z * cos(e)];
};

/** Apparent geocentric longitude of the sun and its distance in AU (Meeus 25, the low-accuracy method: 0.01 degree). */
const solar = (t: number) => {
  const l0 = 280.46646 + 36000.76983 * t + 0.0003032 * t * t,
    m = 357.52911 + 35999.05029 * t - 0.0001537 * t * t,
    e = 0.016708634 - 0.000042037 * t - 0.0000001267 * t * t,
    c =
      (1.914602 - 0.004817 * t - 0.000014 * t * t) * sin(m) +
      (0.019993 - 0.000101 * t) * sin(2 * m) +
      0.000289 * sin(3 * m),
    r = (1.000001018 * (1 - e * e)) / (1 + e * cos(m + c)),
    omega = 125.04 - 1934.136 * t;
  return { longitude: turn(l0 + c - 0.00569 - 0.00478 * sin(omega)), distance: r, omega };
};

/**
 * The sun's place for a moment and place (Meeus 25, the low-accuracy method: about 0.01 degree).
 * @throws TypeError for an invalid Date or observer; RangeError for an observer out of range or a non-finite `deltaT`.
 * @example const sun = sunPosition(new Date(), { latitude: degrees(51.48), longitude: degrees(0) });
 */
export function sunPosition(date: Date, observer: Observer, options: AstroOptions = {}): CelestialPosition {
  const f = frameOf(date, observer, options),
    s = solar(f.t);
  // Meeus 25.8: the apparent place uses the mean obliquity plus 0.00256 cos(omega).
  return strip(place(f, fromEcliptic(s.longitude, 0, meanObliquity(f.t) + 0.00256 * cos(s.omega)), s.distance * au));
}

// Meeus Table 47.A: multiples of D, M, M', F, then the sine coefficient of longitude (1e-6 degree) and the cosine
// coefficient of distance (1e-3 km). Table 47.B: the same multiples and the sine coefficient of latitude.
// prettier-ignore
const lunarLR = [
  0, 0, 1, 0, 6288774, -20905355, 2, 0, -1, 0, 1274027, -3699111, 2, 0, 0, 0, 658314, -2955968, 0, 0, 2, 0, 213618,
  -569925, 0, 1, 0, 0, -185116, 48888, 0, 0, 0, 2, -114332, -3149, 2, 0, -2, 0, 58793, 246158, 2, -1, -1, 0, 57066,
  -152138, 2, 0, 1, 0, 53322, -170733, 2, -1, 0, 0, 45758, -204586, 0, 1, -1, 0, -40923, -129620, 1, 0, 0, 0, -34720,
  108743, 0, 1, 1, 0, -30383, 104755, 2, 0, 0, -2, 15327, 10321, 0, 0, 1, 2, -12528, 0, 0, 0, 1, -2, 10980, 79661, 4, 0,
  -1, 0, 10675, -34782, 0, 0, 3, 0, 10034, -23210, 4, 0, -2, 0, 8548, -21636, 2, 1, -1, 0, -7888, 24208, 2, 1, 0, 0,
  -6766, 30824, 1, 0, -1, 0, -5163, -8379, 1, 1, 0, 0, 4987, -16675, 2, -1, 1, 0, 4036, -12831, 2, 0, 2, 0, 3994,
  -10445, 4, 0, 0, 0, 3861, -11650, 2, 0, -3, 0, 3665, 14403, 0, 1, -2, 0, -2689, -7003, 2, 0, -1, 2, -2602, 0, 2, -1,
  -2, 0, 2390, 10056, 1, 0, 1, 0, -2348, 6322, 2, -2, 0, 0, 2236, -9884, 0, 1, 2, 0, -2120, 5751, 0, 2, 0, 0, -2069, 0,
  2, -2, -1, 0, 2048, -4950, 2, 0, 1, -2, -1773, 4130, 2, 0, 0, 2, -1595, 0, 4, -1, -1, 0, 1215, -3958, 0, 0, 2, 2,
  -1110, 0, 3, 0, -1, 0, -892, 3258, 2, 1, 1, 0, -810, 2616, 4, -1, -2, 0, 759, -1897, 0, 2, -1, 0, -713, -2117, 2, 2,
  -1, 0, -700, 2354, 2, 1, -2, 0, 691, 0, 2, -1, 0, -2, 596, 0, 4, 0, 1, 0, 549, -1423, 0, 0, 4, 0, 537, -1117, 4, -1,
  0, 0, 520, -1571, 1, 0, -2, 0, -487, -1739, 2, 1, 0, -2, -399, 0, 0, 0, 2, -2, -381, -4421, 1, 1, 1, 0, 351, 0, 3, 0,
  -2, 0, -340, 0, 4, 0, -3, 0, 330, 0, 2, -1, 2, 0, 327, 0, 0, 2, 1, 0, -323, 1165, 1, 1, -1, 0, 299, 0, 2, 0, 3, 0,
  294, 0, 2, 0, -1, -2, 0, 8752,
];
// prettier-ignore
const lunarB = [
  0, 0, 0, 1, 5128122, 0, 0, 1, 1, 280602, 0, 0, 1, -1, 277693, 2, 0, 0, -1, 173237, 2, 0, -1, 1, 55413, 2, 0, -1, -1,
  46271, 2, 0, 0, 1, 32573, 0, 0, 2, 1, 17198, 2, 0, 1, -1, 9266, 0, 0, 2, -1, 8822, 2, -1, 0, -1, 8216, 2, 0, -2, -1,
  4324, 2, 0, 1, 1, 4200, 2, 1, 0, -1, -3359, 2, -1, -1, 1, 2463, 2, -1, 0, 1, 2211, 2, -1, -1, -1, 2065, 0, 1, -1, -1,
  -1870, 4, 0, -1, -1, 1828, 0, 1, 0, 1, -1794, 0, 0, 0, 3, -1749, 0, 1, -1, 1, -1565, 1, 0, 0, 1, -1491, 0, 1, 1, 1,
  -1475, 0, 1, 1, -1, -1410, 0, 1, 0, -1, -1344, 1, 0, 0, -1, -1335, 0, 0, 3, 1, 1107, 4, 0, 0, -1, 1021, 4, 0, -1, 1,
  833, 0, 0, 1, -3, 777, 4, 0, -2, 1, 671, 2, 0, 0, -3, 607, 2, 0, 2, -1, 596, 2, -1, 1, -1, 491, 2, 0, -2, 1, -451, 0,
  0, 3, -1, 439, 2, 0, 2, 1, 422, 2, 0, -3, -1, 421, 2, 1, -1, 1, -366, 2, 1, 0, 1, -351, 4, 0, 0, 1, 331, 2, -1, 1, 1,
  315, 2, -2, 0, -1, 302, 0, 0, 1, 3, -283, 2, 1, 1, -1, -229, 1, 1, 0, -1, 223, 1, 1, 0, 1, 223, 0, 1, -2, -1, -220, 2,
  1, -1, -1, -220, 1, 0, 1, 1, -185, 2, -1, -2, -1, 181, 0, 1, 2, 1, -177, 4, 0, -2, -1, 176, 4, -1, -1, -1, 166, 1, 0,
  1, -1, -164, 4, 0, 1, -1, 132, 1, 0, -1, -1, -119, 4, -1, 0, -1, 115, 2, -2, 0, 1, 107,
];

/** The moon's geometric ecliptic longitude and latitude of date in degrees and distance in km (Meeus 47, full series). */
const lunar = (t: number) => {
  const t2 = t * t,
    t3 = t2 * t,
    t4 = t3 * t,
    lp = 218.3164477 + 481267.88123421 * t - 0.0015786 * t2 + t3 / 538841 - t4 / 65194000,
    d = 297.8501921 + 445267.1114034 * t - 0.0018819 * t2 + t3 / 545868 - t4 / 113065000,
    m = 357.5291092 + 35999.0502909 * t - 0.0001536 * t2 + t3 / 24490000,
    mp = 134.9633964 + 477198.8675055 * t + 0.0087414 * t2 + t3 / 69699 - t4 / 14712000,
    f = 93.272095 + 483202.0175233 * t - 0.0036539 * t2 - t3 / 3526000 + t4 / 863310000,
    a1 = 119.75 + 131.849 * t,
    a2 = 53.09 + 479264.29 * t,
    a3 = 313.45 + 481266.484 * t,
    e = 1 - 0.002516 * t - 0.0000074 * t2;
  // Terms with the sun's anomaly M shrink with the Earth's orbit's eccentricity: times E for M once, E squared twice.
  const scale = (k: number) => (k === 0 ? 1 : k === 1 || k === -1 ? e : e * e);
  let sl = 0,
    sr = 0,
    sb = 0;
  for (let i = 0; i < lunarLR.length; i += 6) {
    const arg = lunarLR[i] * d + lunarLR[i + 1] * m + lunarLR[i + 2] * mp + lunarLR[i + 3] * f,
      k = scale(lunarLR[i + 1]);
    sl += lunarLR[i + 4] * k * sin(arg);
    sr += lunarLR[i + 5] * k * cos(arg);
  }
  for (let i = 0; i < lunarB.length; i += 5)
    sb +=
      lunarB[i + 4] *
      scale(lunarB[i + 1]) *
      sin(lunarB[i] * d + lunarB[i + 1] * m + lunarB[i + 2] * mp + lunarB[i + 3] * f);
  // Venus (A1), Jupiter (A2) and the Earth's flattening (L' terms).
  sl += 3958 * sin(a1) + 1962 * sin(lp - f) + 318 * sin(a2);
  sb +=
    -2235 * sin(lp) + 382 * sin(a3) + 175 * sin(a1 - f) + 175 * sin(a1 + f) + 127 * sin(lp - mp) - 115 * sin(lp + mp);
  return { longitude: turn(lp + sl / 1e6), latitude: sb / 1e6, distance: 385000.56 + sr / 1000 };
};

/**
 * The moon's place and phase for a moment and place: Meeus 47 with the full series of Tables 47.A and 47.B (about 10
 * arcseconds in longitude and 4 in latitude), topocentric (its parallax is up to a degree), and the lit fraction from
 * the sun's and moon's places (Meeus 48.2 and 48.3).
 * @throws TypeError for an invalid Date or observer; RangeError for an observer out of range or a non-finite `deltaT`.
 */
export function moonPosition(date: Date, observer: Observer, options: AstroOptions = {}): MoonPosition {
  const f = frameOf(date, observer, options),
    moon = lunar(f.t),
    longitude = moon.longitude + f.n.psi,
    { range, ...p } = place(f, fromEcliptic(longitude, moon.latitude, f.e), moon.distance),
    sun = solar(f.t),
    r = sun.distance * au,
    elongation = Math.acos(Math.max(-1, Math.min(1, cos(moon.latitude) * cos(longitude - sun.longitude)))),
    phase = Math.atan2(r * Math.sin(elongation), moon.distance - r * Math.cos(elongation));
  return {
    ...p,
    illumination: (1 + Math.cos(phase)) / 2,
    phaseAngle: degrees(phase / rad),
    waxing: turn(longitude - sun.longitude) < 180,
    // The moon's mean radius is 1737.4 km, seen from the observer.
    angularRadius: degrees(Math.asin(1737.4 / range) / rad),
  };
}

// Standish's Table 1 (valid 1800 to 2050), J2000 ecliptic and equinox: a (AU), e, I, L, longitude of perihelion and of
// the ascending node (degrees), then each rate per Julian century. Mercury to Neptune, with the Earth-Moon barycentre
// third.
// prettier-ignore
const elements = [
  0.38709927, 0.20563593, 7.00497902, 252.2503235, 77.45779628, 48.33076593, 0.00000037, 0.00001906, -0.00594749,
  149472.67411175, 0.16047689, -0.12534081, 0.72333566, 0.00677672, 3.39467605, 181.9790995, 131.60246718, 76.67984255,
  0.0000039, -0.00004107, -0.0007889, 58517.81538729, 0.00268329, -0.27769418, 1.00000261, 0.01671123, -0.00001531,
  100.46457166, 102.93768193, 0, 0.00000562, -0.00004392, -0.01294668, 35999.37244981, 0.32327364, 0, 1.52371034,
  0.0933941, 1.84969142, -4.55343205, -23.94362959, 49.55953891, 0.00001847, 0.00007882, -0.00813131, 19140.30268499,
  0.44441088, -0.29257343, 5.202887, 0.04838624, 1.30439695, 34.39644051, 14.72847983, 100.47390909, -0.00011607,
  -0.00013253, -0.00183714, 3034.74612775, 0.21252668, 0.20469106, 9.53667594, 0.05386179, 2.48599187, 49.95424423,
  92.59887831, 113.66242448, -0.0012506, -0.00050991, 0.00193609, 1222.49362201, -0.41897216, -0.28867794, 19.18916464,
  0.04725744, 0.77263783, 313.23810451, 170.9542763, 74.01692503, -0.00196176, -0.00004397, -0.00242939, 428.48202785,
  0.40805281, 0.04240589, 30.06992276, 0.00859048, 1.77004347, -55.12002969, 44.96476227, 131.78422574, 0.00026291,
  0.00005105, 0.00035372, 218.45945325, -0.32241464, -0.00508664,
];
/** Heliocentric J2000 ecliptic position in AU of body `k` (0 Mercury, 2 Earth-Moon barycentre, 8 Neptune). */
const orbit = (k: number, t: number): Vec3 => {
  const p = (i: number) => elements[k * 12 + i] + elements[k * 12 + 6 + i] * t,
    a = p(0),
    e = p(1),
    inclination = p(2),
    perihelion = p(4),
    node = p(5),
    w = perihelion - node,
    m = (turn(p(3) - perihelion + 180) - 180) * rad;
  // Kepler's equation by Newton's method from E = M: e < 0.21 here, so six steps reach double precision.
  let anomaly = m;
  for (let i = 0; i < 6; i++) anomaly -= (anomaly - e * Math.sin(anomaly) - m) / (1 - e * Math.cos(anomaly));
  const x = a * (Math.cos(anomaly) - e),
    y = a * Math.sqrt(1 - e * e) * Math.sin(anomaly);
  return [
    (cos(w) * cos(node) - sin(w) * sin(node) * cos(inclination)) * x +
      (-sin(w) * cos(node) - cos(w) * sin(node) * cos(inclination)) * y,
    (cos(w) * sin(node) + sin(w) * cos(node) * cos(inclination)) * x +
      (-sin(w) * sin(node) + cos(w) * cos(node) * cos(inclination)) * y,
    sin(w) * sin(inclination) * x + cos(w) * sin(inclination) * y,
  ];
};

// Meeus 41 (the Astronomical Almanac's formulas): magnitude at r = delta = 1 AU and the phase terms (i in degrees).
const magnitudes: ((i: number) => number)[] = [
  (i) => -0.42 + i * (0.038 + i * (-0.000273 + i * 0.000002)),
  (i) => -4.4 + i * (0.0009 + i * (0.000239 - i * 0.00000065)),
  (i) => -1.52 + 0.016 * i,
  (i) => -9.4 + 0.005 * i,
  () => -8.88,
  () => -7.19,
  () => -6.87,
];

/**
 * The seven planets' places and magnitudes for a moment and place, in the order of {@link planetNames}: Standish's
 * Keplerian elements (valid 1800 to 2050; JPL gives their error as up to tens of arcseconds, several arcminutes for
 * Saturn), light time included, the Earth taken from the Earth-Moon barycentre by the moon's place, precession and
 * nutation to the date. Aberration (up to 20.5 arcseconds) is not applied.
 * @throws TypeError for an invalid Date or observer; RangeError for an observer out of range or a non-finite `deltaT`.
 */
export function planetPositions(date: Date, observer: Observer, options: AstroOptions = {}): PlanetPosition[] {
  const f = frameOf(date, observer, options),
    toDate = mul(f.nutate, precessionOf(f.t)),
    moon = lunar(f.t),
    // The Earth sits 1 / (1 + 81.30057) of the Earth-Moon distance from the barycentre, away from the moon.
    m = fromEcliptic(moon.longitude, moon.latitude, 0),
    k = moon.distance / au / 82.30057,
    bary = orbit(2, f.t),
    earth: Vec3 = [bary[0] - m[0] * k, bary[1] - m[1] * k, bary[2] - m[2] * k],
    ej = 23.4392911111;
  return planetNames.map((name, index) => {
    const body = index < 2 ? index : index + 1;
    let helio = orbit(body, f.t),
      v: Vec3 = [helio[0] - earth[0], helio[1] - earth[1], helio[2] - earth[2]];
    // Light time: 0.0057755183 days per AU (Meeus 33.3); once is enough at these distances.
    helio = orbit(body, f.t - (0.0057755183 * Math.hypot(...v)) / 36525);
    v = [helio[0] - earth[0], helio[1] - earth[1], helio[2] - earth[2]];
    const delta = Math.hypot(...v),
      r = Math.hypot(...helio),
      big = Math.hypot(...earth),
      // J2000 ecliptic to J2000 equator.
      j2000: Vec3 = [
        v[0] / delta,
        (v[1] * cos(ej) - v[2] * sin(ej)) / delta,
        (v[1] * sin(ej) + v[2] * cos(ej)) / delta,
      ],
      i = Math.acos(Math.max(-1, Math.min(1, (r * r + delta * delta - big * big) / (2 * r * delta)))) / rad;
    return {
      ...strip(place(f, apply(toDate, j2000), delta * au)),
      name,
      magnitude: magnitudes[index](i) + 5 * Math.log10(r * delta),
      j2000,
    };
  });
}

/** Stars read by {@link parseBrightStarCatalog}, brightest first. */
export interface StarCatalog {
  /** Number of stars. */
  readonly count: number;
  /** Catalogue numbers (HR). */
  readonly numbers: Uint16Array;
  /** J2000.0 equatorial unit vectors at epoch 2000.0, x y z per star. */
  readonly positions: Float32Array;
  /** Proper motion as the change of each unit vector per Julian year, x y z per star (0 where the catalogue has none). */
  readonly motions: Float32Array;
  /** Visual magnitudes. */
  readonly magnitudes: Float32Array;
  /** B-V colour indices; NaN where the catalogue has none. */
  readonly colors: Float32Array;
  /** Names as the catalogue gives them (Bayer and Flamsteed, for example `Alp UMi`), trimmed; may be empty. */
  readonly names: readonly string[];
}

/**
 * Reads star records in the byte layout of the Yale Bright Star Catalogue, 5th revised edition (CDS V/50 `catalog`:
 * HR in bytes 1-4, name 5-14, J2000 right ascension 76-83, declination 84-90, V magnitude 103-107, B-V 110-114, proper
 * motion 149-160 in arcseconds a year, the right ascension's as a great-circle rate). Records with no J2000 position
 * (the 14 the catalogue removed) are skipped, as are stars fainter than `maxMagnitude`.
 * @throws MargoError `'format'` for a record whose position, magnitude or motion does not parse.
 */
export function parseBrightStarCatalog(text: string, options: { maxMagnitude?: number } = {}): StarCatalog {
  if (typeof text !== 'string') throw new TypeError('Pass the catalogue text as a string.');
  const limit = options.maxMagnitude ?? Infinity;
  const rows: { hr: number; name: string; v: Vec3; pm: Vec3; mag: number; bv: number }[] = [];
  const lines = text.split(/\r?\n/);
  for (let n = 0; n < lines.length; n++) {
    const line = lines[n];
    if (!line.trim()) continue;
    const field = (from: number, to: number) => line.slice(from - 1, to).trim(),
      optional = (from: number, to: number) => (field(from, to) ? Number(field(from, to)) : 0);
    if (!field(76, 90)) continue;
    const hr = Number(field(1, 4)),
      ra = (Number(field(76, 77)) + Number(field(78, 79)) / 60 + Number(field(80, 83)) / 3600) * 15,
      dec =
        (field(84, 84) === '-' ? -1 : 1) *
        (Number(field(85, 86)) + Number(field(87, 88)) / 60 + Number(field(89, 90)) / 3600),
      vText = field(103, 107),
      bvText = field(110, 114),
      mag = Number(vText),
      bv = bvText ? Number(bvText) : NaN,
      // Arcseconds a year to radians a year, along the unit vectors of increasing right ascension and declination.
      pa = (optional(149, 154) / 3600) * rad,
      pd = (optional(155, 160) / 3600) * rad;
    if (
      !Number.isInteger(hr) ||
      !(ra >= 0 && ra < 360) ||
      !(Math.abs(dec) <= 90) ||
      !vText ||
      !Number.isFinite(mag) ||
      (bvText && !Number.isFinite(bv)) ||
      !Number.isFinite(pa) ||
      !Number.isFinite(pd)
    )
      throw new MargoError(
        'failed',
        `Bright star record on line ${n + 1} does not parse: ${JSON.stringify(line.slice(0, 20))}; give the CDS V/50 catalog layout`,
      );
    if (mag > limit) continue;
    rows.push({
      hr,
      name: field(5, 14),
      v: [cos(dec) * cos(ra), cos(dec) * sin(ra), sin(dec)],
      pm: [-sin(ra) * pa - sin(dec) * cos(ra) * pd, cos(ra) * pa - sin(dec) * sin(ra) * pd, cos(dec) * pd],
      mag,
      bv,
    });
  }
  rows.sort((a, b) => a.mag - b.mag);
  const count = rows.length,
    numbers = new Uint16Array(count),
    positions = new Float32Array(count * 3),
    motions = new Float32Array(count * 3),
    magnitudes = new Float32Array(count),
    colors = new Float32Array(count);
  rows.forEach((s, i) => {
    numbers[i] = s.hr;
    positions.set(s.v, i * 3);
    motions.set(s.pm, i * 3);
    magnitudes[i] = s.mag;
    colors[i] = s.bv;
  });
  return { count, numbers, positions, motions, magnitudes, colors, names: rows.map((s) => s.name) };
}

/**
 * Fetches and reads a catalogue file in the layout {@link parseBrightStarCatalog} takes; a gzip file (as CDS serves it)
 * is unpacked first.
 * @throws MargoError `'failed'` for an HTTP error or a record that does not parse; the signal's reason on abort.
 */
export async function fetchBrightStarCatalog(
  url: string | URL,
  options: { signal?: AbortSignal; maxMagnitude?: number } = {},
): Promise<StarCatalog> {
  const response = await fetch(url, { signal: options.signal });
  if (!response.ok)
    throw new MargoError('failed', `Star catalogue ${String(url)} answered HTTP ${response.status}; check the URL`);
  let bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes[0] === 0x1f && bytes[1] === 0x8b)
    bytes = new Uint8Array(
      await new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer(),
    );
  return parseBrightStarCatalog(new TextDecoder('latin1').decode(bytes), options);
}

/**
 * Linear RGB of a star from its B-V index, peak 1: Ballesteros' temperature (EPL 97, 2012) and Planck's law at 610,
 * 550 and 465 nm. Unknown B-V (NaN) gives white.
 */
export function starColor(bv: number): Vec3 {
  if (!Number.isFinite(bv)) return [1, 1, 1];
  const b = Math.max(-0.4, Math.min(2, bv)),
    temperature = 4600 * (1 / (0.92 * b + 1.7) + 1 / (0.92 * b + 0.62)),
    planck = (nm: number) => 1 / (nm ** 5 * (Math.exp(1.4388e7 / (nm * temperature)) - 1)),
    c: Vec3 = [planck(610), planck(550), planck(465)],
    top = Math.max(...c);
  return [c[0] / top, c[1] / top, c[2] / top];
}

// Planet tints (B-V), a Margo design choice for the colour of each point.
const planetTints = [0.93, 0.82, 1.36, 0.83, 1.04, 0.56, 0.41];

/** The sky {@link AstroSky} drives: `Sky` from `@margoengine/sky`, or anything with the same options. */
export interface AstroSkyTarget {
  readonly options: { sunDirection?: readonly [number, number, number]; night?: SkyNightOptions };
  /** Day-night blend, 0 by day and 1 at night; the stars fade in with it. */
  readonly nightFactor?: number;
}

/** {@link AstroSky} settings, read every frame from `astro.options`. */
export interface AstroSkyOptions extends Observer, AstroOptions {
  /** The moment shown when attached. Default now. Read back the running clock with `astro.date`. */
  date?: Date;
  /** Seconds of sky time per real second, -1e6 to 1e6. Default 1 (real time); 0 holds the moment. */
  timeScale?: number;
  /**
   * The sky to drive: its `sunDirection`, and with a `night` option the moon's direction, phase and size and a lit limb
   * toward the sun; with a `catalog` its procedural stars are switched off.
   */
  sky?: AstroSkyTarget;
  /** Stars to draw, from {@link parseBrightStarCatalog} or {@link fetchBrightStarCatalog}. Default none. */
  catalog?: StarCatalog;
  /** Draw the planets as points. Default true. */
  planets?: boolean;
  /** Brightness of a magnitude 0 star (a point's summed value in the scene's linear units), 0 to 1000. Default 4. */
  brightness?: number;
  /** Faintest magnitude drawn, after extinction. Default 6.5 (the naked eye under a dark sky). */
  limitingMagnitude?: number;
  /** Extinction of the air in magnitudes per air mass (Kasten and Young 1989), 0 to 2. Default 0.2. */
  extinction?: number;
  /** Spread of each point (its Gaussian sigma) in pixels, 0.5 to 16. Default 1; the size does not change its brightness. */
  pointSize?: number;
}

const number = (value: unknown, name: string, low: number, high: number) => {
  if (value !== undefined && !(typeof value === 'number' && value >= low && value <= high))
    throw new RangeError(`Invalid AstroSky ${name} ${String(value)}; use a number from ${low} to ${high}.`);
};
const validate = (o: AstroSkyOptions) => {
  checkObserver(o);
  if (o.date !== undefined) checkDate(o.date);
  if (o.deltaT !== undefined && !Number.isFinite(o.deltaT))
    throw new RangeError('Invalid AstroSky deltaT; pass seconds.');
  number(o.timeScale, 'timeScale', -1e6, 1e6);
  number(o.brightness, 'brightness', 0, 1000);
  number(o.limitingMagnitude, 'limitingMagnitude', -30, 30);
  number(o.extinction, 'extinction', 0, 2);
  number(o.pointSize, 'pointSize', 0.5, 16);
  const c = o.catalog;
  if (c !== undefined && !(c && c.positions instanceof Float32Array && c.positions.length === c.count * 3))
    throw new TypeError('AstroSky catalog must come from parseBrightStarCatalog or fetchBrightStarCatalog.');
};

const shader = `struct U {view:mat4x4f,sky0:vec4f,sky1:vec4f,sky2:vec4f,eye:vec4f,screen:vec4f,params:vec4f,blend:vec4f}
@group(0) @binding(0) var<uniform> u:U;
@group(0) @binding(1) var<storage,read> stars:array<vec4f>;
struct O {@builtin(position) position:vec4f,@location(0) uv:vec2f,@location(1) color:vec3f}
@vertex fn vertex(@builtin(vertex_index) v:u32,@builtin(instance_index) i:u32)->O {
 var o:O;o.position=vec4f(2.0,2.0,2.0,1.0);o.uv=vec2f(0.0);o.color=vec3f(0.0);
 // Three vec4s a point: the J2000 vector at 2000.0 and the magnitude, the colour, the motion per Julian year.
 let s=stars[3u*i];let p=normalize(s.xyz+stars[3u*i+2u].xyz*u.eye.w);
 var d=normalize(vec3f(dot(u.sky0.xyz,p),dot(u.sky1.xyz,p),dot(u.sky2.xyz,p)));
 var h=degrees(asin(clamp(d.y,-1.0,1.0)));
 // Refraction (Saemundsson 1986) above -1 degree: the star rises along its vertical.
 if(u.params.z>0.5&&h>-1.0){h=min(90.0,h+(1.02/tan(radians(h+10.3/(h+5.11)))+0.0019279)/60.0);let level=length(d.xz);
  if(level>1e-6){d=vec3f(d.x/level*cos(radians(h)),sin(radians(h)),d.z/level*cos(radians(h)));}}
 if(h<=0.0){return o;}
 // Air mass of Kasten and Young (1989) and the extinction it brings, in magnitudes.
 let m=s.w+u.params.y/(sin(radians(h))+0.50572*pow(h+6.07995,-1.6364));
 if(m>u.params.w){return o;}
 let c=u.view*vec4f(u.eye.xyz+d,1.0);
 if(c.w<=0.0){return o;}
 let corners=array(vec2f(-1.0,-1.0),vec2f(1.0,-1.0),vec2f(-1.0,1.0),vec2f(-1.0,1.0),vec2f(1.0,-1.0),vec2f(1.0,1.0));
 let k=corners[v];
 // At the far plane (0 in reversed depth), so only the sky where nothing was drawn shows it. The quad reaches 4 sigma,
 // where the Gaussian has fallen to e^-8; uv is in sigmas.
 o.position=vec4f(c.xy+k*8.0*u.screen.z/u.screen.xy*c.w,0.0,c.w);o.uv=k*4.0;
 // Flux over the Gaussian exp(-r^2 / (2 sigma^2)), whose integral is 2 pi sigma^2, so the size keeps the energy.
 o.color=stars[3u*i+1u].rgb*pow(10.0,-0.4*m)*u.screen.w*u.params.x/(6.2831853*u.screen.z*u.screen.z);
 return o;
}
@fragment fn fragment(i:O)->@location(0) vec4f {
 let value=i.color*exp(-0.5*dot(i.uv,i.uv));let m=max(value.r,max(value.g,value.b));
 if(m<1e-6){discard;}
 // Straight alpha gives value + sky * (1 - a): the star's light, less the sky times a. On a float target a is the
 // brightest channel over 64 (value / a stays within 64), so the sky lost is 1/64 of a's share; an 8-bit target clamps
 // the colour to 1, so there a is the brightest channel itself (blend.x 1).
 let a=min(1.0,m*u.blend.x);
 return vec4f(value/a,a);
}
`;

/**
 * A sky with the real sun, moon, planets and stars for a date, time and place. Each frame it moves its clock on by
 * `timeScale`, sets the driven `sky`'s sun and moon, and draws the catalogue's stars and the planets as points on the
 * sky (where nothing else was drawn), refracted, dimmed by the air and faded in with the sky's night. WebGPU only.
 * @throws TypeError or RangeError for invalid options (on attach and each frame); MargoError `'unsupported'` on a
 * WebGL engine, `'disposed'` after `dispose()`.
 * @example
 * const astro = AstroSky.attach(engine, { latitude: degrees(51.48), longitude: degrees(0), sky });
 */
export class AstroSky implements EnginePlugin {
  readonly name = 'sky:astro';
  private readonly overlay = new ParticleOverlay();
  private readonly values = new Float32Array(44);
  private uniform?: GPUBuffer;
  private stars?: GPUBuffer;
  private starData?: Float32Array;
  private uploaded?: StarCatalog | null;
  private entries?: GPUBindGroupEntry[];
  private engine?: Engine;
  private disposed = false;
  private clock: number;
  private night = 0;
  /** The sun, moon and planets of the current moment, updated each frame. */
  sun: CelestialPosition;
  moon: MoonPosition;
  planets: PlanetPosition[];

  constructor(readonly options: AstroSkyOptions) {
    validate(options);
    this.clock = (options.date ?? new Date()).getTime();
    this.sun = sunPosition(this.date, options, options);
    this.moon = moonPosition(this.date, options, options);
    this.planets = planetPositions(this.date, options, options);
  }

  static attach(engine: EngineKernel, options: AstroSkyOptions): AstroSky {
    const astro = new AstroSky(options);
    engineRuntime(engine).use(astro);
    return astro;
  }

  /** The moment shown, advanced by `timeScale` each frame. Assign `options.date` to jump. */
  get date(): Date {
    return new Date(this.clock);
  }

  onPreUpdate(delta: number): void {
    const o = this.options;
    validate(o);
    if (!Number.isFinite(delta) || delta < 0) throw new RangeError('Invalid AstroSky delta; pass seconds, 0 or more.');
    if (o.date !== undefined) {
      this.clock = o.date.getTime();
      o.date = undefined;
    }
    this.clock += delta * (o.timeScale ?? 1) * 1000;
    const date = this.date;
    this.sun = sunPosition(date, o, o);
    this.moon = moonPosition(date, o, o);
    this.planets = planetPositions(date, o, o);
    const sky = o.sky;
    if (sky) {
      sky.options.sunDirection = [...this.sun.direction];
      const night = sky.options.night;
      if (night) {
        night.moonDirection = [...this.moon.direction];
        // The night shader's phase is the cosine of the phase angle: -1 new, 0 half, 1 full.
        night.moonPhase = 2 * this.moon.illumination - 1;
        night.moonSize = this.moon.angularRadius.radians;
        night.moonLitBySun = true;
        if (o.catalog) night.starIntensity = 0;
      }
    }
    // Without a sky's own blend, stars fade in as the sun sinks from the horizon to 12 degrees below (nautical twilight).
    const s = Math.max(0, Math.min(1, -this.sun.elevation.degrees / 12));
    this.night = s * s * (3 - 2 * s);
  }

  setup(engine: Engine): void {
    if (this.disposed || !engine.gpu)
      throw new MargoError(
        this.disposed ? 'disposed' : 'unsupported',
        'AstroSky requires WebGPU; attach a new AstroSky to a WebGPU engine',
      );
    this.engine = engine;
    this.uniform = engine.gpu.createBuffer({
      size: this.values.byteLength,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
  }

  registerPasses(graph: FrameGraph): void {
    graph.add({
      name: 'sky:astro',
      // After the sky (2), before fog (5) and weather (6).
      order: 2.5,
      execute: (c) => {
        if (c.backend === 'webgpu') this.draw(c);
      },
    });
  }

  private draw(c: Context): void {
    const o = this.options,
      catalog = o.catalog,
      stars = catalog?.count ?? 0,
      count = stars + (o.planets === false ? 0 : 7);
    // The sky works out its night in its own pass (order 2), before this one: read it now, not a frame late.
    const sky = o.sky,
      night = typeof sky?.nightFactor === 'number' ? sky.nightFactor : this.night;
    if (count === 0 || night <= 0) return;
    if (this.uploaded !== (catalog ?? null)) {
      // Three vec4s a point (see the shader); the planets take the last seven, written each frame.
      const data = new Float32Array((stars + 7) * 12);
      for (let i = 0; i < stars; i++) {
        data.set(catalog!.positions.subarray(i * 3, i * 3 + 3), i * 12);
        data[i * 12 + 3] = catalog!.magnitudes[i];
        data.set(starColor(catalog!.colors[i]), i * 12 + 4);
        data.set(catalog!.motions.subarray(i * 3, i * 3 + 3), i * 12 + 8);
      }
      for (let p = 0; p < 7; p++) data.set(starColor(planetTints[p]), (stars + p) * 12 + 4);
      this.stars?.destroy();
      this.stars = c.device.createBuffer({
        size: data.byteLength,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
      });
      this.starData = data;
      this.uploaded = catalog ?? null;
      this.entries = [{ binding: 1, resource: { buffer: this.stars } }];
      c.device.queue.writeBuffer(this.stars, 0, data as Float32Array<ArrayBuffer>);
    }
    if (o.planets !== false) {
      const data = this.starData!;
      this.planets.forEach((p, i) => {
        data.set(p.j2000, (stars + i) * 12);
        data[(stars + i) * 12 + 3] = p.magnitude;
      });
      c.device.queue.writeBuffer(this.stars!, stars * 48, data as Float32Array<ArrayBuffer>, stars * 12, 7 * 12);
    }
    const v = this.values,
      date = this.date,
      m = skyMatrix(date, o, o),
      [width, tall] = viewSize(c) as [number, number];
    v.set(c.camera.matrix, 0);
    for (let r = 0; r < 3; r++) for (let k = 0; k < 3; k++) v[16 + r * 4 + k] = m[r * 3 + k];
    v.set(c.camera.position, 28);
    // Julian years since 2000.0, for the proper motion.
    v[31] = (julianDay(date) - 2451545) / 365.25;
    v[32] = width;
    v[33] = tall;
    v[34] = o.pointSize ?? 1;
    v[35] = o.brightness ?? 4;
    v[36] = night;
    v[37] = o.extinction ?? 0.2;
    v[38] = o.refraction === false ? 0 : 1;
    v[39] = o.limitingMagnitude ?? 6.5;
    v[40] = c.format.includes('float') ? 1 / 64 : 1;
    this.overlay.draw(c, shader, this.uniform!, v as Float32Array<ArrayBuffer>, count, this.entries);
  }

  private release(): void {
    this.uniform?.destroy();
    this.stars?.destroy();
    this.uniform = this.stars = this.starData = this.entries = undefined;
    this.uploaded = undefined;
    this.overlay.release();
  }

  onDeviceRestored(engine: Engine): void {
    this.release();
    this.setup(engine);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.engine?.removePlugin(this.name);
    this.release();
    this.engine = undefined;
  }

  declare [Symbol.dispose]: () => void;
  [(Symbol.dispose ?? Symbol()) as symbol](): void {
    this.dispose();
  }
}
