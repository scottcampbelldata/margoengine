// The Whittaker and Holdridge classifiers (spec 2.3), an optional entry: `BiomeWorld.create({ classifier: whittaker })`
// weights each biome by the classes or life zones its `zones` name instead of by its climate envelope. Integer only.
// Whittaker classes: our own rectangles in (mean annual temperature, rainfall) approximated from the published diagram
// (Whittaker 1975). Holdridge life zones: nearest hexagon centre in log2 biotemperature, log2 rainfall and log2 PET
// ratio (Holdridge 1947, 1967), biotemperature as the year mean of temperatures clamped to 0..30 C.
import { type Dims, flatten, membership, type ZoneClassifier } from './classify.js';
import { degreeDays } from './climate.js';
import { dimension, type Range } from './define.js';
import { clampInt, divFloor, ONE, qlog2, qsqrt, wendland } from './fixed.js';

export type { ZoneClassifier } from './classify.js';

/** Whittaker's nine biome classes as envelopes over mean annual temperature (C) and rainfall (mm): our rectangles. */
export const WHITTAKER: Readonly<Record<string, { readonly temperature: Range; readonly rainfall: Range }>> =
  Object.freeze({
    tundra: { temperature: [null, -5], rainfall: [null, null] },
    'boreal-forest': { temperature: [-5, 5], rainfall: [300, null] },
    'temperate-grassland-desert': { temperature: [-5, 20], rainfall: [null, 300] },
    'woodland-shrubland': { temperature: [5, 20], rainfall: [300, 900] },
    'temperate-seasonal-forest': { temperature: [5, 20], rainfall: [900, 2200] },
    'temperate-rainforest': { temperature: [5, 20], rainfall: [2200, null] },
    'subtropical-desert': { temperature: [20, null], rainfall: [null, 500] },
    'tropical-seasonal-forest-savanna': { temperature: [20, null], rainfall: [500, 2500] },
    'tropical-rainforest': { temperature: [20, null], rainfall: [2500, null] },
  });

/** Holdridge biotemperature belts, coldest first (bounds at 1.5, 3, 6, 12 and 24 C). */
export const HOLDRIDGE_BELTS: readonly string[] = Object.freeze([
  'polar',
  'subpolar',
  'boreal',
  'cool-temperate',
  'warm-temperate',
  'tropical',
]);
/** Holdridge humidity provinces, wettest first (PET ratio bands doubling from below 0.25 to 16 and more). */
export const HOLDRIDGE_HUMIDITY: readonly string[] = Object.freeze([
  'superhumid',
  'perhumid',
  'humid',
  'subhumid',
  'semiarid',
  'arid',
  'perarid',
  'superarid',
]);

/** The Whittaker classes as envelope dimensions over input slots 0 (temperature) and 1 (rainfall) unless given. */
const classesOf = (slotOf: (layer: string) => number): Dims =>
  flatten(
    Object.values(WHITTAKER).map((e) => [
      dimension('temperature', e.temperature, 0.15),
      dimension('rainfall', e.rainfall, 0.15),
    ]),
    slotOf,
  );

/**
 * The Whittaker classifier: each biome's weight is the sum (at most 1) of the memberships of the Whittaker classes its
 * `zones` list, with the same Wendland blend bands as envelopes.
 * @example
 * const world = await BiomeWorld.create({ classifier: whittaker });
 */
export const whittaker: ZoneClassifier = Object.freeze<ZoneClassifier>({
  kind: 'whittaker',
  scorer(biomes, slotOf) {
    const classes = classesOf(slotOf),
      classBiomes = Object.keys(WHITTAKER).map((name) =>
        biomes.flatMap((b, i) => ((b.zones ?? []).includes(name) ? [i] : [])),
      );
    return (warped, cells, member) => {
      const m = new Int32Array(cells),
        far = new Int32Array(cells);
      for (let w = 0; w < classBiomes.length; w++) {
        membership(classes, w, warped, cells, m, far);
        for (const b of classBiomes[w]) {
          const out = member.subarray(b * cells, (b + 1) * cells);
          for (let k = 0; k < cells; k++) out[k] = Math.min(ONE, out[k] + m[k]);
        }
      }
    };
  },
});

// Belt j covers biotemperatures 1.5 x 2^j..1.5 x 2^(j+1) C (j = -1 is polar); humidity band m covers PET ratios
// 2^m..2^(m+1) (m <= -3 is superhumid, m >= 4 superarid).
const zoneName = (j: number, m: number) =>
  `${HOLDRIDGE_BELTS[clampInt(j + 1, 0, 5)]}-${HOLDRIDGE_HUMIDITY[clampInt(m + 3, 0, 7)]}`;

/**
 * The Holdridge classifier: each biome's weight is the sum (at most 1) of the weights of the four nearest life-zone
 * hexagon centres its `zones` list: 1 within 0.35 of a centre, falling to 0 at 0.65 (hexagon edges at 0.5).
 * @example
 * const world = await BiomeWorld.create({ classifier: holdridge });
 */
