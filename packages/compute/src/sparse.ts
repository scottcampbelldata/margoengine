/// <reference lib="esnext.disposable" preserve="true" />
// @margoengine/compute/sparse: sparse matrices in compressed sparse row (CSR) form, the sparse matrix-vector product,
// and Krylov solvers that run on the GPU without reading back between iterations. Solvers keep their scalars (dot
// products, step lengths) in one-element GPU arrays that the next fused expression broadcasts, so an iteration is a
// handful of passes and the residual is read back only every `checkEvery` iterations.
// Methods: conjugate gradient (M. R. Hestenes and E. Stiefel, "Methods of conjugate gradients for solving linear
// systems", J. Res. NBS 49(6), 1952) and BiCGSTAB (H. A. van der Vorst, "Bi-CGSTAB: a fast and smoothly converging
// variant of Bi-CG for the solution of nonsymmetric linear systems", SIAM J. Sci. Stat. Comput. 13(2), 1992), both
// with an optional Jacobi (diagonal) preconditioner, in the forms of Y. Saad, "Iterative Methods for Sparse Linear
// Systems", 2nd ed., SIAM 2003, algorithms 9.1 and 7.7.
import { fault, rangeError, typeError } from '../../shared/errors.js';
import { GpuArray } from './array.js';
import { Operand } from './expr.js';
import { aborted, type ComputeContext, type WaitOptions } from './context.js';

/** WGSL for y = A x, one thread per row. */
export const spmvShader = /* wgsl */ `struct Shape { rows: u32, pad0: u32, pad1: u32, pad2: u32 }
@group(0) @binding(0) var<storage, read> rowPtr: array<u32>;
@group(0) @binding(1) var<storage, read> colIdx: array<u32>;
@group(0) @binding(2) var<storage, read> values: array<f32>;
@group(0) @binding(3) var<storage, read> x: array<f32>;
@group(0) @binding(4) var<storage, read_write> y: array<f32>;
@group(0) @binding(5) var<uniform> shape: Shape;
@compute @workgroup_size(256)
fn main(@builtin(workgroup_id) wid: vec3u, @builtin(num_workgroups) nwg: vec3u, @builtin(local_invocation_index) lid: u32) {
  let r = (wid.x + wid.y * nwg.x) * 256u + lid;
  if (r >= shape.rows) { return; }
  var sum = 0.0;
  for (var k = rowPtr[r]; k < rowPtr[r + 1u]; k++) { sum += values[k] * x[colIdx[k]]; }
  y[r] = sum;
}`;

/** WGSL for the diagonal: the value at column r of row r (0 where none is stored; duplicates were summed). */
export const diagonalShader = /* wgsl */ `struct Shape { rows: u32, pad0: u32, pad1: u32, pad2: u32 }
@group(0) @binding(0) var<storage, read> rowPtr: array<u32>;
@group(0) @binding(1) var<storage, read> colIdx: array<u32>;
@group(0) @binding(2) var<storage, read> values: array<f32>;
@group(0) @binding(3) var<storage, read_write> d: array<f32>;
@group(0) @binding(4) var<uniform> shape: Shape;
@compute @workgroup_size(256)
fn main(@builtin(workgroup_id) wid: vec3u, @builtin(num_workgroups) nwg: vec3u, @builtin(local_invocation_index) lid: u32) {
  let r = (wid.x + wid.y * nwg.x) * 256u + lid;
  if (r >= shape.rows) { return; }
  var v = 0.0;
  for (var k = rowPtr[r]; k < rowPtr[r + 1u]; k++) { if (colIdx[k] == r) { v += values[k]; } }
  d[r] = v;
}`;

const contiguousF32 = (x: Operand): { array: GpuArray; owned: boolean } =>
  x instanceof GpuArray && x.dtype === 'f32' && x.contiguous && x.offset === 0
    ? { array: x, owned: false }
    : { array: x.astype('f32').eval(), owned: true };

