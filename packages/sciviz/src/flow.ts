// CPU transport foundation for batch 171. Research: docs/clean-room.md. No renderer or Wasm load on import.
import { fault, rangeError, wasmError } from '../../shared/errors.js';

/** A velocity snapshot, in distance units per time unit. Components are planar, x fastest. */
export interface FlowFrame {
  /** Finite time, strictly increasing between frames. One frame describes a steady field at every time. */
  readonly time: number;
  /** x velocity at every sample. NaN marks missing data; infinity is rejected. */
  readonly u: Float32Array;
  /** y velocity at every sample. */
  readonly v: Float32Array;
  /** z velocity; default zero. */
  readonly w?: Float32Array;
}

/** Regular, stationary sampling grid for a steady or time-varying velocity field. */
export interface FlowGrid {
  /** x/y sample counts at least two, z at least one. */
  readonly dims: readonly [number, number, number];
  /** First/last sample positions [xmin,xmax,ymin,ymax,zmin,zmax]. Ascending; equal z bounds for a 2D grid. */
  readonly bounds: readonly [number, number, number, number, number, number];
  /** At least one snapshot. All frames share the grid. Do not mutate input until the call settles. */
  readonly frames: readonly FlowFrame[];
}

/** Physical-time integration controls; no velocity normalisation or temporal extrapolation. */
export interface FlowTraceOptions {
  /** Particle release time. */
  readonly from: number;
  /** End time, earlier than from for backward tracing. Must lie in the frame range for unsteady fields. */
  readonly to: number;
  /** Maximum positive time step; shortened at frame boundaries and at the end. */
  readonly step: number;
  /** Maximum accepted RK4 steps, including shortened steps. Default 10000, maximum 1000000. */
  readonly maxSteps?: number;
  /** Cancels loading, copying and integration with the exact reason. Default absent. */
  readonly signal?: AbortSignal;
}

/** Caller-owned samples, independent of the input and the disposed feature-local Wasm instance. */
export interface FlowTrace {
  /** Packed x,y,z,time in float64, including the seed if valid. The last sample is the last accepted step. */
  readonly samples: Float64Array;
  /** `end`: reached to; `invalid`: a stage/endpoint left the grid or touched missing data; `steps`: budget exhausted. */
  readonly stop: 'end' | 'invalid' | 'steps';
}

interface FlowKernel {
  memory: WebAssembly.Memory;
  reserve(bytes: number): number;
  validate(data: number, start: number, end: number): number;
  trace(
    values: number,
    dims: number,
    bounds: number,
    times: number,
    frames: number,
    state: number,
    output: number,
    to: number,
    step: number,
    limit: number,
  ): number;
}

const CHUNK = 128;
const COPY_CHUNK = 16_384;
const BUDGET = 128 * 1024 * 1024;
const yieldTask = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

async function kernel(signal?: AbortSignal): Promise<FlowKernel> {
  const url = new URL(/* @vite-ignore */ './flow.wasm?no-inline', import.meta.url);
  try {
    let binary: Uint8Array<ArrayBuffer>;
    if (url.protocol !== 'file:') {
      const response = await fetch(url, { signal });
      if (!response.ok) throw fault('failed', `Flow Wasm HTTP ${response.status}; serve the package assets`, 'sciviz');
      binary = new Uint8Array(await response.arrayBuffer());
    } else {
      url.search = '';
      const nodeFs = 'node:fs/promises';
      const fs = await import(/* @vite-ignore */ /* webpackIgnore: true */ nodeFs);
      binary = await fs.readFile(url, { signal });
    }
    signal?.throwIfAborted();
    const loaded = await WebAssembly.instantiate(binary);
    signal?.throwIfAborted();
    return loaded.instance.exports as unknown as FlowKernel;
  } catch (cause) {
    signal?.throwIfAborted();
    const translated = wasmError(cause);
    if (translated !== cause || (cause instanceof Error && cause.name === 'MargoError')) throw translated;
    throw Object.assign(fault('failed', 'Flow Wasm could not load; serve valid package assets', 'sciviz'), { cause });
  }
}

/**
 * Traces a particle through bilinear/trilinear, linearly time-interpolated velocities with classical RK4.
 * Work is in a feature-local Rust/Wasm module, bounded to 128 steps per task. Each call owns a fresh instance,
 * leaves no retained resource after settling and needs no explicit disposal. Concurrent calls share no mutable state.
 * Component copies and output/working buffers together must fit 128 MiB, excluding module overhead and caller input.
 * @throws A help-linked RangeError for malformed grids, times, steps or budgets; coded `failed` for Wasm loading.
 */
