// Scans: plain (flat), along an axis (a segmented scan whose segments are the lines), segmented by flags, and the
// group-by `reduceByKey` built on the segmented scan and compaction.
import { typeError } from '../../shared/errors.js';
import { axisOf, type GpuArray } from './array.js';
import { Operand, fuse } from './expr.js';
import {
  BLOCK,
  addShader,
  operator,
  scanShader,
  segmentedAddShader,
  segmentedShader,
  type Operator,
} from './shaders.js';
import { compactInto, readCount } from './select.js';
import type { ComputeContext, Pass, WaitOptions } from './context.js';

/** Options for scans. */
export interface ScanOptions {
  /** Operator. Default `'sum'`. */
  readonly op?: Operator;
  /** Exclusive scan (element i combines elements before it, starting from the identity). Default false. */
  readonly exclusive?: boolean;
  /** Scan each line along this axis on its own. Default: the flat array. */
  readonly axis?: number;
}

const INF = 0x7f800000;

/** Queues the passes of a flat scan of `source` (n values) into `dst`. */
function flatPasses(
  ctx: ComputeContext,
  source: Operand,
  dst: GpuArray,
  n: number,
  op: Operator,
  exclusive: boolean,
  passes: Pass[],
  temporary: GpuArray[],
): void {
  const { combine, identity } = operator(op, dst.dtype),
    groups = Math.ceil(n / BLOCK),
    sums = ctx.empty([groups], dst.dtype),
    src = fuse(source, 0, ctx.maxStorage(2), temporary);
  temporary.push(sums);
  passes.push({
    program: ctx.program(
      ctx.kernelRoute?.scan(src, combine, identity) ?? scanShader(src, combine, identity, ctx.tuned.scan),
      undefined,
      'scan',
    ),
    resources: { ...src.resources, dst, sums, params: new Uint32Array([n, INF, exclusive ? 1 : 0, 0]) },
    workgroups: ctx.grid(groups),
  });
  if (groups === 1) return;
  const scanned = ctx.empty([groups], dst.dtype);
  temporary.push(scanned);
  flatPasses(ctx, sums, scanned, groups, op, true, passes, temporary);
  passes.push({
    program: ctx.program(addShader(dst.dtype, combine), undefined, 'scan.add'),
    resources: { data: dst, sums: scanned, params: new Uint32Array([n, INF, 0, 0]) },
    workgroups: ctx.grid(groups),
  });
}

/**
 * Queues an inclusive segmented scan of `source` into `dst`: segments start where `flags` is non-zero, or every
 * `period` elements when `flags` is undefined.
 */
function segmentedPasses(
  ctx: ComputeContext,
  source: Operand,
  flags: GpuArray | undefined,
  period: number,
  dst: GpuArray,
  n: number,
  op: Operator,
  passes: Pass[],
  temporary: GpuArray[],
): void {
  const { combine, identity } = operator(op, dst.dtype),
    groups = Math.ceil(n / BLOCK),
    seen = ctx.empty([n], 'u32'),
    sumFlags = ctx.empty([groups], 'u32'),
    sumValues = ctx.empty([groups], dst.dtype),
    src = fuse(source, 0, ctx.maxStorage(5), temporary),
    // Periodic segments read no flags; a placeholder fills the binding (it must not alias a written buffer).
    noFlags = flags ? undefined : ctx.empty([1], 'u32');
  temporary.push(seen, sumFlags, sumValues);
  if (noFlags) temporary.push(noFlags);
  passes.push({
    program: ctx.program(segmentedShader(src, combine, identity, !flags), undefined, 'scan.segmented'),
    resources: {
      ...src.resources,
      flagsIn: flags ?? noFlags!,
      dst,
      seen,
      sumFlags,
      sumValues,
      params: new Uint32Array([n, INF, 0, period]),
    },
    workgroups: ctx.grid(groups),
  });
  if (groups === 1) return;
  const scanned = ctx.empty([groups], dst.dtype);
  temporary.push(scanned);
  segmentedPasses(ctx, sumValues, sumFlags, 0, scanned, groups, op, passes, temporary);
  passes.push({
    program: ctx.program(segmentedAddShader(dst.dtype, combine), undefined, 'scan.segmented.add'),
    resources: { data: dst, seen, scanned, params: new Uint32Array([n, INF, 0, 0]) },
    workgroups: ctx.grid(groups),
  });
}

