import { MargoError } from '@margoengine/math/errors';
import type { HydrometeorSample, Precipitation, SeaSource } from '@margoengine/math/fields';
import { pow } from '@margoengine/math/pinned';
import { wakePatch, type WakeSourceGrid } from './submerged-wake.js';

const PI = 3.141592653589793;
// ATMO-04 measures liquid-water equivalent using this density in kg/m³.
const rainDensity = 1000;
const millimetresPerHourToMetresPerSecond = 1 / 3_600_000;

/**
 * The wake grid rain falls on: cell counts in X and Z, cell length in metres and the lower corner in metres from
 * the origin cell.
 */
export interface WakeRainGrid {
  /** Wake dimensions, X then Z. */
  readonly cells: readonly [number, number];
  /** Length of one grid cell in metres. */
  readonly cellSize: number;
  /** Lower X and Z corners, metres from the wake's origin cell. */
  readonly origin: readonly [number, number];
}

/** Location and measured or supplied properties of one drop at impact. */
export interface WakeRainDrop {
  /** Horizontal coordinates in metres from the wake's origin cell. */
  readonly x: number;
  readonly z: number;
  /** Equivalent sphere diameter in metres. */
  readonly diameter: number;
  /** Downward impact speed in m/s. Use zero for deposition without a pressure impulse. */
  readonly fallSpeed: number;
  /** Drop density in kg/m³. Default 1000 for liquid rain. */
  readonly density?: number;
}

