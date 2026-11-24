// Forestry data and allometry of the northern Rockies conifers (`@margoengine/procedural/conifer-species`): the five
// timber trees of the 1910 Big Burn country, western white pine, western larch, western red cedar, Douglas-fir and grand
// fir. Plain numbers and small functions only, so the biome view can read crown heights without loading the meshes.
//
// Sources (papers and reports only; no code read):
// - Height from diameter: the logistic height-diameter equation of Wykoff, Crookston and Stage 1982, "User's guide to
//   the Stand Prognosis Model", USDA Forest Service INT-GTR-133, with the Inland Empire coefficients of Table 4.1.1 of
//   "Inland Empire (IE) Variant Overview, Forest Vegetation Simulator" (Keyser, USDA Forest Service FMSC, revised 2024):
//   HT = 4.5 + exp(B1 + B2 / (DBH + 1)), HT in feet, DBH in inches. The same overview's bark ratios (DIB / DOB, Table
//   4.1.2, after Wykoff et al. 1982) give each bark's thickness.
// - Crown width: Crookston's 2003 equation (IE overview, equation {4.4.3} and Table 4.4.1, codes 11903, 07303, 20203,
//   01703 and 24203): CW = a1 exp(a2 + a3 ln CL + a4 ln DBH + a5 ln HT + a6 ln BA), CW, CL (crown length) and HT in feet,
//   DBH in inches, BA the stand basal area in square feet per acre.
// - Growth form, shade tolerance, crown and bark: Burns and Honkala (technical coordinators) 1990, "Silvics of North
//   America, Volume 1, Conifers", USDA Agriculture Handbook 654 (the chapters on Pinus monticola, Larix occidentalis,
//   Thuja plicata, Pseudotsuga menziesii and Abies grandis), and Minore 1979, "Comparative autecological characteristics
//   of northwestern tree species: a literature review", USDA Forest Service PNW-GTR-87 (shade tolerance ranking: cedar
//   and grand fir tolerant, white pine and Douglas-fir intermediate, larch very intolerant). Live crown ratios fall with
//   age and rise with tolerance; the young and old values below are ours, inside the ranges those texts give.
// - Annual height growth and branch whorls: one whorl a year at the top of each year's growth unit (Hallé, Oldeman and
//   Tomlinson 1978, Tropical Trees and Forests: An Architectural Analysis; the Silvics chapters for each species'
//   whorled or irregular branching). Height with age follows the Chapman-Richards form (Richards 1959, "A flexible
//   growth function for empirical use", Journal of Experimental Botany 10(2)), its asymptote under the Wykoff
//   asymptote; rates are ours, set so dominant heights at 50 and 100 years sit inside the site index ranges of Silvics.

/** The five northern Rockies timber conifers. */
export type ConiferSpecies = 'western-white-pine' | 'western-larch' | 'western-red-cedar' | 'douglas-fir' | 'grand-fir';
/** Named ages: sapling 15, pole 40, mature 100 and old 250 years. */
export type ConiferAge = 'sapling' | 'pole' | 'mature' | 'old';

/** One species' measured and chosen numbers. Lengths in metres unless named otherwise. */
export interface ConiferSpeciesData {
  /** Latin name. */
  readonly latin: string;
  /** Wykoff height-diameter coefficients B1 and B2 (feet and inches), IE Table 4.1.1. */
  readonly wykoff: readonly [number, number];
  /** Crookston 2003 crown width coefficients a1 to a6, IE Table 4.4.1. */
  readonly crownWidth: readonly [number, number, number, number, number, number];
  /** Inside-bark over outside-bark diameter, IE Table 4.1.2: 1 minus it is the bark's share of the diameter. */
  readonly barkRatio: number;
  /** Chapman-Richards height growth: asymptote (m), rate (per year) and shape. */
  readonly growth: readonly [number, number, number];
  /** Live crown ratio young (sapling) and old: it falls from one to the other with age (time constant 45 years). */
  readonly crownRatio: readonly [number, number];
  /** Shade tolerance rank, 1 very intolerant to 5 very tolerant (Minore 1979). */
  readonly tolerance: number;
  /** True when branches come in annual whorls; false for spiralled, irregular branching (cedar). */
  readonly whorled: boolean;
  /** Main branches per whorl (or per year when not whorled). */
  readonly branchesPerWhorl: number;
  /** Branch insertion angle from the stem, degrees (90 horizontal). */
  readonly branchAngle: number;
  /** Tip droop as a share of branch length (cedar's J-shaped sweep, grand fir's drooping tips). */
  readonly droop: number;
  /** Crown profile exponent, young: radius = (1 - z)^e up the crown (1 a cone, below 1 fuller). */
  readonly profile: number;
  /** How flat or rounded the old crown's top grows: 1 stays conic, larger is more cylindrical with a blunt top. */
  readonly oldTop: number;
  /** Foliage fill of a branch spray, 0 to 1 (larch tufts sparse, grand fir dense). */
  readonly fill: number;
  /** Butt flare: diameter at the ground over diameter at breast height. */
  readonly flare: number;
  /** Bark ridges round the stem (plates, furrows or fibrous strips). */
  readonly ridges: number;
  /** Bark spiral, radians of twist per metre (cedar's strips spiral). */
  readonly twist: number;
  /** Needle albedo, linear RGB. */
  readonly needles: readonly [number, number, number];
  /** Bark albedo, linear RGB. */
  readonly bark: readonly [number, number, number];
  /** Leader droops (cedar's nodding leader). */
  readonly noddingLeader: boolean;
}

