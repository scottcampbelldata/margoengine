// Lazy element-wise expressions and the compiler that fuses them. `a.mul(2).add(b).sqrt()` builds a tree; evaluating
// it (or handing it to a reduction) compiles the whole tree into one kernel, so the intermediate arrays are never
// written. Broadcasting follows NumPy's rule (shapes aligned at the right, each dimension equal or 1); views
// (transpose, slices, broadcasts) are read through their strides inside the same kernel, so they cost no copy.
// Plain numbers travel in a uniform, so changing a constant does not recompile; shapes are compiled in.
import { rangeError, typeError } from '../../shared/errors.js';
import { preciseMathWgsl } from '../../shared/precise-math.js';
import { bitsOf, fromBits, isFloat, promote, scalarType, type DType } from './dtype.js';
import type { ComputeContext, WaitOptions } from './context.js';
import type { GpuArray, ReadOptions } from './array.js';

/** The GPU memory behind an array and its views. */
export interface Storage {
  readonly buffer: GPUBuffer;
  readonly dtype: DType;
  disposed: boolean;
}

/** @internal An expression tree node. */
export type Node =
  | { readonly kind: 'leaf'; readonly array: GpuArray }
  | { readonly kind: 'scalar'; readonly value: number; readonly dtype: DType }
  | { readonly kind: 'index'; readonly dtype: 'u32'; readonly shape: readonly number[] }
  | {
      readonly kind: 'op';
      readonly op: string;
      readonly args: readonly Node[];
      readonly dtype: DType;
      readonly shape: readonly number[];
    };

/** Something element-wise operations take: an array, an expression, or a plain number (broadcast everywhere). */
export type OperandLike = Operand | number;

/** An axis or axes to reduce along, and whether to keep them as length-1 dimensions. */
export interface AxisOptions {
  /** Axis (negative counts from the end) or axes. Default every axis. */
  readonly axis?: number | readonly number[];
  /** Keep reduced axes as length 1, so the result broadcasts against the input. Default false. */
  readonly keepdims?: boolean;
}

/** Shape of the NumPy broadcast of `a` and `b`; throws a RangeError naming both when they do not broadcast. */
export function broadcastShapes(a: readonly number[], b: readonly number[]): number[] {
  const rank = Math.max(a.length, b.length),
    out: number[] = [];
  for (let k = 0; k < rank; k++) {
    const x = a[a.length - rank + k] ?? 1,
      y = b[b.length - rank + k] ?? 1;
    if (x !== y && x !== 1 && y !== 1)
      throw rangeError(
        `Shapes [${a.join(', ')}] and [${b.join(', ')}] do not broadcast; reshape one of them`,
        'compute',
      );
    out.push(x === 1 ? y : x);
  }
  return out;
}

const shapeOf = (node: Node): readonly number[] =>
  node.kind === 'leaf' ? node.array.shape : node.kind === 'scalar' ? [] : node.shape;

// Result types of element-wise operations.
const FLOAT_RESULT = new Set([
  'div',
  'pow',
  'sqrt',
  'rsqrt',
  'exp',
  'exp2',
  'log',
  'log2',
  'log1p',
  'expm1',
  'sin',
  'cos',
  'tan',
  'asin',
  'acos',
  'atan',
  'atan2',
  'sinh',
  'cosh',
  'tanh',
  'reciprocal',
  'hypot',
  'degrees',
  'radians',
]);
const INTEGER_ONLY = new Set(['bitAnd', 'bitOr', 'bitXor', 'bitNot', 'shiftLeft', 'shiftRight', 'popcount']);
const BOOL_RESULT = new Set([
  'lt',
  'le',
  'gt',
  'ge',
  'eq',
  'ne',
  'and',
  'or',
  'xor',
  'not',
  'isnan',
  'isinf',
  'isfinite',
]);

/**
 * Element-wise operations, conversions and reductions shared by {@link GpuArray} and lazy {@link Expr}essions. Every
 * element-wise method returns an `Expr` (nothing runs yet); `eval()`, `read()` or a reduction runs the fused kernel.
 */