/** A supplied contact with water, in seconds and metres from the wake's origin cell. */
export interface WakeRainImpact {
  readonly time: number;
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

/**
 * Options for rain wake sources: the precipitation, the ordered impacts, the grid, the wake step in seconds, the
 * origin cell and the metres per cell (default 4096).
 */
export interface WakeRainSourcesOptions {
  readonly precipitation: Precipitation;
  /** The contact times and positions, in their canonical order within each tick. */
  readonly impacts: readonly WakeRainImpact[];
  readonly grid: WakeRainGrid;
  /** Wake step duration in seconds. The callback receives the midpoint of a step of this duration. */
  readonly dt: number;
  /** Impact/wake origin cell. Defaults to the precipitation field's cell. */
  readonly cell?: Precipitation['cell'];
  /** Horizontal and vertical origin-cell length in metres. Default 4096. */
  readonly metresPerCell?: number;
}

function sourceGrid(grid: WakeRainGrid, dt: number): WakeSourceGrid {
  if (!Array.isArray(grid?.cells) || grid.cells.length !== 2 || !Array.isArray(grid.origin) || grid.origin.length !== 2)
    throw new MargoError('state', 'Give rain the wake grid with two dimensions and an XZ origin.');
  if (!(grid?.cells?.length === 2 && grid.origin?.length === 2))
    throw new MargoError('state', 'Pass the wake grid with its two dimensions and lower XZ corner.');
  const {
    cells: [nx, nz],
    cellSize: dx,
    origin: [x0, z0],
  } = grid;
  if (
    ![nx, nz].every((n) => Number.isInteger(n) && n >= 4 && n <= 4096) ||
    !(Number.isFinite(dx) && dx > 0 && Number.isFinite(x0) && Number.isFinite(z0)) ||
    !(Number.isFinite(dt) && dt > 0)
  )
    throw new MargoError('state', 'Give rain the actual wake grid and a finite positive wake step in seconds.');
  return { nx, nz, dx, x0, z0 };
}

function dropSource(drop: WakeRainDrop, grid: WakeSourceGrid, dt: number): SeaSource {
  const { x, z, diameter, fallSpeed, density = rainDensity } = drop;
  const { nx, nz, dx, x0, z0 } = grid;
  if (![x, z, diameter, fallSpeed, density].every(Number.isFinite) || !(diameter > 0 && density > 0 && fallSpeed >= 0))
    throw new MargoError(
      'state',
      'Give each rain drop a finite location, positive diameter and density, and downward speed.',
    );
  // The physical footprint is the drop's projected disk. One cell of support resolves an unresolved disk.
  const radius = Math.max(diameter / 2, dx);
  if (x - radius < x0 || x + radius > x0 + nx * dx || z - radius < z0 || z + radius > z0 + nz * dx)
    throw new MargoError(
      'state',
      'You must place the rain impact and its complete pressure footprint inside the wake grid.',
    );
  const volume = (PI / 6) * diameter * diameter * diameter;
  const impulse = density * volume * fallSpeed;
  // Reuse the actual wake quadrature with zero volume and no pressure destination to query only its area.
  const area = wakePatch(grid, x, z, radius, 0, undefined);
  const timeArea = area * dt;
  const pressure = impulse / timeArea;
  if (!(volume > 0 && Number.isFinite(volume) && Number.isFinite(timeArea) && Number.isFinite(pressure)))
    throw new MargoError('state', 'Use a rain drop and wake spacing with finite deposited volume and pressure.');
  return { x, z, radius, pressure, volume };
}

/**
 * Surface source for one rain impact. The resolved disk deposits a drop's volume and its downward momentum.
 * Use the returned row for one wake tick. This is a linear impact pulse for the ensuing rings.
 * See Schreck, Hafner and Wojtan (2019), §4, and Le Méhauté (1988).
 */
export function wakeRainSource(drop: WakeRainDrop, grid: WakeRainGrid, dt: number): SeaSource {
  return dropSource(drop, sourceGrid(grid, dt), dt);
}

/** A representative liquid drop preserving volume and kinetic energy per counted impact. Dry samples return undefined. */
export function wakeRainEquivalentDrop(
  x: number,
  z: number,
  { rate, impactRate, energyFlux }: Pick<HydrometeorSample, 'rate' | 'impactRate' | 'energyFlux'>,
): WakeRainDrop | undefined {
  if (![x, z, rate, impactRate, energyFlux].every(Number.isFinite) || rate < 0 || impactRate < 0 || energyFlux < 0)
    throw new MargoError('state', 'Use finite rain location, liquid-water rate, impact count and energy flux.');
  if (rate === 0 && impactRate === 0 && energyFlux === 0) return undefined;
  if (!(rate > 0 && impactRate > 0))
    throw new MargoError('state', 'Give rain with nonzero flux a positive liquid-water rate and impact count.');
  const volumeFlux = rate * millimetresPerHourToMetresPerSecond;
  const volume = volumeFlux / impactRate;
  const fallSpeed = Math.sqrt((2 * energyFlux) / (rainDensity * volumeFlux));
  const diameter = pow((6 * volume) / PI, 1 / 3);
  if (!(diameter > 0 && Number.isFinite(diameter) && Number.isFinite(fallSpeed)))
    throw new MargoError('state', 'You must scale the rain flux and impact count to a finite representative drop.');
  return { x, z, diameter, fallSpeed, density: rainDensity };
}

/** A pure WakeParams.sources callback using supplied contacts and a live precipitation field. */
export function wakeRainSources({
  precipitation,
  impacts,
  grid,
  dt,
  cell = precipitation?.cell,
  metresPerCell = 4096,
}: WakeRainSourcesOptions): (midpoint: number) => readonly SeaSource[] {
  const shape = sourceGrid(grid, dt);
  if (
    typeof precipitation?.sample !== 'function' ||
    ![cell, precipitation.cell].every(
      (origin) => Array.isArray(origin) && origin.length === 3 && origin.every(Number.isSafeInteger),
    ) ||
    !(Number.isFinite(metresPerCell) && metresPerCell > 0)
  )
    throw new MargoError(
      'state',
      'You must supply a precipitation sampler, integer origin cells and a finite cell length.',
    );
  const offset = cell.map((value, i) => (value - precipitation.cell[i]!) * metresPerCell);
  if (!offset.every(Number.isFinite))
    throw new MargoError('state', 'Place the precipitation field within finite offsets of the wake cell.');
  const byTick = new Map<number, WakeRainImpact[]>();
  for (const { time, x, y, z } of impacts) {
    const tick = Math.floor(time / dt);
    if (!Number.isSafeInteger(tick) || tick < 0 || ![x, y, z].every(Number.isFinite))
      throw new MargoError('state', 'Use finite rain impact locations and nonnegative world times on the wake clock.');
    const events = byTick.get(tick);
    if (events) events.push({ time, x, y, z });
    else byTick.set(tick, [{ time, x, y, z }]);
  }
  return (midpoint) => {
    const sources: SeaSource[] = [];
    for (const { time, x, y, z } of byTick.get(Math.floor(midpoint / dt)) ?? []) {
      const { rain } = precipitation.sample(x + offset[0]!, y + offset[1]!, z + offset[2]!, time);
      const drop = wakeRainEquivalentDrop(x, z, rain);
      if (drop) sources.push(dropSource(drop, shape, dt));
    }
    return sources;
  };
}
