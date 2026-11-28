// Forestry data and allometry of the temperate broadleaves (`@margoengine/procedural/broadleaf-species`): English oak,
// European beech and black alder. Plain numbers and small functions only, so a biome view can read crown sizes
// without loading the meshes.
//
// Sources (papers and tables only; no code read):
// - Crown width from stem diameter: Hemery, Savill and Pryor 2005, "Applications of the crown diameter-stem diameter
//   relationship for different species of broadleaved trees", Forest Ecology and Management 215, 285-294, and the table
//   of open-grown trees on https://gabrielhemery.com/blog/2011/06/15/how-big-will-this-tree-grow/ (oak 2.50 m across at
//   0.10 m dbh and 13.14 m at 0.70 m, a straight line 0.727 + 17.73 dbh; beech 2.52 m and 11.96 m, 0.947 + 15.73 dbh).
//   The table has no alder; the alder line is ours, narrower than beech.
// - Growth form: Eaton, Caudullo, Oliveira and de Rigo 2016, "Quercus robur and Quercus petraea in Europe", European
//   Atlas of Forest Tree Species (open-grown pedunculate oak forks low into a few large decurrent limbs); Buck-Sorlin
//   and Bell 2000, "Models of crown architecture in Quercus petraea and Q. robur", Forestry 73(5); Barthelemy and
//   Caraglio 2007, "Plant architecture: a dynamic, multilevel and comprehensive approach to plant form, structure and
//   ontogeny", Annals of Botany 99(3) (decurrent and excurrent crowns, limbs that restart growth from side buds).
// - Leaf area index of closed temperate broadleaf canopies, 4 to 6: Breda 2003, "Ground-based measurements of leaf area
//   index", Journal of Experimental Botany 54(392). Leaf inclination, planophile to plagiophile: Pisek, Sonnentag,
//   Richardson and Mottus 2013, "Is the spherical leaf inclination angle distribution a valid assumption for temperate
//   and boreal broadleaf tree species?", Agricultural and Forest Meteorology 169.
// - Height with age follows the Chapman-Richards form (Richards 1959, "A flexible growth function for empirical use",
//   Journal of Experimental Botany 10(2)); its rates, the diameter curve, bark and leaf albedos and leaf sizes are ours,
//   set inside the ranges those texts give (oak leaves 10 to 12 cm by 7 to 8 cm, five to seven lobe pairs).

/** The three temperate broadleaves. */
export type BroadleafSpecies = 'english-oak' | 'european-beech' | 'black-alder';
/** Named ages: sapling 15, pole 40, mature 120 and old 300 years. */
export type BroadleafAge = 'sapling' | 'pole' | 'mature' | 'old';

/** One species' measured and chosen numbers. Lengths in metres unless named otherwise. */
export interface BroadleafSpeciesData {
  /** Latin name. */
  readonly latin: string;
  /** Chapman-Richards height growth: asymptote (m), rate (per year) and shape. */
  readonly growth: readonly [number, number, number];
  /** Diameter at breast height asymptote, forest grown and open grown (m), and its time constant (years). */
  readonly dbh: readonly [number, number, number];
  /** Crown diameter = a + b dbh (metres; Hemery's open-grown table). */
  readonly crownWidth: readonly [number, number];
  /** Crown base height over total height, forest grown and open grown. */
  readonly crownBase: readonly [number, number];
  /** Limbs the trunk forks into, fewest and most (an alder's leader counts as one). */
  readonly limbs: readonly [number, number];
  /** Where the trunk stops and the limbs take over, as a share of the crown length above its base. */
  readonly fork: number;
  /** True when the trunk runs on as a leader through the crown (alder); false for a decurrent crown (oak, beech). */
  readonly leader: boolean;
  /** Elevation, from the crown's centre, of the dome points the lowest and highest limbs steer to, degrees. */
  readonly limbPitch: readonly [number, number];
  /** Radius of a foliage mass as a share of the crown width. */
  readonly massSize: number;
  /** Leaf area index of the crown (leaf area over the ground area under it). */
  readonly lai: number;
  /** Leaf length and width in metres, and lobe pairs (0 for an unlobed leaf). */
  readonly leaf: readonly [number, number, number];
  /** Leaf albedo, linear RGB. */
  readonly leaves: readonly [number, number, number];
  /** Bark albedo, linear RGB. */
  readonly bark: readonly [number, number, number];
}

