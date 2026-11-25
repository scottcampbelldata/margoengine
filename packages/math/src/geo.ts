// WGS84 geodesy: geodetic <-> ECEF, the local east-north-up frame, geodesics and orbit poses.
// Angles are RADIANS (longitude, latitude, bearing, heading, pitch); lengths are METRES; ECEF is the right-handed
// Earth-centred frame of EPSG:4978 (+Z north pole, +X through lon 0 / lat 0). Written from:
// - NIMA TR8350.2, "Department of Defense World Geodetic System 1984", 3rd ed. (2000): a, 1/f, the conversions.
// - B. R. Bowring, "Transformation from spatial to geographical coordinates", Survey Review 23 (181), 1976.
// - T. Vincenty, "Direct and inverse solutions of geodesics on the ellipsoid with application of nested equations",
//   Survey Review 23 (176), 1975, https://www.ngs.noaa.gov/PUBS_LIB/inverse.pdf
// - C. F. F. Karney, "Algorithms for geodesics", J. Geodesy 87, 2013, https://doi.org/10.1007/s00190-012-0578-z
//   (the reference the tests' accuracy claims are judged against; Vincenty is used because it is short and
//   sub-millimetre except near antipodal points, where Karney's method is the remedy: see {@link geodesicInverse}).

import { MargoError } from './errors.js';

/** WGS84 semi-major axis, metres. */
export const WGS84_A = 6378137;
/** WGS84 flattening. */
export const WGS84_F = 1 / 298.257223563;
/** WGS84 semi-minor axis, metres. */
export const WGS84_B = WGS84_A * (1 - WGS84_F);
const E2 = WGS84_F * (2 - WGS84_F),
  EP2 = (WGS84_A * WGS84_A - WGS84_B * WGS84_B) / (WGS84_B * WGS84_B);

/** Degrees to radians. */
export const degToRad = (degrees: number): number => (degrees * Math.PI) / 180;
/** Radians to degrees. */
export const radToDeg = (radians: number): number => (radians * 180) / Math.PI;

/** Geodetic coordinates: longitude and latitude in radians, height above the ellipsoid in metres. */
export interface Cartographic {
  longitude: number;
  latitude: number;
  height: number;
}

/** Geodetic (radians, metres) to ECEF metres. */
export function cartographicToEcef(longitude: number, latitude: number, height = 0): [number, number, number] {
  const sinLat = Math.sin(latitude),
    cosLat = Math.cos(latitude),
    n = WGS84_A / Math.sqrt(1 - E2 * sinLat * sinLat);
  return [
    (n + height) * cosLat * Math.cos(longitude),
    (n + height) * cosLat * Math.sin(longitude),
    (n * (1 - E2) + height) * sinLat,
  ];
}

/**
 * ECEF metres to geodetic. Bowring's closed form (1976) followed by two fixed-point refinements: sub-millimetre from
 * the centre of the earth to geostationary heights, and exact at the poles.
 */
export function ecefToCartographic(x: number, y: number, z: number): Cartographic {
  const p = Math.hypot(x, y),
    longitude = Math.atan2(y, x);
  if (p === 0 && z === 0) return { longitude: 0, latitude: 0, height: -WGS84_A };
  const theta = Math.atan2(z * WGS84_A, p * WGS84_B),
    st = Math.sin(theta),
    ct = Math.cos(theta);
  let latitude = Math.atan2(z + EP2 * WGS84_B * st * st * st, p - E2 * WGS84_A * ct * ct * ct);
  // Two fixed-point steps of tan(lat) = (z / p) / (1 - e2 N / (N + h)), in the stable p cos + z sin form for h.
  for (let i = 0; i < 2; i++) {
    const s = Math.sin(latitude),
      c = Math.cos(latitude),
      n = WGS84_A / Math.sqrt(1 - E2 * s * s),
      h = p * c + z * s - WGS84_A * Math.sqrt(1 - E2 * s * s);
    latitude = Math.atan2(z * (n + h), p * (n * (1 - E2) + h));
  }
  const s = Math.sin(latitude);
  return {
    longitude,
    latitude,
    height: p * Math.cos(latitude) + z * s - WGS84_A * Math.sqrt(1 - E2 * s * s),
  };
}