/**
 * A sparse matrix in compressed sparse row form on the GPU: `rowPtr` (rows + 1 offsets), and per stored entry its
 * column (`colIdx`), row (`rowIdx`) and value (`values`, f32). Columns are ascending within each row and duplicates
 * are summed. Make one with {@link csr}, {@link coo} or {@link diags}; dispose it to free its arrays.
 */
export class CsrMatrix {
  /** [rows, cols]. */
  readonly shape: readonly [number, number];
  /** Stored entries. */
  readonly nnz: number;
  #disposed = false;

  /** @internal Use csr(), coo() or diags(). */
  constructor(
    /** The context the arrays belong to. */
    readonly context: ComputeContext,
    shape: readonly [number, number],
    /** Row offsets (u32, rows + 1): row r's entries are at [rowPtr[r], rowPtr[r + 1]). */
    readonly rowPtr: GpuArray<'u32'>,
    /** Column of each entry (u32, nnz). */
    readonly colIdx: GpuArray<'u32'>,
    /** Row of each entry (u32, nnz), the expanded rowPtr. */
    readonly rowIdx: GpuArray<'u32'>,
    /** Value of each entry (f32, nnz). */
    readonly values: GpuArray<'f32'>,
  ) {
    this.shape = Object.freeze([shape[0], shape[1]]) as unknown as readonly [number, number];
    this.nnz = values.size;
  }

  /** True after `dispose()`. */
  get disposed(): boolean {
    return this.#disposed;
  }

  #check(): void {
    if (this.#disposed) throw fault('disposed', 'CsrMatrix disposed; create a new one with csr() or coo()', 'compute');
  }

  /** `A x` for a vector of `cols` elements, f32. */
  matvec(x: Operand): GpuArray<'f32'> {
    this.#check();
    const ctx = this.context,
      [rows, cols] = this.shape;
    if (!(x instanceof Operand)) throw typeError('matvec takes a GpuArray or an Expr', 'compute');
    if (x.size !== cols)
      throw rangeError(`matvec of a ${rows} x ${cols} matrix needs ${cols} elements, got ${x.size}`, 'compute');
    const v = contiguousF32(x),
      y = ctx.empty([rows], 'f32');
    if (rows > 0)
      ctx.submit([
        {
          program: ctx.program(spmvShader, undefined, 'sparse.spmv'),
          resources: {
            rowPtr: this.rowPtr,
            colIdx: this.colIdx,
            values: this.values,
            x: v.array,
            y,
            shape: new Uint32Array([rows, 0, 0, 0]),
          },
          workgroups: ctx.grid(Math.ceil(rows / 256)),
        },
      ]);
    if (v.owned) v.array.dispose();
    return y;
  }

  /** The main diagonal (min(rows, cols) elements, f32; 0 where nothing is stored). */
  diagonal(): GpuArray<'f32'> {
    this.#check();
    const ctx = this.context,
      n = Math.min(...this.shape),
      d = ctx.empty([n], 'f32');
    if (n > 0)
      ctx.submit([
        {
          program: ctx.program(diagonalShader, undefined, 'sparse.diagonal'),
          resources: {
            rowPtr: this.rowPtr,
            colIdx: this.colIdx,
            values: this.values,
            d,
            shape: new Uint32Array([n, 0, 0, 0]),
          },
          workgroups: ctx.grid(Math.ceil(n / 256)),
        },
      ]);
    return d;
  }

  /** The transpose, as a new CSR matrix built on the GPU (a stable sort of the entries by column). */
  transpose(): CsrMatrix {
    this.#check();
    const ctx = this.context,
      [rows, cols] = this.shape,
      order = ctx.argsort(this.colIdx, { bits: Math.max(1, Math.ceil(Math.log2(cols + 1))) }),
      colIdx = ctx.take(this.rowIdx, order) as GpuArray<'u32'>,
      rowIdx = ctx.take(this.colIdx, order) as GpuArray<'u32'>,
      values = ctx.take(this.values, order) as GpuArray<'f32'>;
    order.dispose();
    return new CsrMatrix(ctx, [cols, rows], offsetsOf(ctx, rowIdx, cols), colIdx, rowIdx, values);
  }

