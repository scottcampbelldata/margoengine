import { rangeError, typeError } from '../../shared/errors.js';
import { Panel, type PanelOptions } from './basic.js';
import { ListItem, type ListEntry } from './collections.js';
import { edges } from './layout.js';
import type { InputSource } from './interaction.js';
import { Widget, type UiCommand, type UiEvent } from './widget.js';

/** Options for {@link VirtualList}. */
export interface VirtualListOptions extends PanelOptions {
  /** Number of rows. Default 0. */
  count?: number;
  /** Height of every row in UI units. Default 44. */
  rowHeight?: number;
  /** The row at `index`: a label or a `{ label, detail, disabled, value }` entry. Called only for rows that are built. */
  row?: (index: number) => string | ListEntry;
  /** Rows built beyond each edge of the view, so a quick scroll shows no gap. Default 4. */
  overscan?: number;
  /** Index of the selected row. Default -1 (none). */
  selected?: number;
  /** Called with `index` and `item` when a row is chosen by click, tap, Enter or the gamepad. */
  onSelect?: (event: UiEvent) => void;
}

class VirtualRow extends ListItem {
  constructor(
    readonly owner: VirtualList,
    index: number,
    entry: ListEntry,
    height: number,
  ) {
    super(owner, index, entry);
    this.setStyleQuiet({ height, minHeight: 0, shrink: 0 });
  }
  override command(command: UiCommand): boolean {
    if (command !== 'down' && command !== 'up') return false;
    // The next row may not be built yet: the list scrolls to it, builds it and moves the focus there.
    const to = command === 'down' ? this.index + 1 : this.index - 1;
    return to >= 0 && to < this.owner.count ? this.owner.focusIndex(to) : this.owner.leave(this, command);
  }
}

/**
 * A scrolling list of selectable rows of one height that builds only the rows in view (plus `overscan` on each side),
 * so an inventory or a log of a hundred thousand entries costs as much as a screenful. Rows come from `row(index)`;
 * call {@link VirtualList.refresh} when their data changes. Arrow keys and the d-pad move through every row, scrolling
 * and building as they go.
 *
 * @example
 * const log = new VirtualList({ count: 50_000, row: (i) => `Event ${i}`, height: 240, onSelect: (e) => show(e.index!) });
 */
export class VirtualList extends Panel {
  private _count = 0;
  private readonly _rowHeight: number;
  private readonly overscan: number;
  private _selected = -1;
  private readonly source: (index: number) => string | ListEntry;
  private readonly built = new Map<number, VirtualRow>();
  private readonly top = new Widget({ minHeight: 0, shrink: 0 });
  private readonly bottom = new Widget({ minHeight: 0, shrink: 0 });
  private first = 0;
  private last = 0;
  private synced = '';
  private leaving = false;

  /** @throws TypeError or RangeError for a bad count, row height, overscan or row function. */
  constructor(options: VirtualListOptions = {}) {
    const {
      count = 0,
      rowHeight = 44,
      row = (i: number) => `Row ${i + 1}`,
      overscan = 4,
      selected = -1,
      onSelect,
      ...rest
    } = options;
    super({ background: 'surface', border: true, padding: 4, gap: 2, overflow: 'scroll', ...rest });
    if (typeof row !== 'function') throw typeError('row is a function from an index to a label or a { label } entry', 'ui');
    if (!(Number.isFinite(rowHeight) && rowHeight > 0)) throw rangeError('rowHeight must be a number above 0', 'ui');
    if (!Number.isInteger(overscan) || overscan < 0) throw rangeError('overscan must be a whole number, 0 or more', 'ui');
    this.role = 'listbox';
    this.source = row;
    this._rowHeight = rowHeight;
    this.overscan = overscan;
    this.count = count;
    this.select(selected);
    if (onSelect) this.on('select', onSelect);
  }

  /** Number of rows. Setting it builds the view again and clears a selection past the end. */
  get count(): number {
    return this._count;
  }
  set count(value: number) {
    if (!Number.isInteger(value) || value < 0) throw rangeError('count must be a whole number, 0 or more', 'ui');
    this._count = value;
    if (this._selected >= value) this._selected = -1;
    this.refresh();
  }
  /** Height of every row in UI units. */
  get rowHeight(): number {
    return this._rowHeight;
  }
  /** The selected row, or -1. */
  get selected(): number {
    return this._selected;
  }
  /** The rows built now, as `[first, last)`; the others are not widgets at all. */
  get range(): readonly [number, number] {
    return [this.first, this.last];
  }

  /** Build the rows in view again from `row(index)`, after their data changed. */
  refresh(): void {
    for (const row of this.built.values()) row.dispose();
    this.built.clear();
    this.synced = '';
    this.sync();
  }

