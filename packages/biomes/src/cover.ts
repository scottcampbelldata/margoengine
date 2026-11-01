// Canopy cover of a biome world (biome look plan 3, B3): how much of the ground the crowns of its trees fill, by tree
// kind, from the region fields alone, so it answers for the whole world without placing a tree. A view darkens the
// ground under forest with it and draws the far forest from it (trees beyond the stored-object radius).
import { divFloor, ONE, wendland } from '@margoengine/biomes/toolkit';
import { rangeError } from '../../shared/errors.js';
import { type BiomeDefinition, type Dimension, fieldDimension, type SpeciesRule } from './define.js';
import { STRATA } from './reach.js';
import type { BiomeSample } from './sample.js';
import { standAt, standsOf, type Stands, TICK } from './stands.js';
import type { BiomeWorld } from './world.js';
import type { OverviewCorner, ViewTile } from './view.js';

/** The kinds of far tree a view draws: every tree is drawn as the nearest of these. */
export const CANOPY_KINDS = Object.freeze(['broadleaf', 'conifer', 'palm'] as const);

/** Metres per cell of {@link canopyCover} unless asked otherwise: the world's region grid, whatever its tiles. */
export const COVER_STEP = 16;

/** A world-wide cover raster: `width` x `depth` corners `step` metres apart from the world's low corner, 0..255. */
export interface CanopyCover {
  readonly width: number;
  readonly depth: number;
  readonly step: number;
  /** Crown cover of all trees, rows of increasing z. */
  readonly data: Uint8Array;
  /** Each kind's share of `data` by {@link CANOPY_KINDS} index, 0..255 of the ground, same layout. */
  readonly kinds: readonly Uint8Array[];
}

const TREE_MESHES = new Set(['broadleaf', 'conifer', 'palm', 'birch', 'acacia', 'snag']);
const meshName = (rule: SpeciesRule) => (rule.mesh.startsWith('procedural:') ? rule.mesh.slice(11) : rule.mesh);

/** Whether a plant counts as a tree of the canopy: a tree mesh, or any crown of canopy size. */
const isTree = (rule: SpeciesRule) => TREE_MESHES.has(meshName(rule)) || STRATA(rule.radius) === 1;

/** The far kind a tree is drawn as: its {@link CANOPY_KINDS} index. */
const kindOf = (rule: SpeciesRule) => {
  const name = meshName(rule);
  return name === 'conifer' ? 1 : name === 'palm' ? 2 : 0;
};

/**
 * The mean square of a species' crown multiplier: crowns grow as size^0.75 (`SizeDistribution`), so the mean over the
 * size distribution of size^1.5, by 64 midpoints of its inverse CDF. Display maths, floats.
 */
function meanCrownArea(rule: SpeciesRule): number {
  const s = rule.size;
  if (!s) return 1;
  let sum = 0;
  if (s.kind === 'reverse-j') {
    const top = s.max ** (4 / 3), // float division: option maths
      low = top / 10, // float division
      rate = 10 * Math.log(s.q),
      reach = 1 - Math.exp(-rate * (top - low));
    for (let i = 0; i < 64; i++) sum += (low - Math.log(1 - ((i + 0.5) / 64) * reach) / rate) ** 1.5; // float division
  } else
    for (let i = 0; i < 64; i++)
      sum += Math.min(3 * s.scale, s.scale * (-Math.log(1 - (i + 0.5) / 64)) ** (1 / s.shape)) ** 1.5; // float division
  return sum / 64; // float division
}

type Tree = {
  /** Share of the ground its crowns fill at full suitability, inside a stand if it has stands. */
  readonly share: number;
  readonly kind: number;
  readonly stands?: Stands;
  readonly dims: readonly Dimension[];
};

/** What cover reads of a biome list: the trees of each biome, by biome id. */
export type CoverPlan = ReadonlyMap<string, readonly Tree[]>;

/** The trees of each biome (biomes without trees are left out, so an empty plan means no cover anywhere). */
export function coverPlan(biomes: readonly BiomeDefinition[]): CoverPlan {
  const plan = new Map<string, Tree[]>();
  for (const b of biomes) {
    const trees: Tree[] = [];
    for (const rule of b.plants ?? [])
      if (rule.density > 0 && isTree(rule)) {
        const stands = standsOf(rule);
        trees.push({
          share:
            (rule.density / 10000) * // float division: per hectare to per square metre
            Math.PI *
            rule.radius ** 2 *
            meanCrownArea(rule) *
            (stands ? stands.boost / ONE : 1), // float division: Q16
          kind: kindOf(rule),
          stands,
          dims: Object.entries(rule.suitability ?? {}).map(([f, range]) => fieldDimension(f, range!, 0.15)),
        });
      }
    if (trees.length) plan.set(b.id, trees);
  }
  return plan;
}