/** The ellipsoid's outward unit normal (geodetic up) at an ECEF point. */
export function geodeticNormal(x: number, y: number, z: number): [number, number, number] {
  const nx = x / (WGS84_A * WGS84_A),
    ny = y / (WGS84_A * WGS84_A),
    nz = z / (WGS84_B * WGS84_B),
    l = Math.hypot(nx, ny, nz) || 1;
  return [nx / l, ny / l, nz / l];
}

/** The unit east, north and up vectors of the local tangent frame at a geodetic position, as ECEF directions. */
export interface EnuBasis {
  east: [number, number, number];
  north: [number, number, number];
  up: [number, number, number];
}

/** The east-north-up basis (ECEF components) at longitude and latitude in radians. East at a pole is +Y. */
export function enuBasis(longitude: number, latitude: number): EnuBasis {
  const so = Math.sin(longitude),
    co = Math.cos(longitude),
    sa = Math.sin(latitude),
    ca = Math.cos(latitude);
  return { east: [-so, co, 0], north: [-sa * co, -sa * so, ca], up: [ca * co, ca * so, sa] };
}

/** A local east-north-up offset in metres (x east, y north, z up) to an ECEF position, about `origin`. */
export function enuToEcef(origin: Cartographic, east: number, north: number, up: number): [number, number, number] {
  const o = cartographicToEcef(origin.longitude, origin.latitude, origin.height),
    b = enuBasis(origin.longitude, origin.latitude);
  return [0, 1, 2].map((i) => o[i]! + b.east[i]! * east + b.north[i]! * north + b.up[i]! * up) as [number, number, number];
}

/** An ECEF position to its east-north-up offset in metres about `origin`. */
export function ecefToEnu(origin: Cartographic, x: number, y: number, z: number): [number, number, number] {
  const o = cartographicToEcef(origin.longitude, origin.latitude, origin.height),
    b = enuBasis(origin.longitude, origin.latitude),
    d = [x - o[0], y - o[1], z - o[2]];
  const dot = (v: number[]) => v[0]! * d[0]! + v[1]! * d[1]! + v[2]! * d[2]!;
  return [dot(b.east), dot(b.north), dot(b.up)];
}

const wrapPi = (a: number) => a - 2 * Math.PI * Math.round(a / (2 * Math.PI));
const finite = (what: string, ...v: number[]) => {
  if (!v.every(Number.isFinite)) throw new RangeError(`${what} needs finite numbers; pass longitude, latitude and angles in radians and distances in metres`);
};

/** The result of {@link geodesicInverse}. Bearings are radians clockwise from north in [0, 2 PI). */
export interface GeodesicInverse {
  /** Shortest-path length on the ellipsoid surface, metres. */
  distance: number;
  /** Bearing at the start point. */
  initialBearing: number;
  /** Bearing at the end point (the direction of travel there). */
  finalBearing: number;
}

const TAU = 2 * Math.PI;
const norm2pi = (a: number) => ((a % TAU) + TAU) % TAU;

/**
 * Shortest distance and bearings between two surface points (Vincenty 1975), millimetre accurate for any pair that
 * is not nearly antipodal. Latitudes and longitudes in radians. Heights are ignored (the path lies on the ellipsoid).
 * Throws a `MargoError` with code `failed` when the iteration does not converge, which happens only within about
 * half a degree of antipodal; Karney (2013) is the algorithm to use there.
 */