export const holdridge: ZoneClassifier = Object.freeze<ZoneClassifier>({
  kind: 'holdridge',
  scorer(biomes, slotOf) {
    const codes = new Map<string, number>();
    for (let belt = 0; belt < 6; belt++)
      for (let wet = 0; wet < 8; wet++) codes.set(zoneName(belt - 1, wet - 3), belt * 8 + wet);
    const zoneBiomes = Array.from({ length: 48 }, (_, code) =>
        biomes.flatMap((b, i) => ((b.zones ?? []).some((z) => codes.get(z) === code) ? [i] : [])),
      ),
      [ts, cs, ws, rs] = ['temperature', 'coldest', 'warmest', 'rainfall'].map(slotOf);
    return (warped, cells, member) => {
      const centres = new Int32Array(12),
        [t, cold, warm, rain] = [ts, cs, ws, rs].map((s) => warped.subarray(s * cells));
      for (let k = 0; k < cells; k++) {
        const half = divFloor((warm[k] - cold[k]) * 32768, 64790);
        holdridgeCentres(biotemperature(t[k], half), rain[k], centres);
        for (let q = 0; q < 12; q += 3) {
          const d = qsqrt(centres[q]),
            w = wendland(clampInt(divFloor((d - 22938) * ONE, 19661), 0, ONE));
          if (!w) continue;
          for (const b of zoneBiomes[clampInt(centres[q + 1] + 1, 0, 5) * 8 + clampInt(centres[q + 2] + 3, 0, 7)])
            member[b * cells + k] = Math.min(ONE, member[b * cells + k] + w);
        }
      }
    };
  },
});

/** The Holdridge life zone (`'<belt>-<humidity>'`) of a biotemperature (cK) and rainfall (mm). */
export function holdridgeZone(biotemperature: number, rainfall: number): string {
  const centres = new Int32Array(12);
  holdridgeCentres(biotemperature, rainfall, centres);
  return zoneName(centres[1], centres[2]);
}

/**
 * The four hexagon centres around a climate point in Holdridge's lattice, nearest first (ties by belt, then humidity
 * band): writes (distance^2 in Q16, belt j, humidity band r) triples into `out` (12 values).
 * u = log2(rain / 62.5 mm), v = log2(biotemperature / 1.5 C); centres sit at half-integer u and v, and the PET ratio
 * band is floor(v - u + 0.5), so belts, rainfall and humidity bounds all fall on hexagon edges.
 */
function holdridgeCentres(bio: number, rain: number, out: Int32Array): void {
  const v = Math.max(-ONE, qlog2(Math.max(1, divFloor(Math.max(0, bio) * ONE, 150)))),
    u = Math.max(-ONE, qlog2(Math.max(1, divFloor(Math.max(0, rain) * 2 * ONE, 125)))), // rain / 62.5 mm
    k0 = (u - ONE / 2) >> 16,
    j0 = (v - ONE / 2) >> 16;
  for (let c = 0; c < 4; c++) {
    const k = k0 + (c & 1),
      j = j0 + (c >> 1),
      du = u - (k * ONE + ONE / 2),
      dv = v - (j * ONE + ONE / 2),
      d2 = Math.floor((du * du - du * dv + dv * dv) / ONE),
      r = j - k;
    // Insertion by (d2, j, r).
    let at = c;
    while (
      at > 0 &&
      (out[3 * at - 3] > d2 ||
        (out[3 * at - 3] === d2 && (out[3 * at - 2] > j || (out[3 * at - 2] === j && out[3 * at - 1] > r))))
    ) {
      out[3 * at] = out[3 * at - 3];
      out[3 * at + 1] = out[3 * at - 2];
      out[3 * at + 2] = out[3 * at - 1];
      at--;
    }
    out[3 * at] = d2;
    out[3 * at + 1] = j;
    out[3 * at + 2] = r;
  }
}

/** Biotemperature in cK: the year mean of max(0, min(30, T)) for a sinusoidal year (mean and half swing in cK). */
export function biotemperature(mean: number, half: number): number {
  const a = [0, 0],
    b = [0, 0];
  degreeDays(mean, half, 0, a);
  degreeDays(mean, half, 3000, b);
  return divFloor((a[0] - b[0]) * 100, 365);
}

/** The Whittaker class with the largest membership at a mean annual temperature (C) and rainfall (mm). */
export function whittakerClass(temperature: number, rainfall: number): string {
  const names = Object.keys(WHITTAKER),
    classes = classesOf((layer) => (layer === 'temperature' ? 0 : 1)),
    values = Int32Array.of(Math.round(temperature * 100), Math.round(rainfall)),
    m = new Int32Array(1),
    distance = new Int32Array(1);
  let best = '',
    top = -1,
    nearest = '',
    far = 2147483647;
  names.forEach((name, w) => {
    membership(classes, w, values, 1, m, distance);
    if (m[0] > top) [best, top] = [name, m[0]];
    if (distance[0] < far) [nearest, far] = [name, distance[0]];
  });
  return top > 0 ? best : nearest;
}
