// A seeded procedural landscape in integer millimetres (entry `@margoengine/biomes/relief`, loaded by BiomeWorld.create
// only when a world uses it): fractal lowlands, ridged mountains under a mountain mask, an
// optional coast or islands and river valleys. It is the default height of a BiomeWorld and the terrain of the reference world
// R16. Every step works on integers below 2^53 with plain arithmetic, floors and integer square roots (value and simplex noise
// from hash.ts), which every JavaScript engine computes identically, so the same options give the same heights everywhere. Our own layout; the noise is cited in hash.ts.
import { fault, rangeError, typeError } from '../../shared/errors.js';
import type { Erosion, ReliefErosionOptions } from './erosion.js';
import { erosionHook } from './erosion-hook.js';
import { clampInt, divFloor, divWide, imod, isqrt, ONE, sincos } from './fixed.js';
import { fbm, hash3, ridged } from './hash.js';
import type { MountainValley, MountainValleyOptions, MountainValleySettings } from './valley.js';
import { mountainValleyHook } from './valley-hook.js';

export type { MountainValley, MountainValleyOptions, MountainValleySettings } from './valley.js';

/** River valley shape of {@link ReliefOptions}. Lengths in metres. */
export interface ValleyOptions {
  /** Half width of a valley in metres, 1..4,000. Default 250 (islands: a sixth of the radius when that is less). */
  readonly width?: number;
  /** Half width of the flat floor at the bed in metres, 0 up to below `width` and `mouth`. Default 0 (a V of smoothsteps). */
  readonly floor?: number;
  /** Half width at the mouth in metres, 1..4,000: the valley widens (or narrows) toward it over its last kilometre. Default `width`. */
  readonly mouth?: number;
}

/** Islands of a relief with `coast: 'island'`. Lengths in metres. */
export interface IslandOptions {
  /** Number of islands, 1..8. Default 1. */
  readonly count?: number;
  /**
   * Radius of each island's outer shelf edge (on its long axis) in metres, 100 m up to 0.39 of the world's shorter side.
   * Default a third of the shorter side (divided by 2 for 2 to 4 islands, by 3 for 5 to 8).
   */
  readonly radius?: number;
  /** Width of the shelf from the sea floor up to the beach in metres, 1 up to the radius. Default `shelf`, else 0.3 of the radius. */
  readonly shelf?: number;
}

/** Settings of {@link createRelief}. Lengths in metres; every option is quantised once to millimetres. */
export interface ReliefOptions {
  /** u32 seed. Default 1. */
  readonly seed?: number;
  /** World XZ of the minimum corner in metres. Default: centred on the origin, `-size / 2`. */
  readonly origin?: readonly [number, number];
  /** World extent [x, z] in metres, each 64..65,536. Default [4096, 4096]. */
  readonly size?: readonly [number, number];
  /** Mean lowland height in metres. Default 120. */
  readonly base?: number;
  /** Height of the highest ridges above the lowland in metres, 0..8,000. Default 350. */
  readonly relief?: number;
  /**
   * Side of the world that runs down into the sea, `'island'` for islands with sea on every side (see `islands`), or
   * `'none'`. Default `'none'`.
   */
  readonly coast?: 'none' | 'west' | 'east' | 'north' | 'south' | 'island';
  /** River valleys running across the world toward the coast (or west to east without one; radial on islands), 0..8. Default 0. */
  readonly rivers?: number;
  /** Sea floor depth below sea level (0 m) off the coast in metres. Default 40. */
  readonly seaDepth?: number;
  /** Width of a straight coast's shelf from the sea floor up to the land in metres, 1..16,000. Default 1500. */
  readonly shelf?: number;
  /** River valley shape. Default `{ width: 250, floor: 0, mouth: width }`. */
  readonly valley?: ValleyOptions;
  /**
   * A drowned valley (a Sanriku style ria bay) cut into a straight coast, with steep hills round it and a little level
   * ground at its head (see {@link RiaOptions}). Needs `coast` west, east, north or south. Default: none, and then the
   * heights are exactly what they were.
   */
  readonly ria?: RiaOptions;
  /** Islands, with `coast: 'island'` only. Default `{ count: 1 }`. */
  readonly islands?: IslandOptions;
  /**
   * A northern Rockies mountain valley in place of the open landscape (see {@link MountainValleyOptions}): a main valley
   * with a level floor falling to an outlet on one edge, a creek and a rail grade on the floor, and steep walls cut into
   * side gulches and ridges by stream-power drainage. `base` is the floor's height at the outlet and `relief` caps the
   * ridges above it. The `@margoengine/biomes/valley` entry must be loaded first (`BiomeWorld.create` loads
   * it for a relief with this option). Needs `coast: 'none'`, no `ria`, `islands` or `erosion` (the valley's own drainage cuts it) and no
   * `rivers` (the creek is the relief's river).
   * Default: none, and then the heights are exactly what they were.
   */
  readonly mountainValley?: MountainValleyOptions;
  /**
   * Thermal and hydraulic erosion of the landscape on a grid over the world (`erodeRelief` of
   * `@margoengine/biomes/erosion`, which must be loaded first; `BiomeWorld.create` loads it for a relief height with this
   * option). Default: none.
   */
  readonly erosion?: ReliefErosionOptions;
}

