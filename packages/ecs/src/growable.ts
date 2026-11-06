import { World } from './index.js';
import type { NumericArray } from './index.js';

/** Settings of a {@link GrowableWorld}. */
export interface GrowableWorldOptions {
  /** Slots at the start, an integer in [1, `limit`]. Default 1024. */
  capacity?: number;
  /** Most slots it may grow to, an integer up to 1,000,000. Default 1,000,000. Entity ids are spaced by it. */
  limit?: number;
}

/** The resizable buffer of a typed array; the standard types this repository builds against predate `resize`. */
type Resizable = { resize(bytes: number): void };
type ResizableConstructor = new (bytes: number, options: { maxByteLength: number }) => ArrayBuffer;
/** One array to grow. Weak, so a stopped tracker's arrays can go; the array keeps its buffer alive. */
type Slotted = { array: WeakRef<NumericArray>; fill: number };

/**
 * A {@link World} that doubles its slots when `create` runs out, up to `limit`. Every array sized by slot sits on a
 * resizable buffer, so growing moves nothing: `component.fields`, arrays taken from them, and arrays from
 * {@link World.allocate} stay valid and only get longer. Ids do not change either.
 */
export class GrowableWorld extends World {
  // No initializer: World's constructor calls allocate before a field of this class could be set.
  declare private slotted: Slotted[] | undefined;
  /** @throws RangeError for a capacity or limit that is not an integer, or a capacity above the limit. */
  constructor({ capacity = 1024, limit = 1_000_000 }: GrowableWorldOptions = {}) {
    super(capacity, limit);
  }
  /** Most slots this world may grow to. */
  get limit(): number {
    return this.stride;
  }
  override allocate<T extends NumericArray>(Type: new (length: number) => T, fill = 0): T {
    const { BYTES_PER_ELEMENT: bytes } = Type as unknown as { BYTES_PER_ELEMENT: number },
      buffer = new (ArrayBuffer as unknown as ResizableConstructor)(this.capacity * bytes, {
        maxByteLength: this.stride * bytes,
      }),
      array = new (Type as unknown as new (buffer: ArrayBuffer) => T)(buffer);
    if (fill) array.fill(fill);
    (this.slotted ??= []).push({ array: new WeakRef(array), fill });
    return array;
  }
  protected override grow(): void {
    const old = this.capacity;
    if (old >= this.stride)
      throw new RangeError('Entity limit reached; destroy entities or create the GrowableWorld with a higher limit');
    const next = Math.min(old * 2, this.stride);
    this.slotted = (this.slotted as Slotted[]).filter(({ array: reference, fill }) => {
      const array = reference.deref();
      if (!array) return false;
      (array.buffer as unknown as Resizable).resize(next * array.BYTES_PER_ELEMENT);
      if (fill) array.fill(fill, old);
      return true;
    });
    (this as { capacity: number }).capacity = next;
    this.release(old, next);
  }
}
