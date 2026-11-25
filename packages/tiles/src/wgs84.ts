// WGS84 ellipsoid (NIMA TR8350.2, "Department of Defense World Geodetic System 1984") and the ECEF / geodetic
// conversions 3D Tiles uses: tileset coordinates are ECEF metres (EPSG:4978), regions are geodetic radians (EPSG:4979).
import type { TileMatrix } from './matrix.js';

import * as geo from '@margoengine/math/geo';

/** WGS84 semi-major axis, metres. */
export const WGS84_A = 6378137;
/** WGS84 flattening. */
export const WGS84_F = 1 / 298.257223563;
/** WGS84 semi-minor axis, metres. */
export const WGS84_B = WGS84_A * (1 - WGS84_F);

/** Geodetic coordinates: longitude and latitude in radians, height above the ellipsoid in metres. */
export interface Cartographic {
  longitude: number;
  latitude: number;
  height: number;
}

// The conversions are @margoengine/math/geo's (one copy for tiles, controls and geodesy).
/** Geodetic (radians, metres) to ECEF metres. */
export function cartographicToEcef(longitude: number, latitude: number, height = 0): [number, number, number] {
  return geo.cartographicToEcef(longitude, latitude, height);
}
/** ECEF metres to geodetic (Bowring 1976 plus refinement): sub-millimetre from the earth's centre to geostationary heights. */
export function ecefToCartographic(x: number, y: number, z: number): Cartographic {
  return geo.ecefToCartographic(x, y, z);
}
/** The ellipsoid's outward unit normal (geodetic up) at an ECEF point. */
export function geodeticNormal(x: number, y: number, z: number): [number, number, number] {
  return geo.geodeticNormal(x, y, z);
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
