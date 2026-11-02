// Clean-room J9: Finney 2002 (doi:10.1139/x02-068), least-time fire paths; Rothermel 1972
// (https://research.fs.usda.gov/download/treesearch/32533.pdf), moisture cubic and wind/slope multipliers.
// Leopold and Maddock 1953 (doi:10.3133/pp252), depth as a discharge power; Chow 1951
// (doi:10.1029/TR032i002p00231), frequency factor; Nobre 2011 (doi:10.1016/j.jhydrol.2011.03.051),
// drainage-relative heights, not fixed flood classes. Connell and Slatyer 1977 (doi:10.1086/283241)
// motivates sequences after disturbance, not our chosen ages. Verification and limits are in README, Disturbance.
// Assumptions: full fuel R0 = 1000 mm/min, slope K = 5, wind C = 0.1 and B = 1.5;
// cosine wind replaces an elliptical law. Flood depth = 10 mm * area(m2)^0.4 * (1 + K_T).
import { rangeError, typeError } from '../../shared/errors.js';
import { degreesToAngle, divFloor, divWide, idiv, imod, ONE, qexp2, qlog2, qmul, qpow, sincos, umod } from './fixed.js';
import { hash3, hash4 } from './hash.js';
import type { HeightGrid, Hydrology } from './hydrology.js';
import type { RasterLayer } from './layers.js';

/** Fire settings; omitted settings use the defaults shown on each field.
 * @example const fire: FireOptions = { ignitions: [10], ignitionsPerYear: 0 };
 */
export interface FireOptions {
  /** Seeded ignition attempts per year, integer 0..65535. Default 1. */
  readonly ignitionsPerYear?: number;
  /** Authored cell indices ignited in year 0, before seeded attempts. Default none. */
  readonly ignitions?: readonly number[];
  /** Whole minutes of growth per fire, 0..2147483646. Default 480. */
  readonly duration?: number;
  /** Wind speed 0..100 m/s, direction in degrees: 0 = +x, clockwise toward +z. Defaults 0, 0. */
  readonly wind?: { readonly speed?: number; readonly direction?: number };
  /** Fraction of extinction moisture, 0..1. Default 0.2; 1 prevents ignition and spread. */
  readonly moisture?: number;
  /** Years before a burned cell can burn again, integer 0..10000. Default 5; never twice in one year. */
  readonly recovery?: number;
}

/** Flood settings, derived from hydrology independently of the seed.
 * @example const flood: FloodOptions = { returnPeriods: [2, 10, 100], wetland: 2 };
 */
export interface FloodOptions {
  /** Strictly ascending integer return periods, 2..65535 years. Default [2, 10, 100]. */
  readonly returnPeriods?: readonly number[];
  /** Flood periods at or below this integer 1..65535 cap succession at grass. Default 2. */
  readonly wetland?: number;
}

/** Options for independent disturbance data; no option modifies a world.
 * @example const options: DisturbanceOptions = { seed: 7, years: 50, flood: false };
 */
export interface DisturbanceOptions {
  /** Unsigned 32-bit seed. Default 0. */
  readonly seed?: number;
  /** History length in whole years, 1..10000. Default 100. */
  readonly years?: number;
  /** Uint8Array of nx*nz fuel values; 0 cannot burn. Default 128 everywhere. */
  readonly fuel?: Uint8Array;
  /** Uint8Array mask of nx*nz values, each 0 or 1; bare rock cannot burn. Default none. */
  readonly rock?: Uint8Array;
  /** Uint8Array mask of nx*nz values, each 0 or 1, combined with hydrology.water === 0. Default none. */
  readonly water?: Uint8Array;
  /** Fire settings, or false to disable fire. Default {}. */
  readonly fire?: false | FireOptions;
  /** Flood settings, or false to disable flood. Default {}. */
  readonly flood?: false | FloodOptions;
  /** Strictly increasing whole ages 1..65535, at most 255 thresholds. Default stages [1, 5, 20, 80]. */
  readonly succession?: { readonly stages?: readonly number[] };
}

/** Region disturbance layers. Height is a copy, in millimetres, and arrays are owned by the result.
 * @example const d: Disturbance = disturbance(grid, undefined, { fire: false });
 */
