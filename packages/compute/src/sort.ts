// Sorting on the GPU: a stable LSD radix sort (shaders.ts) with keys made from any element type, and what is built on
// it: argsort, sortByKey, top-k, quantiles and unique.
import { rangeError, typeError } from '../../shared/errors.js';
import type { GpuArray } from './array.js';
import { bytesOf } from './dtype.js';
import { Operand, fuse } from './expr.js';
import { WG, fromKeyShader, keyShader, radixLocalShader, radixScatterShader } from './shaders.js';
import { compactInto, readCount } from './select.js';
import { exclusiveSumPasses } from './scan.js';
import type { ComputeContext, Copy, Pass, WaitOptions } from './context.js';

/** Options for sorting. */
export interface SortOptions {
  /** Largest first. Default false. */
  readonly descending?: boolean;
  /**
   * Low key bits to sort on, rounded up to a multiple of 4 (one radix pass each). Default 32; fewer for u32 keys
   * known to be small (`bits: 16` for keys below 65,536 runs half the passes).
   */
  readonly bits?: number;
}

const INF = 0x7f800000;

interface Sorted {
  /** Sorted u32 keys (ascending, already inverted for a descending sort) in a padded scratch array. */
  keys: GpuArray<'u32'>;
  /** The payload moved with the keys, when asked for. */
  values?: GpuArray<'u32'>;
  /** Scratch arrays to dispose after use. */
  scratch: GpuArray[];
}

/**
 * Radix-sorts the keys of `input` (flat), moving a u32 payload: the indices (`payload: 'index'`), the 32-bit pattern
 * of `values`, or nothing.
 */
function radix(
  ctx: ComputeContext,
  input: Operand,
  payload: 'index' | GpuArray | undefined,
  options: SortOptions,
): Sorted {
  ctx.check();
  if (!(input instanceof Operand)) throw typeError('sort takes a GpuArray or an Expr', 'compute');
  const n = input.size,
    bits = options.bits ?? 32;
  if (!Number.isInteger(bits) || bits < 1 || bits > 32)
    throw rangeError(`Sort bits must be a whole number from 1 to 32, got ${bits}`, 'compute');
  if (bits < 32 && input.dtype !== 'u32')
    throw rangeError('Sort bits below 32 apply to u32 keys only; drop bits for other types', 'compute');
  const blocks = Math.max(1, Math.ceil(n / WG)),
    padded = blocks * WG,
    hasValues = payload !== undefined,
    scratch: GpuArray[] = [];
  const temp = (length: number) => {
    const a = ctx.empty([length], 'u32');
    scratch.push(a);
    return a;
  };
  let keysA = temp(padded),
    keysB = temp(padded),
    valuesA = temp(hasValues ? padded : 1),
    valuesB = temp(hasValues ? padded : 1);
  if (n === 0) return { keys: keysA, values: hasValues ? valuesA : undefined, scratch };
  const local = temp(padded),
    localValues = temp(hasValues ? padded : 1),
    counts = temp(16 * blocks),
    offsets = temp(16 * blocks),
    starts = temp(16 * blocks),
    passes: Pass[] = [],
    copies: Copy[] = [];
  const src = fuse(input, 0, ctx.maxStorage(2), scratch);
  passes.push({
    program: ctx.program(keyShader(src), undefined, 'sort.keys'),
    resources: {
      ...src.resources,
      keys: keysA,
      order: valuesA,
      params: new Uint32Array([n, INF, options.descending ? 1 : 0, payload === 'index' ? 1 : 0]),
    },
    workgroups: ctx.grid(Math.ceil(n / WG)),
  });
  if (payload && payload !== 'index') {
    const v = payload.ascontiguous();
    if (v !== payload) scratch.push(v);
    if (bytesOf(v.dtype) !== 4)
      throw typeError('sortByKey values must be a 32-bit type; astype("f32") first', 'compute');
    // Values travel as their 32-bit patterns.
    copies.push([v.buffer, v.offset * 4, valuesA.buffer, 0, n * 4]);
    ctx.submit([], copies.splice(0));
  }
  const localProgram = ctx.program(radixLocalShader, undefined, 'sort.local'),
    scatterProgram = ctx.program(radixScatterShader, undefined, 'sort.scatter'),
    grid = ctx.grid(blocks);
  for (let shift = 0; shift < bits; shift += 4) {
    const params = new Uint32Array([n, shift, blocks, hasValues ? 1 : 0]);
    passes.push({
      program: localProgram,
      resources: {
        keysIn: keysA,
        valuesIn: valuesA,
        keysLocal: local,
        valuesLocal: localValues,
        counts,
        starts,
        radix: params,
      },
      workgroups: grid,
    });
    exclusiveSumPasses(ctx, counts, offsets, 16 * blocks, passes, scratch);
    passes.push({
      program: scatterProgram,
      resources: {
        keysLocal: local,
        valuesLocal: localValues,
        offsets,
        starts,
        keysOut: keysB,
        valuesOut: valuesB,
        radix: params,
      },
      workgroups: grid,
    });
    [keysA, keysB] = [keysB, keysA];
    [valuesA, valuesB] = [valuesB, valuesA];
  }
  ctx.submit(passes);
  return { keys: keysA, values: hasValues ? valuesA : undefined, scratch };
}

