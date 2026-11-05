// Hydrology of a height grid (entry `@margoengine/biomes/hydrology`, spec 2.2 and B9), in integers, so the same grid gives
// the same bytes everywhere. Sources: filled surface, Barnes, Lehman and Mulla, "Priority-Flood", Computers and Geosciences
// 2014; drainage over flats, Barnes, Lehman and Mulla, "An efficient assignment of drainage direction over flat surfaces",
// Computers and Geosciences 2014 (gradients towards lower ground and away from higher ground); D8, O'Callaghan and Mark 1984;
// multiple flow, Freeman 1991 (shares by tan^1.1, in Q16); wetness, Beven and Kirkby 1979; height above nearest drainage,
// Renno et al. 2008. Our own code from those descriptions.
import { rangeError, typeError } from '../../shared/errors.js';
import { bilinear, divFloor, idiv, imod, isqrt, ONE, qexp2, qlog2 } from './fixed.js';
import type { RasterLayer } from './layers.js';
import { distanceTransform, priorityFlood } from './region.js';
import { flowBridge, worldGPU, type FlowState } from './gpu-placement-flow-internal.js';

/** Neighbour offsets of a D8 direction: 0 is +x, then clockwise seen from above with +z down the grid. */
const DX = [1, 1, 0, -1, -1, -1, 0, 1],
  DZ = [0, 1, 1, 1, 0, -1, -1, -1];
/** Q16: sqrt(2), and ln 2. */
const ROOT2 = 92682,
  LN2 = 45426;
/** The least tan a cell's wetness takes, Q16 (about 0.001), so flat ground has a finite index. */
const MIN_TAN = 65;
/** Freeman's exponent 1.1, Q16. */
const FREEMAN = 72090;

/** A grid of heights: `nx` x `nz` corners `step` mm apart, rows of increasing z, in mm (a world's `region`). */
export interface HeightGrid {
  readonly height: Int32Array;
  readonly nx: number;
  readonly nz: number;
  readonly step: number;
}

/** Settings of {@link hydrology}. */
export interface HydrologyOptions {
  /** Sea level in mm: cells below it are outlets and hold no lake or channel. Default: no sea. */
  readonly sea?: number;
  /** Cells that must drain through a cell to make it a channel. Default: the cells of 1 km2, at least 8. */
  readonly channelCells?: number;
  /** Fill depth in mm that makes a cell a lake. Default 1,000. */
  readonly lakeDepth?: number;
  /** Also route `shares` over every lower neighbour (Freeman 1991); wetness then reads them. Default false. */
  readonly multiple?: boolean;
}

/** The result of {@link hydrology}: grids of `nx` x `nz` cells, rows of increasing z. */
export interface Hydrology extends HeightGrid {
  /** The filled surface in mm (at least `height`). */
  readonly filled: Int32Array;
  /** D8 direction 0..7 (+x, then clockwise), or -1 at an outlet: the sea and border cells with no lower neighbour. */
  readonly direction: Int8Array;
  /** Cells draining through each cell, itself included, along `direction`. The outlets' sum is the cell count. */
  readonly flow: Int32Array;
  /** With `multiple`, the same in Q16 cells over every lower neighbour; the outlets' sum is the cell count times 65,536. */
  readonly shares?: Float64Array;
  /** Topographic wetness ln(a / tan b), Q8; a in metres of catchment per metre of contour. */
  readonly twi: Int16Array;
  /** Height above the nearest drainage along the flow, mm; 0 on channels and outlets. */
  readonly hand: Int32Array;
  /** 1 where the fill passes `lakeDepth`; its surface is `filled`. */
  readonly lake: Uint8Array;
  /** 1 where `flow` passes `channelCells`. */
  readonly channel: Uint8Array;
  /** Distance to the sea, a lake or a channel in dm, or 2,147,483,647 with none on the grid. */
  readonly water: Int32Array;
}

/** Whether cell `(x, z)` lies on the border. */
const onBorder = (x: number, z: number, nx: number, nz: number) => x === 0 || z === 0 || x === nx - 1 || z === nz - 1;

