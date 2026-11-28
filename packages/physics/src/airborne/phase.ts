import { MargoError } from '@margoengine/math/errors';
import type { NativePhasePool } from '../native-phase-pool.js';
import { canShareMemory, isShared, STACK_BYTES } from '../world/memory.js';
import type { Region, SolverHost } from '../world/solver.js';

const JOB_BYTES = 32;
const U32 = Uint32Array.BYTES_PER_ELEMENT;
const PARCEL_BYTES = 16 * Float64Array.BYTES_PER_ELEMENT;
const FORCING_BYTES = 11 * Float64Array.BYTES_PER_ELEMENT;
const RECEIPT_WORDS = 2;

export interface AirbornePhaseLoadOptions {
  readonly threads?: number;
  readonly signal?: AbortSignal;
}

export interface AirborneWorkerWork {
  readonly parcels: number;
  readonly simdAxisPairs: number;
  readonly evaporationUpdates: number;
}

export interface AirborneWorkCounts extends AirborneWorkerWork {
  readonly threads: number;
  readonly workers: readonly AirborneWorkerWork[];
}

interface Kernel {
  airborne_apply(job: number): number;
  airborne_thread_phase(job: number, stage: number, part: number, parts: number): number;
}

interface Binding {
  readonly host: SolverHost;
  readonly job: Region;
  readonly receipts: Region;
  readonly kernel: Kernel;
}

async function compile(asset: URL, signal?: AbortSignal): Promise<WebAssembly.Module> {
  try {
    signal?.throwIfAborted();
    let bytes: BufferSource;
    if (asset.protocol === 'file:') {
      const name = 'node:fs/promises';
      const { readFile } = await import(/* @vite-ignore */ /* webpackIgnore: true */ name);
      asset.search = '';
      bytes = await readFile(asset, { signal });
    } else {
      const response = await fetch(asset, { signal });
      if (!response.ok)
        throw new MargoError(
          'failed',
          `Airborne kernel HTTP ${response.status}. Use the Wasm assets shipped with the package.`,
        );
      bytes = await response.arrayBuffer();
    }
    const module = await WebAssembly.compile(bytes);
    signal?.throwIfAborted();
    return module;
  } catch (cause) {
    signal?.throwIfAborted();
    if (cause instanceof MargoError) throw cause;
    throw Object.assign(new MargoError('failed', 'Airborne Wasm failed to load. Serve the matching SIMD assets.'), {
      cause,
    });
  }
}

function stackTop(host: SolverHost, name: string): number {
  const stack = host.allocate(name, STACK_BYTES + 8, 'u8', 1);
  return Math.floor((stack.byteOffset + stack.byteLength) / 16) * 16;
}

function holdsRows(region: Region, bytes: number, memory: WebAssembly.Memory): boolean {
  return (
    (region.memory === undefined || region.memory === memory) &&
    region.type === 'f64' &&
    region.layout === 1 &&
    region.byteOffset > 0 &&
    region.byteOffset % Float64Array.BYTES_PER_ELEMENT === 0 &&
    region.byteLength >= bytes &&
    region.byteOffset + bytes <= memory.buffer.byteLength
  );
}

/** Native per-parcel integration. The solver owns staging, sampler order and ledger publication. */
export class AirbornePhase {
  private binding?: Binding;
  private disposed = false;
  private readonly accepted: Uint32Array;

  private constructor(
    private readonly plain: WebAssembly.Module,
    private readonly shared: WebAssembly.Module | undefined,
    private readonly pool?: NativePhasePool,
  ) {
    this.accepted = new Uint32Array(RECEIPT_WORDS * (pool?.count ?? 1));
  }

  static async load({ threads = 1, signal }: AirbornePhaseLoadOptions = {}): Promise<AirbornePhase> {
    if (!Number.isSafeInteger(threads) || threads < 1)
      throw new MargoError('state', 'Invalid airborne thread count. Choose a positive whole number.');
    if (threads > 1 && !canShareMemory())
      throw new MargoError('unsupported', 'Use a shared-memory host for airborne workers or threads: 1.');
    const [plain, shared] = await Promise.all([
      compile(new URL(/* @vite-ignore */ './airborne-kernel.wasm?no-inline', import.meta.url), signal),
      canShareMemory()
        ? compile(new URL(/* @vite-ignore */ './airborne-kernel-shared.wasm?no-inline', import.meta.url), signal)
        : undefined,
    ]);
    if (threads === 1) return new AirbornePhase(plain, shared);
    const { createNativePhasePool } = await import('../native-phase-pool.js');
    const pool = await createNativePhasePool(threads, {
      subject: 'Airborne',
      phaseExport: 'airborne_thread_phase',
      signal,
    });
    return new AirbornePhase(plain, shared, pool);
  }

