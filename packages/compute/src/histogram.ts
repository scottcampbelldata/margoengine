// Histograms with NumPy's binning. The data range, when not given, is found on the GPU and read by the counting
// kernel from a buffer, so nothing waits on the CPU.
import { rangeError, typeError } from '../../shared/errors.js';
import type { GpuArray } from './array.js';
import { Operand, fuse } from './expr.js';
import { BLOCK, LOCAL_BINS, histogramShader } from './shaders.js';
import { reduce } from './reduce.js';
import type { ComputeContext } from './context.js';

/** Options for histograms. */
export interface HistogramOptions {
  /** Number of equal bins. Default 64. */
  readonly bins?: number;
  /** Range [min, max] the bins cover; values outside are not counted. Default the data's own min and max. */
  readonly range?: readonly [number, number];
}

/** A histogram: per-bin counts and the `bins + 1` bin edges, both on the GPU. */
export interface Histogram {
  readonly counts: GpuArray<'u32'>;
  readonly edges: GpuArray<'f32'>;
}

// Writes range = [lo, hi] (from the reductions, or the given range) widened by 0.5 each side when lo == hi, as NumPy
// does, and the bin edges.
const rangeShader = (
  type: string,
) => /* wgsl */ `${type === 'f16' ? 'enable f16;\n' : ''}struct Given { lo: f32, hi: f32, bins: u32, given: u32 }
@group(0) @binding(0) var<storage, read> low: array<${type}>;
@group(0) @binding(1) var<storage, read> high: array<${type}>;
@group(0) @binding(2) var<storage, read_write> range: array<f32>;
@group(0) @binding(3) var<storage, read_write> edges: array<f32>;
@group(0) @binding(4) var<uniform> given: Given;
@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) id: vec3u) {
  var lo = given.lo;
  var hi = given.hi;
  if (given.given == 0u) { lo = f32(low[0]); hi = f32(high[0]); }
  if (lo == hi) { lo -= 0.5; hi += 0.5; }
  if (id.x == 0u) { range[0] = lo; range[1] = hi; }
  if (id.x <= given.bins) { edges[id.x] = lo + (hi - lo) * f32(id.x) / f32(given.bins); }
}`;

/** NumPy-style histogram (see ComputeContext.histogram). */
export function histogram(ctx: ComputeContext, input: Operand, options: HistogramOptions = {}): Histogram {
  ctx.check();
  if (!(input instanceof Operand)) throw typeError('histogram takes a GpuArray or an Expr', 'compute');
  const n = input.size,
    bins = options.bins ?? 64;
  if (!Number.isInteger(bins) || bins < 1)
    throw rangeError(`Histogram bins must be a whole number of at least 1, got ${bins}`, 'compute');
  let given = options.range;
  if (given) {
    const [lo, hi] = given;
    if (!Number.isFinite(lo) || !Number.isFinite(hi) || lo > hi)
      throw rangeError(`Histogram range must be finite [min, max] with min <= max, got [${lo}, ${hi}]`, 'compute');
  } else if (n === 0) given = [0, 1];
  const counts = ctx.empty([bins], 'u32'),
    edges = ctx.empty([bins + 1], 'f32'),
    range = ctx.empty([2], 'f32');
  // With a given range the reductions are skipped; a one-element placeholder fills their bindings.
  const low = given ? ctx.empty([1], 'f32') : reduce(ctx, input, 'min'),
    high = given ? low : reduce(ctx, input, 'max');
  const uniform = new DataView(new ArrayBuffer(16));
  uniform.setFloat32(0, given?.[0] ?? 0, true);
  uniform.setFloat32(4, given?.[1] ?? 0, true);
  uniform.setUint32(8, bins, true);
  uniform.setUint32(12, given ? 1 : 0, true);
  ctx.submit([
    {
      program: ctx.program(rangeShader(given ? 'f32' : input.dtype), undefined, 'histogram.range'),
      resources: { low, high, range, edges, given: new Uint8Array(uniform.buffer) },
      workgroups: [Math.ceil((bins + 1) / 64), 1, 1],
    },
  ]);
  if (n > 0) {
    const temporaries: GpuArray[] = [];
    const src = fuse(input, 0, ctx.maxStorage(2), temporaries);
    ctx.submit([
      {
        program: ctx.program(histogramShader(src, bins <= LOCAL_BINS), undefined, 'histogram'),
        resources: { ...src.resources, counts, range, params: new Uint32Array([n, bins, 0, 0]) },
        workgroups: ctx.grid(Math.ceil(n / BLOCK)),
      },
    ]);
    for (const t of temporaries) t.dispose();
  }
  low.dispose();
  if (high !== low) high.dispose();
  range.dispose();
  return { counts, edges };
}
