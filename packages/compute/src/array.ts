import { fault, rangeError, typeError } from '../../shared/errors.js';
import { arrayType, bytesOf, toTyped, type DType, type TypedArrayFor } from './dtype.js';
import { Operand, type Node, type Storage } from './expr.js';
import type { ComputeContext } from './context.js';

/** Options for reading results back. */
export interface ReadOptions {
  /** Abandons the read: the promise rejects with the signal's reason. */
  readonly signal?: AbortSignal;
  /** First element to read (C order). Default 0. */
  readonly offset?: number;
  /** Elements to read. Default the rest. */
  readonly length?: number;
}

/** A slice of one dimension: an index (drops the dimension), `[start, stop, step?]` (negatives count from the end), or `null` for all. */
export type SliceSpec = number | null | readonly [number | null, (number | null)?, (number | null)?];

/** C-order strides (in elements) of `shape`. */
function stridesOf(shape: readonly number[]): number[] {
  const strides = new Array<number>(shape.length);
  let s = 1;
  for (let k = shape.length - 1; k >= 0; k--) {
    strides[k] = s;
    s *= shape[k];
  }
  return strides;
}

/** Checks a shape and returns it as a plain array. */
export function checkShape(shape: readonly number[], what = 'Shape'): number[] {
  if (!Array.isArray(shape) || shape.some((d) => !Number.isInteger(d) || d < 0))
    throw rangeError(`${what} must be whole numbers of at least 0, got [${String(shape)}]`, 'compute');
  return [...shape];
}

/** Normalizes a possibly negative axis. */
export function axisOf(axis: number, ndim: number): number {
  if (!Number.isInteger(axis) || axis < -ndim || axis >= Math.max(ndim, 1))
    throw rangeError(`Axis ${axis} is out of range for ${ndim} dimensions`, 'compute');
  return axis < 0 ? axis + ndim : axis;
}

/**
 * An N-dimensional typed array in GPU memory (`f32`, `f16`, `i32` or `u32`), NumPy style: a shape, strides and an
 * offset into a buffer that views share. `reshape`, `transpose`, `slice` and `broadcastTo` return views without
 * copying; element-wise methods (`add`, `mul`, `sqrt`, ...) return lazy expressions that run fused in one kernel;
 * reductions (`sum`, `mean`, `argmax`, ...) run on the GPU and return arrays. `read()` brings values back.
 */
export class GpuArray<T extends DType = DType> extends Operand {
  /** The shared GPU memory. @internal */
  readonly storage: Storage;
  /** Dimensions, outermost first. */
  readonly shape: readonly number[];
  /** Element step per dimension (0 for a broadcast dimension). */
  readonly strides: readonly number[];
  /** First element's index in the buffer. */
  readonly offset: number;
  #disposed = false;
  #owner: boolean;

  /** @internal Use `gpu.array()`, `gpu.zeros()` and friends. */
  constructor(
    /** The context that owns this array. */
    readonly context: ComputeContext,
    /** Element type. */
    readonly dtype: T,
    shape: readonly number[],
    view?: { storage: Storage; strides: readonly number[]; offset: number; owner?: boolean },
    /** @internal Extra buffer usage flags (INDIRECT for dispatch arguments, VERTEX to draw from). */
    usage = 0,
  ) {
    super();
    this.shape = Object.freeze(checkShape(shape));
    if (view) {
      this.storage = view.storage;
      this.strides = Object.freeze([...view.strides]);
      this.offset = view.offset;
      this.#owner = !!view.owner;
      return;
    }
    const size = this.size,
      bytes = size * bytesOf(dtype),
      max = context.device.limits.maxStorageBufferBindingSize;
    if (bytes > max)
      throw rangeError(
        `GpuArray of ${size} ${dtype} elements needs ${bytes} bytes, over this device's ${max}-byte storage binding limit; split the data or stream it`,
        'compute',
      );
    this.storage = {
      buffer: context.allocate(Math.max(16, Math.ceil(bytes / 16) * 16), usage, dtype),
      dtype,
      disposed: false,
    };
    this.strides = Object.freeze(stridesOf(this.shape));
    this.offset = 0;
    this.#owner = true;
  }

  /** The GPU buffer holding the elements (STORAGE, COPY_SRC and COPY_DST usage), for binding in your own passes. */
  get buffer(): GPUBuffer {
    return this.storage.buffer;
  }

  /** Size of the elements in bytes. */
  get byteLength(): number {
    return this.size * bytesOf(this.dtype);
  }

  /** True when the elements are packed in C order from `offset`. */
  get contiguous(): boolean {
    const want = stridesOf(this.shape);
    return this.shape.every((d, k) => d === 1 || this.strides[k] === want[k]);
  }

  /** True after `dispose()`, the context's disposal or, for a view, the owning array's disposal. */
  get disposed(): boolean {
    return this.#disposed || this.storage.disposed;
  }

  /** True when this array owns its buffer (not a view). */
  get owner(): boolean {
    return this.#owner;
  }

  /** @internal */
  node(): Node {
    return { kind: 'leaf', array: this as GpuArray };
  }