export abstract class Operand {
  /** Element type. */
  abstract readonly dtype: DType;
  /** Dimensions, outermost first (C order). `[]` for a single value. */
  abstract readonly shape: readonly number[];
  /** The compute context. */
  abstract readonly context: ComputeContext;
  /** @internal The expression node. */
  abstract node(): Node;

  /** Number of elements. */
  get size(): number {
    return this.shape.reduce((a, b) => a * b, 1);
  }

  /** Number of dimensions. */
  get ndim(): number {
    return this.shape.length;
  }

  /** @internal Builds an element-wise op node. */
  protected op(op: string, args: readonly OperandLike[], dtype?: DType): Expr {
    const first = args.find((a): a is Operand => a instanceof Operand) ?? this;
    let inputType = first.dtype;
    for (const a of args) if (a instanceof Operand) inputType = promote(inputType, a.dtype);
    for (const a of args) if (typeof a === 'number') inputType = promote(inputType, scalarType(a, inputType));
    if (INTEGER_ONLY.has(op) && isFloat(inputType))
      throw typeError(`${op} needs integer arrays; astype('i32') or astype('u32') first`, 'compute');
    const nodes = args.map((a) => {
      // A number takes the promoted type (NaN and Infinity have already promoted integers to f32).
      if (typeof a === 'number') return { kind: 'scalar', value: a, dtype: inputType } as Node;
      if (!(a instanceof Operand))
        throw typeError(`Operand of ${op} must be a number, a GpuArray or an Expr`, 'compute');
      if (a.context !== this.context)
        throw typeError(`Operand of ${op} belongs to another compute context; create it with this context`, 'compute');
      return a.node();
    });
    const shape = nodes.map(shapeOf).reduce((s, t) => broadcastShapes(s, t), [] as number[]);
    const result =
      dtype ?? (BOOL_RESULT.has(op) ? 'u32' : FLOAT_RESULT.has(op) && !isFloat(inputType) ? 'f32' : inputType);
    return new Expr(this.context, { kind: 'op', op, args: nodes, dtype: result, shape });
  }

