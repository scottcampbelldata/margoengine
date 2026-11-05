// The multi-noise classifier, an optional entry: `BiomeWorld.create({ classifier: multiNoise(spec) })` places each
// biome at points or boxes in a space whose axes are fields you choose (temperature, rainfall, any tile layer, or a
// painted `mask/<name>` raster holding your own noise) and gives a cell to the nearest one. Distances are integer
// squared sums over axes normalised to Q16, so the bytes are the same on every platform; an optional blend band turns
// the hard nearest-point border into a smooth ecotone with the same Wendland kernel envelopes use. Our own design,
// the textbook nearest-prototype rule (Euclidean distance to a point or box) plus the package's blend kernel.
// It lives in its own entry rather than in /zones: /zones carries the Whittaker table, the Holdridge lattice and the
// degree-day code, none of which this needs, and this one is useful with no climate at all.
import { type ZoneClassifier } from './classify.js';
import { dimension } from './define.js';
import { clampInt, divFloor, ONE, qsqrt, wendland } from './fixed.js';
import { rangeError, typeError } from '../../shared/errors.js';

export type { ZoneClassifier } from './classify.js';

/** One axis of the space: a field, the range it is measured over, and how much it counts. */
export interface NoiseAxis {
  /**
   * A `ClimateEnvelope` field name (`temperature`, `rainfall`, `moisture`, `height`, ...), a `LAYERS` name, or a user
   * raster `mask/<name>` (0..1) holding noise you wrote with `world.writeLayer` or the editor.
   */
  readonly field: string;
  /** `[min, max]` in the field's plain units: the span a distance of 1 covers. Values outside it count as its edge. */
  readonly range: readonly [min: number, max: number];
  /** How much a gap on this axis counts, an integer from 1 to 16. Default 1. */
  readonly weight?: number;
}

/** A coordinate on an axis: a number (a point) or `[min, max]` (a box side: no gap while the cell is inside it). */
export type AxisPosition = number | readonly [min: number, max: number];

/**
 * Where one biome sits. A biome may have several points (an archipelago in the space). An axis left out of `at` does
 * not count for this point.
 */
export interface NoisePoint {
  /** The id of a biome of the world. */
  readonly biome: string;
  /** Position per axis field. */
  readonly at: Readonly<Record<string, AxisPosition>>;
}

/** What {@link multiNoise} takes. */
export interface MultiNoiseSpec {
  readonly axes: readonly NoiseAxis[];
  readonly points: readonly NoisePoint[];
  /**
   * Width of the smooth border, as a distance in axis spans (0..1; weights multiply gaps first): a biome whose
   * distance is within `blend` of the nearest one takes a share that falls to nothing at `blend`. 0 gives the plain
   * nearest point. Default 0.1.
   */
  readonly blend?: number;
}

const MAX_AXES = 8,
  MAX_POINTS = 1024;

const isPosition = (v: unknown) =>
  (typeof v === 'number' && Number.isFinite(v)) ||
  (Array.isArray(v) && v.length === 2 && v.every((n) => typeof n === 'number' && Number.isFinite(n)) && v[0] <= v[1]);

/** A deep, JSON-clean copy: it crosses to workers and into saved worlds as it is. */
const freezeCopy = <T>(spec: T): T => {
  const walk = (v: unknown): void => {
    if (v && typeof v === 'object') {
      Object.values(v).forEach(walk);
      Object.freeze(v);
    }
  };
  const copy = JSON.parse(JSON.stringify(spec)) as T;
  walk(copy);
  return copy;
};

/**
 * Builds the multi-noise classifier for a spec: each cell goes to the biome whose nearest point or box is closest in
 * the weighted, normalised axis space (ties by priority, then id), with a smooth border over `blend`. Integer only.
 * @throws TypeError for a spec of the wrong shape; RangeError for an unknown field, a value out of range, an axis
 * range with min not below max, a repeated axis, no points or too many, or a point outside its axis range.
 * @example
 * const world = await BiomeWorld.create({
 *   biomes: [temperate, desert],
 *   classifier: multiNoise({
 *     axes: [{ field: 'temperature', range: [-10, 35] }, { field: 'rainfall', range: [0, 3000] }],
 *     points: [{ biome: 'temperate', at: { temperature: 10, rainfall: 1100 } }, { biome: 'desert', at: { temperature: 28, rainfall: 100 } }],
 *   }),
 * });
 */
