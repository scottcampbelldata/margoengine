/// <reference lib="esnext.disposable" />
import { MargoError } from '@margoengine/math/errors';
import { Component, World, type Entity, type NumericArray, type Schema, type ComponentStore } from './index.js';
import type { ParallelWorker, ParallelContext, SharedComponentView } from './parallel-runtime.js';
export { serveParallelSystems, sharedIndex } from './parallel-runtime.js';
export type { ParallelWorker, ParallelEndpoint, ParallelContext, SharedComponentView } from './parallel-runtime.js';
const locked = new WeakSet<World>();
function idle(world: World): void {
  if (locked.has(world))
    throw new MargoError(
      'state',
      'Parallel systems are running; await update before changing component membership or entity lifetime',
    );
}
/** A numeric component whose membership can change only between shared worker updates. */
export class SharedComponent<S extends Schema = Schema> extends Component<S> {
  /** Shared entity-slot lookup, maintained before observers run. Resolve generations with sharedIndex. */
  readonly rows: Int32Array;
  private adding?: Entity;
  private removing?: Entity;
  /** Prefer SharedWorld.component/tag, which register this store for cleanup. */
  constructor(world: SharedWorld, schema: S, tag = false) {
    super(world, schema, tag);
    this.rows = world.allocate(Int32Array, -1);
    world.attach(this);
  }
  override add(entity: Entity, values: Partial<Record<keyof S, number>> = {}): number {
    idle(this.world);
    this.adding = entity;
    try {
      return super.add(entity, values);
    } finally {
      this.adding = undefined;
    }
  }
  override remove(entity: Entity): boolean {
    idle(this.world);
    this.removing = entity;
    try {
      return super.remove(entity);
    } finally {
      this.removing = undefined;
    }
  }
  protected override initializeRow(row: number, values: Partial<Record<keyof S, number>> = {}): void {
    super.initializeRow(row, values);
    this.rows[this.adding! % this.world.stride] = row;
  }
  protected override moveRow(row: number, last: number): void {
    super.moveRow(row, last);
    this.rows[this.removing! % this.world.stride] = -1;
    if (row < this.size) this.rows[this.entities[row] % this.world.stride] = row;
  }
  override touch(entity: Entity): boolean {
    idle(this.world);
    return super.touch(entity);
  }
}
/** Fixed-capacity world with SharedArrayBuffer fields and guarded structural mutation during worker updates. */
export class SharedWorld extends World {
  /** Allocate fixed-length shared storage; requires cross-origin isolation in browsers. */
  override allocate<T extends NumericArray>(Type: new (length: number) => T, fill = 0): T {
    if (typeof SharedArrayBuffer === 'undefined' || ('document' in globalThis && !globalThis.crossOriginIsolated))
      throw new MargoError(
        'unsupported',
        'Shared ECS needs cross-origin isolation; serve COOP same-origin and COEP require-corp headers',
      );
    const Constructor = Type as unknown as { BYTES_PER_ELEMENT: number; new (buffer: SharedArrayBuffer): T };
    const array = new Constructor(new SharedArrayBuffer(this.capacity * Constructor.BYTES_PER_ELEMENT));
    if (fill) array.fill(fill);
    return array;
  }
  override create(): Entity {
    idle(this);
    return super.create();
  }
  override destroy(entity: Entity): void {
    idle(this);
    super.destroy(entity);
  }
  override reserve(count: number): void {
    idle(this);
    super.reserve(count);
  }
  override attach(store: { remove(entity: Entity): unknown }): void {
    idle(this);
    super.attach(store);
  }
  override detach(store: { remove(entity: Entity): unknown }): void {
    idle(this);
    super.detach(store);
  }
  override component<S extends Schema>(schema: S): SharedComponent<S> {
    idle(this);
    return new SharedComponent(this, schema);
  }
  override tag(): SharedComponent<Record<never, never>> {
    idle(this);
    return new SharedComponent(this, {}, true);
  }
}
/** One module system and its declared memory accesses. */
export interface ParallelSystem {
  /** Unique system name. */
  name: string;
  /** Absolute module URL; native module imports are cached inside workers. */
  module: string | URL;
  /** Named function export. Default 'default'. */
  exportName?: string;
  /** Read-only component names. Default none. */
  reads?: readonly string[];
  /** Read/write component names. Default none. Conflicts serialize in dependency order. */
  writes?: readonly string[];
  /** Explicit successors. Default none. */
  before?: readonly string[];
  /** Explicit predecessors. Default none. */
  after?: readonly string[];
}
/** Worker pool ownership, capacity and deadlines. */
export interface ParallelOptions {
  /** Worker count, 1 to 32. Default 2. */
  workers?: number;
  /** Hard deadline per dispatched system in milliseconds. Range 1 to 2147483647; default 30000. Failure closes the schedule. */
  timeout?: number;
  /** Worker factory, for embedding or Node adapters. Default a dedicated browser worker. */
  workerFactory?: () => ParallelWorker;
}
type System = {
  name: string;
  module: string;
  exportName: string;
  reads: string[];
  writes: string[];
  before: string[];
  after: string[];
};
type Pending = { id: number; resolve: () => void; reject: (e: unknown) => void; timer: ReturnType<typeof setTimeout> };
type Slot = { worker: ParallelWorker; pending?: Pending; message: EventListener; error: EventListener };
/** Conflict-aware worker system scheduler over stable shared numeric component rows. */
export class ParallelSchedule {
  private readonly systems: System[] = [];
  private readonly stores: Map<string, ComponentStore>;
  private readonly slots: Slot[] = [];
  private readonly workerCount: number;
  private readonly timeout: number;
  private readonly factory: () => ParallelWorker;
  private stopping?: Promise<void>;
  private stopped = false;
  private running = false;
  private sequence = 0;
  private tick = 0;
  private elapsed = 0;
  private failure?: MargoError;
  private terminationFailed = false;
  /** @throws RangeError for invalid worker count/deadline; TypeError for nonshared or foreign components. */
  constructor(
    readonly world: SharedWorld,
    components: Readonly<Record<string, ComponentStore>>,
    options: ParallelOptions = {},
  ) {
    if (!(world instanceof SharedWorld))
      throw new TypeError('Parallel schedule needs a SharedWorld; create shared component stores before scheduling');
    this.workerCount = options.workers ?? 2;
    this.timeout = options.timeout ?? 30000;
    if (
      !Number.isInteger(this.workerCount) ||
      this.workerCount < 1 ||
      this.workerCount > 32 ||
      !Number.isFinite(this.timeout) ||
      this.timeout < 1 ||
      this.timeout > 0x7fffffff
    )
      throw new RangeError('Invalid parallel options; use 1 to 32 workers and a deadline from 1 to 2147483647 ms');
    this.stores = new Map(Object.entries(components));
    if (
      [...this.stores.values()].some(
        (c) =>
          c.world !== world ||
          !(c instanceof SharedComponent) ||
          !(c.entities.buffer instanceof SharedArrayBuffer) ||
          Object.values(c.fields).some((f) => !(f.buffer instanceof SharedArrayBuffer)),
      )
    )
      throw new TypeError(
        'Parallel components must belong to this SharedWorld; create them with world.component or world.tag',
      );
    this.factory =
      options.workerFactory ??
      (() => {
        if (typeof Worker === 'undefined')
          throw new MargoError('unsupported', 'No browser Worker available; provide workerFactory for this host');
        return new Worker(
          new URL(/* @vite-ignore */ './workers/parallel.js?no-inline', import.meta.url),
        ) as ParallelWorker;
      });
  }
  /** Add a module system. Missing dependency names/cycles reject when compiling order or running an update. */
  add(system: ParallelSystem): this {
    this.check();
    if (this.running) throw new MargoError('state', 'Parallel update is running; add systems between updates');
    if (
      typeof system.name !== 'string' ||
      !system.name.trim() ||
      this.systems.some((s) => s.name === system.name) ||
      !system.module ||
      [system.reads, system.writes, system.before, system.after].some(
        (list) => list !== undefined && (!Array.isArray(list) || list.some((n) => typeof n !== 'string' || !n.trim())),
      ) ||
      (system.exportName !== undefined && (typeof system.exportName !== 'string' || !system.exportName.trim()))
    )
      throw new TypeError('Invalid parallel system; supply a unique name and absolute module URL');
    const reads = [...new Set(system.reads ?? [])],
      writes = [...new Set(system.writes ?? [])];
    if ([...reads, ...writes].some((name) => !this.stores.has(name)))
      throw new TypeError('Unknown parallel component; use names registered with this schedule');
    const url = new URL(String(system.module));
    this.systems.push({
      name: system.name,
      module: url.href,
      exportName: system.exportName ?? 'default',
      reads,
      writes,
      before: [...(system.before ?? [])],
      after: [...(system.after ?? [])],
    });
    return this;
  }
  private graph(): { systems: System[]; edges: Map<System, Set<System>> } {
    const systems = [...this.systems],
      names = new Map(systems.map((s) => [s.name, s])),
      edges = new Map(systems.map((s) => [s, new Set<System>()]));
    const edge = (from: System | undefined, to: System | undefined) => {
      if (!from || !to)
        throw new MargoError('state', 'Parallel dependency is missing; register every named predecessor/successor');
      edges.get(from)!.add(to);
    };
    for (const s of systems) {
      for (const n of s.before) edge(s, names.get(n));
      for (const n of s.after) edge(names.get(n), s);
    }
    const sorted = this.levels(systems, edges).flat();
    const memory = (names: string[]) =>
      new Set(
        names.flatMap((name) => {
          const store = this.stores.get(name)! as SharedComponent;
          return [
            store.entities.buffer,
            store.rows.buffer,
            ...Object.values(store.fields).map((field) => field.buffer),
          ];
        }),
      );
    const access = new Map(
      sorted.map((system) => [system, { reads: memory(system.reads), writes: memory(system.writes) }]),
    );
    for (let i = 0; i < sorted.length; i++)
      for (let j = i + 1; j < sorted.length; j++) {
        const a = sorted[i],
          b = sorted[j];
        const first = access.get(a)!,
          second = access.get(b)!;
        if (
          [...first.writes].some((buffer) => second.reads.has(buffer) || second.writes.has(buffer)) ||
          [...second.writes].some((buffer) => first.reads.has(buffer))
        )
          edge(a, b);
      }
    return { systems, edges };
  }
  private levels(systems: System[], edges: Map<System, Set<System>>): System[][] {
    const pending = new Set(systems),
      done = new Set<System>(),
      levels: System[][] = [];
    while (pending.size) {
      const ready = systems.filter((s) => pending.has(s) && systems.every((p) => !edges.get(p)!.has(s) || done.has(p)));
      if (!ready.length)
        throw new MargoError('state', 'Parallel system dependencies form a cycle; remove a before/after edge');
      levels.push(ready);
      for (const s of ready) {
        done.add(s);
        pending.delete(s);
      }
    }
    return levels;
  }
  /** Return concurrent groups after explicit dependencies and read/write hazards are applied. */
  order(): string[][] {
    this.check();
    const g = this.graph();
    return this.levels(g.systems, g.edges).map((level) => level.map((s) => s.name));
  }
  private slot(): Slot {
    const worker = this.factory();
    const slot = {} as Slot;
    slot.worker = worker;
    slot.message = (event) => {
      const d = (event as MessageEvent).data,
        p = slot.pending;
      if (!p || !d || d.tag !== 'margo-ecs-parallel' || d.id !== p.id) return;
      clearTimeout(p.timer);
      slot.pending = undefined;
      if (d.ok === true) p.resolve();
      else
        p.reject(
          new MargoError(
            'state',
            'Parallel system failed: ' + String(d.error) + '; inspect the module and recreate the schedule',
          ),
        );
    };
    slot.error = (_event) => {
      const p = slot.pending;
      this.failure = new MargoError('state', 'Parallel worker failed; inspect its module and recreate the schedule');
      if (p) {
        clearTimeout(p.timer);
        slot.pending = undefined;
        p.reject(this.failure);
      }
    };
    worker.addEventListener('message', slot.message);
    worker.addEventListener('error', slot.error);
    worker.addEventListener('messageerror', slot.error);
    this.slots.push(slot);
    return slot;
  }
  private dispatch(slot: Slot, system: System, delta: number): Promise<void> {
    const components: Record<string, SharedComponentView> = {};
    for (const name of new Set([...system.reads, ...system.writes])) {
      const c = this.stores.get(name)!;
      Object.defineProperty(components, name, {
        value: {
          entities: c.entities,
          rows: (c as SharedComponent).rows,
          stride: this.world.stride,
          count: c.size,
          fields: c.fields,
        },
        enumerable: true,
      });
    }
    const context: ParallelContext = { delta, elapsed: this.elapsed + delta, tick: this.tick, components };
    return new Promise<void>((resolve, reject) => {
      const id = ++this.sequence;
      const timer = setTimeout(() => {
        slot.pending = undefined;
        reject(
          new MargoError(
            'timeout',
            'Parallel system exceeded its deadline; inspect the module and recreate the schedule',
          ),
        );
      }, this.timeout);
      slot.pending = { id, resolve, reject, timer };
      try {
        slot.worker.postMessage({
          tag: 'margo-ecs-parallel',
          id,
          module: system.module,
          exportName: system.exportName,
          context,
        });
      } catch (error) {
        clearTimeout(timer);
        slot.pending = undefined;
        reject(error);
      }
    });
  }
  /**
   * Run independent systems concurrently and serialize declared conflicts. Locks structure until every worker settles.
   * Callers must not write raw shared arrays or retain worker tasks across the returned promise.
   * After success, written components are touched for change trackers. Failure/abort terminates all workers,
   * closes this schedule and can leave partial field writes; no system is silently repeated.
   * @throws MargoError 'state' for concurrent updates, worker failures or cycles, 'timeout' for deadlines, 'disposed' after stop.
   */
  async update(delta: number, { signal }: { signal?: AbortSignal } = {}): Promise<void> {
    this.check();
    signal?.throwIfAborted();
    if (this.failure) {
      await this.stop();
      throw this.failure;
    }
    if (!Number.isFinite(delta) || delta < 0 || !Number.isFinite(this.elapsed + delta))
      throw new RangeError('Invalid parallel delta; use finite nonnegative seconds');
    if (this.running || locked.has(this.world))
      throw new MargoError('state', 'Shared world already has an update; await it before scheduling more systems');
    const g = this.graph(),
      levels = this.levels(g.systems, g.edges);
    this.running = true;
    locked.add(this.world);
    let abortError: unknown;
    const abort = () => {
      abortError = signal?.reason;
      for (const slot of this.slots) {
        const p = slot.pending;
        if (p) {
          clearTimeout(p.timer);
          slot.pending = undefined;
          p.reject(abortError);
        }
      }
    };
    signal?.addEventListener('abort', abort, { once: true });
    try {
      for (const level of levels)
        for (let offset = 0; offset < level.length; offset += this.workerCount) {
          signal?.throwIfAborted();
          const batch = level.slice(offset, offset + this.workerCount);
          await Promise.all(batch.map((s, i) => this.dispatch(this.slots[i] ?? this.slot(), s, delta)));
        }
      signal?.throwIfAborted();
      this.elapsed += delta;
      this.tick++;
    } catch (error) {
      await this.stop();
      if (abortError !== undefined) throw abortError;
      throw error;
    } finally {
      signal?.removeEventListener('abort', abort);
      if (!this.terminationFailed) locked.delete(this.world);
      this.running = false;
    }
    const written = new Set(this.systems.flatMap((s) => s.writes).map((name) => this.stores.get(name)!));
    for (const c of written) {
      for (const e of [...c.entities.subarray(0, c.size)]) c.touch(e);
    }
  }
  /** Terminate owned workers and reject pending calls; await termination before reusing shared fields. Idempotent. */
  stop(): Promise<void> {
    if (this.stopping) return this.stopping;
    this.stopped = true;
    this.stopping = Promise.resolve().then(async () => {
      const results = await Promise.allSettled(
        this.slots.map(async (slot) => {
          const p = slot.pending;
          if (p) {
            clearTimeout(p.timer);
            slot.pending = undefined;
            p.reject(new MargoError('disposed', 'Parallel schedule stopped; create a new schedule before updating'));
          }
          slot.worker.removeEventListener('message', slot.message);
          slot.worker.removeEventListener('error', slot.error);
          slot.worker.removeEventListener('messageerror', slot.error);
          await slot.worker.terminate();
        }),
      );
      if (results.some((r) => r.status === 'rejected')) {
        this.terminationFailed = true;
        throw new MargoError(
          'state',
          'Parallel worker termination failed; stop the host before accessing shared fields',
        );
      }
      this.slots.length = 0;
    });
    return this.stopping;
  }
  [Symbol.asyncDispose](): Promise<void> {
    return this.stop();
  }
  private check(): void {
    if (this.stopped)
      throw new MargoError('disposed', 'Parallel schedule stopped; create a new schedule before updating');
  }
}
