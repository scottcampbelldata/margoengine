/// <reference lib="esnext.disposable" preserve="true" />
// Stored-object placement (spec 2.4, B5): trees, shrubs, rocks and props of a biome world, as 8-byte records per tile.
// Everything that decides an object (where it is, whether it exists, its size and kind) is integer arithmetic on
// world-anchored hashes, so the same world gives the same records in any tile order, in any tile size, on any machine,
// and the GPU path (B8) can reproduce them byte for byte.
// Sources: candidates and density thinning against each candidate's own hashed number, as in Lane and Prusinkiewicz
// 2002 (multilevel distributions); clusters as a shot-noise Cox process, which is the Neyman-Scott process (Thomas 1949
// Gaussian, Matern 1960 disc, Clark et al. 1999 2Dt fat-tailed kernel) with Poisson offspring; the variable-radius hard
// core by Luby's (1986) rounds with fixed priorities, which settle to the greedy sequential set (Blelloch, Fineman and
// Shun 2012), cut at K rounds with the rest rejected and counted; canopy layers by the perfect plasticity
// approximation (Purves et al. 2008, Strigul et al. 2008) with a size-asymmetric light share; reverse-J (de Liocourt
// 1898) and Weibull (Bailey and Dell 1973) diameters, Chapman-Richards (Richards 1959) heights and power-law crowns
// (West, Brown and Enquist 1999); edge effects after Murcia 1995 and Harper et al. 2005.
import type { RasterLayer } from '@margoengine/biomes';
import type { BiomeTile, BiomeWorld } from '@margoengine/biomes';
import {
  clampInt,
  divFloor,
  fbm,
  hash2,
  hash5,
  isqrt,
  ONE,
  pcg,
  qexp2,
  qlog2,
  qmul,
  qpow,
  wendland,
} from '@margoengine/biomes/toolkit';
import { fault, rangeError, typeError } from '../../shared/errors.js';
import { type BiomeDefinition, type Dimension, fieldDimension, type SpeciesRule } from './define.js';
import { placementReach, STRATA } from './reach.js';

/** Position unit: 1/256 m (3.9 mm), the step of a record inside a 256 m tile. */
const TICK = 256;
/** Perfect plasticity cells: 32 m, world-anchored, inside every tile size. */
const PPA_SHIFT = 13; // 2^13 ticks = 32 m
/** log2(e) in Q16. */
const LOG2E = 94548;
/** Largest local cluster intensity, as a multiple of the mean (candidates are generated at this rate). */
const CLUSTER_CAP = 4;
/** Fade of a stand's edge, in units of the 0..65535 noise (0.6 of its standard deviation): about a quarter of `scale`. */
const STAND_BAND = 6000;
/**
 * The noise level a stand's band is centred on for a cover of 1/16, 2/16 .. 16/16 of the ground: the mean of the band
 * over 3-octave fbm equals the cover. Measured once, 320,000 samples over 16 seeds; the distribution is the same for
 * every seed, and the placement test checks the share it gives.
 */
const STAND_LEVELS = [
  46857, 43445, 40954, 38837, 36934, 35151, 33433, 31745, 30058, 28339, 26559, 24661, 22553, 20044, 16667, 0,
];
/** Fates of a candidate. */
const LIVE = 0,
  ACCEPTED = 1,
  KILLED = 2;

/** A vector exclusion: no stored object stands inside it; `verge` metres around it count as an edge. */
export type Exclusion =
  | {
      /** A road or river: a polyline `[x, z]` in metres with a width. */
      readonly kind: 'line';
      readonly points: readonly (readonly [number, number])[];
      readonly width: number;
      readonly verge?: number;
    }
  | {
      /** A building or yard: a closed polygon `[x, z]` in metres. */
      readonly kind: 'polygon';
      readonly points: readonly (readonly [number, number])[];
      readonly verge?: number;
    };

/** Settings of {@link BiomePlacement.attach}. */
export interface PlacementOptions {
  /** Luby rounds of the hard core, 1..16. Candidates still undecided after them are rejected (and counted). Default 6. */
  readonly rounds?: number;
  /**
   * Species-pair spacing: `'idA|idB'` (species ids, either order) to a factor on the sum of the two crown radii. Default
   * 0.85 within a layer (crowns interlock a little) and 0.3 across layers (a shrub may grow under a crown, not at the
   * trunk).
   */
  readonly conflicts?: Readonly<Record<string, number>>;
  /** Roads, rivers and buildings where nothing is placed. Default none. */
  readonly exclusions?: readonly Exclusion[];
}

/** One species of the world's palette: a biome's species rule with what placement made of it. */
export interface PlacedSpecies {
  /** `'<biome>/<species>'`. */
  readonly key: string;
  readonly id: string;
  readonly biome: string;
  readonly kind: 'plant' | 'rock' | 'prop';
  /** Layer, placed in this order: 0 rocks, 1 canopy trees, 2 understory, 3 shrubs and ground plants, 4 props. */
  readonly layer: number;
  readonly mesh: string;
  /** Crown or footprint radius in metres at reference size (scale 1). */
  readonly radius: number;
  readonly tags: readonly string[];
  /** Plants per hectare at full suitability, and whether a cluster rule gathers them. */
  readonly density: number;
  readonly clustered: boolean;
}

/** A detail species' density over a tile: `value / 255 * density` instances per square metre. */
export interface DensityMap {
  readonly id: string;
  readonly mesh: string;
  /** Instances per square metre at full suitability. */
  readonly density: number;
  /** u8 per cell, `cells` x `cells` rows of increasing z. */
  readonly data: Uint8Array;
  /** The same map every `every` cells (`ceil(cells / every)` square), when a worker sampled it for a view. */
  readonly sampled?: { readonly every: number; readonly data: Uint8Array };
}

/** One stored object, decoded from its record (floats for rendering; the record holds the decided integers). */
export interface InstanceView {
  /** World XZ in metres. */
  x: number;
  z: number;
  /** Index into the tile palette, and the palette key `'<biome>/<species>'`. */
  species: number;
  key: string;
  /** Scale relative to the species' reference size, yaw in radians, variant 0..15. */
  scale: number;
  yaw: number;
  variant: number;
  /** 0 canopy (or open grown), 1 understory, 2 dead standing, 3 fallen log. */
  age: number;
}

/** The objects of one tile. */
export interface PlacedTile {
  readonly x: number;
  readonly z: number;
  /** World XZ of the tile's minimum corner and its side, metres. */
  readonly origin: readonly [number, number];
  readonly size: number;
  /**
   * 8-byte records, little endian: u16 x and u16 z inside the tile (65,536 steps over the side), u8 palette index, u8
   * log scale (128 + 32 log2 scale), u8 yaw (256 steps a turn), u8 variant (low 4 bits) and age (high 4 bits). Sorted by
   * palette index, then z, then x.
   */
  readonly instances: Uint8Array;
  readonly count: number;
  /** The tile palette: species keys, in world palette order. */
  readonly species: readonly string[];
  /** Crown cover per world cell, u8 (255 covered). */
  readonly canopy: RasterLayer;
  /** Exclusion mask per world cell, u8 (255 inside). */
  readonly exclusion: RasterLayer;
  /** Detail species densities (grass, flowers, pebbles), drawn per frame by scatter, never stored as objects. */
  readonly density: readonly DensityMap[];
  /** Candidates generated in the tile's placement cells (before thinning), objects accepted, candidates left undecided
   * after the last round, and how many candidates settled in each round (index 0 is round 1). */
  readonly stats: {
    readonly candidates: number;
    readonly accepted: number;
    readonly unresolved: number;
    readonly rounds: Uint32Array;
  };
  /**
   * The records grouped by palette index, dead standing trees and logs apart (`dead`), in record order: given when a
   * worker placed the tile (it splits them there, off the page's thread).
   */
  readonly groups?: readonly { readonly species: number; readonly dead: boolean; readonly records: Uint8Array }[];
  /** Calls `visit` with each object, decoded; `out` is reused between calls. */
  forEachInstance(visit: (instance: InstanceView) => void): void;
}

/** A placed tile from its data (made here or sent by a worker): frozen, with the record decoder. */
function placed(t: Omit<PlacedTile, 'forEachInstance'>): PlacedTile {
  const { origin, size: side, instances, count, species } = t;
  return Object.freeze({
    ...t,
    forEachInstance(visit: (instance: InstanceView) => void) {
      const out = {} as InstanceView;
      for (let k = 0; k < count; k++) {
        const at = k * 8;
        out.x = origin[0] + ((instances[at] | (instances[at + 1] << 8)) * side) / 65536; // float division: render bridge
        out.z = origin[1] + ((instances[at + 2] | (instances[at + 3] << 8)) * side) / 65536; // float division
        out.species = instances[at + 4];
        out.key = species[out.species];
        out.scale = 2 ** ((instances[at + 5] - 128) / 32); // float division: render bridge
        out.yaw = (instances[at + 6] * Math.PI) / 128; // float division
        out.variant = instances[at + 7] & 15;
        out.age = instances[at + 7] >> 4;
        visit(out);
      }
    },
  });
}

/** Placed tiles kept per placement; the least recently used go first. */
const CACHE = 64;
/** Ids of placements, for their replicas in a world's workers. */
let serial = 0;

type Rect = readonly [number, number, number, number];

/** A species prepared for placement: everything as integers. */
interface Spec extends PlacedSpecies {
  readonly index: number;
  readonly code: number; // u32 hash of the key
  readonly biomeIndex: number;
  readonly r: number; // reference crown radius, ticks
  readonly shade: number; // Q16
  readonly dims: readonly Dimension[];
  readonly size: number; // 0 none, 1 reverse-j, 2 weibull
  readonly sa: number; // reverse-j: rate a (Q16 per unit u); weibull: shape (Q16)
  readonly sb: number; // reverse-j: u min (Q16); weibull: scale (Q16)
  readonly sc: number; // reverse-j: u max (Q16)
  readonly sd: number; // reverse-j: 1 - exp(-a (umax - umin)) (Q16)
  readonly mMax: number; // largest crown multiplier, Q16
  readonly height: number; // reference height, cm
  readonly lambda: number; // density at full suitability, per m^2, Q16
  readonly room: number; // the density crowns of mean size fill, per m^2, Q16 (0: sizes do not respond)
  readonly kappa: number; // candidate oversampling, Q16
  readonly gen: number; // generation cell, ticks
  readonly mu: number; // expected candidates per generation cell, Q16
  readonly e0: number; // exp(-mu), Q16: the Poisson draw's first term
  readonly cluster?: Cluster;
  readonly stands?: Stands;
}