  /** The matrix as a dense rows x cols f32 array. */
  toDense(): GpuArray<'f32'> {
    this.#check();
    const ctx = this.context,
      [rows, cols] = this.shape,
      dense = ctx.zeros([rows * cols]),
      flat = this.rowIdx.astype('i32').mul(cols).add(this.colIdx.astype('i32'));
    ctx.scatter(dense, flat, this.values, { op: 'add' });
    return dense.reshape(rows, cols) as GpuArray<'f32'>;
  }

  /** Frees the four arrays. */
  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    for (const a of [this.rowPtr, this.colIdx, this.rowIdx, this.values]) a.dispose();
  }

  /** Same as `dispose()`, for `using`. */
  [Symbol.dispose](): void {
    this.dispose();
  }
}

// Row offsets (rows + 1) from the sorted row of each entry: an exclusive scan of the per-row counts.
function offsetsOf(ctx: ComputeContext, rowIdx: GpuArray<'u32'>, rows: number): GpuArray<'u32'> {
  const counts = ctx.bincount(rowIdx, { length: rows }),
    ends = ctx.cumsum(counts),
    ptr = ctx.zeros([rows + 1], 'u32');
  if (rows > 0) ctx.scatter(ptr, ctx.arange(1, rows + 1, 1, 'i32'), ends);
  counts.dispose();
  ends.dispose();
  return ptr;
}

const whole = (v: number, what: string) => {
  if (!Number.isInteger(v) || v < 0)
    throw rangeError(`${what} must be a whole number of at least 0, got ${v}`, 'compute');
  return v;
};
const shapeOf = (shape: readonly number[] | undefined): [number, number] => {
  if (!shape || shape.length !== 2) throw rangeError('A sparse matrix needs shape: [rows, cols]', 'compute');
  return [whole(shape[0], 'rows'), whole(shape[1], 'cols')];
};

/** Entries of a sparse matrix by coordinates. */
export interface CooData {
  /** Row of each entry. */
  readonly rows: ArrayLike<number>;
  /** Column of each entry. */
  readonly cols: ArrayLike<number>;
  /** Value of each entry. */
  readonly values: ArrayLike<number>;
  /** [rows, cols] of the matrix. */
  readonly shape: readonly [number, number];
}

/**
 * A CSR matrix from coordinates (SciPy `coo_matrix((values, (rows, cols))).tocsr()`): entries in any order,
 * duplicates summed. Built on the CPU from your arrays, then uploaded.
 * @example const A = coo(gpu, { rows: [0, 1, 1], cols: [0, 0, 1], values: [2, -1, 2], shape: [2, 2] });
 */
