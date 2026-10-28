// Climate settings and the closed-form climate maths of a biome world, all in integers (spec 2.2, decision D9).
// Temperatures are centi-degrees Celsius (cK above 0 C), heights millimetres, rainfall millimetres per year.
// Sources: lapse rates, Minder, Mote and Lundquist 2010 (surface lapse shallower than 6.5 K/km, day steeper than night);
// seasonal amplitude growing with latitude and continentality, Gorczynski and Conrad (ocean range about 12 sin(lat) K);
// growing degree days of a sinusoidal year, the standard closed-form integral; treeline, Korner and Paulsen 2004 and
// Korner 2012 (growing-season mean 6.4 C over at least 94 days above 0.9 C); potential evapotranspiration, Hargreaves
// with FAO-56 extraterrestrial radiation (Allen et al. 1998, chapter 3); moisture index AET/PET from Fu's form of
// Budyko's curve (w = 2.6); heat load folded about the north-east to south-west axis, McCune and Keon 2002.
import { rangeError, typeError } from '../../shared/errors.js';
import {
  atan2,
  clampInt,
  degreesToAngle,
  divFloor,
  divWide,
  isqrt,
  ONE,
  qdiv,
  qexp2,
  qmul,
  qacos,
  qpow,
  qsqrt,
  sincos,
  TURN,
} from './fixed.js';

/** Climate settings of a biome world. Every value is documented with its default; all are quantised once. */
export interface ClimateOptions {
  /** Latitude in degrees, -89..89. Default 45. */
  readonly latitude?: number;
  /** Sea level in metres. Default 0. */
  readonly seaLevel?: number;
  /** Mean surface lapse rate in K per km, 0..12. Default 5.0 (observed surface rates; 6.5 is the free atmosphere). */
  readonly lapseRate?: number;
  /** Day (Tmax) minus night (Tmin) lapse rate in K per km, 0..8. Default 3 (6.5 by day, 3.5 by night). */
  readonly lapseSplit?: number;
  /** Mean annual sea-level temperature at the equator in C. Default 27. */
  readonly equatorTemperature?: number;
  /** Mean annual sea-level temperature at the poles in C. Default -20. */
  readonly poleTemperature?: number;
  /** Rainfall in mm per year before orography, 0..12,000. Default 900. */
  readonly rainfall?: number;
  /** Prevailing wind direction (where the air goes) as [x, z]. Default from the latitude band: trade easterlies below
   * 30 degrees, westerlies to 60, polar easterlies beyond. */
  readonly wind?: readonly [x: number, z: number];
  /** Rain shadow strength 0..1: the share of moisture a 1,500 m rise wrings out. Default 0.6. */
  readonly rainShadow?: number;
  /** Over-land distance in km from the sea to the world's upwind edge when no sea is upwind, 0..5,000. Default 500. */
  readonly inland?: number;
  /** Largest night cooling of cold-air pools in K, 0..10 (0 turns pooling off). Default 3. */
  readonly coldAir?: number;
  /** When the rain falls: `'auto'` (from the latitude band and wind), `'uniform'`, `'summer'` or `'winter'` (a wet
   * season 85 % above the monthly mean, a dry one 85 % below). Read by the Koppen label view only. Default `'auto'`. */
  readonly rainSeason?: 'auto' | 'uniform' | 'summer' | 'winter';
}

/** Climate settings quantised to integers, plus the world constants derived from them. */
export interface Climate {
  readonly latitude: number; // binary angle
  readonly sea: number; // mm
  readonly lapseDay: number; // cK per km
  readonly lapseNight: number; // cK per km
  readonly seaTemperature: number; // cK, mean annual at sea level for this latitude
  readonly rainfall: number; // mm per year
  readonly wind: readonly [number, number]; // Q16 unit vector
  readonly shadow: number; // Q16
  readonly inland: number; // mm
  readonly coldAir: number; // cK
  readonly rainSeason: 'uniform' | 'summer' | 'winter';
  readonly warm: readonly [number, number]; // Q16 north and east components of the warmest aspect
  readonly sinLatitude: number; // Q16, |sin(latitude)|
  /** Hargreaves year sums: sum of daily Ra (kJ per m2) and sum of cos(day phase) Ra. */
  readonly radiation: readonly [number, number];
}