/**
 * Shifts an inclusive segmented scan to exclusive: the identity at each segment start (where `flags` is non-zero, or
 * every `period` elements without flags), else the previous element's value.
 */
function exclusiveFrom(
  ctx: ComputeContext,
  inclusive: GpuArray,
  flags: GpuArray | undefined,
  period: number,
  op: Operator,
): GpuArray {
  const { identity } = operator(op, inclusive.dtype);
  const code = /* wgsl */ `${inclusive.dtype === 'f16' ? 'enable f16;\n' : ''}struct Params { n: u32, inf: u32, a: u32, b: u32 }
@group(0) @binding(0) var<storage, read> inclusive: array<${inclusive.dtype}>;
@group(0) @binding(1) var<storage, read> flags: array<u32>;
@group(0) @binding(2) var<storage, read_write> dst: array<${inclusive.dtype}>;
@group(0) @binding(3) var<uniform> params: Params;
@compute @workgroup_size(256)
fn main(@builtin(workgroup_id) wid: vec3u, @builtin(num_workgroups) nwg: vec3u, @builtin(local_invocation_index) lid: u32) {
  let i = (wid.x + wid.y * nwg.x) * 256u + lid;
  if (i >= params.n) { return; }
  var start = i == 0u;
  if (params.b > 0u) { start = start || i % params.b == 0u; } else { start = start || flags[i] != 0u; }
  if (start) { dst[i] = ${identity}; } else { dst[i] = inclusive[i - 1u]; }
}`;
  const out = ctx.empty(inclusive.shape, inclusive.dtype);
  ctx.submit([
    {
      program: ctx.program(code, undefined, 'scan.exclusive'),
      resources: {
        inclusive,
        flags: flags ?? inclusive,
        dst: out,
        params: new Uint32Array([inclusive.size, INF, 0, flags ? 0 : period]),
      },
      workgroups: ctx.grid(Math.ceil(inclusive.size / 256)),
    },
  ]);
  return out;
}

/** @internal Queues an exclusive sum scan of `source` (u32 counts) into `dst`. */
export function exclusiveSumPasses(
  ctx: ComputeContext,
  source: Operand,
  dst: GpuArray,
  n: number,
  passes: Pass[],
  temporary: GpuArray[],
): void {
  flatPasses(ctx, source, dst, n, 'sum', true, passes, temporary);
}

/** Flat or per-axis scan (see ComputeContext.scan). */
export function scan(ctx: ComputeContext, input: Operand, options: ScanOptions = {}): GpuArray {
  ctx.check();
  if (!(input instanceof Operand)) throw typeError('scan takes a GpuArray or an Expr', 'compute');
  const op = options.op ?? 'sum',
    exclusive = !!options.exclusive,
    n = input.size,
    temporary: GpuArray[] = [],
    passes: Pass[] = [];
  if (options.axis === undefined || input.ndim <= 1) {
    const out = ctx.empty(options.axis === undefined ? [n] : input.shape, input.dtype);
    if (n === 0) return out;
    flatPasses(ctx, input, out, n, op, exclusive, passes, temporary);
    ctx.submit(passes);
    for (const t of temporary) t.dispose();
    return out;
  }
  // Along an axis: move it last (a free view), scan each line as a segment, and move it back.
  const axis = axisOf(options.axis, input.ndim),
    order = [...input.shape.keys()].filter((k) => k !== axis).concat(axis),
    back = order.map((_, k) => order.indexOf(k));
  const moved = (input instanceof Operand && 'transpose' in input ? input : input.eval()) as GpuArray;
  const lines = moved.transpose(...order),
    len = input.shape[axis],
    scanned = ctx.empty(lines.shape, input.dtype);
  if (n > 0) {
    segmentedPasses(ctx, lines, undefined, len, scanned, n, op, passes, temporary);
    ctx.submit(passes);
  }
  let result = scanned;
  if (exclusive && n > 0) {
    result = exclusiveFrom(ctx, scanned, undefined, len, op);
    scanned.dispose();
  }
  const out = result.transpose(...back).eval();
  result.dispose();
  if (moved !== input) moved.dispose();
  for (const t of temporary) t.dispose();
  return out;
}