export function multiNoise(spec: MultiNoiseSpec): ZoneClassifier {
  if (!spec || typeof spec !== 'object' || !Array.isArray(spec.axes) || !Array.isArray(spec.points))
    throw typeError('multiNoise takes { axes, points, blend? } with arrays of axes and points', 'biomes');
  const { axes, points } = spec,
    blend = spec.blend ?? 0.1;
  if (!(typeof blend === 'number' && blend >= 0 && blend <= 1))
    throw rangeError('multiNoise blend is a number from 0 to 1', 'biomes');
  if (axes.length < 1 || axes.length > MAX_AXES)
    throw rangeError('multiNoise takes 1 to 8 axes { field, range: [min, max], weight? }', 'biomes');
  if (points.length < 1 || points.length > MAX_POINTS)
    throw rangeError('multiNoise takes 1 to 1,024 points { biome, at }', 'biomes');
  // Per axis: the layer it reads, the stored value of the range start and its span, and the squared weight.
  const read = axes.map((a) => {
    if (!a || typeof a !== 'object' || typeof a.field !== 'string' || !Array.isArray(a.range) || a.range.length !== 2)
      throw typeError('multiNoise axes are { field, range: [min, max], weight? }', 'biomes');
    const [min, max] = a.range;
    if (!(Number.isFinite(min) && Number.isFinite(max) && min < max))
      throw rangeError('multiNoise axis range is [min, max] with min below max', 'biomes');
    const d = dimension(a.field, [min, max], 0.15), // throws for an unknown field
      weight = a.weight ?? 1;
    if (!(Number.isInteger(weight) && weight >= 1 && weight <= 16))
      throw rangeError('multiNoise axis weight is an integer from 1 to 16', 'biomes');
    if (d.hi <= d.lo) throw rangeError('multiNoise axis range is too narrow for the field resolution', 'biomes');
    return { field: a.field, layer: d.layer, lo: d.lo, span: d.hi - d.lo, weight };
  });
  if (new Set(read.map((a) => a.field)).size !== read.length)
    throw rangeError('multiNoise axis fields must all be different', 'biomes');
  // Per point: its biome id and, per axis, the normalised [lo, hi] (Q16) or null for an axis it ignores.
  const placed = points.map((p) => {
    if (!p || typeof p !== 'object' || typeof p.biome !== 'string' || !p.at || typeof p.at !== 'object')
      throw typeError('multiNoise points are { biome, at } with a biome id and positions per axis field', 'biomes');
    for (const key of Object.keys(p.at))
      if (!read.some((a) => a.field === key)) throw rangeError('multiNoise point names a field that is not an axis', 'biomes');
    const box = read.map((a, i) => {
      const v = p.at[a.field];
      if (v === undefined) return null;
      if (!isPosition(v)) throw rangeError('multiNoise point positions are a number or [min, max]', 'biomes');
      const [min, max] = typeof v === 'number' ? [v, v] : v,
        d = dimension(a.field, [min, max], 0.15),
        lo = divFloor((d.lo - a.lo) * ONE, a.span),
        hi = divFloor((d.hi - a.lo) * ONE, a.span);
      if (lo < 0 || hi > ONE) throw rangeError('multiNoise point positions must lie inside the axis range', 'biomes');
      return [lo, hi] as const;
    });
    return { biome: p.biome, box };
  });
  const copy = freezeCopy(spec),
    band = Math.round(blend * ONE),
    inputs = Object.freeze(read.map((a) => a.layer));
  return Object.freeze<ZoneClassifier>({
    kind: 'multinoise',
    perCell: true,
    inputs,
    spec: copy,
    scorer(biomes, slotOf) {
      const count = biomes.length,
        ids = biomes.map((b) => b.id),
        axesCount = read.length,
        slots = read.map((a) => slotOf(a.layer)),
        weight2 = Float64Array.from(read, (a) => a.weight * a.weight),
        total = placed.length,
        owner = new Int32Array(total),
        lo = new Int32Array(total * axesCount),
        hi = new Int32Array(total * axesCount),
        // Tie order, as the classifier ranks biomes: higher priority first, then id.
        order = ids
          .map((_, i) => i)
          .sort(
            (a, b) =>
              (biomes[b].priority ?? 0) - (biomes[a].priority ?? 0) || (ids[a] < ids[b] ? -1 : ids[a] > ids[b] ? 1 : 0),
          ),
        // The points of each biome, in rank order of their biomes.
        byBiome: number[][] = ids.map(() => []);
      placed.forEach((p, q) => {
        const b = ids.indexOf(p.biome);
        if (b < 0) throw rangeError('multiNoise names a biome the world does not have; add it to BiomeWorld biomes', 'biomes');
        owner[q] = b;
        byBiome[b].push(q);
        p.box.forEach((e, a) => {
          lo[q * axesCount + a] = e ? e[0] : -1;
          hi[q * axesCount + a] = e ? e[1] : -1;
        });
      });
      const active = order.filter((b) => byBiome[b].length > 0);
      return (warped, cells, member) => {
        const u = new Int32Array(axesCount),
          dist = new Float64Array(count);
        for (let k = 0; k < cells; k++) {
          for (let a = 0; a < axesCount; a++)
            u[a] = clampInt(divFloor((warped[slots[a] * cells + k] - read[a].lo) * ONE, read[a].span), 0, ONE);
          // Squared distance of each biome to its nearest point or box: exact integers (at most 16^2 x 8 x 2^32).
          let best = -1;
          for (const b of active) {
            let near = Infinity;
            for (const q of byBiome[b]) {
              let sum = 0;
              for (let a = 0; a < axesCount; a++) {
                const l = lo[q * axesCount + a];
                if (l < 0) continue;
                const gap = Math.max(l - u[a], u[a] - hi[q * axesCount + a], 0);
                sum += weight2[a] * gap * gap;
              }
              if (sum < near) near = sum;
            }
            dist[b] = near;
            if (best < 0 || near < dist[best]) best = b;
          }
          if (!band) {
            member[best * cells + k] = ONE;
            continue;
          }
          const first = qsqrt(Math.floor(dist[best] / ONE));
          for (const b of active) {
            const r = clampInt(divFloor((qsqrt(Math.floor(dist[b] / ONE)) - first) * ONE, band), 0, ONE),
              w = wendland(r);
            if (w) member[b * cells + k] = Math.min(ONE, member[b * cells + k] + w);
          }
        }
      };
    },
  });
}