/** A region sample's value of a suitability field, in the units of a tile layer (`Dimension`). */
function stored(s: BiomeSample, layer: string): number {
  switch (layer) {
    case 'temperature':
      return s.temperature * 100;
    case 'rainfall':
      return s.rainfall;
    case 'moisture':
      return s.moisture * 255;
    case 'slope':
      return s.slope * 256;
    case 'height':
      return s.height * 1000;
    default:
      return s.waterDistance * 10;
  }
}

/**
 * Crown cover at a sampled point: for each of its biomes, by weight, the crowns of the biome's trees that can stand
 * there (none below sea level, as placement), filling the ground at most once. `kinds`, when given, receives each
 * kind's part of the result. Returns 0..1.
 */
export function coverAt(
  plan: CoverPlan,
  world: BiomeWorld,
  s: BiomeSample,
  x: number,
  z: number,
  kinds?: Float64Array,
): number {
  kinds?.fill(0);
  if (!plan.size || s.height * 1000 < world.climate.sea) return 0;
  const tx = Math.round((x - world.bounds[0]) * TICK),
    tz = Math.round((z - world.bounds[1]) * TICK);
  let total = 0;
  for (let b = 0; b < s.biomes.length; b++) {
    const trees = plan.get(s.biomes[b]);
    if (!trees) continue;
    let fill = 0;
    for (const t of trees) {
      let share = t.share;
      if (t.stands) share *= standAt(world.seed, t.stands, tx, tz) / ONE; // float division: Q16
      for (const d of t.dims) {
        if (!share) break;
        const v = stored(s, d.layer),
          dist = Math.max(d.lo - v, v - d.hi),
          at = Math.round(((dist + d.width / 2) / d.width) * ONE); // float division: view only
        share *= wendland(Math.max(0, Math.min(ONE, at))) / ONE; // float division: Q16
      }
      fill += share;
    }
    // Over one means crowns overlap: the ground is full, and the kinds keep their proportions.
    const cap = fill > 1 ? 1 / fill : 1, // float division
      weight = s.weights[b];
    total += Math.min(1, fill) * weight;
    if (kinds)
      for (const t of trees) {
        let share = t.share * cap * weight;
        if (t.stands) share *= standAt(world.seed, t.stands, tx, tz) / ONE; // float division: Q16
        for (const d of t.dims) {
          const v = stored(s, d.layer),
            dist = Math.max(d.lo - v, v - d.hi);
          share *= wendland(Math.max(0, Math.min(ONE, Math.round(((dist + d.width / 2) / d.width) * ONE)))) / ONE; // float division: Q16
        }
        kinds[t.kind] += share;
      }
  }
  return Math.min(1, total);
}

/**
 * How much of the ground tree crowns fill, over the whole world, from the region fields: per grid corner, each of its
 * biomes by weight, each tree's density x crown area x mean crown size squared (stands and suitability included),
 * capped at full ground. No tree is placed and no tile is made. A temperate world reads 255, a desert 0.
 * @param world The world.
 * @param step Metres between corners, a positive multiple of the world resolution. Default 16.
 * @throws RangeError for a `step` that is not a positive multiple of the world resolution.
 */
export function canopyCover(world: BiomeWorld, step = COVER_STEP): CanopyCover {
  const fit = step / world.resolution; // float division: option check
  if (!(step > 0) || Math.round(fit) !== fit)
    throw rangeError('canopyCover step must be a positive multiple of the world resolution', 'biomes');
  const [x0, z0, x1, z1] = world.bounds,
    width = Math.floor((x1 - x0) / step) + 1, // float division: whole cells
    depth = Math.floor((z1 - z0) / step) + 1, // float division
    data = new Uint8Array(width * depth),
    kinds = CANOPY_KINDS.map(() => new Uint8Array(width * depth)),
    plan = coverPlan(world.biomes),
    part = new Float64Array(CANOPY_KINDS.length);
  let s: BiomeSample | undefined;
  if (plan.size)
    for (let j = 0; j < depth; j++)
      for (let i = 0; i < width; i++) {
        const x = x0 + i * step,
          z = z0 + j * step;
        s = world.sampleRegion(Math.min(x, x1 - world.resolution), Math.min(z, z1 - world.resolution), s);
        const k = j * width + i;
        data[k] = Math.round(coverAt(plan, world, s, x, z, part) * 255);
        for (let q = 0; q < kinds.length; q++) kinds[q][k] = Math.round(Math.min(1, part[q]) * 255);
      }
  return { width, depth, step, data, kinds };
}