export interface Disturbance extends HeightGrid {
  readonly seed: number;
  readonly years: number;
  /** Years since last burn at the final history year; 65535 means never burned. */
  readonly age: Uint16Array;
  /** Smallest listed return period reaching the cell, 1 on water, 0 for no listed flood. */
  readonly flood: Uint16Array;
  /** Count of age thresholds reached, capped at 1 for frequently flooded cells. */
  readonly stage: Uint8Array;
}

/** World shape read by disturbanceOf and disturbanceTile; no world methods are called.
 * @example const d = disturbanceOf(world, hydrologyOf(world));
 */
export interface DisturbanceWorld {
  readonly region: HeightGrid;
  readonly bounds: readonly [number, number, number, number];
  readonly tileSize: number;
  readonly resolution: number;
}

const DEFAULT_STAGES = Object.freeze([1, 5, 20, 80]);
const DEFAULT_PERIODS = Object.freeze([2, 10, 100]);
const ROOT2 = 92682,
  SQRT5 = 146543,
  MAX_I32 = 2147483647;
const BASE_RATE = 1000,
  SLOPE_K = 5 * ONE,
  WIND_C = 6554,
  WIND_B = 98304;
const MOISTURE_A = 169738,
  MOISTURE_B = 334889,
  MOISTURE_C = 230687;
const DEPTH_C = 10,
  DEPTH_F = 26214,
  LN2 = 45426,
  SQRT6_PI = 51098,
  EULER = 37827;
const DX = [1, 1, 0, -1, -1, -1, 0, 1, 2, 1, -1, -2, -2, -1, 1, 2];
const DZ = [0, 1, 1, 1, 0, -1, -1, -1, 1, 2, 2, 1, -1, -2, -2, -1];

function object(value: unknown, name: string): void {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw typeError(`disturbance ${name} must be an options object`, 'biomes');
  for (const [key, field] of Object.entries(value))
    if (field === null)
      throw typeError(`disturbance ${name}.${key} must have its documented type; omit it to use the default`, 'biomes');
}

function integer(v: number, lo: number, hi: number, name: string): number {
  if (!Number.isInteger(v) || v < lo || v > hi)
    throw rangeError(`disturbance ${name} must be a whole number from ${lo} to ${hi}`, 'biomes');
  return v;
}

function fraction(v: number, lo: number, hi: number, name: string): number {
  if (!Number.isFinite(v) || v < lo || v > hi)
    throw rangeError(`disturbance ${name} must be a finite number from ${lo} to ${hi}`, 'biomes');
  return Math.round(v * ONE);
}

function ascending(values: readonly number[], lo: number, name: string): void {
  if (!Array.isArray(values))
    throw typeError(`disturbance ${name} must be an ascending array of whole years`, 'biomes');
  let previous = lo - 1;
  for (const v of values) {
    integer(v, lo, 65535, name);
    if (v <= previous) throw rangeError(`disturbance ${name} must be strictly increasing whole years`, 'biomes');
    previous = v;
  }
}

function gridCheck(grid: HeightGrid): number {
  object(grid, 'grid');
  const { nx, nz, step, height } = grid;
  integer(nx, 2, MAX_I32, 'nx');
  integer(nz, 2, MAX_I32, 'nz');
  integer(step, 1, MAX_I32, 'step in millimetres');
  const n = integer(nx * nz, 4, MAX_I32, 'nx x nz');
  if (!(height instanceof Int32Array) || height.length !== n)
    throw typeError('disturbance height must be an Int32Array of nx x nz millimetre values', 'biomes');
  return n;
}

function stageAt(age: number, cap: number, stages: readonly number[]): number {
  let stage = 0;
  while (stage < stages.length && stages[stage] <= age) stage++;
  return Math.min(cap, stage);
}

/** Succession is the number of thresholds at or below age, limited by cap.
 * @throws RangeError for ages outside 0..65535, caps outside 0..255 or unordered thresholds.
 * @example successionStage(25); // 3, young stand
 */
export function successionStage(age: number, cap = 255, stages: readonly number[] = DEFAULT_STAGES): number {
  integer(age, 0, 65535, 'age');
  integer(cap, 0, 255, 'succession cap');
  ascending(stages, 1, 'succession stages');
  integer(stages.length, 0, 255, 'number of succession stages');
  return stageAt(age, cap, stages);
}