/** Steepest descent over `surface` among the neighbours `allowed` keeps, ties to the lowest direction; -1 with no drop. */
function steepest(
  surface: ArrayLike<number>,
  c: number,
  x: number,
  z: number,
  nx: number,
  nz: number,
  allowed?: (i: number) => boolean,
): number {
  let best = 0,
    pick = -1;
  for (let d = 0; d < 8; d++) {
    const u = x + DX[d],
      v = z + DZ[d];
    if (u < 0 || v < 0 || u >= nx || v >= nz) continue;
    const i = v * nx + u;
    if (allowed && !allowed(i)) continue;
    const drop = surface[c] - surface[i],
      // Compared without the root: a diagonal drop over sqrt(2) cells, squared, is half of a straight one.
      w = drop > 0 ? drop * drop * (d & 1 ? 1 : 2) : 0;
    if (w > best) {
      best = w;
      pick = d;
    }
  }
  return pick;
}

/** Breadth-first steps from `seeds` over cells `open` holds, 8-connected: `steps[c]` gets 1 at the seeds. */
function spread(
  seeds: number[],
  steps: Int32Array,
  nx: number,
  nz: number,
  open: (i: number, from: number) => boolean,
) {
  for (let q = 0; q < seeds.length; q++) {
    const c = seeds[q],
      x = imod(c, nx),
      z = idiv(c - x, nx);
    for (let d = 0; d < 8; d++) {
      const u = x + DX[d],
        v = z + DZ[d];
      if (u < 0 || v < 0 || u >= nx || v >= nz) continue;
      const i = v * nx + u;
      if (!steps[i] && open(i, c)) {
        steps[i] = steps[c] + 1;
        seeds.push(i);
      }
    }
  }
}

/** Directions of the cells on flats, from gradients towards lower ground and away from higher ground. */
function drainFlats(
  filled: Int32Array,
  direction: Int8Array,
  flat: Uint8Array,
  nx: number,
  nz: number,
  mask: Int32Array,
) {
  const n = nx * nz,
    toLow = new Int32Array(n),
    away = new Int32Array(n),
    label = new Int32Array(n),
    low: number[] = [],
    high: number[] = [];
  // Labels: 1 for the first flat on.
  let labels = 0;
  for (let c = 0; c < n; c++) {
    if (!flat[c] || label[c]) continue;
    label[c] = ++labels;
    const stack = [c];
    while (stack.length) {
      const a = stack.pop()!,
        x = imod(a, nx),
        z = idiv(a - x, nx);
      for (let d = 0; d < 8; d++) {
        const u = x + DX[d],
          v = z + DZ[d];
        if (u < 0 || v < 0 || u >= nx || v >= nz) continue;
        const i = v * nx + u;
        if (flat[i] && !label[i] && filled[i] === filled[a]) {
          label[i] = labels;
          stack.push(i);
        }
      }
    }
  }
  // Edges: a drained cell level with a flat cell is its way out; a flat cell beside higher ground starts the other gradient.
  for (let c = 0; c < n; c++) {
    const x = imod(c, nx),
      z = idiv(c - x, nx);
    let isLow = false,
      isHigh = false;
    for (let d = 0; d < 8; d++) {
      const u = x + DX[d],
        v = z + DZ[d];
      if (u < 0 || v < 0 || u >= nx || v >= nz) continue;
      const i = v * nx + u;
      if (!flat[c] && flat[i] && filled[i] === filled[c]) isLow = true;
      if (flat[c] && filled[i] > filled[c]) isHigh = true;
    }
    if (isLow) low.push(c);
    if (isHigh) high.push(c);
  }
  for (const c of low) toLow[c] = 1;
  spread(low, toLow, nx, nz, (i, from) => !!flat[i] && filled[i] === filled[from]);
  for (const c of high) away[c] = 1;
  spread(high, away, nx, nz, (i, from) => label[i] === label[from] && !!label[i]);
  const most = new Int32Array(labels + 1);
  for (let c = 0; c < n; c++) if (away[c] > most[label[c]]) most[label[c]] = away[c];
  for (let c = 0; c < n; c++) if (flat[c]) mask[c] = 2 * toLow[c] + (away[c] ? most[label[c]] - away[c] : 0);
  for (let c = 0; c < n; c++) {
    if (!flat[c]) continue;
    const x = imod(c, nx),
      z = idiv(c - x, nx);
    direction[c] = steepest(mask, c, x, z, nx, nz, (i) => filled[i] === filled[c]);
  }
}

/** log2 of a positive integer, Q16, for values past what `qlog2` takes. */
function log2Of(v: number): number {
  let k = 0;
  while (v >= 16384) {
    v = Math.floor(v / 2);
    k++;
  }
  return qlog2(v * ONE) + k * ONE;
}

