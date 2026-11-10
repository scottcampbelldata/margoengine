import { Component, type ArrayConstructor, type Entity, type World } from './index.js';

/** A reference field with a fresh default per row. Values retain identity, including functions and cycles. */
export interface ObjectField<T = unknown> {
  /** Called for each new row; default is undefined. */
  readonly create: () => T;
}

/** Declare a JS value field. Pass a factory for independent mutable defaults. */
export function objectField<T = unknown>(create: () => T = (() => undefined) as () => T): ObjectField<T> {
  if (typeof create !== 'function') throw new TypeError('Invalid object field factory; pass a function');
  return Object.freeze({ create });
}

/** Mixed reference/numeric component schema. */
export type ObjectSchema = Record<string, ArrayConstructor | ObjectField>;
/** Value of one field of a mixed schema. */
export type ObjectValue<T> = T extends ObjectField<infer V> ? V : number;
/** Packed mixed fields, indexed with component.index(entity). */
export type ObjectFields<S extends ObjectSchema> = {
  [K in keyof S]: S[K] extends ArrayConstructor ? InstanceType<S[K]> : ObjectValue<S[K]>[];
};

/** A query-compatible component with arbitrary JS fields beside packed numeric arrays. */
export class ObjectComponent<S extends ObjectSchema> extends Component<Record<never, never>> {
  declare readonly fields: ObjectFields<S>;
  private readonly objects: [string, ObjectField][];
  /** @throws TypeError for an empty schema, invalid factory or unsupported numeric constructor. */
  constructor(world: World, schema: S) {
    const objects: [string, ObjectField][] = [];
    const numeric: Record<string, ArrayConstructor> = {};
    for (const [key, type] of Object.entries(schema)) {
      if (typeof type === 'object' && type !== null && typeof type.create === 'function') objects.push([key, type]);
      else Object.defineProperty(numeric, key, { value: type, enumerable: true });
    }
    if (!Object.keys(schema).length) throw new TypeError('Empty object schema; declare at least one field');
    super(world, numeric, true);
    this.objects = objects;
    for (const [key] of objects) Object.defineProperty(this.fields, key, { value: [], enumerable: true });
    world.attach(this);
  }
  /** Add or update a row atomically after validation; omitted new object fields use their factories. */
  override add(entity: Entity, values: Partial<{ [K in keyof S]: ObjectValue<S[K]> }> = {}): number {
    return super.add(entity, values);
  }
  protected override validateValues(values: Record<string, unknown>): void {
    const numeric: Record<string, number> = {};
    for (const [key, value] of Object.entries(values)) {
      if (!Object.hasOwn(this.fields, key)) throw new RangeError('Unknown object component field; use a schema field');
      if (!Array.isArray(this.fields[key])) Object.defineProperty(numeric, key, { value, enumerable: true });
    }
    super.validateValues(numeric);
  }
  protected override initializeRow(row: number): void {
    const defaults = this.objects.map(([, field]) => field.create());
    super.initializeRow(row);
    for (let i = 0; i < this.objects.length; i++) (this.fields[this.objects[i][0]] as unknown[])[row] = defaults[i];
  }
  protected override moveRow(row: number, last: number): void {
    super.moveRow(row, last);
    for (const [key] of this.objects) {
      const column = this.fields[key] as unknown[];
      if (row !== last) column[row] = column[last];
      column.length = last;
    }
  }
}
