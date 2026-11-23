// Cliffs, overhangs and sea rocks for a heightfield (entry `@margoengine/terrain/rocks`). A heightfield holds one height
// per point, so it can draw neither an overhang nor a sea stack standing out of the water with a notch cut at its foot.
// This entry finds where such rock belongs from the ground's relief and slope, and builds each piece as a closed mesh
// (a signed distance field polygonized by Marching Cubes) that stands a little proud of the heightfield and is faded
// into it by `TerrainBlend` (`@margoengine/terrain/blend`); `RockSurface` (`@margoengine/terrain/rock-surface`) shades it.
//
// Sources (read as papers; no other engine's code):
// - Slope: B. K. P. Horn, "Hill shading and the reflectance map", Proc. IEEE 69(1), 1981, doi:10.1109/PROC.1981.11918
//   (the 3 x 3 weighted differences).
// - Local relief as a moving max minus min, in O(n) per line: M. van Herk, "A fast algorithm for local minimum and
//   maximum filters on rectangular and octagonal kernels", Pattern Recognition Letters 13(7), 1992,
//   doi:10.1016/0167-8655(92)90069-C; J. Gil and M. Werman, IEEE TPAMI 15(5), 1993, doi:10.1109/34.211471.
// - Distance from the shore: G. Borgefors, "Distance transformations in digital images", CVGIP 34(3), 1986,
//   doi:10.1016/S0734-189X(86)80047-0 (two-pass chamfer).
// - Rock volumes over a heightfield, overhangs, ledged strata and sea cliffs: A. Peytavie, E. Galin, J. Grosjean,
//   S. Merillou, "Arches: a framework for modeling complex terrains", Computer Graphics Forum 28(2), 2009,
//   doi:10.1111/j.1467-8659.2009.01385.x; A. Paris, E. Galin, A. Peytavie, E. Guerin, J. Gain, "Terrain amplification
//   with implicit 3D features", ACM TOG 38(5), 2019, doi:10.1145/3342765; M. N. Gamito and F. K. Musgrave, "Procedural
//   landscapes with overhangs", 10th Portuguese Computer Graphics Meeting, 2001.
// - Jointed blocks: A. Paris, A. Peytavie, E. Guerin, O. Argudo, E. Galin, "Modeling rocky scenery using implicit
//   blocks", The Visual Computer 36, 2020, https://hal.archives-ouvertes.fr/hal-02926218; boulders as rounded fracture
//   cells after A. Peytavie, E. Galin, J. Grosjean, S. Merillou, "Procedural generation of rock piles using aperiodic
//   tiling", Computer Graphics Forum 28(7), 2009, doi:10.1111/j.1467-8659.2009.01572.x.
// - Wave-cut notch at the still-water line and stacks as headland remnants: T. Sunamura, "Geomorphology of Rocky
//   Coasts", Wiley, 1992; A. S. Trenhaile, "The Geomorphology of Rock Coasts", Oxford, 1987.
// - Talus fall sorting (bigger blocks roll further from the foot): M. J. Kirkby and I. Statham, "Surface stone movement
//   and scree formation", Journal of Geology 83(3), 1975, doi:10.1086/628097.
// - Polygonizer: W. E. Lorensen and H. E. Cline, "Marching cubes", SIGGRAPH 1987, doi:10.1145/37402.37422
//   (`marchingCubes` of @margoengine/procedural).
import { Geometry } from '@margoengine/core';
import { marchingCubes } from '@margoengine/procedural/marching-cubes';
import { hash, valueNoise } from './noise3.js';

/** A heightfield to place rock on: world heights on a regular grid. */
export interface RockGround {
  /** World heights, `resolution[0] * resolution[1]` of them, x fastest. */
  readonly heights: ArrayLike<number>;
  /** Samples along x and z, integers 3 to 8,193. */
  readonly resolution: readonly [number, number];
  /** World x and z of the first sample. Default [0, 0]. */
  readonly origin?: readonly [number, number];
  /** World extent from the first sample to the last along x and z, above 0 (a `Terrain`'s `size`). */
  readonly size: readonly [number, number];
}
/** Where to look for rock; every option is checked and a bad value throws RangeError. */
export interface RockSiteOptions {
  /** Seed of every random choice, an unsigned 32-bit integer. Default 1. */
  seed?: number;
  /** World height of the sea (or lake) surface. Default 0. */
  seaLevel?: number;
  /** Ground at least this steep, degrees 20 to 85, can hold a cliff. Default 50. */
  cliffSlope?: number;
  /** Local relief (highest less lowest ground within `reliefRadius`) a cliff needs, metres, 0.5 to 5,000. Default 8. */
  cliffRelief?: number;
  /** Radius of the relief window, metres, above 0. Default 16. */
  reliefRadius?: number;
  /** Width of one cliff piece along the face, metres, 2 to 500; pieces are placed 0.75 of it apart, so they overlap. Default 24. */
  cliffWidth?: number;
  /** Most cliff pieces, integer 0 to 4,096. Default 64. */
  maxCliffs?: number;
  /** Most sea rocks (stacks and skerries), integer 0 to 4,096. Default 32. */
  seaRocks?: number;
  /** Water depth range a sea rock stands in, metres [shallowest, deepest], 0 to 1,000. Default [1, 15]. */
  seaRockDepth?: readonly [number, number];
  /** Farthest a sea rock stands from land, metres, above 0. Default 80. */
  shoreDistance?: number;
  /** Least distance between two sea rocks, metres, above 0. Default 14. */
  seaRockSpacing?: number;
  /** Fallen boulders at the foot of each cliff piece, integer 0 to 64. Default 3. */
  boulders?: number;
}
/** One cliff piece: a band of steep ground with its foot, crest and the way it faces. */
export interface CliffSite {
  readonly kind: 'cliff';
  /** World point on the face at mid height. */
  readonly position: readonly [number, number, number];
  /** Horizontal unit vector the face looks along (down the slope). */
  readonly facing: readonly [number, number];
  /** World x and z of the foot and of the crest along `facing`. */
  readonly foot: readonly [number, number];
  readonly crest: readonly [number, number];
  /** Ground height at the foot and at the crest. */
  readonly base: number;
  readonly top: number;
  /** Width along the face, metres. */
  readonly width: number;
  /** Ground slope where it was found, degrees, and the local relief there, metres. */
  readonly slope: number;
  readonly relief: number;
}
/** A rock standing in the water: a tall stack off a cliffed headland, or a low skerry. */
export interface SeaRockSite {
  readonly kind: 'stack' | 'skerry';
  /** World x, bed height and z. */
  readonly position: readonly [number, number, number];
  /** Radius at the foot, metres, and the world height of its top. */
  readonly radius: number;
  readonly top: number;
  /** World height of the sea it stands in (the notch is cut there). */
  readonly seaLevel: number;
}
/** A block fallen from a cliff, lying on the ground at its foot. */
export interface BoulderSite {
  readonly kind: 'boulder';
  /** World x, ground height and z. */
  readonly position: readonly [number, number, number];
  readonly radius: number;
  /** Index of the cliff in `RockSites.cliffs` it fell from. */
  readonly cliff: number;
}
/** What `findRockSites` found, plus the slope and relief grids it measured (same layout as the heights). */
export interface RockSites {
  readonly cliffs: readonly CliffSite[];
  readonly seaRocks: readonly SeaRockSite[];
  readonly boulders: readonly BoulderSite[];
  /** Slope per sample, degrees. */
  readonly slope: Float32Array;
  /** Local relief per sample, metres. */
  readonly relief: Float32Array;
}

