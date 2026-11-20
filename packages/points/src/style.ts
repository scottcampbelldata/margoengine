// Attribute filters and per-point style expressions: Potree's attribute filters (classification, return number, number
// of returns, GPS time, point source, intensity) and the OGC 3D Tiles styling language (show, color, pointSize,
// defines), evaluated on the CPU over a cloud's attribute columns. Clean room; sources in docs/clean-room.md.
import { MargoError } from '@margoengine/math/errors';
import { SRGBToLinear } from '@margoengine/math/color';
import type { PointCloud } from './cloud.js';
import type { OctreeNode, OctreeNodeData, OctreeSource, PointAttribute } from './octree.js';
import { subsetCloud } from './survey.js';
import {
  expression,
  styleProperty,
  vector,
  type StyleEvaluator,
  type StyleRead,
  type StyleSource,
} from '../../shared/style-expression.js';

/** A style property: an expression string, a literal, or `{conditions: [[test, result], ...]}` (first true wins). */
export type PointStyleExpression = StyleSource;

/** An inclusive `[min, max]` range; either end may be `-Infinity` or `Infinity`. */
export type PointRange = readonly [number, number];

/**
 * Potree-style attribute filters. A point is shown when it passes every filter given. Column names are looked up as
 * described in {@link PointTable}, so `returnNumber` also finds a `return_number` column.
 */
export interface PointFilter {
  /** ASPRS classes to show; every other class is hidden. Default all. */
  classification?: readonly number[];
  returnNumber?: PointRange;
  numberOfReturns?: PointRange;
  gpsTime?: PointRange;
  pointSourceId?: PointRange;
  intensity?: PointRange;
  scanAngle?: PointRange;
  userData?: PointRange;
  /** Ranges of any other numeric column, by name (an extra bytes attribute, for example). */
  ranges?: Readonly<Record<string, PointRange>>;
}

/** Options of {@link PointStyle}: the point cloud properties of an OGC 3D Tiles style, plus Potree filters. */
export interface PointStyleOptions {
  /** Boolean expression; hidden points are not drawn. Default true. */
  show?: PointStyleExpression;
  /** Color expression (`color()`, `rgb()`, `hsl()`, `vec4`), sRGB. Default: the point keeps its own colour. */
  color?: PointStyleExpression;
  /** Point size in the material's units (pixels by default, as in 3D Tiles). Default: the point keeps its size. */
  pointSize?: PointStyleExpression;
  /** Named expressions, read as `${name}`; inside a define `${name}` is the column of that name. */
  defines?: Readonly<Record<string, string>>;
  /** Attribute filters, combined with `show` (both must pass). */
  filter?: PointFilter;
}

/**
 * Per-point attribute columns, one value per point or `k` values per point (2 to 4, read as a vector): a `LASPoints`
 * from `margoengine/points/las` as it is, an octree node's `attributes`, or any object of typed arrays. A style reads
 * `${name}` by its exact key first, then by the key that matches ignoring case, `_`, `-` and spaces (`${Classification}`
 * finds `classification`, `${gps_time}` finds `gpsTime`). Point semantics: `${POSITION}` (from `positions`),
 * `${POSITION_ABSOLUTE}` (plus `origin`, then `matrix`), `${COLOR}` (from `colors`, or 16-bit `rgb`) and `${NORMAL}`
 * (from `normals`).
 */
export type PointTable = object;

/** Options of {@link PointStyle.evaluate}. */
export interface PointStyleEvaluateOptions {
  /** Points to style. Default `positions.length / 3`, or the length of the first column. */
  count?: number;
  /** Column-major local-to-world matrix for `${POSITION_ABSOLUTE}`. Default identity. */
  matrix?: ArrayLike<number>;
  signal?: AbortSignal;
}

/** One evaluation of a style over every point. */
export interface PointStyleResult {
  readonly count: number;
  /** 1 for a shown point, 0 for a hidden one. */
  readonly show: Uint8Array;
  /** Points shown. */
  readonly shown: number;
  /** sRGB RGBA in 0..1 per point (a point with no matching condition keeps its own colour), or null without `color`. */
  readonly colors: Float32Array | null;
  /** Size per point, NaN where no condition matched, or null without `pointSize`. Hidden points read NaN. */
  readonly sizes: Float32Array | null;
}

const key = (name: string) => name.toLowerCase().replace(/[\s_-]/g, '');
const isColumn = (v: unknown): v is ArrayLike<unknown> =>
  ArrayBuffer.isView(v) ? !(v instanceof DataView) : Array.isArray(v);
