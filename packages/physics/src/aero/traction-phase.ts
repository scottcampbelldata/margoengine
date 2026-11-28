import { MargoError } from '@margoengine/math/errors';
import type { Wrench } from '../held.js';
import type { Vec3 } from '../math.js';
import type { NativePhasePool } from '../native-phase-pool.js';
import { Arena, STACK_BYTES, worldMemory } from '../world/memory.js';
import type { Region } from '../world/solver.js';

const U32 = Uint32Array.BYTES_PER_ELEMENT;
const F64 = Float64Array.BYTES_PER_ELEMENT;
const PANEL_WORDS = 11;
const MOTION_WORDS = 6;
const RECEIPT_WORDS = 3;
const PROBES = 1 + 2 * MOTION_WORDS;
const JOB_WORDS = 6;
// Use implicitWrench's central-difference velocity and angular-velocity increment.
const DIFFERENCE = 1e-3;

interface Panels {
  readonly arms: Float64Array;
  readonly normals: Float64Array;
  readonly winds: Float64Array;
  readonly densities: Float64Array;
  readonly areas: Float64Array;
  readonly normalCoefficient: number;
  readonly frictionCoefficient: number;
}

export interface WindTractionWorkerWork {
  readonly probes: number;
  readonly panels: number;
  readonly simdPanelPairs: number;
}

export interface WindTractionWorkCounts extends WindTractionWorkerWork {
  readonly threads: number;
  readonly workers: readonly WindTractionWorkerWork[];
}

export interface WindTractionPhaseOptions {
  readonly threads?: number;
  readonly signal?: AbortSignal;
}

async function compile(url: URL, signal?: AbortSignal): Promise<WebAssembly.Module> {
  try {
    let bytes: BufferSource;
    if (url.protocol === 'file:') {
      url.search = '';
      const fs = 'node:fs/promises';
      const { readFile } = await import(/* @vite-ignore */ /* webpackIgnore: true */ fs);
      bytes = await readFile(url, { signal });
    } else {
      const response = await fetch(url, { signal });
      if (!response.ok)
        throw new MargoError('failed', `Wind traction asset returned HTTP ${response.status}. Serve its Wasm file.`);
      bytes = await response.arrayBuffer();
    }
    const module = await WebAssembly.compile(bytes);
    signal?.throwIfAborted();
    return module;
  } catch (cause) {
    signal?.throwIfAborted();
    if (cause instanceof MargoError) throw cause;
    throw Object.assign(new MargoError('failed', 'Serve the wind traction Wasm asset in a SIMD-capable runtime.'), {
      cause,
    });
  }
}

function stackTop(arena: Arena, name: string): number {
  const stack = arena.allocate(name, STACK_BYTES + 8, 'u8', 1);
  return Math.floor((stack.byteOffset + stack.byteLength) / 16) * 16;
}

function stencilIndex(dv: Vec3, dw: Vec3): number {
  let probe = 0;
  for (let column = 0; column < MOTION_WORDS; column++) {
    const value = column < 3 ? dv[column] : dw[column - 3];
    if (value === 0) continue;
    if (probe !== 0 || (value !== DIFFERENCE && value !== -DIFFERENCE))
      throw new MargoError('state', 'Use the wind traction callback with implicitWrench’s fixed derivative stencil.');
    probe = 1 + 2 * column + Number(value < 0);
  }
  return probe;
}

/** Synchronous batched loads from private Wasm scratch, with no writes to accepted rigid/world state. */
export class WindTractionPhase {
  private readonly arena: Arena;
  private readonly motion: Region;
  private readonly output: Region;
  private readonly receipts: Region;
  private readonly job: Region;
  private readonly phase: (job: number, stage: number, part: number, parts: number) => number;
  private readonly completed: Float64Array;
  private readonly threads: number;
  private panels: Region;
  private count = -1;
  private disposed = false;