/** Shape of a cliff piece; every option is checked and a bad value throws RangeError. */
export interface CliffOptions {
  /** Grid spacing of the polygonizer, metres, 0.05 to 20 (any size: a large piece is built in blocks of 127 cells). Default 0.5. */
  cell?: number;
  /** How far the top of the face leans out past its foot, metres, 0 to 100. Default 2.5. */
  overhang?: number;
  /**
   * How far the face stands in front of the heightfield, metres, 0 to 20, measured at the bottom of its deepest crack, soft
   * bed and bump, so the smooth slope never shows through. Default 0.6.
   */
  proud?: number;
  /** Rock kept behind the face, metres, 0.5 to 200. Default 6. */
  thickness?: number;
  /** Bed thickness of the strata, metres, 0 (massive rock) to 100. Default 1.4. */
  strata?: number;
  /** How far hard beds stand out of soft ones, metres, 0 to 20. Default 0.5. */
  ledges?: number;
  /** Tilt of the beds along the face, degrees -60 to 60. Default 0. */
  dip?: number;
  /** Spacing of the vertical joints, metres, 0 (none) to 200. Default 3. */
  joints?: number;
  /** Depth of a joint crack, metres, 0 to 20. Default 0.35. */
  crackDepth?: number;
  /** Size of the rough bumps over the whole face, metres, 0 to 20. Default 0.35. */
  roughness?: number;
  /** How deep the piece goes into the ground at its foot, metres, 0 to 50. Default 1.5. */
  embed?: number;
  /** Seed, an unsigned 32-bit integer. Default 1. */
  seed?: number;
}
/** Shape of a stack or skerry; every option is checked and a bad value throws RangeError. */
export interface SeaRockOptions {
  /** Grid spacing, metres, 0.05 to 20. Default: radius / 12, at least 0.1. */
  cell?: number;
  /** Depth of the wave-cut notch at the sea surface, metres, 0 to 20 (at most 0.45 of the radius is cut). Default 0.6. */
  notchDepth?: number;
  /** Height of the notch, metres, 0.1 to 20 (the wave and tide band). Default 1.2. */
  notchHeight?: number;
  /** How much narrower the top is than the foot, 0 to 0.9. Default 0.25 (a skerry 0.5). */
  taper?: number;
  /** Bed thickness, metres, 0 to 100. Default 0.9. */
  strata?: number;
  /** How far hard beds stand out, metres, 0 to 20. Default 0.25. */
  ledges?: number;
  /** Vertical joints around the rock, integer 0 to 64. Default 7. */
  joints?: number;
  /** Depth of a joint crack, metres, 0 to 20. Default 0.25. */
  crackDepth?: number;
  /** Lumpiness of the outline, 0 to 1 of the radius. Default 0.22. */
  lobes?: number;
  /** Size of the rough bumps, metres, 0 to 20. Default 0.25. */
  roughness?: number;
  /** How deep the rock goes into the bed, metres, 0 to 50. Default 1. */
  embed?: number;
  /** Seed, an unsigned 32-bit integer. Default 1. */
  seed?: number;
}
/** Shape of a fallen boulder; every option is checked and a bad value throws RangeError. */
export interface BoulderOptions {
  /** Grid spacing, metres, 0.02 to 10. Default: radius / 10, at least 0.04. */
  cell?: number;
  /** Fracture planes that cut the block, integer 4 to 32. Default 9. */
  facets?: number;
  /** How rounded its edges are, 0 (sharp) to 1. Default 0.18. */
  rounding?: number;
  /** Rough bumps as a share of the radius, 0 to 0.5. Default 0.06. */
  roughness?: number;
  /** Share of the radius buried in the ground, 0 to 0.9. Default 0.3. */
  embed?: number;
  /** Seed, an unsigned 32-bit integer. Default 1. */
  seed?: number;
}
/** A built rock: its geometry around `position` (set the mesh there), and the site it was built for. */
export interface RockMesh<S = CliffSite | SeaRockSite | BoulderSite> {
  readonly geometry: Geometry;
  readonly position: readonly [number, number, number];
  readonly site: S;
}
/** The options of `buildRocks`. */
export interface BuildRocksOptions {
  cliff?: CliffOptions;
  seaRock?: SeaRockOptions;
  boulder?: BoulderOptions;
}

const bad = (what: string): never => {
  throw new RangeError(`Invalid rock ${what}; see the @margoengine/terrain README, "Cliffs, overhangs and sea rocks"`);
};
const num = (v: unknown, lo: number, hi: number, what: string, open = false): number =>
  typeof v === 'number' && (open ? v > lo : v >= lo) && v <= hi && Number.isFinite(v) ? v : bad(what);
const int = (v: unknown, lo: number, hi: number, what: string): number =>
  Number.isInteger(v) && (v as number) >= lo && (v as number) <= hi ? (v as number) : bad(what);
const seedOf = (v: unknown): number => int(v ?? 1, 0, 0xffffffff, 'seed') | 0;
const object = (o: unknown, what: string) => {
  if (o !== undefined && (o === null || typeof o !== 'object')) bad(what);
  return (o ?? {}) as Record<string, unknown>;
};
const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);
const smooth = (a: number, b: number, x: number) => {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};
const rand = (a: number, b: number, c: number, seed: number) => hash(a, b, c, seed) * 0.5 + 0.5;
function fbm(x: number, y: number, z: number, seed: number, octaves: number): number {
  let sum = 0,
    amp = 0.5,
    f = 1;
  for (let o = 0; o < octaves; o++, amp *= 0.5, f *= 2.03) sum += amp * valueNoise(x * f, y * f, z * f, seed + o);
  return sum;
}
// Smooth maximum of two signed distances over a band k (polynomial blend; k 0 is the plain max): rounds the edge
// where two cuts meet.
const smax = (a: number, b: number, k: number) => {
  if (k <= 0) return Math.max(a, b);
  const h = clamp(0.5 + (0.5 * (a - b)) / k, 0, 1);
  return b + (a - b) * h + k * h * (1 - h);
};

/** A checked ground and its bilinear height at any world x, z (clamped to the grid). */
export interface GroundSampler {
  readonly nx: number;
  readonly nz: number;
  readonly ox: number;
  readonly oz: number;
  readonly dx: number;
  readonly dz: number;
  at(i: number, j: number): number;
  height(x: number, z: number): number;
}
/**
 * Checks `ground` and returns its sampler: `height(x, z)` is bilinear between the four samples around (x, z), clamped to
 * the grid's edge outside it.
 * @throws RangeError for a resolution, size or origin out of range, a heights array of the wrong length or a height
 * that is not finite.
 */
