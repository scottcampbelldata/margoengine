/// <reference lib="esnext.disposable" preserve="true" />
// Clean room: Inselberg (1985), Heinrich and Weiskopf (2013), Hurley (2000).
import { fault, rangeError } from '../../shared/errors.js';
import type { ColumnarTable } from './table.js';
import { SelectionStore, selectionOperation, type RowKey, type SelectionOperation } from './link.js';
import type { Figure, CreateFigureOptions } from './figure.js';
import { MultivariateLayer } from './parcoords-layer.js';
import { densityCounts, type ParallelDensityOptions } from './parcoords-density.js';
export type { ParallelDensityOptions } from './parcoords-density.js';
export { densityCounts as parallelDensity } from './parcoords-density.js';

/** One table column, with the same scale wherever it appears in a matrix. */
export interface ParallelAxis {
  readonly column: string;
  readonly label?: string;
  readonly scale?: 'linear' | 'log';
  readonly domain?: readonly [number, number];
}
/** Shared keyed selection and appearance for parallel coordinates or a scatter-plot matrix. */
export interface MultivariateOptions {
  readonly axes: readonly (string | ParallelAxis)[];
  readonly selection?: SelectionStore;
  readonly rowIds?: ArrayLike<RowKey>;
  readonly figure?: Omit<CreateFigureOptions, 'mode'>;
  /** Scatter diameter, default 3 CSS pixels. */ readonly size?: number;
  readonly signal?: AbortSignal;
}
/** Immutable, f32-normalised columns shared by the two renderers and exact pixel-density calculation. */
export class MultivariateData {
  readonly table: ColumnarTable;
  readonly axes: readonly ParallelAxis[];
  readonly domains: readonly (readonly [number, number])[];
  readonly values: Float32Array;
  readonly order: Uint32Array;
  readonly rowIds: readonly RowKey[];
  constructor(table: ColumnarTable, options: MultivariateOptions) {
    options.signal?.throwIfAborted(); this.table = table;
    this.axes = options.axes.map((a) => typeof a === 'string' ? { column: a } : { ...a });
    if (this.axes.length < 2 || this.axes.length > 32 || new Set(this.axes.map((a) => a.column)).size !== this.axes.length)
      throw rangeError('Multivariate plots need 2 to 32 distinct column axes', 'sciviz');
    if (table.length > 16777216 || table.length * this.axes.length ** 2 > 0xffffffff)
      throw rangeError('Multivariate plot exceeds its row/draw-index limit; partition the table', 'sciviz');
    if (options.rowIds && options.rowIds.length !== table.length) throw rangeError('Multivariate rowIds must match the table length', 'sciviz');
    this.rowIds = options.rowIds ? Array.from(options.rowIds) : Array.from({ length: table.length }, (_, i) => i);
    this.values = new Float32Array(table.length * this.axes.length).fill(NaN);
    this.order = new Uint32Array(this.axes.length * 2);
    this.domains = this.axes.map((axis, k) => {
      const column = table.column(axis.column);
      if (axis.scale !== undefined && axis.scale !== 'linear' && axis.scale !== 'log') throw rangeError('Axis scale must be linear or log', 'sciviz');
      let lo = Infinity, hi = -Infinity;
      for (let i = 0; i < table.length; i++) {
        const v = this.raw(k, i);
        if (Number.isFinite(v) && (axis.scale !== 'log' || v > 0)) { lo = Math.min(lo, v); hi = Math.max(hi, v); }
      }
      if (column.categories && axis.scale === 'log') throw rangeError('Categorical axes need a linear scale', 'sciviz');
      const delta = Math.max(Math.abs(lo) * 0.01, lo === 0 ? 0.5 : Number.MIN_VALUE);
      const constant = [Math.max(-Number.MAX_VALUE, lo - delta), Math.min(Number.MAX_VALUE, hi + delta)] as [number, number];
      if (axis.scale === 'log' && constant[0] <= 0) constant[0] = lo;
      const domain = axis.domain ? [...axis.domain] as [number, number] : lo === hi ? constant : lo < hi ? [lo, hi] as [number, number] : axis.scale === 'log' ? [1, 10] as [number, number] : [0, 1] as [number, number];
      if (!domain.every(Number.isFinite) || !(domain[1] > domain[0]) || (axis.scale === 'log' && domain[0] <= 0)) throw rangeError('Axes need increasing finite domains, positive for log', 'sciviz');
      const transform = (v: number) => axis.scale === 'log' ? Math.log(v) : v, a = transform(domain[0]), span = transform(domain[1]) - a;
      for (let i = 0; i < table.length; i++) {
        const v = this.raw(k, i);
        if (Number.isFinite(v) && (axis.scale !== 'log' || v > 0)) {
          const normal = Number.isFinite(span) ? (transform(v) - a) / span : (v / 2 - domain[0] / 2) / (domain[1] / 2 - domain[0] / 2);
          if (normal >= 0 && normal <= 1) this.values[k * table.length + i] = normal;
        }
      }
      this.order[k * 2] = k; return domain;
    });
  }
  /** Numeric category code or physical value; nulls and nonfinite values become NaN. */
  raw(axis: number, row: number): number {
    const c = this.table.column(this.axes[axis].column);
    return c.validity && !(c.validity[row >> 3] & (1 << (row & 7))) ? NaN : Number(c.values[row]);
  }
  /** Normalised screen value, including axis flip; missing values remain NaN. */
  at(position: number, row: number): number {
    const v = this.values[this.order[position * 2] * this.table.length + row]; return this.order[position * 2 + 1] ? Math.fround(1 - v) : v;
  }
  /** Inverse of an axis scale; ranges use physical values, even on a flipped axis. */
  physical(axis: number, value: number): number {
    const [lo, hi] = this.domains[axis];
    if (value === 0) return lo; if (value === 1) return hi;
    return this.axes[axis].scale === 'log' ? Math.exp(Math.log(lo) * (1 - value) + Math.log(hi) * value) : lo * (1 - value) + hi * value;
  }
}