const SEASONS = ['auto', 'uniform', 'summer', 'winter'];

/**
 * Validates and quantises climate settings (plain arithmetic and CORDIC, so every engine gets the same integers).
 * @throws TypeError when `options` is not an object; RangeError when a value is out of range.
 */
export function quantizeClimate(options: ClimateOptions = {}): Climate {
  if (typeof options !== 'object' || options === null)
    throw typeError('Climate options must be an object; pass {} for the defaults', 'biomes');
  const lat = options.latitude ?? 45,
    lapse = options.lapseRate ?? 5,
    split = options.lapseSplit ?? 3,
    teq = options.equatorTemperature ?? 27,
    tpole = options.poleTemperature ?? -20,
    rain = options.rainfall ?? 900,
    shadow = options.rainShadow ?? 0.6,
    inland = options.inland ?? 500,
    cold = options.coldAir ?? 3,
    season = options.rainSeason ?? 'auto',
    sea = options.seaLevel ?? 0;
  const inRange = (v: number, lo: number, hi: number) => typeof v === 'number' && v >= lo && v <= hi;
  if (
    !inRange(lat, -89, 89) ||
    !inRange(lapse, 0, 12) ||
    !inRange(split, 0, 8) ||
    split / 2 > lapse ||
    !inRange(teq, -60, 60) ||
    !inRange(tpole, -90, 60) ||
    tpole > teq ||
    !inRange(rain, 0, 12000) ||
    !inRange(shadow, 0, 1) ||
    !inRange(inland, 0, 5000) ||
    !inRange(cold, 0, 10) ||
    !inRange(sea, -11000, 9000) ||
    !SEASONS.includes(season)
  )
    throw rangeError(
      'Invalid climate options; latitude -89..89, lapseRate 0..12 with lapseSplit 0..8 at most twice it, equator and pole temperatures with the pole colder, rainfall 0..12,000, rainShadow 0..1, inland 0..5,000 km, coldAir 0..10 K and rainSeason auto/uniform/summer/winter',
      'biomes',
    );
  const latitude = degreesToAngle(lat),
    sc = sincos(latitude, [0, 0]),
    s = Math.abs(sc[1]),
    // Mean annual sea-level temperature: the textbook T_eq - (T_eq - T_pole) sin^2(lat) plus 28 K sin^2 cos^2. The
    // sin^2 form alone runs 5 to 7 K too cold from 30 to 60 degrees against observed zonal means; the second term (our
    // fit, documented in the README) closes that gap and vanishes at the equator and the poles.
    s2 = qmul(s, s),
    seaTemperature =
      Math.round(teq * 100) -
      Math.floor((Math.round((teq - tpole) * 100) * s2) / ONE) +
      Math.floor((2800 * s2 * (ONE - s2)) / 4294967296);
  let wind: [number, number];
  if (options.wind !== undefined) {
    const w = options.wind;
    if (!Array.isArray(w) || w.length !== 2 || !w.every(Number.isFinite) || (w[0] === 0 && w[1] === 0))
      throw rangeError('Climate wind must be a non-zero [x, z] direction', 'biomes');
    // Normalise in integers: scale to about 2^16 and divide by the integer length.
    const m = Math.max(Math.abs(w[0]), Math.abs(w[1])),
      x = Math.round((w[0] / m) * 46341), // float division: quantising the option once
      z = Math.round((w[1] / m) * 46341), // float division
      len = isqrt(x * x + z * z);
    wind = [divFloor(x * ONE, len), divFloor(z * ONE, len)];
  } else wind = Math.abs(lat) < 30 || Math.abs(lat) >= 60 ? [-ONE, 0] : [ONE, 0];
  const auto = Math.abs(lat) < 25 ? 'summer' : Math.abs(lat) < 45 && wind[0] > 0 ? 'winter' : 'uniform';
  return Object.freeze({
    latitude,
    sea: Math.round(sea * 1000),
    lapseDay: Math.round((lapse + split / 2) * 100),
    lapseNight: Math.round((lapse - split / 2) * 100),
    seaTemperature,
    rainfall: Math.round(rain),
    wind: Object.freeze(wind) as readonly [number, number],
    shadow: Math.round(shadow * ONE),
    inland: Math.round(inland * 1e6),
    coldAir: Math.round(cold * 100),
    rainSeason: season === 'auto' ? auto : season,
    warm: Object.freeze(sincos(degreesToAngle(lat >= 0 ? 225 : 315), [0, 0])) as readonly [number, number],
    sinLatitude: s,
    radiation: yearRadiation(latitude, lat >= 0 ? 201 : 19),
  }) as Climate;
}

