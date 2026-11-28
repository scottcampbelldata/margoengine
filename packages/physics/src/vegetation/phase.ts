import { MargoError } from '@margoengine/math/errors';
import type { NativePhasePool } from '../native-phase-pool.js';
import { canShareMemory, isShared, STACK_BYTES } from '../world/memory.js';
import type { Region, SolverHost } from '../world/solver.js';

const U32 = Uint32Array.BYTES_PER_ELEMENT;
const F64 = Float64Array.BYTES_PER_ELEMENT;
const JOB_HEADER_WORDS = 10;
const JOB_BYTES = JOB_HEADER_WORDS * U32 + 3 * F64;
const RECEIPT_WORDS = 3;

export interface PlantSwayPhaseOptions {
  readonly threads?: number;
  readonly signal?: AbortSignal;
}

export interface PlantSwayWorkerWork {
  readonly plants: number;
  readonly integratedPlants: number;
  readonly midpointSubsteps: number;
  readonly simdModePairs: number;
}

export interface PlantSwayWorkCounts extends PlantSwayWorkerWork {
  readonly threads: number;
  readonly workers: readonly PlantSwayWorkerWork[];
}

interface Kernel {
  vegetation_apply(job: number): number;
  vegetation_thread_phase(job: number, stage: number, part: number, parts: number): number;
}

interface Binding {
  readonly host: SolverHost;
  readonly job: Region;
  readonly receipts: Region;
  readonly kernel: Kernel;
}

async function compile(url: URL, signal?: AbortSignal): Promise<WebAssembly.Module> {
  try {
    signal?.throwIfAborted();
    let bytes: BufferSource;
    if (url.protocol === 'file:') {
      url.search = '';
      const fs = 'node:fs/promises';
      const { readFile } = await import(/* @vite-ignore */ /* webpackIgnore: true */ fs);
      bytes = await readFile(url, { signal });
    } else {
      const response = await fetch(url, { signal });
      if (!response.ok)
        throw new MargoError(
          'failed',
          'Vegetation kernel request failed; serve the vegetation Wasm asset with the app.',
        );
      bytes = await response.arrayBuffer();
    }
    const module = await WebAssembly.compile(bytes);
    signal?.throwIfAborted();
    return module;
  } catch (cause) {
    signal?.throwIfAborted();
    if (cause instanceof MargoError) throw cause;
    throw Object.assign(
      new MargoError(
        'failed',
        'Vegetation Wasm could not load; use a SIMD-capable runtime and serve the vegetation Wasm asset.',
      ),
      { cause },
    );
  }
}

function stackTop(host: SolverHost, name: string): number {
  const stack = host.allocate(name, STACK_BYTES + 8, 'u8', 1);
  return Math.floor((stack.byteOffset + stack.byteLength) / 16) * 16;
}

/** Native candidate updates. The solver's host accepts the result after the entire phase succeeds. */
export class PlantSwayPhase {
  private binding?: Binding;
  private disposed = false;
  private readonly completed: Float64Array;

  private constructor(
    private readonly plain: WebAssembly.Module,
    private readonly shared: WebAssembly.Module | undefined,
    private readonly pool?: NativePhasePool,
  ) {
    this.completed = new Float64Array(RECEIPT_WORDS * (pool?.count ?? 1));
  }

  static async load({ threads = 1, signal }: PlantSwayPhaseOptions = {}): Promise<PlantSwayPhase> {
    if (!Number.isSafeInteger(threads) || threads < 1)
      throw new MargoError('state', 'Invalid plant sway thread count. Choose a positive whole number.');
    if (threads > 1 && !canShareMemory())
      throw new MargoError('unsupported', 'Use a shared-memory host for plant sway workers or threads: 1.');
    const [plain, shared] = await Promise.all([
      compile(new URL(/* @vite-ignore */ './vegetation-kernel.wasm?no-inline', import.meta.url), signal),
      canShareMemory()
        ? compile(new URL(/* @vite-ignore */ './vegetation-kernel-shared.wasm?no-inline', import.meta.url), signal)
        : undefined,
    ]);
    if (threads === 1) return new PlantSwayPhase(plain, shared);
    const { createNativePhasePool } = await import('../native-phase-pool.js');
    const pool = await createNativePhasePool(threads, {
      subject: 'Plant sway',
      phaseExport: 'vegetation_thread_phase',
      signal,
    });
    return new PlantSwayPhase(plain, shared, pool);
  }

