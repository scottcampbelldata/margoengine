import { MargoError } from '@margoengine/math/errors';
/** Typed arrays allowed as component field storage. */
export type NumericArray = Float32Array | Float64Array | Int32Array | Uint32Array | Uint8Array;
/** Constructor of a {@link NumericArray}, e.g. `Float32Array`; used as a schema field type. */
export type ArrayConstructor = { new (length: number): NumericArray };
/** Component layout: field name to storage constructor. Must have at least one field. */
export type Schema = Record<string, ArrayConstructor>;
/** Entity id: `generation * capacity + slot`, a non-negative integer up to `0xffffffff`. Stale ids fail `World.alive`. */
export type Entity = number;
const capacityLimit = 1_000_000;
/** Told about every row change of a component, after it happened. Push one onto {@link Component.observers}. */
export interface ComponentObserver {
  /** `entity` gained a row. */
  onAdd(entity: Entity): void;
  /** `add` wrote values into the row `entity` already had, or `touch` reported a direct write. */
  onChange(entity: Entity): void;
  /** `entity` lost its row; a destroyed entity is reported here before its id goes stale. */
  onRemove(entity: Entity): void;
}

/** Packed sparse-set component store. Data rows move when entities are removed. */
export class Component<S extends Schema = Schema> {
  readonly fields: { [K in keyof S]: InstanceType<S[K]> };
  readonly entities: Uint32Array;
  private readonly sparse: Int32Array;
  /** Field arrays in schema order, so row moves need no per-call Object.values. */
  private readonly columns: NumericArray[];
  size = 0;
  /** Called on every row change; `ChangeTracker` from `@margoengine/ecs/changes` is the usual user. */
  readonly observers: ComponentObserver[] = [];
  /**
   * Prefer {@link World.component}, which also registers the store for cleanup on `destroy`.
   * @throws TypeError for an empty schema or an unsupported storage constructor.
   * @param tag True only from {@link World.tag}, the one place a component may have no fields.
   */
  constructor(
    readonly world: World,
    schema: S,
    tag = false,
  ) {
    if (!tag && !Object.keys(schema).length)
      throw new TypeError('Empty component schema; give at least one field, e.g. {x: Float32Array}');
    this.sparse = new Int32Array(world.capacity).fill(-1);
    this.entities = new Uint32Array(world.capacity);
    this.fields = Object.fromEntries(
      Object.entries(schema).map(([key, Type]) => {
        if (![Float32Array, Float64Array, Int32Array, Uint32Array, Uint8Array].includes(Type as typeof Float32Array))
          throw new TypeError(
            'Unsupported component storage; use Float32Array, Float64Array, Int32Array, Uint32Array or Uint8Array',
          );
        return [key, new Type(world.capacity)];
      }),
    ) as typeof this.fields;
    this.columns = Object.values(this.fields) as NumericArray[];
  }
  /** Row of `entity` in the field arrays, or -1 when it is dead or has no such component. */
  index(entity: Entity): number {
    if (!this.world.alive(entity)) return -1;
    const row = this.sparse[entity % this.world.capacity];
    return row >= 0 && this.entities[row] === entity ? row : -1;
  }
  /** True when `entity` is alive and has this component. */
  has(entity: Entity): boolean {
    return this.index(entity) >= 0;
  }
  /**
   * Add the component to `entity` (new rows start zeroed) or overwrite fields of an existing row; returns the row.
   * @throws MargoError `'state'` when the entity is stale or destroyed.
   * @throws RangeError for an unknown field or a value that is not finite or does not fit the field's storage type.
   */
  add(entity: Entity, values: Partial<Record<keyof S, number>> = {}): number {
    this.world.check(entity);
    const keys = Object.keys(values),
      columns = this.columns;
    for (const key of keys) {
      const value = values[key as keyof S];
      const field = this.fields[key];
      if (
        !Object.hasOwn(this.fields, key) ||
        typeof value !== 'number' ||
        !Number.isFinite(value) ||
        (field instanceof Float32Array && !Number.isFinite(Math.fround(value))) ||
        (field instanceof Int32Array && (!Number.isInteger(value) || value < -2147483648 || value > 2147483647)) ||
        (field instanceof Uint32Array && (!Number.isInteger(value) || value < 0 || value > 0xffffffff)) ||
        (field instanceof Uint8Array && (!Number.isInteger(value) || value < 0 || value > 255))
      )
        throw new RangeError('Invalid component data; pass finite numbers that fit the field type');
    }
    let row = this.index(entity);
    const inserted = row < 0;
    if (inserted) {
      row = this.size++;
      this.sparse[entity % this.world.capacity] = row;
      this.entities[row] = entity;
      for (let i = 0; i < columns.length; i++) columns[i][row] = 0;
    }
    for (const key of keys) this.fields[key][row] = values[key as keyof S]!;
    const observers = this.observers;
    if (inserted) for (let i = 0; i < observers.length; i++) observers[i].onAdd(entity);
    else if (keys.length) for (let i = 0; i < observers.length; i++) observers[i].onChange(entity);
    return row;
  }
  /** Report a write made straight into `fields`, which observers cannot see; false when `entity` has no row. */
  touch(entity: Entity): boolean {
    if (this.index(entity) < 0) return false;
    const observers = this.observers;
    for (let i = 0; i < observers.length; i++) observers[i].onChange(entity);
    return true;
  }
  /** Remove the component from `entity`, moving the last row into its place; false when it had none. */
  remove(entity: Entity): boolean {
    const row = this.index(entity);
    if (row < 0) return false;
    const last = --this.size;
    this.sparse[entity % this.world.capacity] = -1;
    if (row !== last) {
      const moved = this.entities[last];
      this.entities[row] = moved;
      this.sparse[moved % this.world.capacity] = row;
      const columns = this.columns;
      for (let i = 0; i < columns.length; i++) columns[i][row] = columns[i][last];
    }
    const observers = this.observers;
    for (let i = 0; i < observers.length; i++) observers[i].onRemove(entity);
    return true;
  }
}