  /** `this + b`. */ add(b: OperandLike): Expr {
    return this.op('add', [this, b]);
  }
  /** `this - b`. */ sub(b: OperandLike): Expr {
    return this.op('sub', [this, b]);
  }
  /** `this * b`. */ mul(b: OperandLike): Expr {
    return this.op('mul', [this, b]);
  }
  /** True division `this / b` (integers divide as f32, as NumPy's `/`). */ div(b: OperandLike): Expr {
    return this.op('div', [this, b]);
  }
  /** Floor division (NumPy `//`); integer division by zero gives 0. */ floorDiv(b: OperandLike): Expr {
    return this.op('floorDiv', [this, b]);
  }
  /** Remainder with the sign of `b` (NumPy `%`). */ mod(b: OperandLike): Expr {
    return this.op('mod', [this, b]);
  }
  /** `this ** b` (as f32). */ pow(b: OperandLike): Expr {
    return this.op('pow', [this, b]);
  }
  /** Element-wise minimum (NumPy `minimum`). */ minimum(b: OperandLike): Expr {
    return this.op('minimum', [this, b]);
  }
  /** Element-wise maximum (NumPy `maximum`). */ maximum(b: OperandLike): Expr {
    return this.op('maximum', [this, b]);
  }
  /** Limits values to [lo, hi] (NumPy `clip`). */ clip(lo: OperandLike, hi: OperandLike): Expr {
    return this.op('clip', [this, lo, hi]);
  }
  /** Two-argument arctangent `atan2(this, x)` in radians. */ atan2(x: OperandLike): Expr {
    return this.op('atan2', [this, x]);
  }
  /** `sqrt(this² + b²)`. */ hypot(b: OperandLike): Expr {
    return this.op('hypot', [this, b]);
  }
  /** `-this`. */ neg(): Expr {
    return this.op('neg', [this]);
  }
  /** Absolute value. */ abs(): Expr {
    return this.op('abs', [this]);
  }
  /** -1, 0 or 1. */ sign(): Expr {
    return this.op('sign', [this]);
  }
  /** `this * this`. */ square(): Expr {
    return this.op('square', [this]);
  }
  /** Square root. */ sqrt(): Expr {
    return this.op('sqrt', [this]);
  }
  /** `1 / sqrt(this)`. */ rsqrt(): Expr {
    return this.op('rsqrt', [this]);
  }
  /** `1 / this`. */ reciprocal(): Expr {
    return this.op('reciprocal', [this]);
  }
  /** e to the power of each element. */ exp(): Expr {
    return this.op('exp', [this]);
  }
  /** 2 to the power of each element. */ exp2(): Expr {
    return this.op('exp2', [this]);
  }
  /** `exp(this) - 1`, accurate near 0. */ expm1(): Expr {
    return this.op('expm1', [this]);
  }
  /** Natural logarithm. */ log(): Expr {
    return this.op('log', [this]);
  }
  /** Base-2 logarithm. */ log2(): Expr {
    return this.op('log2', [this]);
  }
  /** `log(1 + this)`, accurate near 0. */ log1p(): Expr {
    return this.op('log1p', [this]);
  }
  /** Sine (radians). */ sin(): Expr {
    return this.op('sin', [this]);
  }
  /** Cosine (radians). */ cos(): Expr {
    return this.op('cos', [this]);
  }
  /** Tangent (radians). */ tan(): Expr {
    return this.op('tan', [this]);
  }
  /** Arcsine. */ asin(): Expr {
    return this.op('asin', [this]);
  }
  /** Arccosine. */ acos(): Expr {
    return this.op('acos', [this]);
  }
  /** Arctangent. */ atan(): Expr {
    return this.op('atan', [this]);
  }
  /** Hyperbolic sine. */ sinh(): Expr {
    return this.op('sinh', [this]);
  }
  /** Hyperbolic cosine. */ cosh(): Expr {
    return this.op('cosh', [this]);
  }
  /** Hyperbolic tangent. */ tanh(): Expr {
    return this.op('tanh', [this]);
  }
  /** Radians to degrees. */ degrees(): Expr {
    return this.op('degrees', [this]);
  }
  /** Degrees to radians. */ radians(): Expr {
    return this.op('radians', [this]);
  }
  /** Rounds down. */ floor(): Expr {
    return this.op('floor', [this]);
  }
  /** Rounds up. */ ceil(): Expr {
    return this.op('ceil', [this]);
  }
  /** Rounds to nearest, ties to even (as NumPy). */ round(): Expr {
    return this.op('round', [this]);
  }
  /** Rounds toward zero. */ trunc(): Expr {
    return this.op('trunc', [this]);
  }
  /** 1 where `this < b`, else 0 (u32). */ lt(b: OperandLike): Expr {
    return this.op('lt', [this, b]);
  }
  /** 1 where `this <= b`, else 0 (u32). */ le(b: OperandLike): Expr {
    return this.op('le', [this, b]);
  }
  /** 1 where `this > b`, else 0 (u32). */ gt(b: OperandLike): Expr {
    return this.op('gt', [this, b]);
  }
  /** 1 where `this >= b`, else 0 (u32). */ ge(b: OperandLike): Expr {
    return this.op('ge', [this, b]);
  }
  /** 1 where `this == b`, else 0 (u32). */ eq(b: OperandLike): Expr {
    return this.op('eq', [this, b]);
  }
  /** 1 where `this != b`, else 0 (u32). */ ne(b: OperandLike): Expr {
    return this.op('ne', [this, b]);
  }
  /** Logical and of truthiness (non-zero), as u32 0 or 1. */ and(b: OperandLike): Expr {
    return this.op('and', [this, b]);
  }
  /** Logical or of truthiness, as u32 0 or 1. */ or(b: OperandLike): Expr {
    return this.op('or', [this, b]);
  }
  /** Logical exclusive or of truthiness, as u32 0 or 1. */ xor(b: OperandLike): Expr {
    return this.op('xor', [this, b]);
  }
  /** Logical not: 1 where zero, else 0 (u32). */ not(): Expr {
    return this.op('not', [this]);
  }
  /** 1 where NaN (u32). */ isnan(): Expr {
    return this.op('isnan', [this]);
  }
  /** 1 where +-Infinity (u32). */ isinf(): Expr {
    return this.op('isinf', [this]);
  }
  /** 1 where neither NaN nor infinite (u32). */ isfinite(): Expr {
    return this.op('isfinite', [this]);
  }
  /** Bitwise and (integers). */ bitAnd(b: OperandLike): Expr {
    return this.op('bitAnd', [this, b]);
  }
  /** Bitwise or (integers). */ bitOr(b: OperandLike): Expr {
    return this.op('bitOr', [this, b]);
  }
  /** Bitwise exclusive or (integers). */ bitXor(b: OperandLike): Expr {
    return this.op('bitXor', [this, b]);
  }
  /** Bitwise not (integers). */ bitNot(): Expr {
    return this.op('bitNot', [this]);
  }
  /** Shift left by `b` bits (integers). */ shiftLeft(b: OperandLike): Expr {
    return this.op('shiftLeft', [this, b]);
  }
  /** Shift right by `b` bits, arithmetic for i32 (integers). */ shiftRight(b: OperandLike): Expr {
    return this.op('shiftRight', [this, b]);
  }
  /** Number of set bits (integers). */ popcount(): Expr {
    return this.op('popcount', [this]);
  }
  /** Reinterprets the 32-bit pattern as another 32-bit type (f32, i32, u32). */
  bitcast(dtype: Exclude<DType, 'f16'>): Expr {
    if (this.dtype === 'f16') throw typeError('bitcast needs a 32-bit type; astype f16 to f32 first', 'compute');
    return this.op('bitcast', [this], dtype);
  }
  /** Converts to `dtype` (floats to integers truncate toward zero and saturate). */
  astype(dtype: DType): Expr {
    return this.op('astype', [this], dtype);
  }

