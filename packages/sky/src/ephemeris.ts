// Where the planets are on a date, without a sky: heliocentric ecliptic positions from published mean orbital elements,
// solved with Kepler's equation, the Moon's geocentric ecliptic longitude, mean motions and Julian Day helpers. Pure
// maths with no GPU code, for orreries, planet tours, clocks and tools in Node or a browser.
//
// Source of the elements: E. M. Standish, "Keplerian Elements for Approximate Positions of the Major Planets",
// JPL Solar System Dynamics, Table 1 (fitted to the DE405 ephemeris over 1800 AD to 2050 AD), mean ecliptic and
// equinox of J2000. https://ssd.jpl.nasa.gov/planets/approx_pos.html
// The Moon uses the low-precision lunar longitude of the Astronomical Almanac (section D, about 0.3 degrees), moved to
// the J2000 equinox by the IAU 2006 general precession in longitude (Capitaine, Wallace and Chapront, A&A 412, 2003).

/** Days of the Julian Day number at 1970-01-01T00:00Z. */
const UNIX_EPOCH_JD = 2440587.5;
/** J2000.0 (2000-01-01T12:00 TT), the epoch of the elements, as a Julian Day. */
export const J2000 = 2451545.0;
const RAD = Math.PI / 180;

/** The eight major planets, Mercury outward. `earth` is the Earth-Moon barycentre, as in Standish's table. */
export type HeliocentricPlanet = 'mercury' | 'venus' | 'earth' | 'mars' | 'jupiter' | 'saturn' | 'uranus' | 'neptune';
/** {@link HeliocentricPlanet} names in order from the Sun. */
export const HELIOCENTRIC_PLANETS: readonly HeliocentricPlanet[] = Object.freeze([
  'mercury',
  'venus',
  'earth',
  'mars',
  'jupiter',
  'saturn',
  'uranus',
  'neptune',
]);

/**
 * One row of Standish's Table 1: semi-major axis a (au), eccentricity e, inclination I, mean longitude L, longitude of
 * perihelion (varpi) and longitude of the ascending node (degrees), each at J2000 (`at`) and its rate per Julian
 * century (`rate`).
 */
export interface OrbitalElements {
  readonly at: readonly number[];
  readonly rate: readonly number[];
}
const row = (at: number[], rate: number[]): OrbitalElements =>
  Object.freeze({ at: Object.freeze(at), rate: Object.freeze(rate) });
//                       a            e            I             L               varpi          Omega
/** Standish's Table 1, valid 1800 to 2050 ({@link FITTED_SPAN}). */
export const STANDISH_ELEMENTS: Readonly<Record<HeliocentricPlanet, OrbitalElements>> = Object.freeze({
  mercury: row(
    [0.38709927, 0.20563593, 7.00497902, 252.2503235, 77.45779628, 48.33076593],
    [0.00000037, 0.00001906, -0.00594749, 149472.67411175, 0.16047689, -0.12534081],
  ),
  venus: row(
    [0.72333566, 0.00677672, 3.39467605, 181.9790995, 131.60246718, 76.67984255],
    [0.0000039, -0.00004107, -0.0007889, 58517.81538729, 0.00268329, -0.27769418],
  ),
  earth: row(
    [1.00000261, 0.01671123, -0.00001531, 100.46457166, 102.93768193, 0.0],
    [0.00000562, -0.00004392, -0.01294668, 35999.37244981, 0.32327364, 0.0],
  ),
  mars: row(
    [1.52371034, 0.0933941, 1.84969142, -4.55343205, -23.94362959, 49.55953891],
    [0.00001847, 0.00007882, -0.00813131, 19140.30268499, 0.44441088, -0.29257343],
  ),
  jupiter: row(
    [5.202887, 0.04838624, 1.30439695, 34.39644051, 14.72847983, 100.47390909],
    [-0.00011607, -0.00013253, -0.00183714, 3034.74612775, 0.21252668, 0.20469106],
  ),
  saturn: row(
    [9.53667594, 0.05386179, 2.48599187, 49.95424423, 92.59887831, 113.66242448],
    [-0.0012506, -0.00050991, 0.00193609, 1222.49362201, -0.41897216, -0.28867794],
  ),
  uranus: row(
    [19.18916464, 0.04725744, 0.77263783, 313.23810451, 170.9542763, 74.01692503],
    [-0.00196176, -0.00004397, -0.00242939, 428.48202785, 0.40805281, 0.04240589],
  ),
  neptune: row(
    [30.06992276, 0.00859048, 1.77004347, -55.12002969, 44.96476227, 131.78422574],
    [0.00026291, 0.00005105, 0.00035372, 218.45945325, -0.32241464, -0.00508664],
  ),
});

