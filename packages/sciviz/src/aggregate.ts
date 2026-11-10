/// <reference lib="esnext.disposable" preserve="true" />
import { rangeError as makeRangeError } from '../../shared/errors.js';
import { CrossFilter, type TableColumn } from './table.js';
import { integerOf, LIMBS, numberOf, partialInteger, rounded, STATS, words } from './aggregate-exact.js';
import { covers } from './aggregate-raster.js';
import { aggregateShader } from './aggregate-shader.js';
import type {
  AggregateGlyph,
  RasterAggregate,
  RasterAggregateOptions,
  RasterBin,
  RasterTable,
} from './aggregate-types.js';
export type {
  AggregateGlyph,
  RasterColumns,
  RasterAggregateOptions,
  RasterAggregate,
  RasterBin,
  RasterTable,
} from './aggregate-types.js';
export { shadeAggregate, type AggregateShadeOptions } from './aggregate-shade.js';
export { bindRasterAggregate, type RasterBinding, type RasterBindingOptions } from './aggregate-figure.js';

const glyphs: readonly AggregateGlyph[] = ['points', 'lines', 'areas', 'triangles', 'quads'];
const missing = 0xffffffff;
const rangeError = (message: string, anchor: string) =>
  Object.assign(makeRangeError(message, anchor), { code: 'out-of-range' });
const valueAt = (column: TableColumn | undefined, row: number, fallback = NaN): number => {
  if (!column) return fallback;
  if (column.validity && !(column.validity[row >> 3] & (1 << (row & 7)))) return NaN;
  const raw = column.values[row];
  if (typeof raw === 'bigint' && (raw > BigInt(Number.MAX_SAFE_INTEGER) || raw < BigInt(Number.MIN_SAFE_INTEGER)))
    throw rangeError(
      'Raster numeric columns need exactly representable JavaScript values; rescale int64 columns',
      'sciviz',
    );
  return Number(raw);
};

