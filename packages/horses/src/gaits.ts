// Horse gaits from equine biomechanics: which gait a speed takes, the stride length and frequency it has, when each
// hoof strikes and lifts, and how the trunk rises and pitches through the stride. Pure functions of the phase, so a
// film that seeks gets the same pose as one that plays.
// - Footfall timing (lateral sequence walk, diagonal trot), lags and duty factors: M. Hildebrand, "Symmetrical gaits of
//   horses", Science 150(3697):701-708, 1965. Canter and transverse gallop sequences and lags: M. Hildebrand,
//   "Analysis of asymmetrical gaits", Journal of Mammalogy 58(2):131-156, 1977.
// - Stride length against speed: R. McN. Alexander and A. S. Jayes, "A dynamic similarity hypothesis for the gaits of
//   quadrupedal mammals", Journal of Zoology 201:135-152, 1983: relative stride length lambda/h = 2.3 (u^2/gh)^0.3, h
//   the hip joint height. Gait changes by Froude number u^2/gh: R. McN. Alexander, "Optimization and gaits in the
//   locomotion of vertebrates", Physiological Reviews 69(4):1199-1227, 1989; preferred speeds within each gait:
//   D. F. Hoyt and C. R. Taylor, "Gait and the energetics of locomotion in horses", Nature 292:239-240, 1981; stride
//   frequency by size: N. C. Heglund, C. R. Taylor and T. A. McMahon, "Scaling stride frequency and gait to animal size:
//   mice to horses", Science 186:1112-1113, 1974.
// - Trot stance, suspension and stride by speed: H. M. Clayton, "Comparison of the stride kinematics of the collected,
//   working, medium and extended trot in horses", Equine Veterinary Journal 26(3):230-234, 1994; canter: H. M.
//   Clayton, "The extended canter: a comparison of some kinematic variables in horses trained for dressage and for
//   racing", Acta Anatomica 146:183-187, 1993.
// - Trunk vertical motion (two cycles a stride at walk and trot, one at canter and gallop, about 8 to 10 cm at the
//   trot): H. H. F. Buchner, H. H. C. M. Savelberg, H. C. Schamhardt and A. Barneveld, "Head and trunk movement
//   adaptations in horses with experimentally induced fore- or hindlimb lameness", Equine Veterinary Journal
//   28(1):71-76, 1996.
import type { HorseBody } from './anatomy.js';

/** The four natural gaits. */
export type Gait = 'walk' | 'trot' | 'canter' | 'gallop';
/** Every gait, slowest first. */
export const GAITS: readonly Gait[] = ['walk', 'trot', 'canter', 'gallop'];
/** A hoof: left or right, hind or fore. */
export type Hoof = 'LH' | 'LF' | 'RH' | 'RF';
/** The four hooves in the order every per-hoof array uses. */
export const HOOVES: readonly Hoof[] = ['LH', 'LF', 'RH', 'RF'];

/** Footfall pattern of one gait (left lead for canter and gallop). */
export interface GaitPattern {
  /** Phase of the stride, 0 to 1, at which each hoof strikes the ground, in {@link HOOVES} order. */
  readonly strike: readonly [number, number, number, number];
  /** Froude numbers u^2/gh where the gait starts and ends. */
  readonly froude: readonly [number, number];
  /** Duty factor (stance time over stride time) at the slow and fast end of the gait. */
  readonly duty: readonly [number, number];
  /** Froude number of the gait's preferred speed, where its clip is baked. */
  readonly preferred: number;
  /** Trunk rises and falls this many times a stride. */
  readonly bounces: 1 | 2;
  /** Trunk vertical motion, peak to peak, as a ratio of withers height. */
  readonly rise: number;
  /** Trunk pitch, peak to peak, radians (the rocking of the canter and gallop). */
  readonly pitch: number;
  /** Swing hoof lift, fore and hind, as a ratio of withers height. */
  readonly lift: readonly [number, number];
  /** Head and neck nod, peak to peak, radians. */
  readonly nod: number;
}