/** Sorted copy (see ComputeContext.sort). */
export function sort(ctx: ComputeContext, input: Operand, options: SortOptions = {}): GpuArray {
  const sorted = radix(ctx, input, undefined, options),
    n = input.size,
    out = ctx.empty([n], input.dtype);
  if (n > 0)
    ctx.submit([
      {
        program: ctx.program(fromKeyShader(input.dtype), undefined, 'sort.values'),
        resources: { keys: sorted.keys, dst: out, params: new Uint32Array([n, INF, options.descending ? 1 : 0, 0]) },
        workgroups: ctx.grid(Math.ceil(n / WG)),
      },
    ]);
  for (const a of sorted.scratch) a.dispose();
  return out;
}

/** Indices that sort (see ComputeContext.argsort). */
export function argsort(ctx: ComputeContext, input: Operand, options: SortOptions = {}): GpuArray<'u32'> {
  const sorted = radix(ctx, input, 'index', options),
    n = input.size,
    out = ctx.empty([n], 'u32');
  ctx.submit([], [[sorted.values!.buffer, 0, out.buffer, 0, n * 4]]);
  for (const a of sorted.scratch) a.dispose();
  return out;
}

/** Sort keys moving values (see ComputeContext.sortByKey). */
export function sortByKey(
  ctx: ComputeContext,
  keys: Operand,
  values: Operand,
  options: SortOptions = {},
): { keys: GpuArray; values: GpuArray } {
  if (!(values instanceof Operand)) throw typeError('sortByKey values must be a GpuArray or an Expr', 'compute');
  if (keys.size !== values.size)
    throw rangeError(`sortByKey keys (${keys.size}) and values (${values.size}) differ in size`, 'compute');
  const v = values.eval(),
    sorted = radix(ctx, keys, v, options),
    n = keys.size,
    outKeys = ctx.empty([n], keys.dtype),
    outValues = ctx.empty([n], values.dtype);
  if (n > 0)
    ctx.submit(
      [
        {
          program: ctx.program(fromKeyShader(keys.dtype), undefined, 'sort.values'),
          resources: {
            keys: sorted.keys,
            dst: outKeys,
            params: new Uint32Array([n, INF, options.descending ? 1 : 0, 0]),
          },
          workgroups: ctx.grid(Math.ceil(n / WG)),
        },
      ],
      [[sorted.values!.buffer, 0, outValues.buffer, 0, n * 4]],
    );
  v.dispose();
  for (const a of sorted.scratch) a.dispose();
  return { keys: outKeys, values: outValues };
}