/**
 * Ready specs for the preset biomes (`presets` from `@margoengine/biomes/presets`; `beach` has no point): `climate`
 * places eight biomes on mean annual temperature and rainfall, `relief` on height and soil moisture. Plain data to use
 * as they are or to spread into a spec with your own points and blend.
 * @example
 * const world = await BiomeWorld.create({ biomes: Object.values(presets), classifier: multiNoise(multiNoisePresets.climate) });
 */
export const multiNoisePresets: Readonly<Record<'climate' | 'relief', MultiNoiseSpec>> = freezeCopy({
  climate: {
    axes: [
      { field: 'temperature', range: [-20, 32] },
      { field: 'rainfall', range: [0, 3200] },
    ],
    points: [
      { biome: 'tundra', at: { temperature: -12, rainfall: 350 } },
      { biome: 'boreal', at: { temperature: -1, rainfall: 650 } },
      { biome: 'alpine', at: { temperature: -6, rainfall: 1700 } },
      { biome: 'temperate', at: { temperature: 10, rainfall: 1100 } },
      { biome: 'wetland', at: { temperature: 8, rainfall: 2600 } },
      { biome: 'desert', at: { temperature: 26, rainfall: 120 } },
      { biome: 'savanna', at: { temperature: 25, rainfall: 900 } },
      { biome: 'tropical', at: { temperature: 26, rainfall: 2700 } },
    ],
  },
  relief: {
    axes: [
      { field: 'height', range: [0, 3200] },
      { field: 'moisture', range: [0, 1] },
    ],
    points: [
      { biome: 'wetland', at: { height: 20, moisture: 0.95 } },
      { biome: 'tropical', at: { height: 100, moisture: 0.8 } },
      { biome: 'savanna', at: { height: 200, moisture: 0.25 } },
      { biome: 'desert', at: { height: 400, moisture: 0.05 } },
      { biome: 'temperate', at: { height: 300, moisture: 0.5 } },
      { biome: 'boreal', at: { height: 1100, moisture: 0.5 } },
      { biome: 'alpine', at: { height: 2300, moisture: 0.4 } },
      { biome: 'tundra', at: { height: 2900, moisture: 0.2 } },
    ],
  },
} satisfies Record<'climate' | 'relief', MultiNoiseSpec>);
