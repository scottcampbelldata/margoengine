// Mountain valleys of createRelief (`ReliefOptions.mountainValley`): a main valley with a level floor that falls to an
// outlet on one edge of the world, a creek and a rail grade on that floor, and walls cut into side gulches and ridges by
// stream-power drainage under threshold hillslopes. The country it is shaped after is the northern Rockies round
// Wallace, Idaho (the Coeur d'Alene and St. Joe mountains of the 1910 fires).
//
// Method, from published descriptions only (sources in docs/relief-and-hydrology.md):
// - The valley floor is a fixed base level, as the outlet of a landscape evolution model (Howard 1994; Whipple and
//   Tucker 1999). Every other cell of a grid over the world drains to it over the filled surface in Priority-Flood order
//   (Barnes, Lehman and Mulla 2014); the drainage network forms over a seeded starting surface, and each round routes it
//   again over the heights of the last.
// - Detachment-limited stream power, E = K A^m S^n with n = 1 and m / n = 0.5 (Howard 1994; Whipple and Tucker 1999),
//   in its steady state E = U: each cell stands `ks / sqrt(A)` per metre above the cell it drains to, solved in one pass
//   from the base level upstream, the order and the limit of a long step of Braun and Willett's implicit O(n) scheme
//   (Braun and Willett 2013), as Cordonnier et al. (2016) solve uplift against fluvial erosion on a drainage graph.
//   `ks = U / K` is the channel steepness index (Kirby and Whipple 2012).
// - Hillslopes no steeper than a critical angle (threshold hillslopes: Burbank et al. 1996; Montgomery and Brandon
//   2002), applied exactly by a lowest-first pass that lowers each cell to its lowest neighbour plus the critical rise.
// - Rounded ridges: convex hilltops from soil creep (Gilbert 1909; Roering, Kirchner and Dietrich 1999), here passes
//   that lower each convex cell to the mean of its 3 x 3 block and leave concave cells (hollows and channels) alone.
// - Rivers and gulches as the skeleton of the terrain, hillslopes built from them: Genevaux et al. 2013.
// Every step is integer millimetres and Q16, so the same options give the same heights on every engine.
import { rangeError } from '../../shared/errors.js';
import { bilinear, clampInt, divFloor, isqrt, ONE, sincos } from './fixed.js';
import { fbm, hash3 } from './hash.js';
import { mountainValleyHook } from './valley-hook.js';

/** Settings of a mountain valley (`ReliefOptions.mountainValley`). Lengths in metres. */
export interface MountainValleyOptions {
  /** Edge of the world the main valley drains out of. Default `'west'` (the South Fork of the Coeur d'Alene runs west past Wallace). */
  readonly outlet?: 'west' | 'east' | 'north' | 'south';
  /** Where the valley leaves that edge, 0.1..0.9 of the way along it. Default 0.5. */
  readonly center?: number;
  /**
   * Half width of the level valley floor, 5..1,000, measured along the outlet edge; it varies from 0.75 to 1.25 of this
   * along the valley. Default 110 (a floor of about 220 m, room for a creek, a rail line and a town).
   */
  readonly floor?: number;
  /** Fall of the floor toward the outlet per metre, 0.0005..0.1. Default 0.012 (about the South Fork through Wallace). */
  readonly fall?: number;
  /**
   * Critical hillslope angle in degrees, 15..50: no wall is steeper. Default 33 (65 percent, the top of the 50 to 65
   * percent slopes common on the Coeur d'Alene National Forest, Deitschman 1973).
   */
  readonly wall?: number;
  /**
   * Channel steepness `ks` in metres, 1..2,000: a gulch draining A square metres falls `ks / sqrt(A)` per metre. Default
   * 120 (a gulch of 1 km2 falls 12 percent).
   */
  readonly steepness?: number;
  /** Ridge crests rounded by creep or left sharp. Default `'rounded'`. */
  readonly ridges?: 'rounded' | 'sharp';
  /** Spacing of the side gulches in metres, 100..4,000: the wavelength of the starting surface they form on. Default 520. */
  readonly gulches?: number;
  /** The creek on the floor: `width` 1..60 (default 8) and `depth` of its bed under the floor 0.2..10 (default 1.5). */
  readonly creek?: { readonly width?: number; readonly depth?: number };
  /**
   * A rail grade on the floor, on the side away from the creek, or `false` for none: `grade`, the steepest the line may
   * climb, 0.001..0.06 (default 0.017, the 1.7 percent of the Milwaukee Road over St. Paul Pass, 1908), which the floor's
   * `fall` must not pass; and `width` of the level bed 2..20 (default 6).
   */
  readonly rail?: { readonly grade?: number; readonly width?: number } | false;
  /** Spacing of the drainage grid in metres, 4..256. Default 16, doubled until the world is at most 512 cells across. */
  readonly step?: number;
}

