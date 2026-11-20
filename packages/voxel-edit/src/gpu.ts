/// <reference lib="esnext.disposable" preserve="true" />
// @margoengine/voxel-edit/gpu: GPU bulk edits. A grid kept on the GPU between edits (two buffers, a byte per cell), so
// large fills, booleans and filters on multi-million-cell models run as compute passes and the grid is read back once.
// Each operation gives exactly the cells of its CPU counterpart in this package.
import type { Vec3 } from '@margoengine/math';
import { MargoError } from '@margoengine/math/errors';
import { brushInputs, brushPipelines, compileBrush, GridBuffers, isDevice, type PassInputs } from './brush-gpu.js';
import {
  checkCell,
  checkGrid,
  checkOptions,
  checkPalette,
  cellLimit,
  type GridLimits,
  type VoxelGrid,
} from './grid.js';
import { brushes, type ShaderBrush, type ShaderBrushRunOptions } from './shaders.js';

// A box reads its corners, clipped to the grid, from params 0 to 5; a sphere its centre from the tool offset (whole
// i32 cells, so no f32 rounding) and is refused per axis before the squared distance, which then cannot overflow.
const FILL = /* wgsl */ `
fn brush(p: vec3<i32>, value: u32) -> u32 {
  if (param(7) == 0.0) {
    let lo = vec3<i32>(i32(param(0)), i32(param(1)), i32(param(2)));
    let hi = vec3<i32>(i32(param(3)), i32(param(4)), i32(param(5)));
    if (all(p >= lo) && all(p < hi)) { return u32(param(6)); }
    return value;
  }
  let d = p - info.tool_offset.xyz;
  if (any(abs(d) > vec3<i32>(128))) { return value; }
  if (f32(dot(d, d)) <= param(3)) { return u32(param(6)); }
  return value;
}`;
const COMBINE = /* wgsl */ `
fn brush(p: vec3<i32>, value: u32) -> u32 {
  let t = tool(p);
  let op = u32(param(0));
  if (op == 2u) {
    if (t == 0u) { return 0u; }
    return value;
  }
  if (t == 0u) { return value; }
  if (op == 3u) { return 0u; }
  if (op == 0u && value != 0u) { return value; }
  return lookup(t);
}`;
const REMAP = /* wgsl */ `
fn brush(p: vec3<i32>, value: u32) -> u32 { return lookup(value); }`;

/** Longest side: box corners travel as f32, exact for whole numbers up to 2^24. */
const MAX_SIDE = 16_777_216;

const programs = new WeakMap<GPUDevice, Map<string, Promise<GPUComputePipeline>>>();
const program = (device: GPUDevice, name: string, code: string): Promise<GPUComputePipeline> => {
  let cache = programs.get(device);
  if (!cache) programs.set(device, (cache = new Map()));
  let pipeline = cache.get(name);
  if (!pipeline) cache.set(name, (pipeline = compileBrush(device, code, `voxel-edit gpu ${name}`)));
  return pipeline;
};

/** Options of {@link GpuGrid.combine}: those of `combineGrids`. */
export interface GpuCombineOptions {
  operation: 'union' | 'intersect' | 'subtract';
  offset?: Vec3;
  paletteMap?: Uint8Array;
  overlap?: 'base' | 'tool';
}

const NO_INPUTS: PassInputs = {
  passes: 1,
  params: [],
  seed: 0,
  mask: null,
  tool: null,
  toolOffset: [0, 0, 0],
  table: null,
};

/**
 * A grid kept on the GPU for bulk edits. Edits queue compute passes and return at once (each later edit reads the
 * result of the one before); {@link GpuGrid.read} reads the cells back. `fill`, `combine`, `dilate`, `erode`, `smooth`
 * and `remap` give exactly the cells of `boxCells` or `sphereCells` stamped, `combineGrids`, `dilateGrid`, `erodeGrid`
 * (all six directions), the `smooth` shader brush and a palette lookup; `brush` runs any {@link ShaderBrush}.
 */
export class GpuGrid {
  readonly size: Vec3;
  readonly cells: number;
  #device: GPUDevice;
  #buffers: GridBuffers;
  #pipelines: Record<string, GPUComputePipeline>;
  #disposed = false;

  private constructor(device: GPUDevice, buffers: GridBuffers, pipelines: Record<string, GPUComputePipeline>) {
    this.#device = device;
    this.#buffers = buffers;
    this.size = buffers.size;
    this.cells = buffers.count;
    this.#pipelines = pipelines;
  }

