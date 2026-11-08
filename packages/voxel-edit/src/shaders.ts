/// <reference lib="esnext.disposable" preserve="true" />
// @margoengine/voxel-edit/shaders: procedural shader brushes. A small WGSL function written by the user runs once per
// selected cell of a grid on the GPU (WebGPU compute), reading the cells around it, for grow, erode and generate
// brushes; passes read the result of the pass before. Presets in `brushes` match dilateGrid and erodeGrid exactly.
import type { Vec3 } from '@margoengine/math';
import { MargoError } from '@margoengine/math/errors';
import { brushPipelines, brushSource, compileBrush, GridBuffers, isDevice } from './brush-gpu.js';
import {
  checkCell,
  checkGrid,
  checkOptions,
  cellLimit,
  edited,
  type GridEdit,
  type GridLimits,
  type VoxelGrid,
} from './grid.js';

export { brushSource };

/** Options of {@link ShaderBrush.run}. */
export interface ShaderBrushRunOptions extends GridLimits {
  /** Cell indexes the brush runs on (any order, repeats allowed); the rest are copied. Default every cell. */
  selection?: ArrayLike<number>;
  /** Passes, 1 to 1,024; each reads the result of the one before. Default 1. */
  passes?: number;
  /** Up to 16 numbers the code reads as `param(0)` to `param(15)` (f32). Default all 0. */
  params?: readonly number[];
  /** Integer 0 to 2^32 - 1 the code's `hash` and `noise` mix in, so one brush gives different patterns. Default 0. */
  seed?: number;
  /** A second grid the code reads with `tool(q)` (its index at base cell q, 0 outside it). Default none. */
  tool?: VoxelGrid;
  /** Where the tool's cell (0, 0, 0) sits in the grid, in whole cells. Default [0, 0, 0]. */
  toolOffset?: Vec3;
  /** 256 numbers 0 to 255 the code reads with `lookup(i)`, such as a palette remap. Default all 0. */
  table?: ArrayLike<number>;
  /** Aborts the run before the GPU work is read back; the run then rejects with the signal's reason. */
  signal?: AbortSignal;
}

/**
 * Ready-made brush code. `grow` and `erode` give exactly `dilateGrid` and `erodeGrid` with all six directions (grow
 * takes the colour of the first neighbour in grid order, or `param(0)` when it is 1 to 255); `noise` fills cells where
 * value noise at `p * param(0)` exceeds `param(1)` with colour `param(2)`; `smooth` sets each cell to the filled or empty
 * state of most of its 26 neighbours and itself (filled cells taking the most common neighbour colour, the lowest on a
 * tie).
 */
export const brushes = {
  grow: /* wgsl */ `
fn brush(p: vec3<i32>, value: u32) -> u32 {
  if (value != 0u) { return value; }
  var best = 0u;
  var first = 2147483647;
  for (var d = 0; d < 6; d++) {
    let q = p + face_offset(d);
    let v = cell(q);
    if (v != 0u && cell_index(q) < first) { first = cell_index(q); best = v; }
  }
  if (best != 0u && param(0) >= 1.0) { return u32(param(0)); }
  return best;
}`,
  erode: /* wgsl */ `
fn brush(p: vec3<i32>, value: u32) -> u32 {
  if (value == 0u) { return 0u; }
  for (var d = 0; d < 6; d++) { if (cell(p + face_offset(d)) == 0u) { return 0u; } }
  return value;
}`,
  noise: /* wgsl */ `
fn brush(p: vec3<i32>, value: u32) -> u32 {
  if (noise((vec3<f32>(p) + 0.5) * param(0)) > param(1)) { return u32(param(2)); }
  return value;
}`,
  smooth: /* wgsl */ `
fn brush(p: vec3<i32>, value: u32) -> u32 {
  var filled = 0;
  for (var z = -1; z <= 1; z++) {
    for (var y = -1; y <= 1; y++) {
      for (var x = -1; x <= 1; x++) { if (cell(p + vec3<i32>(x, y, z)) != 0u) { filled++; } }
    }
  }
  if (filled < 14) { return 0u; }
  if (value != 0u) { return value; }
  var best = 0u;
  var most = 0;
  for (var z = -1; z <= 1; z++) {
    for (var y = -1; y <= 1; y++) {
      for (var x = -1; x <= 1; x++) {
        let v = cell(p + vec3<i32>(x, y, z));
        if (v == 0u) { continue; }
        var n = 0;
        for (var c = -1; c <= 1; c++) {
          for (var b = -1; b <= 1; b++) {
            for (var a = -1; a <= 1; a++) { if (cell(p + vec3<i32>(a, b, c)) == v) { n++; } }
          }
        }
        if (n > most || (n == most && v < best)) { most = n; best = v; }
      }
    }
  }
  return best;
}`,
} as const;

/**
 * A compiled shader brush: user WGSL defining `fn brush(p: vec3<i32>, value: u32) -> u32`, run on the GPU for every
 * selected cell of a grid. `p` is the cell, `value` its palette index (0 air); the return value (clamped to 255) is the
 * cell's new index. The code may call `cell(q)` (index at any cell, 0 outside), `inside(q)`, `cell_index(q)`,
 * `grid_size()`, `face_offset(0..5)` (-x, +x, -y, +y, -z, +z), `param(i)`, `pass_number()`, `tool(q)`, `lookup(i)`,
 * `hash(q, salt)` (0 to 1) and `noise(x)` (value noise 0 to 1). Every cell of a pass reads the grid as it was before that pass.
 */