export function geodesicInverse(lon1: number, lat1: number, lon2: number, lat2: number): GeodesicInverse {
  finite('geodesicInverse', lon1, lat1, lon2, lat2);
  const f = WGS84_F,
    a = WGS84_A,
    b = WGS84_B;
  const L = wrapPi(lon2 - lon1),
    U1 = Math.atan((1 - f) * Math.tan(lat1)),
    U2 = Math.atan((1 - f) * Math.tan(lat2)),
    sU1 = Math.sin(U1),
    cU1 = Math.cos(U1),
    sU2 = Math.sin(U2),
    cU2 = Math.cos(U2);
  let lambda = L,
    sinSigma = 0,
    cosSigma = 1,
    sigma = 0,
    cosSqAlpha = 1,
    cos2SigmaM = 0,
    sinLambda = 0,
    cosLambda = 1,
    i = 0;
  for (; i < 200; i++) {
    sinLambda = Math.sin(lambda);
    cosLambda = Math.cos(lambda);
    sinSigma = Math.hypot(cU2 * sinLambda, cU1 * sU2 - sU1 * cU2 * cosLambda);
    if (sinSigma === 0) return { distance: 0, initialBearing: 0, finalBearing: 0 };
    cosSigma = sU1 * sU2 + cU1 * cU2 * cosLambda;
    sigma = Math.atan2(sinSigma, cosSigma);
    const sinAlpha = (cU1 * cU2 * sinLambda) / sinSigma;
    cosSqAlpha = 1 - sinAlpha * sinAlpha;
    cos2SigmaM = cosSqAlpha !== 0 ? cosSigma - (2 * sU1 * sU2) / cosSqAlpha : 0; // equatorial line: cos2SigmaM = 0
    const C = (f / 16) * cosSqAlpha * (4 + f * (4 - 3 * cosSqAlpha)),
      next =
        L +
        (1 - C) * f * sinAlpha * (sigma + C * sinSigma * (cos2SigmaM + C * cosSigma * (-1 + 2 * cos2SigmaM * cos2SigmaM)));
    const done = Math.abs(next - lambda) < 1e-13;
    lambda = next;
    if (done) break;
    if (Math.abs(lambda) > Math.PI)
      throw new MargoError('failed', 'The points are nearly antipodal and Vincenty does not converge; move one point by about half a degree');
  }
  if (i === 200) throw new MargoError('failed', 'The points are nearly antipodal and Vincenty does not converge; move one point by about half a degree');
  const uSq = (cosSqAlpha * (a * a - b * b)) / (b * b),
    A = 1 + (uSq / 16384) * (4096 + uSq * (-768 + uSq * (320 - 175 * uSq))),
    B = (uSq / 1024) * (256 + uSq * (-128 + uSq * (74 - 47 * uSq))),
    dSigma =
      B *
      sinSigma *
      (cos2SigmaM +
        (B / 4) *
          (cosSigma * (-1 + 2 * cos2SigmaM * cos2SigmaM) -
            (B / 6) * cos2SigmaM * (-3 + 4 * sinSigma * sinSigma) * (-3 + 4 * cos2SigmaM * cos2SigmaM)));
  sinLambda = Math.sin(lambda);
  cosLambda = Math.cos(lambda);
  return {
    distance: b * A * (sigma - dSigma),
    initialBearing: norm2pi(Math.atan2(cU2 * sinLambda, cU1 * sU2 - sU1 * cU2 * cosLambda)),
    finalBearing: norm2pi(Math.atan2(cU1 * sinLambda, -sU1 * cU2 + cU1 * sU2 * cosLambda)),
  };
}

/** The result of {@link geodesicDirect}: radians, longitude in (-PI, PI], bearing in [0, 2 PI). */
export interface GeodesicDirect {
  longitude: number;
  latitude: number;
  /** Bearing of travel at the end point. */
  finalBearing: number;
}