  /**
   * Uploads `grid` to `device` (the grid is not kept).
   * @throws TypeError for a wrong device or grid; RangeError past `maxCells` (default 16,777,216, at most 67,108,864),
   * past 16,777,216 cells on one side, or past the device's storage binding limit.
   */
  static async create(device: GPUDevice, grid: VoxelGrid, limits: GridLimits = {}): Promise<GpuGrid> {
    if (!isDevice(device))
      throw new TypeError('GpuGrid.create needs a GPUDevice; pass (await adapter.requestDevice())');
    checkOptions(limits, 'GpuGrid.create');
    checkGrid(grid, cellLimit(limits));
    if (grid.size.some((v) => v > MAX_SIDE))
      throw new RangeError(
        `GpuGrid.create grid is ${grid.size.join(' x ')}; pass at most ${MAX_SIDE} cells per side (f32 cell bounds)`,
      );
    const names = { fill: FILL, combine: COMBINE, remap: REMAP, ...brushes },
      entries = await Promise.all(
        Object.entries(names).map(async ([name, code]) => [name, await program(device, name, code)] as const),
      );
    return new GpuGrid(device, new GridBuffers(device, grid, 'GpuGrid'), Object.fromEntries(entries));
  }

  /** Queues `name`; `skip` (an edit that changes no cell) queues nothing but still refuses a disposed grid. */
  #run(name: string, inputs: Partial<PassInputs>, skip = false): this {
    if (this.#disposed) throw new MargoError('disposed', 'GpuGrid is disposed; create a new one');
    if (!skip) this.#buffers.run(this.#pipelines[name], { ...NO_INPUTS, ...inputs });
    return this;
  }