  /** @internal Throws when this array cannot be used in `context`. */
  check(context: ComputeContext): void {
    if (this.disposed) throw fault('disposed', 'GpuArray disposed; create a new array with gpu.array()', 'compute');
    if (context !== this.context)
      throw fault('state', 'GpuArray belongs to another compute context; create it with this context', 'compute');
  }

  #view(shape: readonly number[], strides: readonly number[], offset: number): GpuArray<T> {
    this.check(this.context);
    return new GpuArray(this.context, this.dtype, shape, { storage: this.storage, strides, offset });
  }

  /**
   * The same elements with a new shape (one dimension may be -1 and is inferred). A view when the array is
   * contiguous; otherwise the elements are copied first.
   */
  reshape(...shape: (number | readonly number[])[]): GpuArray<T> {
    const dims = (shape.length === 1 && Array.isArray(shape[0]) ? shape[0] : shape) as number[];
    const known = dims.filter((d) => d !== -1).reduce((a, b) => a * b, 1),
      unknown = dims.filter((d) => d === -1).length;
    if (unknown > 1) throw rangeError('reshape takes at most one -1 dimension', 'compute');
    const resolved = dims.map((d) => (d === -1 ? (known ? this.size / known : 0) : d));
    checkShape(resolved);
    if (resolved.reduce((a, b) => a * b, 1) !== this.size)
      throw rangeError(
        `Cannot reshape ${this.size} elements [${this.shape.join(', ')}] into [${dims.join(', ')}]`,
        'compute',
      );
    const source = this.contiguous ? this : (this.eval() as GpuArray<T>);
    return source.#view(resolved, stridesOf(resolved), source.offset);
  }

  /** A flat view (or copy, when not contiguous) of every element. */
  flatten(): GpuArray<T> {
    return this.reshape(this.size);
  }

  /** The dimensions permuted (default reversed): a view, no copy. */
  transpose(...axes: number[]): GpuArray<T> {
    const order = axes.length ? axes.map((a) => axisOf(a, this.ndim)) : this.shape.map((_, k) => this.ndim - 1 - k);
    if (order.length !== this.ndim || new Set(order).size !== this.ndim)
      throw rangeError(`transpose needs a permutation of ${this.ndim} axes, got [${axes.join(', ')}]`, 'compute');
    return this.#view(
      order.map((k) => this.shape[k]),
      order.map((k) => this.strides[k]),
      this.offset,
    );
  }

  /** The transpose (reversed dimensions), as NumPy's `.T`. */
  get T(): GpuArray<T> {
    return this.transpose();
  }

  /**
   * A view of part of the array, one spec per leading dimension: an index (drops the dimension), `[start, stop,
   * step]` with negatives counting from the end, or `null` for the whole dimension.
   * @example m.slice(0)            // first row
   * @example m.slice(null, [0, 3]) // first three columns
   * @example v.slice([null, null, -1]) // reversed
   */
  slice(...specs: SliceSpec[]): GpuArray<T> {
    if (specs.length > this.ndim)
      throw rangeError(`slice got ${specs.length} specs for ${this.ndim} dimensions`, 'compute');
    let offset = this.offset;
    const shape: number[] = [],
      strides: number[] = [];
    this.shape.forEach((dim, k) => {
      const spec = specs[k] ?? null;
      if (typeof spec === 'number') {
        const index = spec < 0 ? spec + dim : spec;
        if (!Number.isInteger(spec) || index < 0 || index >= dim)
          throw rangeError(`Index ${spec} is out of range for dimension ${k} of length ${dim}`, 'compute');
        offset += index * this.strides[k];
        return;
      }
      const [startIn, stopIn, stepIn] = spec ?? [];
      const step = stepIn ?? 1;
      if (!Number.isInteger(step) || step === 0)
        throw rangeError(`Slice step must be a non-zero integer, got ${step}`, 'compute');
      const clampIndex = (v: number | null | undefined, fallback: number) => {
        if (v === null || v === undefined) return fallback;
        const i = v < 0 ? v + dim : v;
        return step > 0 ? Math.min(Math.max(i, 0), dim) : Math.min(Math.max(i, -1), dim - 1);
      };
      const start = clampIndex(startIn, step > 0 ? 0 : dim - 1),
        stop = clampIndex(stopIn, step > 0 ? dim : -1),
        length = Math.max(0, Math.ceil((stop - start) / step));
      if (length) offset += start * this.strides[k];
      shape.push(length);
      strides.push(this.strides[k] * step);
    });
    return this.#view(shape, strides, offset);
  }

  /** A view with a length-1 dimension inserted at `axis`. */
  expandDims(axis: number): GpuArray<T> {
    const k = axis < 0 ? axis + this.ndim + 1 : axis;
    if (!Number.isInteger(k) || k < 0 || k > this.ndim)
      throw rangeError(`expandDims axis ${axis} is out of range`, 'compute');
    const shape = [...this.shape],
      strides = [...this.strides];
    shape.splice(k, 0, 1);
    strides.splice(k, 0, 0);
    return this.#view(shape, strides, this.offset);
  }

  /** A view without length-1 dimensions (or only `axis`). */
  squeeze(axis?: number): GpuArray<T> {
    const drop =
      axis === undefined ? this.shape.map((d) => d === 1) : this.shape.map((_, k) => k === axisOf(axis, this.ndim));
    if (axis !== undefined && this.shape[axisOf(axis, this.ndim)] !== 1)
      throw rangeError(`squeeze axis ${axis} has length ${this.shape[axisOf(axis, this.ndim)]}, not 1`, 'compute');
    return this.#view(
      this.shape.filter((_, k) => !drop[k]),
      this.strides.filter((_, k) => !drop[k]),
      this.offset,
    );
  }

  /** A view broadcast to `shape` (NumPy rules): repeated dimensions read the same elements. */
  broadcastTo(shape: readonly number[]): GpuArray<T> {
    checkShape(shape);
    const rank = shape.length;
    if (rank < this.ndim)
      throw rangeError(`Cannot broadcast [${this.shape.join(', ')}] to fewer dimensions`, 'compute');
    const strides = shape.map((d, k) => {
      const own = k - (rank - this.ndim);
      if (own < 0) return 0;
      if (this.shape[own] === d) return this.strides[own];
      if (this.shape[own] === 1) return 0;
      throw rangeError(`Cannot broadcast [${this.shape.join(', ')}] to [${shape.join(', ')}]`, 'compute');
    });
    return this.#view(shape, strides, this.offset);
  }

  /** A contiguous array with these elements: this array when it already is, else a copy. */
  ascontiguous(): GpuArray<T> {
    this.check(this.context);
    return this.contiguous && this.offset === 0 ? this : (this.eval() as GpuArray<T>);
  }

  /**
   * @internal Moves this array's buffer to a new owning array of `shape` (same size, C order); this array is left
   * disposed. Used to give results their final shape without a copy.
   */
  transfer<S extends readonly number[]>(shape: S): GpuArray<T> {
    if (!this.#owner || !this.contiguous || this.offset)
      throw fault('state', 'Only a contiguous owning array can transfer its buffer', 'compute');
    if (checkShape(shape).reduce((a, b) => a * b, 1) !== this.size)
      throw rangeError(`Cannot give ${this.size} elements the shape [${shape.join(', ')}]`, 'compute');
    const next = new GpuArray(this.context, this.dtype, shape, {
      storage: this.storage,
      strides: stridesOf(shape),
      offset: 0,
      owner: true,
    });
    this.#owner = false;
    this.#disposed = true;
    this.context.forget(this as GpuArray);
    this.context.track(next as GpuArray);
    return next;
  }

  /** Writes `data` (converted to this array's type) starting at flat element `offset`. Needs a contiguous array. */
  write(data: ArrayLike<number>, offset = 0): this {
    this.check(this.context);
    if (!this.contiguous)
      throw typeError('write needs a contiguous array; write to the array the view came from', 'compute');
    if (!Number.isInteger(offset) || offset < 0 || offset + data.length > this.size)
      throw rangeError(
        `GpuArray write of ${data.length} elements at ${offset} does not fit ${this.size} elements`,
        'compute',
      );
    if (!data.length) return this;
    const bytes = toTyped(data, this.dtype),
      size = bytesOf(this.dtype),
      at = (this.offset + offset) * size;
    if (at % 4 || bytes.byteLength % 4) {
      // queue.writeBuffer needs 4-byte alignment; an odd f16 run is widened to whole words with its neighbours.
      this.context.writeUnaligned(
        this.storage.buffer,
        at,
        new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength),
      );
    } else this.context.device.queue.writeBuffer(this.storage.buffer, at, bytes);
    return this;
  }

  /**
   * Copies the elements (C order) back to the CPU once every queued GPU operation is done. Rejects with a MargoError
   * (`failed`) when queued work failed on the GPU, and with the signal's reason when aborted.
   */
  override async read(options: ReadOptions = {}): Promise<TypedArrayFor[T]> {
    this.check(this.context);
    if (!this.contiguous) return (await super.read(options)) as TypedArrayFor[T];
    const offset = options.offset ?? 0,
      length = options.length ?? this.size - offset;
    if (
      !Number.isInteger(offset) ||
      !Number.isInteger(length) ||
      offset < 0 ||
      length < 0 ||
      offset + length > this.size
    )
      throw rangeError(`GpuArray read of ${length} elements at ${offset} is outside ${this.size} elements`, 'compute');
    const size = bytesOf(this.dtype),
      bytes = await this.context.readBytes(
        this.storage.buffer,
        (this.offset + offset) * size,
        length * size,
        options.signal,
      );
    return new (arrayType(this.dtype))(bytes) as unknown as TypedArrayFor[T];
  }

  /** Frees the GPU buffer (for a view, only the view). Using it afterwards throws a MargoError (`disposed`). */
  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    if (this.#owner) {
      this.storage.disposed = true;
      this.storage.buffer.destroy();
      this.context.forget(this as GpuArray);
    }
  }

  /** Same as `dispose()`, for `using`. */
  [Symbol.dispose](): void {
    this.dispose();
  }
}
