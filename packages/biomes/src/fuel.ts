// Surface fuel of a biome world (entry `@margoengine/biomes/fuel`): which fuel model burns where, from the species and
// open ground each biome names (`SpeciesRule.fuel`, `BiomeDefinition.openFuel`), over the same region fields, stands and
// suitability that `canopyCover` reads, so the map and the forest a view draws agree. The result is a name per grid
// corner that `FireFront` takes as its `fuel` option (`fuel: map.at`); the fuel models themselves (loads, depths,
// surface-area-to-volume ratios and moistures of extinction) live in `@margoengine/vfx/fire-front` and are not repeated here.
// Sources: Anderson, "Aids to determining fuel models for estimating fire behavior", USDA Forest Service General
// Technical Report INT-122, 1982, which describes which vegetation each of the 13 models stands for; the share of the
// ground under crowns is the cover model of `canopyCover` (density x crown area, stands, suitability). Our own map
// from those descriptions; the rule that a cell with at least `timber` crown cover carries its trees' litter and an
// opener one carries the open fuel is ours.
import { rangeError, typeError } from '../../shared/errors.js';
import { meanCrownArea, stored } from './crown.js';
import { type Dimension, fieldDimension } from './define.js';
import type { BiomeSample } from './sample.js';
import { standAt, standsOf, type Stands, TICK } from './stands.js';
import type { Exclusion } from './placement.js';
import type { BiomeWorld } from './world.js';
import { ONE, wendland } from '@margoengine/biomes/toolkit';

/** Metres between grid corners of {@link fuelMap} unless asked otherwise: the world's region grid, as `canopyCover`. */
export const FUEL_STEP = 16;

/** A place with a fuel of its own: an {@link Exclusion} shape (a road, a building, a cut-over) and the fuel model there, or null for none. */
export type FuelPatch = Exclusion & {
  /** Fuel model name, or null for no fuel (a road, a yard, a house footprint). */
  readonly fuel: string | null;
};

/** Settings of {@link fuelMap}. Every one has a default. */
export interface FuelMapOptions {
  /** Metres between grid corners, a positive multiple of the world resolution. Default 16 (`FUEL_STEP`). */
  readonly step?: number;
  /**
   * The share of the ground under the crowns of fuel species (0..1) from which a corner carries the litter of its trees
   * and below which it carries its biome's `openFuel`. Default 0.3.
   */
  readonly timber?: number;
  /** Slope in degrees above which the ground is bare rock and carries no fuel, 20..89. Default 50. */
  readonly rockSlope?: number;
  /** Ground this many metres from water (rivers and the sea) or nearer carries no fuel, 0..100. Default 2. */
  readonly water?: number;
  /**
   * Shapes that carry no fuel: roads, yards, house footprints and pads (`pathExclusions(paths)` of
   * `@margoengine/biomes/splines`, or the `exclusions` of `layoutSettlements`). A corner within half a step of a shape
   * counts as on it, so a road narrower than the step still cuts the map. Default none.
   */
  readonly bare?: readonly Exclusion[];
  /** Shapes with a fuel of their own, such as logging slash (`'FM12'`), applied in order after `bare`. Default none. */
  readonly patches?: readonly FuelPatch[];
  /**
   * The fuel models you will give `FireFront` (`FUEL_MODELS` of `@margoengine/vfx/fire-front`, or your own record by
   * name). When given, a fuel name outside it throws here, not when the fire starts. Default: names are not checked.
   */
  readonly models?: Readonly<Record<string, unknown>>;
}

/** A fuel map: a fuel model name for each corner of a grid over the world. */
export interface FuelMap {
  /** Corners along x and z, `step` metres apart from the world's low corner. */
  readonly width: number;
  readonly depth: number;
  readonly step: number;
  /** World x and z of the first corner, metres. */
  readonly origin: readonly [x: number, z: number];
  /** The fuel names in use: a `data` value `k` above 0 is `names[k - 1]`. */
  readonly names: readonly string[];
  /** Fuel by corner, rows of increasing z: 0 for none, else an index into `names` plus one. */
  readonly data: Uint8Array;
  /** Share of the ground under the crowns of fuel species by corner, 0..255, same layout as `data`. */
  readonly cover: Uint8Array;
  /**
   * The fuel model name at world `(x, z)`, taken from the nearest corner, or null where there is no fuel or the point is
   * outside the world. Bound, so `FireFront.attach(engine, { fuel: map.at })` works.
   */
  readonly at: (x: number, z: number) => string | null;
}

interface Plant {
  readonly fuel: number;
  readonly share: number;
  readonly stands?: Stands;
  readonly dims: readonly Dimension[];
}
interface Plan {
  readonly plants: readonly Plant[];
  readonly open: number; // fuel index, -1 for none
}

const line = (px: number, pz: number, ax: number, az: number, bx: number, bz: number): number => {
  const dx = bx - ax,
    dz = bz - az,
    len = dx * dx + dz * dz,
    t = len > 0 ? Math.max(0, Math.min(1, ((px - ax) * dx + (pz - az) * dz) / len)) : 0; // float division: projection
  return Math.hypot(px - (ax + t * dx), pz - (az + t * dz));
};

