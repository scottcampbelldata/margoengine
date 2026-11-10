// Array building from the Array API standard, with logical C-order indices so
// transposes, slices and fused expressions use the existing gather/scatter paths.
import { rangeError, typeError } from '../../shared/errors.js';
import { axisOf, type GpuArray } from './array.js';
import { promote } from './dtype.js';
import { Expr, Operand, type OperandLike } from './expr.js';

const product = (shape: readonly number[]): number => shape.reduce((a, b) => a * b, 1);
const indices = (x: Operand, shape: readonly number[]): Expr =>
  new Expr(x.context, { kind: 'index', dtype: 'u32', shape }).astype('i32');
const whole = (n: number): boolean => Number.isSafeInteger(n) && n >= 0;
function input(x: Operand): void {
  if (!(x instanceof Operand)) throw typeError('Shape operations need a compute array or expression', 'compute');
  x.context.check();
  // Validate leaves even when an empty output needs no dispatch.
  const visit = (node: ReturnType<Operand['node']>): void => {
    if (node.kind === 'leaf') node.array.check(x.context);
    else if (node.kind === 'op') node.args.forEach(visit);
  };
  visit(x.node());
}

function join(arrays: readonly Operand[], axis: number | null, inserted: boolean): GpuArray {
  if (!Array.isArray(arrays) || !arrays.length)
    throw typeError('concatenate/stack needs at least one array', 'compute');
  arrays.forEach(input);
  const x = arrays[0],
    ctx = x.context;
  const rank = x.ndim + (inserted ? 1 : 0);
  if (axis !== null && !rank) throw rangeError('Use axis: null to concatenate scalars', 'compute');
  const a = axis === null ? 0 : axisOf(axis, rank);
  const shapes = arrays.map((v) => {
    if (v.context !== ctx) throw typeError('Shape operands must share a compute context', 'compute');
    const dims = axis === null ? [v.size] : [...v.shape];
    if (inserted) dims.splice(a, 0, 1);
    return dims;
  });
  const shape = [...shapes[0]];
  for (const dims of shapes)
    if (dims.length !== shape.length || dims.some((d, k) => k !== a && d !== shape[k]))
      throw rangeError(
        'concatenate needs matching dimensions outside its axis; stack needs identical shapes',
        'compute',
      );
  shape[a] = shapes.reduce((n, s) => n + s[a], 0);
  const dtype = arrays.reduce((t, v) => promote(t, v.dtype), x.dtype);
  const out = ctx.empty(shape, dtype),
    inner = product(shape.slice(a + 1));
  let offset = 0;
  try {
    for (let k = 0; k < arrays.length; k++) {
      const v = arrays[k],
        len = shapes[k][a];
      if (v.size) {
        const i = indices(v, [v.size]);
        const dst = i
          .floorDiv(len * inner)
          .mul(shape[a] * inner)
          .add(i.mod(len * inner))
          .add(offset * inner);
        ctx.scatter(out, dst, v.astype(dtype));
      }
      offset += len;
    }
    return out;
  } catch (error) {
    out.dispose();
    throw error;
  }
}

/** Join along an existing axis (default 0); null flattens all inputs. Types promote as for arithmetic. */
export function concatenate(arrays: readonly Operand[], axis: number | null = 0): GpuArray {
  return join(arrays, axis, false);
}

/** Join equal shapes along a newly inserted axis (default 0, negative axes allowed). */
export function stack(arrays: readonly Operand[], axis = 0): GpuArray {
  return join(arrays, axis, true);
}

/** Reverse the given axes, or every axis when omitted. Returns an independently owned array. */
export function flip(x: Operand, axis?: number | readonly number[]): GpuArray {
  input(x);
  const axes =
    axis === undefined
      ? x.shape.map((_, k) => k)
      : (typeof axis === 'number' ? [axis] : axis).map((a) => axisOf(a, x.ndim));
  if (new Set(axes).size !== axes.length)
    throw rangeError('flip axes must be distinct; remove repeated axes', 'compute');
  const i = indices(x, x.shape);
  let idx: OperandLike = i;
  for (const a of axes) {
    const stride = product(x.shape.slice(a + 1));
    idx = (idx as Operand).add(
      i
        .floorDiv(stride)
        .mod(x.shape[a])
        .mul(-2)
        .add(x.shape[a] - 1)
        .mul(stride),
    );
  }
  return x.context.take(x, idx as Operand);
}

/** Tile whole arrays, prepending singleton axes/repetitions to match ranks, as in NumPy. */
export function tile(x: Operand, repetitions: number | readonly number[]): GpuArray {
  input(x);
  const reps = typeof repetitions === 'number' ? [repetitions] : [...repetitions];
  if (!reps.every(whole)) throw rangeError('tile repetitions must be nonnegative safe integers', 'compute');
  const dims = [...x.shape];
  while (dims.length < reps.length) dims.unshift(1);
  while (reps.length < dims.length) reps.unshift(1);
  const shape = dims.map((d, k) => d * reps[k]),
    i = indices(x, shape);
  let idx = i.mul(0);
  for (let a = 0; a < dims.length; a++)
    idx = idx.add(
      i
        .floorDiv(product(shape.slice(a + 1)))
        .mod(shape[a])
        .mod(dims[a])
        .mul(product(dims.slice(a + 1))),
    );
  return x.context.take(x, idx);
}