interface Stands {
  readonly scale: number; // one noise cell, ticks
  readonly top: number; // the noise level (0..65535) from which the density is full
  readonly boost: number; // 1 / cover, Q16: the whole density lives on the cover share of the ground
}

interface Cluster {
  readonly table: Int32Array; // contribution to C (Q16) over d^2 in 256 steps of reach^2
  readonly reach: number; // ticks
  readonly cell: number; // parent cell, ticks
  readonly mu: number; // parents per parent cell, Q16
  readonly e0: number; // exp(-mu), Q16
  readonly beta: number; // clustered share, Q16
  readonly code: number;
}

interface Stratum {
  readonly species: readonly Spec[];
  readonly g: number; // cell, ticks, a power of two
  readonly gs: number; // log2 g
  readonly dmax: number; // largest conflict distance in the layer, ticks
  readonly rmax: number; // largest crown radius in the layer, ticks
}

/** Fixed per world: palette, strata and spacing. */
interface Plan {
  readonly specs: readonly Spec[];
  readonly strata: readonly Stratum[];
  readonly factor: Int32Array; // pair spacing factor (Q16), specs.length^2
  readonly across: number; // the largest factor between layers, Q16
  readonly within: number; // the largest factor within a layer, Q16
  readonly rounds: number;
  readonly details: readonly {
    id: string;
    mesh: string;
    density: number;
    parts: { biome: number; dims: readonly Dimension[]; light?: Dimension }[];
  }[];
}

