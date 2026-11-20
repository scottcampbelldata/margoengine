// Horse anatomy from published equine measurements. Every length is a ratio of the withers height H, set from:
// - body length, heart girth and the weight equation: C. L. Carroll and P. J. Huntington, "Body condition scoring and
//   weight estimation of horses", Equine Veterinary Journal 20(1):41-45, 1988 (weight kg = girth cm^2 x length cm /
//   11880, length from the point of the shoulder to the point of the buttock);
// - segment lengths (arm, forearm, cannon, pastern; thigh, gaskin, hind cannon) and joint heights: H. H. F. Buchner,
//   H. H. C. M. Savelberg, H. C. Schamhardt and A. Barneveld, "Inertial properties of Dutch Warmblood horses", Journal
//   of Biomechanics 30(6):653-658, 1997, scaled by withers height;
// - withers height, body and limb proportions by breed group: S. A. Brooks et al., "Morphological variation in the
//   horse: defining complex traits of body size and shape", Animal Genetics 41(s2):159-165, 2010, and M. Holmstroem,
//   L.-E. Magnusson and J. Philipsson, "Variation in conformation of Swedish Warmblood horses and conformational
//   characteristics of elite sport horses", Equine Veterinary Journal 22(3):186-193, 1990.
// The three types are a riding horse (Thoroughbred build), a cavalry remount (the 15 to 16 hand, 950 to 1,200 lb horse
// of the remount services) and a heavy draft horse (Shire, Clydesdale, Percheron build).

/** Breed group: a draft horse, a cavalry remount or a riding horse. */
export type HorseType = 'draft' | 'cavalry' | 'riding';

/** Every horse type, in panel order. */
export const HORSE_TYPES: readonly HorseType[] = ['riding', 'cavalry', 'draft'];

/** Proportions of one breed group: `withers` in metres, every other length as a ratio of it. */
export interface HorseProportions {
  /** Height at the withers, metres. */
  readonly withers: number;
  /** Point of shoulder to point of buttock. */
  readonly bodyLength: number;
  /** Height at the top of the croup. */
  readonly croup: number;
  /** Heart girth, the circumference just behind the elbows. */
  readonly girth: number;
  /** Withers to sternum, the depth of the chest. */
  readonly chestDepth: number;
  /** Width across the points of the shoulders. */
  readonly chestWidth: number;
  /** Width across the points of the hips. */
  readonly hipWidth: number;
  /** Poll to the top lip. */
  readonly headLength: number;
  /** Poll to the withers along the crest. */
  readonly neckLength: number;
  /** Height of the elbow joint. */
  readonly elbow: number;
  /** Height of the carpus (the knee). */
  readonly knee: number;
  /** Height of the fore fetlock joint. */
  readonly foreFetlock: number;
  /** Height of the hip joint. */
  readonly hipJoint: number;
  /** Height of the stifle. */
  readonly stifle: number;
  /** Height of the point of the hock. */
  readonly hock: number;
  /** Height of the hind fetlock joint. */
  readonly hindFetlock: number;
  /** Fore cannon circumference just below the knee. */
  readonly cannon: number;
  /** Length of the tail dock (the bone). */
  readonly dock: number;
}

/**
 * Published proportions per breed group. The withers heights are the group means (riding 16 hands, cavalry 15.2,
 * draft 17.1); the ratios give each group its build: the draft horse's deeper chest, wider barrel, shorter legs for its
 * height and heavier cannon.
 */