  bind(host: SolverHost): void {
    if (this.binding || this.disposed)
      throw new MargoError('state', 'Airborne integration has already been bound or disposed. Load a fresh solver.');
    const shared = isShared(host.memory);
    const module = shared ? this.shared : this.plain;
    if (!module || (this.pool && !shared))
      throw new MargoError('unsupported', 'Use worldMemory(true) for airborne workers or use threads: 1.');

    const job = host.allocate('airborne-native-job', JOB_BYTES, 'u32', 1);
    const receipts = host.allocate('airborne-work-receipts', U32 * this.accepted.length, 'u32', 1);
    const top = stackTop(host, 'airborne-stack');
    const { exports } = new WebAssembly.Instance(module, { env: { memory: host.memory } });
    const stack = exports.__stack_pointer;
    if (
      !(stack instanceof WebAssembly.Global) ||
      typeof exports.airborne_apply !== 'function' ||
      typeof exports.airborne_thread_phase !== 'function'
    )
      throw new MargoError('failed', 'Airborne integration exports are missing. Rebuild the airborne Wasm assets.');
    stack.value = top;
    new Uint32Array(host.memory.buffer, job.byteOffset, 4)[3] = receipts.byteOffset;
    const pool = this.pool;
    if (pool) {
      const control = host.allocate('airborne-worker-control', U32 * pool.controlWords, 'i32', 1);
      const stackTops = Array.from({ length: pool.count - 1 }, (_, part) => stackTop(host, `airborne-stack-${part + 1}`));
      pool.init({ memory: host.memory, module, job: job.byteOffset, control: control.byteOffset, stackTops });
    }
    this.binding = { host, job, receipts, kernel: exports as unknown as Kernel };
  }

  apply(candidateParcels: Region, forcing: Region, count: number, dt: number): void {
    if (!this.binding || this.disposed)
      throw new MargoError('state', 'Airborne integration is unavailable. Attach a fresh solver before stepping.');
    const { host, job, receipts, kernel } = this.binding;
    const { memory } = host;
    const parcelBytes = count * PARCEL_BYTES;
    const forcingBytes = count * FORCING_BYTES;
    if (
      !Number.isSafeInteger(count) ||
      count < 0 ||
      !(dt > 0 && Number.isFinite(dt)) ||
      !holdsRows(candidateParcels, parcelBytes, memory) ||
      !holdsRows(forcing, forcingBytes, memory) ||
      (candidateParcels.byteOffset < forcing.byteOffset + forcingBytes &&
        forcing.byteOffset < candidateParcels.byteOffset + parcelBytes)
    )
      throw new MargoError('state', 'Invalid airborne integration batch. Give separate world regions and a finite step.');
    if (count === 0) {
      this.accepted.fill(0);
      return;
    }
    const { buffer } = memory;
    const ptr = job.byteOffset;
    const header = new Uint32Array(buffer, ptr, 3);
    header[0] = candidateParcels.byteOffset;
    header[1] = forcing.byteOffset;
    header[2] = count;
    new Float64Array(buffer, ptr + 4 * U32, 1)[0] = dt;
    const pool = this.pool;
    const status = pool ? pool.phase(0, () => kernel.airborne_thread_phase(ptr, 0, 0, pool.count)) : kernel.airborne_apply(ptr);
    if (status !== 0)
      throw new MargoError('state', 'Airborne integration could not accept this batch. Reduce the parcel count or step.');
    const recorded = new Uint32Array(buffer, receipts.byteOffset, this.accepted.length);
    let parcels = 0;
    for (let i = 0; i < recorded.length; i += RECEIPT_WORDS) {
      const rows = recorded[i]!;
      if (recorded[i + 1]! > rows)
        throw new MargoError('failed', 'Airborne integration returned invalid evaporation work. Rebuild the Wasm assets.');
      parcels += rows;
    }
    if (parcels !== count)
      throw new MargoError('failed', 'Airborne integration missed parcels. Rebuild the Wasm assets.');
    this.accepted.set(recorded);
  }

  workCounts(): AirborneWorkCounts {
    const threads = this.accepted.length / RECEIPT_WORDS;
    let parcels = 0;
    let evaporationUpdates = 0;
    const workers = Array.from({ length: threads }, (_, worker) => {
      const rows = this.accepted[RECEIPT_WORDS * worker]!;
      const drying = this.accepted[RECEIPT_WORDS * worker + 1]!;
      parcels += rows;
      evaporationUpdates += drying;
      return { parcels: rows, simdAxisPairs: 2 * rows, evaporationUpdates: drying };
    });
    return { threads, parcels, simdAxisPairs: 2 * parcels, evaporationUpdates, workers };
  }

  [Symbol.dispose](): void {
    this.disposed = true;
    this.pool?.close();
  }
}