/** Scan restarting at non-zero flags (see ComputeContext.segmentedScan). */
export function segmented(
  ctx: ComputeContext,
  values: Operand,
  flags: Operand,
  options: Omit<ScanOptions, 'axis'> = {},
): GpuArray {
  ctx.check();
  if (!(values instanceof Operand) || !(flags instanceof Operand))
    throw typeError('segmentedScan takes values and flags as GpuArrays or Exprs', 'compute');
  if (values.size !== flags.size)
    throw typeError(`segmentedScan values (${values.size}) and flags (${flags.size}) differ in size`, 'compute');
  const op = options.op ?? 'sum',
    n = values.size,
    out = ctx.empty([n], values.dtype);
  if (n === 0) return out;
  const flagArray = flags.ne(0).eval(),
    temporary: GpuArray[] = [flagArray],
    passes: Pass[] = [];
  segmentedPasses(ctx, values, flagArray, 0, out, n, op, passes, temporary);
  ctx.submit(passes);
  if (!options.exclusive) {
    for (const t of temporary) t.dispose();
    return out;
  }
  const shifted = exclusiveFrom(ctx, out, flagArray, 0, op);
  out.dispose();
  for (const t of temporary) t.dispose();
  return shifted;
}

/** Group-by on runs of equal keys (see ComputeContext.reduceByKey). */
export async function reduceByKey(
  ctx: ComputeContext,
  keys: Operand,
  values: Operand,
  options: { readonly op?: Operator } & WaitOptions = {},
): Promise<{ keys: GpuArray; values: GpuArray }> {
  ctx.check();
  if (keys.size !== values.size)
    throw typeError(`reduceByKey keys (${keys.size}) and values (${values.size}) differ in size`, 'compute');
  const n = keys.size;
  if (n === 0) return { keys: ctx.empty([0], keys.dtype), values: ctx.empty([0], values.dtype) };
  const k =
    keys instanceof Operand && 'storage' in keys && (keys as GpuArray).contiguous ? (keys as GpuArray) : keys.eval();
  const flat = k.reshape(n);
  // A run starts where the key differs from the one before; it ends where the next run starts (or at the end).
  const before = flat.slice([0, n - 1]),
    after = flat.slice([1, n]);
  const startsTail = after.ne(before).eval();
  const starts = ctx.empty([n], 'u32');
  const ends = ctx.empty([n], 'u32');
  ctx.submit(
    [],
    [
      [startsTail.buffer, 0, starts.buffer, 4, (n - 1) * 4],
      [startsTail.buffer, 0, ends.buffer, 0, (n - 1) * 4],
    ],
  );
  starts.write([1], 0);
  ends.write([1], n - 1);
  const scanned = segmented(ctx, values, starts, { op: options.op });
  const keyRun = compactInto(ctx, flat, starts),
    valueRun = compactInto(ctx, scanned, ends);
  const count = await readCount(ctx, keyRun.count, options.signal);
  const outKeys = ctx.empty([count], keys.dtype),
    outValues = ctx.empty([count], values.dtype);
  ctx.submit(
    [],
    [
      [keyRun.values.buffer, 0, outKeys.buffer, 0, outKeys.byteLength],
      [valueRun.values.buffer, 0, outValues.buffer, 0, outValues.byteLength],
    ],
  );
  for (const t of [startsTail, starts, ends, scanned, keyRun.values, keyRun.count, valueRun.values, valueRun.count])
    t.dispose();
  if (k !== keys) k.dispose();
  return { keys: outKeys, values: outValues };
}
