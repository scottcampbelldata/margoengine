// The Rust kernel from JavaScript: loads the blueprint and reads the world's columns through typed-array views.
import { MargoError } from '@margoengine/math/errors';
import { LoadOnce } from '../../shared/load-once.js';
import { kernelColumns, wasmBase64 } from './wasm.js';

interface KernelExports extends WebAssembly.Exports {
  memory: WebAssembly.Memory;
  world_new(bodies: number): number;
  world_base(): number;
  world_bytes(): number;
  world_capacity(rows: number): number;
  world_offset(column: number): number;
  world_columns(): number;
  world_reserve(bodies: number): number;
  world_hash(): number;
}

const compiled = new LoadOnce<WebAssembly.Module>(async () => {
  const bytes = Uint8Array.from(atob(wasmBase64), (c) => c.charCodeAt(0));
  return WebAssembly.compile(
    await new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'))).arrayBuffer(),
  );
});

/** Options of {@link loadKernel}. */
export interface KernelLoadOptions {
  /** Stops waiting for the load; the load itself carries on and a later call reuses it. */
  signal?: AbortSignal;
}

/**
 * Compiles the kernel, once per app: compiling is asynchronous, so `new KernelWorld()` can stay synchronous.
 * @throws AbortError (the signal's reason) when `signal` aborts first.
 */
export async function loadKernel({ signal }: KernelLoadOptions = {}): Promise<void> {
  await compiled.load(signal);
}

/** A column view: float columns are `Float32Array`, integer columns `Uint32Array`. One row per body. */
export type KernelColumn = Float32Array | Uint32Array;

/**
 * One simulated world in its own Wasm instance. Column views alias the kernel's memory: reading a pose is a typed-array
 * read, with no call and no copy. `reserve` replaces every view, so read them from `columns` each time, never keep one.
 * Everything a step can change lives in one block, so {@link KernelWorld.snapshot} is one copy.
 */
export class KernelWorld {
  /** Every column by name, for example `columns.positionX[body]`. */
  readonly columns: Record<string, KernelColumn> = {};
  private readonly api: KernelExports;

  /**
   * @param bodies Rows to start with (default 1024); `reserve` adds more.
   * @throws MargoError (`state`) before {@link loadKernel} has finished.
   * @throws RangeError for a capacity the kernel refuses.
   */
  constructor(bodies = 1024) {
    const module = compiled.value;
    if (!module) throw new MargoError('state', 'The physics kernel is not loaded; call await loadKernel() first.');
    this.api = new WebAssembly.Instance(module).exports as KernelExports;
    if (!Number.isSafeInteger(bodies) || !this.api.world_new(bodies))
      throw new RangeError(`Bodies must be an integer from 1 to 4194304; use a smaller world (got ${bodies}).`);
    this.bind();
  }

  private bind(): void {
    const { api } = this,
      { buffer } = api.memory,
      base = api.world_base();
    kernelColumns.forEach(([name, kind, rows], column) => {
      const at = base + api.world_offset(column),
        length = api.world_capacity(rows);
      this.columns[name] = kind === 'f' ? new Float32Array(buffer, at, length) : new Uint32Array(buffer, at, length);
    });
  }

  /** Rows of body columns. */
  get capacity(): number {
    return this.api.world_capacity(0);
  }
  /** Bytes of the world, and of a {@link KernelWorld.snapshot}. */
  get bytes(): number {
    return this.api.world_bytes();
  }
  /** FNV-1a of the world's bytes: equal in every browser, in Node and on any machine for the same inputs. */
  get hash(): number {
    return this.api.world_hash();
  }
  /**
   * Makes room for `bodies` rows. Rows keep their index and values; results of later steps do not change.
   * @throws RangeError when the kernel cannot grow that far.
   */
  reserve(bodies: number): this {
    if (!Number.isSafeInteger(bodies) || !this.api.world_reserve(bodies))
      throw new RangeError(`Cannot reserve ${bodies} bodies; the limit is 4194304 and what memory allows.`);
    this.bind();
    return this;
  }
}