/** Every species' numbers. */
export const BROADLEAF_SPECIES: Readonly<Record<BroadleafSpecies, BroadleafSpeciesData>> = Object.freeze({
  'english-oak': Object.freeze({
    latin: 'Quercus robur',
    growth: [28, 0.013, 1.2] as const,
    dbh: [0.9, 1.4, 120] as const,
    crownWidth: [0.727, 17.73] as const,
    crownBase: [0.45, 0.16] as const,
    limbs: [4, 7] as const,
    fork: 0.3,
    leader: false,
    limbPitch: [-12, 55] as const,
    massSize: 0.185,
    lai: 5.8,
    leaf: [0.11, 0.075, 6] as const,
    leaves: [0.05, 0.11, 0.035] as const,
    bark: [0.09, 0.075, 0.06] as const,
  }),
  'european-beech': Object.freeze({
    latin: 'Fagus sylvatica',
    growth: [35, 0.015, 1.3] as const,
    dbh: [0.8, 1.2, 110] as const,
    crownWidth: [0.947, 15.73] as const,
    crownBase: [0.5, 0.2] as const,
    limbs: [5, 8] as const,
    fork: 0.6,
    leader: false,
    limbPitch: [-5, 58] as const,
    massSize: 0.11,
    lai: 6,
    leaf: [0.08, 0.05, 0] as const,
    leaves: [0.045, 0.12, 0.03] as const,
    bark: [0.2, 0.19, 0.17] as const,
  }),
  'black-alder': Object.freeze({
    latin: 'Alnus glutinosa',
    growth: [28, 0.022, 1.2] as const,
    dbh: [0.45, 0.65, 60] as const,
    crownWidth: [0.8, 12] as const,
    crownBase: [0.45, 0.3] as const,
    limbs: [5, 8] as const,
    fork: 0.95,
    leader: true,
    limbPitch: [10, 62] as const,
    massSize: 0.1,
    lai: 4.5,
    leaf: [0.08, 0.065, 0] as const,
    leaves: [0.035, 0.09, 0.03] as const,
    bark: [0.08, 0.06, 0.05] as const,
  }),
});

/** The species, in a fixed order. */
export const BROADLEAF_SPECIES_IDS: readonly BroadleafSpecies[] = Object.freeze(
  Object.keys(BROADLEAF_SPECIES) as BroadleafSpecies[],
);
/** Years of each named age. */
export const BROADLEAF_AGES: Readonly<Record<BroadleafAge, number>> = Object.freeze({
  sapling: 15,
  pole: 40,
  mature: 120,
  old: 300,
});

/** Options of {@link broadleafForm}. */
export interface BroadleafFormOptions {
  /** Age in years (1 to 600) or a named age. Default 'mature' (120 years). Ignored when `height` is given. */
  readonly age?: number | BroadleafAge;
  /** Total height in metres, 1.5 up to just under the species' asymptote; overrides `age`. */
  readonly height?: number;
  /** 0 forest grown (high bole, slender) to 1 open grown (low limbs, stout). Default 0.8, a meadow or park tree. */
  readonly open?: number;
}

/** A tree's size and crown, from {@link broadleafForm}. Lengths in metres. */
export interface BroadleafForm {
  readonly species: BroadleafSpecies;
  readonly age: number;
  readonly open: number;
  readonly height: number;
  /** Diameter at breast height (1.37 m). */
  readonly dbh: number;
  /** Crown diameter (Hemery's line for the species). */
  readonly crownWidth: number;
  /** Height of the lowest limb. */
  readonly crownBase: number;
  readonly crownLength: number;
  readonly crownRatio: number;
}

const BREAST = 1.37;

const speciesData = (species: BroadleafSpecies): BroadleafSpeciesData => {
  const s = Object.hasOwn(BROADLEAF_SPECIES, species) ? BROADLEAF_SPECIES[species] : undefined;
  if (!s)
    throw new RangeError(
      `Unknown broadleaf species '${String(species)}'; pass one of ${BROADLEAF_SPECIES_IDS.join(', ')}.`,
    );
  return s;
};

/** Height in metres at `age` years (Chapman-Richards). */
export function broadleafHeightAt(species: BroadleafSpecies, age: number): number {
  const [a, k, p] = speciesData(species).growth;
  return BREAST + (a - BREAST) * (1 - Math.exp(-k * age)) ** p;
}