export function rockGround(ground: RockGround): GroundSampler {
  if (!ground || typeof ground !== 'object') bad('ground: pass {heights, resolution, size}');
  const [nx, nz] = ground.resolution ?? [],
    [sx, sz] = ground.size ?? [],
    [ox, oz] = ground.origin ?? [0, 0],
    h = ground.heights;
  int(nx, 3, 8193, 'ground resolution');
  int(nz, 3, 8193, 'ground resolution');
  num(sx, 0, 1e7, 'ground size', true);
  num(sz, 0, 1e7, 'ground size', true);
  num(ox, -1e9, 1e9, 'ground origin');
  num(oz, -1e9, 1e9, 'ground origin');
  if (!h || typeof h.length !== 'number' || h.length !== nx * nz) bad(`ground heights: pass ${nx * nz} heights`);
  for (let k = 0; k < h.length; k++) if (!Number.isFinite(h[k])) bad('ground heights: every height must be finite');
  const dx = sx / (nx - 1),
    dz = sz / (nz - 1),
    at = (i: number, j: number) => h[clamp(j, 0, nz - 1) * nx + clamp(i, 0, nx - 1)];
  return {
    nx,
    nz,
    ox,
    oz,
    dx,
    dz,
    at,
    height(x, z) {
      const u = clamp((x - ox) / dx, 0, nx - 1),
        v = clamp((z - oz) / dz, 0, nz - 1),
        i = Math.min(Math.floor(u), nx - 2),
        j = Math.min(Math.floor(v), nz - 2),
        s = u - i,
        t = v - j;
      return (at(i, j) * (1 - s) + at(i + 1, j) * s) * (1 - t) + (at(i, j + 1) * (1 - s) + at(i + 1, j + 1) * s) * t;
    },
  };
}

// The max (or min) over the window [i - r, i + r] of each entry of a line, edges clamped: van Herk / Gil-Werman, three
// passes over blocks of the window's length, whatever the radius.
function slide(line: Float32Array, r: number, max: boolean, out: Float32Array): void {
  const n = line.length,
    w = 2 * r + 1,
    m = n + 2 * r,
    p = new Float32Array(m),
    g = new Float32Array(m),
    h = new Float32Array(m);
  for (let k = 0; k < m; k++) p[k] = line[clamp(k - r, 0, n - 1)];
  for (let k = 0; k < m; k++) g[k] = k % w === 0 ? p[k] : max ? Math.max(g[k - 1], p[k]) : Math.min(g[k - 1], p[k]);
  for (let k = m - 1; k >= 0; k--)
    h[k] = k % w === w - 1 || k === m - 1 ? p[k] : max ? Math.max(h[k + 1], p[k]) : Math.min(h[k + 1], p[k]);
  for (let i = 0; i < n; i++) out[i] = max ? Math.max(h[i], g[i + 2 * r]) : Math.min(h[i], g[i + 2 * r]);
}
/** Highest less lowest height within a box of half sides `rx`, `rz` samples about each sample (edges clamped). */
export function localRelief(ground: RockGround, rx: number, rz: number): Float32Array {
  const g = rockGround(ground),
    { nx, nz } = g;
  int(rx, 0, 1 << 20, 'relief radius');
  int(rz, 0, 1 << 20, 'relief radius');
  const hi = new Float32Array(nx * nz),
    lo = new Float32Array(nx * nz),
    row = new Float32Array(nx),
    a = new Float32Array(nx),
    b = new Float32Array(nx);
  for (let j = 0; j < nz; j++) {
    for (let i = 0; i < nx; i++) row[i] = g.at(i, j);
    slide(row, rx, true, a);
    slide(row, rx, false, b);
    hi.set(a, j * nx);
    lo.set(b, j * nx);
  }
  const col = new Float32Array(nz),
    c = new Float32Array(nz),
    out = new Float32Array(nx * nz);
  for (let i = 0; i < nx; i++) {
    for (let j = 0; j < nz; j++) col[j] = hi[j * nx + i];
    slide(col, rz, true, c);
    for (let j = 0; j < nz; j++) out[j * nx + i] = c[j];
    for (let j = 0; j < nz; j++) col[j] = lo[j * nx + i];
    slide(col, rz, false, c);
    for (let j = 0; j < nz; j++) out[j * nx + i] -= c[j];
  }
  return out;
}

/** Greedy pick, best score first, keeping `spacing` between picks (a bucket grid finds the neighbours). */
function pick(
  order: Int32Array,
  count: number,
  spacing: number,
  most: number,
  point: (k: number) => [number, number],
  accept: (k: number) => boolean,
): number[] {
  const buckets = new Map<string, [number, number][]>(),
    picked: number[] = [];
  for (let q = 0; q < count && picked.length < most; q++) {
    const k = order[q],
      [x, z] = point(k),
      bx = Math.floor(x / spacing),
      bz = Math.floor(z / spacing);
    let near = false;
    for (let a = -1; a <= 1 && !near; a++)
      for (let b = -1; b <= 1 && !near; b++)
        for (const [px, pz] of buckets.get(bx + a + ',' + (bz + b)) ?? [])
          if ((px - x) ** 2 + (pz - z) ** 2 < spacing * spacing) {
            near = true;
            break;
          }
    if (near || !accept(k)) continue;
    const key = bx + ',' + bz;
    (buckets.get(key) ?? buckets.set(key, []).get(key)!).push([x, z]);
    picked.push(k);
  }
  return picked;
}
function sortBy(score: Float32Array, keep: (k: number) => boolean): [Int32Array, number] {
  const ids: number[] = [];
  for (let k = 0; k < score.length; k++) if (keep(k)) ids.push(k);
  // Best first; ties in grid order, so the pick never depends on the sort's stability.
  ids.sort((a, b) => score[b] - score[a] || a - b);
  return [Int32Array.from(ids), ids.length];
}

/**
 * Finds where rock belongs on `ground`: cliff pieces on steep ground of high local relief (each with its foot, crest
 * and facing found by walking down and up the slope until it eases to half the cliff slope), stacks and skerries in
 * shallow water near the shore (stacks off cliffed coast, after Sunamura 1992), and boulders fallen to each cliff's foot
 * (bigger ones further out, Kirkby and Statham 1975). The same ground and options always give the same sites.
 * @throws RangeError for a ground or option out of range.
 * @example const sites = findRockSites({ heights, resolution: [513, 513], size: [1024, 1024] }, { seaLevel: 0 });
 */
