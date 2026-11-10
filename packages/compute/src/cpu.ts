/// <reference lib="esnext.disposable" preserve="true" />
// The CPU fallback: the same ComputeContext API on plain JavaScript, for runtimes without WebGPU (Node, older browsers,
// blocklisted GPUs). Arrays live in host buffers; expressions run through an interpreter of the same tree the GPU path
// compiles, rounding every value to its element type as the GPU does (f32 with Math.fround, i32 and u32 wrapping).
// Reductions and scans accumulate in double precision, so they agree with the GPU to f32 rounding, not bit for bit.
// The optional entries' kernels (matmul, Stockham FFT passes, convolution, Philox random numbers) run as host
// versions of their WGSL, chosen by the pass label, so those entries keep one code path. Your own WGSL (`kernel`,
// `map`, custom operators) needs a GPU and throws a coded `unsupported` error. Loaded with import() only when
// createCompute falls back, so GPU users never download it.
import { fault, rangeError, typeError } from '../../shared/errors.js';
import { GpuArray, axisOf } from './array.js';
import { isFloat, promote, type DType } from './dtype.js';
import { Operand, where, type AxisOptions, type Node, type OperandLike } from './expr.js';
import {
  ComputeContext,
  aborted,
  type Copy,
  type Pass,
  type PassTiming,
  type Program,
  type WaitOptions,
} from './context.js';
import type { CpuRuntime } from './cpu-runtime.js';
import type { Kernel } from './kernel.js';
import type { Operator } from './shaders.js';
import type { ScanOptions } from './scan.js';
import type { SortOptions } from './sort.js';
import type { TakeOptions } from './select.js';
import type { Histogram, HistogramOptions } from './histogram.js';

type Values = Float64Array;
type Typed = Float32Array | Int32Array | Uint32Array;

/** Host memory standing in for a GPU buffer. */
class HostBuffer {
  bytes: ArrayBuffer;
  constructor(
    readonly size: number,
    readonly dtype: DType | undefined,
  ) {
    this.bytes = new ArrayBuffer(size);
  }
  destroy(): void {
    this.bytes = new ArrayBuffer(0);
  }
}

const runtimes = new WeakMap<ComputeContext, CpuRuntime>();

const host = (buffer: unknown): HostBuffer => buffer as HostBuffer;

const typed = (buffer: HostBuffer, dtype: DType): Typed =>
  dtype === 'f32'
    ? new Float32Array(buffer.bytes)
    : dtype === 'i32'
      ? new Int32Array(buffer.bytes)
      : new Uint32Array(buffer.bytes);

/** The whole host buffer of an array, typed by its element type (index it from `array.offset`). */
export const cpuView = (array: GpuArray): Typed => typed(host(array.storage.buffer), array.dtype);

/** The few device members the shared code reads, backed by host memory. */
function hostDevice(): GPUDevice {
  const device = {
    label: 'cpu',
    features: new Set<string>(),
    limits: {
      maxStorageBufferBindingSize: 2 ** 31,
      maxBufferSize: 2 ** 31,
      maxComputeWorkgroupsPerDimension: 65535,
      maxStorageBuffersPerShaderStage: 16,
      minStorageBufferOffsetAlignment: 4,
    },
    lost: new Promise<never>(() => {}),
    createBuffer: ({ size }: { size: number }) => new HostBuffer(size, undefined),
    queue: {
      writeBuffer(buffer: HostBuffer, offset: number, data: ArrayBufferView | ArrayBuffer) {
        const source = ArrayBuffer.isView(data)
          ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
          : new Uint8Array(data);
        new Uint8Array(buffer.bytes).set(source, offset);
      },
    },
    destroy() {},
  };
  return device as unknown as GPUDevice;
}

// --- Element types -------------------------------------------------------------------------------------------------

const ROUND: Record<DType, (v: number) => number> = {
  f32: Math.fround,
  f16: Math.fround,
  i32: (v) => v | 0,
  u32: (v) => v >>> 0,
};
const id = (v: number) => v;
const I32_MAX = 2147483647,
  I32_MIN = -2147483648,
  U32_MAX = 4294967295;

/** WGSL's conversion `to(v)` of a value of type `from`: floats truncate toward zero and saturate (NaN to 0). */
function conv(from: DType, to: DType): (v: number) => number {
  if (from === to) return id;
  if (isFloat(to)) return Math.fround;
  if (isFloat(from))
    return to === 'i32'
      ? (v) => (v !== v ? 0 : v >= I32_MAX ? I32_MAX : v <= I32_MIN ? I32_MIN : Math.trunc(v))
      : (v) => (v !== v ? 0 : v >= U32_MAX ? U32_MAX : v <= 0 ? 0 : Math.trunc(v));
  return ROUND[to];
}

const scratch = new DataView(new ArrayBuffer(4));
function bitcast(v: number, from: DType, to: DType): number {
  if (from === 'f32') scratch.setFloat32(0, v, true);
  else if (from === 'i32') scratch.setInt32(0, v, true);
  else scratch.setUint32(0, v, true);
  return to === 'f32'
    ? scratch.getFloat32(0, true)
    : to === 'i32'
      ? scratch.getInt32(0, true)
      : scratch.getUint32(0, true);
}

// Rounds to nearest, ties to even (WGSL round, NumPy rint).
const roundEven = (x: number) => {
  const r = Math.round(x);
  return r - x === 0.5 && r % 2 !== 0 ? r - 1 : r;
};
const popcount = (v: number) => {
  let x = v >>> 0,
    c = 0;
  while (x) {
    x &= x - 1;
    c++;
  }
  return c;
};
// WGSL i32 division and remainder: MIN / -1 is MIN and MIN % -1 is 0 (division by zero is handled by the callers).
const divI = (a: number, b: number) => (a === I32_MIN && b === -1 ? a : (a / b) | 0);
const remI = (a: number, b: number) => (a % b) | 0;

type Fn = (a: number, b: number, c: number) => number;