/** Whether the shape covers world (x, z), with `reach` metres of slack (half a step). */
function covers(shape: Exclusion, x: number, z: number, reach: number): boolean {
  const p = shape.points;
  if (shape.kind === 'line') {
    const r = shape.width / 2 + reach; // float division: half width
    for (let i = 0; i + 1 < p.length; i++) if (line(x, z, p[i][0], p[i][1], p[i + 1][0], p[i + 1][1]) <= r) return true;
    return false;
  }
  let inside = false;
  for (let i = 0, j = p.length - 1; i < p.length; j = i++) {
    const [xi, zi] = p[i],
      [xj, zj] = p[j];
    if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside; // float division: crossing
    if (line(x, z, xi, zi, xj, zj) <= reach) return true;
  }
  return inside;
}

const checkShape = (s: unknown, what: string): void => {
  const e = s as Exclusion;
  if (
    !e ||
    (e.kind !== 'line' && e.kind !== 'polygon') ||
    !Array.isArray(e.points) ||
    e.points.length < (e.kind === 'line' ? 2 : 3) ||
    !e.points.every((q) => Array.isArray(q) && q.length === 2 && Number.isFinite(q[0]) && Number.isFinite(q[1])) ||
    (e.kind === 'line' && !(e.width > 0))
  )
    throw typeError(
      `fuelMap ${what} must be exclusion shapes: a line with points and a width, or a polygon of 3 or more points`,
      'biomes',
    );
};

/**
 * The surface fuel of a world, from the fuel names its biomes carry. At each grid corner the biomes there (by weight)
 * give the crown share of each fuel species (density x crown area, stands and suitability, as `canopyCover`): from
 * `timber` of the ground upward the corner takes the fuel of the species with the most crown, below it the biome's
 * `openFuel`; below sea level, within `water` of water and on slopes past `rockSlope` there is none; `bare` shapes
 * clear it and `patches` set it. No tile is made. Same world and options, same map; shares are float display maths as
 * in `canopyCover`.
 * @param world The world.
 * @param options See {@link FuelMapOptions}.
 * @throws RangeError for a `step` that is not a positive multiple of the world resolution, or an option out of range, or
 *   a fuel name missing from `models`; TypeError for a malformed shape.
 * @example
 * const map = fuelMap(world, { bare: pathExclusions(roads) });
 * const fire = FireFront.attach(engine, { ground: (x, z) => world.heightAt(x, z), fuel: map.at, ignitions: [{ at: [0, 0] }] });
 */
