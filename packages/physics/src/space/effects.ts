import { cos, sin } from '@margoengine/math/pinned';
import type { Vec3 } from '@margoengine/core';
import { add, dot, scale, sub } from '@margoengine/math/vec3';
import { celestialError } from './errors.js';

import { angularRadius, atan2, magnitude, separation } from './angles.js';

/** Metres in one astronomical unit, IAU 2012 Resolution B2. */
export const ASTRONOMICAL_UNIT = 149597870700;
const SOLAR_IRRADIANCE = 1361; // IAU nominal W/m² at 1 au.
const SUN_RADIUS = 695700000;
const MOON_RADIUS = 1737400;
const EARTH_EQUATOR = 6378137;
const FLATTENING = 1 / 298.257223563;
const ELLIPSOID_ECCENTRICITY_SQUARED = FLATTENING * (2 - FLATTENING);
const SUN_GM = 1.3271244e20;
const MOON_GM = 4.902800118e12;

/** WGS 84 geodetic site. Angles are radians and height is metres above the reference ellipsoid. */
export interface GeodeticSite {
  readonly latitude: number;
  /** Longitude east of Greenwich. */
  readonly longitude: number;
  /** Defaults to the reference ellipsoid. */
  readonly height?: number;
}

/** Earth-centred, Earth-fixed site and its local east, north and up basis. */
export interface LocalHorizon {
  readonly position: Vec3;
  readonly east: Vec3;
  readonly north: Vec3;
  readonly up: Vec3;
}

/** Form a WGS 84 Earth-fixed point and its geodetic local frame. */
export function localHorizon(site: GeodeticSite): LocalHorizon {
  const { latitude, longitude } = site;
  const height = site.height ?? 0;
  if (
    !Number.isFinite(latitude) ||
    Math.abs(latitude) > Math.PI / 2 ||
    !Number.isFinite(longitude) ||
    !Number.isFinite(height) ||
    height <= -EARTH_EQUATOR * (1 - FLATTENING)
  )
    throw celestialError(
      'Pass finite WGS 84 coordinates with latitude in [-π/2, π/2] and a site above the Earth center.',
    );

  const p = latitude;
  const l = longitude % (2 * Math.PI);
  const sp = sin(p);
  const cp = cos(p);
  const sl = sin(l);
  const cl = cos(l);
  const curvature = EARTH_EQUATOR / Math.sqrt(1 - ELLIPSOID_ECCENTRICITY_SQUARED * sp * sp);
  const up: Vec3 = [cp * cl, cp * sl, sp];
  return {
    position: [
      (curvature + height) * up[0],
      (curvature + height) * up[1],
      (curvature * (1 - ELLIPSOID_ECCENTRICITY_SQUARED) + height) * sp,
    ],
    east: [-sl, cl, 0],
    north: [-sp * cl, -sp * sl, cp],
    up,
  };
}

/** The fraction of a uniformly bright circular disc covered by an overlapping circular disc. */
function covered(source: number, blocker: number, distance: number): number {
  if (distance >= source + blocker) return 0;
  if (distance <= Math.abs(source - blocker)) {
    const ratio = Math.min(1, blocker / source);
    return ratio * ratio;
  }
  // Normalize to the source radius so the two circular segments can be summed without large/small area units.
  const d = distance / source;
  const b = blocker / source;
  const bSquared = b * b;
  const dSquared = d * d;
  const chord = Math.sqrt(Math.max(0, (1 + b - d) * (d + 1 - b) * (d + b - 1) * (d + 1 + b)));
  const sourceAngle = atan2(chord, dSquared + 1 - bSquared);
  const blockerAngle = atan2(chord, dSquared + bSquared - 1);
  return Math.max(0, Math.min(1, (sourceAngle + bSquared * blockerAngle - chord / 2) / Math.PI));
}

/** Geometric solar eclipse as seen from a site. */
export type SolarEclipseKind = 'none' | 'partial' | 'annular' | 'total';

/** Direct top-of-atmosphere sunlight at a WGS 84 site. */
export interface Insolation {
  /** Unit direction toward the Sun, in east, north and up axes. */
  readonly direction: Vec3;
  /** Solar elevation above the geometric horizon, in radians. */
  readonly elevation: number;
  /** Azimuth clockwise from north in [0, 2π), in radians. */
  readonly azimuth: number;
  /** Fraction of the geometrical solar disc obscured by the Moon. */
  readonly obscuration: number;
  /** Geometric solar eclipse class, independently of horizon visibility. */
  readonly eclipse: SolarEclipseKind;
  /** Direct-normal irradiance above the geometric horizon, W/m², after eclipse obscuration. */
  readonly directNormal: number;
  /** Direct irradiance on the local horizontal, W/m². */
  readonly horizontal: number;
}

/**
 * Solar direction, solar eclipse and unattenuated irradiance. Sun and Moon vectors are Earth-fixed positions
 * in metres using the celestial directions appropriate for the observation epoch.
 */
