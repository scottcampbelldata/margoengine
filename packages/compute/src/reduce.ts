// Reductions: over every element (a tree of 1,024-element workgroups, level after level) or along axes (one thread
// per output when there are many outputs, one workgroup per output when each output folds a long line). The first
// level reads the input through the fused expression, so `gpu.sum(x.sub(m).square())` is one pass over x.
import { rangeError, typeError } from '../../shared/errors.js';
import { axisOf, type GpuArray } from './array.js';
import { isFloat, type DType } from './dtype.js';
import { Operand, fuse, where, type AxisOptions, type Fused } from './expr.js';
import { BLOCK, operator, type Operator } from './shaders.js';
import type { ComputeContext } from './context.js';

const params = /* wgsl */ `struct Params { n: u32, inf: u32, len: u32, inner: u32 }`;
const index = /* wgsl */ `fn blockIndex(wid: vec3u, nwg: vec3u) -> u32 { return wid.x + wid.y * nwg.x; }`;
// Outputs past which each output gets its own thread instead of its own workgroup.
const THREAD_PER_OUTPUT = 4096;

/** The axes to reduce, ascending and unique; every axis when `axis` is undefined. */
export function axesOf(axis: number | readonly number[] | undefined, ndim: number): number[] {
  if (axis === undefined) return Array.from({ length: ndim }, (_, k) => k);
  const list = (typeof axis === 'number' ? [axis] : [...axis]).map((a) => axisOf(a, ndim));
  if (new Set(list).size !== list.length) throw rangeError(`Reduction axes repeat: [${String(axis)}]`, 'compute');
  return list.sort((a, b) => a - b);
}

const shapeAfter = (shape: readonly number[], axes: readonly number[], keepdims: boolean) =>
  keepdims ? shape.map((d, k) => (axes.includes(k) ? 1 : d)) : shape.filter((_, k) => !axes.includes(k));

/** WGSL for one tree level over 1,024-element blocks of `src`'s values. */
export function levelShader(src: Fused, combine: string, identity: string): string {
  const t = src.dtype;
  return /* wgsl */ `${src.enables}${src.declarations}${params}
${index}
@group(0) @binding(${src.next}) var<storage, read_write> dst: array<${t}>;
@group(0) @binding(${src.next + 1}) var<uniform> params: Params;
var<workgroup> partial: array<${t}, 256>;
${src.fn}
fn combine(a: ${t}, b: ${t}) -> ${t} { return ${combine}; }
@compute @workgroup_size(256)
fn main(@builtin(workgroup_id) wid: vec3u, @builtin(num_workgroups) nwg: vec3u, @builtin(local_invocation_index) lid: u32) {
  let g = blockIndex(wid, nwg);
  if (g * 1024u >= params.n) { return; }
  var acc: ${t} = ${identity};
  for (var k = 0u; k < 4u; k++) {
    let i = g * 1024u + lid * 4u + k;
    if (i < params.n) { acc = combine(acc, value(i)); }
  }
  partial[lid] = acc;
  workgroupBarrier();
  for (var offset = 128u; offset > 0u; offset >>= 1u) {
    if (lid < offset) { partial[lid] = combine(partial[lid], partial[lid + offset]); }
    workgroupBarrier();
  }
  if (lid == 0u) { dst[g] = partial[0]; }
}`;
}

/**
 * WGSL folding one axis: output o = (outer, j) folds `len` values at (outer * len + k) * inner + j. `perThread`
 * gives each output a thread; otherwise a workgroup whose threads each fold a consecutive run of k.
 */