export class ShaderBrush {
  readonly code: string;
  #device: GPUDevice;
  #pipeline: GPUComputePipeline;
  #disposed = false;

  private constructor(device: GPUDevice, code: string, pipeline: GPUComputePipeline) {
    this.#device = device;
    this.code = code;
    this.#pipeline = pipeline;
    brushPipelines.set(this, { device, pipeline });
  }

  /**
   * Compiles `code` on `device`; `label` (default 'shader brush') names its GPU objects in debuggers and errors.
   * @throws TypeError when `device` is not a GPUDevice or `code` defines no `fn brush`.
   * @throws MargoError `'failed'` when the code does not compile, naming the line of `code` and WGSL's message.
   */
  static async create(
    device: GPUDevice,
    code: string,
    options: { signal?: AbortSignal; label?: string } = {},
  ): Promise<ShaderBrush> {
    if (!isDevice(device))
      throw new TypeError('ShaderBrush.create needs a GPUDevice; pass (await adapter.requestDevice())');
    brushSource(code); // refuses code without fn brush before touching the device
    options?.signal?.throwIfAborted();
    const label = options?.label ?? 'shader brush';
    if (typeof label !== 'string')
      throw new TypeError('ShaderBrush label must be a string; pass a name for GPU debugging');
    const pipeline = await compileBrush(device, code, label);
    options?.signal?.throwIfAborted();
    return new ShaderBrush(device, code, pipeline);
  }

  /**
   * Runs the brush over `grid` (unchanged) and resolves to the new grid, the cells that changed and `clipped` 0.
   * @throws TypeError or RangeError for a bad grid or option, or a grid larger than the device's storage binding limit.
   * @throws MargoError `'disposed'` after dispose(); rejects with the signal's reason when aborted.
   */
  async run(grid: VoxelGrid, options: ShaderBrushRunOptions = {}): Promise<GridEdit> {
    if (this.#disposed) throw new MargoError('disposed', 'ShaderBrush is disposed; create a new one');
    checkOptions(options, 'ShaderBrush.run');
    const count = checkGrid(grid, cellLimit(options)),
      { selection, passes = 1, params = [], seed = 0, signal } = options;
    if (!Number.isInteger(passes) || passes < 1 || passes > 1024)
      throw new RangeError(`ShaderBrush passes is ${passes}; pass a whole number from 1 to 1024`);
    if (
      !Array.isArray(params) ||
      params.length > 16 ||
      !params.every((v) => typeof v === 'number' && Number.isFinite(v))
    )
      throw new TypeError('ShaderBrush params must be up to 16 finite numbers; pass an array such as [0.1, 0.5, 3]');
    if (!Number.isInteger(seed) || seed < 0 || seed > 0xffffffff)
      throw new RangeError(`ShaderBrush seed is ${seed}; pass a whole number from 0 to 4294967295`);
    const tool = options.tool,
      toolOffset = options.toolOffset ?? [0, 0, 0],
      table = options.table;
    if (tool !== undefined) checkGrid(tool, cellLimit(options), 'ShaderBrush tool');
    checkCell(toolOffset, 'ShaderBrush toolOffset');
    if (table !== undefined) {
      if (typeof table?.length !== 'number' || table.length !== 256)
        throw new TypeError('ShaderBrush table must hold 256 numbers; pass a Uint8Array(256)');
      for (let i = 0; i < 256; i++)
        if (!Number.isInteger(table[i]) || table[i] < 0 || table[i] > 255)
          throw new RangeError(`ShaderBrush table[${i}] is ${table[i]}; pass whole numbers 0 to 255`);
    }
    let mask: Uint8Array | null = null;
    if (selection !== undefined) {
      if (typeof selection?.length !== 'number')
        throw new TypeError('ShaderBrush selection must be cell indexes; pass a Float64Array');
      mask = new Uint8Array(Math.ceil(count / 4) * 4);
      for (let i = 0; i < selection.length; i++) {
        const c = selection[i];
        if (!Number.isInteger(c) || c < 0 || c >= count)
          throw new RangeError(
            `ShaderBrush selection holds ${c}, not a cell index of this grid; pass 0 to ${count - 1}`,
          );
        mask[c] = 1;
      }
    }
    signal?.throwIfAborted();
    const buffers = new GridBuffers(this.#device, grid, 'ShaderBrush');
    try {
      buffers.run(this.#pipeline, { passes, params, seed, mask, tool: tool ?? null, toolOffset, table: table ?? null });
      return edited(grid, await buffers.read(signal), 0);
    } finally {
      buffers.destroy();
    }
  }

  /** Lets the pipeline go; `run` then throws. Calling it again does nothing. */
  dispose(): void {
    this.#disposed = true;
    brushPipelines.delete(this);
  }

  [Symbol.dispose](): void {
    this.dispose();
  }
}
