// Biome classification with smooth blends (spec 2.3), integer only. Memberships are products of Wendland kernels of
// the signed distance to each envelope bound (Wendland 1995), the climate inputs are warped by low-frequency value
// noise so borders wander like real ecotones, a 3x3 box blur removes salt-and-pepper, paint layers compose in a fixed
// order, a cell outside every envelope falls back to the nearest one (ties by priority, then id), and the top 4
// biomes are stored with weights that sum to exactly 255 (largest remainder, ties by priority, then id).
// Whittaker classes: our own rectangles in (mean annual temperature, rainfall) approximated from the published diagram
// (Whittaker 1975). Holdridge life zones: nearest hexagon centre in log2 biotemperature, log2 rainfall and log2 PET
// ratio (Holdridge 1947, 1967), biotemperature as the year mean of temperatures clamped to 0..30 C.
import { degreeDays } from './climate.js';
import { type BiomeDefinition, type Dimension, dimension, envelopeOf } from './define.js';
import { clampInt, divFloor, ONE, qlog2, qsqrt, wendland } from './fixed.js';
import { fbm } from './hash.js';

/** Whittaker's nine biome classes as envelopes over mean annual temperature (C) and rainfall (mm): our rectangles. */
export const WHITTAKER: Readonly<
  Record<
    string,
    {
      readonly temperature: readonly [number | null, number | null];
      readonly rainfall: readonly [number | null, number | null];
    }
  >
