import type { ComputeContext } from '@margoengine/compute';
import { fault, rangeError } from '../../shared/errors.js';
import type { Figure } from './figure.js';
import type { RectsLayer } from './rects.js';
import { ColumnarTable, CrossFilter } from './table.js';

/** Equal-width bins, inclusive at the final upper edge. A second axis makes a heatmap. */
export interface TableAggregateOptions {
  readonly x: { readonly column: string; readonly bins: number; readonly range: readonly [number, number] };
  readonly y?: { readonly column: string; readonly bins: number; readonly range: readonly [number, number] };
  readonly value?: string;
  readonly gpu?: ComputeContext;
  readonly signal?: AbortSignal;
}
/** Row counts include missing values; valid counts and numeric statistics exclude null/NaN/Infinity. */
export interface TableAggregate {
  readonly count: Uint32Array;
  readonly valid: Uint32Array;
  readonly sum: Float64Array;
  readonly mean: Float64Array;
  readonly min: Float32Array;
  readonly max: Float32Array;
  readonly nx: number;
  readonly ny: number;
  readonly work: { readonly rows: number; readonly reducedRows: number; readonly partialBins: number; readonly passes: number };
}
const TILE = 256, CHUNK = 262144;
/** Bin width; halves first so a finite range wider than the largest double still has a finite width. */
const binWidth = (lo: number, hi: number, bins: number): number => Number.isFinite(hi - lo) ? (hi - lo) / bins : (hi / 2 - lo / 2) / (bins / 2);
/** Bin i holds lo + i w <= v < lo + (i + 1) w, the last bin also hi: the edges drawn for the bars. The quotient
 * only estimates the bin; rounding can put a value on an edge one bin off, so the edges themselves decide. */
function binIndex(v: number, lo: number, hi: number, bins: number): number {
  const w = binWidth(lo, hi, bins);
  const q = Number.isFinite(v - lo) ? (v - lo) / w : (v / 2 - lo / 2) / (w / 2);
  let i = q >= 0 ? Math.min(bins - 1, Math.floor(q)) : 0;
  while (i > 0 && v < lo + i * w) i--;
  while (i < bins - 1 && v >= lo + (i + 1) * w) i++;
  return i;
}
// One invocation per (tile, bin) segment: the host sorts each 256-row tile's finite values by bin in row order, so
// an invocation sums one contiguous run with no per-bin arrays (WGSL caps function variables at 8192 bytes; 4096
// bins of five arrays were 80 KB) and makes three stores (the WebGL2 layer's scatter tier). No NaN reaches the shader.
const SHADER = `@group(0) @binding(0) var<storage,read> offsets:array<u32>;
@group(0) @binding(1) var<storage,read> values:array<f32>;
@group(0) @binding(2) var<storage,read_write> result:array<f32>;
struct Params{count:u32};@group(0) @binding(3) var<uniform> params:Params;
@compute @workgroup_size(64) fn main(@builtin(global_invocation_id) id:vec3u){
let i=id.x;if(i>=params.count){return;}
var sum=0.0;var lo=3.402823466e+38;var hi=-3.402823466e+38;
for(var r=offsets[i];r<offsets[i+1u];r++){let v=values[r];sum+=v;lo=min(lo,v);hi=max(hi,v);}
result[i*3u]=sum;result[i*3u+1u]=lo;result[i*3u+2u]=hi;}`;

