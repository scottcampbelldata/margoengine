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
function shader(bins: number): string {
  // One independent invocation owns a 256-row tile. No float atomics, ordering races or replicated row scans.
  return `@group(0) @binding(0) var<storage,read> bins:array<u32>;
@group(0) @binding(1) var<storage,read> values:array<f32>;
@group(0) @binding(2) var<storage,read_write> result:array<f32>;
struct Params{count:u32};@group(0) @binding(3) var<uniform> params:Params;
@compute @workgroup_size(64) fn main(@builtin(global_invocation_id) id:vec3u){
let start=id.x*256u;if(start>=params.count){return;}
var counts:array<u32,${bins}>;var valid:array<u32,${bins}>;var sums:array<f32,${bins}>;var lows:array<f32,${bins}>;var highs:array<f32,${bins}>;
for(var b=0u;b<${bins}u;b++){counts[b]=0u;valid[b]=0u;sums[b]=0.0;lows[b]=3.402823466e+38;highs[b]=-3.402823466e+38;}
for(var r=start;r<min(start+256u,params.count);r++){let b=bins[r];if(b<${bins}u){counts[b]++;let v=values[r];if(abs(v)<=3.402823466e+38){valid[b]++;sums[b]+=v;lows[b]=min(lows[b],v);highs[b]=max(highs[b],v);}}}
for(var b=0u;b<${bins}u;b++){let o=(id.x*${bins}u+b)*5u;result[o]=f32(counts[b]);result[o+1u]=f32(valid[b]);result[o+2u]=sums[b];result[o+3u]=lows[b];result[o+4u]=highs[b];}}`;
}

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
  const chunkSize = Math.min(CHUNK, Math.max(TILE, Math.floor(8_388_608 / (bins * 5 * 4)) * TILE));
  const program = options.gpu?.kernel(shader(bins));
  try {
    for (let start = 0; start < table.length; start += chunkSize) {
      await new Promise<void>((resolve) => setTimeout(resolve, 0)); options.signal?.throwIfAborted();
      const n = Math.min(chunkSize, table.length - start), ids = new Uint32Array(n).fill(0xffffffff), values = new Float32Array(n).fill(NaN), tiles = Math.ceil(n / TILE);
      for (let i = 0; i < n; i++) {
        const row = start + i;
        if (mask && !(mask[row >>> 5] & (1 << (row & 31)))) continue;
        let bin = 0, stride = 1;
        for (const axis of axes) {
          const raw = table.value(axis.column, row), v = raw === null ? NaN : Number(raw), [lo, hi] = axis.range;
          if (!Number.isFinite(v) || v < lo || v > hi) { bin = -1; break; }
          bin += Math.min(axis.bins - 1, Math.floor((v - lo) / (hi - lo) * axis.bins)) * stride; stride *= axis.bins;
        }
        if (bin < 0) continue;
        ids[i] = bin; reducedRows++;
        const v = options.value ? table.value(options.value, row) : 1;
        if (v !== null && Number.isFinite(Number(v))) {
          const f = Math.fround(Number(v));
          if (!Number.isFinite(f)) throw rangeError('Aggregate value exceeds float32; rescale the value column', 'sciviz');
          values[i] = f;
        }
      }
      let partial: Float32Array;
      if (options.gpu) {
        using gpuIds = options.gpu.array(ids); using gpuValues = options.gpu.array(values); using output = options.gpu.zeros(tiles * bins * 5);
        program!.run({ bins: gpuIds, values: gpuValues, result: output, params: { count: n } }, { count: tiles });
        partial = await output.read({ signal: options.signal }) as Float32Array; passes++;
      } else {
        partial = new Float32Array(tiles * bins * 5);
        for (let tile = 0; tile < tiles; tile++) {
          for (let b = 0; b < bins; b++) { const o = (tile * bins + b) * 5; partial[o + 3] = Infinity; partial[o + 4] = -Infinity; }
          for (let i = tile * TILE; i < Math.min(n, (tile + 1) * TILE); i++) {
            const b = ids[i]; if (b >= bins) continue; const o = (tile * bins + b) * 5; partial[o]++;
            if (Number.isFinite(values[i])) { partial[o + 1]++; partial[o + 2] += values[i]; partial[o + 3] = Math.min(partial[o + 3], values[i]); partial[o + 4] = Math.max(partial[o + 4], values[i]); }
          }
        }
      }
      partialBins += tiles * bins;
      for (let tile = 0; tile < tiles; tile++) for (let b = 0; b < bins; b++) {
        const o = (tile * bins + b) * 5; count[b] += partial[o]; valid[b] += partial[o + 1]; sum[b] += partial[o + 2];
        if (!Number.isFinite(sum[b])) throw rangeError('Aggregate sum exceeds float32 per tile; rescale the value column', 'sciviz');
        if (partial[o + 1]) { min[b] = Math.min(min[b], partial[o + 3]); max[b] = Math.max(max[b], partial[o + 4]); }
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
      : await figure.bar({ x: Float64Array.from({ length: next.nx }, (_, i) => options.x.range[0] + (i + 0.5) * (options.x.range[1] - options.x.range[0]) / next.nx), y: values }, { width: (options.x.range[1] - options.x.range[0]) / next.nx });
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