> = Object.freeze({
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
export const HOLDRIDGE_BELTS = Object.freeze([
  'polar',
  'subpolar',
  'boreal',
  'cool-temperate',
  'warm-temperate',
  'tropical',
]);
/** Holdridge humidity provinces, wettest first (PET ratio bands doubling from below 0.25 to 16 and more). */
export const HOLDRIDGE_HUMIDITY = Object.freeze([
  'superhumid',
  'perhumid',
  'humid',
  'subhumid',
  'semiarid',
  'arid',
  'perarid',
  'superarid',
]);

/** Paint layer composition modes, applied in the world's paint order. */
export type PaintMode = 'replace' | 'add' | 'multiply' | 'max';

/** A paint layer: user raster `paint/<biome>` composed onto the biome weights, optionally through `mask/<name>`. */
export interface PaintLayer {
  readonly biome: string;
  /** Default `'replace'`. */
  readonly mode?: PaintMode;
  readonly mask?: string;
}

/** The classifier a world builds from its biomes. */
export interface Classifier {
  readonly kind: 'envelopes' | 'whittaker' | 'holdridge';
  readonly ids: readonly string[];
  readonly dims: readonly (readonly Dimension[])[];
  /** Tie order: higher priority first, then id; rank[b] is b's place in it. */
  readonly rank: Int32Array;
  readonly zones: readonly (readonly string[])[];
  readonly whittaker: readonly (readonly [string, readonly Dimension[]])[];
  readonly paint: readonly { readonly biome: number; readonly mode: PaintMode; readonly mask?: string }[];
  /** Layers the classifier reads. */
  readonly inputs: readonly string[];
}

const MODES = ['replace', 'add', 'multiply', 'max'];

/** Builds a classifier. Ids must be unique; at most 255 biomes. */
export function classifier(
  biomes: readonly BiomeDefinition[],
  kind: Classifier['kind'],
  paint: readonly PaintLayer[],
): Classifier {
  const ids = biomes.map((b) => b.id),
    order = ids
      .map((_, i) => i)
      .sort(
        (a, b) =>
          (biomes[b].priority ?? 0) - (biomes[a].priority ?? 0) || (ids[a] < ids[b] ? -1 : ids[a] > ids[b] ? 1 : 0),
      ),
    rank = new Int32Array(ids.length);
  order.forEach((b, place) => {
    rank[b] = place;
  });
  const dims = biomes.map(envelopeOf),
    whittaker = Object.entries(WHITTAKER).map(
      ([name, e]) =>
        [name, [dimension('temperature', e.temperature, 0.15), dimension('rainfall', e.rainfall, 0.15)]] as const,
    );
  const inputs = new Set<string>([
    'temperature',
    'rainfall',
    'coldest',
    'warmest',
    'alpha',
    'moisture',
    'gdd5',
    'season',
    'treeline',
  ]);
  for (const d of dims) for (const dim of d) inputs.add(dim.layer);
  return {
    kind,
    ids,
    dims,
    rank,
    zones: biomes.map((b) => b.zones ?? []),
    whittaker,
    paint: paint.map((p) => {
      const biome = ids.indexOf(p.biome);
      return { biome, mode: p.mode ?? 'replace', mask: p.mask };
    }),
    inputs: [...inputs],
  };
}

/** Validates paint layers against the biome ids. */
export function checkPaint(paint: readonly PaintLayer[], ids: readonly string[]): boolean {
  return (
    Array.isArray(paint) &&
    paint.every(
      (p) =>
        p &&
        ids.includes(p.biome) &&
        (p.mode === undefined || MODES.includes(p.mode)) &&
        (p.mask === undefined || (typeof p.mask === 'string' && p.mask.length > 0)),
    )
  );
}

/** Membership of one envelope (Q16) and its largest normalised signed distance (Q16) at a cell. */
function membership(dims: readonly Dimension[], value: (layer: string) => number, out: Int32Array): void {
  let m = ONE,
    far = -2147483647;
  for (const d of dims) {
    const v = value(d.layer),
      dist = Math.max(d.lo - v, v - d.hi), // negative inside
      half = d.width >> 1;
    far = Math.max(far, clampInt(divFloor(dist * ONE, d.width), -1048576, 1048576));
    if (m) m = Math.floor((m * wendland(clampInt(divFloor((dist + half) * ONE, d.width), 0, ONE))) / ONE);
  }
  out[0] = m;
  out[1] = far;
}

/** The Holdridge life zone (`'<belt>-<humidity>'`) of a biotemperature (cK) and rainfall (mm). */
export function holdridgeZone(biotemperature: number, rainfall: number): string {
  const centres = new Int32Array(8);
  holdridgeCentres(biotemperature, rainfall, centres);
  return zoneName(centres[0], centres[1]);
}

// Belt j covers biotemperatures 1.5 x 2^j..1.5 x 2^(j+1) C (j = -1 is polar); humidity band m covers PET ratios
// 2^m..2^(m+1) (m <= -3 is superhumid, m >= 4 superarid).
const zoneName = (j: number, m: number) =>
  `${HOLDRIDGE_BELTS[clampInt(j + 1, 0, 5)]}-${HOLDRIDGE_HUMIDITY[clampInt(m + 3, 0, 7)]}`;

/**
 * The four hexagon centres around a climate point in Holdridge's lattice, nearest first: writes
 * `[belt, humidity band, distance^2 (Q16), ...]` pairs as (j, r, d2) triples for the nearest and the others.
 * u = log2(rain / 62.5 mm), v = log2(biotemperature / 1.5 C); centres sit at half-integer u and v, and the PET ratio
 * band is floor(v - u + 0.5), so belts, rainfall and humidity bounds all fall on hexagon edges.
 */
function holdridgeCentres(bio: number, rain: number, out: Int32Array): number[][] {
  const v = Math.max(-ONE, qlog2(Math.max(1, divFloor(Math.max(0, bio) * ONE, 150)))),
    u = Math.max(-ONE, qlog2(Math.max(1, divFloor(Math.max(0, rain) * 2 * ONE, 125)))), // rain / 62.5 mm
    k0 = (u - ONE / 2) >> 16,
    j0 = (v - ONE / 2) >> 16,
    list: number[][] = [];
  for (let dj = 0; dj <= 1; dj++)
    for (let dk = 0; dk <= 1; dk++) {
      const k = k0 + dk,
        j = j0 + dj,
        du = u - (k * ONE + ONE / 2),
        dv = v - (j * ONE + ONE / 2),
        d2 = Math.floor((du * du - du * dv + dv * dv) / ONE);
      list.push([d2, j, j - k]);
    }
  list.sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2]);
  out[0] = list[0][1];
  out[1] = list[0][2];
  return list;
}

