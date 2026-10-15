import { wasmBase64 } from './wasm.js';

interface Exports extends WebAssembly.Exports {
  memory: WebAssembly.Memory;
  kernel_new(capacity: number): number;
  kernel_data(handle: number): number;
  kernel_flags(handle: number): number;
  kernel_tick(handle: number, culling: number): number;
  kernel_drop(handle: number): void;
}
let compiled: Promise<WebAssembly.Module> | undefined;
const keys = ['x', 'y', 'z', 'qx', 'qy', 'qz', 'qw', 'sx', 'sy', 'sz'] as const;

/** Column views into the kernel's Wasm memory. `grow` replaces every view (old ones are detached or alias the new layout): re-read them (and `Mesh.matrix`) after creating meshes, never keep them. */
export class TransformStore {
  declare readonly capacity: number;
  declare readonly transforms: Record<'x' | 'y' | 'z' | 'qx' | 'qy' | 'qz' | 'qw' | 'sx' | 'sy' | 'sz', Float32Array>;
  declare readonly matrices: Float32Array;
  declare readonly parents: Float32Array;
  declare readonly bounds: Float32Array;
  declare readonly planes: Float32Array;
  declare readonly active: Uint8Array;
  declare readonly visible: Uint8Array;
  declare readonly rotations: Float32Array;
  declare readonly limits: Float32Array;
  declare readonly constrained: Uint8Array;
  declare readonly hidden: Uint8Array;
  /** Set by tick for each entity whose world matrix was recomputed; the engine clears it after copying the matrix. */
  declare readonly changed: Uint8Array;
  declare private handle: number;

  static async create(capacity = 1024): Promise<TransformStore> {
    compiled ??= (async () => {
      const bytes = Uint8Array.from(atob(wasmBase64), (c) => c.charCodeAt(0));
      return WebAssembly.compile(
        await new Response(
          new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw')),
        ).arrayBuffer(),
      );
    })().catch((error) => {
      compiled = undefined;
      throw error;
    });
    const instance = await WebAssembly.instantiate(await compiled);
    return new TransformStore(instance.exports as Exports, capacity);
  }

  private constructor(
    private readonly api: Exports,
    capacity: number,
  ) {
    this.bind(capacity);
  }

  private bind(capacity: number): void {
    if (!Number.isSafeInteger(capacity) || capacity < 1 || capacity > 1 << 23)
      throw new RangeError('Capacity: 1..8388608');
    const api = this.api,
      handle = api.kernel_new(capacity);
    if (!handle) throw new Error('Transform allocation');
    const offset = api.kernel_data(handle),
      flags = api.kernel_flags(handle),
      buffer = api.memory.buffer;
    const floats = (at: number, length = capacity) => new Float32Array(buffer, offset + at * 4, length),
      bytes = (column: number) => new Uint8Array(buffer, flags + column * capacity, capacity);
    this.handle = handle;
    Object.assign(this, {
      capacity,
      transforms: Object.fromEntries(keys.map((key, field) => [key, floats(field * capacity)])),
      parents: floats(10 * capacity),
      matrices: floats(11 * capacity, 16 * capacity),
      bounds: floats(27 * capacity, 4 * capacity),
      planes: floats(35 * capacity, 24),
      rotations: floats(35 * capacity + 24, 3 * capacity),
      limits: floats(38 * capacity + 24, 12 * capacity),
      active: bytes(0),
      visible: bytes(1),
      constrained: bytes(2),
      hidden: bytes(3),
      changed: bytes(6),
    });
  }

  /**
   * Raises the capacity in place, keeping every entity's inputs and outputs (each view keeps its per-entity layout, so
   * the old values are a prefix of the new view). The next tick recomputes every entity once, as a new store's first
   * tick does. Throws and keeps the old capacity when the capacity is invalid or memory cannot grow.
   */
  grow(capacity: number): void {
    if (!(capacity > this.capacity)) throw new RangeError('Capacity');
    // Every typed-array view, in the same (assignment) order before and after bind.
    const views = () =>
      Object.values({ ...this.transforms, ...this }).filter(ArrayBuffer.isView) as (Float32Array | Uint8Array)[];
    const copies = views().map((view) => view.slice()),
      previous = this.capacity;
    this.api.kernel_drop(this.handle);
    try {
      this.bind(capacity);
    } catch (error) {
      this.bind(previous);
      throw error;
    } finally {
      views().forEach((view, i) => view.set(copies[i]));
    }
  }

  tick(culling = true): void {
    if (!this.handle) throw new Error('Transforms disposed');
    const error = this.api.kernel_tick(this.handle, +culling);
    if (error)
      throw new RangeError(error > this.capacity ? 'Invalid frustum' : `Invalid transform/bounds: ${error - 1}`);
  }

  dispose(): void {
    if (this.handle) {
      this.api.kernel_drop(this.handle);
      this.handle = 0;
    }
  }
}
