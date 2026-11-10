// Regular-grid velocity derivatives. Clean-room mathematical sources and precision policy: docs/clean-room.md.
import type { ComputeContext, GpuArray } from '@margoengine/compute';
import { fault, rangeError } from '../../shared/errors.js';
import type { VectorGrid } from './fields.js';
import { deriveShader } from './derive-shader.js';

/** A Cartesian velocity grid, x fastest. Physical coordinates and velocities must use compatible units. */
export interface DeriveGrid extends VectorGrid {
  /** Optional per-point mask: zero is missing, nonzero is valid. Default all points valid. */
  readonly mask?: ArrayLike<number>;
}

/** Controls for copying and deriving one snapshot. */
export interface DeriveOptions {
  /** Cancels with the exact reason, including during bounded CPU work or GPU readback. Default absent. */
  readonly signal?: AbortSignal;
}

/** Absolute CPU/GPU difference bounds for the rounded input, excluding spatial discretisation error. */
export interface DeriveFloatBound {
  readonly gradient: number;
  readonly divergence: number;
  readonly curl: number;
  readonly vorticity: number;
  readonly q: number;
  readonly lambda2: number;
}

/** Owned results. Scalar arrays are x fastest; GPU scalars have shape [nz, ny, nx] for existing volume/iso layers. */
export interface DerivedFlowFields<T> {
  readonly dims: readonly [number, number, number];
  readonly bounds: readonly [number, number, number, number, number, number];
  /** Nine row-major values per point: d(velocity component i)/d(coordinate j), shape [...,3,3] on GPU. */
  readonly gradient: T;
  readonly divergence: T;
  /** Three xyz values per point. This is vorticity, not angular velocity (half the curl). */
  readonly curl: T;
  /** Euclidean magnitude of curl. */
  readonly vorticity: T;
  /** Rotation dominance, (||Omega||_F^2 - ||S||_F^2)/2, even for nonzero divergence. */
  readonly q: T;
  /** Middle eigenvalue of S^2 + Omega^2. Negative suggests a vortex core under the incompressible-flow model. */
  readonly lambda2: T;
  readonly floatBound: DeriveFloatBound;
}

/** GPU result owner; keep alive until its consumers finish. Recompute after device replacement. */
export interface GpuDerivedFlowFields extends DerivedFlowFields<GpuArray<'f32'>> {
  /** Idempotent. Releases all six arrays, but never the caller's compute context or device. */
  dispose(): void;
  [Symbol.dispose](): void;
}

const NAMES = ['gradient', 'divergence', 'curl', 'vorticity', 'q', 'lambda2'] as const;
const WIDTHS = [9, 1, 3, 1, 1, 1] as const;
const CHUNK = 8192;
const NORMAL = 2 ** -126;
const EPS = 2 ** -23;
const yieldTask = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

async function prepare(grid: DeriveGrid, signal?: AbortSignal) {
  signal?.throwIfAborted();
  if (!grid || grid.dims?.length !== 3 || grid.bounds?.length !== 6 ||
    !Array.from(grid.dims).every((n) => Number.isSafeInteger(n) && n >= 1) ||
    !Array.from(grid.bounds).every(Number.isFinite))
    throw rangeError('Derived flow needs three positive integer dimensions and six finite bounds', 'sciviz');
  const dims = [...grid.dims] as [number, number, number],
    bounds = [...grid.bounds] as [number, number, number, number, number, number],
    count = dims[0] * dims[1] * dims[2];
  if (!Number.isSafeInteger(count) || count > 1_000_000)
    throw rangeError('Derived flow supports at most 1000000 grid points per snapshot', 'sciviz');
  const inverse = dims.map((n, a) => {
    const span = bounds[2 * a + 1] - bounds[2 * a];
    const value = n === 1 ? 0 : Math.fround((n - 1) / span);
    if ((n === 1 && span !== 0) || (n > 1 && (!Number.isFinite(value) || Math.abs(value) < NORMAL)))
      throw rangeError('Derived flow needs equal singleton bounds and finite normal float32 inverse spacing on active axes', 'sciviz');
    return value;
  });
  const arrays = [grid.u, grid.v, grid.w];
  if (!grid.u || !grid.v || arrays.some((a) => a !== undefined && (a === null || typeof a !== 'object' || a.length !== count)) ||
    (grid.mask !== undefined && (grid.mask === null || typeof grid.mask !== 'object' || grid.mask.length !== count)))
    throw rangeError('Derived flow components and mask must match the grid point count', 'sciviz');
  const data = new Float32Array(count * 4);
  let peak = 0;
  for (let start = 0; start < count; start += CHUNK) {
    await yieldTask(); signal?.throwIfAborted();
    for (let i = start; i < Math.min(start + CHUNK, count); i++) {
      let valid = 1;
      if (grid.mask !== undefined) {
        const m = grid.mask[i];
        if (!Number.isFinite(m)) throw rangeError('Derived flow mask values must be finite', 'sciviz');
        valid = m === 0 ? 0 : 1;
      }
      for (let c = 0; c < 3; c++) {
        const v = arrays[c] === undefined ? 0 : arrays[c]![i], f = typeof v === 'number' ? Math.fround(v) : Infinity;
        if (typeof v !== 'number' || (!Number.isFinite(f) && !Number.isNaN(v)))
          throw rangeError('Derived flow velocities must be finite float32 values or NaN for missing data', 'sciviz');
        if (Number.isNaN(v)) valid = 0;
        else { data[4 * i + c] = f; peak = Math.max(peak, Math.abs(f)); }
      }
      data[4 * i + 3] = valid;
    }
  }
  const spacing = Math.max(...inverse.map(Math.abs)), envelope = 8 * Math.max(peak, NORMAL) * spacing;
  // This conservative envelope prevents every stencil, tensor product and output norm from overflowing f32.
  if (!Number.isFinite(envelope) || envelope > 1e18)
    throw rangeError('Derived flow float32 stencil envelope 8 * max(maxAbsVelocity, 2^-126) * maxAbsInverseSpacing must not exceed 1e18; rescale units', 'sciviz');
  const linear = 32 * EPS * envelope + 32 * NORMAL * Math.max(1, spacing),
    square = envelope * envelope,
    floatBound = Object.freeze({ gradient: linear, divergence: 4 * linear, curl: 4 * linear,
      vorticity: 8 * linear, q: 256 * EPS * square + 128 * NORMAL,
      lambda2: 1024 * EPS * square + 128 * NORMAL });
  return { dims: Object.freeze(dims), bounds: Object.freeze(bounds), count, inverse, data, floatBound };
}

