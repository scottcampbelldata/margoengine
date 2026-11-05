// Erosion of a height grid (entry `@margoengine/biomes/erosion`, loaded only by a program or world that uses it), in
// integers, so the same grid and options give the same bytes on every machine and in every worker. Each round slides
// material down slopes steeper than the angle of repose (thermal erosion) and then lets the water of every cell run to
// an outlet, cutting its bed where it can carry more than it holds and dropping what it cannot (hydraulic erosion);
// lakes fill with sediment. Sources: thermal erosion by an angle of repose, Musgrave, Kolb and Mace, "The synthesis and
// rendering of eroded fractal terrains", SIGGRAPH 1989; stream power incision, Howard, "A detachment-limited model of
// drainage basin evolution", Water Resources Research, 1994, and Whipple and Tucker, Journal of Geophysical Research,
// 1999 (erosion driven by catchment area and slope); transport capacity growing with discharge times slope, erosion
// toward it and deposition of the excess, Davy and Lague, "Fluvial erosion/transport equation of landscape evolution models revisited",
// Journal of Geophysical Research, 2009; drainage over the filled surface in Priority-Flood order, Barnes, Lehman and
// Mulla, Computers and Geosciences, 2014. Our own integer layout from those descriptions.
import { rangeError, typeError } from '../../shared/errors.js';
import { bilinear, degreesToAngle, divFloor, ONE, sincos } from './fixed.js';
import { erosionHook } from './erosion-hook.js';
import type { HeightGrid } from './hydrology.js';
import type { Relief } from './relief.js';

/** Settings of {@link erode}. Every option has a default; rates are quantised once to Q16. */
export interface ErosionOptions {
  /** Rounds of thermal then hydraulic erosion, an integer 0..1,024. Default 32. */
  readonly iterations?: number;
  /** Angle of repose in degrees, 0..89: thermal erosion moves material down slopes steeper than this. Default 35. */
  readonly talus?: number;
  /** Share of a cell's steepest excess over the talus slope that slides per round, 0..0.5; 0 turns it off. Default 0.25. */
  readonly thermal?: number;
  /**
   * What a flow can carry, 0..1: mm of sediment per cell drained, per mm of cell side, per unit of slope (tan); so it
   * grows with the water (Davy and Lague 2009) while the cut it makes is limited by the spare capacity. 0 turns
   * hydraulic erosion off. Default 0.01.
   */
  readonly capacity?: number;
  /** Share of the spare capacity a flow cuts from its bed per round, 0..1. Default 0.25. */
  readonly incision?: number;
  /** Share of the load over capacity a flow drops per round, 0..1. Default 0.5. */
  readonly deposition?: number;
  /** Sea level in mm: cells below it are outlets, like the border. Default: no sea. */
  readonly sea?: number;
}

/** Settings of a relief's `erosion` option and of {@link erodeRelief}: those of {@link erode} on the relief's own grid. */
export interface ReliefErosionOptions extends Omit<ErosionOptions, 'sea'> {
  /**
   * Grid spacing in metres, 1..1,024. Default 16 m, doubled until the world is at most 512 cells across (128 m on a
   * 64 km world). The relief's sea level (0 m) is the grid's sea.
   */
  readonly step?: number;
}

/** The result of {@link erode}: grids of `nx` x `nz` cells, rows of increasing z. */
export interface Erosion extends HeightGrid {
  /** The eroded heights in mm. */
  readonly height: Int32Array;
  /** Cells draining through each cell of the eroded grid, itself included, along `direction`. */
  readonly flow: Int32Array;
  /**
   * D8 direction 0..7 (+x, then clockwise with +z down the grid) to the cell each cell drains to over the filled
   * surface, or -1 at an outlet (the border and the sea). Along it the filled surface never rises.
   */
  readonly direction: Int8Array;
  /** How far each cell was lowered, mm (0 where it rose). */
  readonly wear: Int32Array;
  /** How far each cell was raised, mm (0 where it was lowered). */
  readonly deposit: Int32Array;
  /**
   * Sediment the flow carried out through the outlets, in mm of one cell summed: the heights' sum fell by exactly
   * this, and `wear` sums to `deposit` plus this.
   */
  readonly outflow: number;
}

/** Neighbour offsets of a D8 direction: 0 is +x, then clockwise seen from above with +z down the grid. */
const DX = [1, 1, 0, -1, -1, -1, 0, 1],
  DZ = [0, 1, 1, 1, 0, -1, -1, -1];
/** sqrt(2) in Q16. */
const ROOT2 = 92682;
/** Largest height magnitude in mm (33.5 km), and the most cells (2^21): a heap key packs both below 2^53. */
const LIMIT = 33554432,
  CELLS = 2097152;
