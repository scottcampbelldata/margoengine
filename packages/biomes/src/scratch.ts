// Working arrays reused from one tile to the next. A worker makes a tile in tens of milliseconds and threw away
// megabytes of fresh arrays each time: fresh pages are zeroed and mapped, and on a laptop with shared memory that slowed
// the page's own frames in the same process. Kernels that run start to finish on one thread take their working arrays
// from here instead; each array is filled before it is read, so the output bytes are the same.

type Typed = Int32Array | Int16Array | Uint16Array | Uint8Array | Uint32Array | Float64Array;

/** Typed arrays by name, kept between calls (one owner: a world, or a placement). */
export class Scratch {
  readonly #arrays = new Map<string, Typed>();

  /**
   * `length` elements of `Type` under `key`, contents left from the last use: the same memory every call (the largest
   * asked for is kept), valid until the next call with this key.
   */
  take<T extends Typed>(key: string, Type: new (length: number) => T, length: number): T {
    let a = this.#arrays.get(key) as T | undefined;
    if (!a || a.length < length || !(a instanceof Type)) this.#arrays.set(key, (a = new Type(length)));
    return a.length === length ? a : (a.subarray(0, length) as T);
  }
}
