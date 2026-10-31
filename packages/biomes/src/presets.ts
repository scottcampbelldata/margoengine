// The eight biome presets (spec 3.2), as plant functional type limits over the coldest month, growing degree days above
// 5 C and the moisture index AET / PET, with Korner's thermal treeline for forests (spec 2.3). The limits follow the
// BIOME1 and BIOME4 style of screening (Prentice et al. 1992; Kaplan et al. 2003): tropical trees need a coldest month
// of about 15.5 C, temperate broadleaf trees about 1,200 degree days, boreal conifers about 350 (background values from
// that literature, rounded; the per-preset numbers are ours). Meshes are the procedural ones (decision D5).
// Plain data: the presets are frozen here and checked with defineBiome by the package tests, so this entry carries no
// validation code (a world validates every definition it is given, presets included).
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

const tree = (id: string, mesh: string, density: number, radius: number, shade: number): SpeciesRule => ({
  id,
  mesh: `procedural:${mesh}`,
  density,
  radius,
  shade,
  size: { kind: 'reverse-j', q: 1.4, max: 1.6 },
  // Half the stems in fat-tailed 2Dt clusters (seed shadows with scattered outliers, Clark et al. 1999), half at random.
  cluster: { kind: '2dt', parents: 3, spread: 10, offspring: density / 6 },
});
const shrub = (id: string, mesh: string, density: number, radius: number): SpeciesRule => ({
  id,
  mesh: `procedural:${mesh}`,
  density,
  radius,
  shade: 0.6,
});
const rock = (density: number): SpeciesRule => ({
  id: 'boulder',
  mesh: 'procedural:rock',
  density,
  radius: 1.2,
  suitability: { slope: [12, null] },
  cluster: { kind: 'matern', parents: 1, spread: 8, offspring: 5 },
});

/** The presets, by id. Each is a frozen {@link BiomeDefinition}. */
export const presets: Readonly<
  Record<'temperate' | 'desert' | 'tundra' | 'tropical' | 'alpine' | 'wetland' | 'savanna' | 'boreal', BiomeDefinition>
> = Object.freeze({
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
      { material: 'meadow', slope: [null, 25] },
      { material: 'scree', slope: [25, 40] },
      { material: 'rock', slope: [35, null] },
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
      { ...tree('acacia', 'acacia', 25, 5, 0.1), cluster: { kind: 'matern', parents: 0.5, spread: 25, offspring: 4 } },
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
});

/** The world each preset dominates: climate and relief settings for examples, tests and golden digests. */
export const presetWorlds: Readonly<
  Record<keyof typeof presets, { readonly climate: ClimateOptions; readonly relief: ReliefOptions }>
> = Object.freeze({
  temperate: { climate: { latitude: 47, rainfall: 1000 }, relief: { relief: 500, base: 150 } },
  boreal: { climate: { latitude: 57, rainfall: 650, inland: 1200 }, relief: { relief: 400, base: 150 } },
  alpine: { climate: { latitude: 46, rainfall: 1400 }, relief: { relief: 2400, base: 2200 } },
  wetland: { climate: { latitude: 44, rainfall: 1300 }, relief: { relief: 20, base: 12, coast: 'west', rivers: 3 } },
  tundra: { climate: { latitude: 71, rainfall: 300, inland: 2000 }, relief: { relief: 200, base: 60 } },
  desert: { climate: { latitude: 24, rainfall: 80 }, relief: { relief: 600, base: 300 } },
  savanna: { climate: { latitude: 11, rainfall: 750 }, relief: { relief: 300, base: 400 } },
  tropical: { climate: { latitude: 3, rainfall: 2700 }, relief: { relief: 800, base: 120 } },
});