// Positive integers wider than Q16's input range are normalised before taking log2.
function logInteger(v: number): number {
  let shift = 0;
  while (v >= 16384) {
    v = divFloor(v, 2);
    shift++;
  }
  return qlog2(v * ONE) + shift * ONE;
}

function frequency(period: number): number {
  // Q16 table for the default periods; custom periods use the same Gumbel formula in fixed point.
  if (period === 2) return -10766;
  if (period === 10) return 85496;
  if (period === 100) return 205566;
  // ln(T/(T-1)) = -ln(1-1/T); Q30 keeps the tail non-zero even at T=65535.
  const inverse = divWide(1073741824, period);
  let power = inverse,
    sum = inverse;
  for (let k = 2; k <= 24; k++) {
    power = divWide(power * inverse, 1073741824);
    sum += divWide(power, k);
  }
  const logLn = qmul(logInteger(sum) - 30 * ONE, LN2);
  return -qmul(SQRT6_PI, EULER + logLn);
}

function floodLayers(
  h: Hydrology,
  grid: HeightGrid,
  water: Uint8Array,
  periods: readonly number[],
  flood: Uint16Array,
) {
  const n = flood.length,
    { nx, nz, step } = grid;
  const drain = new Int32Array(n).fill(-1),
    visiting = new Uint8Array(n);
  const factors = periods.map((t) => ONE + frequency(t));
  for (let c = 0; c < n; c++) {
    const path: number[] = [];
    let a = c;
    while (drain[a] < 0) {
      if (visiting[a])
        throw rangeError(
          'disturbance hydrology directions must drain without cycles; rerun hydrology on this grid',
          'biomes',
        );
      visiting[a] = 1;
      path.push(a);
      const d = h.direction[a];
      if (h.channel[a] || d < 0) {
        drain[a] = a;
        break;
      }
      const x = imod(a, nx),
        z = idiv(a - x, nx),
        u = x + DX[d],
        v = z + DZ[d];
      if (u < 0 || u >= nx || v < 0 || v >= nz)
        throw rangeError(
          'disturbance hydrology directions must stay inside the grid; rerun hydrology on this grid',
          'biomes',
        );
      a = v * nx + u;
    }
    for (const i of path) {
      drain[i] = drain[a];
      visiting[i] = 0;
    }
  }
  const base = new Int32Array(n).fill(-1),
    exponents = new Int8Array(n);
  for (let c = 0; c < n; c++) {
    if (water[c]) {
      flood[c] = 1;
      continue;
    }
    const a = drain[c];
    if (base[a] < 0) {
      // Area in m2, via logarithms: flow * step^2 may exceed the exact integer range.
      const logArea = logInteger(h.flow[a]) + 2 * (logInteger(step) - logInteger(1000));
      const logDepth = qmul(logArea, DEPTH_F) + logInteger(DEPTH_C);
      const exponent = divFloor(logDepth, ONE);
      base[a] = qexp2(logDepth - exponent * ONE);
      exponents[a] = exponent;
    }
    for (let j = 0; j < periods.length; j++) {
      // Retain submillimetre depth and apply the factor before saturating the final stage.
      const scaled = divWide(base[a] * factors[j], ONE),
        exponent = exponents[a];
      const depth =
        exponent >= 32
          ? MAX_I32
          : Math.min(
              MAX_I32,
              exponent < 0 ? divWide(scaled, ONE * 2 ** -exponent) : divWide(scaled * 2 ** exponent, ONE),
            );
      if (h.hand[c] <= depth) {
        flood[c] = periods[j];
        break;
      }
    }
  }
}