/** The k largest or smallest (see ComputeContext.topk). */
export function topk(
  ctx: ComputeContext,
  input: Operand,
  k: number,
  options: { readonly largest?: boolean } = {},
): { values: GpuArray; indices: GpuArray<'u32'> } {
  if (!Number.isInteger(k) || k < 0 || k > input.size)
    throw rangeError(`topk k must be a whole number from 0 to ${input.size}, got ${k}`, 'compute');
  const order = argsort(ctx, input, { descending: options.largest ?? true }),
    indices = ctx.empty([k], 'u32');
  ctx.submit([], [[order.buffer, 0, indices.buffer, 0, k * 4]]);
  order.dispose();
  const values = ctx.take(input, indices);
  return { values, indices };
}

/** Quantiles with linear interpolation (see ComputeContext.quantile). */
export function quantile(ctx: ComputeContext, input: Operand, q: number | readonly number[]): GpuArray<'f32'> {
  const list = typeof q === 'number' ? [q] : [...q];
  for (const v of list) if (!(v >= 0 && v <= 1)) throw rangeError(`Quantiles must be in [0, 1], got ${v}`, 'compute');
  const n = input.size;
  if (n === 0) throw rangeError('quantile of an empty array has no answer', 'compute');
  const sorted = sort(ctx, input).astype('f32').eval();
  // NumPy's linear method: position q * (n - 1) between the two neighbouring order statistics.
  const lower = list.map((v) => Math.floor(v * (n - 1))),
    upper = lower.map((l) => Math.min(l + 1, n - 1)),
    weight = list.map((v, k) => v * (n - 1) - lower[k]);
  const lo = ctx.take(sorted, ctx.array(lower, 'u32')),
    hi = ctx.take(sorted, ctx.array(upper, 'u32')),
    w = ctx.array(weight, 'f32');
  const result = lo.add(hi.sub(lo).mul(w)).eval() as GpuArray<'f32'>;
  for (const a of [sorted, lo, hi, w]) a.dispose();
  return typeof q === 'number' ? result.transfer([]) : result;
}

/** Distinct values and counts (see ComputeContext.unique). */
export async function unique(
  ctx: ComputeContext,
  input: Operand,
  options: { readonly counts?: boolean } & WaitOptions = {},
): Promise<{ values: GpuArray; counts?: GpuArray<'u32'> }> {
  const n = input.size;
  if (n === 0)
    return { values: ctx.empty([0], input.dtype), ...(options.counts ? { counts: ctx.empty([0], 'u32') } : {}) };
  const sorted = sort(ctx, input);
  const heads = ctx.empty([n], 'u32');
  if (n > 1) {
    const differs = sorted
      .slice([1, n])
      .ne(sorted.slice([0, n - 1]))
      .eval();
    ctx.submit([], [[differs.buffer, 0, heads.buffer, 4, (n - 1) * 4]]);
    differs.dispose();
  }
  heads.write([1], 0);
  const run = compactInto(ctx, sorted, heads);
  let positions: { values: GpuArray; count: GpuArray<'u32'> } | undefined;
  if (options.counts) {
    const index = ctx.arange(0, n, 1, 'u32');
    positions = compactInto(ctx, index, heads);
    index.dispose();
  }
  const count = await readCount(ctx, run.count, options.signal);
  const values = ctx.empty([count], input.dtype);
  ctx.submit([], [[run.values.buffer, 0, values.buffer, 0, values.byteLength]]);
  let counts: GpuArray<'u32'> | undefined;
  if (positions) {
    // Each run's length is the next run's start minus its own (n after the last).
    const starts = ctx.empty([count + 1], 'u32');
    ctx.submit([], [[positions.values.buffer, 0, starts.buffer, 0, count * 4]]);
    starts.write([n], count);
    counts = starts
      .slice([1, count + 1])
      .sub(starts.slice([0, count]))
      .eval() as GpuArray<'u32'>;
    starts.dispose();
    positions.values.dispose();
    positions.count.dispose();
  }
  for (const a of [sorted, heads, run.values, run.count]) a.dispose();
  return counts ? { values, counts } : { values };
}