/**
 * A ria: a drowned river valley cut into a straight coast, the shape of a Sanriku fishing bay (`ReliefOptions.ria`).
 * Lengths in metres. The bay runs inland from the coast edge along an axis that sways a little, narrowing from `width` at
 * the mouth to `headWidth` at its head, shallowing from `depth` to the waterline; steep hills rise from the water on
 * both sides and a small river runs on from the head. Ground within `flat` of the head is levelled to `flatHeight`, the
 * only room for a town. The rest of the coast is steep from the waterline too (no beach, no shelf).
 */
export interface RiaOptions {
  /** Where the axis meets the coast, 0.1..0.9 of the way along it. Default 0.5. */
  readonly center?: number;
  /** Half width of the bay at the mouth, 20..2,000. Default 500. */
  readonly width?: number;
  /** Half width of the bay at its head, 5 up to `width`. Default 140. */
  readonly headWidth?: number;
  /** Length of the bay inland from the coast edge, 200..8,000. Default 2,800. */
  readonly length?: number;
  /** Depth of the water at the mouth, 0..200. Default 25. */
  readonly depth?: number;
  /**
   * Depth of the water at the head, 0 up to `depth`: the floor falls from it to `depth` along the bay, so a harbour at
   * the head has water to moor in (Sanriku bays hold 5 to 10 m at their inner harbours). Default 0: the floor shallows to
   * the waterline at the head.
   */
  readonly headDepth?: number;
  /** Rise of the ground per metre from the waterline, 0.1..1.5. Default 0.55. */
  readonly slope?: number;
  /** Radius of the level ground at the head of the bay, 0..1,500. Default 420. */
  readonly flat?: number;
  /** Height of that ground above the sea, 0..30. Default 4.5. */
  readonly flatHeight?: number;
  /** Distance over which the hills climb to full relief, 100..8,000. Default 350. */
  readonly run?: number;
  /** Whether a river runs 4 km inland from the head along the axis (the `valley` option shapes it). Default true. */
  readonly river?: boolean;
}

/** A river centre line in millimetres, `[x0, z0, x1, z1, ...]`, from its mouth upstream. */
export type RiverLine = Int32Array;

/** One island of a relief with `coast: 'island'`, in millimetres. */
export interface ReliefIsland {
  /** World x of the centre (its peak) in mm. */
  readonly x: number;
  /** World z of the centre in mm. */
  readonly z: number;
  /** Radius of the outer shelf edge on the long axis in mm. */
  readonly radius: number;
}

/** A procedural landscape: integer heights and the centre lines of its rivers. */
export interface Relief {
  /** Height in millimetres at world `(x, z)` given in millimetres (integers). */
  height(x: number, z: number): number;
  /** River centre lines in millimetres, mouth first. */
  readonly rivers: readonly RiverLine[];
  /** River valley half width in millimetres. */
  readonly valleyWidth: number;
  /** The islands of a `coast: 'island'` relief (empty for every other coast). */
  readonly islands: readonly ReliefIsland[];
  /** The erosion grid of a relief made with the `erosion` option (height, flow, wear, deposit), else undefined. */
  readonly erosion?: Erosion;
  /** The valley of a relief made with the `mountainValley` option (lines, frame, floor and drainage grid), else undefined. */
  readonly mountainValley?: MountainValley;
  /**
   * The cells of a grid (`nx` x `nz` corner samples `step` mm apart from world `origin` in mm) along the river centre
   * lines, within half a cell: 1 for water, 0 elsewhere. Worlds take them as water sources.
   */
  waterCells(origin: readonly [number, number], step: number, nx: number, nz: number): Uint8Array;
  /** The options, with defaults filled in and every length in millimetres. */
  readonly settings: Readonly<{
    seed: number;
    origin: readonly [number, number];
    size: readonly [number, number];
    base: number;
    relief: number;
    coast: NonNullable<ReliefOptions['coast']>;
    seaDepth: number;
    /** Shelf width in mm (the islands' shelf on `coast: 'island'`). */
    shelf: number;
    valley: Readonly<{ width: number; floor: number; mouth: number }>;
    /** Island settings in mm, or null for every other coast. */
    islands: Readonly<{ count: number; radius: number; shelf: number }> | null;
    /** The ria with defaults filled in and lengths in mm; absent without the option. */
    ria?: Readonly<Record<keyof Required<RiaOptions>, number>>;
    /** The mountain valley with defaults filled in, lengths in mm and rates in Q16; absent without the option. */
    mountainValley?: Readonly<MountainValleySettings>;
  }>;
}