/**
 * The published patterns. Walk: lateral sequence, each fore hoof a quarter stride after the hind of its side, duty 0.75
 * to 0.6, never fewer than two hooves down. Trot: diagonal pairs half a stride apart, duty 0.48 to 0.36, two short
 * suspensions. Canter (left lead): trailing hind, the diagonal pair (leading hind just before trailing fore), leading
 * fore, one suspension. Gallop (left lead, transverse): trailing hind, leading hind, trailing fore, leading fore, one
 * long suspension.
 */
export const GAIT_PATTERNS: Readonly<Record<Gait, GaitPattern>> = {
  walk: { strike: [0, 0.25, 0.5, 0.75], froude: [0, 0.4], duty: [0.75, 0.6], preferred: 0.24, bounces: 2, rise: 0.025, pitch: 0.02, lift: [0.08, 0.07], nod: 0.12 },
  trot: { strike: [0, 0.5, 0.5, 0], froude: [0.4, 2.4], duty: [0.48, 0.36], preferred: 1.5, bounces: 2, rise: 0.05, pitch: 0.015, lift: [0.17, 0.13], nod: 0.03 },
  canter: { strike: [0.24, 0.5, 0, 0.28], froude: [2.4, 6.5], duty: [0.46, 0.36], preferred: 4.6, bounces: 1, rise: 0.065, pitch: 0.14, lift: [0.18, 0.15], nod: 0.16 },
  gallop: { strike: [0.11, 0.47, 0, 0.36], froude: [6.5, 40], duty: [0.32, 0.22], preferred: 18, bounces: 1, rise: 0.055, pitch: 0.1, lift: [0.22, 0.18], nod: 0.2 },
};

/** Standard gravity, m/s^2. */
export const GRAVITY = 9.80665;

const hipHeight = (body: Pick<HorseBody, 'hipJoint'>): number => {
  const h = body?.hipJoint;
  if (!(h > 0) || !Number.isFinite(h)) throw new TypeError('Gait functions need a horseBody() (its hipJoint height)');
  return h;
};
const speedOf = (speed: number): number => {
  if (!(speed >= 0) || !Number.isFinite(speed)) throw new RangeError('A gait speed must be a finite number of metres per second, 0 or more');
  return speed;
};

/** Froude number u^2/gh of a speed for this horse (h its hip joint height). */
export function froude(body: Pick<HorseBody, 'hipJoint'>, speed: number): number {
  return speedOf(speed) ** 2 / (GRAVITY * hipHeight(body));
}

/** The speed in m/s of a Froude number for this horse. */
export function speedAtFroude(body: Pick<HorseBody, 'hipJoint'>, fr: number): number {
  if (!(fr >= 0) || !Number.isFinite(fr)) throw new RangeError('speedAtFroude needs a finite Froude number, 0 or more');
  return Math.sqrt(fr * GRAVITY * hipHeight(body));
}

/** The gait a horse takes at this speed (by Froude number, so a pony changes gait sooner than a Shire). */
export function gaitFor(body: Pick<HorseBody, 'hipJoint'>, speed: number): Gait {
  const fr = froude(body, speed);
  for (const g of GAITS) if (fr < GAIT_PATTERNS[g].froude[1]) return g;
  return 'gallop';
}

/** The gait's preferred speed for this horse, m/s: where its clip is baked. */
export function preferredSpeed(body: Pick<HorseBody, 'hipJoint'>, gait: Gait): number {
  const p = GAIT_PATTERNS[gait];
  if (!p) throw new TypeError(`Unknown gait; use one of ${GAITS.join(', ')}`);
  return speedAtFroude(body, p.preferred);
}

/** Stride length in metres at this speed: lambda = 2.3 h (u^2/gh)^0.3 (Alexander and Jayes 1983). 0 at rest. */
export function strideLength(body: Pick<HorseBody, 'hipJoint'>, speed: number): number {
  const fr = froude(body, speed);
  return fr === 0 ? 0 : 2.3 * hipHeight(body) * fr ** 0.3;
}

