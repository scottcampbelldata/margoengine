// Biome definitions as plain JSON data (spec 3.2), validated and frozen by defineBiome, and quantised to the integer
// envelopes the classifier uses.
import { rangeError, typeError } from '../../shared/errors.js';
import { clampInt, degreesToAngle, qdiv, sincos } from './fixed.js';
import { LAYERS } from './layers.js';

/** A value range `[min, max]`; `null` leaves that side open. */
export type Range = readonly [min: number | null, max: number | null];

/**
 * Where a biome lives: ranges on climate and terrain fields, in plain units. A cell's membership is 1 well inside every
 * range, falls smoothly (a Wendland kernel) across a blend band centred on each bound, and is exactly 0 beyond it.
 */
export interface ClimateEnvelope {
  /** Mean annual temperature, C. */
  readonly temperature?: Range;
  /** Mean temperature of the coldest and of the warmest month, C (the plant functional type limits of BIOME1). */
  readonly coldest?: Range;
  readonly warmest?: Range;
  /** Growing degree days above 5 C. */
  readonly gdd5?: Range;
  /** Days with a mean above 0.9 C. */
  readonly season?: Range;
  /** Korner thermal treeline margin, K: `[0, null]` below the treeline, `[null, 0]` above it. */
  readonly treeline?: Range;
  /** Annual rainfall, mm. */
  readonly rainfall?: Range;
  /** Moisture index AET / PET, 0..1. */
  readonly moistureIndex?: Range;
  /** Soil moisture, 0..1. */
  readonly moisture?: Range;
  /** Height, m. */
  readonly height?: Range;
  /** Slope, degrees. */
  readonly slope?: Range;
  /** Wind exposure, 0..1 (0.5 on flat ground). */
  readonly exposure?: Range;
  /** Soil depth, m. */
  readonly soil?: Range;
  /** Distance to water, m. */
  readonly waterDistance?: Range;
  /** Ranges on other layers in their own units (any `LAYERS` name), or on a user mask `'mask/<name>'` (0..1). */
  readonly custom?: Readonly<Record<string, Range>>;
  /** Blend band as a fraction of each closed range's width (open ranges use a per-field width). Default 0.15. */
  readonly blend?: number;
}

/** A ground material and where it shows inside the biome (ranges as in {@link ClimateEnvelope}, plus curvature). */
export interface GroundLayer {
  /** Material key, such as `'grass'`, resolved by the view's material table. */
  readonly material: string;
  readonly slope?: Range;
  readonly height?: Range;
  readonly moisture?: Range;
  /** General curvature, 1/m. */
  readonly curvature?: Range;
  /** Relative weight where it shows. Default 1. */
  readonly weight?: number;
}

/** Size distribution of a species: reverse-J (uneven-aged) or Weibull (even-aged). */
export type SizeDistribution =
  | { readonly kind: 'reverse-j'; readonly q: number; readonly max: number }
  | { readonly kind: 'weibull'; readonly shape: number; readonly scale: number };

/** Clustering of a species: Thomas (Gaussian offspring) or Matern (uniform discs). */
export interface ClusterRule {
  readonly kind: 'thomas' | 'matern';
  /** Parents per hectare, spread in metres, mean offspring per parent. */
  readonly parents: number;
  readonly spread: number;
  readonly offspring: number;
}

/** Colour variation: hue and value jitter 0..1, and whether it follows the seasons. */
export interface ColorVariation {
  readonly hue?: number;
  readonly value?: number;
  readonly seasonal?: boolean;
}

/** A stored species (tree, shrub, rock or prop), placed from B5 on. */
export interface SpeciesRule {
  readonly id: string;
  /** Asset key, such as `'procedural:conifer'`. */
  readonly mesh: string;
  /** Plants per hectare at full suitability. */
  readonly density: number;
  /** Crown or footprint radius in metres at mean size. */
  readonly radius: number;
  readonly size?: SizeDistribution;
  readonly cluster?: ClusterRule;
  /** Shade tolerance 0 (needs sun) to 1 (deep shade). Default 0.5. */
  readonly shade?: number;
  readonly suitability?: Partial<
    Record<'temperature' | 'rainfall' | 'moisture' | 'slope' | 'height' | 'waterDistance', Range>
  >;
  readonly alignToGround?: number;
  readonly sink?: number;
  readonly lod?: readonly [near: number, mid: number, far: number];
  readonly color?: ColorVariation;
  readonly tags?: readonly string[];
}

