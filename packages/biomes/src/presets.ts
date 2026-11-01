// The eight climate biome presets (spec 3.2), as plant functional type limits over the coldest month, growing degree days above
// 5 C and the moisture index AET / PET, with Korner's thermal treeline for forests (spec 2.3). The limits follow the
// BIOME1 and BIOME4 style of screening (Prentice et al. 1992; Kaplan et al. 2003): tropical trees need a coldest month
// of about 15.5 C, temperate broadleaf trees about 1,200 degree days, boreal conifers about 350 (background values from
// that literature, rounded; the per-preset numbers are ours). Meshes are the procedural ones (decision D5).
// Plain data: the presets are frozen here and checked with defineBiome by the package tests, so this entry carries no
// validation code (a world validates every definition it is given, presets included). `beach` is not a climate preset:
// it takes low, gentle ground by the sea in any world (height and slope envelopes; the island world uses it).
import type { ClimateOptions } from './climate.js';
import type { BiomeDefinition, SpeciesRule } from './define.js';
import type { ReliefOptions } from './relief.js';

export { R16 } from './r16.js';

/** Deep-freezes plain data. */
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const v of Object.values(value)) freeze(v);
    Object.freeze(value);
  }
  return value;
}

// Woody plants keep above the shore's 3 m and out of the rivers, whose water a view can stand 48 m each side of the line.
const dryLand = { height: [3, null], waterDistance: [50, null] } as const;
// Stands of a forest tree: 70 percent of the land in clumps at 300 m, clearings between them.
const stands = { scale: 300, cover: 0.7 } as const;

const tree = (
  id: string,
  mesh: string,
  density: number,
  radius: number,
  shade: number,
  forest = true,
): SpeciesRule => ({
  id,
  mesh: `procedural:${mesh}`,
  density,
  radius,
  shade,
  suitability: dryLand,
  ...(forest ? { stands } : {}),
  size: { kind: 'reverse-j', q: 1.4, max: forest ? 2.4 : 1.6 },
  // Half the stems in fat-tailed 2Dt clusters (seed shadows with scattered outliers, Clark et al. 1999), half at random.
  cluster: { kind: '2dt', parents: 3, spread: 10, offspring: density / 6 },
});
const shrub = (id: string, mesh: string, density: number, radius: number): SpeciesRule => ({
  id,
  mesh: `procedural:${mesh}`,
  density,
  radius,
  shade: 0.6,
  suitability: dryLand,
});
const rock = (density: number): SpeciesRule => ({
  id: 'boulder',
  mesh: 'procedural:rock',
  density,
  radius: 1.2,
  suitability: { slope: [12, null] },
  cluster: { kind: 'matern', parents: 1, spread: 8, offspring: 5 },
});

/** Ids of the eight climate presets, each with its own world in {@link presetWorlds}. */
export type ClimatePresetId =
  | 'temperate'
  | 'desert'
  | 'tundra'
  | 'tropical'
  | 'alpine'
  | 'wetland'
  | 'savanna'
  | 'boreal';

/** Ids of every preset: the climate presets and `beach`, low gentle ground by the sea that any world can add. */
export type PresetId = ClimatePresetId | 'beach';