// Binary heap ordered by (arrival minute, cell index), including ties.
class ArrivalHeap {
  private readonly cells: number[] = [];
  private readonly times: number[] = [];
  get length() {
    return this.cells.length;
  }
  push(cell: number, time: number) {
    let i = this.length;
    this.cells.push(cell);
    this.times.push(time);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.times[p] < time || (this.times[p] === time && this.cells[p] <= cell)) break;
      this.cells[i] = this.cells[p];
      this.times[i] = this.times[p];
      i = p;
    }
    this.cells[i] = cell;
    this.times[i] = time;
  }
  pop(): [number, number] {
    const result: [number, number] = [this.cells[0], this.times[0]];
    const cell = this.cells.pop()!,
      time = this.times.pop()!;
    if (this.length) {
      let i = 0;
      while (2 * i + 1 < this.length) {
        let j = 2 * i + 1;
        if (
          j + 1 < this.length &&
          (this.times[j + 1] < this.times[j] ||
            (this.times[j + 1] === this.times[j] && this.cells[j + 1] < this.cells[j]))
        )
          j++;
        if (time < this.times[j] || (time === this.times[j] && cell <= this.cells[j])) break;
        this.cells[i] = this.cells[j];
        this.times[i] = this.times[j];
        i = j;
      }
      this.cells[i] = cell;
      this.times[i] = time;
    }
    return result;
  }
}

function fires(
  grid: HeightGrid,
  seed: number,
  years: number,
  fuel: Uint8Array,
  blocked: Uint8Array,
  fire: FireOptions,
  age: Uint16Array,
) {
  const { nx, nz, step, height } = grid,
    n = age.length;
  const attempts = integer(fire.ignitionsPerYear ?? 1, 0, 65535, 'fire ignitionsPerYear');
  const duration = integer(fire.duration ?? 480, 0, MAX_I32 - 1, 'fire duration in minutes');
  const recovery = integer(fire.recovery ?? 5, 0, 10000, 'fire recovery years');
  const r = fraction(fire.moisture ?? 0.2, 0, 1, 'fire moisture');
  if (fire.wind !== undefined) object(fire.wind, 'fire wind');
  const speed = fraction(fire.wind?.speed ?? 0, 0, 100, 'fire wind speed');
  const direction = fire.wind?.direction ?? 0;
  if (!Number.isFinite(direction)) throw rangeError('disturbance fire wind direction must be finite degrees', 'biomes');
  const wind = sincos(degreesToAngle(direction), [0, 0]);
  const eta =
    r === ONE
      ? 0
      : Math.max(0, ONE - qmul(MOISTURE_A, r) + qmul(MOISTURE_B, qmul(r, r)) - qmul(MOISTURE_C, qmul(qmul(r, r), r)));
  const windPower = qmul(WIND_C, qpow(speed, WIND_B));
  const ignitions = fire.ignitions ?? [];
  if (!Array.isArray(ignitions))
    throw typeError('disturbance fire ignitions must be an array of cell indices', 'biomes');
  for (const c of ignitions) integer(c, 0, n - 1, 'fire ignition cell index');
  const distance = DX.map((dx, d) => Math.max(1, divWide(step * (d >= 8 ? SQRT5 : dx && DZ[d] ? ROOT2 : ONE), ONE)));
  const windFactor = DX.map((dx, d) => {
    const length = d >= 8 ? SQRT5 : dx && DZ[d] ? ROOT2 : ONE;
    const cos = Math.max(0, Math.min(ONE, divWide((dx * wind[0] + DZ[d] * wind[1]) * ONE, length)));
    return qmul(windPower, cos);
  });
  const last = new Int32Array(n).fill(-1);
  const burn = (start: number, year: number) => {
    const open = (c: number) =>
      !blocked[c] && fuel[c] > 0 && (last[c] < 0 || (last[c] !== year && year - last[c] >= recovery));
    if (!eta || !open(start)) return;
    const arrival = new Int32Array(n).fill(MAX_I32),
      heap = new ArrivalHeap(),
      burned: number[] = [];
    arrival[start] = 0;
    heap.push(start, 0);
    while (heap.length) {
      const [c, time] = heap.pop();
      if (time !== arrival[c]) continue;
      burned.push(c);
      const x = imod(c, nx),
        z = idiv(c - x, nx);
      for (let d = 0; d < 16; d++) {
        const dx = DX[d],
          dz = DZ[d],
          u = x + dx,
          v = z + dz;
        if (u < 0 || u >= nx || v < 0 || v >= nz) continue;
        const i = v * nx + u;
        if (!open(i)) continue;
        const sx = Math.sign(dx),
          sz = Math.sign(dz);
        if (dx && dz) {
          // Supercover: every cell touched by the straight segment, including corner contacts.
          if (d < 8 && (!open(c + sx) || !open(c + sz * nx))) continue;
          if (d >= 8 && (!open(c + (Math.abs(dx) === 2 ? sx : sz * nx)) || !open(c + sx + sz * nx))) continue;
        }
        const tan = Math.min(2 * ONE, divWide(Math.max(0, height[i] - height[c]) * ONE, distance[d]));
        const slope = qmul(SLOPE_K, qmul(tan, tan));
        const base = divWide(BASE_RATE * ONE * fuel[i], 255);
        const rate = Math.max(
          1,
          Math.min(MAX_I32, divWide(divWide(base * eta, ONE) * (ONE + slope + windFactor[d]), ONE * ONE)),
        );
        const minutes = Math.min(MAX_I32, divWide(distance[d] + rate - 1, rate));
        const next = time + minutes;
        if (next <= duration && next < arrival[i]) {
          arrival[i] = next;
          heap.push(i, next);
        }
      }
    }
    // Freeze eligibility for this whole search: its own burned cells remain traversable until the fire ends.
    for (const c of burned) last[c] = year;
  };
  for (let year = 0; year < years; year++) {
    if (year === 0) for (const c of ignitions) burn(c, year);
    for (let k = 0; k < attempts; k++) {
      const c = umod(hash3(seed, year, k), n);
      const chance = divWide(fuel[c] * eta, 255);
      if ((hash4(seed, year, k, 1) & 0xffff) < chance) burn(c, year);
    }
  }
  for (let c = 0; c < n; c++) if (last[c] >= 0) age[c] = years - 1 - last[c];
}