/** One element-wise op on arguments already converted to `t`, rounded to `out` (expr.ts opCode, on the CPU). */
function opFn(op: string, t: DType, out: DType): Fn {
  const F = isFloat(t),
    u = t === 'u32',
    r = ROUND[out],
    f = Math.fround,
    fl = F ? id : Math.fround;
  const math =
    (g: (x: number) => number): Fn =>
    (a) =>
      f(g(fl(a)));
  switch (op) {
    case 'add':
      return (a, b) => r(a + b);
    case 'sub':
      return (a, b) => r(a - b);
    case 'mul':
      return F ? (a, b) => f(a * b) : (a, b) => r(Math.imul(a, b));
    case 'div':
      return (a, b) => f(fl(a) / fl(b));
    case 'floorDiv':
      return F
        ? (a, b) => f(Math.floor(f(a / b)))
        : u
          ? (a, b) => (b ? Math.floor(a / b) : 0)
          : (a, b) => (b === 0 ? 0 : (divI(a, b) - (remI(a, b) !== 0 && a < 0 !== b < 0 ? 1 : 0)) | 0);
    case 'mod':
      return F
        ? (a, b) => f(a - f(b * Math.floor(f(a / b))))
        : u
          ? (a, b) => (b ? a % b : 0)
          : (a, b) => (b === 0 ? 0 : remI((remI(a, b) + b) | 0, b));
    case 'pow':
      return (a, b) => f(Math.pow(fl(a), fl(b)));
    case 'minimum':
      return (a, b) => Math.min(a, b);
    case 'maximum':
      return (a, b) => Math.max(a, b);
    case 'clip':
      return (a, lo, hi) => Math.min(Math.max(a, lo), hi);
    case 'atan2':
      return (a, b) => f(Math.atan2(fl(a), fl(b)));
    case 'hypot':
      return (a, b) => f(Math.hypot(fl(a), fl(b)));
    case 'neg':
      return (a) => r(-a);
    case 'abs':
      return u ? id : (a) => r(Math.abs(a));
    case 'sign':
      return u ? (a) => (a > 0 ? 1 : 0) : (a) => Math.sign(a) + 0;
    case 'square':
      return F ? (a) => f(a * a) : (a) => r(Math.imul(a, a));
    case 'sqrt':
      return math(Math.sqrt);
    case 'exp':
      return math(Math.exp);
    case 'exp2':
      return math((x) => 2 ** x);
    case 'log':
      return math(Math.log);
    case 'log2':
      return math(Math.log2);
    case 'sin':
      return math(Math.sin);
    case 'cos':
      return math(Math.cos);
    case 'tan':
      return math(Math.tan);
    case 'asin':
      return math(Math.asin);
    case 'acos':
      return math(Math.acos);
    case 'atan':
      return math(Math.atan);
    case 'sinh':
      return math(Math.sinh);
    case 'cosh':
      return math(Math.cosh);
    case 'tanh':
      return math(Math.tanh);
    case 'degrees':
      return (a) => f(fl(a) * f(180 / Math.PI));
    case 'radians':
      return (a) => f(fl(a) * f(Math.PI / 180));
    case 'rsqrt':
      return math((x) => 1 / Math.sqrt(x));
    case 'reciprocal':
      return math((x) => 1 / x);
    case 'log1p':
      return math(Math.log1p);
    case 'expm1':
      return math(Math.expm1);
    case 'floor':
      return F ? (a) => Math.floor(a) : id;
    case 'ceil':
      return F ? (a) => Math.ceil(a) : id;
    case 'trunc':
      return F ? (a) => Math.trunc(a) : id;
    case 'round':
      return F ? roundEven : id;
    case 'lt':
      return (a, b) => (a < b ? 1 : 0);
    case 'le':
      return (a, b) => (a <= b ? 1 : 0);
    case 'gt':
      return (a, b) => (a > b ? 1 : 0);
    case 'ge':
      return (a, b) => (a >= b ? 1 : 0);
    case 'eq':
      return (a, b) => (a === b ? 1 : 0);
    case 'ne':
      return (a, b) => (a !== b ? 1 : 0);
    case 'and':
      return (a, b) => (a !== 0 && b !== 0 ? 1 : 0);
    case 'or':
      return (a, b) => (a !== 0 || b !== 0 ? 1 : 0);
    case 'xor':
      return (a, b) => ((a !== 0) !== (b !== 0) ? 1 : 0);
    case 'not':
      return (a) => (a === 0 ? 1 : 0);
    case 'isnan':
      return F ? (a) => (a !== a ? 1 : 0) : () => 0;
    case 'isinf':
      return F ? (a) => (a === Infinity || a === -Infinity ? 1 : 0) : () => 0;
    case 'isfinite':
      return F ? (a) => (Number.isFinite(a) ? 1 : 0) : () => 1;
    case 'bitAnd':
      return (a, b) => r(a & b);
    case 'bitOr':
      return (a, b) => r(a | b);
    case 'bitXor':
      return (a, b) => r(a ^ b);
    case 'bitNot':
      return (a) => r(~a);
    case 'shiftLeft':
      return (a, b) => r(a << (b & 31));
    case 'shiftRight':
      return u ? (a, b) => a >>> (b & 31) : (a, b) => a >> (b & 31);
    case 'popcount':
      return popcount;
    case 'bitcast':
      return (a) => bitcast(a, t, out);
    case 'astype':
      return conv(t, out);
    default:
      throw typeError(`Unknown element-wise operation ${op}`, 'compute');
  }
}

// --- Expression interpreter ----------------------------------------------------------------------------------------

const CHUNK = 4096;
type Fill = (start: number, length: number, out: Values) => void;
const dtypeOfNode = (node: Node): DType => (node.kind === 'leaf' ? node.array.dtype : node.dtype);

/** Fills `out` with elements [start, start + length) (C order of `shape`, the root's shape) of `node`. */
function compile(node: Node, shape: readonly number[]): Fill {
  if (node.kind === 'leaf') {
    const a = node.array;
    a.check(a.context);
    const view = cpuView(a),
      rank = shape.length;
    if (a.contiguous && a.shape.length === rank && a.shape.every((d, k) => d === shape[k])) {
      const offset = a.offset;
      return (s, n, out) => {
        for (let j = 0; j < n; j++) out[j] = view[offset + s + j];
      };
    }
    // Strides aligned to the output dimensions; broadcast dimensions step 0.
    const steps = shape.map((_, k) => {
      const own = k - (rank - a.shape.length);
      return own < 0 || a.shape[own] === 1 ? 0 : a.strides[own];
    });
    const index = new Array<number>(rank);
    return (s, n, out) => {
      let rest = s,
        at = a.offset;
      for (let k = rank - 1; k >= 0; k--) {
        index[k] = rest % shape[k];
        rest = Math.floor(rest / shape[k]);
        at += index[k] * steps[k];
      }
      for (let j = 0; j < n; j++) {
        out[j] = view[at];
        for (let k = rank - 1; k >= 0; k--) {
          at += steps[k];
          if (++index[k] < shape[k]) break;
          at -= steps[k] * shape[k];
          index[k] = 0;
        }
      }
    };
  }
  if (node.kind === 'scalar') {
    const v = ROUND[node.dtype](node.value);
    return (_s, n, out) => out.fill(v, 0, n);
  }
  if (node.kind === 'index')
    return (s, n, out) => {
      for (let j = 0; j < n; j++) out[j] = s + j;
    };
  const kids = node.args.map((arg) => compile(arg, shape)),
    bufs = kids.map(() => new Float64Array(CHUNK));
  if (node.op === 'where') {
    const [, x, y] = node.args,
      cx = conv(dtypeOfNode(x), node.dtype),
      cy = conv(dtypeOfNode(y), node.dtype);
    return (s, n, out) => {
      for (let k = 0; k < 3; k++) kids[k](s, n, bufs[k]);
      const [c, a, b] = bufs;
      for (let j = 0; j < n; j++) out[j] = c[j] !== 0 ? cx(a[j]) : cy(b[j]);
    };
  }
  const t = node.args.map(dtypeOfNode).reduce(promote),
    casts = node.args.map((arg) => conv(dtypeOfNode(arg), t)),
    f = opFn(node.op, t, node.dtype);
  if (kids.length === 1) {
    const [c0] = casts;
    return (s, n, out) => {
      kids[0](s, n, bufs[0]);
      const a = bufs[0];
      for (let j = 0; j < n; j++) out[j] = f(c0(a[j]), 0, 0);
    };
  }
  if (kids.length === 2) {
    const [c0, c1] = casts;
    return (s, n, out) => {
      kids[0](s, n, bufs[0]);
      kids[1](s, n, bufs[1]);
      const [a, b] = bufs;
      for (let j = 0; j < n; j++) out[j] = f(c0(a[j]), c1(b[j]), 0);
    };
  }
  const [c0, c1, c2] = casts;
  return (s, n, out) => {
    for (let k = 0; k < 3; k++) kids[k](s, n, bufs[k]);
    const [a, b, c] = bufs;
    for (let j = 0; j < n; j++) out[j] = f(c0(a[j]), c1(b[j]), c2(c[j]));
  };
}

/** Every element of `operand` in C order, as exact values of its element type. */
function values(operand: Operand): Values {
  const runtime = runtimes.get(operand.context);
  if (runtime) return runtime.values(operand);
  const n = operand.size,
    out = new Float64Array(n);
  if (n === 0) return out;
  const fill = compile(operand.node(), operand.shape);
  for (let s = 0; s < n; s += CHUNK) fill(s, Math.min(CHUNK, n - s), out.subarray(s, Math.min(s + CHUNK, n)));
  return out;
}

