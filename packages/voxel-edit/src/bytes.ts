// Owned-buffer byte accounting: what grids, cels, sparse snapshots, deltas and image buffers keep alive, with shared
// immutable storage counted once through identity tokens.

/** One stretch of storage a value keeps alive; every holder of the same storage reports the same `token`. */
export interface OwnedBuffer {
  /** Identity of the storage (an ArrayBuffer, or an opaque object for a sparse chunk). */
  readonly token: object;
  /** Bytes the storage holds, a whole number from 0. */
  readonly bytes: number;
}

/** A value that lists its own storage, as `SparseGrid` does with `ownedBuffers()`. */
export interface BufferOwner {
  ownedBuffers(): readonly OwnedBuffer[];
}

/**
 * What {@link ownedBuffers} and {@link ByteLedger} read: an ArrayBuffer or typed array (its whole buffer), a grid,
 * cel or window (`voxels`), packed frames (`banks`), an image (`data`), a {@link BufferOwner}, an {@link OwnedBuffer},
 * or an array of any of these.
 */
export type ByteSource =
  | ArrayBufferLike
  | ArrayBufferView
  | { readonly voxels: ArrayBufferView }
  | { readonly banks: readonly ByteSource[] }
  | { readonly data: ArrayBufferView }
  | BufferOwner
  | OwnedBuffer
  | readonly ByteSource[];

const isBuffer = (value: unknown): value is ArrayBufferLike =>
  value instanceof ArrayBuffer || (typeof SharedArrayBuffer === 'function' && value instanceof SharedArrayBuffer);

function collect(value: unknown, out: Map<object, number>, depth: number): void {
  if (depth > 64) throw new RangeError('ownedBuffers input nests over 64 levels; flatten it');
  if (isBuffer(value)) {
    if (!out.has(value)) out.set(value, value.byteLength);
    return;
  }
  if (ArrayBuffer.isView(value)) return collect(value.buffer, out, depth + 1);
  if (Array.isArray(value)) {
    for (const item of value) collect(item, out, depth + 1);
    return;
  }
  if (typeof value !== 'object' || value === null)
    throw new TypeError('ownedBuffers takes buffers, typed arrays, grids, frames, images or owners; pass one');
  const item = value as Record<string, unknown>;
  if (typeof item.ownedBuffers === 'function')
    return collect((item as unknown as BufferOwner).ownedBuffers(), out, depth + 1);
  if (typeof item.token === 'object' && item.token !== null && typeof item.bytes === 'number') {
    if (!Number.isSafeInteger(item.bytes) || item.bytes < 0)
      throw new RangeError('An owned buffer has a byte count that is not a whole number from 0; fix it');
    if (!out.has(item.token)) out.set(item.token, item.bytes);
    return;
  }
  if (ArrayBuffer.isView(item.voxels)) return collect(item.voxels, out, depth + 1);
  if (Array.isArray(item.banks)) return collect(item.banks, out, depth + 1);
  if (ArrayBuffer.isView(item.data)) return collect(item.data, out, depth + 1);
  throw new TypeError('ownedBuffers found no voxels, banks, data or ownedBuffers on an object; pass a supported value');
}

/**
 * The distinct storage `value` keeps alive, each listed once: a typed array charges its whole buffer (so views of one
 * pool count once), a sparse grid its chunks (snapshots share untouched chunks, and so their tokens).
 */
export function ownedBuffers(value: ByteSource): OwnedBuffer[] {
  const out = new Map<object, number>();
  collect(value, out, 0);
  return [...out].map(([token, bytes]) => ({ token, bytes }));
}

/** Bytes of the distinct storage the values keep alive together: shared storage counts once. */
export function retainedBytes(...values: ByteSource[]): number {
  let bytes = 0;
  for (const { bytes: n } of ownedBuffers(values)) bytes += n;
  return bytes;
}

/**
 * A running count of the storage that held values keep alive, each buffer counted once however many values share it,
 * for budgets such as an undo history: `retain` an entry's values when it is kept and `release` the same values when
 * it is dropped.
 */
export class ByteLedger {
  readonly #held = new Map<object, { bytes: number; holders: number }>();
  #bytes = 0;

  /** Bytes of the distinct storage held. */
  get bytes(): number {
    return this.#bytes;
  }

  /** Distinct buffers held. */
  get buffers(): number {
    return this.#held.size;
  }

  /** Whether storage with this token is held. */
  has(token: object): boolean {
    return this.#held.has(token);
  }

  /**
   * Holds the storage `value` keeps alive (a buffer listed twice in one value is held once) and returns the bytes that
   * were not held before.
   */
  retain(value: ByteSource): number {
    let added = 0;
    for (const { token, bytes } of ownedBuffers(value)) {
      const entry = this.#held.get(token);
      if (entry) entry.holders++;
      else {
        this.#held.set(token, { bytes, holders: 1 });
        added += bytes;
      }
    }
    this.#bytes += added;
    return added;
  }

  /**
   * Lets go of what an earlier `retain(value)` held and returns the bytes no other holder keeps. Nothing changes when
   * `value` lists storage the ledger does not hold.
   * @throws RangeError for storage that was never retained.
   */
  release(value: ByteSource): number {
    const buffers = ownedBuffers(value);
    for (const { token } of buffers)
      if (!this.#held.has(token))
        throw new RangeError('ByteLedger.release got storage it does not hold; retain it first');
    let freed = 0;
    for (const { token } of buffers) {
      const entry = this.#held.get(token)!;
      if (--entry.holders) continue;
      this.#held.delete(token);
      freed += entry.bytes;
    }
    this.#bytes -= freed;
    return freed;
  }
}