/** A per-frame detail species (grass, flowers, pebbles), drawn from a density map. */
export interface DetailRule {
  readonly id: string;
  readonly mesh: string;
  /** Instances per square metre at full suitability. */
  readonly density: number;
  readonly suitability?: SpeciesRule['suitability'];
  /** Canopy light range 0..1 where it grows. */
  readonly light?: Range;
  readonly blades?: boolean;
}

/** A biome as plain, JSON-serialisable data. */
export interface BiomeDefinition {
  /** Unique id, `[a-z0-9-]`, such as `'temperate'`. */
  readonly id: string;
  readonly climate: ClimateEnvelope;
  /** Up to 4 ground materials, blended by their rules. */
  readonly ground: readonly GroundLayer[];
  readonly plants?: readonly SpeciesRule[];
  readonly rocks?: readonly SpeciesRule[];
  readonly props?: readonly SpeciesRule[];
  readonly details?: readonly DetailRule[];
  /** Wind strength and detail 0..1. Default 0.4 and 0.3. */
  readonly wind?: { readonly strength: number; readonly detail?: number };
  readonly tint?: ColorVariation;
  /** Breaks equal weights (higher wins). Default 0. */
  readonly priority?: number;
  /** Whittaker biome classes or Holdridge life zones this biome stands for (the `'whittaker'` and `'holdridge'`
   * classifiers weight biomes by them; see `WHITTAKER` and `holdridgeZone`). */
  readonly zones?: readonly string[];
}

/** Envelope fields: layer, conversion from plain units to stored units, and the blend width of an open range. */
const FIELDS: Readonly<Record<string, readonly [layer: string, toStored: number | 'slope', open: number]>> = {
  temperature: ['temperature', 100, 1.5],
  coldest: ['coldest', 100, 2],
  warmest: ['warmest', 100, 1.5],
  gdd5: ['gdd5', 1, 150],
  season: ['season', 1, 10],
  treeline: ['treeline', 100, 0.5],
  rainfall: ['rainfall', 1, 100],
  moistureIndex: ['alpha', 255, 0.06],
  moisture: ['moisture', 255, 0.06],
  height: ['height', 1000, 50],
  slope: ['slope', 'slope', 3],
  exposure: ['exposure', 255, 0.06],
  soil: ['soil', 100, 0.1],
  waterDistance: ['waterDistance', 10, 20],
  curvature: ['curvature', 10000, 0.01],
};

/** One quantised envelope dimension: stored-unit bounds (open sides are +-2^31) and blend width (at least 1). */
export interface Dimension {
  readonly layer: string;
  readonly lo: number;
  readonly hi: number;
  readonly width: number;
}

/** Slope degrees to Q8.8 tan by CORDIC (deterministic), capped at 128. */
function slopeTan(degrees: number): number {
  if (degrees >= 89.5) return 32767;
  const sc = sincos(degreesToAngle(Math.max(0, degrees)), [0, 0]);
  return clampInt(qdiv(sc[1], sc[0]) >> 8, 0, 32767);
}

const isRange = (r: unknown): r is Range =>
  Array.isArray(r) &&
  r.length === 2 &&
  r.every((v) => v === null || (typeof v === 'number' && Number.isFinite(v))) &&
  !(r[0] !== null && r[1] !== null && r[0] > r[1]);

/** Quantises one range on a field (plain units) to a stored-unit dimension. */
export function dimension(field: string, range: Range, blend: number): Dimension {
  let layer: string, toStored: number | 'slope', open: number;
  if (field in FIELDS) [layer, toStored, open] = FIELDS[field];
  else if (field.startsWith('mask/')) [layer, toStored, open] = [field, 255, 0.06];
  else if (field in LAYERS)
    [layer, toStored, open] = [field, 1 / LAYERS[field].scale, 3 * LAYERS[field].scale]; // float division: option units
  else throw rangeError('Unknown envelope field; use a ClimateEnvelope field, a LAYERS name or mask/<name>', 'biomes');
  const store = (v: number) =>
    toStored === 'slope' ? slopeTan(v) : clampInt(Math.round(v * toStored), -2147483647, 2147483647);
  const [min, max] = range,
    lo = min === null ? -2147483648 : store(min),
    hi = max === null ? 2147483647 : store(max),
    plain = min !== null && max !== null ? (max - min) * blend : open * (blend / 0.15),
    width = Math.max(1, toStored === 'slope' ? slopeTan(plain) || 1 : Math.round(plain * toStored));
  return { layer, lo, hi, width };
}

