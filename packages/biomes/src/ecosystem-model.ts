// Deterministic annual ecosystem transition shared by the offline map and the world solver.
import { rangeError, typeError } from '../../shared/errors.js';
import type { EcosystemOptions, EcoPlant, EcoSpecies, EcoYear, Ecosystem } from './ecosystem.js';
import { clampInt, divFloor, isqrt, ONE, qmul, sincos } from './fixed.js';
import { hash4 } from './hash.js';

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

export function ecosystemConfig(options: Omit<EcosystemOptions, 'years'>) {
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
  if (options.species.length > 65536) throw rangeError('Use at most 65536 ecosystem species', 'biomes');
  const kinds = options.species.map(kindOf),
    index = new Map(kinds.map((k, i) => [k.id, i]));
  if (index.size !== kinds.length) throw rangeError('Two ecosystem species share an id', 'biomes');
  const seed = options.seed ?? 0;
  if (!Number.isSafeInteger(seed)) throw rangeError('An ecosystem seed is an integer', 'biomes');
  const snags = Math.round(num(options.snags, 0, 200, 10, 'snags')),
    limit = Math.round(num(options.limit, 1, 1000000, 200000, 'limit')),
    where = options.where;
  if (where !== undefined && typeof where !== 'function')
    throw typeError('An ecosystem where is a function (x, z, species) => 0..1', 'biomes');
  const [x0, z0, x1, z1] = b.map((v) => Math.round(v * 100));
  const cell = Math.max(100, divFloor(2 * kinds.reduce((m, kind) => Math.max(m, kind.rmax), 0), 10) + 1);
  return { kinds, index, x0, z0, x1, z1, cell, seed, snags, limit, where };
}

export interface ForestColumns {
  x: Int32Array;
  z: Int32Array;
  radius: Int32Array;
  age: Int32Array;
  death: Int32Array;
  species: Int32Array;
  identity: Int32Array;
}

export interface ForestPopulation {
  columns: ForestColumns;
  length: number;
  births: number;
  crowded: number;
}

export interface AnnualEffects {
  kills(xCm: number, zCm: number, species: number, identity: number, year: number): boolean;
  grows(index: number, xCm: number, zCm: number, species: number, oldRadius: number, radius: number): void;
  establishes(xCm: number, zCm: number, species: number): boolean;
  born(index: number): void;
  moves(from: number, to: number): void;
}

export function plantColumns(capacity: number): ForestColumns {
  return {
    x: new Int32Array(capacity),
    z: new Int32Array(capacity),
    radius: new Int32Array(capacity),
    age: new Int32Array(capacity),
    death: new Int32Array(capacity),
    species: new Int32Array(capacity),
    identity: new Int32Array(capacity),
  };
}

type Config = ReturnType<typeof ecosystemConfig>;
type AddPlant = (species: number, x: number, z: number, r: number, age: number, died: number) => void;

export function plantAdder(population: ForestPopulation): AddPlant {
  return (species, x, z, radius, age, death) => {
    const row = population.length;
    if (row === population.columns.x.length) {
      const previous = population.columns;
      population.columns = plantColumns(Math.max(1, row * 2));
      for (const key of Object.keys(previous) as (keyof ForestColumns)[]) population.columns[key].set(previous[key]);
    }
    population.length++;
    const columns = population.columns;
    columns.x[row] = x;
    columns.z[row] = z;
    columns.radius[row] = radius;
    columns.age[row] = age;
    columns.death[row] = death;
    columns.species[row] = species;
    columns.identity[row] = population.births++;
  };
}

export function seedForest(config: Config, plants: EcosystemOptions['plants'], add: AddPlant): void {
  const { index, kinds } = config;
  for (const p of plants ?? []) {
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
}

function crownShade(population: ForestPopulation, cell: number): Int32Array {
  const {
    columns: { x: X, z: Z, radius: R, death: D, identity: N },
    length: n,
  } = population;
  const map = new Map<number, number[]>();
  const key = (cx: number, cz: number) => cx * 1048576 + cz;
  for (let i = 0; i < n; i++) {
    if (D[i] >= 0) continue;
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
    E[i] = clampInt(shaded, 0, ONE);
  }
  return E;
}

export function ecosystemYear(
  config: Config,
  population: ForestPopulation,
  year: number,
  add: AddPlant,
  effects: AnnualEffects | undefined,
  shade: (population: ForestPopulation, cell: number) => Int32Array,
): EcoYear {
  const { kinds, cell, x0, z0, x1, z1, seed, snags, limit, where } = config;
  let { x: X, z: Z, radius: R, age: A, death: D, species: S, identity: N } = population.columns;
  const cs = new Int32Array(2);
  let n = population.length;
  let died = 0;
  if (effects) {
    for (let i = 0; i < n; i++) {
      if (D[i] >= 0 || !effects.kills(X[i], Z[i], S[i], N[i], year)) continue;
      D[i] = year;
      died++;
    }
  }
  const shaded = shade(population, cell);
  let births = 0;
  const end = n;
  for (let i = 0; i < end; i++) {
    if (D[i] >= 0) continue;
    const k = kinds[S[i]],
      id = N[i];
    // Tolerant species keep up to half their growth in deep shade.
    const light = ONE - shaded[i] + (qmul(k.shade, shaded[i]) >> 1);
    // Mortality: base, senescence past the lifespan, and suppression where growth is low (intolerant species more).
    let m = k.base + (A[i] >= k.age ? ONE >> 2 : 0) + qmul(qmul(ONE - light, ONE - (k.shade >> 1)), ONE >> 2);
    m = clampInt(m, 0, ONE);
    if (hash4(seed, id, year, SALT_DIE) >>> 16 < m) {
      D[i] = year;
      died++;
      continue;
    }
    // Logistic crown growth scaled by light.
    const dr = qmul(qmul(k.growth, light), divFloor(R[i] * (k.rmax - R[i]), k.rmax));
    const grown = clampInt(R[i] + Math.max(dr, 0), 1, k.rmax);
    effects?.grows(i, X[i], Z[i], S[i], R[i], grown);
    R[i] = grown;
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
      if (effects && !effects.establishes(sx, sz, S[i])) continue;
      if (n >= limit) {
        population.crowded++;
        continue;
      }
      add(S[i], sx, sz, Math.min(SEEDLING, k.rmax), 0, -1);
      n++;
      if (X !== population.columns.x)
        ({ x: X, z: Z, radius: R, age: A, death: D, species: S, identity: N } = population.columns);
      effects?.born(n - 1);
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
      effects?.moves(i, w);
    }
    w++;
  }
  population.length = w;
  n = w;
  let alive = 0;
  for (let i = 0; i < n; i++) if (D[i] < 0) alive++;
  return Object.freeze({ year, alive, born: births, died });
}

export function runEcosystem(options: EcosystemOptions): Ecosystem {
  const config = ecosystemConfig(options);
  const { years } = options;
  if (!Number.isInteger(years) || years < 0 || years > 2000)
    throw rangeError('Ecosystem years is a whole number, 0..2000', 'biomes');
  const founders = options.plants ?? [];
  const population: ForestPopulation = { columns: plantColumns(founders.length), length: 0, births: 0, crowded: 0 };
  const add = plantAdder(population);
  seedForest(config, founders, add);
  const history: EcoYear[] = [];
  for (let year = 1; year <= years; year++) {
    history.push(ecosystemYear(config, population, year, add, undefined, crownShade));
  }
  const { kinds } = config;
  const { length: n, crowded } = population;
  const { x: X, z: Z, radius: R, age: A, death: D, species: S } = population.columns;
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