  private constructor(
    module: WebAssembly.Module,
    private readonly pool?: NativePhasePool,
  ) {
    const threads = pool?.count ?? 1;
    const memory = worldMemory(threads > 1);
    const arena = new Arena(memory);
    this.arena = arena;
    this.threads = threads;
    this.completed = new Float64Array(threads * RECEIPT_WORDS);
    this.job = arena.allocate('wind-traction-job', JOB_WORDS * U32 + 2 * F64, 'u32', 1);
    this.motion = arena.allocate('wind-traction-motion', MOTION_WORDS * PROBES * F64, 'f64', 1);
    this.output = arena.allocate('wind-traction-output', MOTION_WORDS * PROBES * F64, 'f64', 1);
    this.receipts = arena.allocate('wind-traction-receipts', this.completed.length * U32, 'u32', 1);
    this.panels = arena.allocate('wind-traction-panels', PANEL_WORDS * F64, 'f64', 1);
    const leaderStack = stackTop(arena, 'wind-traction-stack');
    const { exports } = new WebAssembly.Instance(module, { env: { memory } });
    const pointer = exports.__stack_pointer;
    const phase = exports.wind_traction_thread_phase;
    if (!(pointer instanceof WebAssembly.Global) || typeof phase !== 'function')
      throw new MargoError('failed', 'Rebuild the wind traction Wasm asset with its matching phase and stack ABI.');
    pointer.value = leaderStack;
    this.phase = phase as WindTractionPhase['phase'];
    if (pool) {
      const control = arena.allocate('wind-traction-control', pool.controlWords * U32, 'i32', 1);
      const stackTops = Array.from({ length: threads - 1 }, (_, part) =>
        stackTop(arena, `wind-traction-stack-${part}`),
      );
      pool.init({ module, memory, control: control.byteOffset, job: this.job.byteOffset, stackTops });
    }
  }

  static async load({ threads = 1, signal }: WindTractionPhaseOptions = {}): Promise<WindTractionPhase> {
    signal?.throwIfAborted();
    if (!Number.isSafeInteger(threads) || threads < 1 || threads > PROBES)
      throw new MargoError('state', 'Invalid wind traction threads. Choose a whole count from 1 through 13 probes.');
    const url =
      threads > 1
        ? new URL(/* @vite-ignore */ './wind-traction-kernel-shared.wasm?no-inline', import.meta.url)
        : new URL(/* @vite-ignore */ './wind-traction-kernel.wasm?no-inline', import.meta.url);
    const module = await compile(url, signal);
    if (threads === 1) return new WindTractionPhase(module);
    const { createNativePhasePool } = await import('../native-phase-pool.js');
    const pool = await createNativePhasePool(threads, {
      subject: 'Wind traction',
      phaseExport: 'wind_traction_thread_phase',
      signal,
    });
    try {
      const phase = new WindTractionPhase(module, pool);
      signal?.throwIfAborted();
      return phase;
    } catch (error) {
      pool.close();
      throw error;
    }
  }

  prepare({ arms, normals, winds, densities, areas, normalCoefficient, frictionCoefficient }: Panels): void {
    if (this.disposed) throw new MargoError('state', 'Load a new wind traction phase before preparing panels.');
    const count = areas.length;
    const bytes = count * PANEL_WORDS * F64;
    if (
      3 * count !== arms.length ||
      arms.length !== normals.length ||
      arms.length !== winds.length ||
      count !== densities.length
    )
      throw new MargoError('state', 'Pass one arm, normal, air velocity, density and area for each wind panel.');
    if (bytes > this.panels.byteLength) this.panels = this.arena.resize(this.panels, bytes);
    const buffer = this.arena.memory.buffer;
    const panels = new Float64Array(buffer, this.panels.byteOffset, count * PANEL_WORDS);
    for (let i = 0; i < count; i++) {
      const from = 3 * i;
      const into = PANEL_WORDS * i;
      for (let c = 0; c < 3; c++) {
        panels[into + c] = arms[from + c]!;
        panels[into + 3 + c] = normals[from + c]!;
        panels[into + 6 + c] = winds[from + c]!;
      }
      panels[into + 9] = densities[i]!;
      panels[into + 10] = areas[i]!;
    }
    const header = new Uint32Array(buffer, this.job.byteOffset, JOB_WORDS);
    header[0] = this.panels.byteOffset;
    header[1] = this.motion.byteOffset;
    header[2] = this.output.byteOffset;
    header[3] = this.receipts.byteOffset;
    header[4] = count;
    const coefficients = new Float64Array(buffer, this.job.byteOffset + JOB_WORDS * U32, 2);
    coefficients[0] = normalCoefficient;
    coefficients[1] = frictionCoefficient;
    this.count = count;
  }

