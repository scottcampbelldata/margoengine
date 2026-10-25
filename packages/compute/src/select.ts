// Selection: take (gather), scatter (with atomic add/min/max, f32 through compare-and-swap on the bit pattern),
// bincount, and stream compaction (an exclusive scan of the mask gives each kept element its slot).
import { rangeError, typeError } from '../../shared/errors.js';
import { axisOf, GpuArray } from './array.js';
import { bitsOf, fromBits, isFloat, type DType } from './dtype.js';
import { Operand, fuse, type OperandLike } from './expr.js';
import { WG } from './shaders.js';
import { exclusiveSumPasses } from './scan.js';
import type { ComputeContext, Pass, WaitOptions } from './context.js';

/** Options for `take`. */
export interface TakeOptions {
  /** Axis to take along. Default: the flattened input. */
  readonly axis?: number;
  /** Out-of-range indices: `'clip'` to the nearest end (default) or `'wrap'` around. Negative indices count from the end. */
  readonly mode?: 'clip' | 'wrap';
}

const index = /* wgsl */ `fn blockIndex(wid: vec3u, nwg: vec3u) -> u32 { return wid.x + wid.y * nwg.x; }`;

// Indices as a contiguous i32 array (a view of the input when it already is one).
function indexArray(indices: Operand): { array: GpuArray; owned: boolean } {
  if (!(indices instanceof Operand)) throw typeError('Indices must be a GpuArray or an Expr', 'compute');
  if (isFloat(indices.dtype)) throw typeError("Indices must be integers; astype('i32') first", 'compute');
  if (indices instanceof GpuArray && indices.dtype === 'i32' && indices.contiguous && indices.offset === 0)
    return { array: indices, owned: false };
  return { array: indices.astype('i32').eval(), owned: true };
}

/** Elements at indices (see ComputeContext.take). */
export function take(ctx: ComputeContext, input: Operand, indices: Operand, options: TakeOptions = {}): GpuArray {
  ctx.check();
  if (!(input instanceof Operand)) throw typeError('take reads a GpuArray or an Expr', 'compute');
  const { array: idx, owned } = indexArray(indices),
    mode = options.mode ?? 'clip';
  if (mode !== 'clip' && mode !== 'wrap')
    throw typeError(`take mode must be 'clip' or 'wrap', got ${String(mode)}`, 'compute');
  const axis = options.axis === undefined ? undefined : axisOf(options.axis, input.ndim);
  const len = axis === undefined ? input.size : input.shape[axis],
    inner = axis === undefined ? 1 : input.shape.slice(axis + 1).reduce((a, b) => a * b, 1),
    shape =
      axis === undefined ? idx.shape : [...input.shape.slice(0, axis), ...idx.shape, ...input.shape.slice(axis + 1)],
    out = ctx.empty(shape, input.dtype),
    n = out.size;
  if (n > 0 && len === 0) throw rangeError('take from an empty axis has nothing to take', 'compute');
  if (n > 0) {
    const temporaries: GpuArray[] = [];
    const src = fuse(input, 0, ctx.maxStorage(2), temporaries);
    const code = /* wgsl */ `${src.enables}${src.declarations}struct Take { n: u32, len: u32, inner: u32, count: u32, wrap: u32 }
${index}
@group(0) @binding(${src.next}) var<storage, read> idx: array<i32>;
@group(0) @binding(${src.next + 1}) var<storage, read_write> out: array<${input.dtype}>;
@group(0) @binding(${src.next + 2}) var<uniform> take: Take;
${src.fn}
@compute @workgroup_size(256)
fn main(@builtin(workgroup_id) wid: vec3u, @builtin(num_workgroups) nwg: vec3u, @builtin(local_invocation_index) lid: u32) {
  let o = blockIndex(wid, nwg) * 256u + lid;
  if (o >= take.n) { return; }
  let j = o % take.inner;
  let p = (o / take.inner) % take.count;
  let outer = o / (take.inner * take.count);
  let len = i32(take.len);
  var k = idx[p];
  if (k < 0) { k += len; }
  if (take.wrap == 1u) { k = ((k % len) + len) % len; } else { k = clamp(k, 0, len - 1); }
  out[o] = value((outer * take.len + u32(k)) * take.inner + j);
}`;
    ctx.submit([
      {
        program: ctx.program(code, undefined, 'take'),
        resources: {
          ...src.resources,
          idx,
          out,
          take: new Uint32Array([n, len, inner, Math.max(1, idx.size), mode === 'wrap' ? 1 : 0, 0, 0, 0]),
        },
        workgroups: ctx.grid(Math.ceil(n / WG)),
      },
    ]);
    for (const t of temporaries) t.dispose();
  }
  if (owned) idx.dispose();
  return out;
}