/** pi in Q16. */
const PI = 205887;
const angleToRadians = (angle: number) => Math.floor((angle * 411775) / 4294967296); // 2 pi 2^16 / 2^32

/**
 * FAO-56 extraterrestrial radiation summed over a year at one latitude (kJ per m2), and the same sum weighted by the
 * cosine of the day's distance from the warmest day: the two constants Hargreaves' annual PET needs over a sinusoidal
 * year. Integer CORDIC throughout.
 */
function yearRadiation(latitude: number, warmest: number): [number, number] {
  const out = [0, 0],
    lat = sincos(latitude, [0, 0]);
  let s0 = 0,
    s1 = 0;
  for (let day = 1; day <= 365; day++) {
    const phase = Math.floor((day * TURN) / 365) | 0;
    sincos(phase, out);
    const dr = ONE + Math.floor((out[0] * 2163) / ONE); // 1 + 0.033 cos
    // Declination 0.409 sin(2 pi J / 365 - 1.39) radians, as a binary angle.
    sincos((phase - 950155733) | 0, out); // 1.39 rad = 950,155,733 binary-angle units
    const decl = Math.floor((out[1] * 26805) / ONE), // 0.409 rad in Q16 is 26,805
      d = sincos(Math.floor((decl * 683565276) / 65536) | 0, [0, 0]); // radians Q16 to binary angle (2^32 / 2 pi)
    // Sunset hour angle acos(-tan(lat) tan(decl)), clamped for polar day and night.
    const num = lat[1] * d[1],
      den = lat[0] * d[0],
      tt = den ? -divWide(num * ONE, den) : 0,
      x = clampInt(tt, -ONE, ONE),
      ws = atan2(qsqrt(ONE - qmul(x, x)), x) >>> 0,
      wsr = angleToRadians(ws),
      sinws = qsqrt(ONE - qmul(x, x)),
      term =
        Math.floor((wsr * Math.floor((lat[1] * d[1]) / ONE)) / ONE) +
        Math.floor((Math.floor((lat[0] * d[0]) / ONE) * sinws) / ONE);
    // Ra = (24 * 60 / pi) Gsc dr term, Gsc = 0.0820 MJ m-2 min-1: 37.586 dr term MJ, in kJ.
    const ra = Math.max(0, Math.floor((Math.floor((dr * term) / ONE) * 37586) / ONE));
    s0 += ra;
    sincos(Math.floor(((day - warmest) * TURN) / 365) | 0, out);
    s1 += Math.floor((ra * out[0]) / ONE);
  }
  return [s0, s1];
}

/** Half the annual temperature swing in cK: 6 |sin lat| (1 + 3 C) K for continentality C (Q16, 0..1). */
export function halfAmplitude(climate: Climate, continentality: number): number {
  return Math.floor((600 * climate.sinLatitude * (ONE + 3 * continentality)) / 4294967296);
}

/** Continentality C = 1 - exp(-d / 1,500 km) in Q16 for an over-land distance d in metres. */
export function continentality(distance: number): number {
  // exp(-d / L) = 2^(-d log2(e) / L); log2(e) / 1,500 km in Q16 per metre is 94,548 / 1.5e6.
  return ONE - qexp2(-Math.min(15 * ONE, Math.floor((Math.max(0, distance) * 94548) / 1_500_000)));
}