/** The span Table 1 was fitted over, as Julian Days (1800-01-01 to 2050-01-01). */
export const FITTED_SPAN: readonly [number, number] = Object.freeze([2378496.5, 2469807.5]) as readonly [
  number,
  number,
];

/** The Julian Day of a `Date` or a time in milliseconds since 1970 (UTC). */
export const julianDay = (date: Date | number): number => +date / 86400000 + UNIX_EPOCH_JD;
/** The `Date` of a Julian Day. */
export const dateOfJulianDay = (jd: number): Date => new Date((jd - UNIX_EPOCH_JD) * 86400000);
/** Julian centuries from J2000. */
export const centuries = (jd: number): number => (jd - J2000) / 36525;

/** Wraps an angle in degrees to [0, 360). */
export const wrap360 = (deg: number): number => ((deg % 360) + 360) % 360;
/** Wraps an angle in degrees to [-180, 180). */
export const wrap180 = (deg: number): number => wrap360(deg + 180) - 180;

/**
 * Solves Kepler's equation E - e sin E = M (radians) by Newton's method, to 1e-12 rad, for any eccentricity below 1.
 * Starts from M for e below 0.8 and from pi (signed like M) above, so it converges for every M.
 * @throws RangeError when `e` is not in [0, 1) or `M` is not finite.
 * @example const E = eccentricAnomaly(1.2, 0.0167);
 */
export function eccentricAnomaly(M: number, e: number): number {
  if (!(e >= 0 && e < 1)) throw new RangeError(`eccentricAnomaly: eccentricity ${e} is not in [0, 1); pass an ellipse`);
  if (!Number.isFinite(M)) throw new RangeError(`eccentricAnomaly: mean anomaly ${M} is not finite; pass radians`);
  const m = Math.atan2(Math.sin(M), Math.cos(M));
  let E = e < 0.8 ? m : Math.PI * Math.sign(m || 1);
  for (let i = 0; i < 30; i++) {
    const step = (E - e * Math.sin(E) - m) / (1 - e * Math.cos(E));
    E -= step;
    if (Math.abs(step) < 1e-12) break;
  }
  return E;
}

/** A planet's place round the Sun. */
export interface HeliocentricPosition {
  /** Heliocentric ecliptic coordinates (au), mean ecliptic and equinox of J2000: x toward the equinox, z to the pole. */
  x: number;
  y: number;
  z: number;
  /** Heliocentric ecliptic longitude, degrees in [0, 360). */
  longitude: number;
  /** Mean longitude L, degrees in [0, 360): where a uniformly turning wheel (an orrery's) shows the planet. */
  meanLongitude: number;
  /** Distance from the Sun (au). */
  radius: number;
}

const known = (name: string): name is HeliocentricPlanet => Object.hasOwn(STANDISH_ELEMENTS, name);
const check = (name: string, where: string): OrbitalElements => {
  if (!known(name))
    throw new RangeError(`${where}: "${name}" is not a planet; pass one of ${HELIOCENTRIC_PLANETS.join(', ')}`);
  return STANDISH_ELEMENTS[name];
};

/**
 * A planet's heliocentric position on a Julian Day (TDB; UTC differs by about a minute, far below this accuracy).
 * Accuracy against JPL Horizons (DE441) over 1800 to 2050, measured: under 1.2 arcminutes in longitude for the inner
 * planets, Uranus and Neptune, 7.6 for Jupiter and 11.9 for Saturn; distance within 0.19 percent.
 * @throws RangeError for an unknown planet name.
 * @example const mars = planetPosition('mars', julianDay(new Date('2026-11-14')));
 */