/** FNV-1a of a string, u32. */
function fnv(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

const toQ = (v: number) => Math.round(v * ONE);

/** Quantised settings of a size distribution (see SizeDistribution). */
function sizeOf(rule: SpeciesRule): Pick<Spec, 'size' | 'sa' | 'sb' | 'sc' | 'sd' | 'mMax'> {
  const s = rule.size;
  if (!s) return { size: 0, sa: 0, sb: ONE, sc: ONE, sd: 0, mMax: ONE };
  if (s.kind === 'reverse-j') {
    if (!(s.q > 1 && s.q <= 10 && s.max >= 0.5 && s.max <= 8))
      throw rangeError('A reverse-j size needs q in 1..10 (above 1) and max in 0.5..8', 'biomes');
    // Diameter classes of 0.1 reference sizes; frequencies fall by q per class: rate ln(q) / 0.1.
    const umax = qpow(toQ(s.max), 87381), // max crown multiplier^(4/3): the stem size of the largest crown
      a = divFloor(qmul(qlog2(toQ(s.q)), 45426) * 10, 1), // ln q = log2 q * ln 2 (45,426 in Q16)
      umin = divFloor(umax, 10),
      sd = ONE - qexp2(-Math.min(15 * ONE, qmul(qmul(a, umax - umin), LOG2E)));
    return { size: 1, sa: a, sb: umin, sc: umax, sd, mMax: toQ(s.max) };
  }
  if (s.kind === 'weibull') {
    if (!(s.shape >= 0.5 && s.shape <= 10 && s.scale > 0 && s.scale <= 4))
      throw rangeError('A weibull size needs shape in 0.5..10 and scale in 0..4 (above 0)', 'biomes');
    const scale = toQ(s.scale);
    // The largest draw is 3 scales (the 99.99th percentile for shape 2).
    return { size: 2, sa: toQ(s.shape), sb: scale, sc: 3 * scale, sd: 0, mMax: qpow(3 * scale, 49152) };
  }
  throw rangeError("A size distribution kind is 'reverse-j' or 'weibull'", 'biomes');
}

/**
 * The density (per m^2, Q16) at which crowns of a species' mean size fill the ground they may share: 0.757 of it, the
 * random-adsorption jamming cover (0.547) of discs allowed to interlock to 0.85 of their radii. Above it sizes shrink
 * so crowns still fit (Reineke's space filling): with crowns growing as size^0.75 this gives a size-density frontier
 * of slope -1.5. Mean crown area from 256 quantiles of the size distribution, in integers.
 */
function roomOf(radius: number, sizes: Pick<Spec, 'size' | 'sa' | 'sb' | 'sc' | 'sd' | 'mMax'>): number {
  let area = 0;
  for (let q = 0; q < 256; q++) {
    const m = qpow(Math.max(1, drawSize(sizes as Spec, (q * 256 + 128) << 16)), 49152);
    area += qmul(m, m);
  }
  area = Math.max(1, area >> 8); // mean m^2, Q16
  return Math.max(1, Math.round(((0.757 / (Math.PI * radius * radius)) * 65536 * 65536) / area)); // float division: an option quantised once
}

/** Relative stem size u (Q16) for a uniform u32 draw. */
function drawSize(s: Spec, h: number): number {
  const p = (h >>> 16) + 1; // 1..65536, never 0 or 1 exactly below
  if (s.size === 1) {
    // Inverse CDF of the truncated exponential: umin - ln(1 - p d) / a.
    const q = ONE - qmul(p, s.sd);
    return Math.min(s.sc, s.sb + divFloor(-qmul(qlog2(Math.max(1, q)), 45426) * ONE, s.sa));
  }
  if (s.size === 2) {
    // scale (-ln(1 - p))^(1 / shape).
    const e = -qmul(qlog2(Math.max(1, ONE - p + 1)), 45426);
    return Math.min(s.sc, qmul(s.sb, qpow(Math.max(1, e), divFloor(ONE * ONE, s.sa))));
  }
  return ONE;
}

/** A cluster kernel as a table of C contributions (Q16) over d^2, normalised so C averages 1 over the plane. */
function clusterOf(rule: SpeciesRule, index: number, code: number): Cluster | undefined {
  const c = rule.cluster;
  if (!c) return undefined;
  const kinds = ['thomas', 'matern', '2dt'];
  if (!kinds.includes(c.kind) || !(c.parents > 0 && c.parents <= 1e4) || !(c.spread > 0 && c.spread <= 500))
    throw rangeError(
      "A cluster needs kind 'thomas', 'matern' or '2dt', parents 0..10,000 per ha and spread 0..500 m",
      'biomes',
    );
  const offspring = c.offspring ?? rule.density / c.parents, // float division: option
    tail = (c as { tail?: number }).tail ?? 1;
  if (!(offspring > 0) || !(tail >= 0.5 && tail <= 8))
    throw rangeError('A cluster needs offspring above 0 and a 2dt tail in 0.5..8', 'biomes');
  // Reach: 3 sigma (Thomas), the disc (Matern), 4 spreads (2Dt, 94 % of the mass for tail 1).
  const reachM = Math.ceil(c.kind === 'thomas' ? 3 * c.spread : c.kind === 'matern' ? c.spread : 4 * c.spread),
    reach = reachM * TICK,
    spread = toQ(c.spread),
    tailQ = toQ(tail),
    raw = new Int32Array(257);
  for (let j = 0; j <= 256; j++) {
    // d^2 / spread^2 in Q16 at step j of reach^2.
    const t = divFloor(j * reachM * reachM * ONE, 256 * c.spread * c.spread) | 0;
    raw[j] =
      c.kind === 'matern'
        ? j < 256
          ? ONE
          : 0
        : c.kind === 'thomas'
          ? qexp2(-Math.min(15 * ONE, qmul(t >> 1, LOG2E))) // exp(-d^2 / 2 sigma^2)
          : qpow(divFloor(ONE * ONE, ONE + t), tailQ + ONE); // (1 + d^2 / u)^-(p + 1)
  }
  // Mass = pi * integral of k over d^2 (trapezoid), in m^2 times Q16: the kernel is raw / mass.
  let sum = 0;
  for (let j = 0; j < 256; j++) sum += raw[j] + raw[j + 1];
  const mass = divFloor(divFloor(205887 * sum, 512) * reachM * reachM, ONE), // Q16 m^2: pi * (sum / 2) * reach^2 / 256
    parents = toQ(c.parents), // per ha, Q16
    // C contribution = raw / (mass * parents per m^2): table in Q16.
    z = divFloor(mass * parents, 10000 * ONE) || 1,
    table = new Int32Array(257);
  for (let j = 0; j <= 256; j++) table[j] = divFloor(raw[j] * ONE, z);
  void spread;
  // Parents: one cell per mean parent spacing, Poisson counts.
  const cellM = Math.max(1, Math.round(Math.sqrt(10000 / c.parents))), // float division: option
    beta = Math.min(ONE, toQ((c.parents * offspring) / Math.max(rule.density, 1e-9))); // float division: option
  return {
    table,
    reach,
    cell: cellM * TICK,
    mu: divFloor(parents * cellM * cellM, 10000),
    e0: firstTerm(divFloor(parents * cellM * cellM, 10000)),
    beta,
    code: (code ^ 0x51ed270b ^ index) >>> 0,
  };
}

/** A stand rule in integers. A cover of 1 is no stand at all: the same bytes as leaving the rule out. */
function standsOf(rule: SpeciesRule): Stands | undefined {
  const s = rule.stands;
  if (!s || s.cover >= 1) return undefined;
  const cover = toQ(s.cover),
    i = (cover * 16) >> 16, // the cover is at least 0.1, so i is at least 1
    level = STAND_LEVELS[i - 1] + qmul(STAND_LEVELS[i] - STAND_LEVELS[i - 1], (cover * 16) & 0xffff);
  return { scale: Math.round(s.scale * TICK), top: level + (STAND_BAND >> 1), boost: divFloor(ONE * ONE, cover) };
}

/** exp(-mu) in Q16 for a mean mu (Q16): the first term of {@link poisson}. */
const firstTerm = (mu: number) => qexp2(-Math.min(15 * ONE, qmul(mu, LOG2E)));

/** Poisson count for mean mu (Q16, at most 8, with e0 = firstTerm(mu)) from a u32 draw: inverse CDF in Q16. */
function poisson(mu: number, e0: number, h: number): number {
  const u = h >>> 16;
  let p = e0,
    cdf = p,
    k = 0;
  while (u >= cdf && k < 40) {
    k++;
    p = divFloor(p * mu, k * ONE);
    if (!p) break;
    cdf += p;
  }
  return k;
}

/** Builds the per-world plan: palette, layers, spacing. */
function planOf(biomes: readonly BiomeDefinition[], options: PlacementOptions): Plan {
  const rounds = options.rounds ?? 6;
  if (!Number.isInteger(rounds) || rounds < 1 || rounds > 16)
    throw rangeError('BiomePlacement rounds must be an integer in 1..16', 'biomes');
  const specs: Spec[] = [];
  biomes.forEach((b, biomeIndex) => {
    const lists: [SpeciesRule[], 'plant' | 'rock' | 'prop'][] = [
      [[...(b.plants ?? [])], 'plant'],
      [[...(b.rocks ?? [])], 'rock'],
      [[...(b.props ?? [])], 'prop'],
    ];
    for (const [list, kind] of lists)
      for (const rule of list) {
        const key = `${b.id}/${rule.id}`,
          index = specs.length,
          code = fnv(key),
          layer = kind === 'rock' ? 0 : kind === 'prop' ? 4 : STRATA(rule.radius),
          sizes = sizeOf(rule),
          cluster = clusterOf(rule, index, code),
          stands = standsOf(rule),
          capQ = cluster ? ONE + qmul(cluster.beta, (CLUSTER_CAP - 1) * ONE) : ONE,
          // Edges raise lower layers up to 1.5 times; convex ground raises rocks up to 2 times; a stand holds 1 / cover.
          kappa = qmul(
            stands ? qmul(capQ, stands.boost) : capQ,
            layer >= 2 && layer <= 3 ? 98304 : layer === 0 ? 2 * ONE : ONE,
          ),
          r = Math.max(1, Math.round(rule.radius * TICK)),
          perHa = toQ(rule.density); // Q16 per ha
        specs.push({
          key,
          id: rule.id,
          biome: b.id,
          kind,
          layer,
          mesh: rule.mesh,
          radius: rule.radius,
          tags: Object.freeze([...(rule.tags ?? [])]),
          density: rule.density,
          clustered: !!rule.cluster,
          index,
          code,
          biomeIndex,
          r,
          shade: toQ(rule.shade ?? 0.5),
          dims: Object.entries(rule.suitability ?? {}).map(([f, range]) => fieldDimension(f as 'slope', range!, 0.15)),
          ...sizes,
          height: Math.round(rule.radius * 450), // cm: 4.5 crown radii
          lambda: Math.round(rule.density * 6.5536), // per m^2 in Q16: density / 10,000 * 65,536
          room: kind === 'plant' ? roomOf(rule.radius, sizes) : 0,
          kappa,
          gen: 0,
          mu: qmul(perHa, kappa), // per ha for now; set per generation cell below
          e0: 0,
          cluster,
          stands,
        });
      }
  });
  if (specs.length > 255) throw rangeError('A world can place at most 255 species', 'biomes');
  // Pair spacing factors.
  const n = specs.length,
    factor = new Int32Array(n * n),
    conflicts = options.conflicts ?? {};
  if (typeof conflicts !== 'object') throw typeError('BiomePlacement conflicts is an object of factors', 'biomes');
  for (const [k, v] of Object.entries(conflicts))
    if (!/^[^|]+\|[^|]+$/.test(k) || !(v >= 0 && v <= 4))
      throw rangeError("A conflict is 'idA|idB' with a factor in 0..4", 'biomes');
  for (const a of specs)
    for (const b of specs) {
      const f = conflicts[`${a.id}|${b.id}`] ?? conflicts[`${b.id}|${a.id}`] ?? (a.layer === b.layer ? 0.85 : 0.3);
      factor[a.index * n + b.index] = toQ(f);
    }
  // Strata: cell = the largest spacing in the layer, whole metres, power-of-two ticks.
  const strata: Stratum[] = [];
  for (let layer = 0; layer < 5; layer++) {
    const list = specs.filter((s) => s.layer === layer);
    let dmax = TICK,
      rmax = 0;
    for (const a of list) {
      rmax = Math.max(rmax, qmul(a.r, a.mMax) + 1);
      for (const b of list)
        dmax = Math.max(dmax, qmul(factor[a.index * n + b.index], qmul(a.r, a.mMax) + qmul(b.r, b.mMax)) + 1);
    }
    let g = TICK;
    while (g < dmax) g *= 2;
    for (const s of list) {
      // Generation cells: g / 2^k, so each holds at most about 4 candidates on average.
      let gen = g;
      const perM2 = (m: number) => divFloor(s.mu * (m >> 8) * (m >> 8), 10000); // Q16 candidates in an m x m tick cell
      while (gen > TICK && perM2(gen) > 4 * ONE) gen >>= 1;
      (s as { gen: number }).gen = gen;
      const mu = perM2(gen);
      (s as { mu: number }).mu = mu;
      (s as { e0: number }).e0 = firstTerm(mu);
    }
    strata.push({ species: list, g, gs: 31 - Math.clz32(g), dmax, rmax });
  }
  const details = new Map<string, Plan['details'][number]>();
  biomes.forEach((b, biome) => {
    for (const d of b.details ?? []) {
      let entry = details.get(d.id);
      if (!entry) details.set(d.id, (entry = { id: d.id, mesh: d.mesh, density: d.density, parts: [] }));
      entry.parts.push({
        biome,
        dims: Object.entries(d.suitability ?? {}).map(([f, range]) => fieldDimension(f as 'slope', range!, 0.15)),
        light: d.light ? fieldDimension('moisture', d.light, 0.15) : undefined,
      });
    }
  });
  let within = 0,
    across = 0;
  for (const a of specs)
    for (const b of specs)
      if (a.layer === b.layer) within = Math.max(within, factor[a.index * n + b.index]);
      else across = Math.max(across, factor[a.index * n + b.index]);
  return { specs, strata, factor, within, across, rounds, details: [...details.values()] };
}

/** Fields of one world tile that placement reads. */
interface Fields {
  /** present[b] is 1 when biome b has weight somewhere in the tile. */
  readonly present: Uint8Array;
  readonly ids: Uint8Array;
  readonly weights: Uint8Array;
  readonly layers: Readonly<Record<string, ArrayLike<number>>>;
}

/** Thrown when a lookup needs a world tile not yet made; the driver makes it and runs again. */
class Missing {
  constructor(
    readonly x: number,
    readonly z: number,
  ) {}
}

/** Exclusions in ticks: segments with a half width, polygons, verges. */
interface Shapes {
  readonly lines: Float64Array; // ax, az, bx, bz, half, verge per segment
  readonly polys: readonly { pts: Float64Array; verge: number; box: Rect }[];
}

function shapesOf(exclusions: readonly Exclusion[] | undefined, origin: readonly [number, number]): Shapes {
  const lines: number[] = [],
    polys: Shapes['polys'][number][] = [];
  const t = (p: readonly [number, number]) => [
    Math.round((p[0] - origin[0]) * TICK),
    Math.round((p[1] - origin[1]) * TICK),
  ];
  for (const e of exclusions ?? []) {
    if (
      !e ||
      !Array.isArray(e.points) ||
      e.points.length < 2 ||
      !e.points.every((p) => Array.isArray(p) && p.length === 2 && p.every(Number.isFinite))
    )
      throw typeError('An exclusion needs points: [x, z] pairs in metres', 'biomes');
    const verge = Math.round((e.verge ?? 0) * TICK);
    if (!(verge >= 0)) throw rangeError('An exclusion verge must be 0 or more metres', 'biomes');
    if (e.kind === 'line') {
      if (!(e.width > 0)) throw rangeError('A line exclusion needs a width above 0 metres', 'biomes');
      for (let i = 0; i + 1 < e.points.length; i++)
        lines.push(...t(e.points[i]), ...t(e.points[i + 1]), Math.round((e.width / 2) * TICK), verge);
    } else if (e.kind === 'polygon') {
      if (e.points.length < 3) throw rangeError('A polygon exclusion needs 3 or more points', 'biomes');
      const pts = Float64Array.from(e.points.flatMap(t));
      let x0 = Infinity,
        z0 = Infinity,
        x1 = -Infinity,
        z1 = -Infinity;
      for (let i = 0; i < pts.length; i += 2) {
        x0 = Math.min(x0, pts[i]);
        x1 = Math.max(x1, pts[i]);
        z0 = Math.min(z0, pts[i + 1]);
        z1 = Math.max(z1, pts[i + 1]);
      }
      polys.push({ pts, verge, box: [x0 - verge, z0 - verge, x1 + verge, z1 + verge] });
    } else throw typeError("An exclusion kind is 'line' or 'polygon'", 'biomes');
  }
  return { lines: Float64Array.from(lines), polys };
}

/** Squared distance (ticks^2) from (px, pz) to segment a-b, exact in integers below 2^53. */
function segment2(px: number, pz: number, ax: number, az: number, bx: number, bz: number): number {
  const dx = bx - ax,
    dz = bz - az,
    len = dx * dx + dz * dz,
    dot = (px - ax) * dx + (pz - az) * dz;
  if (dot <= 0 || !len) return (px - ax) * (px - ax) + (pz - az) * (pz - az);
  if (dot >= len) return (px - bx) * (px - bx) + (pz - bz) * (pz - bz);
  // Perpendicular distance squared: cross^2 / len, floored.
  const cross = (px - ax) * dz - (pz - az) * dx;
  return divFloor(cross * cross, len);
}

/** Inside an exclusion: 2; inside a verge: 1 plus the verge share in `out[0]` (Q16, 1 at the edge); else 0. */
function excluded(s: Shapes, x: number, z: number, out: Int32Array): number {
  let edge = 0;
  const l = s.lines;
  for (let i = 0; i < l.length; i += 6) {
    const half = l[i + 4],
      verge = l[i + 5],
      reach = half + verge;
    if (x < Math.min(l[i], l[i + 2]) - reach || x > Math.max(l[i], l[i + 2]) + reach) continue;
    if (z < Math.min(l[i + 1], l[i + 3]) - reach || z > Math.max(l[i + 1], l[i + 3]) + reach) continue;
    const d2 = segment2(x, z, l[i], l[i + 1], l[i + 2], l[i + 3]);
    if (d2 < half * half) return 2;
    if (verge && d2 < reach * reach) edge = Math.max(edge, ONE - divFloor((isqrt(d2) - half) * ONE, verge));
  }
  for (const p of s.polys) {
    if (x < p.box[0] || x > p.box[2] || z < p.box[1] || z > p.box[3]) continue;
    const q = p.pts;
    let inside = false,
      best = Infinity;
    for (let i = 0, j = q.length - 2; i < q.length; j = i, i += 2) {
      const xi = q[i],
        zi = q[i + 1],
        xj = q[j],
        zj = q[j + 1];
      // Crossing test with integers: does the edge straddle z, and is the crossing right of x?
      if (zi > z !== zj > z && (x - xi) * (zj - zi) * Math.sign(zj - zi) < (xj - xi) * (z - zi) * Math.sign(zj - zi))
        inside = !inside;
      if (p.verge) best = Math.min(best, segment2(x, z, xi, zi, xj, zj));
    }
    if (inside) return 2;
    if (p.verge && best < p.verge * p.verge) edge = Math.max(edge, ONE - divFloor(isqrt(best) * ONE, p.verge));
  }
  out[0] = edge;
  return edge ? 1 : 0;
}

/**
 * Cells (cx, cz) to a range of a flat list: an open-addressing table on two i32 keys over a toroidal window of 2^bits x
 * 2^bits cells, so a run's neighbouring cells sit in neighbouring slots and a lookup is nearly direct; a collision
 * probes the next slot. (A Map keyed by one number would need keys above 2^31, which engines keep as slow heap doubles.)
 */
class Cells {
  bits: number;
  kx: Int32Array;
  kz: Int32Array;
  /** First list index of the cell, -1 for an empty slot. */
  start: Int32Array;
  count: Int32Array;
  /** A second number per cell (placement: candidates generated in it before thinning). */
  tally: Int32Array;
  size = 0;

  constructor(bits: number) {
    this.bits = bits;
    const n = 1 << (2 * bits);
    this.kx = new Int32Array(n);
    this.kz = new Int32Array(n);
    this.start = new Int32Array(n).fill(-1);
    this.count = new Int32Array(n);
    this.tally = new Int32Array(n);
  }

  /**
   * Empties the table to a window of 2^bits x 2^bits cells, as a new one, over the memory it has (a table grown in an
   * earlier run keeps its larger arrays): slots are read only once `add` wrote them.
   */
  reset(bits: number): void {
    const n = 1 << (2 * bits),
      view = (a: Int32Array) => (a.buffer.byteLength >= n * 4 ? new Int32Array(a.buffer, 0, n) : new Int32Array(n));
    this.bits = bits;
    this.size = 0;
    this.kx = view(this.kx);
    this.kz = view(this.kz);
    this.start = view(this.start).fill(-1);
    this.count = view(this.count);
    this.tally = view(this.tally);
  }

  /** The slot of cell (cx, cz), or -1 when it is not in the table. */
  find(cx: number, cz: number): number {
    const { kx, kz, start, bits } = this,
      mask = start.length - 1;
    let i = ((cz << bits) | (cx & ((1 << bits) - 1))) & mask;
    for (;;) {
      if (start[i] < 0) return -1;
      if (kx[i] === cx && kz[i] === cz) return i;
      i = (i + 1) & mask;
    }
  }

  /** Adds cell (cx, cz) (not in the table yet) with its list start; returns its slot, valid until the next add. */
  add(cx: number, cz: number, first: number): number {
    if (2 * (this.size + 1) > this.start.length) this.#grow();
    this.size++;
    const mask = this.start.length - 1;
    let i = ((cz << this.bits) | (cx & ((1 << this.bits) - 1))) & mask;
    while (this.start[i] >= 0) i = (i + 1) & mask;
    this.kx[i] = cx;
    this.kz[i] = cz;
    this.start[i] = first;
    this.count[i] = 0;
    this.tally[i] = 0;
    return i;
  }

  #grow(): void {
    const { kx, kz, start, count, tally } = this,
      bigger = new Cells(this.bits + 1);
    for (let i = 0; i < start.length; i++)
      if (start[i] >= 0) {
        const slot = bigger.add(kx[i], kz[i], start[i]);
        bigger.count[slot] = count[i];
        bigger.tally[slot] = tally[i];
      }
    this.bits = bigger.bits;
    this.kx = bigger.kx;
    this.kz = bigger.kz;
    this.start = bigger.start;
    this.count = bigger.count;
    this.tally = bigger.tally;
    this.size = bigger.size;
  }
}

