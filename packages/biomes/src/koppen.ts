// Koppen-Geiger labels as a view over a tile's climate layers (decision D11, reversed by Scott 2026-10-28): nothing in
// classification or placement depends on it, and the root entry does not import it. Rules: Beck et al., "Present and
// future Koppen-Geiger climate classification maps at 1-km resolution", Scientific Data 2018 (after Peel, Finlayson
// and McMahon 2007): 30 classes from monthly temperature and rainfall. Months come from the world's sinusoidal year:
// T(m) = mean + A cos(2 pi (m - 6) / 12) with A half the warmest-to-coldest spread, and rainfall in the world's
// `rainSeason` regime (uniform, or a wet season 85 % above the mean and a dry one 85 % below), summer being the six warmest months.
// Integer arithmetic: temperatures in cK, rainfall in mm per month times 1,000.
import { typeError } from '../../shared/errors.js';

/** The 30 Koppen-Geiger classes, by code index. */
export const KOPPEN: readonly string[] = Object.freeze([
  'Af',
  'Am',
  'Aw',
  'BWh',
  'BWk',
  'BSh',
  'BSk',
  'Csa',
  'Csb',
  'Csc',
  'Cwa',
  'Cwb',
  'Cwc',
  'Cfa',
  'Cfb',
  'Cfc',
  'Dsa',
  'Dsb',
  'Dsc',
  'Dsd',
  'Dwa',
  'Dwb',
  'Dwc',
  'Dwd',
  'Dfa',
  'Dfb',
  'Dfc',
  'Dfd',
  'ET',
  'EF',
]);

// cos(2 pi (m - 6) / 12) for m = 0..11 in Q16: month 6 is the warmest, month 0 the coldest.
const COS = [-65536, -56756, -32768, 0, 32768, 56756, 65536, 56756, 32768, 0, -32768, -56756];
/** Summer: the six warmest months (3 and 9 tie; 3 is taken, which leaves every rainfall statistic unchanged). */
const SUMMER = [false, false, false, true, true, true, true, true, true, false, false, false];

/** What the label rules read per cell. */
export interface KoppenClimate {
  /** Mean annual, coldest-month and warmest-month temperature, cK. */
  readonly temperature: number;
  readonly coldest: number;
  readonly warmest: number;
  /** Annual rainfall, mm. */
  readonly rainfall: number;
  /** When the rain falls (a world's `climate.rainSeason`). */
  readonly rainSeason: 'uniform' | 'summer' | 'winter';
}

/**
 * The Koppen-Geiger class index (into {@link KOPPEN}) of one climate. Integer only.
 * @example
 * KOPPEN[koppenClass({ temperature: 1100, coldest: 500, warmest: 1700, rainfall: 700, rainSeason: 'uniform' })]; // 'Cfb'
 */
export function koppenClass(c: KoppenClimate): number {
  const mean = c.temperature,
    half = Math.floor((c.warmest - c.coldest) / 2),
    swing = c.rainSeason === 'summer' ? 55706 : c.rainSeason === 'winter' ? -55706 : 0, // +-0.85 in Q16
    t = new Int32Array(12),
    p = new Int32Array(12); // mm per month x 1,000
  let hot = -2147483647,
    cold = 2147483647,
    warmMonths = 0,
    summer = 0,
    total = 0;
  for (let m = 0; m < 12; m++) {
    t[m] = mean + Math.floor((half * COS[m]) / 65536);
    p[m] = Math.floor((c.rainfall * 1000 * (65536 + Math.floor((swing * COS[m]) / 65536))) / (12 * 65536));
    hot = Math.max(hot, t[m]);
    cold = Math.min(cold, t[m]);
    if (t[m] > 1000) warmMonths++;
    total += p[m];
    if (SUMMER[m]) summer += p[m];
  }
  let sDry = 2147483647,
    sWet = 0,
    wDry = 2147483647,
    wWet = 0,
    dry = 2147483647;
  for (let m = 0; m < 12; m++) {
    dry = Math.min(dry, p[m]);
    if (SUMMER[m]) {
      sDry = Math.min(sDry, p[m]);
      sWet = Math.max(sWet, p[m]);
    } else {
      wDry = Math.min(wDry, p[m]);
      wWet = Math.max(wWet, p[m]);
    }
  }
  const map = c.rainfall,
    // Ten times the dryness threshold, in mm: 20 MAT, +280 when more than 70 % of the rain falls in summer, +140 when
    // neither half has more than 70 % (Beck et al. 2018, Table 2 note). B (arid) below it, BW (desert) below half of it.
    threshold =
      Math.floor((20 * mean) / 100) + (10 * summer > 7 * total ? 280 : 10 * (total - summer) > 7 * total ? 0 : 140);
  if (map < threshold) return (map < threshold / 2 ? 3 : 5) + (mean >= 1800 ? 0 : 1); // BW or BS, h or k
  if (cold >= 1800) {
    if (dry >= 60_000) return 0; // Af
    return dry >= 100_000 - Math.floor((map * 1000) / 25) ? 1 : 2; // Am or Aw
  }
  if (hot <= 1000) return hot > 0 ? 28 : 29; // ET or EF
  // C or D, then s / w / f, then a / b / c / d.
  const second = sDry < 40_000 && 3 * sDry < wWet ? 0 : 10 * wDry < sWet ? 1 : 2,
    third = hot >= 2200 ? 0 : warmMonths >= 4 ? 1 : cold < -3800 ? 3 : 2;
  if (cold > 0) return 7 + second * 3 + Math.min(third, 2);
  return 16 + second * 4 + third;
}

/** A tile-like source of layers (a `BiomeTile`). */
export interface KoppenSource {
  layer(name: string): { readonly data: ArrayLike<number>; readonly width: number; readonly depth: number } | undefined;
}

/**
 * Koppen-Geiger class indices for every cell of a tile (into {@link KOPPEN}), from its `temperature`, `coldest`,
 * `warmest` and `rainfall` layers and the world's rain season (`world.climate.rainSeason`).
 * @throws TypeError when the tile lacks one of those layers.
 * @example
 * const codes = koppen(await world.tile(4, 4), world.climate.rainSeason);
 * console.log(KOPPEN[codes[0]]);
 */
export function koppen(tile: KoppenSource, rainSeason: KoppenClimate['rainSeason']): Uint8Array {
  const get = (name: string) => {
    const layer = tile.layer(name);
    if (!layer) throw typeError(`koppen needs the tile's ${name} layer; request the default layers`, 'biomes');
    return layer;
  };
  const temperature = get('temperature'),
    coldest = get('coldest').data,
    warmest = get('warmest').data,
    rainfall = get('rainfall').data,
    out = new Uint8Array(temperature.width * temperature.depth);
  for (let k = 0; k < out.length; k++)
    out[k] = koppenClass({
      temperature: temperature.data[k],
      coldest: coldest[k],
      warmest: warmest[k],
      rainfall: rainfall[k],
      rainSeason,
    });
  return out;
}