// --- Shapes and folds ----------------------------------------------------------------------------------------------

const typeCode = (t: DType) => (t === 'i32' ? 1 : t === 'u32' ? 2 : 0);
const foldCode = (op: Operator) => ['sum', 'product', 'min', 'max'].indexOf(op as string);

const sizeOf = (shape: readonly number[]) => shape.reduce((a, b) => a * b, 1);

function axesOf(axis: number | readonly number[] | undefined, ndim: number): number[] {
  if (axis === undefined) return Array.from({ length: ndim }, (_, k) => k);
  const list = (typeof axis === 'number' ? [axis] : [...axis]).map((a) => axisOf(a, ndim));
  if (new Set(list).size !== list.length) throw rangeError(`Reduction axes repeat: [${String(axis)}]`, 'compute');
  return list.sort((a, b) => a - b);
}

const shapeAfter = (shape: readonly number[], axes: readonly number[], keepdims: boolean) =>
  keepdims ? shape.map((d, k) => (axes.includes(k) ? 1 : d)) : shape.filter((_, k) => !axes.includes(k));

/** For each input element (C order), the flat index of its output when `axes` are folded away. */
function outputIndex(shape: readonly number[], axes: readonly number[]): Uint32Array {
  const n = sizeOf(shape),
    rank = shape.length,
    kept = shape.map((d, k) => (axes.includes(k) ? 1 : d)),
    steps = new Array<number>(rank);
  let s = 1;
  for (let k = rank - 1; k >= 0; k--) {
    steps[k] = axes.includes(k) ? 0 : s;
    s *= kept[k];
  }
  const out = new Uint32Array(n),
    index = new Array<number>(rank).fill(0);
  let at = 0;
  for (let i = 0; i < n; i++) {
    out[i] = at;
    for (let k = rank - 1; k >= 0; k--) {
      at += steps[k];
      if (++index[k] < shape[k]) break;
      at -= steps[k] * shape[k];
      index[k] = 0;
    }
  }
  return out;
}

type Fold = { identity: number; combine: (acc: number, v: number) => number; finish: (acc: number) => number };

/** The fold of a built-in operator in `dtype`; float sums run in double precision and round once at the end. */
function foldOf(op: Operator, dtype: DType, what: string): Fold {
  if (typeof op === 'object')
    throw fault(
      'unsupported',
      `${what} with a custom WGSL operator needs a GPU; use sum, product, min or max on the CPU backend`,
      'compute',
    );
  const F = isFloat(dtype),
    r = ROUND[dtype];
  switch (op) {
    case 'sum':
      return F
        ? { identity: 0, combine: (a, v) => a + v, finish: Math.fround }
        : { identity: 0, combine: (a, v) => r(a + v), finish: id };
    case 'product':
      return F
        ? { identity: 1, combine: (a, v) => Math.fround(a * v), finish: id }
        : { identity: 1, combine: (a, v) => r(Math.imul(a, v)), finish: id };
    case 'min':
      return {
        identity: dtype === 'i32' ? I32_MAX : dtype === 'u32' ? U32_MAX : Infinity,
        combine: (a, v) => (v < a ? v : a),
        finish: id,
      };
    case 'max':
      return {
        identity: dtype === 'i32' ? I32_MIN : dtype === 'u32' ? 0 : -Infinity,
        combine: (a, v) => (v > a ? v : a),
        finish: id,
      };
    default:
      throw typeError(
        `Unknown reduce op ${String(op)}; use sum, product, min, max or { combine, identity }`,
        'compute',
      );
  }
}

/** Order keys of `dtype` (shaders.ts toKey): u32 whose unsigned order is the value order, NaN by sign bit. */
function keyOf(dtype: DType): (v: number) => number {
  if (dtype === 'u32') return id;
  if (dtype === 'i32') return (v) => (v ^ 0x80000000) >>> 0;
  return (v) => {
    scratch.setFloat32(0, v, true);
    const bits = scratch.getUint32(0, true);
    return (bits & 0x80000000 ? ~bits : bits | 0x80000000) >>> 0;
  };
}

/** Stable LSD radix sort of u32 keys (8 bits a pass over the low `bits`); returns the sorting permutation. */
function radixOrder(keys: Uint32Array, bits: number): Uint32Array {
  const n = keys.length;
  let order = new Uint32Array(n),
    next = new Uint32Array(n);
  for (let i = 0; i < n; i++) order[i] = i;
  const counts = new Uint32Array(256);
  for (let shift = 0; shift < bits; shift += 8) {
    counts.fill(0);
    for (let i = 0; i < n; i++) counts[(keys[i] >>> shift) & 0xff]++;
    let sum = 0;
    for (let d = 0; d < 256; d++) {
      const c = counts[d];
      counts[d] = sum;
      sum += c;
    }
    for (let i = 0; i < n; i++) {
      const k = order[i];
      next[counts[(keys[k] >>> shift) & 0xff]++] = k;
    }
    [order, next] = [next, order];
  }
  return order;
}

const integersOnly = (indices: Operand) => {
  if (!(indices instanceof Operand)) throw typeError('Indices must be a GpuArray or an Expr', 'compute');
  if (isFloat(indices.dtype)) throw typeError("Indices must be integers; astype('i32') first", 'compute');
  return Int32Array.from(values(indices.astype('i32')));
};

const gpuOnly = (what: string) =>
  fault(
    'unsupported',
    `${what} runs WGSL, which needs a GPU; the CPU backend runs the built-in operations only`,
    'compute',
  );

// --- Host versions of the entries' kernels, by pass label ----------------------------------------------------------

type Resources = Readonly<Record<string, unknown>>;

/** A binding as host values: a GpuArray from its offset, a `{ buffer }` binding whole, or uniform bytes. */
export function cpuBound(resource: unknown): { data: Typed; offset: number } {
  if (resource instanceof GpuArray) return { data: cpuView(resource), offset: resource.offset };
  const buffer = host((resource as { buffer: unknown }).buffer);
  return { data: typed(buffer, buffer.dtype ?? 'f32'), offset: 0 };
}
export const cpuUniform = (resource: unknown) => {
  const v = resource as ArrayBufferView;
  return new DataView(v.buffer, v.byteOffset, v.byteLength);
};

// Philox4x32-10. The high word of each 32 x 32-bit product from 16-bit halves (as the WGSL does), the low word with
// Math.imul: both exact.
function mulhi(a: number, b: number): number {
  const a0 = a & 0xffff,
    a1 = a >>> 16,
    b0 = b & 0xffff,
    b1 = b >>> 16,
    p00 = a0 * b0,
    p01 = a0 * b1,
    p10 = a1 * b0,
    mid = (p00 >>> 16) + (p01 & 0xffff) + (p10 & 0xffff);
  return (a1 * b1 + (p01 >>> 16) + (p10 >>> 16) + (mid >>> 16)) >>> 0;
}
function philox(c0: number, c1: number, c2: number, c3: number, k0: number, k1: number, out: Uint32Array): void {
  for (let round = 0; round < 10; round++) {
    const hi0 = mulhi(0xd2511f53, c0),
      lo0 = Math.imul(0xd2511f53, c0) >>> 0,
      hi1 = mulhi(0xcd9e8d57, c2),
      lo1 = Math.imul(0xcd9e8d57, c2) >>> 0;
    c0 = (hi1 ^ c1 ^ k0) >>> 0;
    c1 = lo1;
    c2 = (hi0 ^ c3 ^ k1) >>> 0;
    c3 = lo0;
    k0 = (k0 + 0x9e3779b9) >>> 0;
    k1 = (k1 + 0xbb67ae85) >>> 0;
  }
  out[0] = c0;
  out[1] = c1;
  out[2] = c2;
  out[3] = c3;
}