/** Compute independent CPU-only disturbance layers synchronously, without mutating inputs.
 * @throws TypeError for invalid arrays or objects; RangeError for invalid numbers or drainage.
 * @example const d = disturbance(grid, h, { seed: 7, years: 100 });
 */
export function disturbance(
  grid: HeightGrid,
  hydrology: Hydrology | undefined,
  options: DisturbanceOptions = {},
): Disturbance {
  const n = gridCheck(grid);
  object(options, 'options');
  const seed = integer(options.seed ?? 0, 0, 0xffffffff, 'seed');
  const years = integer(options.years ?? 100, 1, 10000, 'years');
  const fuel = options.fuel ?? new Uint8Array(n).fill(128),
    water = new Uint8Array(n),
    blocked = new Uint8Array(n);
  for (const [name, values] of [
    ['fuel', fuel],
    ['water', options.water],
    ['rock', options.rock],
  ] as const) {
    if (values === undefined) continue;
    if (!(values instanceof Uint8Array) || values.length !== n)
      throw typeError(
        `disturbance ${name} must be a Uint8Array of nx x nz values (0 = ${name === 'fuel' ? 'no fuel' : 'unmasked'})`,
        'biomes',
      );
    if (name !== 'fuel' && values.some((v) => v > 1))
      throw rangeError(`disturbance ${name} must contain only 0 or 1`, 'biomes');
  }
  if (hydrology !== undefined) {
    object(hydrology, 'hydrology');
    if (hydrology.nx !== grid.nx || hydrology.nz !== grid.nz || hydrology.step !== grid.step)
      throw rangeError('disturbance hydrology must match this grid; rerun hydrology on it', 'biomes');
    for (const key of ['water', 'flow', 'hand', 'direction', 'channel'] as const) {
      const a = hydrology[key],
        ctor = key === 'direction' ? Int8Array : key === 'channel' ? Uint8Array : Int32Array;
      if (!(a instanceof ctor) || a.length !== n)
        throw typeError(`disturbance hydrology ${key} must have nx x nz values from hydrology()`, 'biomes');
    }
    for (let c = 0; c < n; c++) {
      if (
        hydrology.direction[c] < -1 ||
        hydrology.direction[c] > 7 ||
        hydrology.flow[c] < 1 ||
        hydrology.hand[c] < 0 ||
        hydrology.water[c] < 0 ||
        hydrology.channel[c] > 1
      )
        throw rangeError(
          'disturbance hydrology must have D8 directions, positive flow and non-negative HAND and water; rerun hydrology()',
          'biomes',
        );
    }
  }
  if (options.succession !== undefined) object(options.succession, 'succession');
  const stages = options.succession?.stages ?? DEFAULT_STAGES;
  successionStage(0, 255, stages);
  for (let c = 0; c < n; c++) {
    water[c] = options.water?.[c] || hydrology?.water[c] === 0 ? 1 : 0;
    blocked[c] = water[c] || options.rock?.[c] ? 1 : 0;
  }
  const age = new Uint16Array(n).fill(65535),
    flood = new Uint16Array(n),
    stage = new Uint8Array(n);
  const fire = options.fire === undefined ? {} : options.fire;
  if (fire !== false) {
    object(fire, 'fire');
    fires(grid, seed, years, fuel, blocked, fire, age);
  }
  const flooding = options.flood === undefined ? {} : options.flood;
  let wetland = 2;
  if (flooding !== false) {
    object(flooding, 'flood');
    const periods = flooding.returnPeriods ?? DEFAULT_PERIODS;
    ascending(periods, 2, 'flood returnPeriods');
    wetland = integer(flooding.wetland ?? 2, 1, 65535, 'flood wetland period');
    if (hydrology) floodLayers(hydrology, grid, water, periods, flood);
  }
  for (let c = 0; c < n; c++) stage[c] = stageAt(age[c], flood[c] && flood[c] <= wetland ? 1 : 255, stages);
  return { height: grid.height.slice(), nx: grid.nx, nz: grid.nz, step: grid.step, seed, years, age, flood, stage };
}

