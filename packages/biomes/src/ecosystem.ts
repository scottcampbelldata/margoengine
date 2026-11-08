// Ecosystem growth (entry `@margoengine/biomes/ecosystem`): plants that grow, compete for light, seed, age and die,
// year by year, so a few founders become a forest with gaps, cohorts and a canopy of the species that suit the light.
// An individual-based model in the line of JABOWA (Botkin, Janak and Wallis 1972) and SORTIE (Pacala et al. 1996):
// crowns grow logistically toward the species' largest crown; a crown is shaded by the overlap of taller crowns only
// (size-asymmetric competition, Weiner 1990, after the zone-of-influence idea of Bella 1971); growth falls with shade
// as the species' tolerance allows; mortality has a base rate, a senescence rate past the species' age, and a
// suppression rate that rises as growth falls (Pacala et al. 1996); adults seed in proportion to crown area, at
// distances drawn from Clark's 2Dt dispersal kernel (Clark et al. 1999). Everything is integers (centimetres,
// millimetres, Q16.16 shares) decided by world-anchored hashes, so the same start gives the same forest everywhere.
import { rangeError, typeError } from '../../shared/errors.js';
import { clampInt, divFloor, isqrt, ONE, qmul, sincos } from './fixed.js';
import { hash4 } from './hash.js';
import type { BiomePlacement, PlacedTile } from './placement.js';

/** A species of an ecosystem, in plain units. */
export interface EcoSpecies {
  /** Id the plants name (a placement palette key such as `'temperate/oak'` works). */
  readonly id: string;
  /** Largest crown radius, metres, 0.1..40. */
  readonly radius: number;
  /** Logistic crown growth rate per year in full light, 0.01..2. Default 0.15. */
  readonly growth?: number;
  /** Typical lifespan, years, 2..3000; past it, a quarter die each year. Default 200. */
  readonly age?: number;
  /** Shade tolerance 0 (needs sun) to 1 (grows at half rate in deep shade and is rarely suppressed). Default 0.5. */
  readonly shade?: number;
  /** Seedlings per year from an adult at its largest crown (crown area scales it), 0..64. Default 4. */
  readonly seeds?: number;
  /** Dispersal scale of the 2Dt kernel, metres, 0.5..2000: half the seedlings land closer than it. Default 10. */
  readonly dispersal?: number;
  /** Share of the largest crown at which a plant starts to seed, 0..1. Default 0.4. */
  readonly maturity?: number;
}

/** A plant at the start or end of a run. Positions in metres; `radius` is the crown radius in metres. */
export interface EcoPlant {
  readonly species: string;
  readonly x: number;
  readonly z: number;
  /** Default: a seedling (5 cm, or the largest crown when smaller). */
  readonly radius?: number;
  /** Years. Default 0. */
  readonly age?: number;
  /** Year it died (standing dead), on output only. */
  readonly died?: number;
}

/** Settings of {@link growEcosystem}. */
export interface EcosystemOptions {
  /** Area `[x0, z0, x1, z1]` in metres where seedlings may establish (plants outside it still grow and shade). */
  readonly bounds: readonly [number, number, number, number];
  readonly species: readonly EcoSpecies[];
  readonly plants?: readonly EcoPlant[];
  /** Years to run, 0..2000. */
  readonly years: number;
  /** Integer seed of every decision. Default 0. */
  readonly seed?: number;
  /** How well a species' seedling does at x, z: 0..1 (it establishes with that chance). Default 1 everywhere. */
  readonly where?: (x: number, z: number, species: string) => number;
  /** Years a dead plant stands before it is gone, 0..200. Default 10. */
  readonly snags?: number;
  /** Most plants (living and dead) held; seedlings past it are not added and are counted. 1..1,000,000. Default 200,000. */
  readonly limit?: number;
}

/** One year of a run. */
export interface EcoYear {
  readonly year: number;
  readonly alive: number;
  readonly born: number;
  readonly died: number;
}

/** The forest after a run. */
export interface Ecosystem {
  readonly years: number;
  /** Living plants, then standing dead ones, each in order of birth. */
  readonly plants: readonly EcoPlant[];
  /** Living plants per species id. */
  readonly counts: Readonly<Record<string, number>>;
  readonly history: readonly EcoYear[];
  /** Seedlings not added because the plant limit was reached. */
  readonly crowded: number;
}