/** The quantised envelope of a definition. */
export function envelopeOf(definition: BiomeDefinition): readonly Dimension[] {
  const c = definition.climate,
    blend = c.blend ?? 0.15,
    dims: Dimension[] = [];
  for (const field of Object.keys(FIELDS))
    if (field !== 'curvature' && c[field as keyof ClimateEnvelope] !== undefined)
      dims.push(dimension(field, c[field as keyof ClimateEnvelope] as Range, blend));
  for (const [field, range] of Object.entries(c.custom ?? {})) dims.push(dimension(field, range, blend));
  return dims;
}

const ID = /^[a-z0-9][a-z0-9-]*$/;

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const v of Object.values(value)) deepFreeze(v);
    Object.freeze(value);
  }
  return value;
}

function species(list: unknown, what: string): void {
  if (list === undefined) return;
  if (!Array.isArray(list)) throw typeError(`Biome ${what} must be an array of species rules`, 'biomes');
  for (const s of list as SpeciesRule[]) {
    if (!s || typeof s.id !== 'string' || typeof s.mesh !== 'string')
      throw typeError('A species rule needs a string id and mesh', 'biomes');
    if (!(s.density >= 0) || !(s.radius > 0) || (s.shade !== undefined && !(s.shade >= 0 && s.shade <= 1)))
      throw rangeError('A species rule needs density 0 or more, radius above 0 and shade 0..1', 'biomes');
  }
}

/**
 * Validates a biome definition and returns a deep-frozen copy (JSON round trip, so it can be saved and shared).
 * @throws TypeError for a wrong shape; RangeError for a value out of range.
 * @example
 * const heath = defineBiome({ id: 'heath', climate: { moistureIndex: [0.4, 0.8] }, ground: [{ material: 'heather' }] });
 */
export function defineBiome(definition: BiomeDefinition): BiomeDefinition {
  if (!definition || typeof definition !== 'object')
    throw typeError('defineBiome takes a biome definition object', 'biomes');
  const d = JSON.parse(JSON.stringify(definition)) as BiomeDefinition;
  if (typeof d.id !== 'string' || !ID.test(d.id))
    throw typeError('A biome id must be a string of a-z, 0-9 and -, such as "temperate"', 'biomes');
  if (!d.climate || typeof d.climate !== 'object') throw typeError('A biome needs a climate envelope object', 'biomes');
  const blend = d.climate.blend ?? 0.15;
  if (!(blend > 0 && blend <= 1)) throw rangeError('A biome envelope blend must be in 0..1 (above 0)', 'biomes');
  for (const [field, range] of Object.entries(d.climate)) {
    if (field === 'blend') continue;
    if (field === 'custom') {
      for (const [name, r] of Object.entries(range as Record<string, unknown>))
        if (!isRange(r))
          throw rangeError('A biome envelope range is [min, max] with min <= max (null leaves a side open)', 'biomes');
        else dimension(name, r, blend);
      continue;
    }
    if (!(field in FIELDS) || field === 'curvature')
      throw rangeError('Unknown envelope field; use a ClimateEnvelope field, a LAYERS name or mask/<name>', 'biomes');
    if (!isRange(range))
      throw rangeError('A biome envelope range is [min, max] with min <= max (null leaves a side open)', 'biomes');
  }
  if (!Array.isArray(d.ground) || d.ground.length < 1 || d.ground.length > 4)
    throw rangeError('A biome needs 1 to 4 ground layers', 'biomes');
  for (const g of d.ground) {
    if (!g || typeof g.material !== 'string') throw typeError('A ground layer needs a string material', 'biomes');
    for (const key of ['slope', 'height', 'moisture', 'curvature'] as const)
      if (g[key] !== undefined && !isRange(g[key]))
        throw rangeError('A biome envelope range is [min, max] with min <= max (null leaves a side open)', 'biomes');
    if (g.weight !== undefined && !(g.weight >= 0))
      throw rangeError('A ground layer weight must be 0 or more', 'biomes');
  }
  species(d.plants, 'plants');
  species(d.rocks, 'rocks');
  species(d.props, 'props');
  if (d.details !== undefined && !Array.isArray(d.details))
    throw typeError('Biome details must be an array of detail rules', 'biomes');
  if (d.priority !== undefined && !Number.isFinite(d.priority))
    throw rangeError('A biome priority must be a finite number', 'biomes');
  if (d.zones !== undefined && (!Array.isArray(d.zones) || !d.zones.every((z) => typeof z === 'string')))
    throw typeError('Biome zones must be an array of class or life-zone names', 'biomes');
  return deepFreeze(d);
}