const KERNELS: Record<string, (r: Resources) => void> = {
  // linalg.ts matmulShader: product[(batch * m + r) * n + c] = sum over k of left * right, through the strides.
  matmul(r) {
    const s = new Uint32Array((r.shape as Uint32Array).slice(0, 12)),
      [m, n, k, , aOffset, aBatch, aRow, aCol, bOffset, bBatch, bRow, bCol] = s,
      left = cpuBound(r.left).data,
      right = cpuBound(r.right).data,
      product = r.product as GpuArray,
      out = cpuView(product),
      round = ROUND[product.dtype],
      F = isFloat(product.dtype),
      batches = product.size / (m * n || 1),
      row = new Float64Array(n);
    for (let b = 0; b < batches; b++)
      for (let i = 0; i < m; i++) {
        row.fill(0);
        const a0 = aOffset + b * aBatch + i * aRow;
        for (let kk = 0; kk < k; kk++) {
          const av = left[a0 + kk * aCol],
            b0 = bOffset + b * bBatch + kk * bRow;
          if (F) for (let j = 0; j < n; j++) row[j] += av * right[b0 + j * bCol];
          else for (let j = 0; j < n; j++) row[j] = round(row[j] + Math.imul(av, right[b0 + j * bCol]));
        }
        const o = (b * m + i) * n;
        for (let j = 0; j < n; j++) out[o + j] = round(row[j]);
      }
  },
  // fft.ts stockhamShader: one radix-2 pass.
  'fft.stockham'(r) {
    const p = cpuUniform(r.pass_),
      n = p.getUint32(0, true),
      l = p.getUint32(4, true),
      lines = p.getUint32(8, true),
      inverse = p.getUint32(12, true) === 1,
      reIn = cpuBound(r.reIn),
      imIn = cpuBound(r.imIn),
      reOut = cpuBound(r.reOut),
      imOut = cpuBound(r.imOut),
      twiddle = cpuBound(r.twiddle),
      half = n / 2,
      stride = half / l,
      f = Math.fround;
    for (let line = 0; line < lines; line++) {
      const base = line * n;
      for (let j = 0; j < half; j++) {
        // The shader's twiddle: table entry k n / (2l), conjugated for the inverse.
        const k = j % l,
          at = twiddle.offset + 2 * k * stride,
          wr = twiddle.data[at],
          wi = inverse ? -twiddle.data[at + 1] : twiddle.data[at + 1],
          ar = reIn.data[reIn.offset + base + j],
          ai = imIn.data[imIn.offset + base + j],
          br0 = reIn.data[reIn.offset + base + j + half],
          bi0 = imIn.data[imIn.offset + base + j + half],
          br = f(f(wr * br0) - f(wi * bi0)),
          bi = f(f(wr * bi0) + f(wi * br0)),
          dest = base + 2 * j - k;
        reOut.data[reOut.offset + dest] = ar + br;
        imOut.data[imOut.offset + dest] = ai + bi;
        reOut.data[reOut.offset + dest + l] = ar - br;
        imOut.data[imOut.offset + dest + l] = ai - bi;
      }
    }
  },
  // signal.ts convolve1dShader.
  convolve(r) {
    const c = cpuUniform(r.conv),
      [n, m, length, start, lines] = [0, 4, 8, 12, 16].map((at) => c.getUint32(at, true)),
      signal = cpuBound(r.signal),
      taps = cpuBound(r.taps),
      out = cpuBound(r.out);
    for (let t = 0; t < length * lines; t++) {
      const line = Math.floor(t / length),
        k = (t % length) + start,
        first = k >= m - 1 ? k - (m - 1) : 0,
        last = Math.min(k, n - 1);
      let sum = 0;
      for (let j = first; j <= last; j++)
        sum = Math.fround(sum + signal.data[signal.offset + line * n + j] * taps.data[taps.offset + k - j]);
      out.data[out.offset + t] = sum;
    }
  },
  // signal.ts convolve2dShader (zero fill).
  convolve2d(r) {
    const c = cpuUniform(r.conv),
      [h, w, kh, kw, oh, ow, y0, x0, batch] = [0, 4, 8, 12, 16, 20, 24, 28, 32].map((at) => c.getUint32(at, true)),
      image = cpuBound(r.image),
      taps = cpuBound(r.taps),
      out = cpuBound(r.out);
    for (let t = 0; t < oh * ow * batch; t++) {
      const b = Math.floor(t / (oh * ow)),
        y = (Math.floor(t / ow) % oh) + y0,
        x = (t % ow) + x0;
      let sum = 0;
      for (let i = 0; i < kh; i++) {
        if (y < i || y - i >= h) continue;
        for (let j = 0; j < kw; j++) {
          if (x < j || x - j >= w) continue;
          sum = Math.fround(
            sum + image.data[image.offset + (b * h + y - i) * w + x - j] * taps.data[taps.offset + i * kw + j],
          );
        }
      }
      out.data[out.offset + t] = sum;
    }
  },
  // sparse.ts spmvShader: y[r] = sum of values[k] * x[colIdx[k]] over row r's entries, in f32.
  'sparse.spmv'(r) {
    const rows = cpuUniform(r.shape).getUint32(0, true),
      ptr = cpuBound(r.rowPtr),
      col = cpuBound(r.colIdx),
      val = cpuBound(r.values),
      x = cpuBound(r.x),
      y = cpuBound(r.y);
    for (let row = 0; row < rows; row++) {
      let sum = 0;
      for (let k = ptr.data[ptr.offset + row]; k < ptr.data[ptr.offset + row + 1]; k++)
        sum = Math.fround(sum + val.data[val.offset + k] * x.data[x.offset + col.data[col.offset + k]]);
      y.data[y.offset + row] = sum;
    }
  },
  // sparse.ts diagonalShader.
  'sparse.diagonal'(r) {
    const rows = cpuUniform(r.shape).getUint32(0, true),
      ptr = cpuBound(r.rowPtr),
      col = cpuBound(r.colIdx),
      val = cpuBound(r.values),
      d = cpuBound(r.d);
    for (let row = 0; row < rows; row++) {
      let v = 0;
      for (let k = ptr.data[ptr.offset + row]; k < ptr.data[ptr.offset + row + 1]; k++)
        if (col.data[col.offset + k] === row) v = Math.fround(v + val.data[val.offset + k]);
      d.data[d.offset + row] = v;
    }
  },
  // random.ts randomShader: element i takes word i % 4 of the Philox block of counter (offset + i / 4, ...).
  random(r) {
    const d = cpuUniform(r.draw),
      [n, offset, offsetHigh, kind, key0, key1, stream, range] = [0, 4, 8, 12, 16, 20, 24, 28].map((at) =>
        d.getUint32(at, true),
      ),
      a = d.getFloat32(32, true),
      b = d.getFloat32(36, true),
      base = d.getInt32(40, true),
      target = r.out as GpuArray,
      out = cpuView(target),
      f = Math.fround,
      word = new Uint32Array(4),
      unit = (x: number) => f((x >>> 8) * 5.9604644775390625e-8),
      tau = f(6.283185307179586);
    for (let i = 0; i < n; i++) {
      const lane = i & 3;
      if (lane === 0) {
        const block = Math.floor(i / 4),
          low = (offset + block) >>> 0,
          high = (offsetHigh + (low < offset ? 1 : 0)) >>> 0;
        philox(low, high, stream, 0, key0, key1, word);
      }
      const value = word[lane];
      if (kind === 1) out[i] = f(a + f(f(b - a) * unit(value)));
      else if (kind === 2) {
        const pair = lane & 2,
          u1 = f(((word[pair] >>> 8) + 1) * 5.9604644775390625e-8),
          u2 = unit(word[pair + 1]),
          radius = f(Math.sqrt(f(-2 * f(Math.log(u1))))),
          angle = f(tau * u2),
          z = f(radius * f(lane & 1 ? Math.sin(angle) : Math.cos(angle)));
        out[i] = f(a + f(b * z));
      } else if (kind === 3) out[i] = (base + (mulhi(value, range) | 0)) | 0;
      else out[i] = value;
    }
  },
};