const mm = (m: number) => Math.round(m * 1000);
const COASTS = ['none', 'west', 'east', 'north', 'south', 'island'];
// Default coast shelf width and river valley half width in mm.
const SHELF = 1_500_000,
  VALLEY = 250_000;
// A valley's width moves from `mouth` to `width` over this distance from the mouth, mm.
const MOUTH_RUN = 1_000_000;
// Ria: the quantised options and the shaping constants. Lengths in mm, the slope a Q16 rise per unit run.
interface Ria {
  axis: number;
  mouth: number;
  head: number;
  length: number;
  depth: number;
  headDepth: number;
  slope: number;
  flat: number;
  flatHeight: number;
  run: number;
  river: boolean;
  /** Largest sway of the axis (mm) and the lowland noise amplitude of the hills' foot. */
  sway: number;
}
const RIA_LOW = 12_000,
  RIA_RIVER = 4_000_000;
function riaOf(o: RiaOptions, coast: string, along: number): Ria {
  const bad = () =>
    rangeError(
      'Invalid relief ria; use it with coast west, east, north or south, center 0.1..0.9, width 20..2,000 m, headWidth 5 m up to width, length 200..8,000 m, depth 0..200 m, headDepth 0..depth, slope 0.1..1.5, flat 0..1,500 m, flatHeight 0..30 m and run 100..8,000 m',
      'biomes',
    );
  if (typeof o !== 'object' || o === null) throw bad();
  const { center = 0.5, width = 500, headWidth = 140, length = 2800, depth = 25, slope = 0.55, flat = 420 } = o,
    { flatHeight = 4.5, run = 350, river = true, headDepth = 0 } = o;
  if (
    !['west', 'east', 'north', 'south'].includes(coast) ||
    !(center >= 0.1 && center <= 0.9) ||
    !(width >= 20 && width <= 2000) ||
    !(headWidth >= 5 && headWidth <= width) ||
    !(length >= 200 && length <= 8000) ||
    !(depth >= 0 && depth <= 200) ||
    !(headDepth >= 0 && headDepth <= depth) ||
    !(slope >= 0.1 && slope <= 1.5) ||
    !(flat >= 0 && flat <= 1500) ||
    !(flatHeight >= 0 && flatHeight <= 30) ||
    !(run >= 100 && run <= 8000) ||
    typeof river !== 'boolean'
  )
    throw bad();
  return {
    axis: Math.floor(along * center),
    mouth: mm(width),
    head: mm(headWidth),
    length: mm(length),
    depth: mm(depth),
    headDepth: mm(headDepth),
    slope: Math.round(slope * ONE),
    flat: mm(flat),
    flatHeight: mm(flatHeight),
    run: mm(run),
    river,
    sway: Math.min(150_000, Math.floor(mm(width) / 3)),
  };
}
// Island beach: the shelf rises to BEACH_LOW, the beach ring climbs to BEACH_TOP over 60 to 120 m (mm).
const BEACH_LOW = 1000,
  BEACH_TOP = 4000;
// Default island radius divisor by count: one island a third of the shorter side, 2 to 4 a sixth, 5 to 8 a ninth.
const ROOT = [1, 1, 2, 2, 2, 3, 3, 3, 3];

/** Smoothstep `3t^2 - 2t^3` of a Q16 t in 0..1. */
const smooth = (t: number) => Math.floor((t * t * (3 * ONE - 2 * t)) / 4294967296);

/** An island's frame: centre, rotation, stretch and sizes, mm and Q16. */
interface Isle {
  x: number;
  z: number;
  cos: number;
  sin: number;
  /** Stretch of the short axis, Q16 1.15..1.45: the outline is an ellipse before the warp. */
  k: number;
  /** Half side of the box outside which the island is surely sea floor. */
  box: number;
  seed: number;
}

/**
 * Builds a seeded procedural landscape. Lowlands are 7 octaves of value noise at 2 km, mountains 6 octaves of ridged
 * simplex noise at 1.5 km under a mask at 6 km or half the longest side (whichever is shorter), the coast a noise-warped 1.5 km
 * shelf down to `seaDepth`, and each river a meandering polyline whose valley (250 m half width) is carved down to a bed
 * that rises from 2 m at the mouth. `coast: 'island'` instead raises islands from a sea floor on every side: each an
 * ellipse warped by noise into bays and headlands, a shelf up to a 1 to 4 m beach ring, then land with a peak and ridge
 * spurs (ridged noise at a third of the radius) and rivers running out from the peak.
 * @throws TypeError when `options` is not an object; RangeError when a value is out of range.
 * @example
 * const relief = createRelief({ seed: 7, coast: 'west', rivers: 1 });
 * const metres = relief.height(0, 0) / 1000;
 * const island = createRelief({ coast: 'island', relief: 330, base: 40 });
 * const peak = island.height(island.islands[0].x, island.islands[0].z) / 1000;
 */