export function axisShader(src: Fused, combine: string, identity: string, perThread: boolean): string {
  const t = src.dtype;
  const head = /* wgsl */ `${src.enables}${src.declarations}${params}
${index}
@group(0) @binding(${src.next}) var<storage, read_write> dst: array<${t}>;
@group(0) @binding(${src.next + 1}) var<uniform> params: Params;
${src.fn}
fn combine(a: ${t}, b: ${t}) -> ${t} { return ${combine}; }
fn at(o: u32, k: u32) -> u32 { return ((o / params.inner) * params.len + k) * params.inner + o % params.inner; }`;
  if (perThread)
    return /* wgsl */ `${head}
@compute @workgroup_size(256)
fn main(@builtin(workgroup_id) wid: vec3u, @builtin(num_workgroups) nwg: vec3u, @builtin(local_invocation_index) lid: u32) {
  let o = blockIndex(wid, nwg) * 256u + lid;
  if (o >= params.n) { return; }
  var acc: ${t} = ${identity};
  for (var k = 0u; k < params.len; k++) { acc = combine(acc, value(at(o, k))); }
  dst[o] = acc;
}`;
  return /* wgsl */ `${head}
var<workgroup> partial: array<${t}, 256>;
@compute @workgroup_size(256)
fn main(@builtin(workgroup_id) wid: vec3u, @builtin(num_workgroups) nwg: vec3u, @builtin(local_invocation_index) lid: u32) {
  let o = blockIndex(wid, nwg);
  if (o >= params.n) { return; }
  let run = (params.len + 255u) / 256u;
  var acc: ${t} = ${identity};
  for (var k = lid * run; k < min(params.len, lid * run + run); k++) { acc = combine(acc, value(at(o, k))); }
  partial[lid] = acc;
  workgroupBarrier();
  for (var offset = 128u; offset > 0u; offset >>= 1u) {
    if (lid < offset) { partial[lid] = combine(partial[lid], partial[lid + offset]); }
    workgroupBarrier();
  }
  if (lid == 0u) { dst[o] = partial[0]; }
}`;
}

const INF = 0x7f800000;

/** Full or per-axis reduction of `input` with `op` (see ComputeContext.reduce). */
export function reduce(ctx: ComputeContext, input: Operand, op: Operator, options: AxisOptions = {}): GpuArray {
  ctx.check();
  if (!(input instanceof Operand)) throw typeError('Reductions take a GpuArray or an Expr', 'compute');
  if (typeof op === 'string' && !['sum', 'product', 'min', 'max'].includes(op))
    throw typeError(`Unknown reduce op ${op}; use sum, product, min, max or { combine, identity }`, 'compute');
  const axes = axesOf(options.axis, input.ndim),
    keepdims = !!options.keepdims,
    shape = shapeAfter(input.shape, axes, keepdims);
  const { combine, identity } = operator(op, input.dtype);
  if (axes.length === input.ndim) return full(ctx, input, combine, identity, shape);
  // Fold one axis at a time, highest first, so the remaining axes keep their numbering.
  let current: Operand = input,
    currentShape = [...input.shape];
  const temporaries: GpuArray[] = [];
  for (let k = axes.length - 1; k >= 0; k--) {
    const axis = axes[k],
      last = k === 0,
      nextShape = currentShape.filter((_, j) => j !== axis);
    const out = ctx.empty(last ? shape : nextShape, input.dtype);
    alongAxis(ctx, current, axis, currentShape, combine, identity, out);
    if (!last) temporaries.push(out);
    current = out;
    currentShape = nextShape;
  }
  for (const t of temporaries) t.dispose();
  return current as GpuArray;
}