// --- The context ---------------------------------------------------------------------------------------------------

/**
 * A compute context that runs on the CPU (see {@link createCompute}'s `backend`). Same API as the WebGPU context;
 * your own WGSL (`kernel`, `map`, custom reduce and scan operators) throws a MargoError (`unsupported`).
 */
export class CpuContext extends ComputeContext {
  /** @internal Use `createCompute({ backend: 'cpu' })`. */
  constructor(runtime?: CpuRuntime) {
    super(hostDevice(), false);
    if (runtime) runtimes.set(this, runtime);
  }

  override dispose(): void {
    runtimes.get(this)?.dispose();
    runtimes.delete(this);
    super.dispose();
  }

  /** `'cpu'`: work runs in JavaScript on the calling thread. */
  override get backend(): 'webgpu' | 'cpu' {
    return 'cpu';
  }

  /** @internal */
  override allocate(size: number, _usage: number, dtype: DType): GPUBuffer {
    return new HostBuffer(size, dtype) as unknown as GPUBuffer;
  }

  /** @internal Programs are not compiled on the CPU: the label picks a host kernel. */
  override program(code: string, entryPoint?: string, label?: string): Program {
    return { label: label ?? entryPoint ?? 'main', code } as unknown as Program;
  }

  /** @internal Runs each pass's host kernel, then the copies. */
  override submit(passes: readonly Pass[], copies: readonly Copy[] = []): void {
    this.check();
    for (const pass of passes) {
      const runtime = runtimes.get(this);
      if (runtime) {
        runtime.kernel(pass.program.label, pass.resources);
        continue;
      }
      const kernel = KERNELS[pass.program.label];
      if (!kernel) throw gpuOnly(`The ${pass.program.label} pass`);
      kernel(pass.resources);
    }
    for (const [src, srcOffset, dst, dstOffset, size] of copies)
      if (size) new Uint8Array(host(dst).bytes).set(new Uint8Array(host(src).bytes, srcOffset, size), dstOffset);
  }

  /** @internal */
  override async readBytes(
    buffer: GPUBuffer,
    offset: number,
    size: number,
    signal?: AbortSignal,
  ): Promise<ArrayBuffer> {
    this.check();
    aborted(signal);
    return host(buffer).bytes.slice(offset, offset + size);
  }

  /** Resolves at once: CPU work is done when the call returns. */
  override async done(options: WaitOptions = {}): Promise<void> {
    this.check();
    aborted(options.signal);
  }

  /** Runs `work` and resolves an empty list: there are no GPU passes to time. */
  override async profile(work: () => unknown, options: WaitOptions = {}): Promise<PassTiming[]> {
    this.check();
    await work();
    aborted(options.signal);
    return [];
  }

  /** Throws a MargoError (`unsupported`): WGSL kernels need a GPU. */
  override kernel(_code: string, _options?: { readonly entryPoint?: string; readonly label?: string }): Kernel {
    throw gpuOnly('gpu.kernel');
  }

  /** Throws a MargoError (`unsupported`): `map` runs a WGSL expression; use the element-wise methods. */
  override map<T extends DType = DType>(
    _inputs: Operand | Readonly<Record<string, Operand>>,
    _expression: string,
    _options?: { readonly dtype?: T; readonly label?: string },
  ): GpuArray<T> {
    throw gpuOnly('gpu.map');
  }

  /** A u32 array of three workgroup counts (only meaningful to WGSL kernels, which need a GPU). */
  override indirectArgs(workgroups: readonly [number, number, number] = [0, 1, 1]): GpuArray<'u32'> {
    return this.empty([3], 'u32').write(workgroups);
  }

  /** An array (drawing from it needs an engine, which needs a GPU). */
  override drawable<T extends DType = 'f32'>(shape: number | readonly number[], dtype?: T): GpuArray<T> {
    return this.zeros(shape, dtype);
  }

