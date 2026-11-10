// One optional, lazy SIMD Wasm implementation on every backend. GPU inputs are
// read in logical C order; results return to the input context as owned arrays.
import { fault, rangeError, typeError } from '../../shared/errors.js';
import { Operand, broadcastShapes } from './expr.js';
import type { GpuArray } from './array.js';
import { aborted, type WaitOptions } from './context.js';

/** Dense decomposition options. Every wait observes signal. */
export interface DecompOptions extends WaitOptions {
  /** Full orthogonal factors for QR/SVD. Default false (reduced factors). */
  readonly fullMatrices?: boolean;
  /** Maximum cyclic Jacobi sweeps for SVD/eigh. Default 100; range 1..1000. */
  readonly maxSweeps?: number;
}
/** A = Q R. Q has orthonormal columns; R is upper trapezoidal. */
export interface QRResult {
  readonly q: GpuArray<'f32'>;
  readonly r: GpuArray<'f32'>;
}
/** A = U diag(s) Vh. Singular values are nonnegative and descending. */
export interface SVDResult {
  readonly u: GpuArray<'f32'>;
  readonly s: GpuArray<'f32'>;
  readonly vh: GpuArray<'f32'>;
}
/** A V = V diag(values). Eigenvalues ascend; vectors are columns. */
export interface EigenResult {
  readonly values: GpuArray<'f32'>;
  readonly vectors: GpuArray<'f32'>;
}
interface Kernel {
  readonly memory: WebAssembly.Memory;
  reserve(n: number): number;
  release(): void;
  run(op: number, m: number, n: number, rhs: number, full: number, sweeps: number): number;
}
async function load(signal?: AbortSignal): Promise<Kernel> {
  aborted(signal);
  const url = new URL(/* @vite-ignore */ './decomp-kernel.wasm?no-inline', import.meta.url);
  let bytes: Uint8Array<ArrayBuffer>;
  if (url.protocol === 'file:') {
    url.search = '';
    const name = 'node:fs/promises';
    const fs = await import(/* @vite-ignore */ /* webpackIgnore: true */ name);
    bytes = await fs.readFile(url, { signal });
  } else {
    const response = await fetch(url, { signal });
    if (!response.ok) throw fault('failed', `Decomposition Wasm load failed: HTTP ${response.status}`, 'compute');
    bytes = new Uint8Array(await response.arrayBuffer());
  }
  aborted(signal);
  const { instance } = await WebAssembly.instantiate(bytes);
  aborted(signal);
  return instance.exports as unknown as Kernel;
}
const size = (s: readonly number[]): number => s.reduce((a, b) => a * b, 1);
function validate(a: Operand): void {
  if (!(a instanceof Operand) || a.ndim < 2) throw typeError('decomp needs an array [..., rows, columns]', 'compute');
  a.context.check();
  if (a.shape.at(-1)! > 4096 || a.shape.at(-2)! > 4096)
    throw rangeError('decomp matrix dimensions are limited to 4096', 'compute');
}
// Flat batch index mapped to an operand with broadcast leading dimensions.
function batchIndex(index: number, batch: readonly number[], own: readonly number[]): number {
  let out = 0,
    stride = 1;
  for (let d = batch.length - 1; d >= 0; d--) {
    const coordinate = index % batch[d];
    index = Math.floor(index / batch[d]);
    const dim = own[d - batch.length + own.length] ?? 1;
    if (dim !== 1) out += coordinate * stride;
    stride *= dim;
  }
  return out;
}
async function decompose(a: Operand, op: number, options: DecompOptions, b?: Operand): Promise<GpuArray<'f32'>[]> {
  aborted(options.signal);
  validate(a);
  if (op === 0 && !(b instanceof Operand))
    throw typeError('solve needs a compute array or expression as its RHS', 'compute');
  const ctx = a.context,
    m = a.shape.at(-2)!,
    n = a.shape.at(-1)!,
    k = Math.min(m, n);
  if ((op <= 3 || op === 6) && m !== n)
    throw rangeError('solve, inv, det, cholesky and eigh need square matrices', 'compute');
  const full = options.fullMatrices ?? false,
    sweeps = options.maxSweeps ?? 100;
  if (typeof full !== 'boolean' || !Number.isInteger(sweeps) || sweeps < 1 || sweeps > 1000)
    throw rangeError('fullMatrices must be boolean; maxSweeps must be an integer in 1..1000', 'compute');
  let batch = [...a.shape.slice(0, -2)],
    rhs = 0,
    vector = false;
  if (b) {
    if (!(b instanceof Operand) || b.context !== ctx || b.ndim === 0)
      throw typeError('solve operands must share a context; b needs at least one dimension', 'compute');
    // NumPy 2 rule: only a 1-D RHS is a vector. Higher ranks are matrix stacks.
    vector = b.ndim === 1;
    rhs = vector ? 1 : b.shape.at(-1)!;
    if ((vector ? b.shape[0] : b.shape.at(-2)) !== n) throw rangeError('solve RHS rows must match A', 'compute');
    batch = broadcastShapes(batch, vector ? [] : b.shape.slice(0, -2));
  }
  const qcols = full ? m : k,
    ucols = full ? m : k,
    vrows = full ? n : k;
  const shapes =
    op === 0
      ? [vector ? [n] : [n, rhs]]
      : op === 1 || op === 3
        ? [[n, n]]
        : op === 2
          ? [[]]
          : op === 4
            ? [
                [m, qcols],
                [qcols, n],
              ]
            : op === 5
              ? [[m, ucols], [k], [vrows, n]]
              : [[n], [n, n]];
  const lengths = shapes.map(size),
    output = lengths.reduce((x, y) => x + y, 0),
    count = size(batch);
  if (rhs > 4096 || m * n * 8 + m * m * 2 + n * n * 2 + n * rhs * 2 > 16_777_216 || count * output > 16_777_216)
    throw rangeError(
      'decomp exceeds its 16,777,216-element workspace/output limit (8mn + 2m^2 + 2n^2 + 2n rhs per matrix: square ' +
        'matrices up to 1182); use smaller blocks or the sparse solvers in @margoengine/compute/sparse',
      'compute',
    );
  const [av, bv, kernel] = await Promise.all([
    a.read({ signal: options.signal }),
    b?.read({ signal: options.signal }),
    load(options.signal),
  ]);
  const input = Float64Array.from(av),
    right = bv ? Float64Array.from(bv) : undefined;
  const results = lengths.map((len) => new Float32Array(count * len));
  try {
    for (let i = 0; i < count && output > 0; i++) {
      if (i > 0 && i % 16 === 0) await new Promise<void>((resolve) => setTimeout(resolve, 0));
      aborted(options.signal);
      ctx.check();
      const an = m * n,
        bn = op === 0 ? n * rhs : 0,
        pointer = kernel.reserve(an + bn + output);
      if (!pointer) throw rangeError('decomp workspace allocation rejected', 'compute');
      let arena = new Float64Array(kernel.memory.buffer, pointer, an + bn + output);
      const ai = batchIndex(i, batch, a.shape.slice(0, -2)) * an;
      arena.set(input.subarray(ai, ai + an));
      if (right && b) {
        const bi = batchIndex(i, batch, vector ? [] : b.shape.slice(0, -2)) * bn;
        arena.set(right.subarray(bi, bi + bn), an);
      }
      const status = kernel.run(op, m, n, rhs, Number(full), sweeps);
      if (status) {
        const reasons = [
          '',
          'workspace limit',
          'nonfinite input',
          'matrix must be symmetric',
          'singular matrix',
          'matrix is not positive definite',
          'Jacobi iteration did not converge',
          'result overflow',
        ];
        throw fault('failed', `Dense decomposition failed in batch ${i}: ${reasons[status] ?? status}`, 'compute');
      }
      arena = new Float64Array(kernel.memory.buffer, pointer, an + bn + output);
      let offset = an + bn;
      lengths.forEach((len, j) => {
        results[j].set(arena.subarray(offset, offset + len), i * len);
        if (results[j].subarray(i * len, (i + 1) * len).some((x) => !Number.isFinite(x)))
          throw fault('failed', 'Dense decomposition result exceeds f32 range', 'compute');
        offset += len;
      });
    }
    aborted(options.signal);
    ctx.check();
    const out: GpuArray<'f32'>[] = [];
    try {
      for (let j = 0; j < results.length; j++)
        out.push(ctx.array(results[j], { shape: [...batch, ...shapes[j]], dtype: 'f32' }));
      return out;
    } catch (error) {
      for (const x of out) x.dispose();
      throw error;
    }
  } finally {
    kernel.release();
  }
}
/** Solve A X = b with partial-pivoted LU; leading matrix dimensions broadcast. 1-D b is a vector. */
export async function solve(a: Operand, b: Operand, options: DecompOptions = {}): Promise<GpuArray<'f32'>> {
  return (await decompose(a, 0, options, b))[0];
}
/** Inverse of every square matrix, using partial-pivoted LU. Singular matrices reject. */
export async function inv(a: Operand, options: DecompOptions = {}): Promise<GpuArray<'f32'>> {
  return (await decompose(a, 1, options))[0];
}
/** Determinant per square matrix. Singular matrices return zero; det(0x0) is one. */
export async function det(a: Operand, options: DecompOptions = {}): Promise<GpuArray<'f32'>> {
  return (await decompose(a, 2, options))[0];
}
/** Lower triangular L with A = L L^T. A must be real symmetric and positive definite. */
export async function cholesky(a: Operand, options: DecompOptions = {}): Promise<GpuArray<'f32'>> {
  return (await decompose(a, 3, options))[0];
}
/** Householder QR for square, tall, wide, rank-deficient and empty matrices. */
export async function qr(a: Operand, options: DecompOptions = {}): Promise<QRResult> {
  const [q, r] = await decompose(a, 4, options);
  return { q, r };
}
/** One-sided Jacobi SVD without forming A^T A. Reduced by default, full factors optional. */
export async function svd(a: Operand, options: DecompOptions = {}): Promise<SVDResult> {
  const [u, s, vh] = await decompose(a, 5, options);
  return { u, s, vh };
}
/** Symmetric Jacobi eigenvalues and orthonormal eigenvectors, sorted ascending. */
export async function eigh(a: Operand, options: DecompOptions = {}): Promise<EigenResult> {
  const [values, vectors] = await decompose(a, 6, options);
  return { values, vectors };
}
/** Symmetric eigenvalues sorted ascending. */
export async function eigvalsh(a: Operand, options: DecompOptions = {}): Promise<GpuArray<'f32'>> {
  const { values, vectors } = await eigh(a, options);
  vectors.dispose();
  return values;
}