/** Tan of the slope from cell `c` along direction `d` over `surface`, Q16, at least the least one. */
function tanAlong(surface: Int32Array, c: number, d: number, nx: number, step: number): number {
  if (d < 0) return MIN_TAN;
  const drop = surface[c] - surface[c + DZ[d] * nx + DX[d]],
    tan = divFloor(drop * ONE, step);
  return Math.max(MIN_TAN, d & 1 ? divFloor(tan * ONE, ROOT2) : tan);
}

/** Routes one Q16 amount of each cell down every lower neighbour, upstream first (Freeman 1991). */
function routeShares(g: HeightGrid, filled: Int32Array, mask: Int32Array, direction: Int8Array): Float64Array {
  const { nx, nz, step } = g,
    n = nx * nz,
    shares = new Float64Array(n).fill(ONE),
    order = new Int32Array(n),
    weight = new Float64Array(8);
  for (let c = 0; c < n; c++) order[c] = c;
  // Highest first, on a flat by its gradient, ties by index: every neighbour a cell sends to comes later.
  order.sort((a, b) => filled[b] - filled[a] || mask[b] - mask[a] || a - b);
  for (let q = 0; q < n; q++) {
    const c = order[q],
      x = imod(c, nx),
      z = idiv(c - x, nx);
    let sum = 0,
      last = -1;
    for (let d = 0; d < 8; d++) {
      const u = x + DX[d],
        v = z + DZ[d];
      weight[d] = 0;
      if (u < 0 || v < 0 || u >= nx || v >= nz) continue;
      const drop = filled[c] - filled[v * nx + u];
      if (drop <= 0) continue;
      const tan = Math.max(MIN_TAN, tanAlong(filled, c, d, nx, step));
      weight[d] = Math.max(1, qexp2(Math.floor((qlog2(tan) * FREEMAN) / ONE)));
      sum += weight[d];
      last = d;
    }
    // No lower neighbour: a flat's one way out, or an outlet that keeps what it has.
    if (!sum) {
      if (direction[c] >= 0) shares[c + DZ[direction[c]] * nx + DX[direction[c]]] += shares[c];
      continue;
    }
    const amount = shares[c];
    let left = amount;
    for (let d = 0; d < 8; d++) {
      if (!weight[d]) continue;
      // The last neighbour takes what rounding left, so nothing is lost. weight below 2^31, amount below 2^46: the product
      // can pass 2^53, so the share is the whole part of amount / sum times the weight plus the rest's share.
      const whole = divFloor(amount, sum),
        part = d === last ? left : whole * weight[d] + divFloor((amount - whole * sum) * weight[d], sum);
      shares[c + DZ[d] * nx + DX[d]] += part;
      left -= part;
    }
  }
  return shares;
}

/**
 * The hydrology of a height grid. Same grid and options, same bytes on every machine.
 * @throws TypeError when `height` is not an Int32Array of `nx` x `nz` values; RangeError for a grid under 2 x 2, a bad `step`
 * or an option out of range.
 * @example
 * const h = hydrology({ height, nx: 257, nz: 257, step: 16000 }, { sea: 0 });
 * console.log(h.flow[128 * 257 + 128], h.channel[128 * 257 + 128]);
 */
export function hydrology(grid: HeightGrid, options: HydrologyOptions = {}): Hydrology {
  const state = prepareFlow(grid, options);
  cpuDirections(state);
  return finishFlow(state);
}

function validateFlow(grid: HeightGrid, options: HydrologyOptions) {
  const { height, nx, nz, step } = grid;
  if (!(height instanceof Int32Array))
    throw typeError('hydrology needs height as an Int32Array of millimetres', 'biomes');
  if (!(nx >= 2 && nz >= 2) || !(step >= 1) || height.length !== nx * nz)
    throw rangeError('hydrology needs nx and nz of 2 or more, nx x nz heights and a step of at least 1 mm', 'biomes');
  const { sea, lakeDepth = 1000, multiple = false } = options,
    channelCells = options.channelCells ?? Math.max(8, Math.ceil(1e12 / (step * step))); // float division: cells of 1 km2
  if (!(channelCells >= 1) || !(lakeDepth > 0))
    throw rangeError('hydrology channelCells must be 1 or more and lakeDepth above 0', 'biomes');
  return { height, nx, nz, step, sea, lakeDepth, multiple, channelCells };
}