  /** Runs the expression into a new array (a GpuArray evaluates to a contiguous copy of itself). */
  eval(): GpuArray {
    return this.context.evaluate(this);
  }

  /** Evaluates and copies the elements back to the CPU in C order. */
  async read(options?: ReadOptions): Promise<ArrayBufferView<ArrayBuffer> & ArrayLike<number>> {
    const array = this.eval();
    try {
      return await array.read(options);
    } finally {
      array.dispose();
    }
  }

  /** The single value of a one-element expression or array, read back. */
  async item(options?: WaitOptions): Promise<number> {
    if (this.size !== 1)
      throw rangeError(
        `item() needs exactly one element, the shape is [${this.shape.join(', ')}]; reduce it first`,
        'compute',
      );
    return (await this.read(options))[0];
  }

  /** Sum (along `axis`). */ sum(options?: AxisOptions): GpuArray {
    return this.context.sum(this, options);
  }
  /** Product (along `axis`). */ prod(options?: AxisOptions): GpuArray {
    return this.context.prod(this, options);
  }
  /** Minimum (along `axis`). */ min(options?: AxisOptions): GpuArray {
    return this.context.min(this, options);
  }
  /** Maximum (along `axis`). */ max(options?: AxisOptions): GpuArray {
    return this.context.max(this, options);
  }
  /** Arithmetic mean (along `axis`), in f32. */ mean(options?: AxisOptions): GpuArray {
    return this.context.mean(this, options);
  }
  /** Variance (along `axis`) with `ddof` delta degrees of freedom (default 0), in f32. */
  var(options?: AxisOptions & { readonly ddof?: number }): GpuArray {
    return this.context.var(this, options);
  }
  /** Standard deviation (along `axis`), in f32. */
  std(options?: AxisOptions & { readonly ddof?: number }): GpuArray {
    return this.context.std(this, options);
  }
  /** Index of the minimum (along one axis; flat index without one), first on ties. */
  argmin(options?: { readonly axis?: number; readonly keepdims?: boolean }): GpuArray<'u32'> {
    return this.context.argmin(this, options);
  }
  /** Index of the maximum (along one axis; flat index without one), first on ties. */
  argmax(options?: { readonly axis?: number; readonly keepdims?: boolean }): GpuArray<'u32'> {
    return this.context.argmax(this, options);
  }
  /** 1 when every element (along `axis`) is non-zero (u32). */ all(options?: AxisOptions): GpuArray {
    return this.context.all(this, options);
  }
  /** 1 when any element (along `axis`) is non-zero (u32). */ any(options?: AxisOptions): GpuArray {
    return this.context.any(this, options);
  }
}