export function coo(gpu: ComputeContext, data: CooData): CsrMatrix {
  gpu.check();
  const [rows, cols] = shapeOf(data?.shape),
    { rows: r, cols: c, values: v } = data,
    n = v?.length;
  if (r?.length !== n || c?.length !== n)
    throw rangeError(`coo needs rows, cols and values of one length, got ${r?.length}, ${c?.length}, ${n}`, 'compute');
  const order = Array.from({ length: n }, (_, k) => k);
  for (let k = 0; k < n; k++) {
    if (!Number.isInteger(r[k]) || r[k] < 0 || r[k] >= rows || !Number.isInteger(c[k]) || c[k] < 0 || c[k] >= cols)
      throw rangeError(`coo entry ${k} at (${r[k]}, ${c[k]}) is outside the ${rows} x ${cols} matrix`, 'compute');
  }
  order.sort((a, b) => r[a] - r[b] || c[a] - c[b] || a - b);
  const rowIdx: number[] = [],
    colIdx: number[] = [],
    values: number[] = [];
  for (const k of order) {
    const last = values.length - 1;
    if (last >= 0 && rowIdx[last] === r[k] && colIdx[last] === c[k]) values[last] += v[k];
    else {
      rowIdx.push(r[k]);
      colIdx.push(c[k]);
      values.push(v[k]);
    }
  }
  const rowPtr = new Uint32Array(rows + 1);
  for (const row of rowIdx) rowPtr[row + 1]++;
  for (let i = 0; i < rows; i++) rowPtr[i + 1] += rowPtr[i];
  return new CsrMatrix(
    gpu,
    [rows, cols],
    gpu.array(rowPtr, 'u32'),
    gpu.array(colIdx, 'u32'),
    gpu.array(rowIdx, 'u32'),
    gpu.array(values, 'f32'),
  );
}

/** A CSR matrix in its own arrays. */
export interface CsrData {
  /** Row offsets, rows + 1 of them, starting at 0 and never decreasing. */
  readonly rowPtr: ArrayLike<number>;
  /** Column of each entry. */
  readonly colIdx: ArrayLike<number>;
  /** Value of each entry. */
  readonly values: ArrayLike<number>;
  /** [rows, cols] of the matrix. */
  readonly shape: readonly [number, number];
}

/**
 * A CSR matrix from its arrays (SciPy `csr_matrix((values, colIdx, rowPtr))`). Columns may come in any order within a
 * row and repeat; they are sorted and summed.
 * @example const I = csr(gpu, { rowPtr: [0, 1, 2], colIdx: [0, 1], values: [1, 1], shape: [2, 2] });
 */
export function csr(gpu: ComputeContext, data: CsrData): CsrMatrix {
  const [rows] = shapeOf(data?.shape),
    { rowPtr, colIdx, values } = data;
  if (rowPtr?.length !== rows + 1 || rowPtr[0] !== 0 || rowPtr[rows] !== values?.length)
    throw rangeError(
      `csr rowPtr needs ${rows + 1} offsets from 0 to the ${values?.length} values, got ${rowPtr?.length}`,
      'compute',
    );
  const r = new Array<number>(values.length);
  for (let i = 0; i < rows; i++) {
    if (!(rowPtr[i + 1] >= rowPtr[i])) throw rangeError(`csr rowPtr decreases at row ${i}`, 'compute');
    for (let k = rowPtr[i]; k < rowPtr[i + 1]; k++) r[k] = i;
  }
  return coo(gpu, { rows: r, cols: colIdx, values, shape: data.shape });
}

/**
 * A matrix with constant diagonals (SciPy `diags`): `values[k]` along the diagonal at `offsets[k]` (0 the main
 * diagonal, positive above, negative below).
 * @example const poisson = diags(gpu, [-1, 2, -1], [-1, 0, 1], [n, n]); // the 1-D Laplacian
 */
export function diags(
  gpu: ComputeContext,
  values: readonly number[],
  offsets: readonly number[],
  shape: readonly [number, number],
): CsrMatrix {
  const [rows, cols] = shapeOf(shape);
  if (values.length !== offsets.length)
    throw rangeError(`diags needs one value per offset, got ${values.length} and ${offsets.length}`, 'compute');
  const r: number[] = [],
    c: number[] = [],
    v: number[] = [];
  offsets.forEach((offset, k) => {
    if (!Number.isInteger(offset)) throw rangeError(`diags offsets must be integers, got ${offset}`, 'compute');
    for (let i = Math.max(0, -offset); i < rows && i + offset < cols; i++) {
      r.push(i);
      c.push(i + offset);
      v.push(values[k]);
    }
  });
  return coo(gpu, { rows: r, cols: c, values: v, shape: [rows, cols] });
}

