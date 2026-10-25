// @margoengine/compute/linalg: matrix products on the GPU, NumPy `matmul` semantics (batched over leading dimensions,
// which broadcast; 1-D operands are promoted to a row or column and the extra dimension dropped). Each workgroup of
// 16 x 16 threads computes a 64 x 64 tile of the result, every thread a 4 x 4 block from shared-memory tiles of A and B
// stepped 16 along K (the register-blocked tiling of V. Volkov and J. W. Demmel, "Benchmarking GPUs to tune dense linear
// algebra", SC08). Operands are read through their strides, so a transposed view costs no copy.
import { rangeError, typeError } from '../../shared/errors.js';
import { GpuArray } from './array.js';
import { isFloat, promote, type DType } from './dtype.js';
import { Operand, broadcastShapes, type Expr } from './expr.js';

const TILE = 64;

/** WGSL for one batched tiled matrix product: c = a @ b with strided operands. */
export function matmulShader(a: DType, b: DType, out: DType): string {
  const acc = isFloat(out) ? 'f32' : out,
    f16 = a === 'f16' || b === 'f16' || out === 'f16';
  return /* wgsl */ `${f16 ? 'enable f16;\n' : ''}struct Shape { m: u32, n: u32, k: u32, pad: u32, aOffset: u32, aBatch: u32, aRow: u32, aCol: u32, bOffset: u32, bBatch: u32, bRow: u32, bCol: u32 }
@group(0) @binding(0) var<storage, read> left: array<${a}>;
@group(0) @binding(1) var<storage, read> right: array<${b}>;
@group(0) @binding(2) var<storage, read_write> product: array<${out}>;
@group(0) @binding(3) var<uniform> shape: Shape;
var<workgroup> tileA: array<array<${acc}, 64>, 16>;
var<workgroup> tileB: array<array<${acc}, 64>, 16>;
@compute @workgroup_size(16, 16)
fn main(@builtin(workgroup_id) wid: vec3u, @builtin(local_invocation_id) lid: vec3u) {
  let batch = wid.z;
  let row0 = wid.y * 64u;
  let col0 = wid.x * 64u;
  let thread = lid.y * 16u + lid.x;
  var acc: array<${acc}, 16>;
  for (var k0 = 0u; k0 < shape.k; k0 += 16u) {
    for (var l = 0u; l < 4u; l++) {
      let e = thread + l * 256u;
      let am = e / 16u;
      let ak = e % 16u;
      var va: ${acc} = ${acc}(0);
      if (row0 + am < shape.m && k0 + ak < shape.k) {
        va = ${acc}(left[shape.aOffset + batch * shape.aBatch + (row0 + am) * shape.aRow + (k0 + ak) * shape.aCol]);
      }
      tileA[ak][am] = va;
      let bk = e / 64u;
      let bn = e % 64u;
      var vb: ${acc} = ${acc}(0);
      if (k0 + bk < shape.k && col0 + bn < shape.n) {
        vb = ${acc}(right[shape.bOffset + batch * shape.bBatch + (k0 + bk) * shape.bRow + (col0 + bn) * shape.bCol]);
      }
      tileB[bk][bn] = vb;
    }
    workgroupBarrier();
    for (var kk = 0u; kk < 16u; kk++) {
      var ra: array<${acc}, 4>;
      var rb: array<${acc}, 4>;
      for (var i = 0u; i < 4u; i++) { ra[i] = tileA[kk][lid.y * 4u + i]; rb[i] = tileB[kk][lid.x * 4u + i]; }
      for (var i = 0u; i < 4u; i++) {
        for (var j = 0u; j < 4u; j++) { acc[i * 4u + j] += ra[i] * rb[j]; }
      }
    }
    workgroupBarrier();
  }
  for (var i = 0u; i < 4u; i++) {
    let r = row0 + lid.y * 4u + i;
    for (var j = 0u; j < 4u; j++) {
      let c = col0 + lid.x * 4u + j;
      if (r < shape.m && c < shape.n) { product[(batch * shape.m + r) * shape.n + c] = ${out}(acc[i * 4u + j]); }
    }
  }
}`;
}

// Batch dimensions of `x` collapsed into one stride, or undefined when they cannot be (then copy first).
function batchStride(x: GpuArray, batchShape: readonly number[]): number | undefined {
  const rank = batchShape.length,
    own = x.ndim - 2,
    strides: number[] = [];
  for (let k = 0; k < rank; k++) {
    const j = k - (rank - own);
    strides.push(j < 0 || x.shape[j] === 1 ? 0 : x.strides[j]);
  }
  // Collapsible when each stride steps the next dimension's whole extent, or every stride is 0 (broadcast).
  if (strides.every((s) => s === 0)) return 0;
  for (let k = 0; k < rank - 1; k++) if (strides[k] !== strides[k + 1] * batchShape[k + 1]) return undefined;
  return strides[rank - 1] ?? 0;
}