/**
 * Every species' numbers. Bark and needle albedos are ours, from field photographs under overcast light (the Silvics
 * texts: white pine's thin grey bark checked into small squares, larch's thick cinnamon plates, cedar's thin red-brown
 * fibrous strips, Douglas-fir's thick dark brown corky furrows, grand fir's smooth grey bark with resin blisters).
 */
export const CONIFER_SPECIES: Readonly<Record<ConiferSpecies, ConiferSpeciesData>> = Object.freeze({
  'western-white-pine': Object.freeze({
    latin: 'Pinus monticola',
    wykoff: [5.19988, -9.26718] as const,
    crownWidth: [1.0405, 1.2799, 0.11941, 0.42745, 0, -0.07182] as const,
    barkRatio: 0.964,
    growth: [50.5, 0.016, 1.35] as const,
    crownRatio: [0.85, 0.42] as const,
    tolerance: 3,
    whorled: true,
    branchesPerWhorl: 5,
    branchAngle: 82,
    droop: 0.12,
    profile: 0.95,
    oldTop: 2.6,
    fill: 0.7,
    flare: 1.25,
    ridges: 16,
    twist: 0,
    needles: [0.045, 0.12, 0.1] as const,
    bark: [0.2, 0.19, 0.18] as const,
    noddingLeader: false,
  }),
  'western-larch': Object.freeze({
    latin: 'Larix occidentalis',
    wykoff: [4.97407, -6.78347] as const,
    crownWidth: [1.02478, 0.99889, 0.19422, 0.59423, -0.09078, -0.02341] as const,
    barkRatio: 0.851,
    growth: [40.5, 0.024, 1.4] as const,
    crownRatio: [0.78, 0.3] as const,
    tolerance: 1,
    whorled: true,
    branchesPerWhorl: 4,
    branchAngle: 88,
    droop: 0.08,
    profile: 1,
    oldTop: 1.4,
    fill: 0.45,
    flare: 1.3,
    ridges: 11,
    twist: 0,
    needles: [0.09, 0.2, 0.05] as const,
    bark: [0.27, 0.12, 0.065] as const,
    noddingLeader: false,
  }),
  'western-red-cedar': Object.freeze({
    latin: 'Thuja plicata',
    wykoff: [4.89564, -8.39057] as const,
    crownWidth: [1.03597, 1.46111, 0.26289, 0.18779, 0, 0] as const,
    barkRatio: 0.95,
    growth: [37.5, 0.012, 1.25] as const,
    crownRatio: [0.92, 0.62] as const,
    tolerance: 5,
    whorled: false,
    branchesPerWhorl: 2,
    branchAngle: 68,
    droop: 0.35,
    profile: 0.8,
    oldTop: 1.3,
    fill: 0.85,
    flare: 1.9,
    ridges: 22,
    twist: 0.05,
    needles: [0.07, 0.16, 0.045] as const,
    bark: [0.3, 0.14, 0.08] as const,
    noddingLeader: true,
  }),
  'douglas-fir': Object.freeze({
    latin: 'Pseudotsuga menziesii var. glauca',
    wykoff: [4.81519, -7.29306] as const,
    crownWidth: [1.01685, 1.48372, 0.27378, 0.49646, -0.18669, -0.01509] as const,
    barkRatio: 0.867,
    growth: [34.5, 0.02, 1.35] as const,
    crownRatio: [0.86, 0.38] as const,
    tolerance: 3,
    whorled: true,
    branchesPerWhorl: 4,
    branchAngle: 75,
    droop: 0.2,
    profile: 0.85,
    oldTop: 1.9,
    fill: 0.75,
    flare: 1.35,
    ridges: 9,
    twist: 0,
    needles: [0.035, 0.12, 0.055] as const,
    bark: [0.16, 0.1, 0.07] as const,
    noddingLeader: false,
  }),
  'grand-fir': Object.freeze({
    latin: 'Abies grandis',
    wykoff: [5.00233, -8.19365] as const,
    crownWidth: [1.0303, 1.14079, 0.20904, 0.38787, 0, 0] as const,
    barkRatio: 0.915,
    growth: [41.5, 0.018, 1.35] as const,
    crownRatio: [0.9, 0.55] as const,
    tolerance: 4,
    whorled: true,
    branchesPerWhorl: 5,
    branchAngle: 86,
    droop: 0.25,
    profile: 0.85,
    oldTop: 2.1,
    fill: 0.9,
    flare: 1.3,
    ridges: 8,
    twist: 0,
    needles: [0.03, 0.115, 0.045] as const,
    bark: [0.24, 0.23, 0.21] as const,
    noddingLeader: false,
  }),
});