/** Biotemperature in cK: the year mean of max(0, min(30, T)) for a sinusoidal year (mean and half swing in cK). */
export function biotemperature(mean: number, half: number): number {
  const a = [0, 0],
    b = [0, 0];
  degreeDays(mean, half, 0, a);
  degreeDays(mean, half, 3000, b);
  return divFloor((a[0] - b[0]) * 100, 365);
}

/** Inputs of a classification: layer getters over an n x n grid (the tile plus a 1-cell margin). */
export interface ClassifyInput {
  readonly n: number;
  layer(name: string): ArrayLike<number>;
  /** User layer value 0..255 at grid cell k, or undefined when unpainted. */
  user(name: string, k: number): number | undefined;
  /** Global cell of grid cell (0, 0). */
  readonly gx: number;
  readonly gz: number;
  readonly seed: number;
  /** Cell size, mm. */
  readonly cell: number;
}

/** Wavelength of the ecotone warp, mm. */
const WARP = 700_000;

/**
 * Classifies the inner (n - 2)^2 cells: writes 4 ids and 4 weights (summing to 255) per cell into `ids` and
 * `weights` (rgba8, row-major over the inner cells). Unused slots hold id 255 and weight 0.
 */
export function classify(c: Classifier, input: ClassifyInput, ids: Uint8Array, weights: Uint8Array): void {
  const n = input.n,
    count = c.ids.length,
    cells = n * n,
    member = new Int32Array(count * cells),
    nearest = new Int32Array(cells),
    // Normalised distance of every envelope at every cell, for the fallback after paint.
    farAll = new Int32Array(count * cells),
    scratch = new Int32Array(2),
    centres = new Int32Array(8),
    warped: Record<string, number> = {},
    layers: Record<string, ArrayLike<number>> = {};
  for (const name of c.inputs) if (!name.startsWith('mask/')) layers[name] = input.layer(name);
  // Warp noise on the 8-cell lattice covering this grid: lattice point (a, b) is global cell (8 (a0 + a), 8 (b0 + b)).
  const a0 = input.gx >> 3,
    b0 = input.gz >> 3,
    span = ((input.gx + n) >> 3) - a0 + 2,
    warpA = new Int32Array(span * span),
    warpB = new Int32Array(span * span);
  for (let b = 0; b < span; b++)
    for (let a = 0; a < span; a++) {
      const lx = divFloor((a0 + a) * 8 * input.cell * ONE, WARP),
        lz = divFloor((b0 + b) * 8 * input.cell * ONE, WARP);
      warpA[b * span + a] = fbm(input.seed ^ 0x5eed, lx, lz, 2);
      warpB[b * span + a] = fbm(input.seed ^ 0x7a1e, lz, lx, 2);
    }
  const warpAt = (grid: Int32Array, i: number, j: number) => {
    const gx = input.gx + i - a0 * 8,
      gz = input.gz + j - b0 * 8,
      a = gx >> 3,
      b = gz >> 3,
      fx = (gx & 7) << 13,
      fz = (gz & 7) << 13,
      at = b * span + a,
      top = grid[at] + Math.floor(((grid[at + 1] - grid[at]) * fx) / ONE),
      bottom = grid[at + span] + Math.floor(((grid[at + span + 1] - grid[at + span]) * fx) / ONE);
    return top + Math.floor(((bottom - top) * fz) / ONE);
  };
  const temperatureLike = ['temperature', 'coldest', 'warmest', 'treeline'],
    inputs = c.inputs.map((name) => ({
      name,
      mode: name.startsWith('mask/')
        ? 0
        : temperatureLike.includes(name)
          ? 1
          : name === 'gdd5'
            ? 2
            : name === 'season'
              ? 3
              : name === 'rainfall'
                ? 4
                : name === 'alpha' || name === 'moisture'
                  ? 5
                  : 6,
      data: name.startsWith('mask/') ? undefined : layers[name],
    }));
  for (let j = 0; j < n; j++)
    for (let i = 0; i < n; i++) {
      const k = j * n + i,
        // The warp is smooth (700 m): noise on a global 8-cell lattice, bilinear between lattice points.
        n1 = warpAt(warpA, i, j) - 32768, // -0.5..0.5 in Q16
        n2 = warpAt(warpB, i, j) - 32768,
        dT = divFloor(n1 * 160, 32768); // +-1.6 K at the extremes, cK
      for (const { name, mode, data } of inputs) {
        if (mode === 0) {
          warped[name] = input.user(name, k) ?? 0;
          continue;
        }
        const v = data![k];
        warped[name] =
          mode === 1
            ? v + dT
            : mode === 2
              ? Math.max(0, v + 2 * dT)
              : mode === 3
                ? clampInt(v + divFloor(dT, 10), 0, 365)
                : mode === 4
                  ? Math.max(0, v + divFloor(v * n2 * 16, 6553600))
                  : mode === 5
                    ? clampInt(v + divFloor(n2 * 10, 32768), 0, 255)
                    : v;
      }
      const value = (layer: string) => warped[layer];
      let best = -1,
        bestFar = 2147483647;
      for (let b = 0; b < count; b++) {
        membership(c.dims[b], value, scratch);
        farAll[b * cells + k] = scratch[1];
        if (scratch[1] < bestFar || (scratch[1] === bestFar && c.rank[b] < c.rank[best])) {
          best = b;
          bestFar = scratch[1];
        }
        if (c.kind === 'envelopes') member[b * cells + k] = scratch[0];
      }
      nearest[k] = best;
      if (c.kind === 'whittaker') {
        for (const [name, dims] of c.whittaker) {
          membership(dims, value, scratch);
          if (!scratch[0]) continue;
          for (let b = 0; b < count; b++)
            if (c.zones[b].includes(name)) member[b * cells + k] = Math.min(ONE, member[b * cells + k] + scratch[0]);
        }
      } else if (c.kind === 'holdridge') {
        const half = divFloor((value('warmest') - value('coldest')) * 32768, 64790),
          list = holdridgeCentres(biotemperature(value('temperature'), half), value('rainfall'), centres);
        for (const [d2, jj, r] of list) {
          // Weight 1 within 0.35 of a centre, 0 beyond 0.65 (hexagon edges at 0.5).
          const d = qsqrt(d2),
            w = wendland(clampInt(divFloor((d - 22938) * ONE, 19661), 0, ONE));
          if (!w) continue;
          const name = zoneName(jj, r);
          for (let b = 0; b < count; b++)
            if (c.zones[b].includes(name)) member[b * cells + k] = Math.min(ONE, member[b * cells + k] + w);
        }
      }
    }
  const inner = n - 2,
    w = new Int32Array(count),
    pick = new Int32Array(count),
    blocked = new Uint8Array(count),
    share = new Int32Array(4);
  for (let j = 0; j < inner; j++)
    for (let i = 0; i < inner; i++) {
      const k = (j + 1) * n + i + 1;
      let total = 0;
      for (let b = 0; b < count; b++) {
        const base = b * cells + k;
        let s = 0;
        for (let dz = -n; dz <= n; dz += n) s += member[base + dz - 1] + member[base + dz] + member[base + dz + 1];
        w[b] = Math.floor(s / 9);
        total += w[b];
      }
      if (!total) {
        w[nearest[k]] = ONE;
        total = ONE;
      }
      for (let b = 0; b < count; b++) w[b] = divFloor(w[b] * ONE, total);
      // Paint layers, in order.
      blocked.fill(0);
      for (const p of c.paint) {
        if (p.biome < 0) continue;
        const raw = input.user(`paint/${c.ids[p.biome]}`, k);
        if (raw === undefined) continue;
        let amount = divFloor(raw * ONE, 255);
        if (p.mask) amount = divFloor(amount * (input.user(p.mask, k) ?? 0), 255);
        if (p.mode === 'replace') {
          for (let b = 0; b < count; b++) w[b] = Math.floor((w[b] * (ONE - amount)) / ONE);
          w[p.biome] += amount;
        } else if (p.mode === 'add') w[p.biome] += amount;
        else if (p.mode === 'multiply') {
          w[p.biome] = Math.floor((w[p.biome] * amount) / ONE);
          if (!amount) blocked[p.biome] = 1;
        } else w[p.biome] = Math.max(w[p.biome], amount);
      }
      total = 0;
      for (let b = 0; b < count; b++) total += w[b];
      if (!total) {
        // Everything painted away: the nearest envelope among the biomes paint did not multiply to 0.
        let pickB = nearest[k],
          pickFar = 2147483647;
        for (let b = 0; b < count; b++) {
          if (blocked[b]) continue;
          const f = farAll[b * cells + k];
          if (f < pickFar || (f === pickFar && c.rank[b] < c.rank[pickB])) {
            pickB = b;
            pickFar = f;
          }
        }
        w[pickB] = ONE;
        total = ONE;
      }
      // Top 4 by weight, ties by rank (insertion into a list sorted by weight, then rank).
      let used = 0;
      for (let b = 0; b < count; b++) {
        if (!w[b]) continue;
        let at = used++;
        while (at > 0 && (w[pick[at - 1]] < w[b] || (w[pick[at - 1]] === w[b] && c.rank[pick[at - 1]] > c.rank[b]))) {
          pick[at] = pick[at - 1];
          at--;
        }
        pick[at] = b;
      }
      used = Math.min(used, 4);
      // Largest remainder to 255.
      let sum = 0,
        given = 0;
      for (let s = 0; s < used; s++) sum += w[pick[s]];
      for (let s = 0; s < used; s++) {
        share[s] = divFloor(w[pick[s]] * 255, sum);
        given += share[s];
      }
      for (let left = 255 - given; left > 0; left--) {
        let top = 0,
          topRem = -1;
        for (let s = 0; s < used; s++) {
          const rem = w[pick[s]] * 255 - share[s] * sum;
          if (rem > topRem) {
            top = s;
            topRem = rem;
          }
        }
        share[top]++;
        // Spent: its remainder drops below every other one.
        w[pick[top]] -= sum;
      }
      // Sort slots by final weight (stable over the rank order they are already in).
      const out = (j * inner + i) * 4;
      const order = [0, 1, 2, 3].slice(0, used).sort((a, b) => share[b] - share[a] || a - b);
      for (let s = 0; s < 4; s++) {
        const live = s < used && share[order[s]] > 0;
        ids[out + s] = live ? pick[order[s]] : 255;
        weights[out + s] = live ? share[order[s]] : 0;
      }
    }
}

/** The Whittaker class with the largest membership at a mean annual temperature (C) and rainfall (mm). */
export function whittakerClass(temperature: number, rainfall: number): string {
  const values: Record<string, number> = { temperature: Math.round(temperature * 100), rainfall: Math.round(rainfall) },
    scratch = new Int32Array(2);
  let best = '',
    top = -1,
    nearest = '',
    far = 2147483647;
  for (const [name, e] of Object.entries(WHITTAKER)) {
    membership(
      [dimension('temperature', e.temperature, 0.15), dimension('rainfall', e.rainfall, 0.15)],
      (l) => values[l],
      scratch,
    );
    if (scratch[0] > top) [best, top] = [name, scratch[0]];
    if (scratch[1] < far) [nearest, far] = [name, scratch[1]];
  }
  return top > 0 ? best : nearest;
}