const SEMANTICS = ['POSITION', 'POSITION_ABSOLUTE', 'COLOR', 'NORMAL'];
const unit = (v: number) => (v > 0 ? (v < 1 ? v : 1) : 0);

/** Column lookup over a table, by exact key, then by loose key. */
function columns(table: PointTable, count: number) {
  const record = table as Record<string, unknown>,
    loose = new Map<string, string>(),
    cache = new Map<string, ((i: number) => unknown) | undefined>();
  for (const name of Object.keys(record)) if (!loose.has(key(name))) loose.set(key(name), name);
  return (name: string): ((i: number) => unknown) | undefined => {
    if (cache.has(name)) return cache.get(name);
    const found = Object.hasOwn(record, name) ? name : loose.get(key(name)),
      column = found === undefined ? undefined : record[found];
    let get: ((i: number) => unknown) | undefined;
    if (isColumn(column)) {
      const k = column.length / Math.max(count, 1);
      if (column.length === count) get = (i) => column[i];
      else if (k === 2 || k === 3 || k === 4)
        get = (i) => vector(Array.prototype.slice.call(column, i * k, i * k + k) as number[]);
      else
        throw new RangeError(
          `Point column ${found} holds ${column.length} values for ${count} points; pass 1 to 4 values a point`,
        );
    }
    cache.set(name, get);
    return get;
  };
}