/** Window bits of a {@link Cells} table for cells of 2^shift ticks over a tile of `tileTicks` plus an apron. */
const windowBits = (tileTicks: number, shift: number) =>
  clampInt(32 - Math.clz32((tileTicks >> Math.min(shift, 30)) + 31), 4, 9);

/** Growable candidate pool of one stratum during one tile's placement. */
class Pool {
  n = 0;
  x = new Int32Array(1024);
  z = new Int32Array(1024);
  prio = new Uint32Array(1024);
  sp = new Uint16Array(1024);
  r = new Int32Array(1024); // conflict radius, ticks
  u = new Int32Array(1024); // stem size, Q16
  h = new Uint32Array(1024); // spare hash: yaw, variant, mortality
  fate = new Uint8Array(1024);
  round = new Uint8Array(1024);
  known = new Uint8Array(1024);
  nb = new Int32Array(1024); // start of the higher-priority neighbour list, -1 until made
  nbn = new Int32Array(1024);
  list = new Int32Array(4096);
  listN = 0;
  /** Generated stratum cells: their candidate ranges, and how many candidates each generated before thinning. */
  readonly cells: Cells;

  constructor(bits: number) {
    this.cells = new Cells(bits);
  }

  /** Empties the pool for the next run, keeping its arrays (each candidate's fields are written when it is pushed). */
  reset(bits: number): this {
    this.n = this.listN = 0;
    this.cells.reset(bits);
    return this;
  }

  grow(): void {
    const size = this.x.length * 2,
      copy = <T extends Int32Array | Uint32Array | Uint16Array | Uint8Array>(a: T): T => {
        const b = new (a.constructor as new (n: number) => T)(size);
        b.set(a);
        return b;
      };
    this.x = copy(this.x);
    this.z = copy(this.z);
    this.prio = copy(this.prio);
    this.sp = copy(this.sp);
    this.r = copy(this.r);
    this.u = copy(this.u);
    this.h = copy(this.h);
    this.fate = copy(this.fate);
    this.round = copy(this.round);
    this.known = copy(this.known);
    this.nb = copy(this.nb);
    this.nbn = copy(this.nbn);
  }

  push(x: number, z: number, prio: number, sp: number, r: number, u: number, h: number): void {
    if (this.n === this.x.length) this.grow();
    const i = this.n++;
    this.x[i] = x;
    this.z[i] = z;
    this.prio[i] = prio;
    this.sp[i] = sp;
    this.r[i] = r;
    this.u[i] = u;
    this.h[i] = h;
    this.fate[i] = LIVE;
    this.round[i] = 0;
    this.known[i] = 0;
    this.nb[i] = -1;
  }

  link(n: number): void {
    if (this.listN === this.list.length) {
      const b = new Int32Array(this.list.length * 2);
      b.set(this.list);
      this.list = b;
    }
    this.list[this.listN++] = n;
  }
}

/** Parent points of one cluster rule: per parent cell, a range of [x, z] tick pairs in `xz`. */
interface Parents {
  readonly cells: Cells;
  xz: Int32Array;
  n: number;
}

/** One tile's placement run: lazily generated candidates and memoised Luby rounds, per stratum. */
class Run {
  readonly pools: Pool[];
  readonly scratch = new Int32Array(1);
  readonly look = { f: undefined as Fields | undefined, k: 0 };
  readonly parentCache = new Map<number, Parents>();
  #tile = Number.NaN;
  #fields: Fields | undefined;
  /** Fields by tile index (z * tiles along x + x), filled on first use. */
  readonly #byTile: (Fields | undefined)[] = [];

  /** The fields of world tile (tx, tz) (inside the world), or a Missing throw while it is not made yet. */
  tileFields(tx: number, tz: number): Fields {
    const key = tz * (this.geometry.worldX >> this.geometry.tileShift) + tx;
    let f = this.#byTile[key];
    if (!f) {
      f = this.fields(tx, tz);
      if (!f) throw new Missing(tx, tz);
      this.#byTile[key] = f;
    }
    return f;
  }

  constructor(
    readonly plan: Plan,
    readonly seed: number,
    readonly fields: (tx: number, tz: number) => Fields | undefined,
    readonly geometry: {
      tileTicks: number;
      cellTicks: number;
      cells: number;
      worldX: number;
      worldZ: number;
      /** log2 of tileTicks and of cellTicks (both powers of two). */
      tileShift: number;
      cellShift: number;
      /** Sea level, mm (the world's `climate.sea`): no species grows on ground below it. */
      sea: number;
    },
    readonly shapes: Shapes,
    /** Pools of earlier runs to reuse (a run goes start to finish in one call, so one run uses them at a time). */
    reuse: Pool[] = [],
  ) {
    this.pools = plan.strata.map((st, s) => {
      const bits = windowBits(geometry.tileTicks, st.gs);
      return reuse[s] ? reuse[s].reset(bits) : (reuse[s] = new Pool(bits));
    });
  }

  /** The world cell fields at a tick position, or undefined outside the world. */
  at(x: number, z: number, out: { f?: Fields; k: number }): boolean {
    const g = this.geometry;
    if (x < 0 || z < 0 || x >= g.worldX || z >= g.worldZ) return false;
    const tx = x >> g.tileShift,
      tz = z >> g.tileShift,
      key = tx * 65536 + tz;
    if (key !== this.#tile) {
      this.#fields = this.tileFields(tx, tz);
      this.#tile = key;
    }
    const f = this.#fields!;
    out.f = f;
    out.k = ((z - tz * g.tileTicks) >> g.cellShift) * g.cells + ((x - tx * g.tileTicks) >> g.cellShift);
    return true;
  }