/** A mountain valley made by `createRelief` (`Relief.mountainValley`). Lines are `[x0, z0, x1, z1, ...]` in mm, outlet first. */
export interface MountainValley {
  /** Centre line of the floor. */
  readonly axis: Int32Array;
  /** The creek's centre line (also the relief's one river). */
  readonly creek: Int32Array;
  /** The rail line's centre, or null without a rail. */
  readonly rail: Int32Array | null;
  /**
   * The valley frame of world `(x, z)` in mm: `[along, across]`, the distance in from the outlet edge and the offset
   * from the centre line parallel to that edge, positive on the rail's side.
   */
  frame(x: number, z: number): [number, number];
  /** Height of the floor in mm `along` mm in from the outlet edge (it rises by `fall` per mm). */
  floorHeight(along: number): number;
  /** Half width of the floor in mm `along` mm in from the outlet edge. */
  floorWidth(along: number): number;
  /**
   * The drainage grid, cell (0, 0) at the relief origin and `step` mm apart, rows of increasing z: heights in mm, the
   * cells draining through each (itself included), and the D8 direction each drains to (0 is +x, then clockwise seen from
   * above with +z down the grid), -1 on the floor.
   */
  readonly grid: Readonly<{
    height: Int32Array;
    flow: Int32Array;
    direction: Int8Array;
    nx: number;
    nz: number;
    step: number;
  }>;
}

/** The options of a mountain valley with defaults filled in, lengths in mm, rates in Q16. */
export interface MountainValleySettings {
  outlet: 'west' | 'east' | 'north' | 'south';
  center: number;
  floor: number;
  fall: number;
  /** Critical angle in thousandths of a degree. */
  wall: number;
  steepness: number;
  ridges: 'rounded' | 'sharp';
  gulches: number;
  creekWidth: number;
  creekDepth: number;
  /** Rail grade in Q16, 0 without a rail. */
  railGrade: number;
  railWidth: number;
  step: number;
}

const mm = (m: number) => Math.round(m * 1000);
const OUTLETS = ['west', 'east', 'north', 'south'];
/** D8 neighbour offsets, +x then clockwise with +z down the grid. */
const DX = [1, 1, 0, -1, -1, -1, 0, 1],
  DZ = [0, 1, 1, 1, 0, -1, -1, -1];
/** sqrt(2) in Q16. */
const ROOT2 = 92682;
/** A heap key packs a height (+-33.5 km, mm) and a cell index (below 2^21) under 2^53. */
const LIMIT = 33554432,
  CELLS = 2097152,
  MAX_CELLS = 1048576;
/** Smoothstep of a Q16 t in 0..1. */
const smooth = (t: number) => Math.floor((t * t * (3 * ONE - 2 * t)) / 4294967296);
/** `floor(a * q / 65536)` for a Q16 q, exact for |a| below 2^36. */
const q16 = (a: number, q: number) => Math.floor((a * q) / ONE);