let sourceId = 0;
/** GPU multivariate chart with persistent row identity, range brushes and owned lifecycle. */
export class MultivariatePlot extends EventTarget {
  readonly figure: Figure;
  readonly data: MultivariateData;
  readonly selection: SelectionStore;
  readonly kind: 'parallel' | 'matrix';
  readonly #layer: MultivariateLayer;
  readonly #ownsSelection: boolean;
  readonly #source = `multivariate:${sourceId++}`;
  readonly #brushes = new Map<number, readonly [number, number]>();
  readonly #change: () => void;
  #disposed = false;
  #density?: { options: ParallelDensityOptions; layer?: { dispose(): void }; generation: number };
  #pending: Promise<void> = Promise.resolve();
  #offPointer?: () => void;
  private constructor(figure: Figure, data: MultivariateData, kind: 'parallel' | 'matrix', options: MultivariateOptions) {
    super(); this.figure = figure; this.data = data; this.kind = kind;
    this.#ownsSelection = !options.selection; this.selection = options.selection ?? new SelectionStore(data.rowIds);
    for (const key of data.rowIds) if (!this.selection.contains(key)) throw rangeError('Every multivariate row key must exist in the shared selection', 'sciviz');
    this.#layer = new MultivariateLayer(figure, data, this.selection, kind, options.size ?? 3);
    figure.addLayer(this.#layer);
    // The axis ranges travel with this plot's brush in the store, so undo, redo, restore and another source's global
    // replace leave the controller on the ranges that made the current rows (KB5700c).
    this.#change = () => { this.#restoreRanges(); this.#layer.selectionChanged(); if (this.#density) this.#scheduleDensity(); this.dispatchEvent(new Event('change')); };
    this.selection.addEventListener('change', this.#change);
    this.#offPointer = this.#pointer();
  }
  /** Create on a canvas. Parallel rows and every matrix cell use the same immutable columns and row keys. */
  static async create(canvas: HTMLCanvasElement, table: ColumnarTable, options: MultivariateOptions & { readonly kind?: 'parallel' | 'matrix' }): Promise<MultivariatePlot> {
    const data = new MultivariateData(table, options);
    const { Figure } = await import('@margoengine/sciviz');
    const figure = await Figure.create(canvas, { ...options.figure, mode: '2d', controls: false, signal: options.signal });
    try { const plot = new MultivariatePlot(figure, data, options.kind ?? 'parallel', options); await figure.ready(); return plot; }
    catch (error) { figure.dispose(); throw error; }
  }
  /** Pending density redraw, including any error. */
  ready(): Promise<void> { return Promise.all([this.#pending, this.figure.ready()]).then(() => {}); }
  #check(): void { if (this.#disposed) throw fault('state', 'MultivariatePlot is disposed; create another plot', 'sciviz'); }
  /** Reorder by column names. Exactly one small GPU order-buffer write, no column re-upload. */
  reorder(names: readonly string[]): void {
    this.#check(); const positions = names.map((n) => this.data.axes.findIndex((a) => a.column === n));
    if (positions.length !== this.data.axes.length || positions.includes(-1) || new Set(positions).size !== positions.length) throw rangeError('Axis order must be a permutation of the plotted columns', 'sciviz');
    const flips = new Map(Array.from({ length: positions.length }, (_, i) => [this.data.order[i * 2], this.data.order[i * 2 + 1]]));
    positions.forEach((axis, i) => { this.data.order[i * 2] = axis; this.data.order[i * 2 + 1] = flips.get(axis)!; });
    this.#layer.orderChanged(); if (this.#density) this.#scheduleDensity(); this.dispatchEvent(new Event('axes'));
  }
  /** Flip one axis without changing its physical brush or column buffer. */
  flip(name: string, flipped?: boolean): void {
    this.#check(); const axis = this.#axis(name), position = Array.from({ length: this.data.axes.length }, (_, i) => i).find((i) => this.data.order[i * 2] === axis)!;
    this.data.order[position * 2 + 1] = flipped === undefined ? 1 - this.data.order[position * 2 + 1] : Number(flipped);
    this.#layer.orderChanged(); if (this.#density) this.#scheduleDensity(); this.dispatchEvent(new Event('axes'));
  }
  #restoreRanges(): void {
    this.#brushes.clear();
    const ranges = this.selection.predicate(this.#source);
    if (!Array.isArray(ranges)) return;
    for (const entry of ranges as unknown[]) {
      if (!Array.isArray(entry) || entry.length !== 3) continue;
      const [axis, lo, hi] = entry as [number, number, number];
      if (Number.isInteger(axis) && axis >= 0 && axis < this.data.axes.length) this.#brushes.set(axis, [lo, hi]);
    }
  }
  #axis(name: string): number { const k = this.data.axes.findIndex((a) => a.column === name); if (k < 0) throw rangeError(`Unknown plotted axis ${name}; use an axis column name`, 'sciviz'); return k; }
  /** Inclusive per-axis ranges intersect; undefined clears that axis. Modifiers apply to the resolved row keys. */
  brush(name: string, range?: readonly [number, number], operation: SelectionOperation = 'replace'): void {
    this.#check(); const axis = this.#axis(name);
    if (range && (!range.every(Number.isFinite) || range.length !== 2 || range[1] < range[0])) throw rangeError('A brush needs ordered finite endpoints', 'sciviz');
    if (range) this.#brushes.set(axis, [...range]); else this.#brushes.delete(axis);
    if (!this.#brushes.size) { this.selection.clear(this.#source); return; }
    const rows: RowKey[] = [];
    for (let row = 0; row < this.data.table.length; row++) {
      let pass = true; for (const [k, [lo, hi]] of this.#brushes) { const v = this.data.raw(k, row); if (!(v >= lo && v <= hi)) { pass = false; break; } }
      if (pass) rows.push(this.data.rowIds[row]);
    }
    const predicate = [...this.#brushes].map(([k, [lo, hi]]) => [k, lo, hi]);
    this.selection.select(rows, { source: this.#source, operation, predicate });
  }
  /** A matrix cell's rectangle selects by its two physical coordinates, with shared row ids. */
  brushCell(x: string, y: string, xr: readonly [number, number], yr: readonly [number, number], operation: SelectionOperation = 'replace'): void {
    this.#check(); const a = this.#axis(x), b = this.#axis(y);
    if ([xr, yr].some((r) => r.length !== 2 || !r.every(Number.isFinite) || r[1] < r[0])) throw rangeError('Matrix brush ranges need ordered finite endpoints', 'sciviz');
    const rows: RowKey[] = [];
    for (let i = 0; i < this.data.table.length; i++) { const vx = this.data.raw(a, i), vy = this.data.raw(b, i); if (vx >= xr[0] && vx <= xr[1] && vy >= yr[0] && vy <= yr[1]) rows.push(this.data.rowIds[i]); }
    this.selection.select(rows, { source: this.#source, operation, predicate: [[a, ...xr], [b, ...yr]] });
  }
  /** Exact integer counts per raster pixel column, displayed with log(1+count) colour. */
  async density(options: ParallelDensityOptions = {}): Promise<Uint32Array> {
    this.#check(); if (this.kind !== 'parallel') throw rangeError('Density belongs to a parallel-coordinates plot', 'sciviz');
    this.#density ??= { options, generation: 0 }; this.#density.options = options;
    const state = this.#density, generation = ++state.generation;
    const counts = await densityCounts(this.data, this.selection, options);
    if (this.#disposed || this.#density !== state || generation !== state.generation) return counts;
    const width = options.width ?? 256, height = options.height ?? 128;
    const layer = await this.figure.heatmap(Float32Array.from(counts, (v) => Math.log1p(v)), { nx: width, ny: height, x: [0, this.data.axes.length - 1], y: [0, 1] });
    if (this.#disposed || this.#density !== state || generation !== state.generation) { this.figure.remove(layer); return counts; }
    if (state.layer) this.figure.remove(state.layer as Parameters<Figure['remove']>[0]); state.layer = layer; this.#layer.visible = false; return counts;
  }
  #scheduleDensity(): void {
    const next = this.density(this.#density!.options).then(() => {});
    this.#pending = next;
    void next.catch((error: unknown) => this.dispatchEvent(new CustomEvent('error', { detail: error })));
  }
  /** Return to the original instanced line geometry. */
  lines(): void { this.#check(); const state = this.#density; this.#density = undefined; if (state?.layer) this.figure.remove(state.layer as Parameters<Figure['remove']>[0]); this.#layer.visible = true; }
  #pointer(): () => void {
    const canvas = this.#layer.canvas;
    let start: { point: readonly [number, number]; position: number; cell?: readonly [number, number] } | undefined;
    const down = (event: PointerEvent) => {
      if (event.button !== 0) return; const p = this.#layer.point(event.offsetX, event.offsetY); if (!p) return;
      const dims = this.data.axes.length, position = Math.round(p[0]);
      if (this.kind === 'parallel' && (Math.abs(position - p[0]) > 0.12 || position < 0 || position >= dims || p[1] < 0 || p[1] > 1)) return;
      const cell = this.kind === 'matrix' ? [Math.floor(p[0]), dims - 1 - Math.floor(p[1])] as const : undefined;
      if (cell && (cell.some((v) => v < 0 || v >= dims) || cell[0] === cell[1])) return;
      start = { point: p, position, cell }; canvas.setPointerCapture(event.pointerId); event.preventDefault(); event.stopImmediatePropagation();
    };
    const up = (event: PointerEvent) => {
      if (!start) return; const s = start; start = undefined; const p = this.#layer.point(event.offsetX, event.offsetY); if (!p) return;
      const range = (axis: number, a: number, b: number) => { const v = [this.data.physical(axis, Math.max(0, Math.min(1, a))), this.data.physical(axis, Math.max(0, Math.min(1, b)))]; return [Math.min(...v), Math.max(...v)] as const; };
      if (s.cell) {
        const [cx, cy] = s.cell, dims = this.data.axes.length, a = this.data.order[cx * 2], b = this.data.order[cy * 2];
        const fx = (v: number) => this.data.order[cx * 2 + 1] ? 1 - v : v, fy = (v: number) => this.data.order[cy * 2 + 1] ? 1 - v : v;
        this.brushCell(this.data.axes[a].column, this.data.axes[b].column, range(a, fx(s.point[0] - cx), fx(p[0] - cx)), range(b, fy(s.point[1] - (dims - 1 - cy)), fy(p[1] - (dims - 1 - cy))), selectionOperation(event));
      } else {
        const a = this.data.order[s.position * 2], flip = this.data.order[s.position * 2 + 1];
        this.brush(this.data.axes[a].column, range(a, flip ? 1 - s.point[1] : s.point[1], flip ? 1 - p[1] : p[1]), selectionOperation(event));
      }
      event.preventDefault(); event.stopImmediatePropagation();
    };
    const cancel = () => { start = undefined; };
    canvas.addEventListener('pointerdown', down, true); canvas.addEventListener('pointerup', up, true); canvas.addEventListener('pointercancel', cancel);
    return () => { canvas.removeEventListener('pointerdown', down, true); canvas.removeEventListener('pointerup', up, true); canvas.removeEventListener('pointercancel', cancel); };
  }
  /** Accessible axis reorder/flip/brush controls. Dispose the returned binding before removing its container. */
  controls(parent: HTMLElement): { dispose(): void; [Symbol.dispose](): void } {
    this.#check(); const form = document.createElement('div'); parent.append(form);
    const update = () => {
      form.replaceChildren();
      for (let position = 0; position < this.data.axes.length; position++) {
        const k = this.data.order[position * 2], axis = this.data.axes[k], field = document.createElement('fieldset'), legend = document.createElement('legend');
        legend.textContent = axis.label ?? axis.column; field.append(legend); field.draggable = true;
        field.addEventListener('dragstart', (e) => e.dataTransfer!.setData('text/plain', axis.column));
        field.addEventListener('dragover', (e) => e.preventDefault());
        field.addEventListener('drop', (e) => { e.preventDefault(); const names = Array.from({ length: this.data.axes.length }, (_, i) => this.data.axes[this.data.order[i * 2]].column), name = e.dataTransfer!.getData('text/plain'), from = names.indexOf(name); if (from >= 0) { names.splice(from, 1); names.splice(position, 0, name); this.reorder(names); } });
        for (const [label, action] of [['Flip', () => this.flip(axis.column)], ['Left', () => { if (!position) return; const names = Array.from({ length: this.data.axes.length }, (_, i) => this.data.axes[this.data.order[i * 2]].column); [names[position - 1], names[position]] = [names[position], names[position - 1]]; this.reorder(names); }], ['Clear brush', () => this.brush(axis.column)]] as const) { const button = document.createElement('button'); button.type = 'button'; button.textContent = label; button.addEventListener('click', action); field.append(button); }
        const inputs = this.data.domains[k].map((value, end) => { const label = document.createElement('label'), input = document.createElement('input'); label.textContent = end ? ' Upper ' : ' Lower '; input.type = 'number'; input.step = 'any'; input.value = String(this.#brushes.get(k)?.[end] ?? value); label.append(input); field.append(label); return input; });
        for (const input of inputs) input.addEventListener('change', () => this.brush(axis.column, [Number(inputs[0].value), Number(inputs[1].value)]));
        form.append(field);
      }
    };
    update(); this.addEventListener('axes', update); const dispose = () => { this.removeEventListener('axes', update); form.remove(); }; return { dispose, [Symbol.dispose]: dispose };
  }
  /** Release every layer, event handler and owned figure/selection. Borrowed selections survive. */
  dispose(): void { if (this.#disposed) return; this.#disposed = true; this.#offPointer?.(); this.selection.removeEventListener('change', this.#change); if (this.#density) this.#density.generation++; this.figure.dispose(); if (this.#ownsSelection) this.selection.dispose(); }
  [Symbol.dispose](): void { this.dispose(); }
}
/** Create an instanced parallel-coordinates plot. */
export const parallelCoordinates = (canvas: HTMLCanvasElement, table: ColumnarTable, options: MultivariateOptions): Promise<MultivariatePlot> => MultivariatePlot.create(canvas, table, { ...options, kind: 'parallel' });
/** Create a single-canvas GPU scatter-plot matrix with shared column scales and linked brushing. */
export const scatterMatrix = (canvas: HTMLCanvasElement, table: ColumnarTable, options: MultivariateOptions): Promise<MultivariatePlot> => MultivariatePlot.create(canvas, table, { ...options, kind: 'matrix' });