export function findRockSites(ground: RockGround, options: RockSiteOptions = {}): RockSites {
  const o = object(options, 'site options'),
    g = rockGround(ground),
    seed = seedOf(o.seed),
    sea = num(o.seaLevel ?? 0, -1e6, 1e6, 'seaLevel'),
    cliffSlope = num(o.cliffSlope ?? 50, 20, 85, 'cliffSlope'),
    cliffRelief = num(o.cliffRelief ?? 8, 0.5, 5000, 'cliffRelief'),
    reliefRadius = num(o.reliefRadius ?? 16, 0, 1e5, 'reliefRadius', true),
    cliffWidth = num(o.cliffWidth ?? 24, 2, 500, 'cliffWidth'),
    maxCliffs = int(o.maxCliffs ?? 64, 0, 4096, 'maxCliffs'),
    maxSea = int(o.seaRocks ?? 32, 0, 4096, 'seaRocks'),
    depth = (o.seaRockDepth ?? [1, 15]) as readonly number[],
    shore = num(o.shoreDistance ?? 80, 0, 1e6, 'shoreDistance', true),
    seaSpacing = num(o.seaRockSpacing ?? 14, 0, 1e5, 'seaRockSpacing', true),
    perCliff = int(o.boulders ?? 3, 0, 64, 'boulders');
  if (!Array.isArray(depth) || depth.length !== 2) bad('seaRockDepth: pass [shallowest, deepest]');
  const [dMin, dMax] = [num(depth[0], 0, 1000, 'seaRockDepth'), num(depth[1], 0, 1000, 'seaRockDepth')];
  if (dMin > dMax) bad('seaRockDepth: shallowest above deepest');
  const { nx, nz, dx, dz, ox, oz } = g,
    n = nx * nz,
    slope = new Float32Array(n),
    gx = new Float32Array(n),
    gz = new Float32Array(n);
  for (let j = 0; j < nz; j++)
    for (let i = 0; i < nx; i++) {
      const a = g.at(i - 1, j - 1),
        b = g.at(i, j - 1),
        c = g.at(i + 1, j - 1),
        d = g.at(i - 1, j),
        f = g.at(i + 1, j),
        p = g.at(i - 1, j + 1),
        q = g.at(i, j + 1),
        r = g.at(i + 1, j + 1),
        k = j * nx + i;
      // Horn 1981; on the outermost samples the clamped neighbour halves the step, so the slope stays a slope.
      const sx = (i === 0 || i === nx - 1 ? 2 : 1) * (c + 2 * f + r - (a + 2 * d + p)),
        sz = (j === 0 || j === nz - 1 ? 2 : 1) * (p + 2 * q + r - (a + 2 * b + c));
      gx[k] = sx / (8 * dx);
      gz[k] = sz / (8 * dz);
      slope[k] = (Math.atan(Math.hypot(gx[k], gz[k])) * 180) / Math.PI;
    }
  const relief = localRelief(
    ground,
    Math.max(1, Math.round(reliefRadius / dx)),
    Math.max(1, Math.round(reliefRadius / dz)),
  );
  const bilinear = (field: Float32Array, x: number, z: number) => {
    const u = clamp((x - ox) / dx, 0, nx - 1),
      v = clamp((z - oz) / dz, 0, nz - 1),
      i = Math.min(Math.floor(u), nx - 2),
      j = Math.min(Math.floor(v), nz - 2),
      s = u - i,
      t = v - j,
      k = j * nx + i;
    return (field[k] * (1 - s) + field[k + 1] * s) * (1 - t) + (field[k + nx] * (1 - s) + field[k + nx + 1] * s) * t;
  };
  const inside = (x: number, z: number) => x >= ox && z >= oz && x <= ox + dx * (nx - 1) && z <= oz + dz * (nz - 1);
  const xz = (k: number): [number, number] => [ox + (k % nx) * dx, oz + Math.floor(k / nx) * dz];

  // Cliffs.
  const cliffScore = new Float32Array(n);
  for (let k = 0; k < n; k++) cliffScore[k] = relief[k] * Math.sin((slope[k] * Math.PI) / 180);
  const [cOrder, cCount] = sortBy(cliffScore, (k) => {
    // Clear of the grid's edge by half a piece, so a piece never hangs past the ground it was found on.
    const i = k % nx,
      j = Math.floor(k / nx),
      mx = Math.ceil(cliffWidth / 2 / dx),
      mz = Math.ceil(cliffWidth / 2 / dz);
    return (
      i >= mx &&
      j >= mz &&
      i < nx - mx &&
      j < nz - mz &&
      slope[k] >= cliffSlope &&
      relief[k] >= cliffRelief &&
      g.at(i, j) >= sea - dMax
    );
  });
  const cliffs: CliffSite[] = [],
    step = Math.min(dx, dz) / 2,
    run = 4 * reliefRadius + 4 * Math.max(dx, dz);
  const walk = (x: number, z: number, fx: number, fz: number, sign: number): [number, number] => {
    let px = x,
      pz = z;
    for (let s = 0; s < run; s += step) {
      const qx = px + sign * fx * step,
        qz = pz + sign * fz * step;
      if (!inside(qx, qz) || bilinear(slope, qx, qz) < cliffSlope * 0.5) break;
      px = qx;
      pz = qz;
    }
    return [px, pz];
  };
  pick(cOrder, cCount, cliffWidth * 0.75, maxCliffs, xz, (k) => {
    const [x, z] = xz(k),
      l = Math.hypot(gx[k], gz[k]),
      fx = -gx[k] / l,
      fz = -gz[k] / l,
      foot = walk(x, z, fx, fz, 1),
      crest = walk(x, z, fx, fz, -1),
      base = g.height(foot[0], foot[1]),
      top = g.height(crest[0], crest[1]);
    if (top - base < cliffRelief * 0.5) return false;
    // The face's mid height, by bisection between crest and foot (the ground falls from one to the other).
    let a = 0,
      b = 1;
    const mid = (base + top) / 2;
    for (let it = 0; it < 30; it++) {
      const t = (a + b) / 2,
        h = g.height(crest[0] + (foot[0] - crest[0]) * t, crest[1] + (foot[1] - crest[1]) * t);
      if (h > mid) a = t;
      else b = t;
    }
    const t = (a + b) / 2,
      mx = crest[0] + (foot[0] - crest[0]) * t,
      mz = crest[1] + (foot[1] - crest[1]) * t;
    // Spaced again where the pieces end up (mid-face), so two found on one face from either side never stack.
    if (cliffs.some((c) => Math.hypot(c.position[0] - mx, c.position[2] - mz) < cliffWidth * 0.75)) return false;
    cliffs.push({
      kind: 'cliff',
      position: [mx, mid, mz],
      facing: [fx, fz],
      foot,
      crest,
      base,
      top,
      width: cliffWidth,
      slope: slope[k],
      relief: relief[k],
    });
    return true;
  });

  // Sea rocks: distance from land by a two-pass chamfer (Borgefors 1986), metres.
  const far = 1e30,
    dist = new Float32Array(n),
    dd = Math.hypot(dx, dz);
  for (let k = 0; k < n; k++) dist[k] = g.at(k % nx, Math.floor(k / nx)) >= sea ? 0 : far;
  for (let j = 0; j < nz; j++)
    for (let i = 0; i < nx; i++) {
      const k = j * nx + i;
      let v = dist[k];
      if (i > 0) v = Math.min(v, dist[k - 1] + dx);
      if (j > 0) {
        v = Math.min(v, dist[k - nx] + dz);
        if (i > 0) v = Math.min(v, dist[k - nx - 1] + dd);
        if (i < nx - 1) v = Math.min(v, dist[k - nx + 1] + dd);
      }
      dist[k] = v;
    }
  for (let j = nz - 1; j >= 0; j--)
    for (let i = nx - 1; i >= 0; i--) {
      const k = j * nx + i;
      let v = dist[k];
      if (i < nx - 1) v = Math.min(v, dist[k + 1] + dx);
      if (j < nz - 1) {
        v = Math.min(v, dist[k + nx] + dz);
        if (i < nx - 1) v = Math.min(v, dist[k + nx + 1] + dd);
        if (i > 0) v = Math.min(v, dist[k + nx - 1] + dd);
      }
      dist[k] = v;
    }
  const nearestCliff = (x: number, z: number): [number, number] => {
    let best = Infinity,
      index = -1;
    for (let c = 0; c < cliffs.length; c++) {
      const d = Math.hypot(cliffs[c].position[0] - x, cliffs[c].position[2] - z);
      if (d < best) [best, index] = [d, c];
    }
    return [best, index];
  };
  const seaScore = new Float32Array(n),
    water = (k: number) => {
      const d = sea - g.at(k % nx, Math.floor(k / nx));
      return d >= dMin && d <= dMax && d > 0 && dist[k] <= shore;
    };
  for (let k = 0; k < n; k++)
    if (water(k)) {
      const [x, z] = xz(k),
        [dc] = nearestCliff(x, z);
      // Rocks stand off the shore, most often half the reach out (a band, not the water's edge).
      const q = dist[k] / shore;
      seaScore[k] =
        (0.25 + 3 * q * (1 - q)) *
        (0.4 + Math.min(1, slope[k] / 30)) *
        (1 + 2 * Math.exp(-dc / (2 * cliffWidth))) *
        (0.6 + 0.4 * rand(k % nx, Math.floor(k / nx), 11, seed));
    }
  const [sOrder, sCount] = sortBy(seaScore, water),
    seaRocks: SeaRockSite[] = [];
  pick(sOrder, sCount, seaSpacing, maxSea, xz, (k) => {
    const [x, z] = xz(k),
      bed = g.at(k % nx, Math.floor(k / nx)),
      [dc, c] = nearestCliff(x, z),
      r1 = rand(k, 1, 0, seed),
      r2 = rand(k, 2, 0, seed),
      cliffTop = c >= 0 ? cliffs[c].top : sea,
      stack = c >= 0 && dc < 3 * cliffWidth && cliffTop - sea > 4 && r1 < 0.7;
    seaRocks.push(
      stack
        ? {
            kind: 'stack',
            position: [x, bed, z],
            radius: seaSpacing * (0.18 + 0.17 * r2),
            top: sea + Math.max(2.5, (0.35 + 0.5 * r1) * (cliffTop - sea)),
            seaLevel: sea,
          }
        : {
            kind: 'skerry',
            position: [x, bed, z],
            radius: seaSpacing * (0.22 + 0.25 * r2),
            top: sea + 0.4 + 2.1 * r1,
            seaLevel: sea,
          },
    );
    return true;
  });

  // Boulders at each cliff's foot.
  const boulders: BoulderSite[] = [];
  cliffs.forEach((cliff, c) => {
    const H = cliff.top - cliff.base,
      [fx, fz] = cliff.facing;
    for (let b = 0; b < perCliff; b++) {
      const a = rand(c, b, 21, seed),
        s = rand(c, b, 22, seed) ** 0.7,
        u = (a - 0.5) * cliff.width,
        out = H * (0.05 + 0.45 * s),
        x = cliff.foot[0] + fx * out + fz * u,
        z = cliff.foot[1] + fz * out - fx * u;
      if (!inside(x, z)) continue;
      boulders.push({
        kind: 'boulder',
        position: [x, g.height(x, z), z],
        radius: clamp(H * (0.025 + 0.06 * s) * (0.7 + 0.6 * rand(c, b, 23, seed)), 0.3, 6),
        cliff: c,
      });
    }
  });
  return { cliffs, seaRocks, boulders, slope, relief };
}