function prepareFlow(grid: HeightGrid, options: HydrologyOptions): FlowState {
  const { height, nx, nz, sea, lakeDepth, multiple, channelCells } = validateFlow(grid, options);
  const n = nx * nz,
    ocean = new Uint8Array(n);
  if (sea !== undefined) for (let c = 0; c < n; c++) ocean[c] = height[c] < sea ? 1 : 0;
  const fill = priorityFlood(height, nx, nz, ocean),
    filled = new Int32Array(n),
    direction = new Int8Array(n).fill(-1),
    flat = new Uint8Array(n),
    mask = new Int32Array(n);
  for (let c = 0; c < n; c++) filled[c] = height[c] + fill[c];
  return { grid, options: { sea, lakeDepth, multiple, channelCells }, n, ocean, fill, filled, direction, flat, mask };
}

function cpuDirections(state: FlowState): void {
  const {
    grid: { nx, nz },
    n,
    ocean,
    filled,
    direction,
    flat,
    mask,
  } = state;
  let flats = false;
  for (let z = 0, c = 0; z < nz; z++)
    for (let x = 0; x < nx; x++, c++) {
      if (ocean[c]) continue;
      direction[c] = steepest(filled, c, x, z, nx, nz);
      if (direction[c] < 0 && !onBorder(x, z, nx, nz)) flat[c] = 1;
      if (flat[c]) flats = true;
    }
  if (flats) drainFlats(filled, direction, flat, nx, nz, mask);
}

function finishFlow(state: FlowState, suppliedFlow?: Int32Array): Hydrology {
  const {
    grid,
    options: { lakeDepth = 1000, multiple = false, channelCells = 8 },
    n,
    ocean,
    fill,
    filled,
    direction,
    mask,
  } = state;
  const { height, nx, nz, step } = grid;
  // Upstream first: a cell comes after everything that drains into it.
  const flow = suppliedFlow ?? new Int32Array(n).fill(1),
    waiting = new Int32Array(n),
    order = new Int32Array(n),
    target = new Int32Array(n);
  for (let c = 0; c < n; c++) {
    const d = direction[c];
    target[c] = d < 0 ? -1 : c + DZ[d] * nx + DX[d];
    if (d >= 0) waiting[target[c]]++;
  }
  let tail = 0;
  for (let c = 0; c < n; c++) if (!waiting[c]) order[tail++] = c;
  for (let q = 0; q < tail; q++) {
    const c = order[q],
      t = target[c];
    if (t >= 0) {
      if (!suppliedFlow) flow[t] += flow[c];
      if (!--waiting[t]) order[tail++] = t;
    }
  }
  const shares = multiple ? routeShares(grid, filled, mask, direction) : undefined,
    lake = new Uint8Array(n),
    channel = new Uint8Array(n),
    sources = new Uint8Array(n),
    twi = new Int16Array(n),
    hand = new Int32Array(n),
    drain = new Int32Array(n),
    metre = log2Of(1000);
  for (let c = 0; c < n; c++) {
    lake[c] = !ocean[c] && fill[c] >= lakeDepth ? 1 : 0;
    channel[c] = !ocean[c] && flow[c] >= channelCells ? 1 : 0;
    sources[c] = ocean[c] | lake[c] | channel[c];
    const tan = tanAlong(filled, c, direction[c], nx, step),
      // Cells times the cell's width in mm, per metre: the specific catchment area in metres.
      a = log2Of(Math.max(1, Math.ceil(((shares ? shares[c] : flow[c] * ONE) * step) / ONE))) - metre, // float division: mm of contour
      wet = Math.floor(((a - qlog2(tan)) * LN2) / ONE);
    twi[c] = Math.max(-32768, Math.min(32767, Math.floor(wet / 256)));
  }
  for (let q = n - 1; q >= 0; q--) {
    const c = order[q],
      t = target[c];
    drain[c] = t < 0 || channel[c] ? height[c] : drain[t];
    hand[c] = Math.max(0, height[c] - drain[c]);
  }
  const d2 = distanceTransform(sources, nx, nz),
    water = new Int32Array(n),
    dm = Math.floor(step / 100);
  for (let c = 0; c < n; c++) water[c] = d2[c] < 0 ? 2147483647 : isqrt(d2[c] * dm * dm);
  return {
    height,
    nx,
    nz,
    step,
    filled,
    direction,
    flow,
    ...(shares ? { shares } : {}),
    twi,
    hand,
    lake,
    channel,
    water,
  };
}