/**
 * Checks and quantises the options for a world of `size` mm. `alone` is false when the relief also asks for a coast, ria,
 * islands, rivers or erosion, which the valley refuses.
 */
export function mountainValleySettings(
  o: MountainValleyOptions,
  size: readonly [number, number],
  alone = true,
): MountainValleySettings {
  if (!alone)
    throw rangeError(
      "Invalid relief mountainValley; use it with coast: 'none', no ria, islands or erosion (its own drainage cuts it) and rivers: 0 (the valley's creek is its river)",
      'biomes',
    );
  const bad = () =>
    rangeError(
      'Invalid relief mountainValley; outlet west/east/north/south, center 0.1..0.9, floor 5..1,000 m, fall 0.0005..0.1 and at most the rail grade, wall 15..50 degrees, steepness 1..2,000 m, ridges rounded or sharp, gulches 100..4,000 m, creek width 1..60 m and depth 0.2..10 m, rail false or grade 0.001..0.06 and width 2..20 m, and step 4..256 m; the floor must hold the creek (and the rail 10 m from it) and the world must be at least 256 m and 5 floors wide',
      'biomes',
    );
  if (typeof o !== 'object' || o === null) throw bad();
  const { outlet = 'west', center = 0.5, floor = 110, fall = 0.012, wall = 33, steepness = 120 } = o,
    { ridges = 'rounded', gulches = 520, creek = {}, rail = {} } = o;
  if (typeof creek !== 'object' || creek === null) throw bad();
  if (rail !== false && (typeof rail !== 'object' || rail === null)) throw bad();
  const { width: cw = 8, depth: cd = 1.5 } = creek,
    { grade = 0.017, width: rw = 6 } = rail === false ? {} : rail;
  if (
    !OUTLETS.includes(outlet) ||
    !(center >= 0.1 && center <= 0.9) ||
    !(floor >= 5 && floor <= 1000) ||
    !(fall >= 0.0005 && fall <= 0.1) ||
    !(wall >= 15 && wall <= 50) ||
    !(steepness >= 1 && steepness <= 2000) ||
    (ridges !== 'rounded' && ridges !== 'sharp') ||
    !(gulches >= 100 && gulches <= 4000) ||
    !(cw >= 1 && cw <= 60) ||
    !(cd >= 0.2 && cd <= 10) ||
    !(grade >= 0.001 && grade <= 0.06) ||
    !(rw >= 2 && rw <= 20)
  )
    throw bad();
  const fallQ = Math.round(fall * ONE),
    gradeQ = rail === false ? 0 : Math.round(grade * ONE),
    floorMm = mm(floor),
    narrow = Math.floor((floorMm * 3) / 4),
    creekReach = Math.floor(mm(cw) / 2) + 2 * mm(cd);
  if (rail !== false && fallQ > gradeQ) throw bad();
  // The creek keeps inside 0.6 of the narrowest floor; the rail sits at half the floor on the other side, 10 m clear of the creek's banks.
  if (Math.floor((narrow * 2) / 5) < creekReach) throw bad();
  if (rail !== false && Math.floor((narrow * 13) / 20) - Math.floor(mm(rw) / 2) - creekReach < 10_000) throw bad();
  const vertical = outlet === 'north' || outlet === 'south',
    along = vertical ? size[0] : size[1],
    across = vertical ? size[1] : size[0];
  if (along < Math.max(256_000, 5 * floorMm) || across < 256_000) throw bad();
  let step = 16_000;
  while (Math.max(size[0], size[1]) > 512 * step) step *= 2;
  if (o.step !== undefined) {
    if (!(o.step >= 4 && o.step <= 256)) throw bad();
    step = mm(o.step);
  }
  if ((1 - divFloor(-size[0], step)) * (1 - divFloor(-size[1], step)) > MAX_CELLS) throw bad();
  return {
    outlet,
    center: Math.floor(along * center),
    floor: floorMm,
    fall: fallQ,
    wall: Math.round(wall * 1000),
    steepness: mm(steepness),
    ridges,
    gulches: mm(gulches),
    creekWidth: mm(cw),
    creekDepth: mm(cd),
    railGrade: gradeQ,
    railWidth: mm(rw),
    step,
  };
}

