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
  world_set_gravity(x: number, y: number, z: number): void;
  world_gravity(axis: number): number;
  world_set_substeps(substeps: number): void;
  world_substeps(): number;
  world_steps(): number;
  world_step(dt: number): void;
  body_add(kind: number): number;
}

/** How a body moves: `dynamic` by forces, `kinematicPosition` to a target, `kinematicVelocity` at its velocity. */
export type KernelBodyKind = 'fixed' | 'dynamic' | 'kinematicPosition' | 'kinematicVelocity';

/** The kind bits of the `flags` column (kernel/src/layout.rs). */
const bodyKinds: Readonly<Record<KernelBodyKind, number>> = {
  fixed: 0,
  dynamic: 2,
  kinematicPosition: 4,
  kinematicVelocity: 6,
};

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
  /** Steps taken so far. */
  get steps(): number {
    return this.api.world_steps();
  }
  /**
   * Equal pieces each step is split into (default 4). Forces reach every piece; impulses land once, before the first.
   * @throws RangeError unless it is a whole number from 1 up.
   */
  get substeps(): number {
    return this.api.world_substeps();
  }
  set substeps(substeps: number) {
    if (!Number.isInteger(substeps) || substeps < 1 || substeps > 0xffff)
      throw new RangeError(`Substeps must be a whole number from 1 to 65535; use 4 unless you measured (got ${substeps}).`);
    this.api.world_set_substeps(substeps);
  }
  /** Gravity as `[x, y, z]`, in m/s^2 (default `[0, -9.81, 0]`, read back as f32). */
  get gravity(): [number, number, number] {
    const { api } = this;
    return [api.world_gravity(0), api.world_gravity(1), api.world_gravity(2)];
  }
  /**
   * Sets gravity.
   * @throws RangeError for a value that is not finite: a NaN in the state would end bit equality.
   */
  setGravity(x: number, y: number, z: number): this {
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z))
      throw new RangeError(`Gravity must be three finite numbers; check what fed it (got ${x}, ${y}, ${z}).`);
    this.api.world_set_gravity(x, y, z);
    return this;
  }
  /**
   * Adds a body and returns its row, which is its index in every column. Grows the world when the rows run out, so read
   * views from `columns` after this call. A new row is at the origin with no mass: give a dynamic body `inverseMass`.
   * @throws RangeError for an unknown kind, or when the world cannot grow.
   */
  addBody(kind: KernelBodyKind): number {
    const bits = Object.hasOwn(bodyKinds, kind) ? bodyKinds[kind] : undefined;
    if (bits === undefined)
      throw new RangeError(`Unknown body kind ${String(kind)}; use one of ${Object.keys(bodyKinds).join(', ')}.`);
    let row = this.api.body_add(bits);
    if (row < 0) {
      this.reserve(this.capacity * 2);
      row = this.api.body_add(bits);
    }
    return row;
  }
  /**
   * Advances the world by `dt` seconds, in {@link KernelWorld.substeps} equal pieces.
   * @throws RangeError unless `dt` is finite and above zero.
   */
  step(dt: number): this {
    if (!(dt > 0) || !Number.isFinite(dt))
      throw new RangeError(`A step must be finite and above zero; a usual step is 1 / 60 (got ${dt}).`);
    this.api.world_step(dt);
    return this;
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