/** The presets, by id. Each is a frozen {@link BiomeDefinition}. */
export const presets: Readonly<Record<PresetId, BiomeDefinition>> = Object.freeze({
  temperate: freeze<BiomeDefinition>({
    id: 'temperate',
    climate: { coldest: [-15, 8], gdd5: [1200, null], moistureIndex: [0.6, null], treeline: [0, null] },
    zones: ['temperate-seasonal-forest', 'cool-temperate-humid', 'cool-temperate-subhumid', 'warm-temperate-humid'],
    ground: [
      { material: 'grass', slope: [null, 22] },
      { material: 'leaf-litter', moisture: [0.6, null] },
      { material: 'rock', slope: [30, null] },
    ],
    plants: [
      tree('oak', 'broadleaf', 180, 4.5, 0.4),
      tree('beech', 'broadleaf', 140, 4, 0.8),
      shrub('hazel', 'shrub', 400, 1.2),
    ],
    rocks: [rock(6)],
    details: [
      { id: 'grass', mesh: 'procedural:grass', density: 40, light: [0.3, 1] },
      { id: 'fern', mesh: 'procedural:fern', density: 4, light: [0, 0.5] },
    ],
  }),
  boreal: freeze<BiomeDefinition>({
    id: 'boreal',
    climate: { gdd5: [350, 1200], moistureIndex: [0.45, null], treeline: [0, null] },
    zones: ['boreal-forest', 'boreal-humid', 'boreal-perhumid', 'boreal-subhumid'],
    ground: [
      { material: 'needles' },
      { material: 'moss', moisture: [0.7, null] },
      { material: 'rock', slope: [32, null] },
    ],
    plants: [
      tree('spruce', 'conifer', 420, 2.2, 0.7),
      tree('pine', 'conifer', 160, 2.6, 0.3),
      shrub('blueberry', 'shrub', 900, 0.5),
    ],
    rocks: [rock(10)],
    details: [{ id: 'moss', mesh: 'procedural:grass', density: 20, light: [0, 0.6] }],
  }),
  alpine: freeze<BiomeDefinition>({
    id: 'alpine',
    climate: { treeline: [null, 0], coldest: [-15, null] },
    zones: ['tundra', 'subpolar-humid', 'subpolar-perhumid', 'subpolar-subhumid'],
    ground: [
      { material: 'meadow', slope: [null, 30] },
      // Talus: scree gathers in the hollows at the foot of the slopes, where the ground is concave.
      { material: 'scree', slope: [15, 40], curvature: [null, 0] },
      { material: 'rock', slope: [30, null] },
      // Snow outweighs the rock it lies on (weight 3: a quarter rock), so a snowy peak reads as snow, not grey.
      { material: 'snow', height: [2800, null], temperature: [null, -3], weight: 3 },
    ],
    plants: [shrub('dwarf-pine', 'shrub', 120, 1.5), shrub('heather', 'shrub', 600, 0.4)],
    rocks: [rock(40)],
    details: [{ id: 'alpine-grass', mesh: 'procedural:grass', density: 25 }],
  }),
  wetland: freeze<BiomeDefinition>({
    id: 'wetland',
    climate: { moisture: [0.8, null], slope: [null, 3], treeline: [0, null] },
    priority: 1,
    zones: ['temperate-rainforest', 'cool-temperate-perhumid', 'warm-temperate-perhumid'],
    ground: [{ material: 'mud' }, { material: 'moss', moisture: [0.9, null] }, { material: 'grass', slope: [2, null] }],
    plants: [tree('alder', 'broadleaf', 90, 3, 0.5), shrub('willow', 'shrub', 300, 1.5)],
    details: [{ id: 'reeds', mesh: 'procedural:grass', density: 60, blades: true }],
  }),
  tundra: freeze<BiomeDefinition>({
    id: 'tundra',
    climate: { treeline: [null, 0], coldest: [null, -15] },
    zones: ['tundra', 'polar-humid', 'polar-perhumid', 'polar-subhumid', 'subpolar-semiarid'],
    ground: [
      { material: 'tundra' },
      { material: 'gravel', slope: [10, null] },
      // Lying snow follows the cold (a mean annual temperature of -6 C or less), not soil moisture, which a 300 mm
      // rainfall tundra never reaches.
      { material: 'snow', temperature: [null, -6] },
    ],
    plants: [shrub('dwarf-birch', 'tundra-shrub', 300, 0.6)],
    rocks: [rock(25)],
    // Lichen is low ground cover drawn per frame, not 2,000 stored shrubs per hectare.
    details: [
      { id: 'sedge', mesh: 'procedural:grass', density: 15 },
      { id: 'lichen', mesh: 'procedural:grass', density: 10 },
    ],
  }),
  desert: freeze<BiomeDefinition>({
    id: 'desert',
    climate: { moistureIndex: [null, 0.2] },
    zones: [
      'subtropical-desert',
      'temperate-grassland-desert',
      'warm-temperate-arid',
      'tropical-arid',
      'warm-temperate-perarid',
      'tropical-perarid',
    ],
    ground: [
      { material: 'sand', slope: [null, 12] },
      { material: 'red-sand', moisture: [null, 0.15] },
      { material: 'rock', slope: [18, null] },
    ],
    plants: [shrub('creosote', 'shrub', 60, 0.8), { ...shrub('cactus', 'cactus', 15, 0.5), shade: 0 }],
    rocks: [rock(30)],
  }),
  savanna: freeze<BiomeDefinition>({
    id: 'savanna',
    climate: { moistureIndex: [0.2, 0.6], coldest: [8, null] },
    zones: ['tropical-seasonal-forest-savanna', 'woodland-shrubland', 'tropical-semiarid', 'warm-temperate-semiarid'],
    ground: [{ material: 'dry-grass' }, { material: 'laterite', slope: [10, null] }],
    plants: [
      {
        // Open woodland: no stands, and crowns already 5 m in radius (larger leaves the self-thinning band).
        ...tree('acacia', 'acacia', 25, 5, 0.1, false),
        cluster: { kind: 'matern', parents: 0.5, spread: 25, offspring: 4 },
      },
      shrub('thornbush', 'shrub', 80, 1.2),
    ],
    rocks: [rock(4)],
    details: [{ id: 'tall-grass', mesh: 'procedural:grass', density: 50, blades: true }],
  }),
  tropical: freeze<BiomeDefinition>({
    id: 'tropical',
    climate: { coldest: [15.5, null], moistureIndex: [0.6, null] },
    zones: ['tropical-rainforest', 'tropical-humid', 'tropical-perhumid', 'tropical-subhumid'],
    ground: [
      { material: 'leaf-litter' },
      { material: 'mud', moisture: [0.85, null] },
      { material: 'rock', slope: [35, null] },
    ],
    plants: [
      tree('kapok', 'broadleaf', 60, 7, 0.3),
      tree('palm', 'palm', 120, 3, 0.6),
      shrub('understory', 'shrub', 700, 1),
    ],
    rocks: [rock(3)],
    details: [{ id: 'fern', mesh: 'procedural:fern', density: 12, light: [0, 0.6] }],
  }),
  // A sand beach: low, gentle ground next to the sea, by height and slope envelopes instead of a climate.
  beach: freeze<BiomeDefinition>({
    id: 'beach',
    climate: { height: [null, 5], slope: [null, 12] },
    ground: [{ material: 'sand' }],
  }),
});