/** Age in years at which the species reaches `height` metres (the inverse of {@link broadleafHeightAt}). */
export function broadleafAgeAt(species: BroadleafSpecies, height: number): number {
  const [a, k, p] = speciesData(species).growth;
  if (!(height > BREAST && height < a))
    throw new RangeError(`Height must be above 1.37 m and below ${a} m for ${species}.`);
  return -Math.log(1 - ((height - BREAST) / (a - BREAST)) ** (1 / p)) / k;
}

/** Diameter at breast height in metres at `age` years for a forest (0) to open (1) grown tree. */
export function broadleafDiameter(species: BroadleafSpecies, age: number, open = 0.7): number {
  const [forest, wide, tau] = speciesData(species).dbh;
  return Math.max(0.01, (forest + (wide - forest) * open) * (1 - Math.exp(-age / tau)));
}

/** Crown width in metres for a stem diameter in metres (Hemery's line). */
export function broadleafCrownWidth(species: BroadleafSpecies, dbh: number): number {
  const [a, b] = speciesData(species).crownWidth;
  return a + b * dbh;
}

/**
 * A tree's size and crown at an age or a height.
 * @throws RangeError for an unknown species, an age, height or openness out of range.
 */
export function broadleafForm(species: BroadleafSpecies, options: BroadleafFormOptions = {}): BroadleafForm {
  const s = speciesData(species),
    open = options.open ?? 0.8;
  if (!(typeof open === 'number' && open >= 0 && open <= 1)) throw new RangeError('open must be 0 to 1.');
  let age: number, height: number;
  if (options.height !== undefined) {
    height = options.height;
    if (!(typeof height === 'number' && height >= 1.5 && height <= s.growth[0] - 0.05))
      throw new RangeError(`height must be 1.5 to ${s.growth[0] - 0.05} m for ${species}.`);
    age = broadleafAgeAt(species, height);
  } else {
    const named = options.age ?? 'mature';
    age = typeof named === 'string' ? (Object.hasOwn(BROADLEAF_AGES, named) ? BROADLEAF_AGES[named] : NaN) : named;
    if (!(typeof age === 'number' && age >= 1 && age <= 600))
      throw new RangeError("age must be 1 to 600 years or 'sapling', 'pole', 'mature' or 'old'.");
    height = Math.max(1.5, broadleafHeightAt(species, age));
  }
  const dbh = broadleafDiameter(species, age, open),
    base = height * (s.crownBase[0] + (s.crownBase[1] - s.crownBase[0]) * open);
  return Object.freeze({
    species,
    age,
    open,
    height,
    dbh,
    crownWidth: broadleafCrownWidth(species, dbh),
    crownBase: base,
    crownLength: height - base,
    crownRatio: (height - base) / height,
  });
}

/** What a broadleaf mesh key names: a species, an age and a condition (leafed or bare). */
export interface BroadleafKey {
  readonly species: BroadleafSpecies;
  readonly age: BroadleafAge;
  readonly condition: 'live' | 'bare';
}

/**
 * Reads a broadleaf mesh key, with or without its `procedural:` prefix: `<species>` (mature, leafed),
 * `<species>/<age>` (sapling, pole, mature or old), `<species>/bare` (mature, leafless) and the generic `broadleaf`
 * (a mature English oak). Undefined for any other key.
 * @example parseBroadleafKey('procedural:european-beech/old'); // { species: 'european-beech', age: 'old', condition: 'live' }
 */
export function parseBroadleafKey(key: string): BroadleafKey | undefined {
  if (typeof key !== 'string') return undefined;
  const name = key.startsWith('procedural:') ? key.slice(11) : key;
  if (name === 'broadleaf') return { species: 'english-oak', age: 'mature', condition: 'live' };
  const [species, rest, extra] = name.split('/');
  if (extra !== undefined || !Object.hasOwn(BROADLEAF_SPECIES, species)) return undefined;
  if (rest === undefined) return { species: species as BroadleafSpecies, age: 'mature', condition: 'live' };
  if (rest === 'bare') return { species: species as BroadleafSpecies, age: 'mature', condition: 'bare' };
  if (Object.hasOwn(BROADLEAF_AGES, rest))
    return { species: species as BroadleafSpecies, age: rest as BroadleafAge, condition: 'live' };
  return undefined;
}