/** Working arrays of the drainage grid. */
interface Grid {
  nx: number;
  nz: number;
  h: Int32Array;
  fixed: Uint8Array;
  dir: Int8Array;
  order: Int32Array;
  area: Int32Array;
  heap: Float64Array;
  seen: Uint8Array;
}

/**
 * Routes the water. Priority-Flood with a 1 mm rise (Barnes, Lehman and Mulla 2014, "+epsilon") from the fixed cells
 * (the floor; the rest of the border is closed) fills every depression so that each cell has a strictly lower
 * neighbour; each cell then drains to one of them by the rho8 rule (Fairfield and Leymarie 1991): the steepest drop,
 * a diagonal drop divided by 2 - r for a hashed r in 0..1 of the cell, so flow over a smooth slope does not lock onto
 * the 8 grid directions. `order` lists the cells receivers first (the stack order of Braun and Willett 2013); `area`
 * counts the cells draining through each.
 */
function route(g: Grid, seed: number): void {
  const { nx, nz, h, fixed, dir, order, area, heap, seen } = g,
    n = nx * nz,
    filled = new Int32Array(n);
  seen.fill(0);
  let size = 0;
  const push = (c: number, level: number) => {
    seen[c] = 1;
    filled[c] = level;
    const key = (level + LIMIT) * CELLS + c;
    let k = size++;
    while (k > 0) {
      const up = (k - 1) >> 1;
      if (heap[up] <= key) break;
      heap[k] = heap[up];
      k = up;
    }
    heap[k] = key;
  };
  for (let c = 0; c < n; c++) if (fixed[c]) push(c, h[c]);
  while (size) {
    const c = heap[0] % CELLS,
      last = heap[--size];
    let k = 0;
    for (let child = 1; child < size; child = 2 * k + 1) {
      if (child + 1 < size && heap[child + 1] < heap[child]) child++;
      if (heap[child] >= last) break;
      heap[k] = heap[child];
      k = child;
    }
    heap[k] = last;
    const cz = divFloor(c, nx),
      cx = c - cz * nx;
    for (let d = 0; d < 8; d++) {
      const u = cx + DX[d],
        v = cz + DZ[d];
      if (u < 0 || v < 0 || u >= nx || v >= nz) continue;
      const i = v * nx + u;
      if (!seen[i]) push(i, Math.max(h[i], filled[c] + 1));
    }
  }
  // Receivers by rho8 over the filled surface, and the count of donors of each cell.
  const donors = new Int32Array(n + 1);
  for (let c = 0; c < n; c++) {
    dir[c] = -1;
    if (fixed[c]) continue;
    const cz = divFloor(c, nx),
      cx = c - cz * nx,
      den = 2 * ONE - (hash3(seed, c, 47) >>> 16);
    let best = -1;
    for (let d = 0; d < 8; d++) {
      const u = cx + DX[d],
        v = cz + DZ[d];
      if (u < 0 || v < 0 || u >= nx || v >= nz) continue;
      const drop = filled[c] - filled[v * nx + u];
      if (drop <= 0) continue;
      const steep = d & 1 ? divFloor(drop * ONE, den) : drop;
      if (steep > best) {
        best = steep;
        dir[c] = d;
      }
    }
    donors[c + DZ[dir[c]] * nx + DX[dir[c]] + 1]++;
  }
  // Donor lists (compressed rows), then the stack: the fixed cells, then each cell's donors after it.
  for (let c = 0; c < n; c++) donors[c + 1] += donors[c];
  const list = new Int32Array(n),
    fill = donors.slice(0, n);
  for (let c = 0; c < n; c++) if (dir[c] >= 0) list[fill[c + DZ[dir[c]] * nx + DX[dir[c]]]++] = c;
  let head = 0,
    tail = 0;
  for (let c = 0; c < n; c++) if (fixed[c]) order[tail++] = c;
  while (head < tail) {
    const c = order[head++];
    for (let k = donors[c]; k < donors[c + 1]; k++) order[tail++] = list[k];
  }
  area.fill(1);
  for (let q = n - 1; q >= 0; q--) {
    const c = order[q],
      d = dir[c];
    if (d >= 0) area[c + DZ[d] * nx + DX[d]] += area[c];
  }
}