// Largest-pivot Jacobi rotations of a scaled real symmetric 3x3, without eigenvectors or cubic roots.
function middleEigenvalue(matrix: number[]): number {
  for (let turn = 0; turn < 48; turn++) {
    let p = 0, q = 1;
    for (const [i, j] of [[0, 2], [1, 2]])
      if (Math.abs(matrix[3 * i + j]) > Math.abs(matrix[3 * p + q])) { p = i; q = j; }
    const b = matrix[3 * p + q], a = matrix[4 * p], d = matrix[4 * q];
    if (Math.abs(b) <= 1e-14 * Math.max(...matrix.map(Math.abs))) break;
    const diff = d - a, t = diff === 0 ? (b >= 0 ? 1 : -1)
      : 2 * b * Math.sign(diff) / (Math.abs(diff) + Math.hypot(diff, 2 * b)),
      c = 1 / Math.sqrt(1 + t * t), s = t * c, r = 3 - p - q;
    const rp = matrix[3 * r + p], rq = matrix[3 * r + q];
    matrix[3 * r + p] = matrix[3 * p + r] = c * rp - s * rq;
    matrix[3 * r + q] = matrix[3 * q + r] = s * rp + c * rq;
    matrix[4 * p] = a - t * b; matrix[4 * q] = d + t * b;
    matrix[3 * p + q] = matrix[3 * q + p] = 0;
  }
  const [a, b, c] = [matrix[0], matrix[4], matrix[8]];
  return Math.max(Math.min(a, b), Math.min(Math.max(a, b), c));
}

/**
 * CPU reference using float64 arithmetic on an owned float32 snapshot. Second-order centred interiors and
 * one-sided boundaries; two-point axes use the secant, singleton derivatives are zero. No extrapolation across
 * masks: a missing centre or required stencil neighbour makes every output at that point NaN.
 * At most 1000000 points; see README for the float32 range envelope and CPU/GPU error bounds.
 */