function full(
  ctx: ComputeContext,
  input: Operand,
  combine: string,
  identity: string,
  shape: readonly number[],
): GpuArray {
  const n = input.size;
  if (n === 0) {
    const out = ctx.empty(shape, input.dtype);
    const code = /* wgsl */ `${input.dtype === 'f16' ? 'enable f16;\n' : ''}${params}
@group(0) @binding(0) var<storage, read_write> dst: array<${input.dtype}>;
@group(0) @binding(1) var<uniform> params: Params;
@compute @workgroup_size(1) fn main() { dst[0] = ${identity}; }`;
    ctx.submit([
      {
        program: ctx.program(code, undefined, 'reduce'),
        resources: { dst: out, params: new Uint32Array([0, INF, 0, 0]) },
        workgroups: [1, 1, 1],
      },
    ]);
    return out;
  }
  let source: Operand = input,
    count = n;
  const temporaries: GpuArray[] = [],
    passes = [];
  let out: GpuArray;
  do {
    const groups = Math.ceil(count / BLOCK);
    const fusedTemps: GpuArray[] = [];
    const src = fuse(source, 0, ctx.maxStorage(1), fusedTemps);
    temporaries.push(...fusedTemps);
    out = ctx.empty(groups === 1 ? shape : [groups], input.dtype);
    passes.push({
      program: ctx.program(
        ctx.kernelRoute?.level(src, combine, identity) ?? levelShader(src, combine, identity),
        undefined,
        'reduce',
      ),
      resources: { ...src.resources, dst: out, params: new Uint32Array([count, INF, 0, 0]) },
      workgroups: ctx.grid(groups),
    });
    if (groups > 1) temporaries.push(out);
    source = out;
    count = groups;
  } while (count > 1);
  ctx.submit(passes);
  for (const t of temporaries) t.dispose();
  return out;
}

function alongAxis(
  ctx: ComputeContext,
  input: Operand,
  axis: number,
  shape: readonly number[],
  combine: string,
  identity: string,
  out: GpuArray,
): void {
  const len = shape[axis],
    inner = shape.slice(axis + 1).reduce((a, b) => a * b, 1),
    outputs = out.size;
  if (outputs === 0) return;
  const temporaries: GpuArray[] = [];
  const src = fuse(input, 0, ctx.maxStorage(1), temporaries);
  const perThread = outputs >= THREAD_PER_OUTPUT || len <= 64;
  ctx.submit([
    {
      program: ctx.program(
        (perThread ? undefined : ctx.kernelRoute?.axis(src, combine, identity)) ??
          axisShader(src, combine, identity, perThread),
        undefined,
        'reduce.axis',
      ),
      resources: { ...src.resources, dst: out, params: new Uint32Array([outputs, INF, len, inner]) },
      workgroups: ctx.grid(perThread ? Math.ceil(outputs / 256) : outputs),
    },
  ]);
  for (const t of temporaries) t.dispose();
}

/** Number of elements each output of a reduction over `axes` folds. */
const countOf = (shape: readonly number[], axes: readonly number[]) => axes.reduce((c, a) => c * shape[a], 1);

/** Mean in f32 (see ComputeContext.mean). */
export function mean(ctx: ComputeContext, input: Operand, options: AxisOptions = {}): GpuArray {
  const n = countOf(input.shape, axesOf(options.axis, input.ndim));
  const sum = reduce(ctx, isFloat(input.dtype) && input.dtype === 'f32' ? input : input.astype('f32'), 'sum', options);
  return scaled(sum, n ? 1 / n : NaN);
}

// sum * factor as a new array of the sum's shape; the sum is disposed.
function scaled(sum: GpuArray, factor: number): GpuArray {
  const out = sum.mul(factor).eval();
  sum.dispose();
  return out;
}

/** Variance in f32 with `ddof` (see ComputeContext.var). */
export function variance(
  ctx: ComputeContext,
  input: Operand,
  options: AxisOptions & { readonly ddof?: number } = {},
): GpuArray {
  const ddof = options.ddof ?? 0;
  if (!Number.isFinite(ddof) || ddof < 0)
    throw rangeError(`ddof must be a number of at least 0, got ${ddof}`, 'compute');
  const x = input.dtype === 'f32' ? input : input.astype('f32');
  const m = mean(ctx, x, { axis: options.axis, keepdims: true });
  const n = countOf(input.shape, axesOf(options.axis, input.ndim));
  const sum = reduce(ctx, x.sub(m).square(), 'sum', options);
  m.dispose();
  return scaled(sum, n - ddof > 0 ? 1 / (n - ddof) : NaN);
}

/** Standard deviation in f32 (see ComputeContext.std). */
export function std(
  ctx: ComputeContext,
  input: Operand,
  options: AxisOptions & { readonly ddof?: number } = {},
): GpuArray {
  const v = variance(ctx, input, options);
  const out = v.sqrt().eval();
  v.dispose();
  return out;
}