/** The species, in a fixed order. */
export const CONIFER_SPECIES_IDS: readonly ConiferSpecies[] = Object.freeze(Object.keys(CONIFER_SPECIES) as ConiferSpecies[]);
/** Years of each named age. */
export const CONIFER_AGES: Readonly<Record<ConiferAge, number>> = Object.freeze({ sapling: 15, pole: 40, mature: 100, old: 250 });

/** Options of {@link coniferForm}. */
export interface ConiferFormOptions {
  /** Age in years (1 to 600) or a named age. Default 'mature' (100 years). Ignored when `height` is given. */
  readonly age?: number | ConiferAge;
  /** Total height in metres, 1.5 up to just under the species' asymptote; overrides `age`. */
  readonly height?: number;
  /** Stand basal area for the crown width equation, square metres per hectare, 1 to 120. Default 34.4 (150 ft2/ac). */
  readonly basalArea?: number;
}

/** A tree's size and crown, from {@link coniferForm}. Lengths in metres. */
export interface ConiferForm {
  readonly species: ConiferSpecies;
  /** Age in years. */
  readonly age: number;
  /** Total height. */
  readonly height: number;
  /** Diameter outside bark at breast height (1.37 m, 4.5 ft). */
  readonly dbh: number;
  /** Live crown length over height. */
  readonly crownRatio: number;
  /** Live crown length. */
  readonly crownLength: number;
  /** Height of the crown base (the lowest live branch). */
  readonly crownBase: number;
  /** Crown width (the widest diameter of the crown). */
  readonly crownWidth: number;
  /** This year's height growth: the spacing of the newest whorls at the top. */
  readonly whorlSpacing: number;
  /** Bark thickness at breast height (one side). */
  readonly barkThickness: number;
}

const FT = 0.3048,
  IN = 0.0254,
  BH = 4.5 * FT;

const speciesData = (species: ConiferSpecies): ConiferSpeciesData => {
  const s = Object.hasOwn(CONIFER_SPECIES, species) ? CONIFER_SPECIES[species] : undefined;
  if (!s) throw new RangeError(`Unknown conifer species '${String(species)}'; pass one of ${CONIFER_SPECIES_IDS.join(', ')}.`);
  return s;
};

/** Height in metres at `age` years (Chapman-Richards). */
export function coniferHeightAt(species: ConiferSpecies, age: number): number {
  const [a, k, p] = speciesData(species).growth;
  return BH + (a - BH) * (1 - Math.exp(-k * age)) ** p;
}

/** Height growth in metres per year at `age` years: the whorl spacing of that year's growth unit. */
export function coniferHeightGrowth(species: ConiferSpecies, age: number): number {
  const [a, k, p] = speciesData(species).growth,
    e = Math.exp(-k * age);
  return (a - BH) * p * (1 - e) ** (p - 1) * k * e;
}

/** Age in years at which the species reaches `height` metres (the inverse of {@link coniferHeightAt}). */
export function coniferAgeAt(species: ConiferSpecies, height: number): number {
  const [a, k, p] = speciesData(species).growth;
  if (!(height > BH && height < a)) throw new RangeError(`Height must be above 1.37 m and below ${a} m for ${species}.`);
  return -Math.log(1 - ((height - BH) / (a - BH)) ** (1 / p)) / k;
}

/** Diameter at breast height in metres for a total height in metres (Wykoff 1982, inverted). */
export function coniferDiameter(species: ConiferSpecies, height: number): number {
  const [b1, b2] = speciesData(species).wykoff,
    ft = height / FT;
  if (ft <= 4.5 + 1e-6) return 0;
  const d = b2 / (Math.log(ft - 4.5) - b1) - 1;
  if (!(d > -1)) throw new RangeError(`Height ${height} m is past the ${species} height-diameter asymptote; pass a lower height.`);
  // Below an inch the equation runs below breast height's own stem: a sapling a little over 1.37 m keeps a thin stem.
  return Math.max(0.005, d * IN);
}

/** Total height in metres for a breast-height diameter in metres (Wykoff 1982). */
export function coniferHeight(species: ConiferSpecies, dbh: number): number {
  const [b1, b2] = speciesData(species).wykoff;
  return (4.5 + Math.exp(b1 + b2 / (dbh / IN + 1))) * FT;
}