interface Kind {
  readonly id: string;
  readonly rmax: number; // mm
  readonly growth: number; // Q16 per year
  readonly age: number;
  readonly shade: number; // Q16
  readonly seeds: number; // Q16 per year
  readonly scale: number; // cm
  readonly mature: number; // mm
  readonly base: number; // Q16 annual mortality
}

const SALT_DIE = 1,
  SALT_SEED = 2,
  SALT_DIST = 3,
  SALT_TURN = 4,
  SALT_SITE = 5,
  SEEDLING = 50, // mm
  FAR = 100000; // m: every coordinate is within this, so centimetres fit an i32 and cells the grid key

/** A finite coordinate within {@link FAR} metres of the origin. */
const near = (v: unknown): boolean => typeof v === 'number' && v >= -FAR && v <= FAR;

function num(v: unknown, lo: number, hi: number, fallback: number, what: string): number {
  if (v === undefined) return fallback;
  if (typeof v !== 'number' || !(v >= lo && v <= hi))
    throw rangeError(`An ecosystem ${what} is ${lo}..${hi}`, 'biomes');
  return v;
}

function kindOf(s: EcoSpecies): Kind {
  if (typeof s !== 'object' || s === null || typeof s.id !== 'string' || !s.id)
    throw typeError('An ecosystem species has an id and a radius', 'biomes');
  const age = Math.round(num(s.age, 2, 3000, 200, 'species age')),
    rmax = Math.round(num(s.radius, 0.1, 40, 1, 'species radius') * 1000);
  return {
    id: s.id,
    rmax,
    growth: Math.round(num(s.growth, 0.01, 2, 0.15, 'species growth') * ONE),
    age,
    shade: Math.round(num(s.shade, 0, 1, 0.5, 'species shade') * ONE),
    seeds: Math.round(num(s.seeds, 0, 64, 4, 'species seeds') * ONE),
    scale: Math.max(1, Math.round(num(s.dispersal, 0.5, 2000, 10, 'species dispersal') * 100)),
    mature: Math.round(num(s.maturity, 0, 1, 0.4, 'species maturity') * rmax),
    base: divFloor(ONE, 4 * age),
  };
}

/**
 * Runs an ecosystem for `years` years from its plants (or from nothing but what seeds in, which is nothing): each year
 * every living plant is shaded by the taller crowns it overlaps, grows by what light reaches it, may die, and, once
 * mature, scatters seedlings. Plants are decided in order of birth with hashes of the seed, the plant and the year.
 * @throws RangeError or TypeError for bad options; RangeError for a plant naming no species.
 */
