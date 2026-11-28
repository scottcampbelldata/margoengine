// The eight climate biome presets (spec 3.2), as plant functional type limits over the coldest month, growing degree days above
// 5 C and the moisture index AET / PET, with Korner's thermal treeline for forests (spec 2.3). The limits follow the
// BIOME1 and BIOME4 style of screening (Prentice et al. 1992; Kaplan et al. 2003): tropical trees need a coldest month
// of about 15.5 C, temperate broadleaf trees about 1,200 degree days, boreal conifers about 350 (background values from
// that literature, rounded; the per-preset numbers are ours). Meshes are the procedural ones (decision D5).
// Plain data: the presets are frozen here and checked with defineBiome by the package tests, so this entry carries no
// validation code (a world validates every definition it is given, presets included). `beach` is not a climate preset:
// it takes low, gentle ground by the sea in any world (height and slope envelopes; the island world uses it).
import { rangeError } from '../../shared/errors.js';
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
  fuel?: string,
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
  ...(fuel ? { fuel } : {}),
});
const shrub = (id: string, mesh: string, density: number, radius: number, fuel?: string): SpeciesRule => ({
  id,
  mesh: `procedural:${mesh}`,
  density,
  radius,
  shade: 0.6,
  suitability: dryLand,
  ...(fuel ? { fuel } : {}),
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

/**
 * Ids of the northern Rockies conifer presets (inland Idaho and western Montana, the country of the 1910 fires), which
 * belong to `rockiesWorld` and carry surface fuel models for `fuelMap` (`@margoengine/biomes/fuel`).
 */
export type RockiesPresetId = 'rockies-moist-forest' | 'rockies-dry-forest' | 'rockies-opening';

/**
 * Ids of the southern California presets (the coast ranges and foothills of the Mediterranean climate, the country of
 * the chaparral fires), which belong to `chaparralWorld` and carry surface fuel models for `fuelMap`.
 */
export type ChaparralPresetId = 'chaparral' | 'coastal-sage-scrub' | 'oak-woodland';

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
      { id: 'sedge', mesh: 'procedural:sedge', density: 15 },
      { id: 'lichen', mesh: 'procedural:lichen', density: 10 },
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

/**
 * The northern Rockies conifer presets, each a frozen {@link BiomeDefinition}: moist forest, dry forest and openings. They
 * are kept apart from `presets` so a list of `Object.values(presets)` stays the eight climate presets and `beach`; the
 * world that holds them is `rockiesWorld`.
 */
// The rockies trees draw the species meshes of @margoengine/procedural/conifers at their pole age (40 years) as the
// reference size: the reverse-J sizes run from about a third of it to 2.4 times it, 29 m cedar to 51 m larch at most,
// inside the old-growth heights of the Silvics chapters.
export const rockiesPresets: Readonly<Record<RockiesPresetId, BiomeDefinition>> = Object.freeze({
  // Which species stand where follows the habitat types of Pfister, Kovalchik, Arno and Presby, "Forest habitat types of
  // Montana", INT-34, 1977, and Cooper, Neiman and Roberts, "Forest habitat types of northern Idaho: a second approximation",
  // INT-GTR-236, 1991: western red cedar, western white pine and grand fir on the moist ground (cedar and grand fir
  // series), Douglas-fir with western larch on the drier slopes (Douglas-fir series), and bunchgrass and brush on the
  // driest, south-facing ground where timber does not close. The surface fuel under each is the model Anderson,
  // "Aids to determining fuel models for estimating fire behavior", INT-GTR-122, 1982, names for it (model values
  // live in @margoengine/vfx/fire-front): closed stands of white pine, lodgepole pine, spruce, fir and larch are model
  // 8 (p. 11), timber with heavy dead-down material, such as old-growth Douglas-fir and overmature or deadfall
  // stands of any type, is model 10 (p. 13; cedar stands take it for their deadfall), grass is model 1 (p. 4), open
  // pine or Douglas-fir stands over grass are model 2 (p. 5) and green low shrub fields in timber (the Douglas-fir
  // snowberry habitat type) are model 5 (p. 8). Crown radii, densities and the climate envelopes are ours.
  'rockies-moist-forest': freeze<BiomeDefinition>({
    id: 'rockies-moist-forest',
    climate: { moisture: [0.56, null], treeline: [0, null], coldest: [-14, null], slope: [null, 40] },
    ground: [
      { material: 'needles' },
      { material: 'moss', moisture: [0.75, null] },
      { material: 'rock', slope: [32, null] },
    ],
    plants: [
      tree('western-white-pine', 'western-white-pine/pole', 120, 3.2, 0.35, true, 'FM8'),
      {
        ...tree('western-red-cedar', 'western-red-cedar/pole', 150, 3.4, 0.8, true, 'FM10'),
        suitability: { height: [3, null], waterDistance: [12, null] },
      },
      tree('grand-fir', 'grand-fir/pole', 170, 3, 0.8, true, 'FM8'),
      shrub('mountain-maple', 'shrub', 500, 1.2, 'FM5'),
    ],
    rocks: [rock(8)],
    details: [{ id: 'fern', mesh: 'procedural:fern', density: 8, light: [0, 0.5] }],
    openFuel: 'FM5',
  }),
  'rockies-dry-forest': freeze<BiomeDefinition>({
    id: 'rockies-dry-forest',
    climate: { moisture: [0.38, 0.6], treeline: [0, null], coldest: [-14, null], slope: [null, 45] },
    ground: [
      { material: 'needles' },
      { material: 'dry-grass', moisture: [null, 0.3] },
      { material: 'rock', slope: [34, null] },
    ],
    plants: [
      tree('douglas-fir', 'douglas-fir/pole', 190, 3, 0.5, true, 'FM10'),
      { ...tree('western-larch', 'western-larch/pole', 70, 2.6, 0.1, true, 'FM8'), stands: { scale: 250, cover: 0.5 } },
      shrub('ninebark', 'shrub', 700, 1, 'FM5'),
    ],
    rocks: [rock(10)],
    details: [{ id: 'pinegrass', mesh: 'procedural:grass', density: 30, light: [0.3, 1] }],
    openFuel: 'FM1',
  }),
  'rockies-opening': freeze<BiomeDefinition>({
    id: 'rockies-opening',
    priority: 1,
    climate: {
      moisture: [null, 0.58],
      treeline: [0, null],
      coldest: [-14, null],
      custom: { aspect: [100, 260] },
      slope: [6, null],
    },
    ground: [{ material: 'dry-grass' }, { material: 'rock', slope: [32, null] }],
    plants: [
      {
        ...tree('douglas-fir', 'douglas-fir/pole', 25, 3, 0.5, false, 'FM2'),
        cluster: { kind: 'matern', parents: 0.5, spread: 20, offspring: 4 },
      },
      shrub('snowbrush', 'shrub', 300, 1.1, 'FM5'),
    ],
    rocks: [rock(14)],
    details: [{ id: 'bunchgrass', mesh: 'procedural:grass', density: 50, blades: true }],
    openFuel: 'FM1',
  }),
});

/**
 * The southern California presets, each a frozen {@link BiomeDefinition}: chaparral, coastal sage scrub and oak woodland.
 * Kept apart from `presets` as the Rockies conifers are; the world that holds them is `chaparralWorld`.
 */
export const chaparralPresets: Readonly<Record<ChaparralPresetId, BiomeDefinition>> = Object.freeze({
  // Which plants stand where follows Keeley and Davis, "Chaparral", and Rundel, "Sage scrub", chapters of
  // Barbour, Keeler-Wolf and Schoenherr (eds.), Terrestrial Vegetation of California, 3rd ed., 2007, and Allen-Diaz,
  // Standiford and Jackson, "Oak woodlands and forests", in the same: evergreen sclerophyll chaparral
  // (chamise, the manzanitas, ceanothus and scrub oak) closes over the dry slopes of the coast ranges and foothills; the
  // soft, summer-deciduous coastal sage scrub (California sagebrush, black sage and California buckwheat) holds the
  // lowest, driest and most exposed ground nearer the sea; oak woodland (coast live oak and blue oak over annual
  // grass) takes the moister north-facing slopes and valley floors. The surface fuel under each is the model Anderson,
  // INT-GTR-122, 1982, names for it: mature chaparral of nearly continuous shrubs 6 ft or more tall is model 4 (p. 7,
  // "California mixed chaparral"), the shorter, less dense brush of sage scrub and of young chaparral gaps is model 6
  // (p. 9, dormant brush), the open oak savanna's grass under scattered trees is model 2 (p. 5) and the open grass
  // model 1 (p. 4), and the closed hardwood litter under live oak is model 9 (p. 12). The live fuel moistures, crown
  // radii, densities and climate envelopes are ours.
  chaparral: freeze<BiomeDefinition>({
    id: 'chaparral',
    climate: { moisture: [0.2, 0.4], coldest: [0, null], slope: [null, 45] },
    ground: [
      { material: 'leaf-litter' },
      { material: 'dry-grass', moisture: [null, 0.25] },
      { material: 'rock', slope: [32, null] },
    ],
    plants: [
      shrub('chamise', 'shrub', 1400, 1, 'FM4'),
      shrub('bigberry-manzanita', 'shrub', 450, 1.5, 'FM4'),
      shrub('hoaryleaf-ceanothus', 'shrub', 400, 1.3, 'FM4'),
      shrub('scrub-oak', 'shrub', 250, 1.7, 'FM4'),
    ],
    rocks: [rock(10)],
    details: [{ id: 'annual-grass', mesh: 'procedural:grass', density: 8, light: [0.4, 1] }],
    openFuel: 'FM6',
  }),
  'coastal-sage-scrub': freeze<BiomeDefinition>({
    id: 'coastal-sage-scrub',
    priority: 1,
    climate: { moisture: [null, 0.3], coldest: [0, null], height: [null, 600], custom: { aspect: [100, 260] } },
    ground: [{ material: 'dry-grass' }, { material: 'rock', slope: [32, null] }],
    plants: [
      shrub('california-sagebrush', 'shrub', 1300, 0.7, 'FM6'),
      shrub('black-sage', 'shrub', 800, 0.8, 'FM6'),
      shrub('california-buckwheat', 'shrub', 900, 0.5, 'FM6'),
    ],
    rocks: [rock(12)],
    details: [{ id: 'annual-grass', mesh: 'procedural:grass', density: 30, blades: true }],
    openFuel: 'FM1',
  }),
  'oak-woodland': freeze<BiomeDefinition>({
    id: 'oak-woodland',
    climate: { moisture: [0.36, null], coldest: [0, null], slope: [null, 35] },
    ground: [
      { material: 'dry-grass' },
      { material: 'leaf-litter', moisture: [0.6, null] },
      { material: 'rock', slope: [30, null] },
    ],
    plants: [
      { ...tree('coast-live-oak', 'broadleaf', 60, 5, 0.6, true, 'FM9'), stands: { scale: 200, cover: 0.55 } },
      tree('blue-oak', 'broadleaf', 35, 4, 0.3, false, 'FM2'),
      shrub('toyon', 'shrub', 120, 1.4, 'FM6'),
    ],
    rocks: [rock(5)],
    details: [{ id: 'annual-grass', mesh: 'procedural:grass', density: 45, blades: true, light: [0.2, 1] }],
    openFuel: 'FM1',
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

/**
 * The world of the northern Rockies conifer presets: steep inland mountains (latitude 47.3, 550 mm of rain, 1,200 m of
 * relief over a 1,000 m base) that split between moist forest, dry forest and openings, with the fuel names `fuelMap`
 * reads (`@margoengine/biomes/fuel`). Kept apart from `presetWorlds`, which holds the climate presets and `island`.
 */
export const rockiesWorld: PresetWorld & { readonly biomes: readonly BiomeDefinition[] } = freeze({
  climate: { latitude: 47.3, rainfall: 550, inland: 600 },
  relief: { relief: 1200, base: 1000 },
  biomes: [
    rockiesPresets['rockies-moist-forest'],
    rockiesPresets['rockies-dry-forest'],
    rockiesPresets['rockies-opening'],
  ],
});

/**
 * The world of the southern California presets: coast-range hills and foothills (latitude 34.2, 450 mm of rain, 900 m
 * of relief over a 150 m base, the sea to the west, the country behind Santa Barbara and Malibu) that split between
 * chaparral, coastal sage scrub and oak woodland, with the fuel names `fuelMap` reads (`@margoengine/biomes/fuel`).
 */
export const chaparralWorld: PresetWorld & { readonly biomes: readonly BiomeDefinition[] } = freeze({
  climate: { latitude: 34.2, rainfall: 450 },
  relief: { relief: 900, base: 150 },
  biomes: [chaparralPresets.chaparral, chaparralPresets['coastal-sage-scrub'], chaparralPresets['oak-woodland']],
});

/**
 * A northern Rockies mountain valley with the conifer presets (`relief.mountainValley` of `createRelief`): the country
 * round Wallace, Idaho, in the 1910 fires. A main valley floor 870 m up at the outlet (Wallace stands at 870 m) runs
 * west, falling 1.2 percent, with a creek and a rail grade on it; walls of about 30 degrees cut into side gulches and
 * rounded ridges reach up to 1,000 m above the floor. Climate and biomes are those of `rockiesWorld`.
 */
export const rockiesValleyWorld: PresetWorld & { readonly biomes: readonly BiomeDefinition[] } = freeze({
  climate: rockiesWorld.climate,
  relief: { relief: 1000, base: 870, mountainValley: { outlet: 'west' as const } },
  biomes: rockiesWorld.biomes,
});

/** A northern Rockies conifer's age, as `procedural:<species>/<age>` mesh keys name it (`@margoengine/procedural/conifers`). */
export type ConiferAge = 'sapling' | 'pole' | 'mature' | 'old';
const coniferAges: readonly string[] = ['sapling', 'pole', 'mature', 'old'];

/**
 * `biomes` with every aged conifer key (`procedural:<species>/<age>`) drawn at `age`: the rockies presets grow pole
 * stands (about 40 years, the regrowth after the 1910 fires); `'mature'` (100 years) gives the closed old timber of a
 * valley that has not burned for a century. Placement is unchanged (the same records, spacing and sizes), so the
 * bigger crowns meet into a closed canopy. Snag, burnt and broadleaf keys are kept. Returns new frozen definitions.
 *
 * @example
 * const biomes = coniferAge(rockiesValleyWorld.biomes, 'mature');
 * console.log(biomes[0].plants?.[0].mesh); // procedural:western-white-pine/mature
 */
export function coniferAge(biomes: readonly BiomeDefinition[], age: ConiferAge): BiomeDefinition[] {
  if (!coniferAges.includes(age))
    throw rangeError(`Unknown conifer age ${String(age)}; pass sapling, pole, mature or old`, 'biomes');
  const aged = (mesh: string) => mesh.replace(/^(procedural:[a-z-]+)\/(?:sapling|pole|mature|old)$/, `$1/${age}`);
  return biomes.map((biome) =>
    freeze({ ...biome, plants: biome.plants?.map((plant) => ({ ...plant, mesh: aged(plant.mesh) })) }),
  );
}

/**
 * A Sanriku ria fishing bay on a 4,096 m world (`relief.ria` of `createRelief`): the sea to the east, a drowned valley
 * 2.4 km long running in from it, 900 m across at the mouth and 320 m at the head, 30 m deep at the mouth and 8 m at the
 * head (water for a harbour to moor in), steep forested
 * hills of up to about 440 m on both sides and a little level ground 3.5 m above the sea within 450 m of the head, the
 * only room for a town, with a small river coming down to it. Latitude 38.7 and 1,300 mm of rain (the Iwate and Miyagi
 * coast); the hills take `temperate` forest, rock on the steepest ground. The bay's sizes follow the Sanriku rias in
 * the Geospatial Information Authority of Japan's 1:25,000 maps (Otsuchi, Yamada and Ofunato bays: 2 to 4 km long,
 * mouths 0.8 to 2 km, hills of 300 to 600 m).
 */
export const riaWorld: PresetWorld & { readonly biomes: readonly BiomeDefinition[] } = freeze({
  climate: { latitude: 38.7, rainfall: 1300 },
  relief: {
    coast: 'east' as const,
    relief: 380,
    base: 60,
    ria: { length: 2400, width: 450, headWidth: 160, flat: 450, flatHeight: 3.5, depth: 30, headDepth: 8 },
  },
  biomes: [presets.temperate],
});