  /**
   * Sets every cell of the box `[min, max)` (`shape: 'box'`, like `boxCells` with `max` exclusive) or within `radius`
   * of the cell `center` (`'sphere'`, like `sphereCells`) to `value` (0 erases). Cells outside the grid are skipped.
   */
  fill(
    shape: { shape: 'box'; min: Vec3; max: Vec3 } | { shape: 'sphere'; center: Vec3; radius: number },
    value: number,
  ): this {
    checkOptions(shape, 'GpuGrid.fill shape');
    checkPalette(value, 'GpuGrid.fill value', 0);
    if (shape.shape === 'box') {
      checkCell(shape.min, 'GpuGrid.fill min');
      checkCell(shape.max, 'GpuGrid.fill max');
      // Clipped to the grid on the CPU, so the corners stay whole f32 values whatever cells were passed.
      const lo = shape.min.map((v, a) => Math.min(Math.max(v, 0), this.size[a])),
        hi = shape.max.map((v, a) => Math.min(Math.max(v, 0), this.size[a]));
      return this.#run('fill', { params: [...lo, ...hi, value, 0] }, lo.some((v, a) => v >= hi[a]));
    }
    if (shape.shape !== 'sphere')
      throw new TypeError("GpuGrid.fill shape is unknown; pass {shape: 'box'} or {shape: 'sphere'}");
    if (!Array.isArray(shape.center) || shape.center.length !== 3 || !shape.center.every(Number.isFinite))
      throw new TypeError('GpuGrid.fill center must be three finite numbers; pass [x, y, z]');
    if (typeof shape.radius !== 'number' || !(shape.radius >= 0) || shape.radius > 128)
      throw new RangeError(`GpuGrid.fill radius is ${shape.radius}; pass 0 to 128`);
    // Whole-cell distances: d . d <= r^2 holds exactly when it holds for floor(r^2).
    const center = shape.center.map(Math.round) as [number, number, number],
      reach = Math.ceil(shape.radius),
      outside = center.some((c, a) => c + reach < 0 || c - reach >= this.size[a]);
    return this.#run(
      'fill',
      { toolOffset: center, params: [0, 0, 0, Math.floor(shape.radius * shape.radius), 0, 0, value, 1] },
      outside,
    );
  }

  /**
   * `combineGrids(this, tool, options)` on the GPU: union (with a `paletteMap`, `overlap` 'base' or 'tool'),
   * intersect or subtract of `tool` placed at `offset`. Returns the filled tool cells that fall outside (clipped).
   * @throws TypeError or RangeError as `combineGrids` does.
   */
  combine(tool: VoxelGrid, options: GpuCombineOptions): number {
    checkOptions(options, 'GpuGrid.combine');
    const cells = checkGrid(tool, Infinity, 'Tool grid'),
      { operation, offset = [0, 0, 0], paletteMap: map, overlap } = options;
    if (operation !== 'union' && operation !== 'intersect' && operation !== 'subtract')
      throw new TypeError("GpuGrid.combine operation is unknown; pass 'union', 'intersect' or 'subtract'");
    checkCell(offset, 'GpuGrid.combine offset');
    if (overlap !== undefined && overlap !== 'base' && overlap !== 'tool')
      throw new TypeError("GpuGrid.combine overlap is unknown; pass 'base' or 'tool'");
    if (operation === 'union') {
      if (!(map instanceof Uint8Array) || map.length !== 256)
        throw new TypeError('GpuGrid.combine union needs a paletteMap; pass 256 entries (see mergePalettes)');
      if (map[0] !== 0) throw new RangeError('GpuGrid.combine paletteMap fills air; keep entry 0 at 0');
      for (let i = 0; i < cells; i++)
        if (tool.voxels[i] && !map[tool.voxels[i]])
          throw new RangeError(`GpuGrid.combine paletteMap empties tool index ${tool.voxels[i]}; map it to 1-255`);
    }
    const op = operation === 'union' ? (overlap === 'tool' ? 1 : 0) : operation === 'intersect' ? 2 : 3;
    this.#run('combine', { params: [op], tool, toolOffset: offset, table: map ?? null });
    const [sx, sy, sz] = this.size,
      [tx, ty, tz] = tool.size;
    let clipped = 0;
    for (let y = 0; y < ty; y++)
      for (let z = 0; z < tz; z++)
        for (let x = 0; x < tx; x++) {
          if (!tool.voxels[x + tx * (z + tz * y)]) continue;
          const dx = x + offset[0],
            dy = y + offset[1],
            dz = z + offset[2];
          if (dx < 0 || dy < 0 || dz < 0 || dx >= sx || dy >= sy || dz >= sz) clipped++;
        }
    return clipped;
  }

  /** `dilateGrid` with all six directions: `iterations` passes (default 1), added cells `color` or their source's. */
  dilate(options: { iterations?: number; color?: number } = {}): this {
    checkOptions(options, 'GpuGrid.dilate');
    const passes = iterations(options.iterations, 'GpuGrid.dilate');
    if (options.color !== undefined) checkPalette(options.color, 'GpuGrid.dilate color');
    return passes ? this.#run('grow', { passes, params: [options.color ?? 0] }) : this;
  }

  /** `erodeGrid` with all six directions, `iterations` passes (default 1). */
  erode(options: { iterations?: number } = {}): this {
    checkOptions(options, 'GpuGrid.erode');
    const passes = iterations(options.iterations, 'GpuGrid.erode');
    return passes ? this.#run('erode', { passes }) : this;
  }

  /** The `smooth` shader brush (majority of the 27 cells around each), `iterations` passes (default 1). */
  smooth(options: { iterations?: number } = {}): this {
    checkOptions(options, 'GpuGrid.smooth');
    const passes = iterations(options.iterations, 'GpuGrid.smooth');
    return passes ? this.#run('smooth', { passes }) : this;
  }

  /** Replaces each cell's index `i` by `table[i]` (256 entries 0 to 255): recolour, isolate or delete colours. */
  remap(table: ArrayLike<number>): this {
    if (typeof table?.length !== 'number' || table.length !== 256)
      throw new TypeError('GpuGrid.remap table must hold 256 numbers; pass a Uint8Array(256)');
    for (let i = 0; i < 256; i++)
      if (!Number.isInteger(table[i]) || table[i] < 0 || table[i] > 255)
        throw new RangeError(`GpuGrid.remap table[${i}] is ${table[i]}; pass whole numbers 0 to 255`);
    return this.#run('remap', { table });
  }

  /** Runs a compiled {@link ShaderBrush} on the grid with the options of `ShaderBrush.run` (no `signal`). */
  brush(brush: ShaderBrush, options: Omit<ShaderBrushRunOptions, 'signal' | 'maxCells'> = {}): this {
    const entry = brushPipelines.get(brush);
    if (!entry)
      throw new TypeError('GpuGrid.brush needs a live ShaderBrush; pass await ShaderBrush.create(device, code)');
    if (entry.device !== this.#device)
      throw new TypeError("GpuGrid.brush brush was made on another device; create it with this grid's device");
    checkOptions(options, 'GpuGrid.brush');
    const inputs = brushInputs(options, this.cells, Infinity, 'GpuGrid.brush');
    if (this.#disposed) throw new MargoError('disposed', 'GpuGrid is disposed; create a new one');
    this.#buffers.run(entry.pipeline, inputs);
    return this;
  }

  /** Replaces every cell with `grid`'s, which must have this grid's size. */
  write(grid: VoxelGrid): this {
    if (this.#disposed) throw new MargoError('disposed', 'GpuGrid is disposed; create a new one');
    checkGrid(grid, Infinity);
    if (grid.size.some((v, i) => v !== this.size[i]))
      throw new RangeError(
        `GpuGrid.write grid is ${grid.size.join(' x ')}, not ${this.size.join(' x ')}; pass a grid of this size`,
      );
    this.#buffers.write(grid.voxels);
    return this;
  }

  /** Reads the cells back after every queued edit. @throws MargoError `'disposed'` after dispose(). */
  async read(options: { signal?: AbortSignal } = {}): Promise<VoxelGrid> {
    if (this.#disposed) throw new MargoError('disposed', 'GpuGrid is disposed; create a new one');
    return { size: [this.size[0], this.size[1], this.size[2]], voxels: await this.#buffers.read(options?.signal) };
  }

  /** Frees the GPU buffers. Calling it again does nothing. */
  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#buffers.destroy();
  }

  [Symbol.dispose](): void {
    this.dispose();
  }
}

function iterations(value: number | undefined, subject: string): number {
  const n = value ?? 1;
  if (!Number.isInteger(n) || n < 0 || n > 1024)
    throw new RangeError(`${subject} iterations must be an integer from 0 to 1024; pass one`);
  return n;
}