/**
 * The share of the ground a view's canopy material takes under full crowns: `canopy`, or 0 for a world with no trees
 * or no free ground layer (16 materials), which keeps its materials as they are.
 * @throws RangeError when `canopy` is not a number from 0 to 1.
 */
export function canopyShare(world: BiomeWorld, canopy: number): number {
  if (!(canopy >= 0 && canopy <= 1))
    throw rangeError('BiomeView canopy must be a number from 0 to 1 (default 0.6 with objects, 0 without)', 'biomes');
  const keys = new Set(world.biomes.flatMap((b) => b.ground.map((g) => g.material)));
  return keys.size < 16 && coverPlan(world.biomes).size ? canopy : 0;
}

/**
 * Gives the canopy material `cover` (0..255) of a texel's 255: the `index` others keep their proportions, rounded down,
 * and the canopy, material `index`, takes what is left, so the texel still sums to 255.
 */
function darken(
  cover: number,
  index: number,
  read: (m: number) => number,
  write: (m: number, v: number) => void,
): void {
  const keep = 255 - cover;
  let given = 0;
  for (let m = 0; m < index; m++) {
    const v = divFloor(read(m) * keep, 255);
    write(m, v);
    given += v;
  }
  write(index, 255 - given);
}

/**
 * The overview's darkening (`overviewWeights` `corner`): each grid corner's last material, the canopy, takes `canopy`
 * times the crown cover there.
 */
export function canopyCorners(world: BiomeWorld, materials: readonly string[], canopy: number): OverviewCorner {
  const plan = coverPlan(world.biomes),
    index = materials.length - 1;
  return (s, x, z, weights, at) =>
    darken(
      Math.round(coverAt(plan, world, s, x, z) * canopy * 255),
      index,
      (m) => weights[at + m],
      (m, v) => {
        weights[at + m] = v;
      },
    );
}

/**
 * Darkens a view tile's weight textures under tree crowns: the cover at the grid corners over the tile (the same corners
 * as the overview, so a tile matches the far ground it replaces), bilinear to the texels. The last of `materials` is the
 * canopy.
 */
export function darkenTile(
  world: BiomeWorld,
  tile: ViewTile,
  step: number,
  materials: readonly string[],
  canopy: number,
): void {
  const n = divFloor(world.tileSize, COVER_STEP) + 1,
    corners = new Float64Array(n * n),
    plan = coverPlan(world.biomes),
    index = materials.length - 1,
    textures = tile.weights,
    count = tile.count,
    x0 = world.bounds[0] + tile.x * world.tileSize,
    z0 = world.bounds[1] + tile.z * world.tileSize,
    texel = step * world.resolution;
  let s: BiomeSample | undefined;
  for (let j = 0; j < n; j++)
    for (let i = 0; i < n; i++) {
      const x = x0 + i * COVER_STEP,
        z = z0 + j * COVER_STEP;
      // The corners on the world's far edge read the last cell inside it.
      s = world.sampleRegion(
        Math.min(x, world.bounds[2] - world.resolution),
        Math.min(z, world.bounds[3] - world.resolution),
        s,
      );
      corners[j * n + i] = coverAt(plan, world, s, x, z);
    }
  for (let v = 0; v < count; v++) {
    const fz = Math.min(n - 1.001, (v * texel) / COVER_STEP), // float division: view only
      iz = Math.floor(fz),
      tz = fz - iz;
    for (let u = 0; u < count; u++) {
      const fx = Math.min(n - 1.001, (u * texel) / COVER_STEP), // float division: view only
        ix = Math.floor(fx),
        tx = fx - ix,
        a = corners[iz * n + ix],
        b = corners[iz * n + ix + 1],
        c = corners[(iz + 1) * n + ix],
        d = corners[(iz + 1) * n + ix + 1],
        top = a + (b - a) * tx,
        t = (v * count + u) * 4;
      darken(
        Math.round((top + (c + (d - c) * tx - top) * tz) * canopy * 255),
        index,
        (m) => textures[m >> 2][t + (m & 3)],
        (m, w) => {
          textures[m >> 2][t + (m & 3)] = w;
        },
      );
    }
  }
}