  bind(host: SolverHost): void {
    if (this.binding || this.disposed)
      throw new MargoError('state', 'Plant sway workers are already bound or disposed. Load a new PlantSway solver.');
    const shared = isShared(host.memory);
    const module = shared ? this.shared : this.plain;
    if (!module || (this.pool && !shared))
      throw new MargoError('unsupported', 'Use worldMemory(true) for plant sway workers or set threads: 1.');
    const job = host.allocate('vegetation-worker-job', JOB_BYTES, 'u32', 1);
    const receipts = host.allocate('vegetation-work-receipts', this.completed.length * F64, 'f64', 1);
    const leaderStack = stackTop(host, 'vegetation-kernel-stack');
    const { exports } = new WebAssembly.Instance(module, { env: { memory: host.memory } });
    const pointer = exports.__stack_pointer;
    if (
      !(pointer instanceof WebAssembly.Global) ||
      typeof exports.vegetation_apply !== 'function' ||
      typeof exports.vegetation_thread_phase !== 'function'
    )
      throw new MargoError('failed', 'Vegetation Wasm has missing modal exports. Rebuild the vegetation assets.');
    pointer.value = leaderStack;
    new Uint32Array(host.memory.buffer, job.byteOffset, JOB_HEADER_WORDS)[8] = receipts.byteOffset;
    const pool = this.pool;
    if (pool) {
      const control = host.allocate('vegetation-worker-control', U32 * pool.controlWords, 'i32', 1);
      const stackTops = Array.from({ length: pool.count - 1 }, (_, i) => stackTop(host, `vegetation-stack-${i + 1}`));
      pool.init({ module, memory: host.memory, job: job.byteOffset, control: control.byteOffset, stackTops });
    }
    this.binding = { host, job, receipts, kernel: exports as unknown as Kernel };
  }

  apply(
    models: number,
    stations: number,
    sections: number,
    samples: number,
    current: number,
    work: number,
    impulses: number,
    count: number,
    dt: number,
    gravity: number,
    tick: number,
  ): number {
    if (!this.binding || this.disposed)
      throw new MargoError('state', 'Plant sway execution is unavailable. Attach a fresh solver before stepping.');
    if (!Number.isSafeInteger(count) || count < 0 || count > 0xffffffff || current === work) return 2;
    const { host, job, receipts, kernel } = this.binding;
    const ptr = job.byteOffset;
    const { buffer } = host.memory;
    const header = new Uint32Array(buffer, ptr, 8);
    header[0] = models;
    header[1] = stations;
    header[2] = sections;
    header[3] = samples;
    header[4] = current;
    header[5] = work;
    header[6] = impulses;
    header[7] = count;
    const parameters = new Float64Array(buffer, ptr + JOB_HEADER_WORDS * U32, 3);
    parameters[0] = dt;
    parameters[1] = gravity;
    parameters[2] = tick;
    const pool = this.pool;
    const status = pool
      ? pool.phase(0, () => kernel.vegetation_thread_phase(ptr, 0, 0, pool.count))
      : kernel.vegetation_apply(ptr);
    if (status !== 0) return status;
    const native = new Float64Array(buffer, receipts.byteOffset, this.completed.length);
    let plants = 0;
    let substeps = 0;
    for (let i = 0; i < native.length; i += RECEIPT_WORDS) {
      const rows = native[i]!;
      const integrated = native[i + 1]!;
      const steps = native[i + 2]!;
      if (
        ![rows, integrated, steps].every(Number.isSafeInteger) ||
        integrated < 0 ||
        integrated > rows ||
        steps < integrated
      )
        throw new MargoError(
          'failed',
          'Vegetation Wasm reported invalid integration work. Rebuild the vegetation assets.',
        );
      plants += rows;
      substeps += steps;
    }
    if (plants !== count)
      throw new MargoError('failed', 'Vegetation workers missed plants. Rebuild the vegetation assets.');
    if (!Number.isSafeInteger(2 * substeps)) return 2;
    this.completed.set(native);
    return 0;
  }

  workCounts(): PlantSwayWorkCounts {
    const threads = this.completed.length / RECEIPT_WORDS;
    let plants = 0;
    let integratedPlants = 0;
    let midpointSubsteps = 0;
    const workers = Array.from({ length: threads }, (_, part) => {
      const at = RECEIPT_WORDS * part;
      const rows = this.completed[at]!;
      const integrated = this.completed[at + 1]!;
      const steps = this.completed[at + 2]!;
      plants += rows;
      integratedPlants += integrated;
      midpointSubsteps += steps;
      return { plants: rows, integratedPlants: integrated, midpointSubsteps: steps, simdModePairs: 2 * steps };
    });
    return { threads, plants, integratedPlants, midpointSubsteps, simdModePairs: 2 * midpointSubsteps, workers };
  }

  [Symbol.dispose](): void {
    this.disposed = true;
    this.pool?.close();
  }
}