export async function deriveFlow(grid: DeriveGrid, options: DeriveOptions = {}): Promise<DerivedFlowFields<Float32Array>> {
  const input = await prepare(grid, options.signal), { count, dims, data, inverse } = input;
  const fields = Object.fromEntries(NAMES.map((name, k) => [name, new Float32Array(count * WIDTHS[k])])) as
    Record<typeof NAMES[number], Float32Array>;
  const strides = [1, dims[0], dims[0] * dims[1]];
  for (let start = 0; start < count; start += CHUNK) {
    await yieldTask(); options.signal?.throwIfAborted();
    for (let i = start; i < Math.min(start + CHUNK, count); i++) {
      const g = new Array<number>(9).fill(0);
      let valid = data[4 * i + 3] !== 0;
      for (let axis = 0; axis < 3; axis++) {
        const n = dims[axis], stride = strides[axis], at = Math.floor(i / stride) % n;
        if (n === 1) continue;
        const oneSided = n > 2 && (at === 0 || at === n - 1),
          a = oneSided ? i : at === 0 ? i : i - stride,
          b = oneSided ? i + (at === 0 ? stride : -stride) : at === n - 1 ? i : i + stride,
          c = oneSided ? i + (at === 0 ? 2 * stride : -2 * stride) : a;
        valid &&= data[4 * a + 3] !== 0 && data[4 * b + 3] !== 0 && data[4 * c + 3] !== 0;
        for (let component = 0; component < 3; component++) {
          const va = data[4 * a + component], vb = data[4 * b + component], vc = data[4 * c + component];
          g[3 * component + axis] = (oneSided ? (2 * (vb - va) - 0.5 * (vc - va)) * (at === 0 ? 1 : -1)
            : (vb - va) * (n === 2 ? 1 : 0.5)) * inverse[axis];
        }
      }
      if (!valid) {
        NAMES.forEach((name, k) => fields[name].fill(NaN, i * WIDTHS[k], (i + 1) * WIDTHS[k]));
        continue;
      }
      fields.gradient.set(g, 9 * i);
      fields.divergence[i] = g[0] + g[4] + g[8];
      const curl = [g[7] - g[5], g[2] - g[6], g[3] - g[1]];
      fields.curl.set(curl, 3 * i); fields.vorticity[i] = Math.hypot(...curl);
      const scale = Math.max(...g.map(Math.abs));
      if (scale === 0) continue;
      const j = g.map((v) => v / scale), a = new Array<number>(9).fill(0);
      for (let r = 0; r < 3; r++) for (let c = r; c < 3; c++) {
        let value = 0;
        for (let k = 0; k < 3; k++) value += 0.5 * (j[3 * r + k] * j[3 * k + c] + j[3 * c + k] * j[3 * k + r]);
        a[3 * r + c] = a[3 * c + r] = value;
      }
      fields.q[i] = -0.5 * (a[0] + a[4] + a[8]) * scale * scale;
      fields.lambda2[i] = middleEigenvalue(a) * scale * scale;
    }
  }
  return { dims: input.dims, bounds: input.bounds, floatBound: input.floatBound, ...fields };
}

/**
 * GPU derivation on the caller's native or WebGL2 compute context. All scalar outputs are separate contiguous
 * f32 GpuArrays usable directly by figure.volume/isosurface on that same device. Reads only the status array;
 * values remain on the GPU. Caller owns/disposes the result and context. No device creation or import side effect.
 */
export async function deriveFlowGPU(gpu: ComputeContext, grid: DeriveGrid, options: DeriveOptions = {}): Promise<GpuDerivedFlowFields> {
  const input = await prepare(grid, options.signal), { count, dims, inverse, data } = input;
  await gpu.routeReady; options.signal?.throwIfAborted();
  const max = Math.min(gpu.device.limits.maxBufferSize, gpu.device.limits.maxStorageBufferBindingSize);
  if (36 * count > max || gpu.device.limits.maxStorageBuffersPerShaderStage < 8)
    throw rangeError('Derived flow needs eight storage bindings and a gradient buffer of 36 bytes per point within device limits', 'sciviz');
  const owned: { dispose(): void }[] = [];
  try {
    const source = gpu.array(data); owned.push(source);
    const status = gpu.zeros(count, 'u32'); owned.push(status);
    const shape = [dims[2], dims[1], dims[0]];
    const fields = Object.fromEntries(NAMES.map((name, k) => {
      const field = gpu.zeros([...shape, ...(name === 'gradient' ? [3, 3] : name === 'curl' ? [3] : [])]);
      owned.push(field); return [name, field];
    })) as Record<typeof NAMES[number], GpuArray<'f32'>>;
    const kernel = gpu.kernel(deriveShader); owned.push(kernel);
    const wx = Math.min(Math.ceil(count / 64), gpu.device.limits.maxComputeWorkgroupsPerDimension);
    kernel.run({ source, status, ...fields, params: { nx: dims[0], ny: dims[1], nz: dims[2], count,
      ix: inverse[0], iy: inverse[1], iz: inverse[2], missingBits: 0x7fc00000 } }, { workgroups: [wx, Math.ceil(count / 64 / wx), 1] });
    const flags = await status.read({ signal: options.signal }); options.signal?.throwIfAborted();
    if (flags.some((v) => v === 2))
      throw fault('failed', 'Derived flow eigensolver did not converge within its float32 residual bound', 'sciviz');
    source.dispose(); status.dispose(); kernel.dispose();
    let disposed = false;
    const dispose = () => { if (!disposed) { disposed = true; NAMES.forEach((name) => fields[name].dispose()); } };
    return { dims: input.dims, bounds: input.bounds, floatBound: input.floatBound, ...fields,
      dispose, [Symbol.dispose]: dispose };
  } catch (error) { for (const resource of owned.reverse()) resource.dispose(); throw error; }
}