  evaluate(v0: Vec3, w0: Vec3, derivatives: boolean): Wrench {
    if (this.disposed || this.count < 0)
      throw new MargoError(
        'state',
        'Prepare the panel data on an open wind traction phase before evaluating the wrench.',
      );
    const count = derivatives ? PROBES : 1;
    const ptr = this.job.byteOffset;
    const buffer = this.arena.memory.buffer;
    const velocities = new Float64Array(buffer, this.motion.byteOffset, MOTION_WORDS * count);
    for (let probe = 0; probe < count; probe++) {
      const column = Math.floor((probe - 1) / 2);
      const increment = probe % 2 === 1 ? DIFFERENCE : -DIFFERENCE;
      for (let i = 0; i < MOTION_WORDS; i++)
        velocities[probe * MOTION_WORDS + i] = (i < 3 ? v0[i]! : w0[i - 3]!) + (i === column ? increment : 0);
    }
    new Uint32Array(buffer, ptr, JOB_WORDS)[5] = count;
    const receipts = new Uint32Array(buffer, this.receipts.byteOffset, this.completed.length);
    receipts.fill(0);
    const pool = derivatives ? this.pool : undefined;
    const status = pool ? pool.phase(0, () => this.phase(ptr, 0, 0, pool.count)) : this.phase(ptr, 0, 0, 1);
    if (status === 1)
      throw new MargoError(
        'state',
        'Wind traction exceeds finite f64 range. Reduce the wind, velocity, panel area or coefficients.',
      );
    if (status !== 0)
      throw new MargoError('failed', 'Rebuild matching wind traction assets before dispatching panel probes.');
    let probes = 0;
    for (let i = 0; i < receipts.length; i += RECEIPT_WORDS) {
      const rows = receipts[i]!;
      probes += rows;
      if (receipts[i + 1] !== rows * this.count || receipts[i + 2] !== rows * Math.floor(this.count / 2))
        throw new MargoError('failed', 'Rebuild wind traction assets so each worker returns its expected panel work.');
    }
    if (probes !== count)
      throw new MargoError('failed', 'Rebuild wind traction assets so workers execute every requested wrench probe.');
    const results = new Float64Array(buffer, this.output.byteOffset, MOTION_WORDS * count).slice();
    if (!results.every(Number.isFinite))
      throw new MargoError(
        'state',
        'Wind traction is outside finite f64 range. Reduce the wind, velocity or coefficients.',
      );
    for (let i = 0; i < receipts.length; i++) this.completed[i]! += receipts[i]!;
    return (dv, dw) => {
      const probe = stencilIndex(dv, dw);
      if (probe >= count)
        throw new MargoError('state', 'Prepare the full wind traction derivative stencil before using implicitWrench.');
      const i = probe * MOTION_WORDS;
      return [
        [results[i]!, results[i + 1]!, results[i + 2]!],
        [results[i + 3]!, results[i + 4]!, results[i + 5]!],
      ];
    };
  }

  workCounts(): WindTractionWorkCounts {
    let probes = 0;
    let panels = 0;
    let simdPanelPairs = 0;
    const workers = Array.from({ length: this.threads }, (_, part) => {
      const i = part * RECEIPT_WORDS;
      const worker = {
        probes: this.completed[i]!,
        panels: this.completed[i + 1]!,
        simdPanelPairs: this.completed[i + 2]!,
      };
      probes += worker.probes;
      panels += worker.panels;
      simdPanelPairs += worker.simdPanelPairs;
      return worker;
    });
    return { threads: this.threads, probes, panels, simdPanelPairs, workers };
  }

  dispose(): void {
    this.disposed = true;
    this.pool?.close();
  }
}
