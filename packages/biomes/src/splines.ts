// Roads and paths over a biome world (entry `@margoengine/biomes/splines`, loaded only by programs that use it): a path
// is a polyline or a smooth curve (uniform Catmull-Rom or cubic B-spline) with a width and an edge. The entry turns paths
// into placement exclusions, into editor edits that paint a road biome or a mask (undoable and replayable like every
// edit), and into a carved height source that flattens or cuts the ground along them. Every step is integer
// millimetres and Q16 with floors, so the same paths give the same bytes on every machine, in any order, from any tile.
// Curves sample at a fixed parameter step per span; distances use a bucket grid of segments so a cell reads only the
// segments that can reach it. Our own design; the curve forms are the textbook uniform cubic bases.
import { rangeError, typeError } from '../../shared/errors.js';
import { divFloor, fade, isqrt, ONE } from './fixed.js';
import { splinesHook } from './splines-hook.js';
import type { BiomeEdit, BiomeEditor, BrushFalloff } from './editor.js';
import type { Heights, HeightSource } from './height.js';
import type { Exclusion } from './placement.js';

/** How a path runs between its points: straight, through them (Catmull-Rom) or smoothed past them (B-spline). */
export type PathCurve = 'polyline' | 'catmull-rom' | 'b-spline';

/** How a carved height shapes the ground under a path (see {@link PathOptions.carve}). */
export interface PathCarve {
  /**
   * `'flatten'` levels the ground across the path to a bed that follows the ground along it, averaged over `grade`;
   * `'cut'` lowers the ground by `depth`. Default `'flatten'`.
   */
  readonly mode?: 'flatten' | 'cut';
  /** Metres below the bed (`'flatten'`) or the ground (`'cut'`), 0..100. Default 0. */
  readonly depth?: number;
  /** Metres along the path over which the bed averages the ground, 0..2,000: longer gives a gentler grade. Default 24. */
  readonly grade?: number;
}

/** A road or path. Lengths in metres; every value is quantised once to millimetres. */
export interface PathOptions {
  /** Points `[x, z]` in world metres, 2..65,536 of them, within 1,100 km of the origin. Repeated points are fine. */
  readonly points: readonly (readonly [number, number])[];
  /** Default `'polyline'`. */
  readonly curve?: PathCurve;
  /** Joins the last point back to the first. Default false. */
  readonly closed?: boolean;
  /** Spacing of curve samples in metres, 0.25..64 (curves only). Default 2. */
  readonly step?: number;
  /** Full width in metres, 0.1..2,000. Default 4. */
  readonly width?: number;
  /** Metres beyond the width over which the path fades out, 0..1,000. Default 2. */
  readonly edge?: number;
  /** Shape of the fade across the edge. Default `'smooth'` (quintic). */
  readonly falloff?: BrushFalloff;
  /** Biome id the path paints (`paint/<biome>`), such as a road biome with a gravel ground. Default none. */
  readonly biome?: string;
  /** Mask the path writes (`mask/<name>`), for envelopes and paint masks to read. Default none. */
  readonly mask?: string;
  /** Paint and mask value at the centre, 0..1. Default 1. */
  readonly strength?: number;
  /** Ground shaping of a carved height ({@link carvePaths}). Default `{ mode: 'flatten', depth: 0, grade: 24 }`. */
  readonly carve?: PathCarve;
}

/** A checked path: its settings with every default filled in, and its sampled centre line. */
export interface Path {
  /** Frozen settings, plain data (what edits and saved worlds hold). */
  readonly options: PathOptions;
  /** Centre line in world millimetres `[x0, z0, x1, z1, ...]`: no repeated neighbours, no piece over 256 m. */
  readonly line: Int32Array;
  /** Length of the centre line in metres. */
  readonly length: number;
}

const CURVES = ['polyline', 'catmull-rom', 'b-spline'],
  FALLOFFS = ['smooth', 'linear', 'constant'],
  CARVES = ['flatten', 'cut'];
/** Longest piece of a sampled line, mm: keeps a segment's squared length times Q16 below 2^53. */
const MAX_SEGMENT = 256_000;
/** Most samples of one path, and most curve samples of one span. */
const MAX_POINTS = 262_144,
  MAX_SPAN = 1024;
/** Smallest and largest bucket side of the segment grid, mm. */
const MIN_BUCKET = 32_000,
  MAX_BUCKET = 4_096_000;