/** A rock's signed distance field and the box it is polygonized in. */
export interface RockField {
  /** Signed distance in local (u, y, v): below 0 inside the rock. */
  sd(u: number, y: number, v: number): number;
  lo: [number, number, number];
  hi: [number, number, number];
  cell: number;
  /** Local (u, y, v) to the geometry's frame (x, y, z about `position`): u along (frame[0], frame[1]) in x and z, v along (frame[2], frame[3]), y less frame[4]. */
  frame: [number, number, number, number, number];
}
/**
 * Polygonizes a field in blocks of at most 127 cells per axis (Marching Cubes on the field's own samples; blocks share
 * their boundary samples), welds the vertices the blocks share and takes every normal from the field's central
 * differences, so a piece shows no seam where its blocks meet. The field is closed one cell inside its box.
 */
function polygonize(f: RockField): Geometry {
  const n = [0, 1, 2].map((a) => Math.max(3, Math.ceil((f.hi[a] - f.lo[a]) / f.cell) + 1)),
    stepOf = [0, 1, 2].map((a) => (f.hi[a] - f.lo[a]) / (n[a] - 1)),
    coord = (a: number, k: number) => f.lo[a] + stepOf[a] * k,
    inset = stepOf.map((s) => s * 1.01),
    sd = (u: number, y: number, v: number) => {
      const box = Math.max(
        f.lo[0] + inset[0] - u,
        u - f.hi[0] + inset[0],
        f.lo[1] + inset[1] - y,
        y - f.hi[1] + inset[1],
        f.lo[2] + inset[2] - v,
        v - f.hi[2] + inset[2],
      );
      return Math.max(f.sd(u, y, v), box);
    };
  if (n[0] * n[1] * n[2] > 64e6) bad('cell: the piece needs over 64 million samples; use a larger cell');
  const chunks = n.map((count) => {
    const out: [number, number][] = [];
    for (let s = 0; s < count - 1; s += 127) out.push([s, Math.min(count - 1, s + 127)]);
    return out;
  });
  const positions: number[] = [],
    indices: number[] = [],
    weld = new Map<string, number>(),
    q = Math.min(...stepOf) * 1e-4;
  for (const [x0, x1] of chunks[0])
    for (const [y0, y1] of chunks[1])
      for (const [z0, z1] of chunks[2]) {
        const r: [number, number, number] = [x1 - x0 + 1, y1 - y0 + 1, z1 - z0 + 1],
          values = new Float64Array(r[0] * r[1] * r[2]);
        let any = false,
          neg = false;
        for (let k = 0, p = 0; k < r[2]; k++)
          for (let j = 0; j < r[1]; j++)
            for (let i = 0; i < r[0]; i++, p++) {
              const v = sd(coord(0, x0 + i), coord(1, y0 + j), coord(2, z0 + k));
              values[p] = v;
              if (v < 0) neg = true;
              else any = true;
            }
        if (!neg || !any) continue;
        const mesh = marchingCubes(values, {
          resolution: r,
          bounds: [
            [coord(0, x0), coord(1, y0), coord(2, z0)],
            [coord(0, x1), coord(1, y1), coord(2, z1)],
          ],
        });
        if (!mesh) continue;
        const vtx = mesh.vertices,
          map = new Int32Array(vtx.length / 6);
        for (let i = 0; i < map.length; i++) {
          const x = vtx[i * 6],
            y = vtx[i * 6 + 1],
            z = vtx[i * 6 + 2],
            key = Math.round(x / q) + ',' + Math.round(y / q) + ',' + Math.round(z / q);
          let id = weld.get(key);
          if (id === undefined) {
            id = positions.length / 3;
            weld.set(key, id);
            positions.push(x, y, z);
          }
          map[i] = id;
        }
        for (let t = 0; t < mesh.indices.length; t += 3) {
          const a = map[mesh.indices[t]],
            b = map[mesh.indices[t + 1]],
            c = map[mesh.indices[t + 2]];
          if (a !== b && b !== c && a !== c) indices.push(a, b, c);
        }
      }
  if (!indices.length) bad('shape: the field holds no rock; check the site and options');
  const [ca, sa, cb, sb, y0] = f.frame,
    out = new Float32Array(positions.length),
    normals = new Float32Array(positions.length),
    e = Math.min(...stepOf) * 0.5;
  for (let i = 0; i < positions.length; i += 3) {
    const u = positions[i],
      y = positions[i + 1],
      v = positions[i + 2];
    const nu = sd(u + e, y, v) - sd(u - e, y, v),
      ny = sd(u, y + e, v) - sd(u, y - e, v),
      nv = sd(u, y, v + e) - sd(u, y, v - e),
      l = Math.hypot(nu, ny, nv) || 1;
    // (u, v) to (x, z): u along (ca, sa), v along (cb, sb), a rotation (determinant 1), so winding is kept.
    out[i] = u * ca + v * cb;
    out[i + 1] = y - y0;
    out[i + 2] = u * sa + v * sb;
    normals[i] = (nu * ca + nv * cb) / l;
    normals[i + 1] = ny / l;
    normals[i + 2] = (nu * sa + nv * sb) / l;
  }
  return new Geometry(out, normals, indices);
}