/** Repeat individual elements/slices. Omitted/null axis flattens. A count list broadcasts from length 1. */
export function repeat(x: Operand, repeats: number | readonly number[], axis: number | null = null): GpuArray {
  input(x);
  const a = axis === null ? null : axisOf(axis, x.ndim);
  const len = a === null ? x.size : x.shape[a];
  const counts = typeof repeats === 'number' ? [repeats] : [...repeats];
  if (!counts.every(whole) || (counts.length !== 1 && counts.length !== len))
    throw rangeError('repeat needs one nonnegative integer or one count per element of its axis', 'compute');
  const n = counts.length === 1 ? counts[0] * len : counts.reduce((s, v) => s + v, 0);
  if (!whole(n) || n > 0x7fffffff)
    throw rangeError('repeat result exceeds the signed index limit; split the input', 'compute');
  const i = indices(x, [n]);
  if (counts.length === 1) return x.context.take(x, i.floorDiv(counts[0]), a === null ? {} : { axis: a });
  // Only the axis lookup is materialized, never an index for every tensor element.
  const lookup = new Int32Array(n);
  let end = 0;
  counts.forEach((count, k) => {
    lookup.fill(k, end, end + count);
    end += count;
  });
  const idx = x.context.array(lookup);
  try {
    return x.context.take(x, idx, a === null ? {} : { axis: a });
  } finally {
    idx.dispose();
  }
}

/** Padding widths: one size, a shared [before, after], or one pair per dimension. */
export type PadWidth = number | readonly [number, number] | readonly (readonly [number, number])[];
/** Constant, endpoint, periodic, or mirrored padding. Mirrors can extend beyond the input length. */
export interface ShapePadOptions {
  /** Default 'constant'. */
  readonly mode?: 'constant' | 'edge' | 'wrap' | 'reflect' | 'symmetric';
  /** Scalar fill for constant padding. Default 0, converted to the input dtype. */
  readonly constantValues?: number;
}

/** Pad each axis, preserving dtype. Nonconstant modes require nonempty source axes when output is nonempty. */
export function pad(x: Operand, width: PadWidth, options: ShapePadOptions = {}): GpuArray {
  input(x);
  const widths: readonly (readonly number[])[] =
    typeof width === 'number'
      ? x.shape.map(() => [width, width])
      : typeof width[0] === 'number'
        ? x.shape.map(() => width as readonly number[])
        : (width as readonly (readonly number[])[]);
  if (widths.length !== x.ndim || widths.some((p) => p.length !== 2 || !p.every(whole)))
    throw rangeError('pad needs nonnegative [before, after] widths for each input dimension', 'compute');
  const mode = options.mode ?? 'constant';
  if (!['constant', 'edge', 'wrap', 'reflect', 'symmetric'].includes(mode))
    throw typeError('pad mode must be constant, edge, wrap, reflect or symmetric', 'compute');
  const shape = x.shape.map((d, k) => d + widths[k][0] + widths[k][1]);
  if (!product(shape)) return x.context.empty(shape, x.dtype);
  if (!x.size) {
    if (mode !== 'constant')
      throw rangeError('Nonconstant padding needs nonempty input axes; use constant padding', 'compute');
    return x.context.full(shape, options.constantValues ?? 0, x.dtype);
  }
  const i = indices(x, shape);
  let idx = i.mul(0),
    valid = i.ge(0);
  for (let a = 0; a < x.ndim; a++) {
    const d = x.shape[a],
      c = i
        .floorDiv(product(shape.slice(a + 1)))
        .mod(shape[a])
        .sub(widths[a][0]);
    valid = valid.and(c.ge(0)).and(c.lt(d));
    let mapped = c.clip(0, d - 1);
    if (mode === 'wrap') mapped = c.mod(d);
    else if (mode === 'reflect' && d > 1) {
      const p = 2 * (d - 1),
        t = c.mod(p);
      mapped = x.context.where(t.lt(d), t, t.neg().add(p));
    } else if (mode === 'symmetric') {
      const p = 2 * d,
        t = c.mod(p);
      mapped = x.context.where(t.lt(d), t, t.neg().add(p - 1));
    }
    idx = idx.add(mapped.mul(product(x.shape.slice(a + 1))));
  }
  const gathered = x.context.take(x, idx);
  if (mode !== 'constant') return gathered;
  try {
    return x.context
      .where(valid, gathered, options.constantValues ?? 0)
      .astype(x.dtype)
      .eval();
  } finally {
    gathered.dispose();
  }
}
