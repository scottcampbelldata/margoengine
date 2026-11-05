/// <reference lib="esnext.disposable" />
import type { Component, ComponentObserver, Entity } from './index.js';

/** Packed entities with an index by slot: a slot holds at most one entity per set, however often it is reused. */
class EntitySet {
  private readonly dense: Uint32Array;
  private readonly sparse: Int32Array;
  size = 0;
  constructor(
    capacity: number,
    private readonly stride: number,
  ) {
    this.dense = new Uint32Array(capacity);
    this.sparse = new Int32Array(capacity).fill(-1);
  }
  has(entity: Entity): boolean {
    const at = this.sparse[entity % this.stride];
    return at >= 0 && this.dense[at] === entity;
  }
  add(entity: Entity): void {
    if (this.has(entity)) return;
    this.sparse[entity % this.stride] = this.size;
    this.dense[this.size++] = entity;
  }
  delete(entity: Entity): void {
    if (!this.has(entity)) return;
    const slot = entity % this.stride,
      at = this.sparse[slot],
      moved = this.dense[--this.size];
    this.sparse[slot] = -1;
    if (at !== this.size) {
      this.dense[at] = moved;
      this.sparse[moved % this.stride] = at;
    }
  }
  clear(): void {
    for (let i = 0; i < this.size; i++) this.sparse[this.dense[i] % this.stride] = -1;
    this.size = 0;
  }
  copy(output: Uint32Array): number {
    if (output.length < this.size)
      throw new RangeError(
        'Change output is too small; pass a Uint32Array at least as long as the entity count (world.capacity always fits)',
      );
    output.set(this.dense.subarray(0, this.size));
    return this.size;
  }
}

/**
 * What happened to one component since the last {@link ChangeTracker.clear}, as a net result: an entity added and
 * removed again in the window is not reported at all, one removed and added back is `changed`, and one added and then
 * written stays `added`. Each tracker has its own window, so two systems can read the same component at their own pace.
 *
 * Writes through `component.add` are seen; writes straight into `component.fields` are not until `component.touch`
 * reports them.
 */
export class ChangeTracker {
  private readonly addedSet: EntitySet;
  private readonly changedSet: EntitySet;
  private readonly removedSet: EntitySet;
  private readonly observer: ComponentObserver;
  /** Start tracking `component`; changes before this call are not reported. */
  constructor(readonly component: Component) {
    const { capacity } = component.world;
    const added = (this.addedSet = new EntitySet(capacity, capacity)),
      changed = (this.changedSet = new EntitySet(capacity, capacity)),
      removed = (this.removedSet = new EntitySet(capacity, capacity));
    this.observer = {
      onAdd(entity) {
        if (removed.has(entity)) {
          removed.delete(entity);
          changed.add(entity);
        } else added.add(entity);
      },
      onChange(entity) {
        if (!added.has(entity)) changed.add(entity);
      },
      onRemove(entity) {
        if (added.has(entity)) added.delete(entity);
        else {
          changed.delete(entity);
          removed.add(entity);
        }
      },
    };
    component.observers.push(this.observer);
  }
  /**
   * Write the entities that gained the component into `output`, in no fixed order; returns how many.
   * @throws RangeError when `output` is too small (`world.capacity` entries always fit).
   */
  added(output: Uint32Array): number {
    return this.addedSet.copy(output);
  }
  /**
   * Write the entities whose row was written and that had the component before the window; returns how many.
   * @throws RangeError when `output` is too small (`world.capacity` entries always fit).
   */
  changed(output: Uint32Array): number {
    return this.changedSet.copy(output);
  }
  /**
   * Write the entities that lost the component, destroyed ones included (their ids are stale); returns how many.
   * @throws RangeError when `output` is too small (`world.capacity` entries always fit).
   */
  removed(output: Uint32Array): number {
    return this.removedSet.copy(output);
  }
  /** Start a new window: forget everything reported so far. Costs one step per change held, not per entity. */
  clear(): void {
    this.addedSet.clear();
    this.changedSet.clear();
    this.removedSet.clear();
  }
  /** Stop tracking. What the tracker holds can still be read. Safe to call twice. */
  stop(): void {
    const { observers } = this.component,
      at = observers.indexOf(this.observer);
    if (at >= 0) observers.splice(at, 1);
  }
  /** `stop()`, for `using` (on runtimes that have `Symbol.dispose`). */
  declare [Symbol.dispose]: () => void;
  [(Symbol.dispose ?? Symbol()) as symbol](): void {
    this.stop();
  }
}