/** A lazy element-wise expression. Nothing runs until `eval()`, `read()` or a reduction takes it. */
export class Expr extends Operand {
  /** The compute context. */
  readonly context: ComputeContext;
  readonly #node: Node & { kind: 'op' | 'index' };
  /** @internal */
  constructor(context: ComputeContext, node: Node & { kind: 'op' | 'index' }) {
    super();
    this.context = context;
    this.#node = node;
  }
  /** Element type of the result. */
  get dtype(): DType {
    return this.#node.dtype;
  }
  /** Shape of the result (the broadcast of the inputs). */
  get shape(): readonly number[] {
    return this.#node.shape;
  }
  /** @internal */
  node(): Node {
    return this.#node;
  }
}

/** WGSL for a fused expression: storage declarations, the element function and the resources to bind. */
export interface Fused {
  /** `enable f16;` when any value is f16. */
  readonly enables: string;
  /** Storage and uniform declarations, bound from `binding` up. */
  readonly declarations: string;
  /** `fn value(i: u32) -> T` returning element i (C order) of the expression. */
  readonly fn: string;
  /** Binding name to array (and `fused` to the constants), for the context's `submit`. */
  readonly resources: Record<string, GPUBufferBinding | Uint32Array<ArrayBuffer>>;
  /** Next free binding index. */
  readonly next: number;
  /** Result type and shape. */
  readonly dtype: DType;
  readonly shape: readonly number[];
  /** A key for the program cache: the source without constants. */
  readonly key: string;
}

const lanes = 'xyzw';
const strideOf = (shape: readonly number[]) => {
  const strides = new Array<number>(shape.length);
  let s = 1;
  for (let k = shape.length - 1; k >= 0; k--) {
    strides[k] = s;
    s *= shape[k];
  }
  return strides;
};

// The precise f32 functions (packages/shared/precise-math.js) for each element-wise op that uses one.
const PRECISE_OPS: Record<string, string> = {
  pow: 'precisePow',
  atan2: 'preciseAtan2',
  sqrt: 'preciseSqrt',
  exp: 'preciseExp',
  exp2: 'preciseExp2',
  expm1: 'preciseExpm1',
  log: 'preciseLog',
  log2: 'preciseLog2',
  log1p: 'preciseLog1p',
  sin: 'preciseSin',
  cos: 'preciseCos',
  tan: 'preciseTan',
  asin: 'preciseAsin',
  acos: 'preciseAcos',
  atan: 'preciseAtan',
  sinh: 'preciseSinh',
  cosh: 'preciseCosh',
  tanh: 'preciseTanh',
};

/**
 * WGSL for one op applied to argument expressions already of `t` (the promoted input type). `precise` collects the
 * precise functions used; undefined (the context's `fastMath`) uses the WGSL builtins instead.
 */