/** `A x` (see {@link CsrMatrix.matvec}). */
export function spmv(A: CsrMatrix, x: Operand): GpuArray<'f32'> {
  if (!(A instanceof CsrMatrix)) throw typeError('spmv takes a CsrMatrix; make one with csr() or coo()', 'compute');
  return A.matvec(x);
}

/** Options for the iterative solvers. */
export interface SparseSolveOptions extends WaitOptions {
  /** Starting guess. Default zeros. */
  readonly x0?: Operand;
  /** Stop when the residual norm is at most `tol` times the norm of b. Default 1e-5 (f32 arithmetic). */
  readonly tol?: number;
  /** Or at most `atol`. Default 0. */
  readonly atol?: number;
  /** Most iterations. Default 10 times the number of rows. */
  readonly maxIterations?: number;
  /** `'jacobi'` (divide by the diagonal) or `'none'`. Default `'jacobi'`. */
  readonly preconditioner?: 'jacobi' | 'none';
  /** Iterations between residual read-backs (the only GPU-to-CPU traffic). Default 32. */
  readonly checkEvery?: number;
}

/** What a solver found. */
export interface SparseSolveResult {
  /** The solution (f32, the size of b). */
  readonly x: GpuArray<'f32'>;
  /** Iterations run. */
  readonly iterations: number;
  /** Final residual norm ||b - A x||, recomputed from x. */
  readonly residual: number;
  /** True when the residual met the tolerance. */
  readonly converged: boolean;
}

interface Setup {
  readonly ctx: ComputeContext;
  readonly n: number;
  readonly b: GpuArray;
  readonly x: GpuArray;
  readonly inverse: GpuArray | undefined;
  readonly tol: number;
  readonly atol: number;
  readonly maxIterations: number;
  readonly checkEvery: number;
}

function setup(name: string, A: CsrMatrix, b: Operand, options: SparseSolveOptions): Setup {
  if (!(A instanceof CsrMatrix)) throw typeError(`${name} takes a CsrMatrix; make one with csr() or coo()`, 'compute');
  if (!(b instanceof Operand)) throw typeError(`${name} takes b as a GpuArray or an Expr`, 'compute');
  const [rows, cols] = A.shape;
  if (rows !== cols) throw rangeError(`${name} needs a square matrix, got ${rows} x ${cols}`, 'compute');
  if (b.size !== rows) throw rangeError(`${name}: b has ${b.size} elements, the matrix ${rows} rows`, 'compute');
  const tol = options.tol ?? 1e-5,
    atol = options.atol ?? 0,
    maxIterations = options.maxIterations ?? 10 * rows,
    checkEvery = options.checkEvery ?? 32,
    preconditioner = options.preconditioner ?? 'jacobi';
  if (!(tol >= 0) || !(atol >= 0)) throw rangeError(`${name} tol and atol must be at least 0`, 'compute');
  if (!Number.isInteger(maxIterations) || maxIterations < 0)
    throw rangeError(`${name} maxIterations must be a whole number, got ${maxIterations}`, 'compute');
  if (!Number.isInteger(checkEvery) || checkEvery < 1)
    throw rangeError(`${name} checkEvery must be a whole number of at least 1, got ${checkEvery}`, 'compute');
  if (preconditioner !== 'jacobi' && preconditioner !== 'none')
    throw typeError(`${name} preconditioner must be 'jacobi' or 'none', got ${String(preconditioner)}`, 'compute');
  if (options.x0 && options.x0.size !== rows)
    throw rangeError(`${name}: x0 has ${options.x0.size} elements, the matrix ${rows} rows`, 'compute');
  const ctx = A.context,
    bb = b.astype('f32').eval(),
    x = options.x0 ? options.x0.astype('f32').eval() : ctx.zeros([rows]);
  let inverse: GpuArray | undefined;
  if (preconditioner === 'jacobi') {
    const d = A.diagonal();
    // Rows without a diagonal entry are left unscaled.
    inverse = ctx.where(d.eq(0), 1, d.reciprocal()).eval();
    d.dispose();
  }
  return { ctx, n: rows, b: bb, x, inverse, tol, atol, maxIterations, checkEvery };
}

