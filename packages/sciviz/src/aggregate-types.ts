import type { ComputeContext } from '@margoengine/compute';
import type { ColumnarTable, CrossFilter } from './table.js';

/** One row describes one primitive. Mesh rows carry cell values, never duplicated triangle vertices. */
export type AggregateGlyph = 'points' | 'lines' | 'areas' | 'triangles' | 'quads';
/** Physical-coordinate columns. Lines use x1/y1, triangles also x2/y2, quads also x3/y3. */
export interface RasterColumns {
  readonly x: string;
  readonly y: string;
  readonly x1?: string;
  readonly y1?: string;
  readonly x2?: string;
  readonly y2?: string;
  readonly x3?: string;
  readonly y3?: string;
  /** Area lower boundary at each endpoint. Default 0. */
  readonly baseline?: string;
  readonly baseline1?: string;
}
/** Every primitive is visited; no sampling, pre-binning, or float32 conversion of aggregate values. */
export interface RasterAggregateOptions {
  readonly columns: RasterColumns;
  /** Default points. */ readonly glyph?: AggregateGlyph;
  /** Increasing [xmin,xmax,ymin,ymax]. */ readonly bounds: readonly [number, number, number, number];
  /** Default 256 each, integers from 1 through 4096. */ readonly width?: number;
  readonly height?: number;
  /** Numeric column; default 1. Nulls and nonfinite values do not enter numeric statistics. */ readonly value?: string;
  /** Dictionary-encoded categorical column, optional. */ readonly category?: string;
  /** Optional GPU; omit for the exact CPU reference. */ readonly gpu?: ComputeContext;
  readonly signal?: AbortSignal;
  /** Bounded staging, default 32768, maximum 65536 rows. */ readonly chunkRows?: number;
}
/** Statistics for one bin. first/last are the first/last finite values in source row order. */
export interface RasterBin {
  readonly count: number;
  readonly valid: number;
  readonly sum: number;
  readonly mean: number;
  readonly min: number;
  readonly max: number;
  readonly first: number;
  readonly last: number;
  readonly firstRow: number | undefined;
  readonly lastRow: number | undefined;
  readonly categories: Readonly<Record<string, number>>;
}
/** Integer counts and order-independent exact binary64 sums, rounded once to nearest-even. */
export interface RasterAggregate {
  readonly width: number;
  readonly height: number;
  readonly bounds: readonly [number, number, number, number];
  readonly count: Uint32Array;
  readonly valid: Uint32Array;
  readonly sum: Float64Array;
  readonly mean: Float64Array;
  readonly min: Float64Array;
  readonly max: Float64Array;
  readonly first: Float64Array;
  readonly last: Float64Array;
  readonly firstRow: Uint32Array;
  readonly lastRow: Uint32Array;
  readonly categories: readonly string[];
  readonly categoricalCount: Uint32Array;
  readonly work: Readonly<{
    rows: number;
    primitives: number;
    contributions: number;
    rowBinTests: number;
    dispatches: number;
    /** Logical live buffer bound, including host/upload/readback copies and any filter bitmap; excludes driver/compiler memory. */
    peakStagingBytes: number;
    outputBytes: number;
  }>;
  /** Pixel indices have their origin at the lower left. */
  bin(x: number, y: number): RasterBin | undefined;
  /** Physical-coordinate hover, inclusive at the final upper edge. */
  at(x: number, y: number): RasterBin | undefined;
}
/** Borrowed columnar data or its exact crossfilter selection. */
export type RasterTable = ColumnarTable | CrossFilter;