function cliffOptions(options: CliffOptions | undefined) {
  const o = object(options, 'cliff options');
  return {
    cell: num(o.cell ?? 0.5, 0.05, 20, 'cell'),
    overhang: num(o.overhang ?? 2.5, 0, 100, 'overhang'),
    proud: num(o.proud ?? 0.6, 0, 20, 'proud'),
    thickness: num(o.thickness ?? 6, 0.5, 200, 'thickness'),
    strata: num(o.strata ?? 1.4, 0, 100, 'strata'),
    ledges: num(o.ledges ?? 0.5, 0, 20, 'ledges'),
    dip: num(o.dip ?? 0, -60, 60, 'dip'),
    joints: num(o.joints ?? 3, 0, 200, 'joints'),
    crackDepth: num(o.crackDepth ?? 0.35, 0, 20, 'crackDepth'),
    roughness: num(o.roughness ?? 0.35, 0, 20, 'roughness'),
    embed: num(o.embed ?? 1.5, 0, 50, 'embed'),
    seed: seedOf(o.seed),
  };
}
// Strata offset at bed coordinate b (beds 1 apart): hard beds (hash above 0) stand out, soft ones fall back, each with
// rounded edges, so the face steps in ledges and notches.
const bed = (b: number, seed: number) => {
  const k = Math.floor(b),
    fr = b - k;
  return hash(k, 7, 3, seed) * smooth(0, 0.2, fr) * smooth(1, 0.8, fr);
};

/**
 * The signed distance field of a cliff piece in its local frame (u along the face, y world height, v out of the face;
 * below 0 inside the rock) and the box it lives in. The face is the ground's own crossing of each height along the
 * facing, moved `proud` out, leaning `overhang` out over its top third, stepped by the strata and cut by joints.
 */
