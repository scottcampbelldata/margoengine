// WGS84 ellipsoid (NIMA TR8350.2, "Department of Defense World Geodetic System 1984") and the ECEF / geodetic
// conversions 3D Tiles uses: tileset coordinates are ECEF metres (EPSG:4978), regions are geodetic radians (EPSG:4979).
import type { TileMatrix } from './matrix.js';

/** WGS84 semi-major axis, metres. */
export const WGS84_A = 6378137;
/** WGS84 flattening. */
export const WGS84_F = 1 / 298.257223563;
/** WGS84 semi-minor axis, metres. */
export const WGS84_B = WGS84_A * (1 - WGS84_F);
const E2 = WGS84_F * (2 - WGS84_F),
  EP2 = (WGS84_A * WGS84_A - WGS84_B * WGS84_B) / (WGS84_B * WGS84_B);

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
 * ECEF metres to geodetic. Bowring's closed form (B. R. Bowring, "Transformation from spatial to geographical
 * coordinates", Survey Review 23, 1976) followed by one Newton refinement: sub-millimetre from the centre of the earth
 * to geostationary heights, and exact at the poles.
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

/**
 * The local east-north-up frame at an ECEF point as a matrix from ENU metres to ECEF: columns east, north, up and the
 * point. At the poles, where east is undefined, east is taken as +y (longitude 0's east).
 */
export function eastNorthUpToEcef(x: number, y: number, z: number): TileMatrix {
  const { longitude, latitude } = ecefToCartographic(x, y, z);
  const so = Math.sin(longitude),
    co = Math.cos(longitude),
    sa = Math.sin(latitude),
    ca = Math.cos(latitude);
  return Float64Array.of(-so, co, 0, 0, -sa * co, -sa * so, ca, 0, ca * co, ca * so, sa, 0, x, y, z, 1);
}