/** Compute the region once; tile sampling reads it without changing the world.
 * @example const d = disturbanceOf(world, hydrologyOf(world), { seed: 7 });
 */
export function disturbanceOf(
  world: DisturbanceWorld,
  h: Hydrology | undefined,
  options?: DisturbanceOptions,
): Disturbance {
  object(world, 'world');
  return disturbance(world.region, h, options);
}

/** Disturbance raster metadata, in canonical layer order.
 * @example console.log(DISTURBANCE_LAYERS.age.unit); // years
 */
export const DISTURBANCE_LAYERS = Object.freeze({
  age: Object.freeze({ format: 'u16', scale: 1, unit: 'years' } as const),
  flood: Object.freeze({ format: 'u16', scale: 1, unit: 'years' } as const),
  stage: Object.freeze({ format: 'u8', scale: 1, unit: 'index' } as const),
});

/** Sample age, flood and stage at the nearest region corner for each tile cell.
 * @throws RangeError for a tile outside the world or a mismatched region.
 * @example const [age, flood, stage] = disturbanceTile(world, d, 0, 0);
 */
export function disturbanceTile(world: DisturbanceWorld, d: Disturbance, x: number, z: number): RasterLayer[] {
  object(world, 'world');
  resultCheck(d);
  gridCheck(world.region);
  if (!Array.isArray(world.bounds) || world.bounds.length !== 4 || !world.bounds.every(Number.isFinite))
    throw typeError('disturbanceTile world bounds must contain four finite metre coordinates', 'biomes');
  if (
    !(
      world.tileSize > 0 &&
      Number.isFinite(world.tileSize) &&
      world.resolution > 0 &&
      Number.isFinite(world.resolution)
    )
  )
    throw rangeError('disturbanceTile needs positive finite tileSize and resolution in metres', 'biomes');
  const cells = divWide(world.tileSize, world.resolution);
  if (cells < 1 || cells * world.resolution !== world.tileSize)
    throw rangeError('disturbanceTile resolution must divide tileSize exactly', 'biomes');
  const width = (world.bounds[2] - world.bounds[0]) / world.tileSize; // float division: world tile coordinates
  const depth = (world.bounds[3] - world.bounds[1]) / world.tileSize; // float division: world tile coordinates
  if (!Number.isInteger(x) || !Number.isInteger(z) || x < 0 || z < 0 || x >= width || z >= depth)
    throw rangeError('disturbanceTile needs tile indices inside the world', 'biomes');
  if (d.nx !== world.region.nx || d.nz !== world.region.nz || d.step !== world.region.step)
    throw rangeError('disturbanceTile needs disturbanceOf this world region', 'biomes');
  const scale = divFloor(world.resolution * 1000 * ONE, d.step);
  const age = new Uint16Array(cells * cells),
    flood = new Uint16Array(cells * cells),
    stage = new Uint8Array(cells * cells);
  for (let j = 0, k = 0; j < cells; j++) {
    const nearZ = Math.min(d.nz - 1, divFloor((z * cells + j) * scale + 32768, ONE));
    for (let i = 0; i < cells; i++, k++) {
      const near = nearZ * d.nx + Math.min(d.nx - 1, divFloor((x * cells + i) * scale + 32768, ONE));
      age[k] = d.age[near];
      flood[k] = d.flood[near];
      stage[k] = d.stage[near];
    }
  }
  const layer = (name: keyof typeof DISTURBANCE_LAYERS, data: RasterLayer['data']): RasterLayer => ({
    name,
    ...DISTURBANCE_LAYERS[name],
    width: cells,
    depth: cells,
    data,
  });
  return [layer('age', age), layer('flood', flood), layer('stage', stage)];
}