/**
 * Matrix product `a @ b` with NumPy's `matmul` rules: the last two dimensions multiply ([.., m, k] @ [.., k, n] gives
 * [.., m, n]), leading dimensions broadcast as a batch, and a 1-D operand acts as a row (left) or column (right) whose
 * dimension is dropped from the result. Floats accumulate in f32, integers in their own type.
 * @example const c = matmul(a, b); const batched = matmul(stackOf10, w); const xtx = matmul(x.T, x);
 */
export function matmul(a: Operand, b: Operand): GpuArray {
  if (!(a instanceof Operand) || !(b instanceof Operand))
    throw typeError('matmul takes two GpuArrays or Exprs', 'compute');
  if (a.context !== b.context) throw typeError('matmul operands belong to different compute contexts', 'compute');
  if (a.ndim === 0 || b.ndim === 0)
    throw rangeError('matmul needs arrays of at least one dimension; use mul for scalars', 'compute');
  const ctx = a.context;
  ctx.check();
  const temporaries: GpuArray[] = [];
  const asArray = (x: Operand): GpuArray => {
    if (x instanceof GpuArray) return x;
    const e = x.eval();
    temporaries.push(e);
    return e;
  };
  let left = asArray(a),
    right = asArray(b);
  const dropRow = left.ndim === 1,
    dropCol = right.ndim === 1;
  if (dropRow) left = left.reshape(1, left.size);
  if (dropCol) right = right.reshape(right.size, 1);
  const [m, k] = left.shape.slice(-2),
    [k2, n] = right.shape.slice(-2);
  if (k !== k2)
    throw rangeError(
      `matmul shapes [${a.shape.join(', ')}] and [${b.shape.join(', ')}] differ in the inner dimension (${k} vs ${k2})`,
      'compute',
    );
  const batchShape = broadcastShapes(left.shape.slice(0, -2), right.shape.slice(0, -2)),
    batches = batchShape.reduce((x, y) => x * y, 1);
  let aBatch = batchStride(left, batchShape),
    bBatch = batchStride(right, batchShape);
  if (aBatch === undefined) {
    left = left.broadcastTo([...batchShape, m, k]).eval();
    temporaries.push(left);
    aBatch = m * k;
  }
  if (bBatch === undefined) {
    right = right.broadcastTo([...batchShape, k, n]).eval();
    temporaries.push(right);
    bBatch = k * n;
  }
  const out = promote(left.dtype, right.dtype),
    shape = [...batchShape, ...(dropRow ? [] : [m]), ...(dropCol ? [] : [n])],
    product = ctx.empty(shape, out);
  if (batches > ctx.device.limits.maxComputeWorkgroupsPerDimension)
    throw rangeError(
      `matmul batch of ${batches} is over the device's ${ctx.device.limits.maxComputeWorkgroupsPerDimension}; split the batch`,
      'compute',
    );
  if (product.size > 0) {
    left.check(ctx);
    right.check(ctx);
    const r = left.ndim,
      s = right.ndim;
    ctx.submit([
      {
        program: ctx.program(matmulShader(left.dtype, right.dtype, out), undefined, 'matmul'),
        // Whole buffers: the offsets and strides are in the shape uniform.
        resources: {
          left: { buffer: left.buffer },
          right: { buffer: right.buffer },
          product,
          shape: new Uint32Array([
            m,
            n,
            k,
            0,
            left.offset,
            aBatch,
            left.strides[r - 2],
            left.strides[r - 1],
            right.offset,
            bBatch,
            right.strides[s - 2],
            right.strides[s - 1],
          ]),
        },
        workgroups: [Math.ceil(n / TILE), Math.ceil(m / TILE), batches],
      },
    ]);
  }
  for (const t of temporaries) t.dispose();
  return product;
}

/** Dot product of two 1-D arrays (shape `[]`), or `matmul` for higher dimensions. */
export function dot(a: Operand, b: Operand): GpuArray {
  if (a.ndim === 1 && b.ndim === 1) {
    if (a.size !== b.size) throw rangeError(`dot of vectors of ${a.size} and ${b.size} elements`, 'compute');
    return a.mul(b).sum();
  }
  return matmul(a, b);
}

/** Outer product of two 1-D arrays: a lazy expression of shape [a.size, b.size]. */
export function outer(a: GpuArray, b: GpuArray): Expr {
  return a.reshape(a.size, 1).mul(b.reshape(1, b.size));
}

/** Euclidean (L2) norm of every element, or along `axis`, in f32. */
export function norm(
  x: Operand,
  options: { readonly axis?: number | readonly number[]; readonly keepdims?: boolean } = {},
): GpuArray {
  const squares = x.astype('f32').square().sum(options);
  const out = squares.sqrt().eval();
  squares.dispose();
  return out;
}