function opCode(op: string, args: string[], t: DType, out: DType, precise?: Set<string>): string {
  const [a, b, c] = args,
    zero = `${t}(0)`,
    flag = (cond: string) => `select(0u, 1u, ${cond})`;
  // Float functions on integer inputs run in f32 (the result type already says f32).
  const fl = (x: string) => (isFloat(t) ? x : `f32(${x})`);
  const name = precise && PRECISE_OPS[op];
  if (name) {
    // In f32 (an f16 value is widened and the result narrowed back), the same on every GPU.
    precise.add(name);
    const f = (x: string) => (t === 'f32' ? x : `f32(${x})`),
      call = `${name}(${args
        .slice(0, op === 'pow' || op === 'atan2' ? 2 : 1)
        .map(f)
        .join(', ')})`;
    return out === 'f32' ? call : `${out}(${call})`;
  }
  switch (op) {
    case 'add':
      return `(${a} + ${b})`;
    case 'sub':
      return `(${a} - ${b})`;
    case 'mul':
      return `(${a} * ${b})`;
    case 'div':
      return `(${fl(a)} / ${fl(b)})`;
    case 'floorDiv':
      return isFloat(t)
        ? `floor(${a} / ${b})`
        : t === 'u32'
          ? `select(0u, ${a} / ${b}, ${b} != 0u)`
          : `select(0i, (${a} / ${b}) - select(0i, 1i, (${a} % ${b} != 0i) && ((${a} < 0i) != (${b} < 0i))), ${b} != 0i)`;
    case 'mod':
      return isFloat(t)
        ? `(${a} - ${b} * floor(${a} / ${b}))`
        : t === 'u32'
          ? `select(0u, ${a} % ${b}, ${b} != 0u)`
          : `select(0i, ((${a} % ${b}) + ${b}) % ${b}, ${b} != 0i)`;
    case 'pow':
      return `pow(${fl(a)}, ${fl(b)})`;
    case 'minimum':
      return `min(${a}, ${b})`;
    case 'maximum':
      return `max(${a}, ${b})`;
    case 'clip':
      return `clamp(${a}, ${b}, ${c})`;
    case 'atan2':
      return `atan2(${fl(a)}, ${fl(b)})`;
    case 'hypot':
      return `length(vec2(${fl(a)}, ${fl(b)}))`;
    case 'neg':
      return t === 'u32' ? `(0u - ${a})` : `(-${a})`;
    case 'abs':
      return `abs(${a})`;
    case 'sign':
      return t === 'u32' ? `select(0u, 1u, ${a} > 0u)` : `sign(${a})`;
    case 'square':
      return `(${a} * ${a})`;
    case 'sqrt':
    case 'exp':
    case 'exp2':
    case 'log':
    case 'log2':
    case 'sin':
    case 'cos':
    case 'tan':
    case 'asin':
    case 'acos':
    case 'atan':
    case 'sinh':
    case 'cosh':
    case 'tanh':
    case 'degrees':
    case 'radians':
      return `${op}(${fl(a)})`;
    case 'rsqrt':
      return `inverseSqrt(${fl(a)})`;
    case 'reciprocal':
      return `(1.0 / ${fl(a)})`;
    // log1p and expm1: the classic correction for a rounded 1 + x (D. Goldberg, "What every computer scientist should
    // know about floating-point arithmetic", ACM Computing Surveys 23(1), 1991, theorem 4).
    // u - 1 subtracts 1 from u rebuilt from its bits: WGSL lets a compiler reassociate, and (1.0 + x) - 1.0 written
    // out is folded to x on AMD and Intel GPUs, which leaves log(u) (bug 22; precise-math.js pmHide).
    case 'log1p': {
      const x = fl(a),
        u = `(1.0 + ${x})`,
        bits = `bitcast<u32>(${u})`,
        d = `(ldexp(f32(i32((${bits} & 0x7fffffu) | 0x800000u)), i32((${bits} >> 23u) & 0xffu) - 150i) - 1.0)`;
      return `select(${x} * log(${u}) / ${d}, ${x}, ${d} == 0.0)`;
    }
    case 'expm1': {
      const x = fl(a),
        u = `exp(${x})`;
      return `select(select(select((${u} - 1.0) * ${x} / log(${u}), ${x}, ${u} == 1.0), -1.0, ${x} < -80.0), ${u}, ${x} > 80.0)`;
    }
    case 'floor':
    case 'ceil':
    case 'round':
    case 'trunc':
      return isFloat(t) ? `${op}(${a})` : a;
    case 'lt':
      return flag(`${a} < ${b}`);
    case 'le':
      return flag(`${a} <= ${b}`);
    case 'gt':
      return flag(`${a} > ${b}`);
    case 'ge':
      return flag(`${a} >= ${b}`);
    case 'eq':
      return flag(`${a} == ${b}`);
    case 'ne':
      return flag(`${a} != ${b}`);
    case 'and':
      return flag(`(${a} != ${zero}) && (${b} != ${zero})`);
    case 'or':
      return flag(`(${a} != ${zero}) || (${b} != ${zero})`);
    case 'xor':
      return flag(`(${a} != ${zero}) != (${b} != ${zero})`);
    case 'not':
      return flag(`${a} == ${zero}`);
    case 'isnan':
    case 'isinf':
    case 'isfinite': {
      if (!isFloat(t)) return op === 'isfinite' ? '1u' : '0u';
      const bits = t === 'f16' ? `(bitcast<u32>(f32(${a})) & 0x7fffffffu)` : `(bitcast<u32>(${a}) & 0x7fffffffu)`;
      return op === 'isnan'
        ? flag(`${bits} > 0x7f800000u`)
        : op === 'isinf'
          ? flag(`${bits} == 0x7f800000u`)
          : flag(`${bits} < 0x7f800000u`);
    }
    case 'bitAnd':
    case 'bitOr':
    case 'bitXor':
    case 'bitNot':
    case 'shiftLeft':
    case 'shiftRight':
    case 'popcount':
      if (isFloat(t)) throw typeError(`${op} needs integer arrays; astype('i32') or astype('u32') first`, 'compute');
      return op === 'bitAnd'
        ? `(${a} & ${b})`
        : op === 'bitOr'
          ? `(${a} | ${b})`
          : op === 'bitXor'
            ? `(${a} ^ ${b})`
            : op === 'bitNot'
              ? `(~${a})`
              : op === 'shiftLeft'
                ? `(${a} << (u32(${b}) & 31u))`
                : op === 'shiftRight'
                  ? `(${a} >> (u32(${b}) & 31u))`
                  : `${t}(countOneBits(${a}))`;
    case 'bitcast':
      return `bitcast<${out}>(${a})`;
    case 'astype':
      return `${out}(${a})`;
    case 'where':
      return `select(${c}, ${b}, ${a} != ${zero})`;
    default:
      throw typeError(`Unknown element-wise operation ${op}`, 'compute');
  }
}