  /**
   * Select a row (-1 clears). With `emit` it also fires `'select'`.
   * @throws RangeError for an index outside -1 to count - 1.
   */
  select(index: number, emit = false): void {
    if (!Number.isInteger(index) || index < -1 || index >= this._count) {
      if (index === -1) return;
      throw rangeError(`VirtualList index ${index} is outside 0 to ${this._count - 1}`, 'ui');
    }
    this._selected = index;
    for (const row of this.built.values()) row.selected = row.index === index;
    this.invalidate(false);
    this.ui?.touchMirror();
    if (emit && index >= 0) {
      const entry = this.built.get(index)?.entry ?? entryOf(this.source(index));
      this.emit('select', { index, item: entry.value ?? entry });
    }
  }

  /**
   * Scroll so row `index` is fully in view, and build it.
   * @throws RangeError for an index outside 0 to count - 1.
   */
  scrollToIndex(index: number): void {
    if (!Number.isInteger(index) || index < 0 || index >= this._count)
      throw rangeError(`VirtualList index ${index} is outside 0 to ${this._count - 1}`, 'ui');
    const y = index * this.step(),
      view = this.view();
    if (y < this.scrollY) this.scrollY = y;
    else if (y + this._rowHeight > this.scrollY + view) this.scrollY = y + this._rowHeight - view;
    this.invalidate();
    this.sync();
  }

  /** Scroll to row `index`, build it and give it the focus. Returns false when it cannot take the focus. */
  focusIndex(index: number, source?: InputSource): boolean {
    this.scrollToIndex(index);
    const ui = this.ui;
    if (!ui) return false;
    ui.layout();
    const row = this.built.get(index);
    return !!row && ui.focus(row, source);
  }

  /**
   * An arrow past the first or last row: the UI moves the focus on as it would from the end of a full list. When that
   * wraps back into this list, the focus lands on the far end, scrolled into view, not on whichever row is built.
   * @internal
   */
  leave(row: Widget, command: 'up' | 'down'): boolean {
    const ui = this.ui;
    if (!ui || this.leaving) return false;
    this.leaving = true;
    try {
      ui.navigate(command, ui.inputMode);
    } finally {
      this.leaving = false;
    }
    const now = ui.focused;
    if (now !== row && now instanceof VirtualRow && now.owner === this)
      return this.focusIndex(command === 'down' ? 0 : this._count - 1, ui.inputMode);
    return now !== row;
  }

  override tick(dt: number): boolean {
    this.sync();
    return super.tick(dt);
  }

  private step(): number {
    const gap = this.style.gap ?? 0;
    return this._rowHeight + (typeof gap === 'number' ? gap : gap[1]);
  }
  /**
   * Height of the view inside the padding. Before the first layout: a numeric `height` style, else the screen's height.
   */
  private view(): number {
    const [top, , bottom] = edges(this.style.padding),
      height = this.style.height;
    const box = this.rect.height > 0 ? this.rect.height : typeof height === 'number' ? height : (this.ui?.height ?? 720);
    return Math.max(0, box - top - bottom);
  }

  /** Build the rows the view needs, drop the rest, and size the two spacers that stand for the rows not built. */
  private sync(): void {
    const step = this.step(),
      gap = step - this._rowHeight,
      n = this._count,
      first = Math.max(0, Math.min(n, Math.floor(this.scrollY / step) - this.overscan)),
      last = Math.max(first, Math.min(n, Math.ceil((this.scrollY + this.view()) / step) + this.overscan)),
      key = `${first}|${last}|${n}|${step}`;
    if (key === this.synced) return;
    this.synced = key;
    this.first = first;
    this.last = last;
    const focused = this.ui?.focused;
    for (const [index, row] of this.built)
      if (index < first || index >= last) {
        if (row === focused) this.ui?.focus(null);
        row.dispose();
        this.built.delete(index);
      }
    const children: Widget[] = [];
    // A spacer and the gap after it end where row `first` starts: first * step.
    if (first > 0) children.push(this.top.setStyle({ height: first * step - gap }));
    for (let i = first; i < last; i++) {
      let row = this.built.get(i);
      if (!row) {
        row = new VirtualRow(this, i, entryOf(this.source(i)), this._rowHeight);
        row.selected = i === this._selected;
        this.built.set(i, row);
      }
      children.push(row);
    }
    if (last < n) children.push(this.bottom.setStyle({ height: (n - last) * step - gap }));
    for (const child of [...this.children]) if (!children.includes(child)) this.remove(child);
    children.forEach((child, i) => {
      if (this.children[i] !== child) this.insert(child, i);
    });
    this.invalidate();
  }
}

function entryOf(value: string | ListEntry): ListEntry {
  if (typeof value === 'string') return { label: value };
  if (!value || typeof value.label !== 'string')
    throw typeError('row(index) returns a string or a { label } entry', 'ui');
  return value;
}