export function fuelMap(world: BiomeWorld, options: FuelMapOptions = {}): FuelMap {
  if (!options || typeof options !== 'object') throw typeError('fuelMap options must be an object', 'biomes');
  const { step = FUEL_STEP, timber = 0.3, rockSlope = 50, water = 2, bare = [], patches = [], models } = options,
    fit = step / world.resolution; // float division: option check
  if (!(step > 0) || Math.round(fit) !== fit)
    throw rangeError('fuelMap step must be a positive multiple of the world resolution', 'biomes');
  if (!(timber >= 0 && timber <= 1)) throw rangeError('fuelMap timber must be a share of the ground, 0..1', 'biomes');
  if (!(rockSlope >= 20 && rockSlope <= 89)) throw rangeError('fuelMap rockSlope must be degrees, 20..89', 'biomes');
  if (!(water >= 0 && water <= 100)) throw rangeError('fuelMap water must be metres, 0..100', 'biomes');
  if (!Array.isArray(bare)) throw typeError('fuelMap bare must be an array of exclusion shapes', 'biomes');
  if (!Array.isArray(patches)) throw typeError('fuelMap patches must be an array of shapes with a fuel', 'biomes');
  for (const b of bare) checkShape(b, 'bare');
  for (const p of patches) {
    checkShape(p, 'patches');
    if (p.fuel !== null && typeof p.fuel !== 'string')
      throw typeError('A fuelMap patch fuel is a fuel model name or null', 'biomes');
  }
  const names: string[] = [],
    index = (name: string): number => {
      if (models && !Object.hasOwn(models, name))
        throw rangeError(
          `fuelMap: unknown fuel model "${name}"; give one of ${Object.keys(models).join(', ')}`,
          'biomes',
        );
      let i = names.indexOf(name);
      if (i < 0) i = names.push(name) - 1;
      return i;
    },
    plan = new Map<string, Plan>();
  for (const b of world.biomes) {
    const plants: Plant[] = [];
    for (const rule of b.plants ?? [])
      if (rule.fuel && rule.density > 0) {
        const stands = standsOf(rule);
        plants.push({
          fuel: index(rule.fuel),
          share:
            (rule.density / 10000) * // float division: per hectare to per square metre
            Math.PI *
            rule.radius ** 2 *
            meanCrownArea(rule) *
            (stands ? stands.boost / ONE : 1), // float division: Q16
          stands,
          dims: Object.entries(rule.suitability ?? {}).map(([f, range]) => fieldDimension(f, range!, 0.15)),
        });
      }
    const open = b.openFuel ? index(b.openFuel) : -1;
    if (plants.length || open >= 0) plan.set(b.id, { plants, open });
  }
  const shapes = [
    ...bare.map((shape) => ({ shape, fuel: -1 })),
    ...patches.map((p) => ({ shape: p as Exclusion, fuel: p.fuel === null ? -1 : index(p.fuel) })),
  ];
  if (names.length > 255) throw rangeError('fuelMap holds at most 255 different fuel models', 'biomes');
  const [x0, z0, x1, z1] = world.bounds,
    width = Math.floor((x1 - x0) / step) + 1, // float division: whole cells
    depth = Math.floor((z1 - z0) / step) + 1, // float division
    data = new Uint8Array(width * depth),
    cover = new Uint8Array(width * depth),
    rock = fieldDimension('slope', [null, rockSlope]).hi,
    score = new Float64Array(names.length),
    open = new Float64Array(names.length),
    scratch = new Float64Array(Math.max(1, ...[...plan.values()].map((p) => p.plants.length)));
  let s: BiomeSample | undefined;
  if (plan.size)
    for (let j = 0; j < depth; j++)
      for (let i = 0; i < width; i++) {
        const x = x0 + i * step,
          z = z0 + j * step;
        s = world.sampleRegion(Math.min(x, x1 - world.resolution), Math.min(z, z1 - world.resolution), s);
        const k = j * width + i;
        if (s.height * 1000 < world.climate.sea) continue;
        score.fill(0);
        open.fill(0);
        const tx = Math.round((x - x0) * TICK),
          tz = Math.round((z - z0) * TICK);
        let crown = 0;
        for (let b = 0; b < s.biomes.length; b++) {
          const p = plan.get(s.biomes[b]);
          if (!p) continue;
          const weight = s.weights[b],
            mine = scratch;
          let fill = 0;
          for (let q = 0; q < p.plants.length; q++) {
            const t = p.plants[q];
            let share = t.share;
            if (t.stands) share *= standAt(world.seed, t.stands, tx, tz) / ONE; // float division: Q16
            for (const d of t.dims) {
              if (!share) break;
              const v = stored(s, d.layer),
                dist = Math.max(d.lo - v, v - d.hi),
                at = Math.round(((dist + d.width / 2) / d.width) * ONE); // float division: view only
              share *= wendland(Math.max(0, Math.min(ONE, at))) / ONE; // float division: Q16
            }
            mine[q] = share;
            fill += share;
          }
          const cap = fill > 1 ? 1 / fill : 1; // float division: crowns overlap
          crown += Math.min(1, fill) * weight;
          for (let q = 0; q < p.plants.length; q++) score[p.plants[q].fuel] += mine[q] * cap * weight;
          if (p.open >= 0) open[p.open] += weight;
        }
        cover[k] = Math.round(Math.min(1, crown) * 255);
        // Bare rock and water carry no fuel.
        if (stored(s, 'slope') > rock || s.waterDistance < water) continue;
        const pick = (from: Float64Array): number => {
          let best = -1,
            top = 0;
          for (let f = 0; f < from.length; f++) if (from[f] > top) [best, top] = [f, from[f]];
          return best;
        };
        let f = crown >= timber ? pick(score) : pick(open);
        if (f < 0) f = crown >= timber ? pick(open) : crown > 0 ? pick(score) : -1;
        data[k] = f + 1;
      }
  // Shapes, in order, over the corners in their boxes.
  const reach = step / 2; // float division: half a step
  for (const { shape, fuel } of shapes) {
    let lx = Infinity,
      lz = Infinity,
      hx = -Infinity,
      hz = -Infinity;
    for (const [px, pz] of shape.points) {
      lx = Math.min(lx, px);
      lz = Math.min(lz, pz);
      hx = Math.max(hx, px);
      hz = Math.max(hz, pz);
    }
    const slack = (shape.kind === 'line' ? shape.width / 2 : 0) + reach, // float division: half width
      i0 = Math.max(0, Math.ceil((lx - slack - x0) / step)), // float division: metres to corners
      i1 = Math.min(width - 1, Math.floor((hx + slack - x0) / step)), // float division
      j0 = Math.max(0, Math.ceil((lz - slack - z0) / step)), // float division
      j1 = Math.min(depth - 1, Math.floor((hz + slack - z0) / step)); // float division
    for (let j = j0; j <= j1; j++)
      for (let i = i0; i <= i1; i++)
        if (covers(shape, x0 + i * step, z0 + j * step, reach)) data[j * width + i] = fuel + 1;
  }
  const at = (x: number, z: number): string | null => {
    const i = Math.round((x - x0) / step), // float division: metres to corners
      j = Math.round((z - z0) / step); // float division
    if (!(i >= 0 && i < width && j >= 0 && j < depth)) return null;
    const v = data[j * width + i];
    return v ? names[v - 1] : null;
  };
  return { width, depth, step, origin: [x0, z0], names: Object.freeze(names), data, cover, at };
}