/** Bucket keys: indices offset into 0..2^17. */
const KEY = 131_072,
  KEY_HALF = 65_536;

const mm = (m: number) => Math.round(m * 1000);
const inRange = (v: unknown, lo: number, hi: number): v is number => typeof v === 'number' && v >= lo && v <= hi;
const deepFreeze = <T>(o: T): T => {
  if (o && typeof o === 'object') {
    for (const v of Object.values(o)) deepFreeze(v);
    Object.freeze(o);
  }
  return o;
};

/** Length of a vector in mm, floored: exact below 2^52 squared, a correctly rounded double root above. */
function length(dx: number, dz: number): number {
  const d2 = dx * dx + dz * dz;
  return d2 <= 4503599627370496 ? isqrt(d2) : Math.floor(Math.sqrt(d2));
}

/** Validates path settings and fills every default. */
function settings(path: PathOptions): PathOptions {
  if (!path || typeof path !== 'object')
    throw typeError('A path is an object such as { points: [[0, 0], [40, 10]], width: 4 }', 'biomes');
  const { points } = path;
  if (
    !Array.isArray(points) ||
    points.length < 2 ||
    points.length > 65536 ||
    !points.every((p) => Array.isArray(p) && p.length === 2 && p.every((v) => inRange(v, -1_100_000, 1_100_000)))
  )
    throw rangeError('A path needs 2 to 65,536 points: [x, z] pairs in metres within 1,100 km of the origin', 'biomes');
  const curve = path.curve ?? 'polyline',
    closed = path.closed ?? false,
    step = path.step ?? 2,
    width = path.width ?? 4,
    edge = path.edge ?? 2,
    falloff = path.falloff ?? 'smooth',
    strength = path.strength ?? 1,
    carve = path.carve === undefined ? {} : path.carve;
  if (!CURVES.includes(curve)) throw rangeError("A path curve is 'polyline', 'catmull-rom' or 'b-spline'", 'biomes');
  if (typeof closed !== 'boolean') throw typeError('A path closed option is true or false', 'biomes');
  if (!inRange(step, 0.25, 64))
    throw rangeError('A path step is the spacing of curve samples in metres, 0.25..64', 'biomes');
  if (!inRange(width, 0.1, 2000)) throw rangeError('A path width is a number of metres, 0.1..2,000', 'biomes');
  if (!inRange(edge, 0, 1000)) throw rangeError('A path edge is a number of metres, 0..1,000', 'biomes');
  if (!FALLOFFS.includes(falloff)) throw rangeError("A path falloff is 'smooth', 'linear' or 'constant'", 'biomes');
  if (!inRange(strength, 0, 1)) throw rangeError('A path strength is a number 0..1', 'biomes');
  if (path.biome !== undefined && !(typeof path.biome === 'string' && /^[a-z0-9][a-z0-9-]*$/.test(path.biome)))
    throw rangeError('A path biome is a biome id such as road (lowercase letters, digits and dashes)', 'biomes');
  const mask = typeof path.mask === 'string' ? path.mask.replace(/^mask\//, '') : path.mask;
  if (mask !== undefined && !(typeof mask === 'string' && /^[\w-]+$/.test(mask)))
    throw rangeError('A path mask is a name such as roads (letters, digits, _ and -), or mask/roads', 'biomes');
  if (
    typeof carve !== 'object' ||
    carve === null ||
    !CARVES.includes(carve.mode ?? 'flatten') ||
    !inRange(carve.depth ?? 0, 0, 100) ||
    !inRange(carve.grade ?? 24, 0, 2000)
  )
    throw rangeError("A path carve is { mode: 'flatten' or 'cut', depth: 0..100 m, grade: 0..2,000 m }", 'biomes');
  return deepFreeze({
    points: points.map((p) => [p[0], p[1]] as const),
    curve,
    closed,
    step,
    width,
    edge,
    falloff,
    strength,
    ...(path.biome === undefined ? {} : { biome: path.biome }),
    ...(mask === undefined ? {} : { mask }),
    carve: { mode: carve.mode ?? 'flatten', depth: carve.depth ?? 0, grade: carve.grade ?? 24 },
  });
}

/**
 * A point of a uniform cubic span at parameter `tq` (Q16), relative to its second control point: Catmull-Rom `c = 2`
 * (through q1 and q2) or B-spline `c = 6`. Horner steps with floors keep every product below 2^53.
 */
function spanPoint(spline: boolean, a: number, b: number, c: number, d: number, tq: number): number {
  const q0 = a - b,
    q2 = c - b,
    q3 = d - b;
  let c0: number, c1: number, c2: number, c3: number;
  if (spline) {
    c0 = q0 + q2;
    c1 = 3 * (q2 - q0);
    c2 = 3 * (q0 + q2);
    c3 = q3 - q0 - 3 * q2;
  } else {
    c0 = 0;
    c1 = q2 - q0;
    c2 = 2 * q0 + 4 * q2 - q3;
    c3 = q3 - q0 - 3 * q2;
  }
  let h = c3;
  h = c2 + divFloor(h * tq, ONE);
  h = c1 + divFloor(h * tq, ONE);
  h = divFloor(h * tq, ONE);
  return b + divFloor(c0 + h, spline ? 6 : 2);
}

const tooMany = () =>
  rangeError('A path samples to over 262,144 points; use fewer points, a larger step or a polyline', 'biomes');

/** The sampled centre line of checked settings, mm. */
function sampleLine(o: PathOptions): Int32Array {
  const p = o.points.map(([x, z]) => [mm(x), mm(z)]),
    n = p.length,
    raw: number[] = [];
  if (o.curve === 'polyline') {
    for (const q of p) raw.push(q[0], q[1]);
    if (o.closed) raw.push(p[0][0], p[0][1]);
  } else {
    const spline = o.curve === 'b-spline',
      step = mm(o.step!);
    // Control windows: wrapped for a closed path; an open Catmull-Rom path reflects its ends so it starts and ends at
    // them, an open B-spline repeats them three times so it does too.
    let c: number[][], spans: number;
    if (o.closed) {
      c = [p[n - 1], ...p, p[0], p[1]];
      spans = n;
    } else if (spline) {
      c = [p[0], p[0], ...p, p[n - 1], p[n - 1]];
      spans = n + 1;
    } else {
      c = [
        [2 * p[0][0] - p[1][0], 2 * p[0][1] - p[1][1]],
        ...p,
        [2 * p[n - 1][0] - p[n - 2][0], 2 * p[n - 1][1] - p[n - 2][1]],
      ];
      spans = n - 1;
    }
    for (let s = 0; s < spans; s++) {
      const [a, b, e, f] = [c[s], c[s + 1], c[s + 2], c[s + 3]],
        reach = Math.max(
          length(e[0] - b[0], e[1] - b[1]),
          divFloor(
            length(b[0] - a[0], b[1] - a[1]) + length(e[0] - b[0], e[1] - b[1]) + length(f[0] - e[0], f[1] - e[1]),
            3,
          ),
        ),
        count = Math.min(MAX_SPAN, Math.max(1, -divFloor(-reach, step)));
      for (let k = s ? 1 : 0; k <= count; k++) {
        const tq = divFloor(k * ONE, count);
        raw.push(spanPoint(spline, a[0], b[0], e[0], f[0], tq), spanPoint(spline, a[1], b[1], e[1], f[1], tq));
      }
      if (raw.length > 2 * MAX_POINTS) throw tooMany();
    }
  }
  // Drop repeated neighbours and split pieces over 256 m.
  const out: number[] = [raw[0], raw[1]];
  for (let i = 2; i < raw.length; i += 2) {
    const ax = out[out.length - 2],
      az = out[out.length - 1],
      dx = raw[i] - ax,
      dz = raw[i + 1] - az;
    if (!dx && !dz) continue;
    const pieces = Math.max(1, -divFloor(-length(dx, dz), MAX_SEGMENT));
    for (let k = 1; k <= pieces; k++) out.push(ax + divFloor(dx * k, pieces), az + divFloor(dz * k, pieces));
    if (out.length > 2 * MAX_POINTS) throw tooMany();
  }
  // A path whose points all coincide is a disc: one segment of length 0.
  if (out.length === 2) out.push(out[0], out[1]);
  return Int32Array.from(out);
}

/**
 * Checks a path and samples its centre line: the settings every other function here uses, with defaults filled in.
 * @throws TypeError or RangeError naming the setting to fix.
 * @example
 * const road = definePath({ points: [[0, 0], [120, 40], [260, 30]], curve: 'catmull-rom', width: 5, biome: 'road' });
 * console.log(road.length, road.line.length / 2); // metres, and the number of sampled points
 */
export function definePath(path: PathOptions): Path {
  const options = settings(path),
    line = sampleLine(options);
  let total = 0;
  for (let i = 2; i < line.length; i += 2) total += length(line[i] - line[i - 2], line[i + 1] - line[i - 1]);
  return Object.freeze({ options, line, length: total / 1000 }); // float division: millimetres to metres
}

/** The segments of some paths and a bucket grid over their reach, positions in world mm. */
interface Index {
  readonly n: number;
  /** Per segment: ends, path, and the bed height at each end (flatten paths). */
  readonly ax: Float64Array;
  readonly az: Float64Array;
  readonly bx: Float64Array;
  readonly bz: Float64Array;
  readonly path: Int32Array;
  readonly pa: Float64Array;
  readonly pb: Float64Array;
  /** Per path: half width, edge, depth (mm), falloff, flatten. */
  readonly half: Float64Array;
  readonly edge: Float64Array;
  readonly depth: Float64Array;
  readonly falloff: readonly BrushFalloff[];
  readonly flatten: readonly boolean[];
  /** Bucket side in mm and the segments of each bucket of their reach box. */
  readonly bucket: number;
  readonly cells: Map<number, Int32Array>;
  /** Dedupe stamps for {@link near}. */
  readonly stamp: Int32Array;
  generation: number;
}

/** A bucket grid over the segments of checked paths; `bed` gives each flatten path's bed per line point. */
function indexOf(paths: readonly Path[], bed?: (path: number) => Float64Array | undefined): Index {
  let n = 0,
    reach = 0;
  for (const p of paths) {
    n += p.line.length / 2 - 1; // float division: an exact count
    reach = Math.max(reach, mm(p.options.width! / 2) + mm(p.options.edge!)); // float division: metres
  }
  const ax = new Float64Array(n),
    az = new Float64Array(n),
    bx = new Float64Array(n),
    bz = new Float64Array(n),
    path = new Int32Array(n),
    pa = new Float64Array(n),
    pb = new Float64Array(n),
    lists = new Map<number, number[]>();
  // Buckets at least as wide as the longest reach and piece, so a segment lies in at most 3 x 3 of them.
  let longest = 0;
  for (const p of paths)
    for (let k = 0; k + 2 < p.line.length; k += 2)
      longest = Math.max(longest, length(p.line[k + 2] - p.line[k], p.line[k + 3] - p.line[k + 1]));
  let bucket = MIN_BUCKET;
  while (bucket < Math.max(reach, longest) && bucket < MAX_BUCKET) bucket *= 2;
  let s = 0;
  paths.forEach((p, i) => {
    const l = p.line,
      r = mm(p.options.width! / 2) + mm(p.options.edge!), // float division: metres
      profile = bed?.(i);
    for (let k = 0; k + 2 < l.length; k += 2, s++) {
      ax[s] = l[k];
      az[s] = l[k + 1];
      bx[s] = l[k + 2];
      bz[s] = l[k + 3];
      path[s] = i;
      if (profile) {
        pa[s] = profile[k >> 1];
        pb[s] = profile[(k >> 1) + 1];
      }
      const x0 = divFloor(Math.min(l[k], l[k + 2]) - r, bucket),
        x1 = divFloor(Math.max(l[k], l[k + 2]) + r, bucket),
        z0 = divFloor(Math.min(l[k + 1], l[k + 3]) - r, bucket),
        z1 = divFloor(Math.max(l[k + 1], l[k + 3]) + r, bucket);
      for (let z = z0; z <= z1; z++)
        for (let x = x0; x <= x1; x++) {
          const key = (x + KEY_HALF) * KEY + z + KEY_HALF,
            list = lists.get(key);
          if (list) list.push(s);
          else lists.set(key, [s]);
        }
    }
  });
  const cells = new Map<number, Int32Array>();
  for (const [key, list] of lists) cells.set(key, Int32Array.from(list));
  return {
    n,
    ax,
    az,
    bx,
    bz,
    path,
    pa,
    pb,
    half: Float64Array.from(paths, (p) => mm(p.options.width! / 2)), // float division: metres
    edge: Float64Array.from(paths, (p) => mm(p.options.edge!)),
    depth: Float64Array.from(paths, (p) => mm(p.options.carve!.depth!)),
    falloff: paths.map((p) => p.options.falloff!),
    flatten: paths.map((p) => p.options.carve!.mode === 'flatten'),
    bucket,
    cells,
    stamp: new Int32Array(n),
    generation: 0,
  };
}

/** The segments whose reach box meets the rectangle, each once. */
function near(ix: Index, x0: number, z0: number, x1: number, z1: number, out: number[]): number[] {
  out.length = 0;
  const b = ix.bucket,
    i0 = divFloor(x0, b),
    i1 = divFloor(x1, b),
    j0 = divFloor(z0, b),
    j1 = divFloor(z1, b);
  if ((i1 - i0 + 1) * (j1 - j0 + 1) > ix.cells.size) {
    // A rectangle wider than the grid: every segment, tested by its box.
    for (let s = 0; s < ix.n; s++) {
      const r = ix.half[ix.path[s]] + ix.edge[ix.path[s]];
      if (
        Math.min(ix.ax[s], ix.bx[s]) - r <= x1 &&
        Math.max(ix.ax[s], ix.bx[s]) + r >= x0 &&
        Math.min(ix.az[s], ix.bz[s]) - r <= z1 &&
        Math.max(ix.az[s], ix.bz[s]) + r >= z0
      )
        out.push(s);
    }
    return out;
  }
  const g = ++ix.generation;
  for (let j = j0; j <= j1; j++)
    for (let i = i0; i <= i1; i++) {
      const list = ix.cells.get((i + KEY_HALF) * KEY + j + KEY_HALF);
      if (list)
        for (let k = 0; k < list.length; k++)
          if (ix.stamp[list[k]] !== g) {
            ix.stamp[list[k]] = g;
            out.push(list[k]);
          }
    }
  return out;
}

/** Weight (Q16) at squared distance `d2` from a centre line: 1 inside half width `half`, fading across `edge`. */
function weight(d2: number, half: number, edge: number, falloff: BrushFalloff): number {
  if (d2 <= half * half) return ONE;
  const reach = half + edge;
  if (!edge || d2 >= reach * reach) return 0;
  if (falloff === 'constant') return ONE;
  const t = Math.min(ONE, divFloor((isqrt(d2) - half) * ONE, edge));
  return falloff === 'linear' ? ONE - t : ONE - fade(t);
}

/**
 * Path weights of `count` x `rows` samples `step` mm apart from (x0, z0) mm into `w` (Q16, the largest over every
 * segment). With `bed`, also the bed height under the strongest weight (ties: the lowest) into `bed`, from `ground`
 * for cut paths. Each sample is a function of its own position only, so tiles meet without seams.
 */
function raster(
  ix: Index,
  x0: number,
  z0: number,
  step: number,
  count: number,
  rows: number,
  w: Int32Array,
  falloff?: BrushFalloff,
  bed?: Float64Array,
  ground?: Int32Array,
  list: number[] = [],
): boolean {
  w.fill(0);
  const x1 = x0 + (count - 1) * step,
    z1 = z0 + (rows - 1) * step;
  let any = false;
  for (const s of near(ix, x0, z0, x1, z1, list)) {
    const p = ix.path[s],
      half = ix.half[p],
      edge = ix.edge[p],
      r = half + edge,
      fall = falloff ?? ix.falloff[p],
      ax = ix.ax[s],
      az = ix.az[s],
      dx = ix.bx[s] - ax,
      dz = ix.bz[s] - az,
      len = dx * dx + dz * dz,
      c0 = Math.max(0, -divFloor(x0 - Math.min(ax, ax + dx) + r, step)),
      c1 = Math.min(count - 1, divFloor(Math.max(ax, ax + dx) + r - x0, step)),
      r0 = Math.max(0, -divFloor(z0 - Math.min(az, az + dz) + r, step)),
      r1 = Math.min(rows - 1, divFloor(Math.max(az, az + dz) + r - z0, step));
    for (let j = r0; j <= r1; j++)
      for (let i = c0; i <= c1; i++) {
        const k = j * count + i;
        if (!bed && w[k] === ONE) continue;
        const px = x0 + i * step - ax,
          pz = z0 + j * step - az,
          dot = px * dx + pz * dz;
        // Parameter of the nearest point (Q16) and the squared distance to it; the foot is within 1 mm.
        let t = 0,
          d2: number;
        if (dot <= 0 || !len) d2 = px * px + pz * pz;
        else if (dot >= len) {
          t = ONE;
          d2 = (px - dx) * (px - dx) + (pz - dz) * (pz - dz);
        } else {
          t = divFloor(dot * ONE, len);
          const fx = px - divFloor(dx * t, ONE),
            fz = pz - divFloor(dz * t, ONE);
          d2 = fx * fx + fz * fz;
        }
        const v = weight(d2, half, edge, fall);
        if (!v) continue;
        any = true;
        if (!bed) {
          if (v > w[k]) w[k] = v;
          continue;
        }
        const level = (ix.flatten[p] ? ix.pa[s] + divFloor((ix.pb[s] - ix.pa[s]) * t, ONE) : ground![k]) - ix.depth[p];
        if (v > w[k] || (v === w[k] && level < bed[k])) {
          w[k] = v;
          bed[k] = level;
        }
      }
  }
  return any;
}

/** Bed heights of a flatten path per line point: the ground averaged over `grade` metres of line around each. */
function bedOf(path: Path, ground: (x: number, z: number) => number): Float64Array {
  const l = path.line,
    n = l.length >> 1,
    h = new Float64Array(n),
    s = new Float64Array(n),
    out = new Float64Array(n),
    half = mm(path.options.carve!.grade! / 2); // float division: metres
  for (let i = 0; i < n; i++) {
    h[i] = ground(l[2 * i], l[2 * i + 1]);
    if (i) s[i] = s[i - 1] + length(l[2 * i] - l[2 * i - 2], l[2 * i + 1] - l[2 * i - 1]);
  }
  // A window of line points within `half` of each along the line, slid with two pointers.
  let lo = 0,
    hi = -1,
    sum = 0;
  for (let i = 0; i < n; i++) {
    while (hi + 1 < n && s[hi + 1] - s[i] <= half) sum += h[++hi];
    while (s[i] - s[lo] > half) sum -= h[lo++];
    out[i] = divFloor(sum, hi - lo + 1);
  }
  return out;
}

/** The carve of `paths` over a world's heights (minimum corner `origin`, mm). */
function carve(base: Heights, paths: readonly PathOptions[], origin: readonly [number, number]): Heights {
  if (!Array.isArray(paths))
    throw typeError('A carved height takes { carve: [paths], base?: height source }', 'biomes');
  const defined = paths.map(definePath);
  if (!defined.length) return base;
  const ix = indexOf(defined, (i) =>
      defined[i].options.carve!.mode === 'flatten'
        ? bedOf(defined[i], (x, z) => base.grid(x - origin[0], z - origin[1], 1, 1, 1)[0])
        : undefined,
    ),
    list: number[] = [];
  return {
    ...(base.relief ? { relief: base.relief } : {}),
    grid(gx, gz, count, rows, step, scratch) {
      const out = base.grid(gx, gz, count, rows, step, scratch),
        n = count * rows,
        w = scratch ? scratch.take('carve.w', Int32Array, n) : new Int32Array(n),
        bed = scratch ? scratch.take('carve.bed', Float64Array, n) : new Float64Array(n);
      if (raster(ix, origin[0] + gx * step, origin[1] + gz * step, step, count, rows, w, undefined, bed, out, list))
        for (let k = 0; k < n; k++) if (w[k]) out[k] += divFloor((bed[k] - out[k]) * w[k], ONE);
      return out;
    },
  };
}

/**
 * A height source carved along paths: `base` (default the procedural relief) with the ground flattened or cut under
 * each path's width, blending back across its edge (each path's `carve` settings). Pass it as `BiomeWorld.create({
 * height })`; the world loads this entry for it, its worker replicas carve the same bytes, and `saveWorld` keeps it.
 * Where paths overlap, the strongest weight wins and then the lowest bed, whatever their order.
 * @throws TypeError or RangeError naming the path setting to fix.
 * @example
 * const road = { points: [[-200, 0], [0, 40], [200, 10]], curve: 'catmull-rom', width: 6, carve: { grade: 40 } };
 * const world = await BiomeWorld.create({ height: carvePaths([road]) });
 */
export function carvePaths(paths: readonly PathOptions[], base?: HeightSource): HeightSource {
  if (!Array.isArray(paths))
    throw typeError('carvePaths takes an array of paths and an optional height source', 'biomes');
  return { carve: paths.map((p) => settings(p)), ...(base === undefined ? {} : { base }) };
}

/**
 * Placement exclusions of paths (`BiomePlacement.attach(world, { exclusions })`): each path's centre line with its width,
 * and its edge as the verge, so no stored object stands on a road and edge-loving plants line it.
 * @example
 * const placement = BiomePlacement.attach(world, { exclusions: pathExclusions([road]) });
 */
export function pathExclusions(paths: readonly PathOptions[]): Exclusion[] {
  if (!Array.isArray(paths)) throw typeError('pathExclusions takes an array of paths', 'biomes');
  return paths.map((p) => {
    const { options, line } = definePath(p),
      points: [number, number][] = [];
    for (let i = 0; i < line.length; i += 2) points.push([line[i] / 1000, line[i + 1] / 1000]); // float division: mm to m
    return { kind: 'line', points, width: options.width!, verge: options.edge! };
  });
}

/**
 * Editor edits that paint paths: one per path and layer, `paint/<biome>` for a path with `biome` and `mask/<name>` for
 * one with `mask`, mode `'max'` (so overlapping paths give the same bytes in any order). `editor.apply` replays each.
 */
export function pathEdits(paths: readonly PathOptions[]): BiomeEdit[] {
  if (!Array.isArray(paths)) throw typeError('pathEdits takes an array of paths', 'biomes');
  const edits: BiomeEdit[] = [];
  for (const p of paths) {
    const o = settings(p),
      edit = { kind: 'path', path: o, strength: o.strength!, mode: 'max', falloff: o.falloff! } as const;
    if (o.biome) edits.push({ ...edit, layer: `paint/${o.biome}` });
    if (o.mask) edits.push({ ...edit, layer: `mask/${o.mask}` });
  }
  return edits;
}

/**
 * Paints paths through an editor as one undo step: road biomes and masks under each path's width, fading across its
 * edge. Every path is checked before anything is painted.
 * @throws TypeError or RangeError naming the path setting to fix; the editor's own errors (a stroke already open).
 * @example
 * const editor = BiomeEditor.attach(world);
 * paintPaths(editor, [{ points: [[0, 0], [300, 80]], width: 5, biome: 'road', mask: 'roads' }]);
 * editor.undo(); // the exact bytes from before
 */
export function paintPaths(editor: BiomeEditor, paths: readonly PathOptions[]): void {
  if (!editor || typeof editor.apply !== 'function' || typeof editor.stroke !== 'function')
    throw typeError('paintPaths takes a BiomeEditor and an array of paths', 'biomes');
  const edits = pathEdits(paths);
  if (edits.length) editor.stroke(() => edits.forEach((e) => editor.apply(e)));
}

/** Checked paths of edits, by their frozen settings object, with their index. */
const built = new WeakMap<object, { path: Path; index: Index; list: number[] }>();
const builtOf = (o: PathOptions) => {
  let b = built.get(o);
  if (!b) {
    const path = definePath(o);
    built.set(o, (b = { path, index: indexOf([path]), list: [] }));
  }
  return b;
};

splinesHook.carve = carve;
splinesHook.check = (path) => {
  const o = settings(path);
  built.set(o, builtOf(o));
  return o;
};
splinesHook.box = (o) => {
  const { line } = builtOf(o).path,
    r = mm(o.width! / 2) + mm(o.edge!); // float division: metres
  let x0 = Infinity,
    z0 = Infinity,
    x1 = -Infinity,
    z1 = -Infinity;
  for (let i = 0; i < line.length; i += 2) {
    x0 = Math.min(x0, line[i]);
    x1 = Math.max(x1, line[i]);
    z0 = Math.min(z0, line[i + 1]);
    z1 = Math.max(z1, line[i + 1]);
  }
  return [x0 - r, z0 - r, x1 + r, z1 + r];
};
splinesHook.raster = (o, falloff, x0, z0, step, count, rows) => {
  const b = builtOf(o),
    w = new Int32Array(count * rows);
  raster(b.index, x0, z0, step, count, rows, w, falloff, undefined, undefined, b.list);
  return w;
};
