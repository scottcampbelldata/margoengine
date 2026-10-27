/**
 * A typed blackboard key: the name it is stored under and the value `get` returns while it is unset. Make one with
 * {@link blackboardKey} and share it between the code that writes and the code that reads, so both agree on the type.
 */
export interface BlackboardKey<T> {
  /** Storage name; also the property name in {@link Blackboard.toJSON}. */
  readonly name: string;
  /** Returned by {@link Blackboard.get} while the key is unset. */
  readonly fallback: T;
}

/**
 * Declare a typed blackboard key.
 * @example const target = blackboardKey<[number, number, number] | null>('target', null);
 * @throws TypeError for an empty name.
 */
export function blackboardKey<T>(name: string, fallback: T): BlackboardKey<T> {
  if (typeof name !== 'string' || !name) throw new TypeError('Blackboard key name must be a non-empty string');
  return Object.freeze({ name, fallback });
}

/**
 * Shared memory of one agent (or a squad): behaviour-tree conditions, actions and utility scores read and write it
 * through typed {@link BlackboardKey}s. `version` counts writes, so a caller can tell when anything changed.
 */
export class Blackboard {
  private readonly values = new Map<string, unknown>();
  /** Increases by one on every `set`, `delete` or `clear` that changed something. */
  version = 0;
  /** @param initial Values to start with, by key name (for example the output of {@link Blackboard.toJSON}). */
  constructor(initial?: Readonly<Record<string, unknown>>) {
    if (initial != null) {
      if (typeof initial !== 'object')
        throw new TypeError('Blackboard initial values must be an object of name: value');
      for (const [name, value] of Object.entries(initial)) this.values.set(name, value);
    }
  }
  /** The stored value, or the key's fallback while it is unset. */
  get<T>(key: BlackboardKey<T>): T {
    return this.values.has(key.name) ? (this.values.get(key.name) as T) : key.fallback;
  }
  /** Store `value` under `key`. */
  set<T>(key: BlackboardKey<T>, value: T): this {
    if (!this.values.has(key.name) || !Object.is(this.values.get(key.name), value)) {
      this.values.set(key.name, value);
      this.version++;
    }
    return this;
  }
  /** True when `key` has been set (and not deleted). */
  has(key: BlackboardKey<unknown>): boolean {
    return this.values.has(key.name);
  }
  /** Unset `key`; returns whether it was set. */
  delete(key: BlackboardKey<unknown>): boolean {
    const had = this.values.delete(key.name);
    if (had) this.version++;
    return had;
  }
  /** Unset every key. */
  clear(): void {
    if (this.values.size) this.version++;
    this.values.clear();
  }
  /** The set values by key name, for saving; pass it back to the constructor to restore. */
  toJSON(): Record<string, unknown> {
    return Object.fromEntries(this.values);
  }
}
