// JSON extras for the glTF writers: copied and checked at write time, so the mesh-only formats never load this.
const isObject = (value: unknown): value is object => typeof value === 'object' && value !== null;

const plain = (value: object): boolean => {
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};

/**
 * @internal A JSON copy of `extras`, or undefined. Throws for values JSON would drop or change silently: non-finite
 * numbers, functions, class instances (typed arrays included) and cycles.
 */
export function copyExtras(value: unknown, label: string): Record<string, unknown> | undefined {
  if (value === undefined) return undefined;
  if (!isObject(value) || Array.isArray(value) || !plain(value))
    throw new TypeError(`${label} must be a plain object; wrap the data in { ... }`);
  const path = new Set<object>();
  const copy = (item: unknown, depth: number): unknown => {
    if (item === null || typeof item === 'string' || typeof item === 'boolean') return item;
    if (typeof item === 'number') {
      if (!Number.isFinite(item)) throw new RangeError(`${label} holds ${item}; JSON has no such number, store null`);
      return item;
    }
    if (typeof item !== 'object')
      throw new TypeError(`${label} holds a ${typeof item}; extras take JSON values only, convert it first`);
    if (depth > 64) throw new RangeError(`${label} nests deeper than 64 levels; flatten it`);
    if (path.has(item)) throw new TypeError(`${label} is circular; extras must be a JSON tree`);
    if (!Array.isArray(item) && !plain(item))
      throw new TypeError(
        `${label} holds a ${item.constructor?.name ?? 'class'} instance; convert it (Array.from for typed arrays)`,
      );
    path.add(item);
    let out: unknown;
    if (Array.isArray(item)) out = Array.from(item, (entry) => copy(entry ?? null, depth + 1));
    else {
      const record: Record<string, unknown> = {};
      for (const key of Object.keys(item)) {
        const entry = (item as Record<string, unknown>)[key];
        // Defined, not assigned, so a "__proto__" member stays an ordinary key.
        if (entry !== undefined)
          Object.defineProperty(record, key, {
            value: copy(entry, depth + 1),
            enumerable: true,
            writable: true,
            configurable: true,
          });
      }
      out = record;
    }
    path.delete(item);
    return out;
  };
  return copy(value, 0) as Record<string, unknown>;
}
