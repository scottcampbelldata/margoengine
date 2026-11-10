/// <reference lib="esnext.disposable" />
import { MargoError } from '@margoengine/math/errors';
import type { ComponentStore as Component, ComponentObserver, Entity, World } from './index.js';
import type { QueryTerms } from './query.js';

/** Per-query structural transitions delivered by flush(). */
export interface QueryListener {
  /** Entity entered the query. Default no callback. */
  onEnter?: (entity: Entity) => void;
  /** Entity exited the query. Its id can be stale after destruction. Default no callback. */
  onExit?: (entity: Entity) => void;
}

/** An incrementally maintained component query with independent enter/exit events. */
export class ReactiveQuery {
  private readonly required: readonly Component[];
  private readonly excluded: readonly Component[];
  private readonly reads: readonly Component[];
  private readonly watched: readonly Component[];
  private readonly dense: Entity[] = [];
  private readonly positions = new Map<Entity, number>();
  private readonly listeners = new Set<QueryListener>();
  private events: [boolean, Entity, QueryListener[]][] = [];
  private stopped = false;
  private visiting = false;
  private flushing = false;
  private readonly observer: ComponentObserver = {
    onAdd: (entity) => this.refresh(entity),
    onRemove: (entity) => this.refresh(entity),
    onChange: () => {},
  };
  /** @throws TypeError when with is empty or a component belongs to another world. */
  constructor(
    readonly world: World,
    terms: QueryTerms,
  ) {
    this.required = [...terms.with];
    this.excluded = [...(terms.without ?? [])];
    this.reads = [...this.required, ...(terms.optional ?? [])];
    this.watched = [...new Set([...this.required, ...this.excluded])];
    if (!this.required.length || [...this.watched, ...this.reads].some((c) => c.world !== world))
      throw new TypeError(
        'Invalid reactive query; pass at least one required component and only components of this world',
      );
    let smallest = this.required[0];
    for (const c of this.required) if (c.size < smallest.size) smallest = c;
    for (let i = 0; i < smallest.size; i++) this.refresh(smallest.entities[i]);
    this.events.length = 0;
    for (const c of this.watched) c.observers.push(this.observer);
  }
  /** Number of cached matches. No world scan. */
  get size(): number {
    return this.dense.length;
  }
  /** True when the entity is in the current cache. */
  has(entity: Entity): boolean {
    return this.positions.has(entity);
  }
  private matches(entity: Entity): boolean {
    return (
      this.world.alive(entity) &&
      !this.world.destroying(entity) &&
      this.required.every((c) => c.has(entity)) &&
      this.excluded.every((c) => !c.has(entity))
    );
  }
  private refresh(entity: Entity): void {
    if (this.stopped) return;
    const row = this.positions.get(entity),
      match = this.matches(entity);
    if (match && row === undefined) {
      this.positions.set(entity, this.dense.length);
      this.dense.push(entity);
      if (this.listeners.size) this.events.push([true, entity, [...this.listeners]]);
    } else if (!match && row !== undefined) {
      const last = this.dense.pop()!;
      if (row < this.dense.length) {
        this.dense[row] = last;
        this.positions.set(last, row);
      }
      this.positions.delete(entity);
      if (this.listeners.size) this.events.push([false, entity, [...this.listeners]]);
    }
  }
  /**
   * Subscribe to future transitions; initial:true immediately visits current entries for this listener alone.
   * Returns an idempotent unsubscribe function.
   * @throws MargoError 'disposed' after stop.
   */
  subscribe(listener: QueryListener, { initial = false }: { initial?: boolean } = {}): () => void {
    this.check();
    this.listeners.add(listener);
    if (initial)
      for (const e of [...this.dense]) {
        if (!this.listeners.has(listener) || this.stopped) break;
        listener.onEnter?.(e);
      }
    return () => {
      this.listeners.delete(listener);
    };
  }
  /**
   * Deliver queued transitions in order. Listener mutations queue transitions for the next flush.
   * An error propagates; already delivered transitions are not replayed, remaining transitions stay pending.
   * @throws MargoError 'state' for nested flush, or 'disposed' after stop.
   */
  flush(): number {
    this.check();
    if (this.flushing) throw new MargoError('state', 'Reactive query is flushing; flush again after callbacks return');
    this.flushing = true;
    const events = this.events;
    this.events = [];
    let delivered = 0;
    try {
      for (let i = 0; i < events.length && !this.stopped; i++) {
        const [enter, e, listeners] = events[i];
        delivered++;
        for (const listener of listeners) {
          if (this.stopped) break;
          if (!this.listeners.has(listener)) continue;
          (enter ? listener.onEnter : listener.onExit)?.(e);
        }
      }
    } finally {
      if (!this.stopped && delivered < events.length) this.events = [...events.slice(delivered), ...this.events];
      this.flushing = false;
    }
    return delivered;
  }
  /** Write cached ids without scanning components; throws RangeError for an undersized output. */
  run(output: Uint32Array): number {
    this.check();
    if (output.length < this.size)
      throw new RangeError('Reactive query output is too small; allocate at least query.size entries');
    output.set(this.dense);
    return this.size;
  }
  /**
   * Snapshot cached ids, then resolve current rows. Newly entered matches wait until the next iteration.
   * Rows are reused and ordered with then optional (-1 when absent).
   * @throws MargoError 'state' for a nested iteration, or 'disposed' after stop.
   */
  forEach(visit: (entity: Entity, rows: Int32Array) => void): number {
    this.check();
    if (this.visiting) throw new MargoError('state', 'Reactive query is visiting; use another query to nest iteration');
    const ids = [...this.dense],
      rows = new Int32Array(this.reads.length);
    let count = 0;
    this.visiting = true;
    try {
      for (const e of ids) {
        if (this.stopped || !this.positions.has(e)) continue;
        this.reads.forEach((c, i) => {
          rows[i] = c.index(e);
        });
        visit(e, rows);
        count++;
      }
    } finally {
      this.visiting = false;
    }
    return count;
  }
  /** Detach observers and release cached ids, transitions and listeners. Idempotent. */
  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    for (const c of this.watched) {
      const i = c.observers.indexOf(this.observer);
      if (i >= 0) c.observers.splice(i, 1);
    }
    this.positions.clear();
    this.dense.length = 0;
    this.events.length = 0;
    this.listeners.clear();
  }
  declare [Symbol.dispose]: () => void;
  [(Symbol.dispose ?? Symbol()) as symbol](): void {
    this.stop();
  }
  private check(): void {
    if (this.stopped)
      throw new MargoError('disposed', 'Reactive query stopped; create a new query before reading or subscribing');
  }
}