/**
 * Degree days above `base` (cK) of a sinusoidal year with mean `mean` and half swing `half` (cK), and the days above
 * `base`: the closed-form integral `(365 / pi)((mean - base) theta + half sin theta)`, theta = acos((base - mean) / half).
 * Writes `[degreeDays, days]` (degree days in C day, days 0..365) into `out`.
 */
export function degreeDays<T extends { [index: number]: number }>(mean: number, half: number, base: number, out: T): T {
  const over = mean - base;
  if (half <= 0 || over >= half || -over >= half) {
    const above = over > 0 && (half <= 0 || over >= half);
    out[0] = above ? Math.floor((365 * over) / 100) : 0;
    out[1] = above ? 365 : 0;
    return out;
  }
  const x = qdiv(-over, half),
    s = qsqrt(ONE - qmul(x, x)),
    theta = qacos(x),
    n = over * theta + half * s;
  out[0] = Math.max(0, divFloor(n * 365, PI * 100));
  out[1] = divFloor(theta * 365, PI);
  return out;
}

/** Mean temperature of the days above `base` (cK), or `base` when there are none. */
export function seasonMean(degree: number, days: number, base: number): number {
  return days > 0 ? base + divFloor(degree * 100, days) : base;
}

/** Korner's thermal treeline margin in cK: min(Tgs - 6.4 C, (days - 94) x 1 K / 30 days); 0 or more allows trees. */
export function treelineMargin(seasonTemperature: number, days: number): number {
  return Math.min(seasonTemperature - 640, divFloor((days - 94) * 100, 30));
}

/**
 * Annual Hargreaves PET in mm over a sinusoidal year: 0.0023 x 0.408 sqrt(DTR) ((T + 17.8) S0 + a S1), with mean T,
 * half swing a and diurnal range DTR in cK, and the year sums of {@link Climate.radiation}. 0 or more.
 */
export function evapotranspiration(climate: Climate, mean: number, half: number, range: number): number {
  const [s0, s1] = climate.radiation,
    term = divFloor((mean + 1780) * s0 + half * s1, 1000), // 1e-2 K MJ
    root = isqrt(Math.max(0, range) * 10000); // sqrt(DTR in K) x 1000
  return Math.max(0, divFloor(term * root * 9384, 1e12));
}

/** 1 / 2.6 and 2.6 in Q16 (Fu's w). */
const W = 170394,
  INVERSE_W = 25206;

/**
 * Moisture index alpha = AET / PET in Q16 (0..1) from Fu's form of the Budyko curve,
 * E / P = 1 + phi - (1 + phi^w)^(1/w) with dryness phi = PET / P and w = 2.6.
 */
export function moistureIndex(pet: number, rainfall: number): number {
  if (pet <= 0) return ONE;
  if (rainfall <= 0) return 0;
  const phi = Math.min(2047 * ONE, divFloor(pet * ONE, rainfall));
  // Very dry: E is all of P, so alpha = 1 / phi (the curve is within 1e-4 of it there).
  if (phi >= 16 * ONE) return qdiv(ONE, phi);
  if (phi < 64) return ONE;
  const ratio = ONE + phi - qpow(ONE + qpow(phi, W), INVERSE_W);
  return clampInt(qdiv(ratio, phi), 0, ONE);
}

/**
 * Heat load in Q16, -1..1: cos(aspect - warmest aspect) x min(1, tan(slope) / tan(30 degrees)), from the downslope
 * gradient: `gx` and `gz` are the east and south height gradients (any common scale), slope is Q8.8 tan.
 */
export function heatLoad(climate: Climate, gx: number, gz: number, slope: number): number {
  if (slope <= 0 || (gx === 0 && gz === 0)) return 0;
  // Downslope direction: north component gz, east component -gx.
  const [wc, ws] = climate.warm,
    c = divWide(gz * wc - gx * ws, isqrt(Math.min(68719476736, gx * gx + gz * gz)) || 1);
  return Math.floor((clampInt(c, -ONE, ONE) * Math.min(ONE, divFloor(slope * ONE, 148))) / ONE); // tan 30 = 148 / 256
}