/** Full row rasterisation and all reductions on GPU, or the exact CPU reference when gpu is omitted. */
export async function aggregateRaster(input: RasterTable, options: RasterAggregateOptions): Promise<RasterAggregate> {
  options.signal?.throwIfAborted();
  const table = input instanceof CrossFilter ? input.table : input,
    glyph = options.glyph ?? 'points',
    kind = glyphs.indexOf(glyph);
  const width = options.width ?? 256,
    height = options.height ?? 256,
    bins = width * height,
    bounds = [...options.bounds] as [number, number, number, number];
  const chunkRows = options.chunkRows ?? 32768;
  if (
    kind < 0 ||
    ![width, height].every((n) => Number.isInteger(n) && n >= 1 && n <= 4096) ||
    bins > 1048576 ||
    bounds.length !== 4 ||
    !bounds.every(Number.isFinite) ||
    !(bounds[1] > bounds[0]) ||
    !(bounds[3] > bounds[2]) ||
    !Number.isInteger(chunkRows) ||
    chunkRows < 1 ||
    chunkRows > 65536
  )
    throw rangeError(
      'Raster needs a known glyph, increasing finite bounds, dimensions 1..4096, at most 1048576 bins and chunkRows 1..65536',
      'sciviz',
    );
  const names = options.columns,
    vertexNames: (readonly [string, string])[] = [[names.x, names.y]];
  if (kind > 0) vertexNames.push([names.x1!, names.y1!]);
  if (kind >= 3) vertexNames.push([names.x2!, names.y2!]);
  if (kind === 4) vertexNames.push([names.x3!, names.y3!]);
  const numeric = (name: string): TableColumn => {
    const c = table.column(name);
    if (c.categories) throw rangeError('Raster coordinates and values must be numeric', 'sciviz');
    return c;
  };
  const columns = vertexNames.map(([x, y]) => [numeric(x), numeric(y)] as const),
    value = options.value ? numeric(options.value) : undefined;
  const base = names.baseline ? numeric(names.baseline) : undefined,
    base1 = names.baseline1 ? numeric(names.baseline1) : base;
  const category = options.category ? table.column(options.category) : undefined;
  if (category && !category.categories) throw rangeError('Raster category needs a dictionary-encoded column', 'sciviz');
  const categories = category?.categories ?? [],
    stride = STATS + LIMBS * 2 + categories.length;
  const mask = input instanceof CrossFilter ? input.bitmap : undefined;
  const count = new Uint32Array(bins),
    valid = new Uint32Array(bins),
    sums: bigint[] = Array(bins).fill(0n);
  const sum = new Float64Array(bins),
    mean = new Float64Array(bins).fill(NaN),
    min = new Float64Array(bins).fill(Infinity),
    max = new Float64Array(bins).fill(-Infinity);
  const first = new Float64Array(bins).fill(NaN),
    last = new Float64Array(bins).fill(NaN),
    firstRow = new Uint32Array(bins).fill(missing),
    lastRow = new Uint32Array(bins).fill(missing);
  if (bins * Math.max(1, categories.length) > 16777216)
    throw rangeError('Categorical raster exceeds 16777216 bin/category cells; partition the categories', 'sciviz');
  const categoricalCount = new Uint32Array(bins * categories.length);
  const gpu = options.gpu?.backend === 'cpu' ? undefined : options.gpu,
    outputBytes = bins * stride * 4;
  if (gpu && outputBytes > gpu.device.limits.maxStorageBufferBindingSize)
    throw rangeError(
      'Exact raster accumulator exceeds this GPU storage binding limit; reduce raster dimensions',
      'sciviz',
    );
  // Bounded dispatch work prevents a large canvas from turning one dispatch into an unresponsive GPU job.
  const chunk = Math.max(1, Math.min(chunkRows, Math.floor(8388608 / bins)));
  // Live logical buffers: host records, uploaded records, result, mapped readback, returned copy and uniforms.
  const peakStagingBytes =
    Math.min(chunk, table.length) * 64 * (gpu ? 2 : 1) + (gpu ? outputBytes * 3 + 16 : 0) + (mask?.byteLength ?? 0);
  let primitives = 0,
    contributions = 0,
    rowBinTests = 0,
    dispatches = 0;
  const output = gpu?.zeros(bins * stride, 'u32');
  const program = gpu?.kernel(aggregateShader(categories.length));
  const project = (v: number, axis: number): number => {
    const lo = bounds[axis * 2],
      hi = bounds[axis * 2 + 1],
      size = axis ? height : width;
    const scale = hi - lo;
    const p = Number.isFinite(scale) ? ((v - lo) / scale) * size : ((v / 2 - lo / 2) / (hi / 2 - lo / 2)) * size;
    let f = Math.fround(p);
    // Preserve exact point bin ownership when an f64 physical coordinate is within one f32 ulp of a bin edge.
    if (glyph === 'points' && p >= 0 && p <= size && Math.floor(f) !== Math.floor(p)) {
      const f32 = new Float32Array([f]);
      const bits = new Uint32Array(f32.buffer);
      bits[0] += f > p ? -1 : 1;
      f = f32[0];
    }
    return f;
  };
  try {
    for (let start = 0; start < table.length; start += chunk) {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      options.signal?.throwIfAborted();
      const n = Math.min(chunk, table.length - start),
        src = new Uint32Array(n * 16),
        floats = new Float32Array(src.buffer);
      for (let i = 0; i < n; i++) {
        const row = start + i,
          o = i * 16;
        if (mask && !(mask[row >>> 5] & (1 << (row & 31)))) continue;
        let present = true;
        for (let k = 0; k < columns.length; k++) {
          const x = valueAt(columns[k][0], row),
            y = valueAt(columns[k][1], row);
          present &&= Number.isFinite(x) && Number.isFinite(y);
          if (glyph === 'points') present &&= x >= bounds[0] && x <= bounds[1] && y >= bounds[2] && y <= bounds[3];
          floats[o + k * 2] = project(x, 0);
          floats[o + k * 2 + 1] = project(y, 1);
          present &&= Number.isFinite(floats[o + k * 2]) && Number.isFinite(floats[o + k * 2 + 1]);
        }
        if (glyph === 'areas') {
          const a = valueAt(base, row, 0),
            b = valueAt(base1, row, 0);
          present &&= Number.isFinite(a) && Number.isFinite(b);
          floats[o + 4] = floats[o + 2];
          floats[o + 5] = project(b, 1);
          floats[o + 6] = floats[o];
          floats[o + 7] = project(a, 1);
        }
        if (!present) continue;
        primitives++;
        src[o + 10] = 1;
        src[o + 12] = row;
        const v = valueAt(value, row, 1);
        if (Number.isFinite(v)) {
          const [lo, hi] = words(v);
          src[o + 8] = lo;
          src[o + 9] = hi;
          src[o + 10] |= 2;
        }
        src[o + 11] =
          category && (!category.validity || category.validity[row >> 3] & (1 << (row & 7)))
            ? Number(category.values[row])
            : missing;
      }
      rowBinTests += n * bins;
      if (gpu) {
        using source = gpu.array(src, { dtype: 'u32' });
        program!.run({ src: source, dst: output!, p: { count: n, width, height, glyph: kind } }, { count: bins });
        const partial = (await output!.read({ signal: options.signal })) as Uint32Array;
        dispatches++;
        for (let b = 0; b < bins; b++) {
          const o = b * stride,
            c = partial[o],
            v = partial[o + 1];
          count[b] += c;
          contributions += c;
          for (let k = 0; k < categories.length; k++)
            categoricalCount[b * categories.length + k] += partial[o + STATS + LIMBS * 2 + k];
          if (!v) continue;
          if (!valid[b]) {
            first[b] = numberOf(partial[o + 6], partial[o + 7]);
            firstRow[b] = partial[o + 10];
          }
          last[b] = numberOf(partial[o + 8], partial[o + 9]);
          lastRow[b] = partial[o + 11];
          valid[b] += v;
          min[b] = Math.min(min[b], numberOf(partial[o + 2], partial[o + 3]));
          max[b] = Math.max(max[b], numberOf(partial[o + 4], partial[o + 5]));
          sums[b] += partialInteger(partial, o + STATS);
        }
      } else {
        for (let i = 0; i < n; i++) {
          const o = i * 16,
            finite = !!(src[o + 10] & 2),
            v = finite ? numberOf(src[o + 8], src[o + 9]) : NaN;
          const exact = finite ? integerOf(src[o + 8], src[o + 9]) : 0n;
          for (let b = 0; b < bins; b++)
            if (covers(src, floats, i, b % width, Math.floor(b / width), width, height, glyph)) {
              count[b]++;
              contributions++;
              const categoryIndex = src[o + 11];
              if (categoryIndex < categories.length) categoricalCount[b * categories.length + categoryIndex]++;
              if (!finite) continue;
              if (!valid[b]) {
                first[b] = v;
                firstRow[b] = src[o + 12];
              }
              valid[b]++;
              last[b] = v;
              lastRow[b] = src[o + 12];
              min[b] = Math.min(min[b], v);
              max[b] = Math.max(max[b], v);
              sums[b] += exact;
            }
        }
      }
    }
  } finally {
    output?.dispose();
    program?.dispose();
  }
  for (let b = 0; b < bins; b++) {
    sum[b] = rounded(sums[b]);
    mean[b] = valid[b] ? rounded(sums[b], valid[b]) : NaN;
    if (!valid[b]) min[b] = max[b] = NaN;
  }
  const bin = (x: number, y: number): RasterBin | undefined => {
    if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || y < 0 || x >= width || y >= height) return undefined;
    const b = y * width + x;
    return {
      count: count[b],
      valid: valid[b],
      sum: sum[b],
      mean: mean[b],
      min: min[b],
      max: max[b],
      first: first[b],
      last: last[b],
      firstRow: firstRow[b] === missing ? undefined : firstRow[b],
      lastRow: lastRow[b] === missing ? undefined : lastRow[b],
      categories: Object.fromEntries(categories.map((name, k) => [name, categoricalCount[b * categories.length + k]])),
    };
  };
  return {
    width,
    height,
    bounds,
    count,
    valid,
    sum,
    mean,
    min,
    max,
    first,
    last,
    firstRow,
    lastRow,
    categories,
    categoricalCount,
    work: { rows: table.length, primitives, contributions, rowBinTests, dispatches, peakStagingBytes, outputBytes },
    bin,
    at(x, y) {
      if (
        !Number.isFinite(x) ||
        !Number.isFinite(y) ||
        x < bounds[0] ||
        x > bounds[1] ||
        y < bounds[2] ||
        y > bounds[3]
      )
        return undefined;
      return bin(Math.min(width - 1, Math.floor(project(x, 0))), Math.min(height - 1, Math.floor(project(y, 1))));
    },
  };
}