export function growEcosystem(options: EcosystemOptions): Ecosystem {
  if (typeof options !== 'object' || options === null)
    throw typeError('growEcosystem takes { bounds, species, plants?, years, ... }', 'biomes');
  const b = options.bounds;
  if (!Array.isArray(b) || b.length !== 4 || !b.every(near) || !(b[2] > b[0] && b[3] > b[1]))
    throw rangeError(
      'Ecosystem bounds are [x0, z0, x1, z1] in metres within 100 km of 0, with x1 > x0 and z1 > z0',
      'biomes',
    );
  if (!Array.isArray(options.species) || !options.species.length)
    throw typeError('An ecosystem has one or more species', 'biomes');
  const kinds = options.species.map(kindOf),
    index = new Map(kinds.map((k, i) => [k.id, i]));
  if (index.size !== kinds.length) throw rangeError('Two ecosystem species share an id', 'biomes');
  const years = options.years;
  if (!Number.isInteger(years) || years < 0 || years > 2000)
    throw rangeError('Ecosystem years is a whole number, 0..2000', 'biomes');
  const seed = options.seed ?? 0;
  if (!Number.isSafeInteger(seed)) throw rangeError('An ecosystem seed is an integer', 'biomes');
  const snags = Math.round(num(options.snags, 0, 200, 10, 'snags')),
    limit = Math.round(num(options.limit, 1, 1000000, 200000, 'limit')),
    where = options.where;
  if (where !== undefined && typeof where !== 'function')
    throw typeError('An ecosystem where is a function (x, z, species) => 0..1', 'biomes');
  const [x0, z0, x1, z1] = b.map((v) => Math.round(v * 100));
  // Plants as columns: x, z in cm, radius in mm, age and death year, species, birth number.
  let n = 0,
    cap = 1024;
  let X = new Int32Array(cap),
    Z = new Int32Array(cap),
    R = new Int32Array(cap),
    A = new Int32Array(cap),
    D = new Int32Array(cap),
    S = new Uint16Array(cap),
    N = new Int32Array(cap);
  let born = 0;
  const add = (s: number, x: number, z: number, r: number, age: number, died: number) => {
    if (n === cap) {
      cap *= 2;
      const grow = <T extends Int32Array | Uint16Array>(a: T): T => {
        const c = new (a.constructor as new (n: number) => T)(cap);
        c.set(a);
        return c;
      };
      [X, Z, R, A, D, N] = [X, Z, R, A, D, N].map(grow);
      S = grow(S);
    }
    X[n] = x;
    Z[n] = z;
    R[n] = r;
    A[n] = age;
    D[n] = died;
    S[n] = s;
    N[n] = born++;
    n++;
  };
  for (const p of options.plants ?? []) {
    if (typeof p !== 'object' || p === null)
      throw typeError('An ecosystem plant is { species, x, z, radius?, age? }', 'biomes');
    const s = index.get(p.species);
    if (s === undefined) throw rangeError('An ecosystem plant names a species of the ecosystem', 'biomes');
    if (!near(p.x) || !near(p.z)) throw rangeError('An ecosystem plant has an x and z within 100 km of 0', 'biomes');
    const k = kinds[s],
      r =
        p.radius === undefined
          ? Math.min(SEEDLING, k.rmax)
          : Math.round(num(p.radius, 0, 40, 0, 'plant radius') * 1000),
      age = Math.round(num(p.age, 0, 100000, 0, 'plant age'));
    add(s, Math.round(p.x * 100), Math.round(p.z * 100), clampInt(r, 1, k.rmax), age, -1);
  }
  const history: EcoYear[] = [],
    cs = new Int32Array(2);
  let crowded = 0;
  // Grid of crowns: cells as wide as the widest crown's diameter, so a crown overlaps only the 3 x 3 cells around it.
  const cell = Math.max(100, divFloor(2 * Math.max(...kinds.map((k) => k.rmax)), 10) + 1); // cm
  for (let year = 1; year <= years; year++) {
    const map = new Map<number, number[]>(),
      key = (cx: number, cz: number) => cx * 1048576 + cz;
    for (let i = 0; i < n; i++)
      if (D[i] < 0) {
        const k = key(divFloor(X[i], cell), divFloor(Z[i], cell));
        const list = map.get(k);
        if (list) list.push(i);
        else map.set(k, [i]);
      }
    // Shade: taller crowns (ties: the older plant) cover a share of this crown by their overlap depth.
    const E = new Int32Array(n);
    for (let i = 0; i < n; i++) {
      if (D[i] >= 0) continue;
      const cx = divFloor(X[i], cell),
        cz = divFloor(Z[i], cell);
      let shaded = 0;
      for (let dz = -1; dz <= 1 && shaded < ONE; dz++)
        for (let dx = -1; dx <= 1; dx++)
          for (const j of map.get(key(cx + dx, cz + dz)) ?? []) {
            if (j === i || R[j] < R[i] || (R[j] === R[i] && N[j] > N[i])) continue;
            const ex = X[j] - X[i],
              ez = Z[j] - Z[i],
              reach = R[i] + R[j], // mm
              d = isqrt((ex * ex + ez * ez) * 100); // mm, exact
            if (d >= reach) continue;
            shaded += divFloor((reach - d) * ONE, 2 * R[i]);
          }
      const L = ONE - clampInt(shaded, 0, ONE),
        k = kinds[S[i]];
      // Tolerant species keep up to half their growth in deep shade.
      E[i] = L + (qmul(k.shade, ONE - L) >> 1);
    }
    let died = 0,
      births = 0;
    const end = n;
    for (let i = 0; i < end; i++) {
      if (D[i] >= 0) continue;
      const k = kinds[S[i]],
        id = N[i];
      // Mortality: base, senescence past the lifespan, and suppression where growth is low (intolerant species more).
      let m = k.base + (A[i] >= k.age ? ONE >> 2 : 0) + qmul(qmul(ONE - E[i], ONE - (k.shade >> 1)), ONE >> 2);
      m = clampInt(m, 0, ONE);
      if (hash4(seed, id, year, SALT_DIE) >>> 16 < m) {
        D[i] = year;
        died++;
        continue;
      }
      // Logistic crown growth scaled by light.
      const dr = qmul(qmul(k.growth, E[i]), divFloor(R[i] * (k.rmax - R[i]), k.rmax));
      R[i] = clampInt(R[i] + Math.max(dr, 0), 1, k.rmax);
      A[i]++;
      if (R[i] < k.mature || !k.seeds) continue;
      // Seedlings: seeds * (r / rmax)^2 a year, the fraction by a hashed draw.
      const share = divFloor(R[i] * ONE, k.rmax),
        lambda = qmul(k.seeds, qmul(share, share)),
        count = Math.min(64, (lambda >> 16) + (hash4(seed, id, year, SALT_SEED) >>> 16 < (lambda & 0xffff) ? 1 : 0));
      for (let c = 0; c < count; c++) {
        const h = hash4(seed, id, year * 64 + c, SALT_DIST),
          v = (h >>> 16) + 1, // 1..65536
          // 2Dt with shape 1: r = scale * sqrt(1 / v - 1), v uniform in (0, 1]; capped at 30 scales. The ratio is Q16, so
          // isqrt of it times ONE is its root in Q16.
          r = Math.min(30 * k.scale, qmul(k.scale, isqrt(divFloor((65536 - v) * 65536, v) * ONE))),
          turn = hash4(seed, id, year * 64 + c, SALT_TURN) | 0;
        sincos(turn, cs);
        const sx = X[i] + qmul(r, cs[0]),
          sz = Z[i] + qmul(r, cs[1]);
        if (sx < x0 || sz < z0 || sx >= x1 || sz >= z1) continue;
        if (where) {
          const q = where(sx / 100, sz / 100, k.id); // float division: metres for the callback
          const chance = Number.isFinite(q) ? clampInt(Math.round(q * ONE), 0, ONE) : 0;
          if (hash4(seed, id, year * 64 + c, SALT_SITE) >>> 16 >= chance) continue;
        }
        if (n >= limit) {
          crowded++;
          continue;
        }
        add(S[i], sx, sz, Math.min(SEEDLING, k.rmax), 0, -1);
        births++;
      }
    }
    // Snags fall and are gone `snags` years after death.
    let w = 0;
    for (let i = 0; i < n; i++) {
      if (D[i] >= 0 && year - D[i] >= snags) continue;
      if (w !== i) {
        X[w] = X[i];
        Z[w] = Z[i];
        R[w] = R[i];
        A[w] = A[i];
        D[w] = D[i];
        S[w] = S[i];
        N[w] = N[i];
      }
      w++;
    }
    n = w;
    let alive = 0;
    for (let i = 0; i < n; i++) if (D[i] < 0) alive++;
    history.push(Object.freeze({ year, alive, born: births, died }));
  }
  const plants: EcoPlant[] = [],
    counts: Record<string, number> = {};
  for (const living of [true, false])
    for (let i = 0; i < n; i++)
      if (D[i] < 0 === living) {
        const k = kinds[S[i]];
        if (living) counts[k.id] = (counts[k.id] ?? 0) + 1;
        plants.push(
          Object.freeze({
            species: k.id,
            x: X[i] / 100, // float division: centimetres to metres for output
            z: Z[i] / 100, // float division: centimetres to metres for output
            radius: R[i] / 1000, // float division: millimetres to metres for output
            age: A[i],
            ...(living ? {} : { died: D[i] }),
          }),
        );
      }
  return Object.freeze({
    years,
    plants: Object.freeze(plants),
    counts: Object.freeze(counts),
    history: Object.freeze(history),
    crowded,
  });
}

/**
 * The stored plants of a placed tile as ecosystem founders: each object's species key (`'<biome>/<species>'`), place
 * and crown (the species' reference radius times its scale). Rocks and props are left out; dead standing trees and
 * logs too.
 */
export function plantsFromTile(placement: BiomePlacement, tile: PlacedTile): EcoPlant[] {
  const radius = new Map(placement.species.filter((s) => s.kind === 'plant').map((s) => [s.key, s.radius])),
    out: EcoPlant[] = [];
  tile.forEachInstance((o) => {
    const r = radius.get(o.key);
    if (r !== undefined && o.age < 2) out.push({ species: o.key, x: o.x, z: o.z, radius: r * o.scale });
  });
  return out;
}