/** Strides per second at this speed: speed over stride length. */
export function strideFrequency(body: Pick<HorseBody, 'hipJoint'>, speed: number): number {
  const s = strideLength(body, speed);
  return s === 0 ? 0 : speed / s;
}

/** Everything one stride needs: the gait, the timing and the reach. */
export interface Stride {
  readonly gait: Gait;
  readonly speed: number;
  /** Metres covered in one stride. */
  readonly length: number;
  /** Seconds per stride. */
  readonly duration: number;
  /** Stance time over stride time, the same for all four hooves. */
  readonly duty: number;
  /** Strike phase of each hoof in {@link HOOVES} order. */
  readonly strike: readonly [number, number, number, number];
  readonly pattern: GaitPattern;
}

/**
 * The stride at this speed. `gait` forces a gait (a slow canter, a fast walk); left out it follows the speed.
 * @throws RangeError for a speed that is not finite and positive.
 */
export function stride(body: HorseBody, speed: number, gait: Gait = gaitFor(body, speed)): Stride {
  if (!(speed > 0)) throw new RangeError('stride needs a speed above 0 m/s; a standing horse has no stride');
  const pattern = GAIT_PATTERNS[gait];
  if (!pattern) throw new TypeError(`Unknown gait; use one of ${GAITS.join(', ')}`);
  const fr = froude(body, speed),
    [a, b] = pattern.froude,
    t = Math.min(1, Math.max(0, (fr - a) / (b - a))),
    duty = pattern.duty[0] + (pattern.duty[1] - pattern.duty[0]) * t,
    length = strideLength(body, speed);
  return { gait, speed, length, duration: length / speed, duty, strike: pattern.strike, pattern };
}

const wrap = (x: number): number => x - Math.floor(x);

/**
 * Where a hoof is in its cycle at stride phase `phase` (0 to 1): `stance` true while it bears weight, and `t` running 0
 * to 1 through the stance or through the swing.
 */
export function hoofPhase(s: Pick<Stride, 'duty' | 'strike'>, hoof: number, phase: number): { stance: boolean; t: number } {
  const local = wrap(phase - s.strike[hoof]);
  return local < s.duty ? { stance: true, t: local / s.duty } : { stance: false, t: (local - s.duty) / (1 - s.duty) };
}

/** How many hooves are on the ground at this phase. */
export function hoovesDown(s: Pick<Stride, 'duty' | 'strike'>, phase: number): number {
  let n = 0;
  for (let i = 0; i < 4; i++) if (hoofPhase(s, i, phase).stance) n++;
  return n;
}

/** Phase of the lowest trunk point: the middle of the support, where the most weight is on the legs. */
function lowPhase(s: Stride): number {
  if (s.pattern.bounces === 2) return wrap(s.strike[0] + s.duty / 2);
  // Circular mean of the four stance midpoints.
  let x = 0,
    y = 0;
  for (let i = 0; i < 4; i++) {
    const a = 2 * Math.PI * (s.strike[i] + s.duty / 2);
    x += Math.cos(a);
    y += Math.sin(a);
  }
  return wrap(Math.atan2(y, x) / (2 * Math.PI));
}

/** Trunk motion at a stride phase: height offset (m), pitch (radians, nose down positive) and head nod (radians). */
export interface TrunkMotion {
  readonly rise: number;
  readonly pitch: number;
  readonly nod: number;
}

/**
 * The trunk's rise and pitch at stride phase `phase`: lowest at mid-support, `bounces` cycles a stride, peak to peak
 * `pattern.rise` times the withers height. The canter and gallop rock: the forehand rises as the hind legs push.
 */
export function trunkMotion(body: HorseBody, s: Stride, phase: number): TrunkMotion {
  const low = lowPhase(s),
    k = s.pattern.bounces,
    a = 2 * Math.PI * k * (phase - low),
    amp = (s.pattern.rise * body.withers) / 2;
  return {
    rise: -amp * Math.cos(a),
    pitch: (s.pattern.pitch / 2) * Math.sin(2 * Math.PI * (phase - low)),
    nod: (s.pattern.nod / 2) * Math.cos(a + 0.6),
  };
}