/** Stable f32 tile reductions on GPU (when supplied) or CPU, merged in float64 on the host. */
export async function aggregateTable(input: ColumnarTable | CrossFilter, options: TableAggregateOptions): Promise<TableAggregate> {
  const table = input instanceof CrossFilter ? input.table : input, axes = [options.x, ...(options.y ? [options.y] : [])];
  for (const axis of axes) {
    const col = table.column(axis.column);
    if (col.categories || !Number.isInteger(axis.bins) || axis.bins < 1 || axis.range.length !== 2 || !axis.range.every(Number.isFinite) || !(axis.range[1] > axis.range[0]))
      throw rangeError('Aggregation axes need numeric columns, positive bin counts and increasing finite ranges', 'sciviz');
  }
  const nx = options.x.bins, ny = options.y?.bins ?? 1, bins = nx * ny;
  if (bins > 4096) throw rangeError('Aggregation supports at most 4096 bins per call', 'sciviz');
  if (options.value && table.column(options.value).categories) throw rangeError('Aggregate values must be numeric', 'sciviz');
  const mask = input instanceof CrossFilter ? input.bitmap : undefined;
  const count = new Uint32Array(bins), valid = new Uint32Array(bins), sum = new Float64Array(bins), mean = new Float64Array(bins), min = new Float32Array(bins).fill(Infinity), max = new Float32Array(bins).fill(-Infinity);
  let reducedRows = 0, partialBins = 0, passes = 0;
  const chunkSize = Math.min(CHUNK, Math.max(TILE, Math.floor(8_388_608 / (bins * 3 * 4)) * TILE));
  const program = options.gpu?.kernel(SHADER);
  try {
    for (let start = 0; start < table.length; start += chunkSize) {
      await new Promise<void>((resolve) => setTimeout(resolve, 0)); options.signal?.throwIfAborted();
      const n = Math.min(chunkSize, table.length - start), tiles = Math.ceil(n / TILE), segments = tiles * bins;
      // Segment (tile, bin) holds that tile's rows in that bin; its finite values sit in order at offsets[s]..offsets[s + 1].
      const ids = new Int32Array(n).fill(-1), values = new Float32Array(n).fill(NaN), rows = new Uint32Array(segments), offsets = new Uint32Array(segments + 1);
      for (let i = 0; i < n; i++) {
        const row = start + i;
        if (mask && !(mask[row >>> 5] & (1 << (row & 31)))) continue;
        let bin = 0, stride = 1;
        for (const axis of axes) {
          const raw = table.value(axis.column, row), v = raw === null ? NaN : Number(raw), [lo, hi] = axis.range;
          if (!Number.isFinite(v) || v < lo || v > hi) { bin = -1; break; }
          bin += binIndex(v, lo, hi, axis.bins) * stride; stride *= axis.bins;
        }
        if (bin < 0) continue;
        const segment = Math.floor(i / TILE) * bins + bin; ids[i] = segment; rows[segment]++; reducedRows++;
        const v = options.value ? table.value(options.value, row) : 1;
        if (v !== null && Number.isFinite(Number(v))) {
          const f = Math.fround(Number(v));
          if (!Number.isFinite(f)) throw rangeError('Aggregate value exceeds float32; rescale the value column', 'sciviz');
          values[i] = f; offsets[segment + 1]++;
        }
      }
      for (let k = 0; k < segments; k++) offsets[k + 1] += offsets[k];
      const sorted = new Float32Array(Math.max(1, offsets[segments])), next = offsets.slice(0, segments);
      for (let i = 0; i < n; i++) if (ids[i] >= 0 && !Number.isNaN(values[i])) sorted[next[ids[i]]++] = values[i];
      let partial: Float32Array;
      if (options.gpu) {
        using gpuOffsets = options.gpu.array(offsets); using gpuValues = options.gpu.array(sorted); using output = options.gpu.zeros(segments * 3);
        program!.run({ offsets: gpuOffsets, values: gpuValues, result: output, params: { count: segments } }, { count: segments });
        partial = await output.read({ signal: options.signal }) as Float32Array; passes++;
      } else {
        partial = new Float32Array(segments * 3);
        for (let k = 0; k < segments; k++) {
          let lo = Infinity, hi = -Infinity;
          for (let r = offsets[k]; r < offsets[k + 1]; r++) { partial[k * 3] += sorted[r]; lo = Math.min(lo, sorted[r]); hi = Math.max(hi, sorted[r]); }
          partial[k * 3 + 1] = lo; partial[k * 3 + 2] = hi;
        }
      }
      partialBins += segments;
      for (let k = 0; k < segments; k++) {
        const b = k % bins, finite = offsets[k + 1] - offsets[k]; count[b] += rows[k]; valid[b] += finite; sum[b] += partial[k * 3];
        if (!Number.isFinite(sum[b])) throw rangeError('Aggregate sum exceeds float32 per tile; rescale the value column', 'sciviz');
        if (finite) { min[b] = Math.min(min[b], partial[k * 3 + 1]); max[b] = Math.max(max[b], partial[k * 3 + 2]); }
      }
    }
  } finally { program?.dispose(); }
  for (let b = 0; b < bins; b++) { mean[b] = valid[b] ? sum[b] / valid[b] : NaN; if (!valid[b]) min[b] = max[b] = NaN; }
  return { count, valid, sum, mean, min, max, nx, ny, work: { rows: table.length, reducedRows, partialBins, passes } };
}

/** Recompute and replace one chart after filter changes. Await refresh() to observe errors. */
export interface AggregateBinding {
  readonly layer: RectsLayer | undefined;
  readonly result: TableAggregate | undefined;
  readonly error: unknown;
  refresh(): Promise<void>;
  dispose(): void;
  [Symbol.dispose](): void;
}
/** Filtered histograms/bars use exact bin edges; heatmaps use x/y bins. Defaults to count. */
export function bindTableAggregate(filter: CrossFilter, figure: Figure, options: TableAggregateOptions & { readonly kind?: 'histogram' | 'bar' | 'heatmap'; readonly statistic?: 'count' | 'sum' | 'mean' | 'min' | 'max' }): AggregateBinding {
  let layer: RectsLayer | undefined, result: TableAggregate | undefined, error: unknown, disposed = false, generation = 0, requestedVersion = -1;
  let pending: Promise<void> | undefined;
  const update = async () => {
    if (disposed) throw fault('state', 'Aggregate binding is disposed', 'sciviz');
    const g = ++generation, next = await aggregateTable(filter, options);
    if (disposed || g !== generation) return;
    const values = Float32Array.from(next[options.statistic ?? 'count'], (v) => Number.isFinite(v) ? v : 0);
    const pending = options.kind === 'heatmap' || options.y
      ? await figure.heatmap(values, { nx: next.nx, ny: next.ny, x: options.x.range, y: options.y?.range })
      : await figure.bar({ x: Float64Array.from({ length: next.nx }, (_, i) => options.x.range[0] + (i + 0.5) * binWidth(options.x.range[0], options.x.range[1], next.nx)), y: values }, { width: binWidth(options.x.range[0], options.x.range[1], next.nx) });
    if (disposed || g !== generation) { figure.remove(pending); return; }
    if (layer) figure.remove(layer); layer = pending; result = next; error = undefined;
  };
  const refresh = () => {
    if (disposed) return Promise.reject(fault('state', 'Aggregate binding is disposed', 'sciviz'));
    if (pending && requestedVersion === filter.version) return pending;
    requestedVersion = filter.version;
    pending = update();
    return pending;
  };
  const change = () => { void refresh().catch((e: unknown) => { error = e; }); };
  filter.addEventListener('change', change);
  const dispose = () => { if (disposed) return; disposed = true; generation++; filter.removeEventListener('change', change); if (layer) figure.remove(layer); layer = undefined; };
  return { get layer() { return layer; }, get result() { return result; }, get error() { return error; }, refresh, dispose, [Symbol.dispose]: dispose };
}