export const HORSE_PROPORTIONS: Readonly<Record<HorseType, HorseProportions>> = {
  riding: {
    withers: 1.63,
    bodyLength: 1.03,
    croup: 1.0,
    girth: 1.14,
    chestDepth: 0.45,
    chestWidth: 0.25,
    hipWidth: 0.33,
    headLength: 0.37,
    neckLength: 0.56,
    elbow: 0.56,
    knee: 0.31,
    foreFetlock: 0.16,
    hipJoint: 0.66,
    stifle: 0.52,
    hock: 0.37,
    hindFetlock: 0.17,
    cannon: 0.125,
    dock: 0.3,
  },
  cavalry: {
    withers: 1.57,
    bodyLength: 1.03,
    croup: 1.0,
    girth: 1.17,
    chestDepth: 0.46,
    chestWidth: 0.27,
    hipWidth: 0.34,
    headLength: 0.37,
    neckLength: 0.55,
    elbow: 0.55,
    knee: 0.3,
    foreFetlock: 0.16,
    hipJoint: 0.65,
    stifle: 0.51,
    hock: 0.36,
    hindFetlock: 0.17,
    cannon: 0.13,
    dock: 0.3,
  },
  draft: {
    withers: 1.75,
    bodyLength: 1.06,
    croup: 1.0,
    girth: 1.34,
    chestDepth: 0.5,
    chestWidth: 0.31,
    hipWidth: 0.37,
    headLength: 0.4,
    neckLength: 0.52,
    elbow: 0.51,
    knee: 0.29,
    foreFetlock: 0.15,
    hipJoint: 0.64,
    stifle: 0.49,
    hock: 0.35,
    hindFetlock: 0.16,
    cannon: 0.16,
    dock: 0.3,
  },
};

/** One horse in metres: the proportions times its withers height, and its weight. */
export interface HorseBody extends HorseProportions {
  readonly type: HorseType;
  /** Body weight in kilograms from girth and length (Carroll and Huntington 1988). */
  readonly mass: number;
}

/** Options of {@link horseBody}. */
export interface HorseBodyOptions {
  /** Breed group. Default `'riding'`. */
  type?: HorseType;
  /** Height at the withers in metres, 1.2 to 2.1. Default the group's mean. */
  withers?: number;
  /** Multiplies the girth and the body widths, 0.8 to 1.25: a lean or a heavy horse. Default 1. */
  condition?: number;
}

/** A height in hands (4 inches each, the decimal digit being inches: 15.2 hh is 15 hands 2 inches) in metres. */
export function handsToMetres(hands: number): number {
  if (!(hands > 0) || !Number.isFinite(hands)) throw new RangeError('handsToMetres needs a positive height in hands');
  const whole = Math.floor(hands),
    inches = Math.round((hands - whole) * 10);
  if (inches > 3) throw new RangeError('handsToMetres: the digit after the point is inches, 0 to 3 (15.2 is 15 hands 2 inches)');
  return (whole * 4 + inches) * 0.0254;
}

/** Weight in kilograms from heart girth and body length in metres (Carroll and Huntington 1988). */
export function horseMass(girth: number, bodyLength: number): number {
  if (!(girth > 0) || !(bodyLength > 0)) throw new RangeError('horseMass needs a positive girth and body length in metres');
  return ((girth * 100) ** 2 * (bodyLength * 100)) / 11880;
}

/**
 * A horse's measurements in metres for its type, withers height and condition.
 * @example
 * const body = horseBody({type: 'cavalry'}); // body.withers 1.57, body.mass about 455 kg
 * @throws TypeError for an unknown type; RangeError for a withers height or condition out of range.
 */
export function horseBody(options: HorseBodyOptions = {}): HorseBody {
  const type = options.type ?? 'riding',
    p = HORSE_PROPORTIONS[type];
  if (!p || !Object.hasOwn(HORSE_PROPORTIONS, type))
    throw new TypeError(`horseBody type must be one of ${HORSE_TYPES.join(', ')}`);
  const H = options.withers ?? p.withers,
    c = options.condition ?? 1;
  if (!(H >= 1.2 && H <= 2.1)) throw new RangeError('horseBody withers must be 1.2 to 2.1 metres');
  if (!(c >= 0.8 && c <= 1.25)) throw new RangeError('horseBody condition must be 0.8 to 1.25');
  const out: Record<string, number | string> = { type };
  for (const [k, v] of Object.entries(p)) out[k] = k === 'withers' ? H : v * H;
  out.girth = (out.girth as number) * c;
  out.chestWidth = (out.chestWidth as number) * c;
  out.hipWidth = (out.hipWidth as number) * c;
  out.mass = horseMass(out.girth as number, out.bodyLength as number);
  return Object.freeze(out) as unknown as HorseBody;
}