export function cliffField(site: CliffSite, ground: RockGround, options?: CliffOptions): RockField {
  const o = cliffOptions(options),
    g = rockGround(ground);
  if (!site || site.kind !== 'cliff') bad('cliff site: pass one of findRockSites(...).cliffs');
  const [px, , pz] = site.position,
    [fx, fz] = site.facing,
    tx = fz,
    tz = -fx,
    H = Math.max(site.top - site.base, o.cell * 4),
    w = site.width / 2,
    reach = H * 1.5 + site.width + 4 * o.cell,
    capTop = site.top + 0.6 * o.roughness,
    ys: [number, number] = [site.base - o.embed, capTop],
    step = Math.min(g.dx, g.dz) / 2;
  // The ground's crossing of height y on the line through u along the facing: the first v (from far behind the face)
  // where the ground falls below y, refined by bisection. A table over (u, y) at the polygonizer's cell, bilinear.
  const cross = (u: number, y: number) => {
    const line = (v: number) => g.height(px + tx * u + fx * v, pz + tz * u + fz * v);
    let prev = -reach;
    if (line(prev) < y) return -reach;
    for (let v = -reach + step; v <= reach; v += step) {
      if (line(v) < y) {
        let a = prev,
          b = v;
        for (let it = 0; it < 12; it++) {
          const m = (a + b) / 2;
          if (line(m) >= y) a = m;
          else b = m;
        }
        return (a + b) / 2;
      }
      prev = v;
    }
    return reach;
  };
  const nu = Math.max(2, Math.ceil((2 * w) / o.cell)) + 1,
    ny = Math.max(2, Math.ceil((ys[1] - ys[0]) / o.cell)) + 1,
    table = new Float32Array(nu * ny),
    footCross = new Float32Array(nu);
  for (let i = 0; i < nu; i++) footCross[i] = cross(-w + (2 * w * i) / (nu - 1), site.base);
  let cMin = Infinity,
    cMax = -Infinity;
  for (let j = 0; j < ny; j++)
    for (let i = 0; i < nu; i++) {
      const y = ys[0] + ((ys[1] - ys[0]) * j) / (ny - 1);
      // Below the foot the rock stops just past the foot's crossing: the rest is under the ground anyway.
      const c = Math.min(cross(-w + (2 * w * i) / (nu - 1), y), footCross[i] + o.embed + o.cell);
      table[j * nu + i] = c;
      cMin = Math.min(cMin, c);
      cMax = Math.max(cMax, c);
    }
  const crossAt = (u: number, y: number) => {
    const a = clamp(((u + w) / (2 * w)) * (nu - 1), 0, nu - 1),
      b = clamp(((y - ys[0]) / (ys[1] - ys[0])) * (ny - 1), 0, ny - 1),
      i = Math.min(Math.floor(a), nu - 2),
      j = Math.min(Math.floor(b), ny - 2),
      s = a - i,
      t = b - j,
      k = j * nu + i;
    return (table[k] * (1 - s) + table[k + 1] * s) * (1 - t) + (table[k + nu] * (1 - s) + table[k + nu + 1] * s) * t;
  };
  const dip = Math.tan((o.dip * Math.PI) / 180),
    out = o.proud + o.overhang + o.ledges + o.crackDepth + 3 * o.roughness + o.cell;
  const sd = (u: number, y: number, v: number) => {
    const c = crossAt(u, y),
      t = clamp((y - site.base) / H, 0, 1),
      x = px + tx * u + fx * v,
      z = pz + tz * u + fz * v;
    // The deepest crack, soft bed and bump still end `proud` in front of the ground's slope.
    let face = c + o.proud + o.crackDepth + o.roughness + o.overhang * smooth(0.58, 0.9, t);
    let b = 0;
    if (o.strata > 0) {
      b = (y + u * dip) / o.strata + 0.35 * valueNoise(x / (6 * o.strata), 0.5, z / (6 * o.strata), o.seed);
      face += o.ledges * (bed(b, o.seed) + 1) * 0.5;
    }
    if (o.joints > 0 && o.crackDepth > 0) {
      // Joints shift by bed (brick-like jointing of bedded rock) and wander a little up the face.
      const k = Math.floor(b),
        a =
          (u + hash(k, 5, 1, o.seed) * o.joints + 0.25 * o.joints * valueNoise(x * 0.2, y * 0.1, z * 0.2, o.seed + 9)) /
          o.joints,
        dj = Math.abs(a - Math.round(a)) * o.joints;
      face -= o.crackDepth * (1 - smooth(0, Math.max(o.cell, 0.08 * o.joints), dj));
    }
    face -= smooth(0.55, 1, Math.abs(u) / w) * out;
    let d = v - face + o.roughness * fbm(x / 3, y / 3, z / 3, o.seed + 17, 3) * 2;
    d = Math.max(d, c - o.thickness - v);
    d = smax(
      d,
      y - (site.top - 0.25 + 0.5 * o.roughness * valueNoise(x * 0.15, 3.5, z * 0.15, o.seed + 3)),
      0.3 * o.cell,
    );
    d = Math.max(d, site.base - o.embed - y, Math.abs(u) - w);
    return d;
  };
  return {
    sd,
    lo: [-w - o.cell, ys[0] - o.cell, cMin - o.thickness - o.cell * 2],
    hi: [w + o.cell, ys[1] + o.cell, cMax + out + o.cell * 2],
    cell: o.cell,
    frame: [tx, tz, fx, fz, site.position[1]],
  };
}

/**
 * Builds a cliff piece as a closed mesh around its site's mid-face `position`: the face stands `proud` in front of the
 * heightfield (so the smooth slope never shows), leans `overhang` out over its top third, steps in strata ledges and is
 * cut by joint cracks. Fade its foot into the ground with `TerrainBlend` and shade it with `RockSurface`.
 * @throws RangeError for a site that is not a cliff, a ground or option out of range, or a piece over 64 million samples.
 * @example const rock = buildCliff(sites.cliffs[0], ground, { overhang: 4 });
 * engine.createMesh().setGeometry(rock.geometry).setPosition(rock.position);
 */
export function buildCliff(site: CliffSite, ground: RockGround, options?: CliffOptions): RockMesh<CliffSite> {
  const field = cliffField(site, ground, options);
  return { geometry: polygonize(field), position: [...site.position] as [number, number, number], site };
}

function seaOptions(options: SeaRockOptions | undefined, site: SeaRockSite) {
  const o = object(options, 'sea rock options'),
    skerry = site.kind === 'skerry';
  return {
    cell: num(o.cell ?? Math.max(0.1, site.radius / 12), 0.05, 20, 'cell'),
    notchDepth: num(o.notchDepth ?? 0.6, 0, 20, 'notchDepth'),
    notchHeight: num(o.notchHeight ?? 1.2, 0.1, 20, 'notchHeight'),
    taper: num(o.taper ?? (skerry ? 0.5 : 0.25), 0, 0.9, 'taper'),
    strata: num(o.strata ?? 0.9, 0, 100, 'strata'),
    ledges: num(o.ledges ?? 0.25, 0, 20, 'ledges'),
    joints: int(o.joints ?? 7, 0, 64, 'joints'),
    crackDepth: num(o.crackDepth ?? 0.25, 0, 20, 'crackDepth'),
    lobes: num(o.lobes ?? 0.22, 0, 1, 'lobes'),
    roughness: num(o.roughness ?? 0.25, 0, 20, 'roughness'),
    embed: num(o.embed ?? 1, 0, 50, 'embed'),
    seed: seedOf(o.seed),
  };
}
/**
 * The signed distance field of a stack or skerry about its site (u = x, v = z less the site's; y world height): a
 * lumpy tapering column with a wave-cut notch at the sea surface (a band `notchHeight` high centred a tenth of it above
 * still water, Trenhaile 1987), strata ledges, joints around it and a rounded top.
 */
export function seaRockField(site: SeaRockSite, options?: SeaRockOptions): RockField {
  if (!site || (site.kind !== 'stack' && site.kind !== 'skerry'))
    bad('sea rock site: pass one of findRockSites(...).seaRocks');
  const o = seaOptions(options, site),
    [px, bedY, pz] = site.position,
    R0 = site.radius,
    H = Math.max(site.top - bedY, o.cell * 4),
    notchMid = site.seaLevel + 0.1 * o.notchHeight,
    notch = Math.min(o.notchDepth, 0.45 * R0),
    lo = bedY - o.embed,
    top = site.top;
  const sd = (u: number, y: number, v: number) => {
    const r = Math.hypot(u, v),
      cu = r > 1e-9 ? u / r : 1,
      cv = r > 1e-9 ? v / r : 0,
      t = clamp((y - bedY) / H, 0, 1);
    let R = R0 * (1 - o.taper * t) * (1 + o.lobes * valueNoise(cu * 1.6, y / (R0 * 1.5), cv * 1.6, o.seed));
    R -= notch * Math.exp(-(((y - notchMid) / (0.5 * o.notchHeight)) ** 2));
    let b = 0;
    if (o.strata > 0) {
      b = y / o.strata + 0.3 * valueNoise(cu, 0.5, cv, o.seed + 1);
      R += o.ledges * bed(b, o.seed);
    }
    if (o.joints > 0 && o.crackDepth > 0) {
      const a = ((Math.atan2(v, u) / (2 * Math.PI)) * o.joints + hash(Math.floor(b), 4, 2, o.seed) * 0.5) % 1,
        dj = Math.abs(a - Math.round(a)) * ((2 * Math.PI * Math.max(r, 1e-3)) / o.joints);
      R -= o.crackDepth * (1 - smooth(0, Math.max(o.cell, 0.06 * R0), dj));
    }
    let d = r - Math.max(R, 0.05 * R0) + o.roughness * fbm((px + u) / 2, y / 2, (pz + v) / 2, o.seed + 5, 3) * 2;
    d = smax(d, y - (top + 0.3 * o.roughness * valueNoise(u * 0.4, 1.5, v * 0.4, o.seed + 2)), Math.min(R0, H) * 0.25);
    return Math.max(d, lo - y);
  };
  const reach = R0 * (1 + o.lobes) + o.ledges + 2 * o.roughness + 2 * o.cell;
  return {
    sd,
    lo: [-reach, lo - o.cell, -reach],
    hi: [reach, top + o.roughness + 2 * o.cell, reach],
    cell: o.cell,
    frame: [1, 0, 0, 1, bedY],
  };
}
/**
 * Builds a stack or skerry as a closed mesh about its site's `position` (x, bed height, z). Its notch sits at the sea
 * surface it was found in (`site.seaLevel`).
 * @throws RangeError for a site that is not a sea rock or an option out of range.
 * @example for (const s of sites.seaRocks) { const r = buildSeaRock(s); engine.createMesh().setGeometry(r.geometry).setPosition(r.position); }
 */