const HEADER = 28,
  CELL_BYTES = 9;

function resultCheck(d: Disturbance): number {
  const n = gridCheck(d);
  integer(d.seed, 0, 0xffffffff, 'seed');
  integer(d.years, 1, 10000, 'years');
  if (
    !(d.age instanceof Uint16Array) ||
    !(d.flood instanceof Uint16Array) ||
    !(d.stage instanceof Uint8Array) ||
    d.age.length !== n ||
    d.flood.length !== n ||
    d.stage.length !== n
  )
    throw typeError(
      'disturbance needs nx x nz age u16, flood u16 and stage u8 values; pass a disturbance() result',
      'biomes',
    );
  return n;
}

/** Encode MGDS version 1, little endian: nx, nz, step, seed, years, then row-major height, age, flood, stage per cell.
 * @throws TypeError or RangeError for invalid disturbance data.
 * @example const bytes = encodeDisturbance(d);
 */
export function encodeDisturbance(d: Disturbance): Uint8Array {
  const n = resultCheck(d);
  const bytes = new Uint8Array(HEADER + n * CELL_BYTES),
    view = new DataView(bytes.buffer);
  view.setUint32(0, 0x5344474d, true);
  view.setUint32(4, 1, true);
  for (const [j, value] of [d.nx, d.nz, d.step, d.seed, d.years].entries()) view.setUint32(8 + j * 4, value, true);
  for (let c = 0, p = HEADER; c < n; c++, p += CELL_BYTES) {
    view.setInt32(p, d.height[c], true);
    view.setUint16(p + 4, d.age[c], true);
    view.setUint16(p + 6, d.flood[c], true);
    view.setUint8(p + 8, d.stage[c]);
  }
  return bytes;
}

/** Decode exactly one MGDS version 1 record, accepting byte views with offsets.
 * @throws RangeError for a wrong magic, version, grid or length; TypeError for a non-byte input.
 * @example const d = decodeDisturbance(bytes);
 */
export function decodeDisturbance(bytes: Uint8Array): Disturbance {
  if (!(bytes instanceof Uint8Array))
    throw typeError('decodeDisturbance needs a Uint8Array from encodeDisturbance', 'biomes');
  const bad = () =>
    rangeError('decodeDisturbance needs a complete MGDS version 1 record from encodeDisturbance', 'biomes');
  if (bytes.byteLength < HEADER) throw bad();
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (v.getUint32(0, true) !== 0x5344474d || v.getUint32(4, true) !== 1) throw bad();
  const nx = v.getUint32(8, true),
    nz = v.getUint32(12, true),
    step = v.getUint32(16, true),
    seed = v.getUint32(20, true),
    years = v.getUint32(24, true),
    n = nx * nz;
  if (
    nx < 2 ||
    nz < 2 ||
    n > MAX_I32 ||
    step < 1 ||
    step > MAX_I32 ||
    years < 1 ||
    years > 10000 ||
    HEADER + n * CELL_BYTES !== bytes.byteLength
  )
    throw bad();
  const height = new Int32Array(n),
    age = new Uint16Array(n),
    flood = new Uint16Array(n),
    stage = new Uint8Array(n);
  for (let c = 0, p = HEADER; c < n; c++, p += CELL_BYTES) {
    height[c] = v.getInt32(p, true);
    age[c] = v.getUint16(p + 4, true);
    flood[c] = v.getUint16(p + 6, true);
    stage[c] = v.getUint8(p + 8);
  }
  return { nx, nz, step, seed, years, height, age, flood, stage };
}
