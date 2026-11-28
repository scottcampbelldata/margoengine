import { MargoError } from '@margoengine/math/errors';
import type { NativePhasePool } from '../native-phase-pool.js';
import { canShareMemory, isShared, STACK_BYTES } from '../world/memory.js';
import type { Region, SolverHost } from '../world/solver.js';

const U32 = Uint32Array.BYTES_PER_ELEMENT;
const JOB_WORDS = 8;
const RECEIPT_WORDS = 2;

export interface CloudProjectionLoadOptions {
  readonly threads?: number;
  readonly signal?: AbortSignal;
}

interface WorkerWork {
  readonly cells: number;
  readonly pairedCells: number;
}

/**
 * Work counts for one cloud pressure projection: the thread count, applications, and the cells and paired cells
 * each participant visited.
 */
export interface CloudProjectionWorkCounts extends WorkerWork {
  readonly threads: number;
  readonly applications: number;
  readonly workers: readonly WorkerWork[];
}

interface Kernel {
  cloud_projection_apply(job: number): number;
  cloud_projection_thread_phase(job: number, stage: number, part: number, parts: number): number;
}

interface Binding {
  readonly host: SolverHost;
  readonly job: Region;
  readonly receipts: Region;
  readonly cells: number;
  readonly kernel: Kernel;
}