  /** The parents of a cluster's parent cell, made once per run: their slot in `store.cells` (pairs in `store.xz`). */
  parents(c: Cluster, px: number, pz: number, store: Parents): number {
    const found = store.cells.find(px, pz);
    if (found >= 0) return found;
    const count = poisson(c.mu, c.e0, hash5(this.seed, c.code, px, pz, 0)),
      slot = store.cells.add(px, pz, store.n);
    if (store.n + 2 * count > store.xz.length) {
      const grown = new Int32Array(Math.max(2 * store.xz.length, store.n + 2 * count));
      grown.set(store.xz);
      store.xz = grown;
    }
    for (let i = 1; i <= count; i++) {
      const h = hash5(this.seed, c.code, px, pz, i);
      store.xz[store.n++] = px * c.cell + Math.floor(((h >>> 16) * c.cell) / 65536);
      store.xz[store.n++] = pz * c.cell + Math.floor(((h & 0xffff) * c.cell) / 65536);
    }
    store.cells.count[slot] = 2 * count;
    return slot;
  }

  /**
   * Can biome b have weight anywhere in the tick rectangle? False only when every world tile it meets lacks the biome
   * (candidates there would all be thinned away, so skipping them changes nothing).
   */
  somewhere(b: number, x0: number, z0: number, x1: number, z1: number): boolean {
    const g = this.geometry;
    for (let tz = Math.max(0, z0) >> g.tileShift; tz <= Math.min(g.worldZ - 1, z1) >> g.tileShift; tz++)
      for (let tx = Math.max(0, x0) >> g.tileShift; tx <= Math.min(g.worldX - 1, x1) >> g.tileShift; tx++) {
        if (this.tileFields(tx, tz).present[b]) return true;
      }
    return false;
  }

  /** Cluster intensity factor C(x) (Q16) of a species: (1 - beta) + beta * the shot-noise sum, capped. */
  cluster(c: Cluster, x: number, z: number): number {
    const reach2 = c.reach * c.reach,
      x0 = divFloor(x - c.reach, c.cell),
      x1 = divFloor(x + c.reach, c.cell),
      z0 = divFloor(z - c.reach, c.cell),
      z1 = divFloor(z + c.reach, c.cell);
    let sum = 0,
      store = this.parentCache.get(c.code);
    if (!store) this.parentCache.set(c.code, (store = { cells: new Cells(5), xz: new Int32Array(1024), n: 0 }));
    for (let pz = z0; pz <= z1; pz++)
      for (let px = x0; px <= x1; px++) {
        const slot = this.parents(c, px, pz, store),
          start = store.cells.start[slot],
          end = start + store.cells.count[slot],
          parents = store.xz;
        for (let i = start; i < end; i += 2) {
          const ox = parents[i],
            oz = parents[i + 1],
            d2 = (x - ox) * (x - ox) + (z - oz) * (z - oz);
          if (d2 >= reach2) continue;
          // Linear interpolation in the table over d^2.
          const t = divFloor(d2 * 256 * 64, reach2), // 1/64 steps
            j = t >> 6,
            f = t & 63;
          sum += c.table[j] + (((c.table[j + 1] - c.table[j]) * f) >> 6);
        }
      }
    return ONE - c.beta + qmul(c.beta, Math.min(CLUSTER_CAP * ONE, sum));
  }

  /** How much of a stand covers (x, z), Q16, 0 in a clearing: a Wendland-shaped threshold of world-anchored noise. */
  stand(st: Stands, x: number, z: number): number {
    const noise = fbm(hash2(this.seed, st.scale), divFloor(x * ONE, st.scale), divFloor(z * ONE, st.scale), 3);
    return wendland(clampInt(divFloor((st.top - noise) * ONE, STAND_BAND), 0, ONE));
  }

  /**
   * Generates (once) the candidates of stratum `s` in cell (cx, cz) that pass thinning, light and lower layers. Returns
   * the cell's slot in the stratum's table (valid until that table's next add).
   */
  cell(s: number, cx: number, cz: number): number {
    const pool = this.pools[s],
      found = pool.cells.find(cx, cz);
    if (found >= 0) return found;
    const st = this.plan.strata[s],
      start = pool.n,
      look = this.look,
      e = this.scratch,
      // Mark the cell first: generating it can query other strata, never this one, so the slot stays valid.
      slot = pool.cells.add(cx, cz, start);
    let generated = 0;
    for (const sp of st.species) {
      if (!this.somewhere(sp.biomeIndex, cx * st.g, cz * st.g, (cx + 1) * st.g - 1, (cz + 1) * st.g - 1)) continue;
      const steps = divFloor(st.g, sp.gen), // a power of two
        // A stratum cell no larger than a tile lies inside one tile (both are aligned powers of two), so each of its
        // generation cells would get the same answer as the cell itself.
        each = st.g > this.geometry.tileTicks;
      for (let b = 0; b < steps; b++)
        for (let a = 0; a < steps; a++) {
          const gx = cx * steps + a,
            gz = cz * steps + b;
          if (
            each &&
            !this.somewhere(sp.biomeIndex, gx * sp.gen, gz * sp.gen, (gx + 1) * sp.gen - 1, (gz + 1) * sp.gen - 1)
          )
            continue;
          const n = poisson(sp.mu, sp.e0, hash5(this.seed, sp.code, gx, gz, 0));
          generated += n;
          for (let i = 1; i <= n; i++) {
            const h0 = hash5(this.seed, sp.code, gx, gz, i),
              h1 = pcg(h0),
              h2 = pcg(h1),
              h3 = pcg(h2),
              h4 = pcg(h3),
              x = gx * sp.gen + Math.floor(((h0 >>> 8) * sp.gen) / 16777216),
              z = gz * sp.gen + Math.floor(((h1 >>> 8) * sp.gen) / 16777216),
              stand = sp.stands ? this.stand(sp.stands, x, z) : ONE;
            // The thinning below keeps a candidate at most `stand` of the time: most of a clearing's stop here, cheaply.
            if (h2 >>> 16 >= stand) continue;
            if (!this.at(x, z, look)) continue;
            const f = look.f!,
              k = look.k;
            // Land only: species model land plants, rocks and props (none is aquatic), so none stands below sea level.
            if (f.layers.height[k] < this.geometry.sea) continue;
            // Biome weight of the species' biome here (0 when it is not among the cell's four).
            let w = 0;
            for (let q = 0; q < 4; q++) if (f.ids[k * 4 + q] === sp.biomeIndex) w = f.weights[k * 4 + q];
            if (!w) continue;
            let p = divFloor(w * ONE, 255);
            // Suitability: Wendland bands on the species' ranges, as envelopes.
            for (const d of sp.dims) {
              const v = f.layers[d.layer][k],
                dist = Math.max(d.lo - v, v - d.hi);
              p = qmul(p, wendland(clampInt(divFloor((dist + (d.width >> 1)) * ONE, d.width), 0, ONE)));
              if (!p) break;
            }
            if (!p) continue;
            const ex = excluded(this.shapes, x, z, e);
            if (ex === 2) continue;
            // Edge: near the biome border (the strongest weight below 1) or a verge.
            const edge = Math.max(
              e[0] * (ex === 1 ? 1 : 0),
              clampInt(divFloor((255 - f.weights[k * 4]) * 2 * ONE, 255), 0, ONE),
            );
            if (sp.layer === 2 || sp.layer === 3) p = qmul(p, ONE + (edge >> 1));
            if (sp.layer === 0) {
              // Rocks favour convex ground: up to twice as many where curvature reaches 0.05 per metre.
              const curv = f.layers.curvature[k];
              p = qmul(p, ONE + clampInt(curv * 131, 0, ONE));
            }
            if (sp.cluster) p = qmul(p, this.cluster(sp.cluster, x, z));
            if (sp.stands) p = qmul(p, qmul(stand, sp.stands.boost));
            // Thinning against the candidate's own number: p is the intensity over the candidate rate.
            const limit = divFloor(p * ONE, sp.kappa); // Q16 survival probability
            if (h2 >>> 16 >= limit) continue;
            // Size, shrunk where the local density leaves crowns less room, then crown and edge shrink of canopy trees.
            const lambda = qmul(sp.lambda, p),
              room = sp.room && lambda > sp.room ? qpow(divFloor(sp.room * ONE, lambda), 43691) : ONE, // (room / density)^(2/3)
              u = qmul(drawSize(sp, h3), room),
              m = qpow(Math.max(1, u), 49152), // crown multiplier u^0.75
              shrink = sp.layer === 1 ? ONE - (edge >> 2) : sp.layer >= 2 && sp.layer <= 3 ? ONE + (edge >> 2) : ONE,
              r = Math.max(1, qmul(qmul(sp.r, m), shrink));
            // Lower layers: shade (under a crown of an earlier plant layer) and the spacing to earlier layers.
            if (s >= 2 && s <= 3 && h2 >>> 16 >= qmul(limit, sp.shade) && this.covered(s, x, z)) continue;
            if (s && this.blocked(s, sp.index, x, z, r)) continue;
            pool.push(x, z, h4, sp.index, r, u, pcg(h4));
          }
        }
    }
    pool.cells.count[slot] = pool.n - start;
    pool.cells.tally[slot] = generated;
    return slot;
  }

  /** Is (x, z) under an accepted crown of an earlier plant layer (1 .. s - 1)? */
  covered(s: number, x: number, z: number): boolean {
    for (let t = 1; t < s; t++) {
      const st = this.plan.strata[t];
      if (!st.species.length) continue;
      const reach = st.rmax,
        pool = this.pools[t];
      for (let cz = (z - reach) >> st.gs; cz <= (z + reach) >> st.gs; cz++)
        for (let cx = (x - reach) >> st.gs; cx <= (x + reach) >> st.gs; cx++) {
          const slot = this.cell(t, cx, cz),
            start = pool.cells.start[slot],
            end = start + pool.cells.count[slot];
          for (let i = start; i < end; i++) {
            const dx = pool.x[i] - x,
              dz = pool.z[i] - z;
            if (dx * dx + dz * dz < pool.r[i] * pool.r[i] && this.accepted(t, i)) return true;
          }
        }
    }
    return false;
  }

