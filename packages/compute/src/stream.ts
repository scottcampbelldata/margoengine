// @margoengine/compute/stream: data larger than GPU memory, a chunk at a time. Chunks come from any iterable or async
// iterable of TypedArrays (a file reader, a fetch body parser, a generator); each is uploaded, handed to your function,
// and freed, and the next chunk is pulled while the GPU works on the current one. Summaries combine on the CPU in
// double precision: sums, extremes, and mean and variance by the pairwise update of T. F. Chan, G. H. Golub and
// R. J. LeVeque, "Algorithms for computing the sample variance: analysis and recommendations", Amer. Statistician
// 37(3), 1983.
import { rangeError, typeError } from '../../shared/errors.js';
import type { GpuArray } from './array.js';
import type { DType } from './dtype.js';
import { aborted, type ComputeContext, type WaitOptions } from './context.js';

/** Where chunks come from: an iterable or async iterable of TypedArrays (or number arrays). */
export type ChunkSource = Iterable<ArrayLike<number>> | AsyncIterable<ArrayLike<number>>;

/** Options for streaming. */
export interface StreamOptions extends WaitOptions {
  /** Element type of the uploaded chunks. Default from each chunk's TypedArray. */
  readonly dtype?: DType;
}

/** Splits an array into chunks of `size` elements (subarray views of a TypedArray, no copies). */
export function* chunks<T extends ArrayLike<number>>(data: T, size: number): Generator<T> {
  if (!Number.isInteger(size) || size < 1)
    throw rangeError(`Chunk size must be a whole number of at least 1, got ${size}`, 'compute');
  const sub = (data as unknown as { subarray?: (a: number, b: number) => T }).subarray;
  for (let start = 0; start < data.length; start += size)
    yield sub
      ? sub.call(data, start, Math.min(start + size, data.length))
      : (Array.prototype.slice.call(data, start, start + size) as unknown as T);
}

async function* iterate(source: ChunkSource): AsyncGenerator<ArrayLike<number>> {
  if (source && typeof (source as AsyncIterable<unknown>)[Symbol.asyncIterator] === 'function')
    yield* source as AsyncIterable<ArrayLike<number>>;
  else if (source && typeof (source as Iterable<unknown>)[Symbol.iterator] === 'function')
    yield* source as Iterable<ArrayLike<number>>;
  else throw typeError('stream takes an iterable or async iterable of TypedArrays', 'compute');
}

/**
 * Runs `work` on each chunk as a GpuArray and yields its results in order. The chunk array is freed after `work`'s
 * result settles; the next chunk is read from the source meanwhile.
 * @example for await (const sum of stream(gpu, chunks(bigData, 1 << 24), (c) => c.sum().item())) total += sum;
 */
export async function* stream<R>(
  gpu: ComputeContext,
  source: ChunkSource,
  work: (chunk: GpuArray, index: number) => R | Promise<R>,
  options: StreamOptions = {},
): AsyncGenerator<Awaited<R>> {
  if (typeof work !== 'function') throw typeError('stream needs a function to run on each chunk', 'compute');
  const it = iterate(source);
  let next = it.next(),
    index = 0;
  while (true) {
    aborted(options.signal);
    const item = await next;
    if (item.done) return;
    const chunk = options.dtype ? gpu.array(item.value, options.dtype) : gpu.array(item.value);
    next = it.next();
    try {
      yield await work(chunk, index++);
    } finally {
      chunk.dispose();
    }
  }
}

/** Folds every chunk with `op` and resolves the result (combined in double precision across chunks). */
export async function reduceStream(
  gpu: ComputeContext,
  source: ChunkSource,
  op: 'sum' | 'product' | 'min' | 'max' = 'sum',
  options: StreamOptions = {},
): Promise<number> {
  const combine = {
    sum: (a: number, b: number) => a + b,
    product: (a: number, b: number) => a * b,
    min: Math.min,
    max: Math.max,
  }[op];
  if (!combine) throw typeError(`reduceStream op must be sum, product, min or max, got ${op}`, 'compute');
  let total = { sum: 0, product: 1, min: Infinity, max: -Infinity }[op];
  for await (const part of stream(gpu, source, (c) => gpu.reduce(c, op).item(options), options))
    total = combine(total, part);
  return total;
}

/** Summary statistics of a stream. */
export interface StreamStats {
  readonly count: number;
  readonly mean: number;
  /** Population variance (divide by count); multiply by count / (count - 1) for the sample variance. */
  readonly variance: number;
  readonly min: number;
  readonly max: number;
}

/** Count, mean, variance, min and max of every value in a stream, in one pass over the data. */
export async function statsStream(
  gpu: ComputeContext,
  source: ChunkSource,
  options: StreamOptions = {},
): Promise<StreamStats> {
  let count = 0,
    mean = 0,
    m2 = 0,
    min = Infinity,
    max = -Infinity;
  const parts = stream(
    gpu,
    source,
    async (c) => {
      const m = c.mean(),
        v = c.var(),
        lo = c.min(),
        hi = c.max();
      const values = await Promise.all([m, v, lo, hi].map((a) => a.item(options)));
      for (const a of [m, v, lo, hi]) a.dispose();
      return { n: c.size, values };
    },
    options,
  );
  for await (const { n, values } of parts) {
    if (!n) continue;
    const [chunkMean, chunkVariance, lo, hi] = values,
      total = count + n,
      delta = chunkMean - mean;
    // Chan, Golub and LeVeque's pairwise combination of (count, mean, M2).
    m2 += chunkVariance * n + delta * delta * ((count * n) / total);
    mean += delta * (n / total);
    count = total;
    min = Math.min(min, lo);
    max = Math.max(max, hi);
  }
  return { count, mean: count ? mean : NaN, variance: count ? m2 / count : NaN, min, max };
}

/** A histogram over a fixed range accumulated chunk by chunk on the GPU (counts and edges as `histogram` gives them). */
export async function histogramStream(
  gpu: ComputeContext,
  source: ChunkSource,
  histogramOptions: { readonly bins?: number; readonly range: readonly [number, number] },
  options: StreamOptions = {},
): Promise<{ counts: GpuArray<'u32'>; edges: GpuArray<'f32'> }> {
  if (!histogramOptions?.range) throw rangeError('histogramStream needs a fixed range so chunks share bins', 'compute');
  let counts: GpuArray<'u32'> | undefined, edges: GpuArray<'f32'> | undefined;
  for await (const h of stream(gpu, source, (c) => gpu.histogram(c, histogramOptions), options)) {
    if (!counts) {
      counts = h.counts;
      edges = h.edges;
      continue;
    }
    const sum = counts.add(h.counts).eval() as GpuArray<'u32'>;
    counts.dispose();
    h.counts.dispose();
    h.edges.dispose();
    counts = sum;
  }
  if (!counts) {
    const none = gpu.zeros(0),
      empty = gpu.histogram(none, histogramOptions);
    none.dispose();
    return empty;
  }
  return { counts, edges: edges! };
}