async function compile(asset: URL, signal?: AbortSignal): Promise<WebAssembly.Module> {
  try {
    signal?.throwIfAborted();
    let bytes: BufferSource;
    if (asset.protocol === 'file:') {
      asset.search = '';
      const source = 'node:fs/promises';
      const { readFile } = await import(/* @vite-ignore */ /* webpackIgnore: true */ source);
      bytes = await readFile(asset, { signal });
    } else {
      const response = await fetch(asset, { signal });
      if (!response.ok)
        throw new MargoError(
          'failed',
          `Cloud projection request returned HTTP ${response.status}. Serve the matching cloud Wasm asset.`,
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
      new MargoError('failed', 'Cloud projection Wasm could not load. Serve the matching assets in a SIMD runtime.'),
      { cause },
    );
  }
}

function stackTop(host: SolverHost, name: string): number {
  const stack = host.allocate(name, STACK_BYTES + 8, 'u8', 1);
  return Math.floor((stack.byteOffset + stack.byteLength) / 16) * 16;
}

function overlap(a: Float64Array, b: Float64Array): boolean {
  return a.byteOffset < b.byteOffset + b.byteLength && b.byteOffset < a.byteOffset + a.byteLength;
}

/** Internal matrix product. The caller keeps its PCG vectors and reduction order. */
export class CloudProjection {
  private binding?: Binding;
  private disposed = false;
  private applications = 0;
  private readonly totals: Float64Array;

  private constructor(
    private readonly plain: WebAssembly.Module,
    private readonly shared: WebAssembly.Module | undefined,
    private readonly pool?: NativePhasePool,
  ) {
    this.totals = new Float64Array(RECEIPT_WORDS * (pool?.count ?? 1));
  }

  static async load({ threads = 1, signal }: CloudProjectionLoadOptions = {}): Promise<CloudProjection> {
    if (!Number.isSafeInteger(threads) || threads < 1)
      throw new MargoError('state', 'Invalid cloud projection thread count. Choose a positive whole number.');
    if (threads > 1 && !canShareMemory())
      throw new MargoError('unsupported', 'Use a shared-memory host for cloud projection workers or threads: 1.');
    const [plain, shared] = await Promise.all([
      compile(new URL(/* @vite-ignore */ './cloud-projection-kernel.wasm?no-inline', import.meta.url), signal),
      canShareMemory()
        ? compile(
            new URL(/* @vite-ignore */ './cloud-projection-kernel-shared.wasm?no-inline', import.meta.url),
            signal,
          )
        : undefined,
    ]);
    if (threads === 1) return new CloudProjection(plain, shared);
    const { createNativePhasePool } = await import('../native-phase-pool.js');
    const pool = await createNativePhasePool(threads, {
      subject: 'Cloud projection',
      phaseExport: 'cloud_projection_thread_phase',
      phase: 'matrix',
      signal,
    });
    return new CloudProjection(plain, shared, pool);
  }

  bind(host: SolverHost, nx: number, ny: number, nz: number): void {
    if (this.disposed || this.binding)
      throw new MargoError('state', 'Cloud projection has already been bound or disposed. Load a new cloud solver.');
    const shared = isShared(host.memory);
    const module = shared ? this.shared : this.plain;
    if (!module || (this.pool && !shared))
      throw new MargoError('unsupported', 'Use worldMemory(true) for cloud projection workers or use threads: 1.');
    const cells = nx * ny * nz;
    if (![nx, ny, nz].every((n) => Number.isSafeInteger(n) && n > 0) || cells > 0x0fffffff)
      throw new MargoError('state', 'Cloud projection dimensions exceed the Wasm range. Use a smaller pressure grid.');

    const job = host.allocate('cloud-projection-job', U32 * JOB_WORDS, 'u32', 1);
    const receipts = host.allocate('cloud-projection-receipts', U32 * this.totals.length, 'u32', 1);
    const top = stackTop(host, 'cloud-projection-stack');
    const { exports } = new WebAssembly.Instance(module, { env: { memory: host.memory } });
    const stack = exports.__stack_pointer;
    if (
      !(stack instanceof WebAssembly.Global) ||
      typeof exports.cloud_projection_apply !== 'function' ||
      typeof exports.cloud_projection_thread_phase !== 'function'
    )
      throw new MargoError('failed', 'Cloud projection Wasm exports are missing. Rebuild the cloud projection assets.');
    stack.value = top;
    new Uint32Array(host.memory.buffer, job.byteOffset, JOB_WORDS).set([0, 0, 0, receipts.byteOffset, nx, ny, nz, 0]);
    const pool = this.pool;
    if (pool) {
      const control = host.allocate('cloud-projection-workers', U32 * pool.controlWords, 'i32', 1);
      const stackTops = Array.from({ length: pool.count - 1 }, (_, part) =>
        stackTop(host, `cloud-projection-stack-${part + 1}`),
      );
      pool.init({ memory: host.memory, module, job: job.byteOffset, control: control.byteOffset, stackTops });
    }
    this.binding = { host, job, receipts, cells, kernel: exports as unknown as Kernel };
  }

  apply(input: Float64Array, degree: Float64Array, output: Float64Array): void {
    if (!this.binding || this.disposed)
      throw new MargoError('state', 'Cloud projection is unavailable. Attach a fresh cloud solver before stepping.');
    const { host, job, receipts, cells, kernel } = this.binding;
    const buffer = host.memory.buffer;
    if (
      input.buffer !== buffer ||
      degree.buffer !== buffer ||
      output.buffer !== buffer ||
      input.length !== cells ||
      degree.length !== cells ||
      output.length !== cells ||
      overlap(input, output) ||
      overlap(degree, output)
    )
      throw new MargoError(
        'state',
        'Cloud projection needs current world vectors of the grid size. Keep the output in a separate arena region.',
      );
    const header = new Uint32Array(buffer, job.byteOffset, 3);
    header[0] = input.byteOffset;
    header[1] = degree.byteOffset;
    header[2] = output.byteOffset;
    const ptr = job.byteOffset;
    const pool = this.pool;
    const status = pool
      ? pool.phase(0, () => kernel.cloud_projection_thread_phase(ptr, 0, 0, pool.count))
      : kernel.cloud_projection_apply(ptr);
    if (status !== 0)
      throw new MargoError('state', 'Cloud pressure product exceeds numeric range. Reduce the velocity or forcing.');
    const counts = new Uint32Array(buffer, receipts.byteOffset, this.totals.length);
    let visited = 0;
    for (let i = 0; i < counts.length; i += RECEIPT_WORDS) {
      const rows = counts[i]!;
      const paired = counts[i + 1]!;
      if (paired > rows || paired % 2 !== 0)
        throw new MargoError('failed', 'Cloud projection reported invalid SIMD work. Rebuild the cloud assets.');
      visited += rows;
    }
    if (visited !== cells)
      throw new MargoError('failed', 'Cloud projection missed pressure cells. Rebuild the cloud assets.');
    for (let i = 0; i < counts.length; i++) this.totals[i]! += counts[i]!;
    this.applications++;
  }

  resetWork(): void {
    this.applications = 0;
    this.totals.fill(0);
  }

  workCounts(): CloudProjectionWorkCounts {
    const threads = this.totals.length / RECEIPT_WORDS;
    let cells = 0;
    let pairedCells = 0;
    const workers = Array.from({ length: threads }, (_, i) => {
      const visited = this.totals[RECEIPT_WORDS * i]!;
      const paired = this.totals[RECEIPT_WORDS * i + 1]!;
      cells += visited;
      pairedCells += paired;
      return { cells: visited, pairedCells: paired };
    });
    return { threads, applications: this.applications, cells, pairedCells, workers };
  }

  [Symbol.dispose](): void {
    this.disposed = true;
    this.pool?.close();
  }
}