// a := next (disposing a), returning next.
const swap = (old: GpuArray | undefined, next: GpuArray): GpuArray => {
  old?.dispose();
  return next;
};
const dot = (a: Operand, b: Operand) => a.mul(b).sum();
// Reads a one-element array and frees it.
async function take1(a: GpuArray, signal: AbortSignal | undefined): Promise<number> {
  try {
    return await a.item({ signal });
  } finally {
    a.dispose();
  }
}

async function finish(
  s: Setup,
  A: CsrMatrix,
  x: GpuArray,
  iterations: number,
  signal: AbortSignal | undefined,
): Promise<SparseSolveResult> {
  const ax = A.matvec(x),
    [rr, bn] = await Promise.all([take1(s.b.sub(ax).square().sum(), signal), take1(dot(s.b, s.b), signal)]);
  ax.dispose();
  s.b.dispose();
  s.inverse?.dispose();
  const residual = Math.sqrt(rr);
  return {
    x: x as GpuArray<'f32'>,
    iterations,
    residual,
    converged: residual <= Math.max(s.tol * Math.sqrt(bn), s.atol),
  };
}

/**
 * Solves A x = b for a symmetric positive definite A by the conjugate gradient method, on the GPU. Resolves the
 * solution with its iteration count, residual and whether it converged (it does not reject when it did not).
 * @example const { x, iterations } = await cg(A, b, { tol: 1e-6 });
 */
export async function cg(A: CsrMatrix, b: Operand, options: SparseSolveOptions = {}): Promise<SparseSolveResult> {
  const s = setup('cg', A, b, options),
    { ctx, inverse, checkEvery, maxIterations } = s,
    signal = options.signal;
  aborted(signal);
  const b2 = await take1(dot(s.b, s.b), signal),
    stop = Math.max(s.tol * Math.sqrt(b2), s.atol) ** 2;
  let x = s.x,
    ax = A.matvec(x),
    r = s.b.sub(ax).eval();
  ax.dispose();
  // z = M^-1 r (r itself without a preconditioner); p starts as a copy of z.
  let z = inverse ? r.mul(inverse).eval() : r,
    p = z.add(0).eval(),
    rz = dot(r, z),
    k = 0,
    // x at the last check whose residual was finite: what a breakdown (rz or p.Ap reaching 0, in f32) falls back to.
    good = x.add(0).eval();
  if ((await take1(dot(r, r), signal)) > stop)
    while (k < maxIterations) {
      // A residual that reached exactly zero ends the method (Hestenes and Stiefel; Barrett et al., Templates, 1994,
      // figure 2.5): alpha and beta are then 0 instead of 0 / 0, so x stays the solution until the next check reads it.
      const ap = A.matvec(p),
        pap = dot(p, ap),
        alpha = ctx.where(rz.eq(0), 0, rz.div(pap)).eval();
      pap.dispose();
      x = swap(x, x.add(p.mul(alpha)).eval());
      r = swap(r, r.sub(ap.mul(alpha)).eval());
      ap.dispose();
      alpha.dispose();
      k++;
      if (k % checkEvery === 0 || k === maxIterations) {
        const value = await take1(dot(r, r), signal);
        if (!Number.isFinite(value)) {
          x = swap(x, good);
          break;
        }
        good = swap(good, x.add(0).eval());
        if (value <= stop) break;
      }
      const zNext = inverse ? r.mul(inverse).eval() : r,
        rzNext = dot(r, zNext),
        beta = ctx.where(rzNext.eq(0), 0, rzNext.div(rz)).eval();
      p = swap(p, zNext.add(p.mul(beta)).eval());
      if (inverse) z.dispose();
      z = zNext;
      rz.dispose();
      beta.dispose();
      rz = rzNext;
    }
  if (inverse) z.dispose();
  for (const a of [r, p, rz]) a.dispose();
  if (good !== x) good.dispose();
  return finish(s, A, x, k, signal);
}