  /** @internal An array of `shape` holding `data` (exact values of `dtype`). */
  #result<T extends DType>(shape: readonly number[], dtype: T, data: ArrayLike<number>): GpuArray<T> {
    const out = this.empty(shape, dtype);
    if (data.length) cpuView(out).set(data);
    return out;
  }

  /** @internal Interprets the expression into a new contiguous array. */
  override evaluate(operand: Operand): GpuArray {
    this.check();
    return this.#result(operand.shape, operand.dtype, values(operand));
  }

  override reduce(input: Operand, op: Operator = 'sum', options: AxisOptions = {}): GpuArray {
    this.check();
    if (!(input instanceof Operand)) throw typeError('Reductions take a GpuArray or an Expr', 'compute');
    if (typeof op === 'string' && !['sum', 'product', 'min', 'max'].includes(op))
      throw typeError(`Unknown reduce op ${op}; use sum, product, min, max or { combine, identity }`, 'compute');
    const fold = foldOf(op, input.dtype, 'reduce'),
      axes = axesOf(options.axis, input.ndim),
      shape = shapeAfter(input.shape, axes, !!options.keepdims),
      data = values(input),
      acc = new Float64Array(sizeOf(shape)).fill(fold.identity);
    const runtime = runtimes.get(this);
    if (runtime)
      return this.#result(
        shape,
        input.dtype,
        runtime.run('reduce', [data, input.shape, axes], [typeCode(input.dtype), foldCode(op), acc.length])[0],
      );
    if (axes.length === input.ndim) {
      let a = fold.identity;
      for (let i = 0; i < data.length; i++) a = fold.combine(a, data[i]);
      acc[0] = a;
    } else {
      const to = outputIndex(input.shape, axes);
      for (let i = 0; i < data.length; i++) acc[to[i]] = fold.combine(acc[to[i]], data[i]);
    }
    for (let i = 0; i < acc.length; i++) acc[i] = fold.finish(acc[i]);
    return this.#result(shape, input.dtype, acc);
  }
  override sum(input: Operand, options?: AxisOptions): GpuArray {
    return this.reduce(input, 'sum', options);
  }
  override prod(input: Operand, options?: AxisOptions): GpuArray {
    return this.reduce(input, 'product', options);
  }
  override min(input: Operand, options?: AxisOptions): GpuArray {
    return this.reduce(input, 'min', options);
  }
  override max(input: Operand, options?: AxisOptions): GpuArray {
    return this.reduce(input, 'max', options);
  }
  override mean(input: Operand, options: AxisOptions = {}): GpuArray {
    const n = axesOf(options.axis, input.ndim).reduce((c, a) => c * input.shape[a], 1),
      sum = this.reduce(input.dtype === 'f32' ? input : input.astype('f32'), 'sum', options);
    return this.#scaled(sum, n ? 1 / n : NaN);
  }
  #scaled(sum: GpuArray, factor: number): GpuArray {
    const out = sum.mul(factor).eval();
    sum.dispose();
    return out;
  }
  override var(input: Operand, options: AxisOptions & { readonly ddof?: number } = {}): GpuArray {
    const ddof = options.ddof ?? 0;
    if (!Number.isFinite(ddof) || ddof < 0)
      throw rangeError(`ddof must be a number of at least 0, got ${ddof}`, 'compute');
    const x = input.dtype === 'f32' ? input : input.astype('f32'),
      m = this.mean(x, { axis: options.axis, keepdims: true }),
      n = axesOf(options.axis, input.ndim).reduce((c, a) => c * input.shape[a], 1),
      sum = this.reduce(x.sub(m).square(), 'sum', options);
    m.dispose();
    return this.#scaled(sum, n - ddof > 0 ? 1 / (n - ddof) : NaN);
  }
  override std(input: Operand, options: AxisOptions & { readonly ddof?: number } = {}): GpuArray {
    const v = this.var(input, options),
      out = v.sqrt().eval();
    v.dispose();
    return out;
  }
  override argmin(input: Operand, options?: { readonly axis?: number; readonly keepdims?: boolean }): GpuArray<'u32'> {
    return this.#arg(input, 'min', options);
  }
  override argmax(input: Operand, options?: { readonly axis?: number; readonly keepdims?: boolean }): GpuArray<'u32'> {
    return this.#arg(input, 'max', options);
  }
  #arg(
    input: Operand,
    which: 'min' | 'max',
    options: { readonly axis?: number; readonly keepdims?: boolean } = {},
  ): GpuArray<'u32'> {
    this.check();
    if (!(input instanceof Operand)) throw typeError(`arg${which} takes a GpuArray or an Expr`, 'compute');
    if (input.size === 0) throw rangeError(`arg${which} of an empty array has no answer`, 'compute');
    const data = values(input),
      better = which === 'min' ? (v: number, b: number) => v < b : (v: number, b: number) => v > b;
    const runtime = runtimes.get(this);
    if (runtime) {
      const axis = options.axis === undefined ? undefined : axisOf(options.axis, input.ndim);
      const len = axis === undefined ? data.length : input.shape[axis];
      const inner = axis === undefined ? 1 : sizeOf(input.shape.slice(axis + 1));
      return this.#result(
        axis === undefined
          ? options.keepdims
            ? input.shape.map(() => 1)
            : []
          : shapeAfter(input.shape, [axis], !!options.keepdims),
        'u32',
        runtime.run('arg', [data], [len, inner, which === 'max' ? 1 : 0])[0],
      );
    }
    if (options.axis === undefined) {
      let best = 0;
      for (let i = 1; i < data.length; i++) if (better(data[i], data[best])) best = i;
      return this.#result(options.keepdims ? input.shape.map(() => 1) : [], 'u32', [best]);
    }
    const axis = axisOf(options.axis, input.ndim),
      len = input.shape[axis],
      inner = sizeOf(input.shape.slice(axis + 1)),
      outer = data.length / (len * inner),
      out = new Uint32Array(outer * inner);
    for (let o = 0; o < outer; o++)
      for (let j = 0; j < inner; j++) {
        let best = 0;
        for (let k = 1; k < len; k++)
          if (better(data[(o * len + k) * inner + j], data[(o * len + best) * inner + j])) best = k;
        out[o * inner + j] = best;
      }
    return this.#result(shapeAfter(input.shape, [axis], !!options.keepdims), 'u32', out);
  }
  override all(input: Operand, options?: AxisOptions): GpuArray {
    return this.reduce(input.ne(0), 'min', options);
  }
  override any(input: Operand, options?: AxisOptions): GpuArray {
    return this.reduce(input.ne(0), 'max', options);
  }
  override countNonzero(input: Operand, options?: AxisOptions): GpuArray {
    return this.reduce(input.ne(0), 'sum', options);
  }
  override nansum(input: Operand, options?: AxisOptions): GpuArray {
    return this.reduce(where(input.isnan(), 0, input), 'sum', options);
  }
  override nanmin(input: Operand, options?: AxisOptions): GpuArray {
    return this.reduce(where(input.isnan(), Infinity, input), 'min', options);
  }
  override nanmax(input: Operand, options?: AxisOptions): GpuArray {
    return this.reduce(where(input.isnan(), -Infinity, input), 'max', options);
  }
  override nanmean(input: Operand, options: AxisOptions = {}): GpuArray {
    const x = input.dtype === 'f32' ? input : input.astype('f32'),
      sum = this.reduce(where(x.isnan(), 0, x), 'sum', options),
      count = this.reduce(x.isnan().not(), 'sum', options),
      out = sum.div(count).eval();
    sum.dispose();
    count.dispose();
    return out;
  }

  override scan(input: Operand, options: ScanOptions = {}): GpuArray {
    this.check();
    if (!(input instanceof Operand)) throw typeError('scan takes a GpuArray or an Expr', 'compute');
    const fold = foldOf(options.op ?? 'sum', input.dtype, 'scan'),
      exclusive = !!options.exclusive,
      data = values(input),
      n = data.length,
      out = new Float64Array(n);
    const runtime = runtimes.get(this);
    if (runtime) {
      const axis = options.axis === undefined || input.ndim <= 1 ? undefined : axisOf(options.axis, input.ndim);
      const len = axis === undefined ? n : input.shape[axis];
      const inner = axis === undefined ? 1 : sizeOf(input.shape.slice(axis + 1));
      return this.#result(
        options.axis === undefined ? [n] : input.shape,
        input.dtype,
        runtime.run('scan', [data], [typeCode(input.dtype), foldCode(options.op ?? 'sum'), len, inner, +exclusive])[0],
      );
    }
    const line = (start: number, len: number, step: number) => {
      let acc = fold.identity;
      for (let k = 0; k < len; k++) {
        const at = start + k * step;
        if (exclusive) {
          out[at] = fold.finish(acc);
          acc = fold.combine(acc, data[at]);
        } else {
          acc = fold.combine(acc, data[at]);
          out[at] = fold.finish(acc);
        }
      }
    };
    if (options.axis === undefined || input.ndim <= 1) {
      if (n) line(0, n, 1);
      return this.#result(options.axis === undefined ? [n] : input.shape, input.dtype, out);
    }
    const axis = axisOf(options.axis, input.ndim),
      len = input.shape[axis],
      inner = sizeOf(input.shape.slice(axis + 1)),
      outer = len * inner ? n / (len * inner) : 0;
    for (let o = 0; o < outer; o++) for (let j = 0; j < inner; j++) line(o * len * inner + j, len, inner);
    return this.#result(input.shape, input.dtype, out);
  }
  override cumsum(input: Operand, options: { readonly axis?: number } = {}): GpuArray {
    return this.scan(input, options);
  }
  override cumprod(input: Operand, options: { readonly axis?: number } = {}): GpuArray {
    return this.scan(input, { ...options, op: 'product' });
  }
  override segmentedScan(values_: Operand, flags: Operand, options: Omit<ScanOptions, 'axis'> = {}): GpuArray {
    this.check();
    if (!(values_ instanceof Operand) || !(flags instanceof Operand))
      throw typeError('segmentedScan takes values and flags as GpuArrays or Exprs', 'compute');
    if (values_.size !== flags.size)
      throw typeError(`segmentedScan values (${values_.size}) and flags (${flags.size}) differ in size`, 'compute');
    const fold = foldOf(options.op ?? 'sum', values_.dtype, 'segmentedScan'),
      data = values(values_),
      starts = values(flags),
      out = new Float64Array(data.length);
    const runtime = runtimes.get(this);
    if (runtime)
      return this.#result(
        [data.length],
        values_.dtype,
        runtime.run(
          'segmented',
          [data, starts],
          [typeCode(values_.dtype), foldCode(options.op ?? 'sum'), +!!options.exclusive],
        )[0],
      );
    let acc = fold.identity;
    for (let i = 0; i < data.length; i++) {
      if (starts[i] !== 0) acc = fold.identity;
      if (options.exclusive) {
        out[i] = fold.finish(acc);
        acc = fold.combine(acc, data[i]);
      } else {
        acc = fold.combine(acc, data[i]);
        out[i] = fold.finish(acc);
      }
    }
    return this.#result([data.length], values_.dtype, out);
  }
  override async reduceByKey(
    keys: Operand,
    values_: Operand,
    options: { readonly op?: Operator } & WaitOptions = {},
  ): Promise<{ keys: GpuArray; values: GpuArray }> {
    this.check();
    aborted(options.signal);
    if (keys.size !== values_.size)
      throw typeError(`reduceByKey keys (${keys.size}) and values (${values_.size}) differ in size`, 'compute');
    const fold = foldOf(options.op ?? 'sum', values_.dtype, 'reduceByKey'),
      k = values(keys),
      v = values(values_),
      outKeys: number[] = [],
      outValues: number[] = [];
    const runtime = runtimes.get(this);
    if (runtime) {
      const [rk, rv] = runtime.run('group', [k, v], [typeCode(values_.dtype), foldCode(options.op ?? 'sum')]);
      return { keys: this.#result([rk.length], keys.dtype, rk), values: this.#result([rv.length], values_.dtype, rv) };
    }
    for (let i = 0; i < k.length; i++) {
      if (i === 0 || k[i] !== k[i - 1]) {
        outKeys.push(k[i]);
        outValues.push(fold.identity);
      }
      outValues[outValues.length - 1] = fold.combine(outValues[outValues.length - 1], v[i]);
    }
    return {
      keys: this.#result([outKeys.length], keys.dtype, outKeys),
      values: this.#result([outValues.length], values_.dtype, outValues.map(fold.finish)),
    };
  }

  // The sorting permutation of the flat elements (sort.ts: keys inverted for descending, low `bits` only).
  #order(input: Operand, options: SortOptions): { data: Values; order: Uint32Array } {
    this.check();
    if (!(input instanceof Operand)) throw typeError('sort takes a GpuArray or an Expr', 'compute');
    const bits = options.bits ?? 32;
    if (!Number.isInteger(bits) || bits < 1 || bits > 32)
      throw rangeError(`Sort bits must be a whole number from 1 to 32, got ${bits}`, 'compute');
    if (bits < 32 && input.dtype !== 'u32')
      throw rangeError('Sort bits below 32 apply to u32 keys only; drop bits for other types', 'compute');
    const used = Math.min(32, Math.ceil(bits / 4) * 4),
      mask = used === 32 ? 0xffffffff : (1 << used) - 1,
      key = keyOf(input.dtype),
      data = values(input),
      keys = new Uint32Array(data.length);
    const runtime = runtimes.get(this);
    if (runtime)
      return {
        data,
        order: Uint32Array.from(runtime.run('order', [data], [typeCode(input.dtype), used, +!!options.descending])[0]),
      };
    for (let i = 0; i < data.length; i++) {
      const k = options.descending ? ~key(data[i]) : key(data[i]);
      keys[i] = (k & mask) >>> 0;
    }
    return { data, order: radixOrder(keys, used) };
  }
  override sort(input: Operand, options: SortOptions = {}): GpuArray {
    const { data, order } = this.#order(input, options),
      out = new Float64Array(data.length);
    const runtime = runtimes.get(this);
    if (runtime) return this.#result([data.length], input.dtype, runtime.run('gather', [data, order])[0]);
    for (let i = 0; i < out.length; i++) out[i] = data[order[i]];
    return this.#result([out.length], input.dtype, out);
  }
  override argsort(input: Operand, options: SortOptions = {}): GpuArray<'u32'> {
    const { order } = this.#order(input, options);
    return this.#result([order.length], 'u32', order);
  }
  override sortByKey(
    keys: Operand,
    values_: Operand,
    options: SortOptions = {},
  ): { readonly keys: GpuArray; readonly values: GpuArray } {
    if (!(values_ instanceof Operand) || values_.size !== keys.size)
      throw typeError(`sortByKey needs values of the keys' size (${keys.size})`, 'compute');
    const { data, order } = this.#order(keys, options),
      v = values(values_),
      k = new Float64Array(order.length),
      w = new Float64Array(order.length);
    const runtime = runtimes.get(this);
    if (runtime)
      return {
        keys: this.#result([order.length], keys.dtype, runtime.run('gather', [data, order])[0]),
        values: this.#result([order.length], values_.dtype, runtime.run('gather', [v, order])[0]),
      };
    for (let i = 0; i < order.length; i++) {
      k[i] = data[order[i]];
      w[i] = v[order[i]];
    }
    return { keys: this.#result([k.length], keys.dtype, k), values: this.#result([w.length], values_.dtype, w) };
  }
  override topk(
    input: Operand,
    k: number,
    options: { readonly largest?: boolean } = {},
  ): { readonly values: GpuArray; readonly indices: GpuArray<'u32'> } {
    if (!Number.isInteger(k) || k < 0 || k > input.size)
      throw rangeError(`topk k must be a whole number from 0 to ${input.size}, got ${k}`, 'compute');
    const { data, order } = this.#order(input, { descending: options.largest ?? true }),
      head = order.slice(0, k);
    return {
      values: this.#result(
        [k],
        input.dtype,
        runtimes.get(this)?.run('gather', [data, head])[0] ?? Array.from(head, (i) => data[i]),
      ),
      indices: this.#result([k], 'u32', head),
    };
  }
  override quantile(input: Operand, q: number | readonly number[]): GpuArray<'f32'> {
    const list = typeof q === 'number' ? [q] : [...q];
    for (const v of list) if (!(v >= 0 && v <= 1)) throw rangeError(`Quantiles must be in [0, 1], got ${v}`, 'compute');
    const n = input.size;
    if (n === 0) throw rangeError('quantile of an empty array has no answer', 'compute');
    const sorted = this.sort(input),
      s = values(sorted.astype('f32')),
      f = Math.fround;
    sorted.dispose();
    // NumPy's linear method in f32, as sort.ts computes it on the GPU.
    const runtime = runtimes.get(this);
    if (runtime)
      return this.#result(typeof q === 'number' ? [] : [list.length], 'f32', runtime.run('quantile', [s, list])[0]);
    const out = list.map((v) => {
      const lower = Math.floor(v * (n - 1)),
        upper = Math.min(lower + 1, n - 1),
        w = f(v * (n - 1) - lower);
      return f(s[lower] + f(f(s[upper] - s[lower]) * w));
    });
    return this.#result(typeof q === 'number' ? [] : [out.length], 'f32', out);
  }
  override median(input: Operand): GpuArray<'f32'> {
    return this.quantile(input, 0.5);
  }
  override async unique(
    input: Operand,
    options: { readonly counts?: boolean } & WaitOptions = {},
  ): Promise<{ values: GpuArray; counts?: GpuArray<'u32'> }> {
    aborted(options.signal);
    const sorted = this.sort(input),
      s = values(sorted),
      distinct: number[] = [],
      counts: number[] = [];
    sorted.dispose();
    const runtime = runtimes.get(this);
    if (runtime) {
      const [v, c] = runtime.run('unique', [s]);
      return options.counts
        ? { values: this.#result([v.length], input.dtype, v), counts: this.#result([c.length], 'u32', c) }
        : { values: this.#result([v.length], input.dtype, v) };
    }
    for (let i = 0; i < s.length; i++) {
      if (i === 0 || s[i] !== s[i - 1]) {
        distinct.push(s[i]);
        counts.push(0);
      }
      counts[counts.length - 1]++;
    }
    const out = this.#result([distinct.length], input.dtype, distinct);
    return options.counts ? { values: out, counts: this.#result([counts.length], 'u32', counts) } : { values: out };
  }

  override take(input: Operand, indices: Operand, options: TakeOptions = {}): GpuArray {
    this.check();
    if (!(input instanceof Operand)) throw typeError('take reads a GpuArray or an Expr', 'compute');
    const idx = integersOnly(indices),
      mode = options.mode ?? 'clip';
    if (mode !== 'clip' && mode !== 'wrap')
      throw typeError(`take mode must be 'clip' or 'wrap', got ${String(mode)}`, 'compute');
    const axis = options.axis === undefined ? undefined : axisOf(options.axis, input.ndim),
      len = axis === undefined ? input.size : input.shape[axis],
      inner = axis === undefined ? 1 : sizeOf(input.shape.slice(axis + 1)),
      shape =
        axis === undefined
          ? indices.shape
          : [...input.shape.slice(0, axis), ...indices.shape, ...input.shape.slice(axis + 1)],
      n = sizeOf(shape);
    if (n > 0 && len === 0) throw rangeError('take from an empty axis has nothing to take', 'compute');
    const data = n ? values(input) : new Float64Array(0),
      count = Math.max(1, idx.length),
      out = new Float64Array(n);
    const runtime = runtimes.get(this);
    if (runtime)
      return this.#result(shape, input.dtype, runtime.run('take', [data, idx], [len, inner, n, +(mode === 'wrap')])[0]);
    for (let o = 0; o < n; o++) {
      const j = o % inner,
        p = Math.floor(o / inner) % count,
        outer = Math.floor(o / (inner * count));
      let k = idx[p];
      if (k < 0) k += len;
      k = mode === 'wrap' ? ((k % len) + len) % len : Math.min(Math.max(k, 0), len - 1);
      out[o] = data[(outer * len + k) * inner + j];
    }
    return this.#result(shape, input.dtype, out);
  }
  override scatter<T extends DType>(
    target: GpuArray<T>,
    indices: Operand,
    values_: OperandLike,
    options: { readonly op?: 'set' | 'add' | 'min' | 'max' } = {},
  ): GpuArray<T> {
    this.check();
    target.check(this);
    if (!target.contiguous || target.offset)
      throw typeError('scatter needs a contiguous target; scatter into the array the view came from', 'compute');
    const op = options.op ?? 'set';
    if (!['set', 'add', 'min', 'max'].includes(op))
      throw typeError(`scatter op must be set, add, min or max, got ${op}`, 'compute');
    const idx = integersOnly(indices),
      n = idx.length,
      scalar = typeof values_ === 'number';
    if (!scalar && !(values_ instanceof Operand))
      throw typeError('scatter values must be a number, a GpuArray or an Expr', 'compute');
    if (!scalar && values_.size !== n && values_.size !== 1)
      throw rangeError(
        `scatter has ${n} indices but ${values_.size} values; pass one value or one per index`,
        'compute',
      );
    if (n === 0) return target;
    const t = target.dtype,
      v = scalar ? new Float64Array([ROUND[t](values_ as number)]) : values((values_ as Operand).astype(t)),
      out = cpuView(target),
      len = target.size,
      r = ROUND[t],
      combine =
        op === 'add'
          ? (a: number, b: number) => r(a + b)
          : op === 'min'
            ? (a: number, b: number) => Math.min(a, b)
            : op === 'max'
              ? (a: number, b: number) => Math.max(a, b)
              : (_a: number, b: number) => b;
    const runtime = runtimes.get(this);
    if (runtime) {
      out.set(runtime.run('scatter', [out, idx, v], [typeCode(t), ['set', 'add', 'min', 'max'].indexOf(op)])[0]);
      return target;
    }
    for (let i = 0; i < n; i++) {
      let k = idx[i];
      if (k < 0) k += len;
      if (k < 0 || k >= len) continue;
      out[k] = combine(out[k], v[v.length === 1 ? 0 : i]);
    }
    return target;
  }
  override bincount(input: Operand, options: { readonly weights?: Operand; readonly length: number }): GpuArray {
    const length = options?.length;
    if (!Number.isInteger(length) || length < 0)
      throw rangeError(
        'bincount needs length (the number of bins, one past the largest value) as a whole number',
        'compute',
      );
    const out = this.zeros([length], options.weights ? 'f32' : 'u32');
    return this.scatter(out, input, options.weights ?? 1, { op: 'add' });
  }
  override compact(input: Operand, mask: Operand): { readonly values: GpuArray; readonly count: GpuArray<'u32'> } {
    this.check();
    if (!(input instanceof Operand) || !(mask instanceof Operand))
      throw typeError('compact takes an input and a mask (GpuArrays or Exprs)', 'compute');
    if (input.size !== mask.size)
      throw rangeError(`compact input (${input.size}) and mask (${mask.size}) differ in size`, 'compute');
    const data = values(input),
      keep = values(mask),
      out = new Float64Array(data.length);
    const runtime = runtimes.get(this);
    if (runtime) {
      const [packed, count] = runtime.run('compact', [data, keep]);
      return { values: this.#result([data.length], input.dtype, packed), count: this.#result([1], 'u32', count) };
    }
    let count = 0;
    for (let i = 0; i < data.length; i++) if (keep[i] !== 0) out[count++] = data[i];
    return { values: this.#result([data.length], input.dtype, out), count: this.#result([1], 'u32', [count]) };
  }
  override async filter(input: Operand, mask: Operand, options: WaitOptions = {}): Promise<GpuArray> {
    aborted(options.signal);
    const { values: packed, count } = this.compact(input, mask),
      n = cpuView(count)[0],
      out = this.#result([n], input.dtype, cpuView(packed).subarray(0, n));
    packed.dispose();
    count.dispose();
    return out;
  }
  override async nonzero(input: Operand, options: WaitOptions = {}): Promise<GpuArray<'u32'>> {
    aborted(options.signal);
    const data = values(input),
      out: number[] = [];
    for (let i = 0; i < data.length; i++) if (data[i] !== 0) out.push(i);
    return this.#result([out.length], 'u32', out);
  }

  override histogram(input: Operand, options: HistogramOptions = {}): Histogram {
    this.check();
    if (!(input instanceof Operand)) throw typeError('histogram takes a GpuArray or an Expr', 'compute');
    const n = input.size,
      bins = options.bins ?? 64,
      f = Math.fround;
    if (!Number.isInteger(bins) || bins < 1)
      throw rangeError(`Histogram bins must be a whole number of at least 1, got ${bins}`, 'compute');
    const given = options.range;
    if (given) {
      const [lo, hi] = given;
      if (!Number.isFinite(lo) || !Number.isFinite(hi) || lo > hi)
        throw rangeError(`Histogram range must be finite [min, max] with min <= max, got [${lo}, ${hi}]`, 'compute');
    }
    const data = values(input.dtype === 'f32' ? input : input.astype('f32'));
    const runtime = runtimes.get(this);
    if (runtime) {
      const [counts, edges] = runtime.run('histogram', [data], [bins, given ? 1 : 0, given?.[0] ?? 0, given?.[1] ?? 1]);
      return { counts: this.#result([bins], 'u32', counts), edges: this.#result([bins + 1], 'f32', edges) };
    }
    // histogram.ts on the GPU: the range in f32 (the data's own min and max when not given), widened by 0.5 each
    // side when empty, then bin = min(u32((x - lo) * bins / (hi - lo)), bins - 1) for lo <= x <= hi.
    let lo = given ? f(given[0]) : n ? Infinity : 0,
      hi = given ? f(given[1]) : n ? -Infinity : 1;
    if (!given)
      for (let i = 0; i < n; i++) {
        if (data[i] < lo) lo = data[i];
        if (data[i] > hi) hi = data[i];
      }
    if (lo === hi) {
      lo = f(lo - 0.5);
      hi = f(hi + 0.5);
    }
    const scale = f(bins / f(hi - lo)),
      counts = new Uint32Array(bins),
      edges = new Float32Array(bins + 1);
    for (let i = 0; i < n; i++) {
      const x = data[i];
      if (x >= lo && x <= hi) counts[Math.min(Math.trunc(f(f(x - lo) * scale)), bins - 1)]++;
    }
    for (let i = 0; i <= bins; i++) edges[i] = f(lo + f(f(f(hi - lo) * i) / bins));
    return { counts: this.#result([bins], 'u32', counts), edges: this.#result([bins + 1], 'f32', edges) };
  }
}

/** Makes the CPU context (createCompute's fallback). */
export const cpuContext = (): ComputeContext => new CpuContext();
