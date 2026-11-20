// Every dimension of the orrery in one place, in metres, Blender's axes (z up, x toward the J2000 equinox, y toward
// ecliptic longitude 90 degrees). glTF export turns that into the engine's y up: engine (x, y, z) = Blender (x, z, -y).
// `node examples/orrery/blender/write-layout.mjs` writes this to blender/layout.json for the Blender build;
// tests/orrery-gears.test.js checks the file is current.
import {
  HELIOCENTRIC_PLANETS as PLANETS,
  yearCalendar,
  type HeliocentricPlanet as PlanetName,
} from '@margoengine/sky/ephemeris';
import { ARBOR, FRAME, L1, L2, designTrains, modules, radii, type Train } from './gears.ts';

export type Moon = {
  name: string;
  /** Arm length from the planet's post (m), the moon ball's radius (m). */
  arm: number;
  radius: number;
  /** Sidereal period in days; negative turns clockwise (Triton). */
  period: number;
};
export type PlanetLayout = {
  name: PlanetName;
  /** Orbit radius on the model (not to scale), ball radius, height of its arm, radius of its tube. */
  orbit: number;
  radius: number;
  armZ: number;
  tube: number;
  /** Axis tilt from the ecliptic pole (degrees) and the ecliptic longitude it leans toward; fixed in space. */
  tilt: number;
  tiltToward: number;
  ring: null | { inner: number; outer: number };
  moons: Moon[];
  /** Heights of the wheel levels: A holds a (drive arbor) and b (stud arbor); B holds c (stud) and d (tube). */
  levelA: number;
  levelB: number;
  train: Train;
  module: { A: number; B: number };
};

export const PLINTH = { radius: 0.66, height: 0.075 };
/** Brass calendar ring inlaid in the plinth top: degrees outside, Earth's dates inside. */
export const CALENDAR = { inner: 0.5, split: 0.555, outer: 0.605 };
export const DOME = { radius: 0.622, wall: 0.3, cap: 0.22, thickness: 0.003 };
export const PLATES = { bottom: 0.095, top: 0.2, thickness: 0.005, radius: 0.178 };
export const WHEEL_THICKNESS = 0.0032;
export const PLANET_Z = 0.33;
export const SUN = { radius: 0.03, z: PLANET_Z };
const LEVELS = { first: 0.1075, step: 0.0057 };
const ARMS = { lowest: 0.216, step: 0.0088 };

const shape: Record<
  PlanetName,
  { orbit: number; radius: number; tilt: number; tiltToward: number; ring: PlanetLayout['ring']; moons: Moon[] }
> = {
  mercury: { orbit: 0.064, radius: 0.0075, tilt: 0, tiltToward: 0, ring: null, moons: [] },
  venus: { orbit: 0.096, radius: 0.0115, tilt: 0, tiltToward: 0, ring: null, moons: [] },
  earth: {
    orbit: 0.14,
    radius: 0.0125,
    tilt: 23.44,
    tiltToward: 90,
    ring: null,
    moons: [{ name: 'moon', arm: 0.025, radius: 0.0042, period: 27.321661 }],
  },
  mars: {
    orbit: 0.197,
    radius: 0.0095,
    tilt: 25.19,
    tiltToward: 352.9,
    ring: null,
    moons: [
      { name: 'phobos', arm: 0.0145, radius: 0.0018, period: 0.31891 },
      { name: 'deimos', arm: 0.0195, radius: 0.0016, period: 1.26244 },
    ],
  },
  jupiter: {
    orbit: 0.282,
    radius: 0.027,
    tilt: 3.13,
    tiltToward: 248,
    ring: null,
    moons: [
      { name: 'io', arm: 0.034, radius: 0.0028, period: 1.769138 },
      { name: 'europa', arm: 0.0395, radius: 0.0025, period: 3.551181 },
      { name: 'ganymede', arm: 0.0455, radius: 0.0036, period: 7.154553 },
      { name: 'callisto', arm: 0.0525, radius: 0.0033, period: 16.689017 },
    ],
  },
  saturn: {
    orbit: 0.396,
    radius: 0.0215,
    tilt: 28.05,
    tiltToward: 79.5,
    ring: { inner: 0.028, outer: 0.043 },
    moons: [{ name: 'titan', arm: 0.051, radius: 0.0033, period: 15.945421 }],
  },
  uranus: {
    orbit: 0.49,
    radius: 0.0165,
    tilt: 97.77,
    tiltToward: 257.3,
    ring: null,
    moons: [
      { name: 'titania', arm: 0.026, radius: 0.0022, period: 8.705872 },
      { name: 'oberon', arm: 0.0315, radius: 0.0022, period: 13.463239 },
    ],
  },
  neptune: {
    orbit: 0.56,
    radius: 0.0165,
    tilt: 28.32,
    tiltToward: 293,
    ring: null,
    moons: [{ name: 'triton', arm: 0.0265, radius: 0.0028, period: -5.876854 }],
  },
};

/** The radial reach of a planet and its moons around its orbit radius. */
export const reach = (p: { radius: number; ring: PlanetLayout['ring']; moons: Moon[] }) =>
  Math.max(p.radius, p.ring?.outer ?? 0, ...p.moons.map((m) => m.arm + m.radius));

export function planetLayouts(trains = designTrains()): PlanetLayout[] {
  return PLANETS.map((name, i) => ({
    name,
    ...shape[name],
    // The fastest planet's wheel is lowest, so its tube is innermost and its arm highest.
    levelA: LEVELS.first + 2 * i * LEVELS.step,
    levelB: LEVELS.first + (2 * i + 1) * LEVELS.step,
    armZ: ARMS.lowest + (PLANETS.length - 1 - i) * ARMS.step,
    tube: 0.0045 + i * 0.0015,
    train: trains[name],
    module: modules(trains[name]),
  }));
}

/** Calendar ring ticks: Earth's heliocentric longitude at 0h UTC on every day of `year` (@margoengine/sky/ephemeris). */
export const calendar = (year = 2026) => yearCalendar(year);

export const MONTHS = [
  'JANUARY',
  'FEBRUARY',
  'MARCH',
  'APRIL',
  'MAY',
  'JUNE',
  'JULY',
  'AUGUST',
  'SEPTEMBER',
  'OCTOBER',
  'NOVEMBER',
  'DECEMBER',
];

/** Everything the Blender build reads. */
export function orreryLayout() {
  const planets = planetLayouts();
  return {
    units: 'metres, Blender axes (z up)',
    plinth: PLINTH,
    calendar: { ...CALENDAR, ...calendar(), months: MONTHS },
    dome: DOME,
    plates: PLATES,
    wheelThickness: WHEEL_THICKNESS,
    planetZ: PLANET_Z,
    sun: SUN,
    arbor: ARBOR,
    centres: { C: [0, 0], L1, L2, D2: FRAME.D2, D12: FRAME.D12 },
    planets: planets.map((p) => ({
      ...p,
      wheels: {
        a: { teeth: p.train.a, module: p.module.A, centre: L1, z: p.levelA, ...radii(p.train.a, p.module.A) },
        b: { teeth: p.train.b, module: p.module.A, centre: L2, z: p.levelA, ...radii(p.train.b, p.module.A) },
        c: { teeth: p.train.c, module: p.module.B, centre: L2, z: p.levelB, ...radii(p.train.c, p.module.B) },
        d: { teeth: p.train.d, module: p.module.B, centre: [0, 0], z: p.levelB, ...radii(p.train.d, p.module.B) },
      },
    })),
  };
}
