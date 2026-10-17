import { wasmBase64 } from './wasm.js';

interface Exports extends WebAssembly.Exports {
  memory: WebAssembly.Memory;
  kernel_new(capacity: number): number;
  kernel_data(handle: number): number;
  kernel_flags(handle: number): number;
  kernel_tick(handle: number, culling: number): number;
  kernel_sync_rotation(handle: number, id: number): void;
  kernel_drop(handle: number): void;
}
interface RotationSlot {
  handle: number;
  api: Exports;
}
const rotationSlots = new WeakMap<TransformStore, RotationSlot>();
/** Writes `qx, qy, qz, qw` from slot `id`'s Euler XYZ lanes through `Kernel::sync_rotation`. */
export function syncStoredRotation(store: TransformStore, id: number): void {
  const slot = rotationSlots.get(store);
  if (!slot?.handle) throw new Error('Transforms disposed');
  slot.api.kernel_sync_rotation(slot.handle, id);
}
let compiled: Promise<WebAssembly.Module> | undefined;
// Same columns as packages/kernel/src/lib.rs. `flags[id]` there is ACTIVE.
const X = 0;
const Y = 1;
const Z = 2;
const QX = 3;
const QY = 4;
const QZ = 5;
const QW = 6;
const SX = 7;
const SY = 8;
const SZ = 9;
const PARENTS = 10;
const WORLD_MATRIX = 11;
const LOCAL_SPHERE = 27;
const PLANES = 35;
const LIMITS = 38;
const TAIL = 24;
const ACTIVE = 0;
const VISIBLE = 1;
const CONSTRAINED = 2;
const HIDDEN = 3;
const CHANGED = 6;

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
    rotationSlots.set(this, { handle: 0, api });
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
    const slot = rotationSlots.get(this);
    if (slot) slot.handle = handle;
    Object.assign(this, {
      capacity,
      transforms: {
        x: floats(X * capacity),
        y: floats(Y * capacity),
        z: floats(Z * capacity),
        qx: floats(QX * capacity),
        qy: floats(QY * capacity),
        qz: floats(QZ * capacity),
        qw: floats(QW * capacity),
        sx: floats(SX * capacity),
        sy: floats(SY * capacity),
        sz: floats(SZ * capacity),
      },
      parents: floats(PARENTS * capacity),
      matrices: floats(WORLD_MATRIX * capacity, 16 * capacity),
      bounds: floats(LOCAL_SPHERE * capacity, 4 * capacity),
      planes: floats(PLANES * capacity, TAIL),
      rotations: floats(PLANES * capacity + TAIL, 3 * capacity),
      limits: floats(LIMITS * capacity + TAIL, 12 * capacity),
      active: bytes(ACTIVE),
      visible: bytes(VISIBLE),
      constrained: bytes(CONSTRAINED),
      hidden: bytes(HIDDEN),
      changed: bytes(CHANGED),
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
    const slot = rotationSlots.get(this);
    if (slot) slot.handle = 0;
    if (this.handle) {
      this.api.kernel_drop(this.handle);
      this.handle = 0;
    }
  }
}