/**
 * Compiles `operand` into WGSL that computes any element by index. `binding` is the first binding index to use;
 * leaves become read-only storage bindings `src0`, `src1`, ... (one per distinct buffer) and constants a uniform
 * `fused`. `maxStorage` caps the storage bindings; past it, the deepest subtrees are evaluated first.
 */
export function fuse(operand: Operand, binding: number, maxStorage: number, temporaries: GpuArray[]): Fused {
  let root = operand.node();
  const shape = operand.shape;
  // Evaluate subtrees until the distinct buffers fit the binding budget.
  const leaves = (node: Node, set = new Set<Storage>()): Set<Storage> => {
    if (node.kind === 'leaf') set.add(node.array.storage);
    else if (node.kind === 'op') for (const a of node.args) leaves(a, set);
    return set;
  };
  const split = (node: Node): Node => {
    if (node.kind !== 'op' || leaves(node).size <= maxStorage) return node;
    const args = node.args.map(split);
    let rebuilt: Node = { ...node, args };
    while (leaves(rebuilt).size > maxStorage) {
      const widest = (rebuilt as Node & { kind: 'op' }).args
        .map((a, k) => [k, a.kind === 'op' ? leaves(a).size : 0] as const)
        .sort((x, y) => y[1] - x[1])[0];
      if (!widest || widest[1] === 0)
        throw rangeError(
          `Expression reads more than ${maxStorage} buffers in one operation; evaluate parts of it first`,
          'compute',
        );
      const sub = (rebuilt as Node & { kind: 'op' }).args[widest[0]] as Node & { kind: 'op' };
      const array = operand.context.evaluate(new Expr(operand.context, sub));
      temporaries.push(array);
      const replaced: Node[] = [...(rebuilt as Node & { kind: 'op' }).args];
      replaced[widest[0]] = { kind: 'leaf', array };
      rebuilt = { ...(rebuilt as Node & { kind: 'op' }), args: replaced };
    }
    return rebuilt;
  };
  root = split(root);

  const storages = new Map<Storage, string>(),
    resources: Record<string, GPUBufferBinding | Uint32Array<ArrayBuffer>> = {},
    consts: number[] = [],
    lets: string[] = [],
    names = new Map<Node, string>();
  let declarations = '',
    next = binding,
    f16 = false;
  const precise = operand.context.fastMath ? undefined : new Set<string>();
  const outStrides = strideOf(shape);
  const cast = (v: string, from: DType, to: DType) => (from === to ? v : `${to}(${v})`);
  // Emits one `let` per node (shared subtrees once) and returns the name holding the node's value in its own type.
  const visit = (node: Node): string => {
    const cached = names.get(node);
    if (cached !== undefined) return cached;
    let code: string;
    if (node.kind === 'leaf') {
      const a = node.array;
      let name = storages.get(a.storage);
      if (!name) {
        name = `src${storages.size}`;
        storages.set(a.storage, name);
        declarations += `@group(0) @binding(${next++}) var<storage, read> ${name}: array<${a.dtype}>;
`;
        // The whole buffer is bound; the view's offset and strides are applied in the index below.
        a.check(operand.context);
        resources[name] = { buffer: a.storage.buffer };
      }
      // Element offset of output element i in this view; broadcast dimensions contribute nothing.
      const rank = shape.length,
        same = a.contiguous && a.shape.length === rank && a.shape.every((d, k) => d === shape[k]);
      let index: string;
      if (same) index = a.offset ? `(i + ${a.offset}u)` : 'i';
      else {
        // Signed when a stride is negative (a reversed slice), so the sum may step backwards from the offset.
        const signed = a.strides.some((st) => st < 0),
          suffix = signed ? 'i' : 'u',
          terms: string[] = a.offset ? [`${a.offset}${suffix}`] : [];
        for (let k = 0; k < a.shape.length; k++) {
          const outK = rank - a.shape.length + k;
          if (a.shape[k] === 1 || a.strides[k] === 0) continue;
          let coordinate = outK === 0 ? `(i / ${outStrides[0]}u)` : `((i / ${outStrides[outK]}u) % ${shape[outK]}u)`;
          if (signed) coordinate = `i32${coordinate}`;
          terms.push(a.strides[k] === 1 ? coordinate : `${coordinate} * ${a.strides[k]}${suffix}`);
        }
        index = terms.length ? (signed ? `u32(${terms.join(' + ')})` : terms.join(' + ')) : '0u';
      }
      code = `${name}[${index}]`;
    } else if (node.kind === 'scalar') {
      const slot = consts.length;
      consts.push(bitsOf(node.value, node.dtype));
      code = fromBits(`fused[${slot >> 2}].${lanes[slot & 3]}`, node.dtype);
    } else if (node.kind === 'index') code = 'i';
    else if (node.op === 'where') {
      const [condition, x, y] = node.args;
      code = `select(${cast(visit(y), dtypeOfNode(y), node.dtype)}, ${cast(visit(x), dtypeOfNode(x), node.dtype)}, ${visit(condition)} != ${dtypeOfNode(condition)}(0))`;
    } else {
      // The op's input type: the promotion of its arguments' types (scalars already carry it).
      const t = node.args.map(dtypeOfNode).reduce(promote);
      code = opCode(
        node.op,
        node.args.map((arg) => cast(visit(arg), dtypeOfNode(arg), t)),
        t,
        node.dtype,
        precise,
      );
    }
    const own = dtypeOfNode(node);
    if (own === 'f16') f16 = true;
    const v = `v${names.size}`;
    lets.push(`let ${v}: ${own} = ${code};`);
    names.set(node, v);
    return v;
  };
  const result = visit(root);
  const slots = Math.max(1, Math.ceil(consts.length / 4));
  const values = new Uint32Array(slots * 4);
  values.set(consts);
  declarations += `@group(0) @binding(${next++}) var<uniform> fused: array<vec4u, ${slots}>;\n`;
  resources.fused = values;
  const helpers = precise?.size ? preciseMathWgsl([...precise]) : '';
  const fn = `${helpers}fn value(i: u32) -> ${operand.dtype} {\n  ${lets.join('\n  ')}\n  return ${result};\n}`;
  return {
    enables: f16 ? 'enable f16;\n' : '',
    declarations,
    fn,
    resources,
    next,
    dtype: operand.dtype,
    shape,
    key: `${declarations}\n${fn}`,
  };
}

const dtypeOfNode = (node: Node): DType => (node.kind === 'leaf' ? node.array.dtype : node.dtype);

/** NumPy-style `where(condition, a, b)`: `a` where the condition is non-zero, else `b`, broadcast together. */
export function where(condition: Operand, a: OperandLike, b: OperandLike): Expr {
  if (!(condition instanceof Operand)) throw typeError('where needs a condition array or expression', 'compute');
  const branch = (x: OperandLike, other: OperandLike) =>
    typeof x === 'number' ? scalarType(x, other instanceof Operand ? other.dtype : 'f32') : x.dtype;
  const t = promote(branch(a, b), branch(b, a));
  return (condition as unknown as { op(op: string, args: OperandLike[], dtype?: DType): Expr }).op(
    'where',
    [condition, a, b],
    t,
  );
}