/** Mean ignoring NaN, in f32. */
export function nanmean(ctx: ComputeContext, input: Operand, options: AxisOptions = {}): GpuArray {
  const x = input.dtype === 'f32' ? input : input.astype('f32');
  const sum = reduce(ctx, where(x.isnan(), 0, x), 'sum', options),
    count = reduce(ctx, x.isnan().not(), 'sum', options);
  const out = sum.div(count).eval();
  sum.dispose();
  count.dispose();
  return out;
}

/** WGSL for argmin/argmax: pairs of (value, index), first index on ties. */
export function argShader(src: Fused, which: 'min' | 'max', mode: 'flat' | 'level' | 'thread' | 'group'): string {
  const t = src.dtype,
    better = which === 'min' ? '<' : '>';
  // `level` reads earlier partial values and indices; the others read the input through value(i).
  const load =
    mode === 'level'
      ? 'fn load(i: u32) -> Pair { return Pair(vals[i], idx[i]); }'
      : 'fn load(i: u32) -> Pair { return Pair(value(i), i); }';
  const head = /* wgsl */ `${src.enables}${src.declarations}${params}
${index}
struct Pair { v: ${t}, i: u32 }
@group(0) @binding(${src.next}) var<storage, read_write> outValues: array<${t}>;
@group(0) @binding(${src.next + 1}) var<storage, read_write> outIndices: array<u32>;
@group(0) @binding(${src.next + 2}) var<uniform> params: Params;
${mode === 'level' ? `@group(0) @binding(${src.next + 3}) var<storage, read> vals: array<${t}>;\n@group(0) @binding(${src.next + 4}) var<storage, read> idx: array<u32>;` : ''}
${src.fn}
${load}
fn pick(a: Pair, b: Pair) -> Pair {
  if (b.i == 0xffffffffu) { return a; }
  if (a.i == 0xffffffffu || b.v ${better} a.v || (b.v == a.v && b.i < a.i)) { return b; }
  return a;
}
fn at(o: u32, k: u32) -> u32 { return ((o / params.inner) * params.len + k) * params.inner + o % params.inner; }`;
  const none = /* wgsl */ `Pair(${t}(0), 0xffffffffu)`;
  const tree = /* wgsl */ `
  partial[lid] = acc;
  workgroupBarrier();
  for (var offset = 128u; offset > 0u; offset >>= 1u) {
    if (lid < offset) { partial[lid] = pick(partial[lid], partial[lid + offset]); }
    workgroupBarrier();
  }`;
  if (mode === 'thread')
    return /* wgsl */ `${head}
@compute @workgroup_size(256)
fn main(@builtin(workgroup_id) wid: vec3u, @builtin(num_workgroups) nwg: vec3u, @builtin(local_invocation_index) lid: u32) {
  let o = blockIndex(wid, nwg) * 256u + lid;
  if (o >= params.n) { return; }
  var acc = ${none};
  for (var k = 0u; k < params.len; k++) { let p = load(at(o, k)); acc = pick(acc, Pair(p.v, k)); }
  outValues[o] = acc.v;
  outIndices[o] = acc.i;
}`;
  if (mode === 'group')
    return /* wgsl */ `${head}
var<workgroup> partial: array<Pair, 256>;
@compute @workgroup_size(256)
fn main(@builtin(workgroup_id) wid: vec3u, @builtin(num_workgroups) nwg: vec3u, @builtin(local_invocation_index) lid: u32) {
  let o = blockIndex(wid, nwg);
  if (o >= params.n) { return; }
  let run = (params.len + 255u) / 256u;
  var acc = ${none};
  for (var k = lid * run; k < min(params.len, lid * run + run); k++) { let p = load(at(o, k)); acc = pick(acc, Pair(p.v, k)); }
  ${tree}
  if (lid == 0u) { outValues[o] = partial[0].v; outIndices[o] = partial[0].i; }
}`;
  return /* wgsl */ `${head}
var<workgroup> partial: array<Pair, 256>;
@compute @workgroup_size(256)
fn main(@builtin(workgroup_id) wid: vec3u, @builtin(num_workgroups) nwg: vec3u, @builtin(local_invocation_index) lid: u32) {
  let g = blockIndex(wid, nwg);
  if (g * 1024u >= params.n) { return; }
  var acc = ${none};
  for (var k = 0u; k < 4u; k++) {
    let i = g * 1024u + lid * 4u + k;
    if (i < params.n) { acc = pick(acc, load(i)); }
  }
  ${tree}
  if (lid == 0u) { outValues[g] = partial[0].v; outIndices[g] = partial[0].i; }
}`;
}