/**
 * Crown width in metres (Crookston 2003): `dbh`, `height` and `crownLength` in metres, `basalArea` in square metres
 * per hectare. Below 1 inch the width at 1 inch scales with the diameter, as the IE variant does.
 */
export function coniferCrownWidth(
  species: ConiferSpecies,
  dbh: number,
  height: number,
  crownLength: number,
  basalArea = 34.4,
): number {
  const [a1, a2, a3, a4, a5, a6] = speciesData(species).crownWidth,
    d = dbh / IN,
    ba = Math.max(1, basalArea / 0.229568),
    at = (di: number) =>
      a1 *
      Math.exp(
        a2 + a3 * Math.log(Math.max(1, crownLength / FT)) + a4 * Math.log(di) + a5 * Math.log(height / FT) + a6 * Math.log(ba),
      ) *
      FT;
  return d >= 1 ? at(d) : at(1) * Math.max(d, 0.2);
}

/** Live crown ratio at `age` years. */
export function coniferCrownRatio(species: ConiferSpecies, age: number): number {
  const [young, old] = speciesData(species).crownRatio;
  return old + (young - old) * Math.exp(-Math.max(0, age - 10) / 45);
}

/**
 * A tree's size and crown at an age or a height: height from the growth curve, diameter from the Wykoff equation,
 * crown ratio by age, crown width from Crookston's equation and the top whorl spacing from the growth curve.
 * @throws RangeError for an unknown species, age or height out of range.
 */
export function coniferForm(species: ConiferSpecies, options: ConiferFormOptions = {}): ConiferForm {
  const s = speciesData(species);
  const ba = options.basalArea ?? 34.4;
  if (!(typeof ba === 'number' && ba >= 1 && ba <= 120)) throw new RangeError('basalArea must be 1 to 120 m2/ha.');
  let age: number, height: number;
  if (options.height !== undefined) {
    height = options.height;
    if (!(typeof height === 'number' && height >= 1.5 && height <= s.growth[0] - 0.05))
      throw new RangeError(`height must be 1.5 to ${s.growth[0] - 0.05} m for ${species}.`);
    age = coniferAgeAt(species, height);
  } else {
    const named = options.age ?? 'mature';
    age = typeof named === 'string' ? CONIFER_AGES[named] : named;
    if (!(typeof age === 'number' && age >= 1 && age <= 600))
      throw new RangeError("age must be 1 to 600 years or 'sapling', 'pole', 'mature' or 'old'.");
    height = Math.max(1.5, coniferHeightAt(species, age));
  }
  const dbh = coniferDiameter(species, height),
    crownRatio = coniferCrownRatio(species, age),
    crownLength = crownRatio * height;
  return Object.freeze({
    species,
    age,
    height,
    dbh,
    crownRatio,
    crownLength,
    crownBase: height - crownLength,
    crownWidth: coniferCrownWidth(species, dbh, height, crownLength, ba),
    whorlSpacing: coniferHeightGrowth(species, age),
    barkThickness: (dbh * (1 - s.barkRatio)) / 2,
  });
}

/** What a conifer mesh key names: a species, an age and a condition. */
export interface ConiferKey {
  readonly species: ConiferSpecies;
  readonly age: ConiferAge;
  readonly condition: 'live' | 'snag' | 'burnt';
}

/**
 * Reads a conifer mesh key, with or without its `procedural:` prefix: `<species>` (mature and live),
 * `<species>/<age>` (sapling, pole, mature or old), `<species>/snag` and `<species>/burnt` (mature, dead), and the
 * generic `conifer-snag` and `burnt-trunk` (a Douglas-fir snag and burnt tree). Undefined for any other key.
 * @example parseConiferKey('procedural:western-larch/old'); // { species: 'western-larch', age: 'old', condition: 'live' }
 */
export function parseConiferKey(key: string): ConiferKey | undefined {
  if (typeof key !== 'string') return undefined;
  const name = key.startsWith('procedural:') ? key.slice(11) : key;
  if (name === 'conifer-snag') return { species: 'douglas-fir', age: 'mature', condition: 'snag' };
  if (name === 'burnt-trunk') return { species: 'douglas-fir', age: 'mature', condition: 'burnt' };
  const [species, rest, extra] = name.split('/');
  if (extra !== undefined || !Object.hasOwn(CONIFER_SPECIES, species)) return undefined;
  if (rest === undefined) return { species: species as ConiferSpecies, age: 'mature', condition: 'live' };
  if (rest === 'snag' || rest === 'burnt') return { species: species as ConiferSpecies, age: 'mature', condition: rest };
  if (Object.hasOwn(CONIFER_AGES, rest)) return { species: species as ConiferSpecies, age: rest as ConiferAge, condition: 'live' };
  return undefined;
}