export function planetPosition(name: HeliocentricPlanet, jd: number): HeliocentricPosition {
  const { at, rate } = check(name, 'planetPosition');
  const T = centuries(jd);
  const [a, e, I, L, w, O] = at.map((value, i) => value + rate[i] * T);
  const omega = (w - O) * RAD,
    node = O * RAD,
    inc = I * RAD;
  const E = eccentricAnomaly((L - w) * RAD, e);
  const xp = a * (Math.cos(E) - e),
    yp = a * Math.sqrt(1 - e * e) * Math.sin(E);
  const co = Math.cos(omega),
    so = Math.sin(omega),
    cO = Math.cos(node),
    sO = Math.sin(node),
    cI = Math.cos(inc),
    sI = Math.sin(inc);
  const x = (co * cO - so * sO * cI) * xp + (-so * cO - co * sO * cI) * yp;
  const y = (co * sO + so * cO * cI) * xp + (-so * sO + co * cO * cI) * yp;
  const z = so * sI * xp + co * sI * yp;
  return {
    x,
    y,
    z,
    longitude: wrap360(Math.atan2(y, x) / RAD),
    meanLongitude: wrap360(L),
    radius: Math.hypot(x, y, z),
  };
}

/** Mean motion in degrees per day, from the table's rate of mean longitude. @throws RangeError for an unknown name. */
export const meanMotion = (name: HeliocentricPlanet): number => check(name, 'meanMotion').rate[3] / 36525;

/** General precession in longitude, degrees per Julian century (IAU 2006: 5028.796195 arcseconds). */
const PRECESSION = 5028.796195 / 3600;

/**
 * The Moon's geocentric ecliptic longitude in degrees [0, 360), referred to the J2000 equinox like the planets. The
 * Astronomical Almanac's low-precision series (six periodic terms) gives it for the equinox of date; general
 * precession moves it to J2000. Measured against Horizons over 1800 to 2050: within 17 arcminutes.
 * @example const moon = moonLongitude(julianDay(Date.now()));
 */
export function moonLongitude(jd: number): number {
  const T = centuries(jd);
  const s = (a: number, b: number) => Math.sin((a + b * T) * RAD);
  const ofDate =
    218.32 +
    481267.881 * T +
    6.29 * s(135.0, 477198.87) -
    1.27 * s(259.3, -413335.36) +
    0.66 * s(235.7, 890534.22) +
    0.21 * s(269.9, 954397.74) -
    0.19 * s(357.5, 35999.05) -
    0.11 * s(186.5, 966404.03);
  return wrap360(ofDate - PRECESSION * T);
}

/** Every planet's heliocentric position on a Julian Day. */
export function solarSystem(jd: number): Record<HeliocentricPlanet, HeliocentricPosition> {
  return Object.fromEntries(HELIOCENTRIC_PLANETS.map((name) => [name, planetPosition(name, jd)])) as Record<
    HeliocentricPlanet,
    HeliocentricPosition
  >;
}

/** One day of {@link yearCalendar}. */
export interface CalendarDay {
  /** Earth's heliocentric ecliptic longitude at 0h UTC, degrees in [0, 360). */
  longitude: number;
  /** Day of the month, 1 to 31. */
  day: number;
  /** Month, 0 (January) to 11. */
  month: number;
}

/**
 * The Earth's heliocentric longitude at 0h UTC on every day of a year: the date ticks of an orrery's or a sundial's
 * calendar ring (a day's tick sits at its longitude; a month starts where `day` is 1).
 * @throws RangeError when `year` is not an integer.
 * @example const { days } = yearCalendar(2026); // 365 ticks
 */
export function yearCalendar(year: number): { year: number; days: CalendarDay[] } {
  if (!Number.isInteger(year))
    throw new RangeError(`yearCalendar: year ${year} is not an integer; pass a year like 2026`);
  const start = julianDay(Date.UTC(year, 0, 1)),
    end = julianDay(Date.UTC(year + 1, 0, 1));
  const days: CalendarDay[] = [];
  for (let jd = start; jd < end; jd++) {
    const date = dateOfJulianDay(jd);
    days.push({ longitude: planetPosition('earth', jd).longitude, day: date.getUTCDate(), month: date.getUTCMonth() });
  }
  return { year, days };
}