/**
 * Solves A x = b for a general square A by BiCGSTAB, on the GPU. Resolves the solution with its iteration count,
 * residual and whether it converged; a breakdown (a zero inner product) ends early with `converged: false`.
 * @example const { x, converged } = await bicgstab(A, b);
 */
export async function bicgstab(A: CsrMatrix, b: Operand, options: SparseSolveOptions = {}): Promise<SparseSolveResult> {
  const s = setup('bicgstab', A, b, options),
    { ctx, inverse, checkEvery, maxIterations } = s,
    signal = options.signal;
  aborted(signal);
  const b2 = await take1(dot(s.b, s.b), signal),
    stop = Math.max(s.tol * Math.sqrt(b2), s.atol) ** 2,
    precondition = (v: GpuArray) => (inverse ? v.mul(inverse).eval() : v.add(0).eval());
  let x = s.x,
    ax = A.matvec(x),
    r = s.b.sub(ax).eval();
  ax.dispose();
  const rHat = r.add(0).eval();
  let p: GpuArray = ctx.zeros([s.n]),
    v: GpuArray = ctx.zeros([s.n]),
    rho: GpuArray = ctx.ones([]),
    alpha: GpuArray = ctx.ones([]),
    omega: GpuArray = ctx.ones([]),
    k = 0,
    // x at the last check whose residual was finite: what a breakdown falls back to.
    good = x.add(0).eval();
  if ((await take1(dot(r, r), signal)) > stop)
    while (k < maxIterations) {
      // r exactly zero is convergence, not the rho = 0 breakdown: hold x there (alpha, beta and omega 0, not 0 / 0).
      const rhoNext = dot(rHat, r),
        solved = dot(r, r).eq(0).eval(),
        beta = ctx.where(solved, 0, rhoNext.div(rho).mul(alpha.div(omega))).eval();
      p = swap(p, r.add(p.sub(v.mul(omega)).mul(beta)).eval());
      const pHat = precondition(p);
      v = swap(v, A.matvec(pHat));
      const rv = dot(rHat, v);
      alpha = swap(alpha, ctx.where(solved, 0, rhoNext.div(rv)).eval());
      rv.dispose();
      const sv = r.sub(v.mul(alpha)).eval(),
        sHat = precondition(sv),
        t = A.matvec(sHat),
        tt = dot(t, t),
        ts = dot(t, sv);
      // s exactly zero (t = A M^-1 s zero) is Templates' early exit after the half step, x + alpha p^: omega 0.
      omega = swap(omega, ctx.where(tt.eq(0), 0, ts.div(tt)).eval());
      ts.dispose();
      x = swap(x, x.add(pHat.mul(alpha)).add(sHat.mul(omega)).eval());
      r = swap(r, sv.sub(t.mul(omega)).eval());
      for (const a of [pHat, sv, sHat, t, tt, beta, solved]) a.dispose();
      rho = swap(rho, rhoNext);
      k++;
      if (k % checkEvery === 0 || k === maxIterations) {
        const [value, w] = await Promise.all([take1(dot(r, r), signal), omega.item({ signal })]);
        // A breakdown (rho or omega reaching 0) leaves NaN behind: return the last finite x instead.
        if (!Number.isFinite(value) || !Number.isFinite(w)) {
          x = swap(x, good);
          break;
        }
        good = swap(good, x.add(0).eval());
        if (value <= stop) break;
      }
    }
  for (const a of [r, rHat, p, v, rho, alpha, omega]) a.dispose();
  if (good !== x) good.dispose();
  return finish(s, A, x, k, signal);
}