/** Steepest slope (tan, Q16) a flow's capacity reads: 8, about 83 degrees. */
const TAN_MAX = 8 * ONE;

/** `floor(x * k / 65536)` for integers x and k of 0 or more with `x / 65536 * k` below 2^53, exact. */
const scale = (x: number, k: number) => Math.floor(x / ONE) * k + Math.floor(((x % ONE) * k) / ONE);

/** Working arrays of one grid. */
interface Work {
  readonly nx: number;
  readonly nz: number;
  readonly h: Int32Array;
  readonly filled: Int32Array;
  readonly dir: Int8Array;
  readonly lake: Uint8Array;
  readonly order: Int32Array;
  readonly area: Int32Array;
  readonly heap: Float64Array;
  readonly seen: Uint8Array;
}

/**
 * Priority-Flood from the outlets over `h`: each cell drains to the neighbour that reached it first (lowest filled
 * height, ties by index), `order` lists the cells outlets first, `filled` is the filled surface, `lake` marks the cells
 * under it and `area` counts the cells draining through each.
 */
function route(w: Work, sea: number | undefined): void {
  const { nx, nz, h, filled, dir, lake, order, area, heap, seen } = w,
    n = nx * nz;
  seen.fill(0);
  let size = 0,
    head = 0;
  const push = (c: number, level: number) => {
    filled[c] = level;
    seen[c] = 1;
    // Filled height first, then the index: one number, so the heap compares plain keys.
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
  for (let z = 0, c = 0; z < nz; z++)
    for (let x = 0; x < nx; x++, c++)
      if (x === 0 || z === 0 || x === nx - 1 || z === nz - 1 || (sea !== undefined && h[c] < sea)) {
        dir[c] = -1;
        push(c, h[c]);
      }
  while (size) {
    const c = heap[0] % CELLS,
      last = heap[--size];
    // The last key sinks from the root to its place.
    let k = 0;
    for (let child = 1; child < size; child = 2 * k + 1) {
      if (child + 1 < size && heap[child + 1] < heap[child]) child++;
      if (heap[child] >= last) break;
      heap[k] = heap[child];
      k = child;
    }
    heap[k] = last;
    order[head++] = c;
    const cz = divFloor(c, nx),
      cx = c - cz * nx;
    for (let d = 0; d < 8; d++) {
      const u = cx + DX[d],
        v = cz + DZ[d];
      if (u < 0 || v < 0 || u >= nx || v >= nz) continue;
      const i = v * nx + u;
      if (seen[i]) continue;
      dir[i] = (d + 4) & 7;
      push(i, Math.max(h[i], filled[c]));
    }
  }
  area.fill(1);
  for (let q = n - 1; q >= 0; q--) {
    const c = order[q],
      d = dir[c];
    lake[c] = filled[c] > h[c] ? 1 : 0;
    if (d >= 0) area[c + DZ[d] * nx + DX[d]] += area[c];
  }
}

/**
 * One thermal pass, in place and in a fixed order (forward on even rounds, backward on odd ones so neither direction
 * leads): a cell steeper than the talus slope toward some neighbours moves `rate` of its steepest excess to them, shared
 * by excess, the steepest taking what rounding left. With rate at most 0.5 no cell sinks below its lowest neighbour and
 * no neighbour rises above it, so heights stay within their first range.
 */
function slide(w: Work, rate: number, straight: number, diagonal: number, backward: boolean, ex: Int32Array): void {
  const { nx, nz, h } = w,
    n = nx * nz;
  for (let q = 0; q < n; q++) {
    const c = backward ? n - 1 - q : q,
      z = divFloor(c, nx),
      x = c - z * nx;
    let best = 0,
      sum = 0,
      steep = -1;
    for (let d = 0; d < 8; d++) {
      const u = x + DX[d],
        v = z + DZ[d];
      ex[d] = 0;
      if (u < 0 || v < 0 || u >= nx || v >= nz) continue;
      const e = h[c] - h[v * nx + u] - (d & 1 ? diagonal : straight);
      if (e <= 0) continue;
      ex[d] = e;
      sum += e;
      if (e > best) {
        best = e;
        steep = d;
      }
    }
    const m = Math.floor((best * rate) / ONE);
    if (m <= 0) continue;
    let left = m;
    for (let d = 0; d < 8; d++) {
      if (!ex[d] || d === steep) continue;
      const part = divFloor(m * ex[d], sum);
      h[c + DZ[d] * nx + DX[d]] += part;
      left -= part;
    }
    h[c + DZ[steep] * nx + DX[steep]] += left;
    h[c] -= m;
  }
}

/**
 * One hydraulic pass over the routing of this round, upstream first. A cell under the filled surface (a lake) keeps what
 * arrives up to the surface. Elsewhere the flow can carry `capacity x cells x side x tan` (the cells draining through,
 * the cell side in mm, the slope to the cell it drains to): below that it cuts `incision` of the spare capacity from its bed, never below the cell it drains to;
 * above it drops `deposition` of the excess, never above the lowest cell that drains to it from outside a lake. What
 * reaches an outlet leaves the grid. Returns the sediment that left.
 */
function flowPass(w: Work, step: number, rates: readonly number[], load: Float64Array): number {
  const { nx, nz, h, filled, dir, lake, order, area } = w,
    [capacity, incision, deposition] = rates,
    diagonal = Math.floor((step * ROOT2) / ONE);
  let out = 0;
  load.fill(0);
  for (let q = order.length - 1; q >= 0; q--) {
    const c = order[q],
      d = dir[c];
    let carried = load[c];
    if (d < 0) {
      out += carried;
      continue;
    }
    const p = c + DZ[d] * nx + DX[d];
    if (lake[c]) {
      const settle = Math.min(carried, filled[c] - h[c]);
      h[c] += settle;
      carried -= settle;
    } else {
      // Not under a lake: the filled surface is the height here, and the cell drained to is no higher.
      const drop = h[c] - h[p],
        tan = Math.min(TAN_MAX, divFloor(drop * ONE, d & 1 ? diagonal : step)),
        // Cells drained times the cell side, mm: the water's share of the cell's width.
        can = scale(scale(area[c] * step, tan), capacity);
      if (carried < can) {
        const cut = Math.min(drop, scale(can - carried, incision));
        h[c] -= cut;
        carried += cut;
      } else if (carried > can) {
        const cz = divFloor(c, nx),
          cx = c - cz * nx;
        let low = Infinity;
        for (let k = 0; k < 8; k++) {
          const u = cx - DX[k],
            v = cz - DZ[k],
            i = v * nx + u;
          // The neighbour on the far side of direction k drains here when its own direction is k.
          if (u >= 0 && v >= 0 && u < nx && v < nz && dir[i] === k && !lake[i]) low = Math.min(low, h[i]);
        }
        if (low !== Infinity) {
          const settle = Math.min(low - h[c], scale(carried - can, deposition));
          h[c] += settle;
          carried -= settle;
        }
      }
    }
    load[p] += carried;
  }
  return out;
}

/** A rate option quantised to Q16 after a range check. */
function rate(value: number | undefined, fallback: number, max: number, name: string): number {
  const v = value ?? fallback;
  if (typeof v !== 'number' || !(v >= 0 && v <= max))
    throw rangeError(`Erosion ${name} must be a number from 0 to ${max}`, 'biomes');
  return Math.round(v * ONE);
}

/**
 * Erodes a height grid: `iterations` rounds of thermal then hydraulic erosion, then the drainage of the result. Same
 * grid and options, same bytes on every machine. The grid's border and cells below `sea` are outlets.
 * @throws TypeError when `height` is not an Int32Array of `nx` x `nz` values or `options` is not an object; RangeError
 * for a grid under 2 x 2 or over 2,097,152 cells, a step outside 1..1,048,576 mm, a height beyond +-33,554,432 mm or an
 * option out of range.
 * @example
 * const e = erode({ height, nx: 257, nz: 257, step: 16000 }, { sea: 0 });
 * console.log(e.height[128 * 257 + 128] - height[128 * 257 + 128], e.flow[128 * 257 + 128]);
 */
export function erode(grid: HeightGrid, options: ErosionOptions = {}): Erosion {
  const { height, nx, nz, step } = grid;
  if (!(height instanceof Int32Array)) throw typeError('erode needs height as an Int32Array of millimetres', 'biomes');
  if (typeof options !== 'object' || options === null)
    throw typeError('Erosion options must be an object; pass {} for the defaults', 'biomes');
  if (
    !Number.isInteger(nx) ||
    !Number.isInteger(nz) ||
    !(nx >= 2 && nz >= 2 && nx * nz <= CELLS) ||
    height.length !== nx * nz ||
    !Number.isInteger(step) ||
    !(step >= 1 && step <= 1048576) ||
    height.some((v) => v > LIMIT || v < -LIMIT)
  )
    throw rangeError(
      'erode needs nx and nz of 2 or more (at most 2,097,152 cells), nx x nz heights within +-33,554,432 mm and a step of 1..1,048,576 mm',
      'biomes',
    );
  const iterations = options.iterations ?? 32,
    talus = options.talus ?? 35,
    sea = options.sea === undefined ? undefined : Math.round(options.sea);
  if (!Number.isInteger(iterations) || iterations < 0 || iterations > 1024)
    throw rangeError('Erosion iterations must be an integer from 0 to 1,024', 'biomes');
  if (typeof talus !== 'number' || !(talus >= 0 && talus <= 89))
    throw rangeError('Erosion talus must be an angle of 0 to 89 degrees', 'biomes');
  if (sea !== undefined && !Number.isFinite(sea)) throw rangeError('Erosion sea must be a height in mm', 'biomes');
  const thermal = rate(options.thermal, 0.25, 0.5, 'thermal'),
    rates = [
      rate(options.capacity, 0.01, 1, 'capacity'),
      rate(options.incision, 0.25, 1, 'incision'),
      rate(options.deposition, 0.5, 1, 'deposition'),
    ],
    cs = sincos(degreesToAngle(talus), [0, 0]),
    tan = divFloor(cs[1] * ONE, cs[0]),
    n = nx * nz,
    w: Work = {
      nx,
      nz,
      h: Int32Array.from(height),
      filled: new Int32Array(n),
      dir: new Int8Array(n),
      lake: new Uint8Array(n),
      order: new Int32Array(n),
      area: new Int32Array(n),
      heap: new Float64Array(n),
      seen: new Uint8Array(n),
    },
    straight = Math.floor((tan * step) / ONE),
    diagonal = Math.floor((tan * Math.floor((step * ROOT2) / ONE)) / ONE),
    ex = new Int32Array(8),
    load = new Float64Array(n);
  let outflow = 0;
  for (let r = 0; r < iterations; r++) {
    if (thermal) slide(w, thermal, straight, diagonal, (r & 1) === 1, ex);
    if (rates[0] && rates[1]) {
      route(w, sea);
      outflow += flowPass(w, step, rates, load);
    }
  }
  route(w, sea);
  const wear = new Int32Array(n),
    deposit = new Int32Array(n);
  for (let c = 0; c < n; c++) {
    const change = w.h[c] - height[c];
    if (change < 0) wear[c] = -change;
    else deposit[c] = change;
  }
  return { height: w.h, nx, nz, step, flow: w.area, direction: w.dir, wear, deposit, outflow };
}

/** A relief with its erosion: the eroded grid and the relief it was made from. */
export interface ErodedRelief extends Relief {
  /** The erosion grid; its cell (0, 0) is the relief's origin, `step` mm apart. */
  readonly erosion: Erosion;
}

/**
 * Erodes a procedural relief (from `createRelief` of `@margoengine/biomes/relief`) on a grid over its world, and returns
 * a relief whose `height(x, z)` is the original plus the erosion's change, interpolated bilinearly between grid corners
 * (so on the grid the heights are the eroded grid's, and the relief's own detail stays between them). Rivers, islands
 * and settings are the original's. A relief made with the `erosion` option is already this.
 * @throws RangeError for a `step` outside 1..1,024 m or a grid over 2,097,152 cells, and what {@link erode} throws.
 * @example
 * const relief = erodeRelief(createRelief({ seed: 7 }), { iterations: 48 });
 * const metres = relief.height(0, 0) / 1000;
 * const wornMm = relief.erosion.wear[128 * relief.erosion.nx + 128];
 */
export function erodeRelief(relief: Relief, options: ReliefErosionOptions = {}): ErodedRelief {
  if (typeof options !== 'object' || options === null)
    throw typeError('Erosion options must be an object; pass {} for the defaults', 'biomes');
  const {
      origin: [ox, oz],
      size: [sx, sz],
    } = relief.settings,
    { step: metres, ...rest } = options;
  let step = 16000;
  while (Math.max(sx, sz) > 512 * step) step *= 2;
  if (metres !== undefined) step = Math.round(metres * 1000);
  if (!(step >= 1000 && step <= 1_024_000)) throw rangeError('Relief erosion step must be 1 to 1,024 metres', 'biomes');
  const nx = 1 - divFloor(-sx, step),
    nz = 1 - divFloor(-sz, step);
  if (nx * nz > CELLS) throw rangeError('Relief erosion grid is over 2,097,152 cells; use a larger step', 'biomes');
  const base = new Int32Array(nx * nz);
  for (let j = 0, c = 0; j < nz; j++)
    for (let i = 0; i < nx; i++, c++) base[c] = relief.height(ox + i * step, oz + j * step);
  const erosion = erode({ height: base, nx, nz, step }, { ...rest, sea: 0 }),
    change = new Int32Array(nx * nz),
    at = relief.height;
  for (let c = 0; c < nx * nz; c++) change[c] = erosion.height[c] - base[c];
  return Object.freeze({
    ...relief,
    height: (x: number, z: number) =>
      at(x, z) + bilinear(change, nx, nz, divFloor((x - ox) * ONE, step), divFloor((z - oz) * ONE, step)),
    erosion,
  });
}

erosionHook.erode = erodeRelief;