/** argmin / argmax (see ComputeContext.argmin). */
export function arg(
  ctx: ComputeContext,
  input: Operand,
  which: 'min' | 'max',
  options: { readonly axis?: number; readonly keepdims?: boolean } = {},
): GpuArray<'u32'> {
  ctx.check();
  if (!(input instanceof Operand)) throw typeError(`arg${which} takes a GpuArray or an Expr`, 'compute');
  if (input.size === 0) throw rangeError(`arg${which} of an empty array has no answer`, 'compute');
  const temporaries: GpuArray[] = [];
  const t: DType = input.dtype;
  if (options.axis === undefined) {
    const shape = options.keepdims ? input.shape.map(() => 1) : [];
    let count = input.size,
      values: GpuArray | undefined,
      indices: GpuArray<'u32'> | undefined;
    const passes = [];
    let first = true;
    do {
      const groups = Math.ceil(count / BLOCK),
        lastLevel = groups === 1;
      const src = first
        ? fuse(input, 0, ctx.maxStorage(4), temporaries)
        : fuse(values!, 0, ctx.maxStorage(4), temporaries);
      const outValues = ctx.empty([groups], t),
        outIndices = ctx.empty(lastLevel ? shape : [groups], 'u32');
      const resources: Record<string, unknown> = {
        ...src.resources,
        outValues,
        outIndices,
        params: new Uint32Array([count, INF, 0, 0]),
      };
      if (!first) Object.assign(resources, { vals: values!, idx: indices! });
      // Later levels read their inputs from `vals`/`idx`; `value` is still declared (for the shared head) and unused.
      passes.push({
        program: ctx.program(argShader(src, which, first ? 'flat' : 'level'), undefined, `arg${which}`),
        resources: resources as Record<string, never>,
        workgroups: ctx.grid(groups),
      });
      if (values) temporaries.push(values);
      if (indices) temporaries.push(indices);
      values = outValues;
      indices = outIndices;
      count = groups;
      first = false;
    } while (count > 1);
    ctx.submit(passes);
    temporaries.push(values!);
    for (const a of temporaries) a.dispose();
    return indices!;
  }
  const axis = axisOf(options.axis, input.ndim),
    len = input.shape[axis],
    inner = input.shape.slice(axis + 1).reduce((a, b) => a * b, 1),
    shape = shapeAfter(input.shape, [axis], !!options.keepdims),
    outputs = shape.reduce((a, b) => a * b, 1),
    perThread = outputs >= THREAD_PER_OUTPUT || len <= 64;
  const src = fuse(input, 0, ctx.maxStorage(2), temporaries);
  const outValues = ctx.empty([outputs], t),
    outIndices = ctx.empty(shape, 'u32');
  ctx.submit([
    {
      program: ctx.program(argShader(src, which, perThread ? 'thread' : 'group'), undefined, `arg${which}.axis`),
      resources: { ...src.resources, outValues, outIndices, params: new Uint32Array([outputs, INF, len, inner]) },
      workgroups: ctx.grid(perThread ? Math.ceil(outputs / 256) : outputs),
    },
  ]);
  temporaries.push(outValues);
  for (const a of temporaries) a.dispose();
  return outIndices;
}