export function sampleInsolation(sun: Vec3, moon: Vec3, site: GeodeticSite): Insolation {
  const frame = localHorizon(site);
  const toSun = sub(sun, frame.position);
  const toMoon = sub(moon, frame.position);
  const sunRange = magnitude(toSun);
  const moonRange = magnitude(toMoon);
  if (
    !(sunRange > SUN_RADIUS) ||
    !(moonRange > MOON_RADIUS) ||
    !Number.isFinite(sunRange) ||
    !Number.isFinite(moonRange)
  )
    throw celestialError('Pass finite Earth-fixed Sun and Moon positions outside the observer and both bodies.');

  const ray: Vec3 = [toSun[0] / sunRange, toSun[1] / sunRange, toSun[2] / sunRange];
  const direction: Vec3 = [dot(ray, frame.east), dot(ray, frame.north), dot(ray, frame.up)];
  const [east, north, up] = direction;
  const angle = atan2(east, north);
  const azimuth = angle < 0 ? angle + 2 * Math.PI : angle;
  const elevation = atan2(up, Math.sqrt(east * east + north * north));

  const a = angularRadius(SUN_RADIUS, sunRange);
  const b = angularRadius(MOON_RADIUS, moonRange);
  const d = separation(toSun, toMoon);
  const obscuration = moonRange < sunRange ? covered(a, b, d) : 0;
  let eclipse: SolarEclipseKind = 'none';
  if (obscuration > 0) {
    eclipse = 'partial';
    if (d <= Math.abs(a - b)) eclipse = b >= a ? 'total' : 'annular';
  }

  const parallax = ASTRONOMICAL_UNIT / sunRange;
  const directNormal = up > 0 ? SOLAR_IRRADIANCE * parallax * parallax * (1 - obscuration) : 0;
  return {
    direction,
    azimuth,
    elevation,
    obscuration,
    eclipse,
    directNormal,
    horizontal: directNormal * Math.max(0, up),
  };
}

/** Fraction of the Moon in the core or outer part of the Earth's shadow. */
export interface LunarEclipse {
  readonly umbralFraction: number;
  /** Fraction inside the outer penumbra, including the portion in the umbra. */
  readonly penumbralFraction: number;
  readonly type: 'none' | 'penumbral' | 'partial' | 'total';
}

/** Compute the geometrical lunar eclipse from simultaneous geocentric Sun and Moon vectors in metres. */
export function lunarEclipse(sun: Vec3, moon: Vec3): LunarEclipse {
  const sunRange = magnitude(sun);
  const moonRange = magnitude(moon);
  if (
    !(sunRange > SUN_RADIUS) ||
    !(moonRange > EARTH_EQUATOR + MOON_RADIUS) ||
    !Number.isFinite(sunRange) ||
    !Number.isFinite(moonRange)
  )
    throw celestialError('Pass finite geocentric Sun and Moon vectors outside the corresponding physical radii.');
  // Espenak and Meeus (2009), Danjon shadow enlargement, equations 1-5 and 1-6.
  const earthRadius = EARTH_EQUATOR * (1 - FLATTENING / 2);
  const parallax = 1.01 * angularRadius(earthRadius, moonRange) + angularRadius(earthRadius, sunRange);
  const sunRadius = angularRadius(SUN_RADIUS, sunRange);
  const moonRadius = angularRadius(MOON_RADIUS, moonRange);
  const offset = separation(scale(sun, -1), moon);
  const umbralFraction = covered(moonRadius, Math.max(0, parallax - sunRadius), offset);
  const penumbralFraction = covered(moonRadius, parallax + sunRadius, offset);
  const type =
    umbralFraction === 1 ? 'total' : umbralFraction > 0 ? 'partial' : penumbralFraction > 0 ? 'penumbral' : 'none';
  return { umbralFraction, penumbralFraction, type };
}

/** Lunar and solar tide generating potential and its gradient, in m²/s² and Earth-fixed m/s². */
export interface TidalDrive {
  readonly potential: number;
  readonly acceleration: Vec3;
}

function pointTide(body: Vec3, gm: number, position: Vec3): TidalDrive {
  const radius = magnitude(body);
  if (!(radius > 0) || !Number.isFinite(radius))
    throw celestialError('Pass a finite geocentric body position separated from the Earth center.');

  const n = scale(body, 1 / radius);
  const u = scale(position, 1 / radius);
  const projection = dot(n, u);
  const squared = dot(u, u);
  const delta = squared - 2 * projection;
  const separationRatio = magnitude(sub(n, u));
  if (!(separationRatio > 0) || !Number.isFinite(separationRatio))
    throw celestialError('Pass a finite Earth-fixed sampling point separated from the celestial body.');
  const k = separationRatio;
  // Rationalized Newton potential with its degree-zero and degree-one terms removed. The form below retains
  // the quadratic signal at small offsets and avoids subtracting almost equal absolute accelerations.
  const onePlus = 1 + k;
  const potential = ((gm / radius) * ((-projection * delta * (2 + k)) / onePlus - squared)) / (k * onePlus);
  const relative = sub(scale(n, (-delta * (1 + k + k * k)) / onePlus), u);
  const acceleration = scale(relative, gm / radius / radius / (k * k * k));
  return { potential, acceleration };
}

/** The direct solar and lunar tide at an Earth-fixed Cartesian point, with all positions specified in metres. */
export function tidalDrive(sun: Vec3, moon: Vec3, position: Vec3): TidalDrive {
  const solar = pointTide(sun, SUN_GM, position);
  const lunar = pointTide(moon, MOON_GM, position);
  const [x, y, z] = add(solar.acceleration, lunar.acceleration);
  // A zero offset defines an exact zero potential and gradient, independent of vector signs.
  return { potential: solar.potential + lunar.potential + 0, acceleration: [x + 0, y + 0, z + 0] };
}