/** Fixed-capacity entity allocator with generational ids and the component stores created from it. */
export class World {
  private readonly live: Uint8Array;
  private readonly generations: Uint32Array;
  private readonly free: Uint32Array;
  private freeCount: number;
  private readonly components = new Set<{ remove(entity: Entity): unknown }>();
  /**
   * @param capacity Maximum live entities, an integer in [1, 1_000_000]. Default 4096.
   * @throws RangeError for an invalid capacity.
   */
  constructor(readonly capacity = 4096) {
    if (!Number.isSafeInteger(capacity) || capacity < 1 || capacity > capacityLimit)
      throw new RangeError('Invalid ECS capacity; use an integer from 1 to 1000000');
    this.live = new Uint8Array(capacity);
    this.generations = new Uint32Array(capacity);
    this.free = new Uint32Array(capacity);
    this.freeCount = capacity;
    for (let i = 0; i < capacity; i++) this.free[i] = capacity - 1 - i;
  }
  /** True when `entity` is a current id of this world (created and not destroyed since). */
  alive(entity: Entity): boolean {
    if (!Number.isSafeInteger(entity) || entity < 0 || entity > 0xffffffff) return false;
    const slot = entity % this.capacity;
    return !!this.live[slot] && Math.floor(entity / this.capacity) === this.generations[slot];
  }
  /**
   * Assert that `entity` is alive.
   * @throws MargoError `'state'` when the entity is stale or destroyed.
   */
  check(entity: Entity): void {
    if (!this.alive(entity))
      throw new MargoError('state', 'Entity is stale or destroyed; check world.alive(entity) before using a stored id');
  }
  /**
   * Allocate a new entity id.
   * @throws RangeError when all `capacity` slots are in use.
   */
  create(): Entity {
    if (!this.freeCount)
      throw new RangeError('Entity capacity exhausted; destroy entities or create the World with a larger capacity');
    const slot = this.free[--this.freeCount];
    this.live[slot] = 1;
    return this.generations[slot] * this.capacity + slot;
  }
  /**
   * Remove `entity` from every component of this world and free its slot (retired instead once
   * its next id would exceed `0xffffffff`); the old id becomes stale.
   * A call made while the same entity is being destroyed, from a store's `remove`, does nothing.
   * @throws MargoError `'state'` when the entity is already stale or destroyed.
   */
  destroy(entity: Entity): void {
    this.check(entity);
    const slot = entity % this.capacity;
    // A cascade can lead back here while this entity is on its way out; the outer call finishes the job.
    if (this.live[slot] === 2) return;
    this.live[slot] = 2;
    for (const component of this.components) component.remove(entity);
    this.live[slot] = 0;
    // Retire slots before generation IDs would exceed packed Uint32 storage.
    if ((this.generations[slot] + 1) * this.capacity + slot <= 0xffffffff) {
      this.generations[slot]++;
      this.free[this.freeCount++] = slot;
    }
  }
  /** Have `store.remove(entity)` called for every entity destroyed, while it is still alive; `Relation` uses this. */
  attach(store: { remove(entity: Entity): unknown }): void {
    this.components.add(store);
  }
  /** Undo {@link World.attach}. */
  detach(store: { remove(entity: Entity): unknown }): void {
    this.components.delete(store);
  }
  /**
   * Create a component store sized to `capacity` and register it with this world.
   * @throws TypeError for an empty schema or an unsupported storage constructor.
   */
  component<S extends Schema>(schema: S): Component<S> {
    const component = new Component(this, schema);
    this.components.add(component);
    return component;
  }
  /** Create a tag: a component with no fields, for marks like `frozen`. Use it like any component: add, remove, has, query. */
  tag(): Component<Record<never, never>> {
    const tag = new Component<Record<never, never>>(this, {}, true);
    this.components.add(tag);
    return tag;
  }
  /**
   * Query output is caller-owned; returns the number of matching entity IDs.
   * @throws TypeError when `components` is empty or holds a component of another world.
   * @throws RangeError when `output` is too small for the matches.
   */
  query(components: readonly Component[], output: Uint32Array): number {
    if (!components.length || components.some((component) => component.world !== this))
      throw new TypeError('Query needs components of this world');
    let source = components[0];
    for (let i = 1; i < components.length; i++) if (components[i].size < source.size) source = components[i];
    // index() repeats the liveness test for every component; it depends only on the entity, so test it once per row.
    let count = 0;
    const capacity = this.capacity,
      live = this.live,
      generations = this.generations,
      entities = source.entities,
      size = source.size,
      width = components.length;
    for (let i = 0; i < size; i++) {
      const entity = entities[i],
        slot = entity % capacity;
      if (!live[slot] || Math.floor(entity / capacity) !== generations[slot]) continue;
      let match = true;
      for (let j = 0; j < width; j++) {
        const component = components[j],
          row = component['sparse'][slot];
        if (row < 0 || component.entities[row] !== entity) {
          match = false;
          break;
        }
      }
      if (match) {
        if (count === output.length)
          throw new RangeError(
            'Query output is too small; pass a Uint32Array at least as long as the entity count (world.capacity always fits)',
          );
        output[count++] = entity;
      }
    }
    return count;
  }
}
export { Schedule } from './schedule.js';
export type { ScheduleOptions, ScheduleTime, SystemOptions, SystemRun } from './schedule.js';
export { ChangeTracker } from './changes.js';
export { Query } from './query.js';
export type { QueryTerms } from './query.js';
export { Relation } from './relations.js';
export type { RelationOptions } from './relations.js';