/** The point semantics of the Styling specification's "Point Cloud" section, over a table. */
function semantics(table: PointTable, count: number, matrix?: ArrayLike<number>) {
  const t = table as Record<string, unknown>,
    positions = isColumn(t.positions) ? (t.positions as ArrayLike<number>) : undefined,
    normals = isColumn(t.normals) ? (t.normals as ArrayLike<number>) : undefined,
    origin = isColumn(t.origin) && t.origin.length === 3 ? (t.origin as ArrayLike<number>) : [0, 0, 0],
    m = matrix ?? [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
    colors = isColumn(t.colors) ? (t.colors as ArrayLike<number>) : undefined,
    rgb = isColumn(t.rgb) ? (t.rgb as ArrayLike<number>) : undefined;
  if (m.length !== 16 || !Array.from(m).every(Number.isFinite))
    throw new TypeError('Pass a finite column-major matrix of 16 numbers');
  for (const [name, values] of [
    ['positions', positions],
    ['normals', normals],
  ] as const)
    if (values && values.length !== count * 3)
      throw new RangeError(`Point ${name} hold ${values.length} values for ${count} points; pass 3 a point`);
  let color: ((i: number) => number[]) | undefined;
  if (colors) {
    const k = colors.length / Math.max(count, 1),
      scale = colors instanceof Uint8Array || colors instanceof Uint8ClampedArray ? 255 : 1;
    if (k !== 3 && k !== 4)
      throw new RangeError(`Point colors hold ${colors.length} values for ${count} points; pass 3 or 4 a point`);
    color = (i) => [0, 1, 2, 3].map((c) => (c < k ? colors[i * k + c] / scale : 1));
  } else if (rgb) {
    if (rgb.length !== count * 3)
      throw new RangeError(`Point rgb holds ${rgb.length} values for ${count} points; pass 3 a point`);
    // LAS stores 16-bit colour; files with 8-bit values in 16-bit fields keep them as they are, as rgb16ToRgba8 does.
    let wide = false;
    for (let i = 0; i < rgb.length && !wide; i++) wide = rgb[i] > 255;
    const scale = wide ? 65535 : 255;
    color = (i) => [rgb[i * 3] / scale, rgb[i * 3 + 1] / scale, rgb[i * 3 + 2] / scale, 1];
  }
  const xyz = (values: ArrayLike<number>, i: number) => [values[i * 3], values[i * 3 + 1], values[i * 3 + 2]];
  return (name: string, i: number): unknown => {
    if (name === 'POSITION') return positions && vector(xyz(positions, i));
    if (name === 'POSITION_ABSOLUTE') {
      if (!positions) return undefined;
      const [x, y, z] = xyz(positions, i).map((v, c) => v + origin[c]),
        w = m[3] * x + m[7] * y + m[11] * z + m[15];
      return vector([0, 1, 2].map((c) => (m[c] * x + m[4 + c] * y + m[8 + c] * z + m[12 + c]) / w));
    }
    if (name === 'COLOR') return vector(color ? color(i) : [1, 1, 1, 1]);
    return normals && vector(xyz(normals, i));
  };
}

const FILTERS = [
  'returnNumber',
  'numberOfReturns',
  'gpsTime',
  'pointSourceId',
  'intensity',
  'scanAngle',
  'userData',
] as const;

function checkRange(name: string, range: unknown): PointRange {
  if (
    !Array.isArray(range) ||
    range.length !== 2 ||
    range.some((v) => typeof v !== 'number' || Number.isNaN(v)) ||
    range[0] > range[1]
  )
    throw new RangeError(`Filter ${name} is an ascending [min, max] range of numbers; pass two numbers`);
  return [range[0], range[1]];
}

/** The compiled parts of a style, kept off its public surface. */
interface Compiled {
  show?: StyleEvaluator;
  color?: StyleEvaluator;
  pointSize?: StyleEvaluator;
  defines: Map<string, StyleEvaluator>;
  ranges: [string, number, number][];
  classes?: Uint8Array;
}
const COMPILED = new WeakMap<PointStyle, Compiled>();

/**
 * A compiled point style: OGC 3D Tiles styling (show, color, pointSize, defines, conditions, vectors, maths, regular
 * expressions) plus Potree attribute filters. Compile once; evaluate it over any number of tables.
 */
export class PointStyle {
  /** The options it was compiled from. */
  readonly options: Readonly<PointStyleOptions>;
  /** Throws MargoError `state` for an expression that does not parse, RangeError for a malformed filter. */
  constructor(options: PointStyleOptions = {}) {
    if (!options || typeof options !== 'object')
      throw new TypeError('A point style is an object; pass {show, color, pointSize, defines, filter}');
    this.options = options;
    const c: Compiled = { defines: new Map(), ranges: [] };
    COMPILED.set(this, c);
    if (options.show !== undefined && options.show !== true) c.show = styleProperty(options.show, true);
    if (options.color !== undefined) c.color = styleProperty(options.color, undefined);
    if (options.pointSize !== undefined) c.pointSize = styleProperty(options.pointSize, undefined);
    c.defines = new Map(
      Object.entries(options.defines ?? {}).map(([name, source]) => {
        if (typeof source !== 'string')
          throw new TypeError(`Define ${name} is not a string; pass an expression string`);
        return [name, expression(source)];
      }),
    );
    const filter = options.filter ?? {};
    if (typeof filter !== 'object') throw new TypeError('A point filter is not an object; pass an object of ranges');
    for (const name of FILTERS)
      if (filter[name] !== undefined) c.ranges.push([name, ...checkRange(name, filter[name])]);
    for (const [name, range] of Object.entries(filter.ranges ?? {})) c.ranges.push([name, ...checkRange(name, range)]);
    if (filter.classification !== undefined) {
      const classes = filter.classification;
      if (!Array.isArray(classes) || classes.some((k) => !Number.isInteger(k) || k < 0 || k > 255))
        throw new RangeError(
          'Filter classification holds a class outside 0 to 255; pass the integer ASPRS classes to show',
        );
      c.classes = new Uint8Array(256);
      for (const k of classes) c.classes[k] = 1;
    }
  }

  /** Whether the style hides any point it is given: a show expression or a filter. */
  get filters(): boolean {
    const c = COMPILED.get(this)!;
    return c.show !== undefined || c.ranges.length > 0 || c.classes !== undefined;
  }

  /**
   * Evaluates the style for every point of `table`. Throws MargoError `state` when an expression gives the wrong
   * type for a point (show not a boolean, color not four finite numbers, pointSize not a finite number of 0 or more),
   * TypeError when a filter names a column the table lacks.
   */
  evaluate(table: PointTable, options: PointStyleEvaluateOptions = {}): PointStyleResult {
    return run(this, table, options);
  }
}

/**
 * Evaluation in a cloud's stored order: `rows` maps a point to its table row, and `local` gives the
 * cloud's own colours (for `${COLOR}`) and its stored positions and normals when the table has none.
 */
function run(
  style: PointStyle,
  table: PointTable,
  options: PointStyleEvaluateOptions,
  rows?: ArrayLike<number> | null,
  local?: Local,
): PointStyleResult {
  const c = COMPILED.get(style)!;
  if (!table || typeof table !== 'object') throw new TypeError('Pass a table of per-point columns');
  const t = table as Record<string, unknown>;
  let count = options.count;
  if (count === undefined) {
    const first = isColumn(t.positions) ? t.positions.length / 3 : Object.values(t).find(isColumn)?.length;
    count = first ?? 0;
  }
  if (!Number.isSafeInteger(count) || count < 0) throw new RangeError('Pass a whole number of points');
  if (rows && rows.length !== count) throw new RangeError('Pass one table row per point');
  const column = columns(table, count),
    semantic = semantics(table, count, options.matrix),
    stored =
      local && !isColumn(t.positions)
        ? semantics({ positions: local.positions, normals: local.normals ?? undefined }, count, options.matrix)
        : undefined;
  const filters = c.ranges.map(([name, lo, hi]) => {
    const get = column(name);
    if (!get) throw new TypeError(`The point table has no ${name} column to filter; pass one or drop the filter`);
    return [get, lo, hi] as const;
  });
  const classes = c.classes,
    classOf = classes && column('classification');
  if (classes && !classOf)
    throw new TypeError('The point table has no classification column to filter; pass one or drop the filter');
  let row = 0,
    point = 0;
  const raw: StyleRead = (name) =>
    !SEMANTICS.includes(name)
      ? column(name)?.(row)
      : name === 'COLOR' && local
        ? vector(local.color(point))
        : stored && name !== 'COLOR'
          ? stored(name, point)
          : semantic(name, row);
  const read: StyleRead = (name) => (c.defines.has(name) ? c.defines.get(name)!(raw) : raw(name));
  const show = new Uint8Array(count),
    colors = c.color ? new Float32Array(count * 4) : null,
    sizes = c.pointSize ? new Float32Array(count).fill(Number.NaN) : null;
  let shown = 0;
  for (point = 0; point < count; point++) {
    if (!(point & 4095)) options.signal?.throwIfAborted();
    row = rows ? rows[point] : point;
    let visible = true;
    for (const [get, lo, hi] of filters) {
      const v = get(row) as number;
      if (!(v >= lo && v <= hi)) visible = false;
    }
    if (visible && classes && !classes[(classOf!(row) as number) & 255]) visible = false;
    if (visible && c.show) {
      const v = c.show(read);
      if (typeof v !== 'boolean')
        throw new MargoError('state', 'Style show must return a boolean; compare the property explicitly');
      visible = v;
    }
    if (!visible) continue;
    show[point] = 1;
    shown++;
    if (colors) {
      let rgba = c.color!(read) as number[] | undefined;
      if (rgba === undefined) rgba = read('COLOR') as number[];
      if (!Array.isArray(rgba) || rgba.length !== 4 || rgba.some((v) => typeof v !== 'number' || !Number.isFinite(v)))
        throw new MargoError('state', 'Style color must return four finite components; use color(), rgb() or vec4()');
      for (let k = 0; k < 4; k++) colors[point * 4 + k] = unit(rgba[k]);
    }
    if (sizes) {
      const s = c.pointSize!(read);
      if (s === undefined) continue;
      if (typeof s !== 'number' || !Number.isFinite(s) || s < 0)
        throw new MargoError('state', 'Style pointSize must return a finite number of 0 or more; clamp it');
      sizes[point] = s;
    }
  }
  return { count, show, shown, colors, sizes };
}

/** A cloud's own data for styling in its stored order. */
interface Local {
  color(point: number): number[];
  /** The colours as they were, for an exact restore: RGBA floats, or packed RGBA8 words. */
  floats: Float32Array | null;
  packed: Uint32Array | null;
  positions: Float32Array;
  normals?: Float32Array | null;
}

const toSRGB = (v: number) => (v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055);
/** sRGB RGBA in 0..1 of a cloud's own colour at stored index i, from a snapshot of its colours. */
function ownColors(cloud: PointCloud): Local {
  const floats = cloud.floatColors?.slice() ?? null,
    packed = floats ? null : (cloud.colors?.slice() ?? null),
    linear = cloud.colorSpace === 'linear';
  return {
    floats,
    packed,
    positions: cloud.positions,
    normals: cloud.normals,
    color: (i) =>
      floats
        ? [0, 1, 2, 3].map((c) => (c < 3 && linear ? toSRGB(unit(floats[i * 4 + c])) : unit(floats[i * 4 + c])))
        : packed
          ? [0, 8, 16, 24].map((s) => ((packed[i] >>> s) & 255) / 255)
          : [1, 1, 1, 1],
  };
}

/** Writes sRGB RGBA (0..1) colours to a cloud in its own format and colour space. */
function writeColors(cloud: PointCloud, color: (i: number) => ArrayLike<number>): void {
  const linear = cloud.colorSpace === 'linear',
    rgba = cloud.colorFormat === 'float' ? new Float32Array(cloud.count * 4) : new Uint8Array(cloud.count * 4);
  for (let i = 0; i < cloud.count; i++) {
    const c = color(i);
    for (let k = 0; k < 4; k++) {
      const v = k < 3 && linear ? SRGBToLinear(c[k]) : c[k];
      rgba[i * 4 + k] = rgba instanceof Uint8Array ? Math.round(v * 255) : v;
    }
  }
  if (cloud.colors) cloud.updateColors(0, rgba, 4);
  else cloud.setColors(rgba, 4);
  cloud.colorComponents = 4;
}

/** Writes sizes (material units, NaN to keep `kept(i)`) as the cloud's per-point size multipliers. */
function writeSizes(cloud: PointCloud, sizes: Float32Array, kept: (i: number) => number): void {
  const base = cloud.material.size,
    out = new Float32Array(cloud.count);
  for (let i = 0; i < cloud.count; i++) out[i] = Number.isNaN(sizes[i]) ? kept(i) : base > 0 ? sizes[i] / base : 0;
  if (cloud.sizes) cloud.updateSizes(0, out);
  else cloud.setSizes(out);
}

const styleOf = (style: PointStyle | PointStyleOptions) =>
  style instanceof PointStyle ? style : new PointStyle(style);

/** A live style on one cloud: `update` restyles it, `dispose` (or `using`) puts back what it had. */
export interface PointStyleBinding extends Disposable {
  /** The latest evaluation. */
  readonly result: PointStyleResult;
  /** Evaluates `style` (or the current one again, after the table changed) and writes it to the cloud. */
  update(style?: PointStyle | PointStyleOptions): PointStyleResult;
  /** Restores the colours, sizes and selection mask the cloud had when bound. */
  dispose(): void;
}

/** Options of {@link bindPointStyle}. */
export interface BindPointStyleOptions {
  /** Column-major matrix for `${POSITION_ABSOLUTE}`. Default the cloud's `matrix`. */
  matrix?: ArrayLike<number>;
  signal?: AbortSignal;
}

/**
 * Styles a cloud in place from its table (rows in the cloud's source order, so a `reorder`ed cloud reads its
 * `sourceIndex`). Colours replace the cloud's per-point colours (`${COLOR}` reads the colours it had when bound),
 * point sizes its per-point sizes, and hidden points go through the cloud's selection mask in `'filter'` mode, so they
 * draw nothing and cannot be picked while the cloud keeps its order and buffers. The binding owns the mask while it
 * lives. Nothing on the cloud changes when an evaluation throws.
 */
export function bindPointStyle(
  cloud: PointCloud,
  table: PointTable,
  style: PointStyle | PointStyleOptions,
  options: BindPointStyleOptions = {},
): PointStyleBinding {
  const local = ownColors(cloud),
    components = cloud.colorComponents,
    sizes = cloud.sizes?.slice() ?? null,
    mask = cloud.mask ? Uint8Array.from({ length: cloud.count }, (_, i) => +cloud.isSelected(i)) : null,
    maskStyle = cloud.maskStyle;
  let current = styleOf(style),
    disposed = false,
    colored = false,
    sized = false,
    masked = false,
    result: PointStyleResult;
  const restoreColors = () => {
    if (!colored) return;
    cloud.setColors(
      local.floats ? local.floats.slice() : local.packed && new Uint8Array(local.packed.slice().buffer),
      4,
    );
    cloud.colorComponents = components;
    colored = false;
  };
  const restoreSizes = () => {
    if (sized) cloud.setSizes(sizes && sizes.slice());
    sized = false;
  };
  const restoreMask = () => {
    if (masked) cloud.setMask(mask, maskStyle);
    masked = false;
  };
  const apply = (next: PointStyle): PointStyleResult => {
    // Evaluate first, so a style that throws leaves the cloud as it was.
    const r = run(
      next,
      table,
      { count: cloud.count, matrix: options.matrix ?? cloud.matrix, signal: options.signal },
      cloud.sourceIndex,
      local,
    );
    const colors = r.colors;
    if (colors) {
      writeColors(cloud, (i) => (r.show[i] ? colors.subarray(i * 4, i * 4 + 4) : local.color(i)));
      colored = true;
    } else restoreColors();
    if (r.sizes) {
      writeSizes(cloud, r.sizes, (i) => sizes?.[i] ?? 1);
      sized = true;
    } else restoreSizes();
    if (r.shown < r.count) {
      if (masked && cloud.mask) cloud.updateMask(0, r.show);
      else cloud.setMask(r.show, { ...maskStyle, mode: 'filter' });
      masked = true;
    } else restoreMask();
    return r;
  };
  result = apply(current);
  return {
    get result() {
      return result;
    },
    update(next) {
      if (disposed) throw new MargoError('disposed', 'Point style binding is disposed; bind the style again');
      const style = next === undefined ? current : styleOf(next);
      result = apply(style);
      current = style;
      return result;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      restoreColors();
      restoreSizes();
      restoreMask();
    },
    [Symbol.dispose]() {
      this.dispose();
    },
  };
}

/**
 * A new cloud holding only the points the style shows, styled, plus their indices into `source`: hidden points take no
 * memory, draw budget or picking. Re-run it after changing the style or the data.
 */
export function createStyledCloud(
  source: PointCloud,
  table: PointTable,
  style: PointStyle | PointStyleOptions,
  options: BindPointStyleOptions = {},
): { cloud: PointCloud; indices: Uint32Array; result: PointStyleResult } {
  const local = ownColors(source),
    result = run(
      styleOf(style),
      table,
      { count: source.count, matrix: options.matrix ?? source.matrix, signal: options.signal },
      source.sourceIndex,
      local,
    ),
    indices = new Uint32Array(result.shown);
  for (let i = 0, n = 0; i < result.count; i++) if (result.show[i]) indices[n++] = i;
  const cloud = subsetCloud(source, indices),
    colors = result.colors;
  if (colors) writeColors(cloud, (i) => colors.subarray(indices[i] * 4, indices[i] * 4 + 4));
  if (result.sizes) {
    const sizes = Float32Array.from(indices, (i) => result.sizes![i]);
    writeSizes(cloud, sizes, (i) => source.sizes?.[indices[i]] ?? 1);
  }
  return { cloud, indices, result };
}

/**
 * Wraps an octree source (`PotreeSource`, `CopcSource`, `MemoryOctree`) so each node is styled as it loads: hidden
 * points are dropped from the node and `color` becomes its colours. `pointSize` does not apply to octree nodes. To
 * change the style, wrap the source again and give it to a new `OctreeCloud`.
 */
export function styleSource(source: OctreeSource, style: PointStyle | PointStyleOptions): OctreeSource {
  const compiled = styleOf(style);
  return {
    root: source.root,
    async load(node: OctreeNode, signal: AbortSignal): Promise<OctreeNodeData> {
      return styleNode(await source.load(node, signal), compiled, signal);
    },
  };
}

/** Styles one node's points: what `styleSource` does to each node. */
export function styleNode(
  data: OctreeNodeData,
  style: PointStyle | PointStyleOptions,
  signal?: AbortSignal,
): OctreeNodeData {
  const s = styleOf(style),
    count = data.positions.length / 3,
    k = data.colorComponents ?? (data.colors ? data.colors.length / Math.max(count, 1) : 4);
  const result = run(
    s,
    { ...data.attributes, positions: data.positions, ...(data.colors ? { colors: data.colors } : {}) },
    { count, signal },
  );
  if (result.shown === count && !result.colors) return data;
  const keep: number[] = [];
  for (let i = 0; i < count; i++) if (result.show[i]) keep.push(i);
  const pick = <T extends PointAttribute | Float32Array>(values: T, per: number): T => {
    const out = new (values.constructor as new (n: number) => T)(keep.length * per);
    for (let i = 0; i < keep.length; i++) for (let c = 0; c < per; c++) out[i * per + c] = values[keep[i] * per + c];
    return out;
  };
  let colors: Uint8Array | Float32Array | null | undefined = data.colors && pick(data.colors, k),
    components = data.colors ? (k as 3 | 4) : undefined;
  if (result.colors) {
    colors = new Uint8Array(keep.length * 4);
    for (let i = 0; i < keep.length; i++)
      for (let c = 0; c < 4; c++) colors[i * 4 + c] = Math.round(result.colors[keep[i] * 4 + c] * 255);
    components = 4;
  }
  const attributes: Record<string, PointAttribute> = {};
  for (const [name, values] of Object.entries(data.attributes ?? {}))
    attributes[name] = pick(values, values.length / Math.max(count, 1));
  return {
    ...data,
    positions: pick(data.positions, 3),
    colors,
    colorComponents: components,
    attributes,
    ...(data.rowIds ? { rowIds: keep.map((i) => data.rowIds![i]) } : {}),
  };
}