// True when the expression reads `array`'s buffer.
function reads(operand: Operand, array: GpuArray): boolean {
  const visit = (node: ReturnType<Operand['node']>): boolean =>
    node.kind === 'leaf' ? node.array.storage === array.storage : node.kind === 'op' ? node.args.some(visit) : false;
  return visit(operand.node());
}

/** Writes values at indices, in place (see ComputeContext.scatter). */
export function scatter<T extends DType>(
  ctx: ComputeContext,
  target: GpuArray<T>,
  indices: Operand,
  values: OperandLike,
  options: { readonly op?: 'set' | 'add' | 'min' | 'max' } = {},
): GpuArray<T> {
  ctx.check();
  if (!(target instanceof GpuArray)) throw typeError('scatter writes into a GpuArray', 'compute');
  target.check(ctx);
  if (!target.contiguous || target.offset)
    throw typeError('scatter needs a contiguous target; scatter into the array the view came from', 'compute');
  const op = options.op ?? 'set';
  if (!['set', 'add', 'min', 'max'].includes(op))
    throw typeError(`scatter op must be set, add, min or max, got ${op}`, 'compute');
  if (target.dtype === 'f16' && op !== 'set')
    throw typeError("scatter add/min/max needs a 32-bit target; use 'f32'", 'compute');
  const { array: idx, owned } = indexArray(indices),
    n = idx.size;
  const scalar = typeof values === 'number';
  if (!scalar && !(values instanceof Operand))
    throw typeError('scatter values must be a number, a GpuArray or an Expr', 'compute');
  if (!scalar && values.size !== n && values.size !== 1)
    throw rangeError(`scatter has ${n} indices but ${values.size} values; pass one value or one per index`, 'compute');
  if (n > 0) {
    const t = target.dtype,
      temporaries: GpuArray[] = [];
    // Values that read the target itself are evaluated first: a pass cannot read and write one buffer.
    let source: Operand | undefined = scalar ? undefined : (values as Operand).astype(t);
    if (source && reads(source, target)) {
      const copy = source.eval();
      temporaries.push(copy);
      source = copy;
    }
    const src = source ? fuse(source, 0, ctx.maxStorage(2), temporaries) : undefined;
    const base = src?.next ?? 0;
    const atomicType = t === 'i32' ? 'atomic<i32>' : 'atomic<u32>';
    const load = scalar ? `${fromBits('params.value', t)}` : (values as Operand).size === 1 ? 'value(0u)' : 'value(i)';
    let write: string;
    if (op === 'set') write = 'dst[j] = v;';
    else if (t === 'f32') {
      const combine = op === 'add' ? 'bitcast<f32>(old) + v' : `${op}(bitcast<f32>(old), v)`;
      // Atomic float update: retry the compare-and-swap with the value another thread just stored.
      write = `var old = atomicLoad(&dst[j]);
    loop {
      let swapped = atomicCompareExchangeWeak(&dst[j], old, bitcast<u32>(${combine}));
      if (swapped.exchanged) { break; }
      old = swapped.old_value;
    }`;
    } else write = `atomic${op[0].toUpperCase()}${op.slice(1)}(&dst[j], v);`;
    const code = /* wgsl */ `${src?.enables ?? (t === 'f16' ? 'enable f16;\n' : '')}${src?.declarations ?? ''}struct Params { n: u32, len: u32, value: u32, pad: u32 }
${index}
@group(0) @binding(${base}) var<storage, read> idx: array<i32>;
@group(0) @binding(${base + 1}) var<storage, read_write> dst: array<${op === 'set' ? t : atomicType}>;
@group(0) @binding(${base + 2}) var<uniform> params: Params;
${src?.fn ?? ''}
@compute @workgroup_size(256)
fn main(@builtin(workgroup_id) wid: vec3u, @builtin(num_workgroups) nwg: vec3u, @builtin(local_invocation_index) lid: u32) {
  let i = blockIndex(wid, nwg) * 256u + lid;
  if (i >= params.n) { return; }
  var k = idx[i];
  if (k < 0) { k += i32(params.len); }
  if (k < 0 || k >= i32(params.len)) { return; }
  let j = u32(k);
  let v = ${load};
  ${write}
}`;
    ctx.submit([
      {
        program: ctx.program(code, undefined, `scatter.${op}`),
        resources: {
          ...(src?.resources ?? {}),
          idx,
          dst: target,
          params: new Uint32Array([n, target.size, scalar ? bitsOf(values as number, t) : 0, 0]),
        },
        workgroups: ctx.grid(Math.ceil(n / WG)),
      },
    ]);
    for (const a of temporaries) a.dispose();
  }
  if (owned) idx.dispose();
  return target;
}