export function createRelief(options: ReliefOptions = {}): Relief {
  if (typeof options !== 'object' || options === null)
    throw typeError('Relief options must be an object; pass {} for the defaults', 'biomes');
  const seed = (options.seed ?? 1) >>> 0,
    size = options.size ?? [4096, 4096],
    origin = options.origin ?? [-size[0] / 2, -size[1] / 2],
    base = options.base ?? 120,
    relief = options.relief ?? 900,
    coast = options.coast ?? 'none',
    count = options.rivers ?? 0,
    seaDepth = options.seaDepth ?? 40;
  if (
    !Array.isArray(size) ||
    !Array.isArray(origin) ||
    size.length !== 2 ||
    origin.length !== 2 ||
    !size.every((v) => v >= 64 && v <= 65536) ||
    !origin.every((v) => Number.isFinite(v) && Math.abs(v) <= 1e6) ||
    !(Math.abs(base) <= 8000) ||
    !(relief >= 0 && relief <= 8000) ||
    !(seaDepth >= 0 && seaDepth <= 8000) ||
    !COASTS.includes(coast) ||
    !Number.isInteger(count) ||
    count < 0 ||
    count > 8
  )
    throw rangeError(
      'Invalid relief options; size 64..65,536 m, origin within 1,000 km, base within 8 km, relief and seaDepth 0..8,000 m, coast none/west/east/north/south/island and 0..8 rivers',
      'biomes',
    );
  const ox = mm(origin[0]),
    oz = mm(origin[1]),
    sx = mm(size[0]),
    sz = mm(size[1]),
    baseMm = mm(base),
    reliefMm = mm(relief),
    sea = mm(seaDepth);
  const isle = coast === 'island',
    io = options.islands;
  // Islands: count, radius (outer shelf edge on the long axis) and shelf, mm.
  let islandCount = 0,
    radius = 0;
  if (io !== undefined || isle) {
    const shorter = Math.min(sx, sz);
    islandCount = io?.count ?? 1;
    radius = io?.radius === undefined ? divFloor(shorter, 3 * (ROOT[islandCount] ?? 1)) : mm(io.radius);
    if (
      !isle ||
      (io !== undefined && (typeof io !== 'object' || io === null)) ||
      !Number.isInteger(islandCount) ||
      islandCount < 1 ||
      islandCount > 8 ||
      !(radius >= 100_000) ||
      // The island and its warp stay inside the world, so every border sample is the sea floor.
      radius * 41 > shorter * 16
    )
      throw rangeError(
        "Invalid relief islands; use them with coast: 'island', count 1..8 and a radius from 100 m to 0.39 of the shorter side",
        'biomes',
      );
  }
  const vo = options.valley ?? {},
    widthM = vo.width ?? (isle ? Math.min(250, Math.floor(radius / 6) / 1000) : 250),
    shelf = mm(isle ? (io?.shelf ?? options.shelf ?? radius * 0.0003) : (options.shelf ?? 1500)),
    width = mm(widthM),
    mouth = mm(vo.mouth ?? widthM),
    vFloor = mm(vo.floor ?? 0);
  if (
    typeof vo !== 'object' ||
    vo === null ||
    !(shelf >= 1000 && shelf <= (isle ? radius : 16_000_000)) ||
    !(width >= 1000 && width <= 4_000_000) ||
    !(mouth >= 1000 && mouth <= 4_000_000) ||
    !(vFloor >= 0 && vFloor < width && vFloor < mouth)
  )
    throw rangeError(
      'Invalid relief shelf or valley; shelf 1..16,000 m (on islands up to the radius), valley width and mouth 1..4,000 m and a floor from 0 up to below both',
      'biomes',
    );
  if (options.mountainValley !== undefined) {
    const { settings: check, build } = mountainValleyHook;
    if (!check || !build)
      throw fault(
        'state',
        "A relief with mountainValley needs the valley entry; await import('@margoengine/biomes/valley') first (BiomeWorld.create loads it)",
        'biomes',
      );
    const alone =
        coast === 'none' &&
        options.ria === undefined &&
        io === undefined &&
        count === 0 &&
        options.erosion === undefined,
      ms = check(options.mountainValley, [sx, sz], alone),
      { valley, height } = build(ms, seed, [ox, oz], [sx, sz], baseMm, reliefMm),
      rivers = [valley.creek];
    return {
      height,
      rivers,
      valleyWidth: Math.floor(ms.creekWidth / 2),
      islands: Object.freeze([]),
      mountainValley: valley,
      waterCells: (at, step, nx, nz) => riverCells(rivers, at, step, nx, nz),
      settings: Object.freeze({
        seed,
        origin: [ox, oz] as const,
        size: [sx, sz] as const,
        base: baseMm,
        relief: reliefMm,
        coast,
        seaDepth: sea,
        shelf,
        valley: Object.freeze({ width, floor: vFloor, mouth }),
        islands: null,
        mountainValley: Object.freeze(ms),
      }),
    };
  }
  // Coast frame: distance inland from the coast edge (u) and position along it (v), both in mm.
  const frame = (x: number, z: number): [number, number] =>
    coast === 'west'
      ? [x - ox, z - oz]
      : coast === 'east'
        ? [ox + sx - x, z - oz]
        : coast === 'north'
          ? [z - oz, x - ox]
          : [oz + sz - z, x - ox];
  const along = coast === 'north' || coast === 'south' ? sx : sz,
    across = coast === 'north' || coast === 'south' ? sz : sx;
  // Island frames: a centre from the seed inside the world, a rotation and a stretch. The warp moves the outline by up
  // to a quarter of the radius (the straight coast's 600 m warp on a 1.5 km shelf, scaled), `box` adds a margin for
  // the 64 mm rounding of the distance, so every sample outside it is the sea floor.
  const warpAmp = Math.floor(radius / 4),
    box = radius + warpAmp + Math.floor(radius / 32),
    isles: Isle[] = [];
  for (let i = 0; i < islandCount; i++) {
    const cs = sincos(hash3(seed, 101, i) | 0, [0, 0]);
    isles.push({
      x: ox + box + Math.floor(((sx - 2 * box) * (hash3(seed, 102, i) >>> 16)) / 65536),
      z: oz + box + Math.floor(((sz - 2 * box) * (hash3(seed, 103, i) >>> 16)) / 65536),
      cos: cs[0],
      sin: cs[1],
      k: 75366 + Math.floor(((hash3(seed, 104, i) >>> 16) * 19661) / 65536),
      box,
      seed: (seed + 17 * i) | 0,
    });
  }
  // How far a straight coast's shelf edge moves inland at position v along it, mm: the outline warp, 600 m at most.
  const coastWarp = (v: number) =>
    Math.floor(((fbm(seed + 3, divFloor(v * ONE, 3_000_000), 0, 3) - 32768) * 600_000) / 32768);
  // Ria: its axis sways by up to `sway` over 1.2 km runs, a function of the distance inland uu from the coast line.
  const ria = options.ria === undefined ? null : riaOf(options.ria, coast, along),
    riaAxis = (uu: number) =>
      ria!.axis +
      Math.floor(((fbm(seed + 9, divFloor(Math.max(uu, 0) * ONE, 1_200_000), 0, 2) - 32768) * ria!.sway) / 32768);
  // Rivers: 8 segments inland from the mouth, meandering by hashed offsets. On a straight coast the mouth is on the
  // shelf's outer edge (the sea floor), so the valley is carved across the whole shelf down to the sea: a mouth inland
  // of the warped shore left the shelf's land between it and the sea as a ridge, closing the river in a basin. Without
  // a coast it is a third of the shelf in from the low-x edge. On islands each runs from the sea beyond the coast in to
  // an eighth of the radius from the peak, in a hashed direction.
  const rivers: Int32Array[] = [];
  for (let r = 0; r < count; r++) {
    const line = new Int32Array(18);
    if (isle) {
      const c = isles[imod(r, islandCount)],
        cs = sincos(hash3(seed, 211, r) | 0, [0, 0]),
        outer = radius + warpAmp,
        head = Math.floor(radius / 8),
        seg = Math.floor((outer - head) / 8);
      let side = 0;
      for (let k = 0; k <= 8; k++) {
        const dist = outer - seg * k;
        if (k) side += Math.floor((((hash3(seed, r, k) >>> 16) - 32768) * Math.floor(seg / 3)) / 32768);
        side = clampInt(side, -Math.floor(dist / 4), Math.floor(dist / 4));
        line[2 * k] = c.x + Math.floor((dist * cs[0] - side * cs[1]) / ONE);
        line[2 * k + 1] = c.z + Math.floor((dist * cs[1] + side * cs[0]) / ONE);
      }
      rivers.push(line);
      continue;
    }
    let v = divFloor(along * (2 * r + 1), 2 * count);
    for (let k = 0; k <= 8; k++) {
      if (k) v += Math.floor(((hash3(seed, r, k) >>> 16) - 32768) * Math.floor(along / 14 / 32768));
      v = clampInt(v, Math.floor(along / 16), along - Math.floor(along / 16));
      const next = Math.floor(across / 9),
        u =
          k > 0
            ? Math.floor((across * k) / 9)
            : coast === 'none'
              ? Math.floor(shelf / 3)
              : clampInt(coastWarp(v), 0, next);
      // Back to world coordinates.
      const [x, z] =
        coast === 'east'
          ? [ox + sx - u, oz + v]
          : coast === 'north'
            ? [ox + v, oz + u]
            : coast === 'south'
              ? [ox + v, oz + sz - u]
              : [ox + u, oz + v];
      line[2 * k] = x;
      line[2 * k + 1] = z;
    }
    rivers.push(line);
  }
  if (ria?.river) {
    // The ria's river: from the bay head inland along the axis, in 8 segments of half a kilometre.
    const line = new Int32Array(18);
    for (let k = 0; k <= 8; k++) {
      const uu = ria.length + Math.floor((RIA_RIVER * k) / 8),
        v = riaAxis(uu),
        u = uu + coastWarp(v);
      const [x, z] =
        coast === 'east'
          ? [ox + sx - u, oz + v]
          : coast === 'north'
            ? [ox + v, oz + u]
            : coast === 'south'
              ? [ox + v, oz + sz - u]
              : [ox + u, oz + v];
      line[2 * k] = x;
      line[2 * k + 1] = z;
    }
    rivers.push(line);
  }
  // Distance from the mouth to the start of each segment (first 9 values) and segment lengths (last 8) in mm, for the
  // mouth's widening.
  const runs = rivers.map((line) => {
    const out = new Float64Array(17);
    for (let k = 0; k < 8; k++) {
      const dx = (line[2 * k + 2] >> 6) - (line[2 * k] >> 6),
        dz = (line[2 * k + 3] >> 6) - (line[2 * k + 1] >> 6);
      out[9 + k] = isqrt(dx * dx + dz * dz) * 64;
      out[k + 1] = out[k] + out[9 + k];
    }
    return out;
  });
  // Lattice coordinates: Q16 cells of `wavelength` mm.
  const lattice = (p: number, wavelength: number) => divFloor(p * ONE, wavelength);
  // Mountain mask wavelength: 6 km, or half the longest side when that is shorter, so a small world sees several mask
  // values instead of about one (a 4 km world at 6 km got 0 to 25 percent of `relief` on most seeds). Worlds of 12 km
  // and more, R16 included, keep 6 km and their exact heights.
  const maskWave = Math.min(6_000_000, Math.floor(Math.max(sx, sz) / 2));
  // Island wavelengths: ridges at a third of the radius (a 2 km island holds several spurs), lowland swells at the
  // radius, the outline warp and the beach width at half of it; the centre's forced peak reaches out to 0.6 of it.
  const ridgeWave = Math.floor(radius / 3),
    halfWave = Math.floor(radius / 2),
    peakReach = Math.floor((radius * 3) / 5),
    lowAmp = Math.floor(radius / 24),
    ramp = Math.floor(radius / 4);
  const islandHeight = (x: number, z: number, m: number): number => {
    let h = -sea;
    for (const c of isles) {
      const du = x - c.x,
        dz = z - c.z;
      if (du >= c.box || du <= -c.box || dz >= c.box || dz <= -c.box) continue;
      // Elliptical radial distance in the island's rotated frame, in 64 mm units.
      const a = Math.floor((du * c.cos + dz * c.sin) / ONE) >> 6,
        b = Math.floor((Math.floor((dz * c.cos - du * c.sin) / ONE) * c.k) / ONE) >> 6,
        e = isqrt(a * a + b * b) * 64,
        warp = Math.floor(
          ((fbm(c.seed + 3, lattice(du, halfWave), lattice(dz, halfWave), 3) - 32768) * warpAmp) / 32768,
        ),
        // Inland distance from the shelf's outer edge.
        d = radius - e + warp;
      if (d <= 0) continue;
      let hi: number;
      if (d < shelf) hi = -sea + Math.floor(((BEACH_LOW + sea) * smooth(divFloor(d * ONE, shelf))) / ONE);
      else {
        const beach =
          60_000 + Math.floor((fbm(c.seed + 5, lattice(du, halfWave), lattice(dz, halfWave), 2) * 60_000) / 65536);
        if (d < shelf + beach) hi = BEACH_LOW + divFloor((BEACH_TOP - BEACH_LOW) * (d - shelf), beach);
        else {
          // The peak: the mountain mask forced on and the ridge noise lifted to its crest toward the centre.
          const peak = smooth(clampInt(ONE - divFloor(e * ONE, peakReach), 0, ONE)),
            ridge = ridged(c.seed + 2, lattice(du, ridgeWave), lattice(dz, ridgeWave), 6),
            lifted = ridge + Math.floor(((ONE - ridge) * Math.floor((peak * peak) / ONE)) / ONE),
            land = Math.max(
              BEACH_TOP,
              baseMm +
                Math.floor(((fbm(c.seed, lattice(du, radius), lattice(dz, radius), 4) - 32768) * lowAmp) / 32768) +
                Math.floor((Math.floor((lifted * Math.max(m, peak)) / ONE) * reliefMm) / ONE),
            ),
            t = clampInt(divFloor((d - shelf - beach) * ONE, ramp), 0, ONE);
          hi = BEACH_TOP + Math.floor(((land - BEACH_TOP) * smooth(t)) / ONE);
        }
      }
      if (hi > h) h = hi;
    }
    return h;
  };
  // The ground of a ria at `uu` mm inland of the coast line and `v` along it: water (a U section in the bay, a sloping
  // floor in the sea), else the lower of the hills (a low land plus ridges that climb with the distance from the water)
  // and the waterline's rise, levelled near the bay head.
  const riaHeight = (r: Ria, uu: number, v: number, x: number, z: number): number => {
    const dv = Math.abs(v - riaAxis(uu)),
      w =
        uu <= 0
          ? r.mouth
          : uu >= r.length
            ? r.head
            : r.mouth + Math.floor(((r.head - r.mouth) * smooth(divFloor(uu * ONE, r.length))) / ONE),
      bayFloor = (): number => {
        const lengthwise = uu <= 0 ? ONE : ONE - smooth(divFloor(uu * ONE, r.length));
        // From `headDepth` at the head to `depth` at the mouth (0 at the head without it, the bytes of before).
        const floor = r.headDepth + Math.floor(((r.depth - r.headDepth) * lengthwise) / ONE);
        return -Math.floor((floor * (ONE - smooth(clampInt(divFloor(dv * ONE, w), 0, ONE)))) / ONE);
      };
    if (uu <= 0) return Math.min(Math.max(-sea, Math.floor((uu * 3) / 10)), dv < w ? bayFloor() : 0);
    // Distance to the nearest water: the sea over the coast line, the bay's side, or past its head the head's rim.
    let dBay: number;
    if (uu <= r.length) dBay = dv - w;
    else {
      const a = (uu - r.length) >> 6,
        b = dv >> 6;
      dBay = isqrt(a * a + b * b) * 64 - r.head;
    }
    if (dBay < 0 && uu <= r.length) return bayFloor();
    const dist = Math.max(0, Math.min(uu, dBay)),
      lowland = fbm(seed, lattice(x, 2_048_000), lattice(z, 2_048_000), 7),
      ridge = ridged(seed + 2, lattice(x, 1_500_000), lattice(z, 1_500_000), 6),
      climb = smooth(clampInt(divFloor(dist * ONE, r.run), 0, ONE)),
      land =
        baseMm +
        Math.floor(((lowland - 32768) * RIA_LOW) / 32768) +
        Math.floor((Math.floor((ridge * climb) / ONE) * reliefMm) / ONE),
      cap = Math.floor((dist * r.slope) / ONE);
    let h = Math.min(Math.max(land, 500), cap);
    if (r.flat > 0 && r.flatHeight > 0) {
      // Level ground round a point just inland of the bay head, up to the waterline's rise.
      const a = (uu - r.length - Math.floor(r.flat / 2)) >> 6,
        b = dv >> 6,
        t = smooth(clampInt(Math.floor(((ONE - divFloor(isqrt(a * a + b * b) * 64 * ONE, r.flat)) * 5) / 2), 0, ONE)),
        target = Math.min(r.flatHeight, cap);
      h += Math.floor(((target - h) * t) / ONE);
    }
    return h;
  };
  const height = (x: number, z: number): number => {
    let h: number;
    if (isle) {
      const mask = fbm(seed + 1, lattice(x - ox, maskWave), lattice(z - oz, maskWave), 3);
      h = islandHeight(x, z, smooth(clampInt(Math.floor(((mask - 29491) * ONE) / 16384), 0, ONE)));
    } else {
      const lowland = fbm(seed, lattice(x, 2_048_000), lattice(z, 2_048_000), 7),
        mask = fbm(seed + 1, lattice(x, maskWave), lattice(z, maskWave), 3),
        // Mountains where the mask passes 0.45, full height from 0.7, eased at both ends so the foot of a range has no crease.
        m = smooth(clampInt(Math.floor(((mask - 29491) * ONE) / 16384), 0, ONE)),
        ridge = ridged(seed + 2, lattice(x, 1_500_000), lattice(z, 1_500_000), 6);
      h =
        baseMm +
        Math.floor(((lowland - 32768) * 220_000) / 32768) +
        Math.floor((Math.floor((ridge * m) / ONE) * reliefMm) / ONE);
    }
    if (coast !== 'none' && !isle) {
      const [u, v] = frame(x, z),
        warp = coastWarp(v),
        d = u - warp;
      if (ria) h = riaHeight(ria, d, v, x, z);
      else if (d < shelf) {
        // Smoothstep from the sea floor at the edge to the land height at the shelf's inner end.
        const t = clampInt(divFloor(d * ONE, shelf), 0, ONE),
          s = smooth(t);
        h = -sea + Math.floor(((h + sea) * s) / ONE);
      }
    }
    for (let r = 0; r < rivers.length; r++) {
      const line = rivers[r];
      let best = Infinity,
        bestK = 0;
      // In units of 64 mm, so every product stays below 2^53.
      for (let k = 0; k < 8; k++) {
        const ax = line[2 * k] >> 6,
          az = line[2 * k + 1] >> 6,
          bx = (line[2 * k + 2] >> 6) - ax,
          bz = (line[2 * k + 3] >> 6) - az,
          px = (x >> 6) - ax,
          pz = (z >> 6) - az,
          len = bx * bx + bz * bz,
          dot = px * bx + pz * bz,
          t = dot <= 0 || !len ? 0 : dot >= len ? 1024 : divWide(dot * 1024, len),
          dx = px - Math.floor((bx * t) / 1024),
          dz = pz - Math.floor((bz * t) / 1024),
          d2 = dx * dx + dz * dz;
        if (d2 < best) {
          best = d2;
          bestK = k * 1024 + t;
        }
      }
      // Half width here: `width`, moving to `mouth` over the last kilometre.
      let w = width;
      if (mouth !== width) {
        const k = bestK >> 10,
          run = k > 7 ? runs[r][8] : runs[r][k] + Math.floor((runs[r][9 + k] * (bestK & 1023)) / 1024);
        w += divFloor((mouth - width) * Math.max(0, MOUTH_RUN - run), MOUTH_RUN);
      }
      if (best < (w >> 6) * (w >> 6)) {
        const d = isqrt(best) * 64,
          bed = 2000 + Math.floor((bestK * 40_000) / 8192),
          t = d <= vFloor ? 0 : divFloor((d - vFloor) * ONE, w - vFloor),
          s = smooth(t);
        if (h > bed) h = bed + Math.floor(((h - bed) * s) / ONE);
      }
    }
    return h;
  };
  const made: Relief = {
    height,
    rivers,
    valleyWidth: width,
    islands: Object.freeze(isles.map((c) => Object.freeze({ x: c.x, z: c.z, radius }))),
    waterCells: (at, step, nx, nz) => riverCells(rivers, at, step, nx, nz),
    settings: Object.freeze({
      seed,
      origin: [ox, oz] as const,
      size: [sx, sz] as const,
      base: baseMm,
      relief: reliefMm,
      coast,
      seaDepth: sea,
      shelf,
      valley: Object.freeze({ width, floor: vFloor, mouth }),
      islands: isle ? Object.freeze({ count: islandCount, radius, shelf }) : null,
      ...(ria
        ? {
            ria: Object.freeze({
              center: ria.axis,
              width: ria.mouth,
              headWidth: ria.head,
              length: ria.length,
              depth: ria.depth,
              headDepth: ria.headDepth,
              slope: ria.slope,
              flat: ria.flat,
              flatHeight: ria.flatHeight,
              run: ria.run,
              river: ria.river ? 1 : 0,
            }),
          }
        : {}),
    }),
  };
  const erosion = options.erosion;
  if (erosion === undefined) return made;
  if (typeof erosion !== 'object' || erosion === null)
    throw typeError('Relief erosion must be an object of erosion settings; pass {} for the defaults', 'biomes');
  if (!erosionHook.erode)
    throw fault(
      'state',
      "A relief with erosion needs the erosion entry; await import('@margoengine/biomes/erosion') first (BiomeWorld.create loads it)",
      'biomes',
    );
  return erosionHook.erode(made, erosion);
}

/** Region cells along river centre lines (within half a cell), as water sources. */
function riverCells(
  rivers: readonly Int32Array[],
  origin: readonly [number, number],
  step: number,
  nx: number,
  nz: number,
): Uint8Array {
  const mask = new Uint8Array(nx * nz);
  for (const line of rivers)
    for (let k = 0; k + 3 < line.length; k += 2) {
      const ax = line[k] - origin[0],
        az = line[k + 1] - origin[1],
        bx = line[k + 2] - origin[0],
        bz = line[k + 3] - origin[1],
        n = Math.max(1, divFloor(2 * Math.max(Math.abs(bx - ax), Math.abs(bz - az)), step));
      for (let s = 0; s <= n; s++) {
        const x = divFloor(2 * (ax + divFloor((bx - ax) * s, n)) + step, 2 * step),
          z = divFloor(2 * (az + divFloor((bz - az) * s, n)) + step, 2 * step);
        if (x >= 0 && z >= 0 && x < nx && z < nz) mask[z * nx + x] = 1;
      }
    }
  return mask;
}