  /** Does an accepted object of an earlier layer stand within the pair spacing of a candidate? */
  blocked(s: number, sp: number, x: number, z: number, r: number): boolean {
    const n = this.plan.specs.length;
    for (let t = 0; t < s; t++) {
      const st = this.plan.strata[t];
      if (!st.species.length) continue;
      const pool = this.pools[t],
        reach = qmul(this.plan.across, st.rmax + r) + 1;
      for (let cz = (z - reach) >> st.gs; cz <= (z + reach) >> st.gs; cz++)
        for (let cx = (x - reach) >> st.gs; cx <= (x + reach) >> st.gs; cx++) {
          const slot = this.cell(t, cx, cz),
            start = pool.cells.start[slot],
            end = start + pool.cells.count[slot];
          for (let i = start; i < end; i++) {
            const d = qmul(this.plan.factor[sp * n + pool.sp[i]], r + pool.r[i]),
              dx = pool.x[i] - x,
              dz = pool.z[i] - z;
            if (dx * dx + dz * dz < d * d && this.accepted(t, i)) return true;
          }
        }
    }
    return false;
  }

  /** The conflicting candidates of `i` with a higher priority (ties by position, then species), made once. */
  higher(s: number, i: number): void {
    const pool = this.pools[s];
    if (pool.nb[i] >= 0) return;
    const st = this.plan.strata[s],
      n = this.plan.specs.length,
      x = pool.x[i],
      z = pool.z[i],
      reach = st.dmax,
      cx0 = (x - reach) >> st.gs,
      cx1 = (x + reach) >> st.gs,
      cz0 = (z - reach) >> st.gs,
      cz1 = (z + reach) >> st.gs;
    for (let cz = cz0; cz <= cz1; cz++) for (let cx = cx0; cx <= cx1; cx++) this.cell(s, cx, cz);
    // Generating cells may have grown the pool; read it again.
    const p = this.pools[s];
    p.nb[i] = p.listN;
    for (let cz = cz0; cz <= cz1; cz++)
      for (let cx = cx0; cx <= cx1; cx++) {
        const slot = p.cells.find(cx, cz),
          start = p.cells.start[slot],
          end = start + p.cells.count[slot];
        for (let j = start; j < end; j++) {
          if (j === i) continue;
          const pj = p.prio[j],
            pi = p.prio[i];
          if (
            pj < pi ||
            (pj === pi && (p.x[j] < x || (p.x[j] === x && (p.z[j] < z || (p.z[j] === z && p.sp[j] <= p.sp[i])))))
          )
            continue;
          const d = qmul(this.plan.factor[p.sp[i] * n + p.sp[j]], p.r[i] + p.r[j]),
            dx = p.x[j] - x,
            dz = p.z[j] - z;
          if (dx * dx + dz * dz < d * d) p.link(j);
        }
      }
    p.nbn[i] = p.listN - p.nb[i];
  }

  /** Is candidate i of stratum s live at the end of round t (Luby rounds with fixed priorities)? */
  live(s: number, i: number, t: number): boolean {
    const p = this.pools[s];
    if (!t) return true;
    while (p.fate[i] === LIVE && p.known[i] < t) this.step(s, i);
    return p.fate[i] === LIVE || t < p.round[i];
  }

  /** Was candidate i of stratum s accepted in round t? */
  acceptedIn(s: number, i: number, t: number): boolean {
    const p = this.pools[s];
    while (p.fate[i] === LIVE && p.known[i] < t) this.step(s, i);
    return p.fate[i] === ACCEPTED && p.round[i] === t;
  }

  /** Accepted within the rounds. */
  accepted(s: number, i: number): boolean {
    return !this.live(s, i, this.plan.rounds) && this.pools[s].fate[i] === ACCEPTED;
  }

  /** Advances candidate i by one round. */
  step(s: number, i: number): void {
    this.higher(s, i);
    const p = this.pools[s],
      t = p.known[i] + 1,
      start = p.nb[i],
      end = start + p.nbn[i];
    let free = true;
    for (let q = start; q < end && free; q++) if (this.live(s, p.list[q], t - 1)) free = false;
    if (free) {
      p.fate[i] = ACCEPTED;
      p.round[i] = t;
      return;
    }
    for (let q = start; q < end; q++)
      if (this.acceptedIn(s, p.list[q], t)) {
        p.fate[i] = KILLED;
        p.round[i] = t;
        return;
      }
    p.known[i] = t;
  }
}

const tileKey = (x: number, z: number) => `${x},${z}`;

/**
 * Stored objects of a biome world: trees, shrubs, rocks and props from each biome's species rules, placed per tile and
 * cached. Deterministic: the same world gives the same records whatever tiles are asked for and in what order.
 * `using placement = BiomePlacement.attach(world)` frees it at the end of a block.
 * @example
 * const placement = BiomePlacement.attach(world);
 * const tile = await placement.tile(4, 4);
 * tile.forEachInstance((i) => console.log(i.key, i.x, i.z, i.scale));
 */
export class BiomePlacement implements Disposable {
  #species: readonly PlacedSpecies[] = [];
  #reach = 0;
  readonly #world: BiomeWorld;
  #options: PlacementOptions;
  #plan: Plan;
  #shapes: Shapes;
  readonly #cache = new Map<string, Promise<PlacedTile>>();
  /** What placement reads of each world tile, kept as long as the world keeps the tile. */
  readonly #fields = new WeakMap<BiomeTile, Fields>();
  readonly #listeners = new Set<(rect: Rect) => void>();
  readonly #off: () => void;
  #disposed = false;
  /** The world's workers (tiles are placed there, by a replica of this placement), and this placement's id there. */
  readonly #workers: BiomeWorld['workers'];
  readonly #pid = ++serial;
  /** Candidate pools reused from tile to tile (tens of megabytes of tables per tile otherwise). */
  readonly #pools: Pool[] = [];

