/// <reference lib="esnext.disposable" preserve="true" />
// Clean room: Pratt (1973), Ahlberg/Williamson/Shneiderman (1992), WAI-ARIA grid.
import { fault, rangeError } from '../../shared/errors.js';
import { expression, evaluate, type Column } from './calc-expression.js';
import { ColumnarTable } from './table.js';
import { SelectionStore, selectionOperation, type RowKey, type SelectionOperation } from './link.js';
import type { Figure, LineLayer, LineLayerOptions } from './figure.js';

/** Keys default to row indices; a supplied store is borrowed. */
export interface QueryOptions {
  readonly rowIds?: ArrayLike<RowKey>;
  readonly selection?: SelectionStore;
}
/** Float64 selected samples in increasing time order; original rows and keys survive sorting. */
export interface SelectionSeries {
  readonly time: Float64Array;
  readonly values: Float64Array;
  readonly rows: Uint32Array;
  readonly rowIds: readonly RowKey[];
}
/** Safe calculator predicates over typed columns, extraction and shared keyed interaction. */
export class QuerySelection {
  readonly table: ColumnarTable;
  readonly rowIds: readonly RowKey[];
  readonly selection: SelectionStore;
  readonly #owns: boolean;
  #disposed = false;
  constructor(table: ColumnarTable, options: QueryOptions = {}) {
    this.table = table;
    this.rowIds = Object.freeze(options.rowIds ? Array.from(options.rowIds) : Array.from({ length: table.length }, (_, i) => i));
    if (this.rowIds.length !== table.length || new Set(this.rowIds).size !== table.length)
      throw rangeError('Query needs one unique key per table row', 'sciviz');
    this.#owns = !options.selection;
    this.selection = options.selection ?? new SelectionStore(this.rowIds);
    if (this.rowIds.some((id) => !this.selection.contains(id))) throw rangeError('Query keys must belong to the shared selection', 'sciviz');
  }
  /** @internal */ check(): void { if (this.#disposed) throw fault('state', 'Query is disposed', 'sciviz'); }
  /** Numeric arrays only; reductions ignore null/nonfinite samples over the complete table.
   * Unary min/max/sum/mean/count reduce an expression; binary min/max stay componentwise.
   * Comparisons involving missing/nonfinite operands are false. No caller code is executed.
   */
  matching(source: string): Uint32Array {
    this.check(); const entries = Object.entries(this.table.columns), columns = new Map<string, Column>();
    const row = new Array<number>(entries.length);
    for (const [i, [name, col]] of entries.entries())
      if (!col.categories && !(col.values instanceof BigInt64Array) && !(col.values instanceof BigUint64Array))
        columns.set(name, { values: col.values as ArrayLike<number>, width: 1, offset: i });
    const load = (i: number) => { for (let k = 0; k < entries.length; k++) { const v = this.table.value(entries[k][0], i); row[k] = typeof v === 'number' ? v : NaN; } };
    const nodes = expression(source, columns, { precision: 'f64', predicates: true, reduce: (op, args) => args.map((arg) => {
      let result = op === 'min' ? Infinity : op === 'max' ? -Infinity : 0, n = 0, correction = 0;
      for (let i = 0; i < this.table.length; i++) {
        load(i); const v = evaluate(arg, row, undefined, 'f64').value;
        if (!Number.isFinite(v)) continue;
        n++;
        if (op === 'min') result = Math.min(result, v);
        else if (op === 'max') result = Math.max(result, v);
        else { const y = v - correction, next = result + y; correction = (next - result) - y; result = next; }
      }
      return { op: 'literal', args: [], value: op === 'count' ? n : !n ? NaN : op === 'mean' ? result / n : result };
    }) });
    if (nodes.length !== 1) throw rangeError('A query predicate must be scalar', 'sciviz');
    const rows = new Uint32Array(this.table.length); let n = 0;
    for (let i = 0; i < this.table.length; i++) { load(i); const v = evaluate(nodes[0], row, undefined, 'f64').value; if (Number.isFinite(v) && v !== 0) rows[n++] = i; }
    return rows.slice(0, n);
  }
  /** Evaluate fully before publishing; syntax errors leave the store unchanged. */
  select(source: string, options: { readonly source?: string; readonly operation?: SelectionOperation } = {}): Uint32Array {
    const rows = this.matching(source); this.selection.select(Array.from(rows, (i) => this.rowIds[i]), { source: 'query', ...options }); return rows;
  }
  /** Current shared selection in physical table order. */
  rows(): Uint32Array { this.check(); return Uint32Array.from(this.rowIds.flatMap((id, i) => this.selection.has(id) ? [i] : [])); }
  /** Independent typed storage, with dictionaries, exact int64, units and validity preserved. */
  extract(): ColumnarTable { return this.table.take(this.rows()); }
  series(time: string, value: string): SelectionSeries {
    this.check(); this.table.column(time); this.table.column(value);
    const rows = this.rows().filter((i) => typeof this.table.value(time, i) === 'number' && Number.isFinite(this.table.value(time, i)) && typeof this.table.value(value, i) === 'number' && Number.isFinite(this.table.value(value, i)));
    rows.sort((a, b) => Number(this.table.value(time, a)) - Number(this.table.value(time, b)) || a - b);
    return { rows, rowIds: Array.from(rows, (i) => this.rowIds[i]), time: Float64Array.from(rows, (i) => Number(this.table.value(time, i))), values: Float64Array.from(rows, (i) => Number(this.table.value(value, i))) };
  }
  /** Draw this snapshot; call again after selection changes. Empty/singleton selections draw no line. */
  async plot(figure: Figure, time: string, value: string, options: LineLayerOptions = {}): Promise<LineLayer | null> {
    const series = this.series(time, value);
    return series.rows.length < 2 ? null : figure.line({ x: series.time, y: series.values }, options);
  }
  dispose(): void { if (this.#disposed) return; this.#disposed = true; if (this.#owns) this.selection.dispose(); }
  [Symbol.dispose](): void { this.dispose(); }
}

/** Bounded DOM rows and columns, fixed row height, stable identity through sorting. */
export interface SpreadsheetOptions {
  /** Default 28 CSS pixels. */ readonly rowHeight?: number;
  /** Default 160 CSS pixels. */ readonly columnWidth?: number;
  /** Default 360 CSS pixels. */ readonly height?: number;
  /** Extra rows on either side, default 3. */ readonly overscan?: number;
  /** Default all table columns. */ readonly columns?: readonly string[];
  /** Show selected rows only, default false. */ readonly selectedOnly?: boolean;
  /** Aborts listeners and removes the view. */ readonly signal?: AbortSignal;
}
/** A virtualised, sortable read-only data spreadsheet. Click/Space selects; modifiers use the shared algebra. */
export class Spreadsheet {
  readonly element: HTMLDivElement;
  readonly #query: QuerySelection;
  readonly #columns: readonly string[];
  readonly #rowHeight: number;
  readonly #columnWidth: number;
  readonly #overscan: number;
  readonly #body: HTMLDivElement;
  readonly #events = new AbortController();
  readonly #activeId = `query-${crypto.randomUUID()}`;
  readonly #resize: ResizeObserver;
  #order: Uint32Array;
  #selectedOnly: boolean;
  #sort?: { column: string; descending: boolean };
  #focus = 0;
  #column = 0;
  #disposed = false;
  constructor(container: HTMLElement, query: QuerySelection, options: SpreadsheetOptions = {}) {
    query.check(); this.#query = query; this.#columns = options.columns ?? Object.keys(query.table.columns);
    for (const name of this.#columns) query.table.column(name);
    if (!this.#columns.length || new Set(this.#columns).size !== this.#columns.length) throw rangeError('Spreadsheet needs unique columns', 'sciviz');
    this.#rowHeight = options.rowHeight ?? 28; this.#columnWidth = options.columnWidth ?? 160; this.#overscan = options.overscan ?? 3;
    const height = options.height ?? 360;
    if (![this.#rowHeight, this.#columnWidth, height].every((v) => Number.isFinite(v) && v > 0) || !Number.isInteger(this.#overscan) || this.#overscan < 0)
      throw rangeError('Spreadsheet dimensions must be positive, overscan a nonnegative integer', 'sciviz');
    this.#selectedOnly = options.selectedOnly ?? false; this.#order = new Uint32Array();
    const root = this.element = document.createElement('div'); root.setAttribute('role', 'grid'); root.setAttribute('aria-label', 'Data spreadsheet'); root.setAttribute('aria-colcount', String(this.#columns.length)); root.tabIndex = 0;
    root.style.cssText = `overflow:auto;position:relative;height:${height}px;border:1px solid #718096;font:13px system-ui;color:inherit`;
    this.#body = document.createElement('div'); this.#body.style.cssText = `position:relative;width:${this.#columns.length * this.#columnWidth}px`; root.append(this.#body); container.append(root);
    const signal = this.#events.signal;
    root.addEventListener('scroll', () => this.render(), { signal });
    query.selection.addEventListener('change', () => this.refresh(), { signal });
    root.addEventListener('keydown', (event) => {
      if (!this.#order.length) return;
      if (event.key === ' ' || event.key === 'Enter') { event.preventDefault(); this.#pick(this.#focus, event); return; }
      const n = this.#order.length;
      if (event.key === 'ArrowDown') this.#focus = Math.min(n - 1, this.#focus + 1);
      else if (event.key === 'ArrowUp') this.#focus = Math.max(0, this.#focus - 1);
      else if (event.key === 'ArrowRight') this.#column = Math.min(this.#columns.length - 1, this.#column + 1);
      else if (event.key === 'ArrowLeft') this.#column = Math.max(0, this.#column - 1);
      else if (event.key === 'Home') { this.#column = 0; if (event.ctrlKey) this.#focus = 0; }
      else if (event.key === 'End') { this.#column = this.#columns.length - 1; if (event.ctrlKey) this.#focus = n - 1; }
      else return;
      event.preventDefault(); root.scrollTop = this.#focus * this.#rowHeight; root.scrollLeft = this.#column * this.#columnWidth; this.render();
    }, { signal });
    this.#resize = new ResizeObserver(() => this.render()); this.#resize.observe(root);
    options.signal?.addEventListener('abort', () => this.dispose(), { once: true, signal });
    this.refresh(); if (options.signal?.aborted) this.dispose();
  }
  get rows(): Uint32Array { return this.#order.slice(); }
  set selectedOnly(value: boolean) { this.#selectedOnly = value; this.element.scrollTop = 0; this.refresh(); }
  sort(column: string, descending = false): void { this.#query.table.column(column); this.#sort = { column, descending }; this.refresh(); }
  #pick(index: number, event: MouseEvent | KeyboardEvent): void {
    this.#focus = index; this.#query.selection.select([this.#query.rowIds[this.#order[index]]], { source: 'spreadsheet', operation: selectionOperation(event) });
  }
  /** Rebuild order after a selection change; source row indices never change. */
  refresh(): void {
    if (this.#disposed) return;
    this.#order = this.#selectedOnly ? this.#query.rows() : Uint32Array.from({ length: this.#query.table.length }, (_, i) => i);
    if (this.#sort) {
      const { column, descending } = this.#sort, table = this.#query.table;
      this.#order.sort((a, b) => { const x = table.value(column, a), y = table.value(column, b), missing = (v: unknown) => v === null || (typeof v === 'number' && Number.isNaN(v));
        if (missing(x) || missing(y)) return missing(x) ? missing(y) ? a - b : 1 : -1;
        return (x! < y! ? -1 : x! > y! ? 1 : 0) * (descending ? -1 : 1) || a - b;
      });
    }
    this.#focus = Math.max(0, Math.min(this.#focus, this.#order.length - 1)); this.render();
  }
  /** Refresh visible cells only. At most viewport rows/columns plus overscan exist in the DOM. */
  render(): void {
    if (this.#disposed) return;
    const root = this.element, h = this.#rowHeight, w = this.#columnWidth, n = this.#order.length;
    const start = Math.max(0, Math.floor(root.scrollTop / h) - this.#overscan), end = Math.min(n, Math.ceil((root.scrollTop + root.clientHeight) / h) + this.#overscan);
    const first = Math.max(0, Math.floor(root.scrollLeft / w) - 1), last = Math.min(this.#columns.length, Math.ceil((root.scrollLeft + root.clientWidth) / w) + 1);
    root.setAttribute('aria-rowcount', String(n + 1)); root.removeAttribute('aria-activedescendant'); this.#body.style.height = `${(n + 1) * h}px`; this.#body.replaceChildren();
    const header = document.createElement('div'); header.setAttribute('role', 'row'); header.setAttribute('aria-rowindex', '1'); header.style.cssText = `position:sticky;top:0;height:${h}px;z-index:1;background:Canvas;color:CanvasText`;
    for (let c = first; c < last; c++) {
      const name = this.#columns[c], cell = document.createElement('button'); cell.type = 'button'; cell.tabIndex = -1; cell.textContent = name; cell.setAttribute('role', 'columnheader'); cell.setAttribute('aria-colindex', String(c + 1)); cell.setAttribute('aria-sort', this.#sort?.column === name ? this.#sort.descending ? 'descending' : 'ascending' : 'none'); cell.style.cssText = `position:absolute;left:${c * w}px;width:${w}px;height:${h}px;overflow:hidden`;
      cell.onclick = (event) => { event.stopPropagation(); this.sort(name, this.#sort?.column === name && !this.#sort.descending); }; header.append(cell);
    }
    this.#body.append(header);
    for (let i = start; i < end; i++) {
      const source = this.#order[i], selected = this.#query.selection.has(this.#query.rowIds[source]), row = document.createElement('div'); row.setAttribute('role', 'row'); row.setAttribute('aria-rowindex', String(i + 2)); row.setAttribute('aria-selected', String(selected)); row.dataset.row = String(source);
      row.style.cssText = `position:absolute;top:${(i + 1) * h}px;height:${h}px;width:100%;background:${selected && this.#query.selection.active ? '#3182ce44' : 'transparent'}`;
      row.onclick = (event) => { root.focus(); this.#pick(i, event); };
      for (let c = first; c < last; c++) {
        const cell = document.createElement('div'); cell.setAttribute('role', 'gridcell'); cell.setAttribute('aria-colindex', String(c + 1)); cell.textContent = String(this.#query.table.value(this.#columns[c], source) ?? ''); cell.style.cssText = `position:absolute;left:${c * w}px;width:${w}px;height:${h}px;box-sizing:border-box;padding:4px 8px;overflow:hidden;white-space:nowrap;border-bottom:1px solid #71809644`;
        if (i === this.#focus && c === this.#column) { cell.id = this.#activeId; root.setAttribute('aria-activedescendant', cell.id); cell.style.outline = '1px solid #718096'; }
        row.append(cell);
      }
      this.#body.append(row);
    }
  }
  dispose(): void { if (this.#disposed) return; this.#disposed = true; this.#events.abort(); this.#resize.disconnect(); this.element.remove(); }
  [Symbol.dispose](): void { this.dispose(); }
}