/** Follow a geodesic from a surface point for `distance` metres on `bearing` (clockwise from north), Vincenty 1975. */
export function geodesicDirect(lon1: number, lat1: number, bearing: number, distance: number): GeodesicDirect {
  finite('geodesicDirect', lon1, lat1, bearing, distance);
  const f = WGS84_F,
    a = WGS84_A,
    b = WGS84_B,
    s = distance,
    sinA1 = Math.sin(bearing),
    cosA1 = Math.cos(bearing),
    tanU1 = (1 - f) * Math.tan(lat1),
    cosU1 = 1 / Math.sqrt(1 + tanU1 * tanU1),
    sinU1 = tanU1 * cosU1,
    sigma1 = Math.atan2(tanU1, cosA1),
    sinAlpha = cosU1 * sinA1,
    cosSqAlpha = 1 - sinAlpha * sinAlpha,
    uSq = (cosSqAlpha * (a * a - b * b)) / (b * b),
    A = 1 + (uSq / 16384) * (4096 + uSq * (-768 + uSq * (320 - 175 * uSq))),
    B = (uSq / 1024) * (256 + uSq * (-128 + uSq * (74 - 47 * uSq)));
  let sigma = s / (b * A),
    cos2SigmaM = 0,
    sinSigma = 0,
    cosSigma = 1;
  for (let i = 0; i < 200; i++) {
    cos2SigmaM = Math.cos(2 * sigma1 + sigma);
    sinSigma = Math.sin(sigma);
    cosSigma = Math.cos(sigma);
    const dSigma =
      B *
      sinSigma *
      (cos2SigmaM +
        (B / 4) *
          (cosSigma * (-1 + 2 * cos2SigmaM * cos2SigmaM) -
            (B / 6) * cos2SigmaM * (-3 + 4 * sinSigma * sinSigma) * (-3 + 4 * cos2SigmaM * cos2SigmaM)));
    const next = s / (b * A) + dSigma;
    const done = Math.abs(next - sigma) < 1e-13;
    sigma = next;
    if (done) break;
  }
  cos2SigmaM = Math.cos(2 * sigma1 + sigma);
  sinSigma = Math.sin(sigma);
  cosSigma = Math.cos(sigma);
  const x = sinU1 * sinSigma - cosU1 * cosSigma * cosA1,
    latitude = Math.atan2(
      sinU1 * cosSigma + cosU1 * sinSigma * cosA1,
      (1 - f) * Math.hypot(sinAlpha, x),
    ),
    lambda = Math.atan2(sinSigma * sinA1, cosU1 * cosSigma - sinU1 * sinSigma * cosA1),
    C = (f / 16) * cosSqAlpha * (4 + f * (4 - 3 * cosSqAlpha)),
    L =
      lambda -
      (1 - C) * f * sinAlpha * (sigma + C * sinSigma * (cos2SigmaM + C * cosSigma * (-1 + 2 * cos2SigmaM * cos2SigmaM)));
  return {
    longitude: wrapPi(lon1 + L),
    latitude,
    finalBearing: norm2pi(Math.atan2(sinAlpha, -x)),
  };
}

/** An ECEF camera pose looking at a geodetic target. */
export interface OrbitPose {
  position: [number, number, number];
  target: [number, number, number];
  up: [number, number, number];
}

/**
 * The camera pose that orbits a geodetic `centre` at `range` metres. `heading` is the compass direction the camera
 * looks toward (radians clockwise from north); `pitch` is how far below the local horizon it looks (0 horizontal,
 * PI/2 straight down). `up` is screen-up in ECEF: toward the sky, or toward the heading direction when looking down.
 */
export function orbitPose(centre: Cartographic, heading: number, pitch: number, range: number): OrbitPose {
  finite('orbitPose', centre.longitude, centre.latitude, centre.height, heading, pitch, range);
  const target = cartographicToEcef(centre.longitude, centre.latitude, centre.height),
    b = enuBasis(centre.longitude, centre.latitude),
    sh = Math.sin(heading),
    ch = Math.cos(heading),
    sp = Math.sin(pitch),
    cp = Math.cos(pitch),
    mix = (e: number, n: number, u: number) =>
      [0, 1, 2].map((i) => b.east[i]! * e + b.north[i]! * n + b.up[i]! * u) as [number, number, number],
    view = mix(sh * cp, ch * cp, -sp);
  return {
    target,
    position: [target[0] - view[0] * range, target[1] - view[1] * range, target[2] - view[2] * range],
    up: mix(sh * sp, ch * sp, cp),
  };
}