/** The 16 neighbours of the slope limit: the 8 of D8, then the knight's moves (sqrt(5) cells), which keep cones round. */
const LX = [1, 1, 0, -1, -1, -1, 0, 1, 2, 1, -1, -2, -2, -1, 1, 2],
  LZ = [0, 1, 1, 1, 0, -1, -1, -1, 1, 2, 2, 1, -1, -2, -2, -1];
/** Run of each of the 16 moves in Q16 cells: 1, sqrt(2) and sqrt(5). */
const LRUN = [
  ONE,
  ROOT2,
  ONE,
  ROOT2,
  ONE,
  ROOT2,
  ONE,
  ROOT2,
  146543,
  146543,
  146543,
  146543,
  146543,
  146543,
  146543,
  146543,
];

/**
 * Lowers every free cell to at most a neighbour (of 16) plus its critical rise over the run (`rise` per cell side, per
 * cell), lowest first, so afterwards no free cell stands steeper than its critical angle over any of them.
 */
function limitSlopes(g: Grid, rise: Int32Array): void {
  const { nx, nz, h, fixed } = g,
    n = nx * nz;
  let heap = new Float64Array(2 * n),
    size = 0;
  const push = (c: number) => {
    if (size === heap.length) {
      const grown = new Float64Array(2 * heap.length);
      grown.set(heap);
      heap = grown;
    }
    const key = (h[c] + LIMIT) * CELLS + c;
    let k = size++;
    while (k > 0) {
      const up = (k - 1) >> 1;
      if (heap[up] <= key) break;
      heap[k] = heap[up];
      k = up;
    }
    heap[k] = key;
  };
  for (let c = 0; c < n; c++) push(c);
  while (size) {
    const top = heap[0],
      c = top % CELLS,
      last = heap[--size];
    let k = 0;
    for (let child = 1; child < size; child = 2 * k + 1) {
      if (child + 1 < size && heap[child + 1] < heap[child]) child++;
      if (heap[child] >= last) break;
      heap[k] = heap[child];
      k = child;
    }
    heap[k] = last;
    // A key left behind when the cell was lowered again.
    if ((top - c) / CELLS - LIMIT !== h[c]) continue;
    const cz = divFloor(c, nx),
      cx = c - cz * nx;
    for (let d = 0; d < 16; d++) {
      const u = cx + LX[d],
        v = cz + LZ[d];
      if (u < 0 || v < 0 || u >= nx || v >= nz) continue;
      const i = v * nx + u;
      if (fixed[i]) continue;
      const top2 = h[c] + q16(rise[i], LRUN[d]);
      if (h[i] <= top2) continue;
      h[i] = top2;
      push(i);
    }
  }
}

/** Lowers each free convex cell to the mean of its 3 x 3 block (creep rounds the crests; hollows and channels stay). */
function round(g: Grid, before: Int32Array): void {
  const { nx, nz, h, fixed } = g;
  before.set(h);
  for (let z = 0, c = 0; z < nz; z++)
    for (let x = 0; x < nx; x++, c++) {
      if (fixed[c]) continue;
      let sum = 0,
        count = 0;
      for (let dz = -1; dz <= 1; dz++)
        for (let dx = -1; dx <= 1; dx++) {
          const u = x + dx,
            v = z + dz;
          if (u < 0 || v < 0 || u >= nx || v >= nz) continue;
          sum += before[v * nx + u];
          count++;
        }
      const mean = divFloor(sum, count);
      if (mean < h[c]) h[c] = mean;
    }
}