/** Counts (or weight sums) per value (see ComputeContext.bincount). */
export function bincount(
  ctx: ComputeContext,
  input: Operand,
  options: { readonly weights?: Operand; readonly length: number },
): GpuArray {
  const length = options?.length;
  if (!Number.isInteger(length) || length < 0)
    throw rangeError(
      'bincount needs length (the number of bins, one past the largest value) as a whole number',
      'compute',
    );
  const out = ctx.zeros([length], options.weights ? 'f32' : 'u32');
  return scatter(ctx, out, input, options.weights ?? 1, { op: 'add' });
}

/** @internal Compaction into a full-size array plus a count, without reading back. */
export function compactInto(
  ctx: ComputeContext,
  input: Operand,
  mask: Operand,
): { values: GpuArray; count: GpuArray<'u32'> } {
  ctx.check();
  if (!(input instanceof Operand) || !(mask instanceof Operand))
    throw typeError('compact takes an input and a mask (GpuArrays or Exprs)', 'compute');
  if (input.size !== mask.size)
    throw rangeError(`compact input (${input.size}) and mask (${mask.size}) differ in size`, 'compute');
  const n = input.size,
    values = ctx.empty([n], input.dtype),
    count = ctx.empty([1], 'u32');
  if (n === 0) return { values, count };
  const flags = mask.ne(0).eval(),
    offsets = ctx.empty([n], 'u32'),
    temporaries: GpuArray[] = [flags, offsets],
    passes: Pass[] = [];
  exclusiveSumPasses(ctx, flags, offsets, n, passes, temporaries);
  const src = fuse(input, 0, ctx.maxStorage(4), temporaries);
  const code = /* wgsl */ `${src.enables}${src.declarations}${index}
@group(0) @binding(${src.next}) var<storage, read> flags: array<u32>;
@group(0) @binding(${src.next + 1}) var<storage, read> offsets: array<u32>;
@group(0) @binding(${src.next + 2}) var<storage, read_write> values: array<${input.dtype}>;
@group(0) @binding(${src.next + 3}) var<storage, read_write> count: array<u32>;
@group(0) @binding(${src.next + 4}) var<uniform> size: vec4u;
${src.fn}
@compute @workgroup_size(256)
fn main(@builtin(workgroup_id) wid: vec3u, @builtin(num_workgroups) nwg: vec3u, @builtin(local_invocation_index) lid: u32) {
  let i = blockIndex(wid, nwg) * 256u + lid;
  if (i >= size.x) { return; }
  if (flags[i] != 0u) { values[offsets[i]] = value(i); }
  if (i == size.x - 1u) { count[0] = offsets[i] + flags[i]; }
}`;
  passes.push({
    program: ctx.program(code, undefined, 'compact'),
    resources: { ...src.resources, flags, offsets, values, count, size: new Uint32Array([n, 0, 0, 0]) },
    workgroups: ctx.grid(Math.ceil(n / WG)),
  });
  ctx.submit(passes);
  for (const t of temporaries) t.dispose();
  return { values, count };
}

/** Compaction without reading back (see ComputeContext.compact). */
export function compact(
  ctx: ComputeContext,
  input: Operand,
  mask: Operand,
): { values: GpuArray; count: GpuArray<'u32'> } {
  return compactInto(ctx, input, mask);
}

/** @internal Reads a one-element u32 count. */
export async function readCount(ctx: ComputeContext, count: GpuArray<'u32'>, signal?: AbortSignal): Promise<number> {
  return (await count.read({ signal }))[0];
}

/** Exactly sized compaction (see ComputeContext.filter). */
export async function filter(
  ctx: ComputeContext,
  input: Operand,
  mask: Operand,
  options: WaitOptions = {},
): Promise<GpuArray> {
  const run = compactInto(ctx, input, mask);
  try {
    const n = await readCount(ctx, run.count, options.signal);
    const out = ctx.empty([n], input.dtype);
    ctx.submit([], [[run.values.buffer, 0, out.buffer, 0, out.byteLength]]);
    return out;
  } finally {
    run.values.dispose();
    run.count.dispose();
  }
}

/** Flat indices of non-zero elements (see ComputeContext.nonzero). */
export async function nonzero(
  ctx: ComputeContext,
  input: Operand,
  options: WaitOptions = {},
): Promise<GpuArray<'u32'>> {
  const index = ctx.arange(0, input.size, 1, 'u32');
  try {
    return (await filter(ctx, index, input, options)) as GpuArray<'u32'>;
  } finally {
    index.dispose();
  }
}