  private constructor(world: BiomeWorld, options: PlacementOptions) {
    this.#world = world;
    this.#options = options;
    this.#plan = this.#replan(options);
    this.#shapes = shapesOf(options.exclusions, [world.bounds[0], world.bounds[1]]);
    this.#workers = world.workers;
    this.#workers?.attach(this.#pid, options);
    this.#off = world.onChange((rect) => {
      // Biomes or climate may have changed: rebuild the plan, drop the tiles the change reaches.
      const reach = this.#reach;
      this.#plan = this.#replan(this.#options);
      this.#drop(rect, Math.max(reach, this.#reach));
    });
  }

  /**
   * Attaches placement to a world.
   * @throws TypeError or RangeError for bad options or species rules.
   */
  static attach(world: BiomeWorld, options: PlacementOptions = {}): BiomePlacement {
    if (!world || typeof world.tile !== 'function')
      throw typeError('BiomePlacement.attach takes a BiomeWorld', 'biomes');
    if (typeof options !== 'object' || options === null)
      throw typeError('BiomePlacement options must be an object; pass {} for the defaults', 'biomes');
    return new BiomePlacement(world, options);
  }

  /** The world palette, in placement order within each layer. */
  get species(): readonly PlacedSpecies[] {
    return this.#species;
  }

  /** The world's tile side in metres. */
  get tileSize(): number {
    return this.#world.tileSize;
  }

  /** Detail species of the world's biomes (grass, flowers, pebbles): drawn per frame from the tiles' density maps. */
  get details(): readonly { readonly id: string; readonly mesh: string; readonly density: number }[] {
    return this.#plan.details.map((d) => ({ id: d.id, mesh: d.mesh, density: d.density }));
  }

  /** How far (metres) an input change can move or change objects: an edit can change the tiles this far around it. */
  get reach(): number {
    return this.#reach;
  }

  #replan(options: PlacementOptions): Plan {
    const plan = planOf(this.#world.biomes, options);
    this.#species = Object.freeze(
      plan.specs.map((s) =>
        Object.freeze({
          key: s.key,
          id: s.id,
          biome: s.biome,
          kind: s.kind,
          layer: s.layer,
          mesh: s.mesh,
          radius: s.radius,
          tags: s.tags,
          density: s.density,
          clustered: s.clustered,
        }),
      ),
    );
    this.#reach = placementReach(this.#world.biomes, plan.rounds, plan.within / ONE, plan.across / ONE); // float division: metres
    return plan;
  }

  #live(): void {
    if (this.#disposed)
      throw fault(
        'disposed',
        'BiomePlacement is disposed; attach a new one with BiomePlacement.attach(world)',
        'biomes',
      );
  }

  /** Drops cached tiles within `grow` metres of a world rectangle and tells listeners. */
  #drop(rect: Rect, grow: number): void {
    const w = this.#world,
      t = w.tileSize,
      r: Rect = [rect[0] - grow, rect[1] - grow, rect[2] + grow, rect[3] + grow];
    for (const key of [...this.#cache.keys()]) {
      const [x, z] = key.split(',').map(Number),
        x0 = w.bounds[0] + x * t,
        z0 = w.bounds[1] + z * t;
      if (x0 < r[2] && x0 + t > r[0] && z0 < r[3] && z0 + t > r[1]) this.#cache.delete(key);
    }
    const clipped: Rect = [
      Math.max(w.bounds[0], r[0]),
      Math.max(w.bounds[1], r[1]),
      Math.min(w.bounds[2], r[2]),
      Math.min(w.bounds[3], r[3]),
    ];
    for (const listener of [...this.#listeners]) listener(clipped);
  }

  /** Replaces exclusions or spacing; every tile they reach is placed again on its next request. */
  update(changes: Pick<PlacementOptions, 'exclusions' | 'conflicts'>): void {
    this.#live();
    if (typeof changes !== 'object' || changes === null)
      throw typeError('BiomePlacement update takes { exclusions?, conflicts? }', 'biomes');
    const options = { ...this.#options, ...changes },
      shapes = shapesOf(options.exclusions, [this.#world.bounds[0], this.#world.bounds[1]]);
    this.#plan = this.#replan(options);
    this.#options = options;
    this.#shapes = shapes;
    this.#workers?.update(this.#pid, changes);
    this.#cache.clear();
    for (const listener of [...this.#listeners]) listener(this.#world.bounds);
  }

  /** Calls `listener` with each rectangle whose objects may have changed; returns an unsubscribe function. */
  onChange(listener: (rect: Rect) => void): () => void {
    this.#live();
    if (typeof listener !== 'function') throw typeError('BiomePlacement onChange takes a function', 'biomes');
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /**
   * The objects of tile (x, z), cached. Makes the world tiles it reads (the tile and its neighbours) first.
   * @throws RangeError for a tile outside the world. Rejects with the signal's reason when aborted.
   */
  async tile(
    x: number,
    z: number,
    options: {
      readonly signal?: AbortSignal;
      /** On a world with workers: lower runs sooner among queued tiles (a view passes the distance). Default 0. */
      readonly priority?: number;
      /** On a world with workers: also sample the detail maps every this many cells (`DensityMap.sampled`). */
      readonly detail?: number;
    } = {},
  ): Promise<PlacedTile> {
    this.#live();
    const w = this.#world;
    if (!Number.isInteger(x) || !Number.isInteger(z) || x < 0 || z < 0 || x >= w.tilesX || z >= w.tilesZ)
      throw rangeError(
        'BiomeWorld tile indices must be integers inside the world (0..tilesX - 1, 0..tilesZ - 1)',
        'biomes',
      );
    if (options.signal?.aborted) throw options.signal.reason;
    const key = tileKey(x, z);
    let pending = this.#cache.get(key);
    if (pending) {
      // Least recently used goes first: a hit moves to the end.
      this.#cache.delete(key);
      this.#cache.set(key, pending);
    } else {
      pending = this.#workers
        ? this.#workers
            .run<Omit<PlacedTile, 'forEachInstance'>>(
              { op: 'place', pid: this.#pid, x, z, split: true, detail: options.detail },
              { near: [x, z], priority: options.priority, signal: options.signal },
            )
            .then(placed)
        : this.#place(x, z, options.signal);
      this.#cache.set(key, pending);
      if (this.#cache.size > CACHE) this.#cache.delete(this.#cache.keys().next().value!);
      pending.catch(() => {
        if (this.#cache.get(key) === pending) this.#cache.delete(key);
      });
    }
    return pending;
  }

  /** The tiles of a world rectangle (metres), nearest to `focus` first. */
  async *tiles(
    rect: Rect,
    options: { readonly focus?: readonly [number, number]; readonly signal?: AbortSignal } = {},
  ): AsyncIterableIterator<PlacedTile> {
    for await (const t of this.#world.tiles(rect, options)) yield await this.tile(t.x, t.z, options);
  }

  /** SHA-256 (hex) of a tile's palette and records. */
  async digest(x: number, z: number, options: { readonly signal?: AbortSignal } = {}): Promise<string> {
    const t = await this.tile(x, z, options),
      head = new TextEncoder().encode(`${t.species.join(',')};${t.count};`),
      bytes = new Uint8Array(head.length + t.instances.length);
    bytes.set(head);
    bytes.set(t.instances, head.length);
    return (await import('@margoengine/biomes/digest')).sha256(bytes);
  }

  #place(x: number, z: number, signal?: AbortSignal): Promise<PlacedTile> {
    return this.#withFields(x - 1, z - 1, x + 1, z + 1, signal, (fields) => this.#run(x, z, fields));
  }

  /**
   * Runs `work` with the world tiles it reads: the given tile range first, then any further tile a lookup reaches
   * (the work runs again from the start; its result does not depend on what was loaded before).
   */
  async #withFields<T>(
    tx0: number,
    tz0: number,
    tx1: number,
    tz1: number,
    signal: AbortSignal | undefined,
    work: (fields: (x: number, z: number) => Fields | undefined) => T,
  ): Promise<T> {
    const w = this.#world,
      fields = new Map<string, Fields>(),
      load = async (tx: number, tz: number) => {
        if (tx < 0 || tz < 0 || tx >= w.tilesX || tz >= w.tilesZ || fields.has(tileKey(tx, tz))) return;
        const t: BiomeTile = await w.tile(tx, tz, { signal });
        let f = this.#fields.get(t);
        if (!f) {
          const layers: Record<string, ArrayLike<number>> = {};
          for (const name of t.layers) layers[name] = t.layer(name)!.data;
          const ids = t.layer('biome')!.data as Uint8Array,
            weights = t.layer('biomeWeight')!.data as Uint8Array,
            present = new Uint8Array(256);
          for (let k = 0; k < ids.length; k++) if (weights[k]) present[ids[k]] = 1;
          this.#fields.set(t, (f = { present, ids, weights, layers }));
        }
        fields.set(tileKey(tx, tz), f);
      };
    for (let tz = tz0; tz <= tz1; tz++) for (let tx = tx0; tx <= tx1; tx++) await load(tx, tz);
    for (;;) {
      if (signal?.aborted) throw signal.reason;
      this.#live();
      try {
        return work((tx, tz) => fields.get(tileKey(tx, tz)));
      } catch (error) {
        if (!(error instanceof Missing)) throw error;
        await load(error.x, error.z);
      }
    }
  }

  #runOf(fields: (x: number, z: number) => Fields | undefined): Run {
    const w = this.#world,
      tileTicks = w.tileSize * TICK;
    return new Run(
      this.#plan,
      w.seed,
      fields,
      {
        tileTicks,
        cellTicks: w.resolution * TICK,
        cells: w.tileSize / w.resolution, // float division: exact
        worldX: w.tilesX * tileTicks,
        worldZ: w.tilesZ * tileTicks,
        tileShift: 31 - Math.clz32(tileTicks),
        cellShift: 31 - Math.clz32(w.resolution * TICK),
        sea: w.climate.sea,
      },
      this.#shapes,
      this.#pools,
    );
  }

  #run(tx: number, tz: number, fields: (x: number, z: number) => Fields | undefined): PlacedTile {
    const w = this.#world,
      plan = this.#plan,
      run = this.#runOf(fields),
      { tileTicks, cellTicks, cells } = run.geometry,
      x0 = tx * tileTicks,
      z0 = tz * tileTicks,
      rounds = new Uint32Array(plan.rounds),
      objects: { s: number; i: number }[] = [];
    let unresolved = 0,
      candidates = 0;
    // Every candidate inside the tile, each layer in order.
    plan.strata.forEach((st, s) => {
      if (!st.species.length) return;
      for (let cz = z0 >> st.gs; cz <= (z0 + tileTicks - 1) >> st.gs; cz++)
        for (let cx = x0 >> st.gs; cx <= (x0 + tileTicks - 1) >> st.gs; cx++) {
          const slot = run.cell(s, cx, cz),
            pool = run.pools[s],
            start = pool.cells.start[slot],
            end = start + pool.cells.count[slot];
          candidates += pool.cells.tally[slot];
          for (let i = start; i < end; i++) {
            const px = pool.x[i],
              pz = pool.z[i];
            if (px < x0 || pz < z0 || px >= x0 + tileTicks || pz >= z0 + tileTicks) continue;
            run.live(s, i, plan.rounds);
            if (pool.fate[i] === LIVE) unresolved++;
            else rounds[pool.round[i] - 1]++;
            if (pool.fate[i] === ACCEPTED) objects.push({ s, i });
          }
        }
    });
    // Canopy layers per 32 m cell: perfect plasticity, then the light share of the understory.
    const age = new Uint8Array(objects.length),
      size = new Int32Array(objects.length);
    objects.forEach((o, k) => {
      size[k] = run.pools[o.s].u[o.i];
    });
    const trees = objects.map((o, k) => k).filter((k) => objects[k].s === 1 || objects[k].s === 2),
      byCell = new Map<number, number[]>();
    for (const k of trees) {
      const o = objects[k],
        p = run.pools[o.s],
        key = ((p.x[o.i] >> PPA_SHIFT) + 32768) * 65536 + (p.z[o.i] >> PPA_SHIFT) + 32768;
      let list = byCell.get(key);
      if (!list) byCell.set(key, (list = []));
      list.push(k);
    }
    const heightOf = (k: number) => {
      const o = objects[k],
        p = run.pools[o.s],
        sp = plan.specs[p.sp[o.i]],
        // Chapman-Richards: H = Href ((1 - e^(-1.6 u)) / (1 - e^(-1.6)))^1.2.
        grow = ONE - qexp2(-Math.min(15 * ONE, qmul(qmul(104858, p.u[o.i]), LOG2E)));
      return qmul(sp.height, qpow(divFloor(grow * ONE, 52305), 78643));
    };
    for (const list of byCell.values()) {
      const h = list.map(heightOf),
        order = list
          .map((_, q) => q)
          .sort(
            (a, b) =>
              h[b] - h[a] ||
              run.pools[objects[list[b]].s].prio[objects[list[b]].i] -
                run.pools[objects[list[a]].s].prio[objects[list[a]].i],
          );
      let area = 0,
        zStar = 0;
      // The canopy closes at 60 % crown cover, the lower bound of a closed tree canopy (crowns interlocking, generally
      // 60 to 100 % crown cover; below it an open canopy, 25 to 60 %) in the FGDC Vegetation Classification Standard,
      // FGDC-STD-005, June 1997. It is also the cover a dense stand reaches under the hard core and the room rule
      // (measured 0.6 to 0.65 of the ground at the candidate rates placement uses), m^2 Q16.
      const cellArea = 614 * ONE;
      for (const q of order) {
        const o = objects[list[q]],
          p = run.pools[o.s],
          rm = divFloor(p.r[o.i] * ONE, TICK); // crown radius, metres Q16
        if (area >= cellArea) break;
        area += qmul(205887, qmul(rm, rm));
        zStar = h[q];
      }
      if (area < cellArea) continue; // an open stand: every tree is canopy
      for (const q of order) {
        if (h[q] >= zStar) continue;
        const k = list[q],
          o = objects[k],
          p = run.pools[o.s],
          sp = plan.specs[p.sp[o.i]],
          rel = divFloor(h[q] * ONE, zStar || 1),
          light = sp.shade + qmul(ONE - sp.shade, qmul(rel, rel)); // size-asymmetric share, theta 2
        age[k] = 1;
        size[k] = qmul(size[k], light);
        // Thinning: badly suppressed trees die; a third of the dead lie as logs.
        const die = p.h[o.i] >>> 16;
        if (light < 22938 && die < divFloor((22938 - light) * ONE, 22938)) age[k] = (p.h[o.i] & 255) < 85 ? 3 : 2;
      }
    }
    // Records.
    const present = [...new Set(objects.map((o) => run.pools[o.s].sp[o.i]))].sort((a, b) => a - b),
      palette = new Map(present.map((s, q) => [s, q])),
      order = objects
        .map((_, k) => k)
        .sort((a, b) => {
          const oa = objects[a],
            ob = objects[b],
            pa = run.pools[oa.s],
            pb = run.pools[ob.s];
          return pa.sp[oa.i] - pb.sp[ob.i] || pa.z[oa.i] - pb.z[ob.i] || pa.x[oa.i] - pb.x[ob.i];
        }),
      instances = new Uint8Array(objects.length * 8);
    order.forEach((k, n) => {
      const o = objects[k],
        p = run.pools[o.s],
        at = n * 8,
        lx = divFloor((p.x[o.i] - x0) * 65536, tileTicks),
        lz = divFloor((p.z[o.i] - z0) * 65536, tileTicks),
        m = qpow(Math.max(1, size[k]), 49152),
        scale = clampInt(128 + ((qlog2(m) * 32 + 32768) >> 16), 0, 255),
        h = p.h[o.i];
      instances[at] = lx & 255;
      instances[at + 1] = lx >> 8;
      instances[at + 2] = lz & 255;
      instances[at + 3] = lz >> 8;
      instances[at + 4] = palette.get(p.sp[o.i])!;
      instances[at + 5] = scale;
      instances[at + 6] = (h >>> 8) & 255;
      instances[at + 7] = ((h >>> 24) & 15) | (age[k] << 4);
    });
    // Rasters: crown cover, exclusion mask, detail densities.
    const n = cells * cells,
      canopy = new Uint8Array(n),
      exclusion = new Uint8Array(n),
      half = cellTicks >> 1,
      quarter = cellTicks >> 2,
      crowns: number[] = [];
    // Crowns of live trees within reach of the tile (neighbouring tiles' trees overhang it).
    const reachT = Math.max(plan.strata[1].rmax, plan.strata[2].rmax);
    for (const s of [1, 2]) {
      const st = plan.strata[s];
      if (!st.species.length) continue;
      for (let cz = (z0 - reachT) >> st.gs; cz <= (z0 + tileTicks + reachT) >> st.gs; cz++)
        for (let cx = (x0 - reachT) >> st.gs; cx <= (x0 + tileTicks + reachT) >> st.gs; cx++) {
          const slot = run.cell(s, cx, cz),
            pool = run.pools[s],
            start = pool.cells.start[slot],
            end = start + pool.cells.count[slot];
          for (let i = start; i < end; i++) if (run.accepted(s, i)) crowns.push(pool.x[i], pool.z[i], pool.r[i]);
        }
    }
    for (let c = 0; c < crowns.length; c += 3) {
      const cx = crowns[c] - x0,
        cz = crowns[c + 1] - z0,
        r = crowns[c + 2],
        i0 = Math.max(0, (cx - r) >> run.geometry.cellShift),
        i1 = Math.min(cells - 1, (cx + r) >> run.geometry.cellShift),
        j0 = Math.max(0, (cz - r) >> run.geometry.cellShift),
        j1 = Math.min(cells - 1, (cz + r) >> run.geometry.cellShift);
      for (let j = j0; j <= j1; j++)
        for (let i = i0; i <= i1; i++) {
          // Four sub-samples per cell; each covered quarter adds 64 (255 when all are).
          let cover = 0;
          for (let q = 0; q < 4; q++) {
            const sx = i * cellTicks + quarter + (q & 1) * half - cx,
              sz = j * cellTicks + quarter + (q >> 1) * half - cz;
            if (sx * sx + sz * sz < r * r) cover++;
          }
          if (cover) canopy[j * cells + i] = Math.max(canopy[j * cells + i], cover === 4 ? 255 : cover * 64);
        }
    }
    const e = new Int32Array(1);
    if (this.#shapes.lines.length || this.#shapes.polys.length)
      for (let j = 0; j < cells; j++)
        for (let i = 0; i < cells; i++)
          if (excluded(this.#shapes, x0 + i * cellTicks + half, z0 + j * cellTicks + half, e) === 2)
            exclusion[j * cells + i] = 255;
    const f = fields(tx, tz)!,
      density = plan.details.map((d) => {
        const data = new Uint8Array(n);
        if (!d.parts.some((part) => f.present[part.biome]))
          return Object.freeze({ id: d.id, mesh: d.mesh, density: d.density, data });
        for (let k = 0; k < n; k++) {
          if (exclusion[k] || f.layers.height[k] < w.climate.sea) continue;
          let sum = 0;
          for (const part of d.parts) {
            let wt = 0;
            for (let q = 0; q < 4; q++) if (f.ids[k * 4 + q] === part.biome) wt = f.weights[k * 4 + q];
            if (!wt) continue;
            let p = divFloor(wt * ONE, 255);
            for (const dim of part.dims) {
              const v = f.layers[dim.layer][k],
                dist = Math.max(dim.lo - v, v - dim.hi);
              p = qmul(p, wendland(clampInt(divFloor((dist + (dim.width >> 1)) * ONE, dim.width), 0, ONE)));
            }
            if (part.light) {
              const v = 255 - canopy[k],
                dist = Math.max(part.light.lo - v, v - part.light.hi);
              p = qmul(
                p,
                wendland(clampInt(divFloor((dist + (part.light.width >> 1)) * ONE, part.light.width), 0, ONE)),
              );
            }
            sum += p;
          }
          data[k] = (Math.min(ONE, sum) * 255 + 32768) >> 16;
        }
        return Object.freeze({ id: d.id, mesh: d.mesh, density: d.density, data });
      });
    const raster = (name: string, data: Uint8Array): RasterLayer =>
        Object.freeze({ name, format: 'u8' as const, width: cells, depth: cells, data, scale: 1 / 255, unit: '0..1' }),
      species = Object.freeze(present.map((s) => plan.specs[s].key)),
      origin = Object.freeze([w.bounds[0] + tx * w.tileSize, w.bounds[1] + tz * w.tileSize] as const),
      side = w.tileSize,
      count = objects.length;
    return placed({
      x: tx,
      z: tz,
      origin,
      size: side,
      instances,
      count,
      species,
      canopy: raster('canopy', canopy),
      exclusion: raster('exclusion', exclusion),
      density: Object.freeze(density),
      stats: Object.freeze({ candidates, accepted: count, unresolved, rounds }),
    });
  }

  /**
   * Every candidate of a world rectangle (metres) that passed thinning, shade and the earlier layers, with its fate:
   * for debugging, editors and tests. `round` is the Luby round it settled in (0 when still undecided after the last).
   */
  async inspect(
    rect: Rect,
    options: { readonly signal?: AbortSignal } = {},
  ): Promise<
    {
      key: string;
      layer: number;
      x: number;
      z: number;
      spacing: number;
      size: number;
      priority: number;
      fate: 'accepted' | 'rejected' | 'unresolved';
      round: number;
    }[]
  > {
    this.#live();
    if (!Array.isArray(rect) || rect.length !== 4 || !rect.every(Number.isFinite))
      throw typeError('BiomePlacement inspect takes a [minX, minZ, maxX, maxZ] rectangle in metres', 'biomes');
    const w = this.#world,
      t = w.tileSize,
      tx0 = Math.max(0, Math.floor((rect[0] - w.bounds[0]) / t) - 1), // float division: metres to tiles
      tz0 = Math.max(0, Math.floor((rect[1] - w.bounds[1]) / t) - 1), // float division
      tx1 = Math.min(w.tilesX - 1, Math.floor((rect[2] - w.bounds[0]) / t) + 1), // float division
      tz1 = Math.min(w.tilesZ - 1, Math.floor((rect[3] - w.bounds[1]) / t) + 1); // float division
    return this.#withFields(tx0, tz0, tx1, tz1, options.signal, (fields) => {
      const run = this.#runOf(fields),
        x0 = Math.round((rect[0] - w.bounds[0]) * TICK),
        z0 = Math.round((rect[1] - w.bounds[1]) * TICK),
        x1 = Math.round((rect[2] - w.bounds[0]) * TICK),
        z1 = Math.round((rect[3] - w.bounds[1]) * TICK),
        out: Awaited<ReturnType<BiomePlacement['inspect']>> = [];
      this.#plan.strata.forEach((st, s) => {
        if (!st.species.length) return;
        for (let cz = z0 >> st.gs; cz <= (z1 - 1) >> st.gs; cz++)
          for (let cx = x0 >> st.gs; cx <= (x1 - 1) >> st.gs; cx++) {
            const slot = run.cell(s, cx, cz),
              p = run.pools[s],
              start = p.cells.start[slot],
              end = start + p.cells.count[slot];
            for (let i = start; i < end; i++) {
              if (p.x[i] < x0 || p.z[i] < z0 || p.x[i] >= x1 || p.z[i] >= z1) continue;
              run.live(s, i, this.#plan.rounds);
              const sp = this.#plan.specs[p.sp[i]];
              out.push({
                key: sp.key,
                layer: s,
                x: w.bounds[0] + p.x[i] / TICK, // float division: report
                z: w.bounds[1] + p.z[i] / TICK, // float division
                spacing: p.r[i] / TICK, // float division
                size: p.u[i] / ONE, // float division
                priority: p.prio[i],
                fate: p.fate[i] === ACCEPTED ? 'accepted' : p.fate[i] === KILLED ? 'rejected' : 'unresolved',
                round: p.fate[i] === LIVE ? 0 : p.round[i],
              });
            }
          }
      });
      return out;
    });
  }

  /** Stops listening to the world and frees the cache; later calls throw MargoError `'disposed'`. */
  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#off();
    this.#workers?.detach(this.#pid);
    this.#cache.clear();
    this.#listeners.clear();
    this.#pools.length = 0;
  }

  [Symbol.dispose](): void {
    this.dispose();
  }
}
