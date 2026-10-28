// Point queries for gameplay (`BiomeWorld.sample`): the same per-cell climate as the tiles, from region data.
import type { Climate } from './climate.js';
import { cellClimate, TPI_RADIUS } from './fields.js';
import { atan2, clampInt, divFloor, isqrt, ONE } from './fixed.js';
import type { RasterLayer } from './layers.js';
import { bilinear, type Region } from './region.js';

/** Climate values at a point, in plain units (written by `BiomeWorld.sample`). */
export interface BiomeSample {
  /** Height in metres. */
  height: number;
  /** Slope as rise over run, and aspect in degrees clockwise from north (-Z). */
  slope: number;
  aspect: number;
  /** Mean annual, coldest-month and warmest-month temperature in C. */
  temperature: number;
  coldest: number;
  warmest: number;
  /** Growing degree days above 5 C, and days above 0.9 C. */
  gdd5: number;
  season: number;
  /** Korner treeline margin in K: trees grow at 0 or more. */
  treeline: number;
  /** Rainfall in mm per year. */
  rainfall: number;
  /** Moisture index AET / PET and soil moisture, 0..1. */
  alpha: number;
  moisture: number;
  /** Wind exposure 0..1 (0.5 on flat ground) and distance to water in metres. */
  exposure: number;
  waterDistance: number;
  /** Soil depth in metres. */
  soil: number;
}

/** A sample from the region fields at world (x, z) metres. */
export function samplePoint(
  climate: Climate,
  region: Region,
  origin: readonly [number, number],
  x: number,
  z: number,
  out: BiomeSample = {} as BiomeSample,
): BiomeSample {
  const px = Math.round(x * 1000) - origin[0],
    pz = Math.round(z * 1000) - origin[1],
    rx = divFloor(px * ONE, region.step),
    rz = divFloor(pz * ONE, region.step),
    at = (grid: Int32Array, dx = 0, dz = 0) => bilinear(grid, region.nx, region.nz, rx + dx, rz + dz),
    e = at(region.height),
    // Central differences one region cell apart: mm over 2 cells.
    gx = at(region.height, ONE) - at(region.height, -ONE),
    gz = at(region.height, 0, ONE) - at(region.height, 0, -ONE),
    tan = Math.min(32767, divFloor(isqrt(Math.min(68719476736, gx * gx + gz * gz) * 65536), 2 * region.step)),
    angle = gx === 0 && gz === 0 ? 0 : atan2(-gx, gz),
    rain = Math.max(0, at(region.rain)),
    expo = clampInt(at(region.exposure), 0, 255),
    dist = clampInt(at(region.water), 0, 65535),
    c = cellClimate(
      climate,
      e,
      tan,
      gx,
      gz,
      0,
      TPI_RADIUS,
      rain,
      clampInt(at(region.continentality), 0, ONE),
      expo,
      dist,
      Math.max(0, at(region.fill)),
      [0, 0],
      new Int32Array(9),
    );
  out.height = e / 1000;
  out.slope = tan / 256;
  out.aspect = (((angle >> 16) * 360) / 65536 + 360) % 360;
  out.temperature = c[0] / 100;
  out.coldest = c[1] / 100;
  out.warmest = c[2] / 100;
  out.gdd5 = c[3];
  out.season = c[4];
  out.treeline = c[5] / 100;
  out.rainfall = Math.min(65535, rain);
  out.alpha = c[6] / 255;
  out.moisture = c[7] / 255;
  out.exposure = expo / 255;
  out.waterDistance = dist / 10;
  out.soil = c[8] / 100;
  return out;
}

/** A sample read from a finished tile's cell (exact: the tile's own values). */
export function readCell(
  tile: { layer(name: string): RasterLayer | undefined },
  i: number,
  j: number,
  out: BiomeSample = {} as BiomeSample,
): BiomeSample {
  const value = (name: string) => {
    const layer = tile.layer(name)!;
    return layer.data[j * layer.width + i] * layer.scale;
  };
  out.height = value('height');
  out.slope = value('slope');
  out.aspect = (value('aspect') + 360) % 360;
  out.temperature = value('temperature');
  out.coldest = value('coldest');
  out.warmest = value('warmest');
  out.gdd5 = value('gdd5');
  out.season = value('season');
  out.treeline = value('treeline');
  out.rainfall = value('rainfall');
  out.alpha = value('alpha');
  out.moisture = value('moisture');
  out.exposure = value('exposure');
  out.waterDistance = value('waterDistance');
  out.soil = value('soil');
  return out;
}
