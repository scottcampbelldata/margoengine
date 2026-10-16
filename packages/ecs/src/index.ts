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

/** Packed sparse-set component store. Data rows move when entities are removed. */
export class Component<S extends Schema = Schema> {
  readonly fields: { [K in keyof S]: InstanceType<S[K]> };
  readonly entities: Uint32Array;
  private readonly sparse: Int32Array;
  /** Field arrays in schema order, so row moves need no per-call Object.values. */
  private readonly columns: NumericArray[];
  size = 0;
  /**
   * Prefer {@link World.component}, which also registers the store for cleanup on `destroy`.
   * @throws TypeError for an empty schema or an unsupported storage constructor.
   */
  constructor(
    readonly world: World,
    schema: S,
  ) {
    if (!Object.keys(schema).length) throw new TypeError('Empty component schema');
    this.sparse = new Int32Array(world.capacity).fill(-1);
    this.entities = new Uint32Array(world.capacity);
    this.fields = Object.fromEntries(
      Object.entries(schema).map(([key, Type]) => {
        if (![Float32Array, Float64Array, Int32Array, Uint32Array, Uint8Array].includes(Type as typeof Float32Array))
          throw new TypeError('Unsupported component storage');
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
        throw new RangeError('Invalid component data');
    }
    let row = this.index(entity);
    if (row < 0) {
      row = this.size++;
      this.sparse[entity % this.world.capacity] = row;
      this.entities[row] = entity;
      for (let i = 0; i < columns.length; i++) columns[i][row] = 0;
    }
    for (const key of keys) this.fields[key][row] = values[key as keyof S]!;
    return row;
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
    return true;
  }
}

/** Fixed-capacity entity allocator with generational ids and the component stores created from it. */
export class World {
  private readonly live: Uint8Array;
  private readonly generations: Uint32Array;
  private readonly free: Uint32Array;
  private freeCount: number;
  private readonly components = new Set<Component>();
  /**
   * @param capacity Maximum live entities, an integer in [1, 1_000_000]. Default 4096.
   * @throws RangeError for an invalid capacity.
   */
  constructor(readonly capacity = 4096) {
    if (!Number.isSafeInteger(capacity) || capacity < 1 || capacity > capacityLimit)
      throw new RangeError('Invalid ECS capacity');
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
    if (!this.freeCount) throw new RangeError('Entity capacity exhausted');
    const slot = this.free[--this.freeCount];
    this.live[slot] = 1;
    return this.generations[slot] * this.capacity + slot;
  }
  /**
   * Remove `entity` from every component of this world and free its slot (retired instead once
   * its next id would exceed `0xffffffff`); the old id becomes stale.
   * @throws MargoError `'state'` when the entity is already stale or destroyed.
   */
  destroy(entity: Entity): void {
    this.check(entity);
    for (const component of this.components) component.remove(entity);
    const slot = entity % this.capacity;
    this.live[slot] = 0;
    // Retire slots before generation IDs would exceed packed Uint32 storage.
    if ((this.generations[slot] + 1) * this.capacity + slot <= 0xffffffff) {
      this.generations[slot]++;
      this.free[this.freeCount++] = slot;
    }
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
        if (count === output.length) throw new RangeError('Query output is too small');
        output[count++] = entity;
      }
    }
    return count;
  }
}