export async function tracePathline(
  grid: FlowGrid,
  seed: readonly [number, number, number],
  options: FlowTraceOptions,
): Promise<FlowTrace> {
  const signal = options?.signal;
  signal?.throwIfAborted();
  const fail = (message: string): never => {
    throw rangeError(message, 'sciviz');
  };
  const dims = grid?.dims;
  if (!dims || dims.length !== 3 || dims.some((n, i) => !Number.isSafeInteger(n) || n < (i === 2 ? 1 : 2)))
    fail('Flow dims need integer x/y counts of at least 2 and z of at least 1');
  const bounds = grid.bounds;
  if (!bounds || bounds.length !== 6 || bounds.some((x) => !Number.isFinite(x)))
    fail('Flow bounds need six finite first/last sample coordinates');
  for (let i = 0; i < 3; i++) {
    const width = bounds[i * 2 + 1] - bounds[i * 2];
    if (!Number.isFinite(width) || (dims[i] === 1 ? width !== 0 : width <= 0))
      fail('Flow bounds must ascend on sampled axes and be equal on the singleton z axis');
  }
  const frames = grid.frames;
  if (!frames?.length || frames.length > 4096) fail('Flow needs 1 to 4096 velocity frames');
  const size = dims[0] * dims[1] * dims[2];
  const max = options?.maxSteps ?? 10_000;
  if (!Number.isInteger(max) || max < 1 || max > 1_000_000) fail('Flow maxSteps must be an integer from 1 to 1000000');
  const bytes = size * frames.length * 12;
  if (!Number.isSafeInteger(bytes) || bytes + (max + 1) * 64 + CHUNK * 32 + frames.length * 8 + 96 > BUDGET)
    fail('Flow input and output exceed the 128 MiB working budget; reduce the grid, frames or maxSteps');
  for (let i = 0; i < frames.length; i++) {
    const f = frames[i];
    if (
      !f ||
      !Number.isFinite(f.time) ||
      (i > 0 && (!(f.time > frames[i - 1].time) || !Number.isFinite(f.time - frames[i - 1].time)))
    )
      fail('Flow frame times must be finite, strictly increasing, with finite differences');
    for (const a of [f.u, f.v, f.w])
      if (a !== undefined && (!(a instanceof Float32Array) || a.length !== size))
        fail('Flow components must be Float32Arrays with one value per grid sample');
    if (!f.u || !f.v) fail('Flow frames need both u and v components');
  }
  const from = options?.from,
    to = options?.to,
    step = options?.step;
  if (
    !Number.isFinite(from) ||
    !Number.isFinite(to) ||
    !Number.isFinite(to - from) ||
    !Number.isFinite(step) ||
    step <= 0
  )
    fail('Flow from/to must be finite and step must be a positive finite time interval');
  if (!seed || seed.length !== 3 || seed.some((x) => !Number.isFinite(x)))
    fail('Flow seed needs three finite coordinates');
  if (frames.length > 1 && (Math.min(from, to) < frames[0].time || Math.max(from, to) > frames.at(-1)!.time))
    fail('Flow trace times must lie inside the frame range; provide covering frames');
  const k = await kernel(signal);
  const base = k.reserve(Math.ceil(bytes / 8) * 8 + frames.length * 8 + 96 + CHUNK * 32);
  if (!base) throw fault('failed', 'Flow memory could not grow; use a smaller grid or fewer frames', 'sciviz');
  let next = base;
  const alloc = (bytes: number) => {
    const pointer = next;
    next += Math.ceil(bytes / 8) * 8;
    return pointer;
  };
  try {
    const data = alloc(bytes),
      dimensions = alloc(12),
      box = alloc(48),
      times = alloc(frames.length * 8);
    const state = alloc(32),
      output = alloc(CHUNK * 32);
    new Uint32Array(k.memory.buffer, dimensions, 3).set(dims);
    new Float64Array(k.memory.buffer, box, 6).set(bounds);
    new Float64Array(k.memory.buffer, times, frames.length).set(frames.map((f) => f.time));
    for (let frame = 0; frame < frames.length; frame++) {
      const f = frames[frame];
      for (const [component, a] of [f.u, f.v, f.w].entries()) {
        if (!a) continue; // allocation is zero-initialised
        for (let start = 0; start < size; start += COPY_CHUNK) {
          signal?.throwIfAborted();
          const end = Math.min(size, start + COPY_CHUNK),
            index = (frame * 3 + component) * size + start;
          new Float32Array(k.memory.buffer, data + index * 4, end - start).set(a.subarray(start, end));
          if (!k.validate(data, index, index + end - start))
            fail('Flow velocities must be finite or NaN; remove infinite samples');
          await yieldTask();
        }
      }
    }
    signal?.throwIfAborted();
    new Float64Array(k.memory.buffer, state, 4).set([...seed, from]);
    const call = (limit: number) =>
      k.trace(data, dimensions, box, times, frames.length, state, output, to, step, limit);
    // Validate the seed without taking a step, even when from == to.
    if ((call(0) & 3) === 2) return { samples: new Float64Array(), stop: 'invalid' };
    const samples = new Float64Array((max + 1) * 4);
    samples.set([...seed, from]);
    let count = 1,
      status = from === to ? 1 : 0;
    while (status === 0 && count <= max) {
      signal?.throwIfAborted();
      const result = call(Math.min(CHUNK, max - count + 1));
      status = result & 3;
      const added = result >>> 2;
      samples.set(new Float64Array(k.memory.buffer, output, added * 4), count * 4);
      count += added;
      if (status === 3) fail('Flow step cannot advance this time value; use a larger time step or relative times');
      await yieldTask();
    }
    signal?.throwIfAborted();
    return { samples: samples.slice(0, count * 4), stop: status === 1 ? 'end' : status === 2 ? 'invalid' : 'steps' };
  } catch (error) {
    throw wasmError(error);
  }
}