/** A preset world: climate and relief settings, and for a world made for several biomes their definitions. */
export interface PresetWorld {
  /** Climate settings. */
  readonly climate: ClimateOptions;
  /** Relief settings (`height: { relief }`). */
  readonly relief: ReliefOptions;
  /** The biomes the world is made for (frozen definitions, ready for `BiomeWorld.create`). */
  readonly biomes?: readonly BiomeDefinition[];
}

/** A preset kept off the lowest ground (below 4 m), so the beach takes the shore instead of sharing it. */
const inland = (b: BiomeDefinition): BiomeDefinition => freeze({ ...b, climate: { ...b.climate, height: [4, null] } });

/**
 * The world each climate preset dominates (climate and relief settings for examples, tests and golden digests), and
 * `island`: a tropical island with sea on every side (`coast: 'island'`) and its biomes: `tropical` and `temperate`
 * kept above 4 m, and `beach` on the shore.
 */
export const presetWorlds: Readonly<
  Record<ClimatePresetId, PresetWorld> & {
    readonly island: PresetWorld & { readonly biomes: readonly BiomeDefinition[] };
  }
> = Object.freeze({
  temperate: { climate: { latitude: 47, rainfall: 1000 }, relief: { relief: 500, base: 150 } },
  boreal: { climate: { latitude: 57, rainfall: 650, inland: 1200 }, relief: { relief: 400, base: 150 } },
  alpine: { climate: { latitude: 46, rainfall: 1400 }, relief: { relief: 2400, base: 2200 } },
  wetland: { climate: { latitude: 44, rainfall: 1300 }, relief: { relief: 20, base: 12, coast: 'west', rivers: 3 } },
  tundra: { climate: { latitude: 71, rainfall: 300, inland: 2000 }, relief: { relief: 200, base: 60 } },
  desert: { climate: { latitude: 24, rainfall: 80 }, relief: { relief: 600, base: 300 } },
  savanna: { climate: { latitude: 11, rainfall: 750 }, relief: { relief: 300, base: 400 } },
  tropical: { climate: { latitude: 3, rainfall: 2700 }, relief: { relief: 800, base: 120 } },
  island: {
    climate: { latitude: 9, rainfall: 2400 },
    relief: { coast: 'island' as const, relief: 330, base: 40 },
    biomes: [inland(presets.tropical), inland(presets.temperate), presets.beach],
  },
});