/** What {@link hydrologyOf} and {@link riversOf} read of a `BiomeWorld`. */
export interface HydrologyWorld {
  readonly region: HeightGrid;
  readonly bounds: readonly [number, number, number, number];
  readonly climate: { readonly sea: number };
  readonly tileSize: number;
  readonly resolution: number;
}

/**
 * The hydrology of a world's region grid (`world.region`), with the world's sea level. Rerun it after `world.update` with new
 * heights or climate.
 * @throws what {@link hydrology} throws.
 * @example
 * const world = await BiomeWorld.create();
 * const h = hydrologyOf(world);
 * const { lines } = riversOf(world, h);
 * await BiomeView.attach(engine, world, { water: { rivers: lines } });
 */
export function hydrologyOf(world: HydrologyWorld, options: HydrologyOptions = {}): Hydrology {
  return hydrology(world.region, { sea: world.climate.sea, ...options });
}

/**
 * The hydrology of a world's region, using its device on a GPU world and the CPU otherwise.
 * Uses the world's sea level unless `options.sea` overrides it. Rerun after heights or climate change.
 * The synchronous {@link hydrologyOf} always uses the CPU.
 * @throws what {@link hydrology} throws for invalid inputs. Rejects with the signal's reason on abort,
 * or MargoError code `failed` on device loss or GPU execution errors.
 * @example
 * const h = await hydrologyOfAsync(world, { multiple: true }, { signal });
 * const { lines } = riversOf(world, h);
 */
export async function hydrologyOfAsync(
  world: HydrologyWorld,
  options: HydrologyOptions = {},
  { signal }: { readonly signal?: AbortSignal } = {},
): Promise<Hydrology> {
  signal?.throwIfAborted();
  const grid = world.region,
    settings = { sea: world.climate.sea, ...options };
  validateFlow(grid, settings);
  const gpu = worldGPU.get(world),
    combined = gpu ? (signal ? AbortSignal.any([signal, gpu.signal]) : gpu.signal) : signal;
  combined?.throwIfAborted();
  // The CPU accepts non-finite thresholds; keep those settings outside the GPU kernel's domain.
  if (
    gpu &&
    (settings.sea === undefined || Number.isFinite(settings.sea)) &&
    (settings.channelCells === undefined || Number.isFinite(settings.channelCells)) &&
    (settings.lakeDepth === undefined || Number.isFinite(settings.lakeDepth))
  ) {
    // The kernel is in the GPU entry (by package name), so this entry and the worker file hold none of it.
    const { hydrologyGPU } = await import('@margoengine/biomes/gpu');
    return hydrologyGPU(gpu.device, grid, { ...settings, multiple: !!settings.multiple }, { signal: combined });
  }
  await Promise.resolve();
  combined?.throwIfAborted();
  return hydrology(grid, settings);
}

/** River lines of {@link riversOf}. */
export interface HydrologyRivers {
  /** Centre lines in millimetres, `[x0, z0, x1, z1, ...]`, mouth first; a tributary's mouth is where it joins. */
  readonly lines: readonly Int32Array[];
  /** The filled surface in mm at each point of the line, never rising towards the mouth. */
  readonly levels: readonly Int32Array[];
}

/**
 * The channels of a hydrology as lines for `BiomeView`'s `water: { rivers }`: from each mouth up the largest flow, every other
 * channel its own line from the point where it joins. Lines under `minimumCells` cells are left out (default 8). Lines follow
 * grid directions, so they run in straight pieces of 45 degree turns.
 * @example
 * const { lines, levels } = riversOf(world, hydrologyOf(world));
 */