export function buildSeaRock(site: SeaRockSite, options?: SeaRockOptions): RockMesh<SeaRockSite> {
  return {
    geometry: polygonize(seaRockField(site, options)),
    position: [...site.position] as [number, number, number],
    site,
  };
}

function boulderOptions(options: BoulderOptions | undefined, site: BoulderSite) {
  const o = object(options, 'boulder options');
  return {
    cell: num(o.cell ?? Math.max(0.04, site.radius / 10), 0.02, 10, 'cell'),
    facets: int(o.facets ?? 9, 4, 32, 'facets'),
    rounding: num(o.rounding ?? 0.18, 0, 1, 'rounding'),
    roughness: num(o.roughness ?? 0.06, 0, 0.5, 'roughness'),
    embed: num(o.embed ?? 0.3, 0, 0.9, 'embed'),
    seed: seedOf(o.seed),
  };
}
/**
 * The signed distance field of a boulder about its centre. The seed varies the proportions, joint orientation and
 * fracture planes. The bed face and principal joints keep broad faces between the rounded edges.
 */
export function boulderField(site: BoulderSite, options?: BoulderOptions): RockField {
  if (!site || site.kind !== 'boulder') bad('boulder site: pass one of findRockSites(...).boulders');
  const o = boulderOptions(options, site),
    r = num(site.radius, 0, 1e4, 'boulder radius', true),
    planes: number[] = [],
    key = Math.round(site.position[0] * 7) ^ Math.round(site.position[2] * 13) ^ o.seed;
  const angle = 2 * Math.PI * rand(0, 1, key, 3),
    c = Math.cos(angle),
    s = Math.sin(angle),
    xSpan = 0.92 + 0.25 * rand(1, 1, key, 3),
    zSpan = 0.63 + 0.35 * rand(2, 1, key, 3),
    pitch = 0.12 + 0.73 * rand(3, 1, key, 3),
    roof = 0.71 + 0.23 * rand(4, 1, key, 3);
  // Keep a bearing face below ground and a pitched fracture above it, then cut the sides and corners in local axes.
  planes.push(0, -1, 0, 0.84 * r, pitch, 1, 0.12 * hash(3, 2, key, 3), roof * r);
  for (let k = 2; k < o.facets; k++) {
    const side = k < 6,
      a = (k - 2) * (side ? Math.PI / 2 : 2.399963) + 0.24 * hash(k, 2, key, 3),
      y = side ? 0.32 * hash(k, 4, key, 3) : 0.39 + 0.5 * hash(k, 4, key, 3),
      distance = r * (0.73 + 0.25 * rand(k, 3, key, 3));
    planes.push(Math.cos(a) / xSpan, y, Math.sin(a) / zSpan, distance);
  }
  const k = o.rounding * r * 0.25,
    sd = (u: number, y: number, v: number) => {
      const x = u * c + v * s,
        z = v * c - u * s;
      // The envelope closes sparsely cut rocks; on most faces the fractures lie well inside the envelope.
      let d = Math.hypot(x / xSpan, y * 0.89, z / zSpan) - r * 1.105;
      for (let p = 0; p < planes.length; p += 4)
        d = smax(d, x * planes[p] + y * planes[p + 1] + z * planes[p + 2] - planes[p + 3], k);
      return d + o.roughness * r * fbm(x / (0.45 * r), y / (0.34 * r), z / (0.45 * r), o.seed + key, 3) * 2;
    };
  const e = r * (1.105 + 1.75 * o.roughness),
    ex = e * Math.hypot(c * xSpan, s * zSpan) + 2 * o.cell,
    ez = e * Math.hypot(s * xSpan, c * zSpan) + 2 * o.cell,
    down = Math.min(e / 0.89, r * (0.84 + 1.75 * o.roughness)) + 2 * o.cell;
  return { sd, lo: [-ex, -down, -ez], hi: [ex, e / 0.89 + 2 * o.cell, ez], cell: o.cell, frame: [1, 0, 0, 1, 0] };
}
/**
 * Builds a boulder as a closed mesh about its centre, which lies `embed` of its radius above the ground point of its site
 * (so that much of it is buried).
 * @throws RangeError for a site that is not a boulder or an option out of range.
 */
export function buildBoulder(site: BoulderSite, options?: BoulderOptions): RockMesh<BoulderSite> {
  const o = boulderOptions(options, site),
    [x, y, z] = site.position;
  return {
    geometry: polygonize(boulderField(site, options)),
    position: [x, y + site.radius * (1 - o.embed) * 0.87, z],
    site,
  };
}

/**
 * Builds every site `findRockSites` found: cliffs, then sea rocks, then boulders, in the sites' order.
 * @throws RangeError as the single builders do.
 * @example
 * const sites = findRockSites(ground, { seaLevel: 0 });
 * for (const rock of buildRocks(sites, ground)) engine.createMesh().setGeometry(rock.geometry).setPosition(rock.position);
 */
export function buildRocks(sites: RockSites, ground: RockGround, options: BuildRocksOptions = {}): RockMesh[] {
  const o = object(options, 'build options');
  if (!sites || !Array.isArray(sites.cliffs)) bad('sites: pass the result of findRockSites');
  return [
    ...sites.cliffs.map((s) => buildCliff(s, ground, o.cliff as CliffOptions)),
    ...sites.seaRocks.map((s) => buildSeaRock(s, o.seaRock as SeaRockOptions)),
    ...sites.boulders.map((s) => buildBoulder(s, o.boulder as BoulderOptions)),
  ];
}