/**
 * Builds the mountain valley of a relief with origin `(ox, oz)`, size `(sx, sz)` in mm, a floor `base` mm high at the
 * outlet edge and ridges capped softly at `relief` mm above it. Returns the valley and its height function.
 */
export function buildMountainValley(
  s: MountainValleySettings,
  seed: number,
  [ox, oz]: readonly [number, number],
  [sx, sz]: readonly [number, number],
  base: number,
  relief: number,
): { valley: MountainValley; height: (x: number, z: number) => number } {
  const vertical = s.outlet === 'north' || s.outlet === 'south',
    along = vertical ? sx : sz,
    across = vertical ? sz : sx;
  // The valley frame: u in from the outlet edge, v along that edge.
  const toFrame = (x: number, z: number): [number, number] =>
    s.outlet === 'west'
      ? [x - ox, z - oz]
      : s.outlet === 'east'
        ? [ox + sx - x, z - oz]
        : s.outlet === 'north'
          ? [z - oz, x - ox]
          : [oz + sz - z, x - ox];
  const toWorld = (u: number, v: number): [number, number] =>
    s.outlet === 'west'
      ? [ox + u, oz + v]
      : s.outlet === 'east'
        ? [ox + sx - u, oz + v]
        : s.outlet === 'north'
          ? [ox + v, oz + u]
          : [ox + v, oz + sz - u];
  const lattice = (p: number, wave: number) => divFloor(p * ONE, wave);
  // The centre line sways by up to a twelfth of the world's width (300 m at most) over 2.4 km runs.
  const sway = Math.min(300_000, Math.floor(along / 12)),
    axisAt = (u: number) =>
      clampInt(
        s.center + Math.floor(((fbm(seed + 31, lattice(u, 2_400_000), 0, 2) - 32768) * sway) / 16384),
        Math.floor(along / 8),
        along - Math.floor(along / 8),
      ),
    // Floor half width, 0.75 to 1.25 of `floor`, over 1.4 km runs.
    widthAt = (u: number) =>
      s.floor +
      Math.floor(
        (clampInt((fbm(seed + 32, lattice(u, 1_400_000), 0, 2) - 32768) * 4, -32768, 32768) * Math.floor(s.floor / 4)) /
          32768,
      ),
    floorAt = (u: number) => base + q16(u, s.fall),
    // Creek centre: on the far side of the rail (-0.6 to -0.15 of the half width), or anywhere within 0.6 without a rail.
    creekAt = (u: number) => {
      const w = widthAt(u),
        t = clampInt(32768 + (fbm(seed + 33, lattice(u, 800_000), 0, 3) - 32768) * 3, 0, ONE),
        [lo, hi] = s.railGrade ? [-39321, -9830] : [-39321, 39321];
      return q16(w, lo + q16(hi - lo, t));
    },
    railAt = (u: number) => Math.floor(widthAt(u) / 2);
  const frame = (x: number, z: number): [number, number] => {
    const [u, v] = toFrame(x, z);
    return [u, v - axisAt(u)];
  };

  // The drainage grid.
  const step = s.step,
    nx = 1 - divFloor(-sx, step),
    nz = 1 - divFloor(-sz, step),
    n = nx * nz,
    g: Grid = {
      nx,
      nz,
      h: new Int32Array(n),
      fixed: new Uint8Array(n),
      dir: new Int8Array(n),
      order: new Int32Array(n),
      area: new Int32Array(n),
      heap: new Float64Array(n),
      seen: new Uint8Array(n),
    },
    // Grid corners within 1.5 cells of the floor are floor too, so a bilinear sample anywhere on the floor reads only floor.
    margin = Math.floor((step * 3) / 2),
    ramp = 22938, // a rise of 0.35 per metre out from the floor's edge, Q16
    amp = s.gulches,
    // Rock varies: the steepness index from 0.5 to 1.5 of ks and the critical angle by up to 4 degrees either way, over
    // 1.2 km and 700 m, so neither the channels nor the walls are one plane.
    ks = new Int32Array(n),
    rise = new Int32Array(n);
  for (let j = 0, c = 0; j < nz; j++)
    for (let i = 0; i < nx; i++, c++) {
      const x = ox + i * step,
        z = oz + j * step,
        [u, dv] = frame(x, z),
        out = Math.abs(dv) - widthAt(u) - margin;
      if (out <= 0) {
        g.fixed[c] = 1;
        g.h[c] = floorAt(u);
      } else {
        // The starting surface: a ramp up from the floor over a distance warped by noise at the gulch spacing, so the
        // water running down it gathers into side gulches.
        const warp = Math.floor(
          ((fbm(seed + 34, lattice(x, s.gulches), lattice(z, s.gulches), 4) - 32768) * amp) / 32768,
        );
        g.h[c] = floorAt(u) + 1 + Math.max(0, q16(out + warp, ramp));
      }
    }
  // Each cell's steepness and critical rise per cell side: tan of its wall angle (a binary angle for CORDIC), Q16.
  const turn = 4294967296 / 360_000,
    cs = [0, 0];
  for (let j = 0, c = 0; j < nz; j++)
    for (let i = 0; i < nx; i++, c++) {
      const x = ox + i * step,
        z = oz + j * step,
        a = clampInt((fbm(seed + 36, lattice(x, 1_200_000), lattice(z, 1_200_000), 3) - 32768) * 4, -32768, 32768),
        b = clampInt((fbm(seed + 37, lattice(x, 700_000), lattice(z, 700_000), 3) - 32768) * 4, -32768, 32768);
      ks[c] = s.steepness + Math.floor((s.steepness * a) / 65536);
      sincos(Math.round((s.wall + Math.floor((4000 * b) / 32768)) * turn), cs);
      rise[c] = q16(step, divFloor(cs[1] * ONE, cs[0]));
    }
  const passes = s.ridges === 'rounded' ? clampInt(divFloor(80_000, step), 1, 8) : 0,
    before = new Int32Array(n);
  // The drainage network of the starting surface, then steady-state stream power on it, base level first: a channel
  // cell stands ks / sqrt(A) per mm (A in m2) above the cell it drains to. Where that is steeper than the critical
  // slope the water no longer cuts a channel: the cell (and every cell above it) is hillslope, left for the slope limit,
  // which raises the threshold walls from the channels and the floor.
  route(g, seed);
  const slope = g.seen;
  slope.fill(0);
  for (let q = 0; q < n; q++) {
    const c = g.order[q],
      d = g.dir[c];
    if (d < 0 || g.fixed[c]) continue;
    const p = c + DZ[d] * nx + DX[d],
      climb = q16(step, divFloor(ks[c] * ONE, isqrt(g.area[c]) * step));
    if (slope[p] || climb >= rise[c]) {
      slope[c] = 1;
      g.h[c] = LIMIT - 1;
    } else g.h[c] = g.h[p] + (d & 1 ? q16(climb, ROOT2) : climb);
  }
  // Where the wall detail goes: hillslope cells (Q16 weight 1), not the channels or the floor, whose gentle beds it would dam.
  const hill = new Int32Array(n);
  for (let c = 0; c < n; c++) hill[c] = slope[c] ? ONE : 0;
  limitSlopes(g, rise);
  for (let p = 0; p < passes; p++) round(g, before);
  if (passes) limitSlopes(g, rise);
  // Ridges capped softly at `relief` above the outlet: heights above the knee are squeezed toward the cap, never over it.
  const knee = Math.floor(relief / 4),
    from = base + relief - knee;
  if (knee > 0)
    for (let c = 0; c < n; c++) {
      const e = g.h[c] - from;
      if (e > 0 && !g.fixed[c]) g.h[c] = from + divFloor(e * knee, e + knee);
    }
  // Every free cell stands at least 1 mm over the cell it drains to, so the grid has no closed basin; and where a cell
  // drains diagonally, the two cells beside that step are lowered until the middle of the square (the mean of its four
  // corners, where a bilinear sample crosses it) is no higher than the cell, so the interpolated ground has no dam
  // there either. Lowering moves water, so this repeats until nothing is lowered (a few times at most).
  for (let pass = 0; pass < 8; pass++) {
    route(g, seed);
    let lowered = 0;
    for (let q = 0; q < n; q++) {
      const c = g.order[q],
        d = g.dir[c];
      if (d < 0 || g.fixed[c]) continue;
      const p = c + DZ[d] * nx + DX[d];
      g.h[c] = Math.max(g.h[c], g.h[p] + 1);
      if (!(d & 1)) continue;
      const a = c + DX[d],
        b = c + DZ[d] * nx,
        top = divFloor(3 * g.h[c] - g.h[p], 2);
      for (const s of [a, b])
        if (g.h[s] > top && !g.fixed[s]) {
          g.h[s] = top;
          lowered++;
        }
    }
    if (!lowered) break;
  }
  route(g, seed);

  const half = Math.floor(s.creekWidth / 2),
    bank = 2 * s.creekDepth,
    height = (x: number, z: number): number => {
      const [u, dv] = frame(x, z),
        w = widthAt(u),
        f = floorAt(u),
        out = Math.abs(dv) - w;
      let h: number;
      if (out <= 0) h = f;
      else {
        h = bilinear(g.h, nx, nz, divFloor((x - ox) * ONE, step), divFloor((z - oz) * ONE, step));
        // Rock and soil detail of +-1.5 m on the walls, faded in over two cells from the floor's grid edge and out
        // toward the channels.
        const fx = divFloor((x - ox) * ONE, step),
          fz = divFloor((z - oz) * ONE, step),
          t = q16(
            smooth(clampInt(divFloor((out - margin) * ONE, 2 * step), 0, ONE)),
            clampInt(bilinear(hill, nx, nz, fx, fz), 0, ONE),
          );
        if (t > 0)
          h += Math.floor(
            (Math.floor(((fbm(seed + 35, lattice(x, 48_000), lattice(z, 48_000), 3) - 32768) * 1500) / 32768) * t) /
              ONE,
          );
        return h;
      }
      // The creek: a level bed `half` wide with banks of 1 in 2 up to the floor.
      const dc = Math.abs(dv - creekAt(u));
      if (dc < half + bank) {
        const t = dc <= half ? 0 : smooth(divFloor((dc - half) * ONE, bank));
        h = f - s.creekDepth + Math.floor((s.creekDepth * t) / ONE);
      }
      return h;
    };

  // Lines from the outlet upstream, one point per grid step of u, inside the world.
  const line = (offset: (u: number) => number) => {
    const out: number[] = [];
    for (let u = 0; u <= across; u += step) {
      const [x, z] = toWorld(u, axisAt(u) + offset(u));
      out.push(x, z);
    }
    return Int32Array.from(out);
  };
  const valley: MountainValley = Object.freeze({
    axis: line(() => 0),
    creek: line(creekAt),
    rail: s.railGrade ? line(railAt) : null,
    frame,
    floorHeight: floorAt,
    floorWidth: widthAt,
    grid: Object.freeze({ height: g.h, flow: g.area, direction: g.dir, nx, nz, step }),
  });
  return { valley, height };
}

mountainValleyHook.settings = mountainValleySettings;
mountainValleyHook.build = buildMountainValley;