export function riversOf(world: HydrologyWorld, h: Hydrology, minimumCells = 8): HydrologyRivers {
  const { nx, nz, step, channel, direction, flow, filled } = h,
    [x0, z0] = world.bounds,
    ox = Math.round(x0 * 1000),
    oz = Math.round(z0 * 1000),
    lines: Int32Array[] = [],
    levels: Int32Array[] = [],
    stack: number[][] = [];
  const inflow = (c: number) => {
    const out: number[] = [],
      x = imod(c, nx),
      z = idiv(c - x, nx);
    for (let d = 0; d < 8; d++) {
      const u = x + DX[d],
        v = z + DZ[d];
      if (u < 0 || v < 0 || u >= nx || v >= nz) continue;
      const i = v * nx + u;
      // A neighbour in direction d drains here when its own direction is the opposite one.
      if (channel[i] && direction[i] === ((d + 4) & 7)) out.push(i);
    }
    // Largest flow first, ties by index.
    return out.sort((a, b) => flow[b] - flow[a] || a - b);
  };
  for (let c = 0; c < nx * nz; c++) {
    if (!channel[c]) continue;
    const d = direction[c];
    if (d < 0 || !channel[c + DZ[d] * nx + DX[d]]) stack.push([c]);
  }
  while (stack.length) {
    const cells = stack.pop()!;
    for (let at = cells[cells.length - 1]; ; ) {
      const up = inflow(at);
      if (!up.length) break;
      // Every other channel is a line of its own, starting at this junction.
      for (let k = 1; k < up.length; k++) stack.push([at, up[k]]);
      at = up[0];
      cells.push(at);
    }
    if (cells.length < minimumCells) continue;
    const line: number[] = [],
      level: number[] = [];
    for (let k = 0; k < cells.length; k++) {
      const c = cells[k];
      // The ends and the points where the line turns.
      if (k && k < cells.length - 1 && cells[k + 1] - c === c - cells[k - 1]) continue;
      const x = imod(c, nx);
      line.push(ox + x * step, oz + idiv(c - x, nx) * step);
      level.push(filled[c]);
    }
    lines.push(Int32Array.from(line));
    levels.push(Int32Array.from(level));
  }
  return { lines, levels };
}

/** Tile layer names of {@link hydrologyTile}, with their formats. */
export const HYDROLOGY_LAYERS = Object.freeze({
  flow: { format: 'i32', scale: 1, unit: 'cells' },
  twi: { format: 'i16', scale: 1 / 256, unit: 'ln m' },
  hand: { format: 'i32', scale: 0.001, unit: 'm' },
  lake: { format: 'u8', scale: 1, unit: '0 or 1' },
  channel: { format: 'u8', scale: 1, unit: '0 or 1' },
} as const);

/**
 * The hydrology of world tile `(x, z)` as rasters of the tile's cells: `flow`, `lake` and `channel` of the nearest region
 * corner, `twi` and `hand` bilinear between them.
 * @throws RangeError for a tile outside the world.
 * @example
 * const [flow, twi, hand, lake, channel] = hydrologyTile(world, hydrologyOf(world), 2, 3);
 */
export function hydrologyTile(world: HydrologyWorld, h: Hydrology, x: number, z: number): RasterLayer[] {
  const { nx, nz, step } = h,
    cells = world.tileSize / world.resolution, // float division: exact
    cell = world.resolution * 1000,
    size = (world.bounds[2] - world.bounds[0]) / world.tileSize, // float division: tiles
    depth = (world.bounds[3] - world.bounds[1]) / world.tileSize; // float division: tiles
  if (!(x >= 0 && z >= 0 && x < size && z < depth) || !Number.isInteger(x) || !Number.isInteger(z))
    throw rangeError('hydrologyTile needs tile indices inside the world', 'biomes');
  const toRegion = divFloor(cell * ONE, step),
    count = cells * cells,
    flow = new Int32Array(count),
    twi = new Int16Array(count),
    hand = new Int32Array(count),
    lake = new Uint8Array(count),
    channel = new Uint8Array(count),
    wet = Int32Array.from(h.twi);
  for (let j = 0, k = 0; j < cells; j++) {
    const v = (z * cells + j) * toRegion,
      nearZ = Math.min(nz - 1, (v + 32768) >> 16);
    for (let i = 0; i < cells; i++, k++) {
      const u = (x * cells + i) * toRegion,
        near = nearZ * nx + Math.min(nx - 1, (u + 32768) >> 16);
      flow[k] = h.flow[near];
      lake[k] = h.lake[near];
      channel[k] = h.channel[near];
      twi[k] = bilinear(wet, nx, nz, u, v);
      hand[k] = bilinear(h.hand, nx, nz, u, v);
    }
  }
  const layer = (name: keyof typeof HYDROLOGY_LAYERS, data: RasterLayer['data']): RasterLayer => ({
    name,
    ...HYDROLOGY_LAYERS[name],
    width: cells,
    depth: cells,
    data,
  });
  return [layer('flow', flow), layer('twi', twi), layer('hand', hand), layer('lake', lake), layer('channel', channel)];
}
flowBridge.prepare = prepareFlow;
flowBridge.drain = (state) => {
  if (state.flat.some(Boolean))
    drainFlats(state.filled, state.direction, state.flat, state.grid.nx, state.grid.nz, state.mask);
};
flowBridge.finish = finishFlow;
