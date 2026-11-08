import { rangeError, typeError } from '../../shared/errors.js';
import { mixColors, withAlpha } from './color.js';
import { Label, Panel, type PanelOptions } from './basic.js';
import { Button, type ButtonOptions } from './controls.js';
import { Widget, type ColorRef, type DrawContext, type UiCommand, type UiEvent, type WidgetOptions } from './widget.js';

/** What a row tells when it is chosen: a {@link List} or a virtual list. */
export interface ListOwner {
  select(index: number, emit: boolean): void;
}

/** One row of a {@link List}. A plain string is the same as `{ label: string }`. */
export interface ListEntry {
  label: string;
  /** Your data; passed back in `'select'` events as `item`. Default the entry itself. */
  value?: unknown;
  /** Muted text at the right edge, for example a price or a count. */
  detail?: string;
  /** Disabled rows draw dimmed and cannot be selected. */
  disabled?: boolean;
}

/** @internal A selectable row of a list. */
export class ListItem extends Widget {
  selected = false;
  constructor(
    readonly list: ListOwner,
    readonly index: number,
    readonly entry: ListEntry,
  ) {
    super({ padding: [8, 14], minHeight: 44, enabled: !entry.disabled });
    this.role = 'option';
    this.focusable = true;
    this.pointerEvents = 'auto';
  }
  override get text(): string {
    return this.entry.label;
  }
  override activate(): void {
    if (this.active) this.list.select(this.index, true);
  }
  override measure(maxWidth: number): { width: number; height: number } {
    return this.ui ? this.ui.measureText(this.entry.label, 'body', maxWidth - 16, 1.25) : { width: 0, height: 0 };
  }
  override draw(context: DrawContext): void {
    const { list, ui, theme } = context,
      r = this.rect,
      active = this.active;
    const base = this.selected ? ui.color('surfaceRaised') : ui.color('surface');
    list.rect(r.x, r.y, r.width, r.height, {
      fill: mixColors(base, ui.color('text'), 0.1 * this.levels.hover),
      radius: theme.radius,
    });
    if (this.selected) list.rect(r.x, r.y + 6, 5, r.height - 12, { fill: ui.color('primary'), radius: 2.5 });
    const color = active ? ui.color('text') : ui.color('onDisabled'),
      layout = ui.textLayout(this.entry.label, 'body', Math.max(0, r.width - 28), 1.25, 'start'),
      h = layout.lineHeight * layout.lines.length;
    list.text(r.x + 14 - layout.bounds.left, r.y + (r.height - h) / 2, layout, ui.font, color);
    if (this.entry.detail) {
      const d = ui.textLayout(this.entry.detail, 'small', Infinity, 1.2, 'end'),
        dh = d.lineHeight * d.lines.length;
      list.text(
        r.x + r.width - 14 - (d.bounds.right - d.bounds.left) - d.bounds.left,
        r.y + (r.height - dh) / 2,
        d,
        ui.font,
        active ? ui.color('textMuted') : ui.color('onDisabled'),
      );
    }
    this.drawFocus(context, 0);
  }
}

/** Options for {@link List}. */
export interface ListOptions extends PanelOptions {
  /** The rows. */
  items?: readonly (string | ListEntry)[];
  /** Index of the selected row. Default -1 (none). */
  selected?: number;
  /** Called with `index` and `item` when a row is chosen by click, tap, Enter or the gamepad. */
  onSelect?: (event: UiEvent) => void;
}

/**
 * A vertical list of selectable rows that scrolls when it is taller than its box (give it a `height` or `maxHeight`).
 * Focus moves between rows with the arrow keys and the d-pad and scrolls the focused row into view.
 *
 * @example
 * const saves = new List({ items: ['Slot 1', 'Slot 2', 'Slot 3'], height: 180, onSelect: (e) => load(e.index!) });
 */
export class List extends Panel {
  private _items: ListEntry[] = [];
  private _selected = -1;

  constructor(options: ListOptions = {}) {
    const { items = [], selected = -1, onSelect, ...rest } = options;
    super({ background: 'surface', border: true, padding: 4, gap: 2, overflow: 'scroll', ...rest });
    this.role = 'listbox';
    this.items = items;
    this.select(selected);
    if (onSelect) this.on('select', onSelect);
  }
  get items(): readonly ListEntry[] {
    return this._items;
  }
  /** Replace the rows and clear the selection. @throws TypeError for an entry that is not a string or `{ label }`. */
  set items(items: readonly (string | ListEntry)[]) {
    if (!Array.isArray(items)) throw typeError('List items are an array of strings or { label } entries', 'ui');
    this._items = items.map((entry) => {
      if (typeof entry === 'string') return { label: entry };
      if (!entry || typeof entry.label !== 'string')
        throw typeError('A list entry is a string or has a string label', 'ui');
      return entry;
    });
    this._selected = -1;
    this.clear();
    this._items.forEach((entry, i) => this.add(new ListItem(this, i, entry)));
  }
  get selected(): number {
    return this._selected;
  }
  /** Index of the selected row, or -1. */
  get selectedItem(): ListEntry | undefined {
    return this._items[this._selected];
  }
  /**
   * Select a row (-1 clears). With `emit` it also fires `'select'`.
   * @throws RangeError for an index outside -1..length-1.
   */
  select(index: number, emit = false): void {
    if (!Number.isInteger(index) || index < -1 || index >= this._items.length) {
      if (index === -1) return;
      throw rangeError(`List index ${index} is outside 0..${this._items.length - 1}`, 'ui');
    }
    this._selected = index;
    for (const child of this.children) if (child instanceof ListItem) child.selected = child.index === index;
    this.invalidate(false);
    this.ui?.touchMirror();
    if (emit && index >= 0) {
      const entry = this._items[index];
      this.emit('select', { index, item: entry.value ?? entry });
    }
  }
}

/** An item in an {@link Inventory} slot. */
export interface InventoryItem {
  /** Your identifier, for example `'potion-health'`. */
  id: string;
  /** Shown in the tooltip and read by screen readers. */
  name: string;
  /** A symbol or emoji drawn in the slot. Default the first letter of `name`. */
  icon?: string;
  /** Stack size; shown when above 1. */
  count?: number;
  /** Second line of the tooltip. */
  description?: string;
  /** Accent colour of the slot's rim (a theme role or `#rrggbb`). */
  color?: ColorRef;
}

class Slot extends Widget {
  item: InventoryItem | null = null;
  constructor(
    readonly inventory: Inventory,
    readonly index: number,
  ) {
    super({});
    this.role = 'button';
    this.focusable = true;
    this.pointerEvents = 'auto';
  }
  override get text(): string {
    return this.item
      ? `${this.item.name}${(this.item.count ?? 1) > 1 ? `, ${this.item.count}` : ''}`
      : `Empty slot ${this.index + 1}`;
  }
  override activate(): void {
    if (this.active) this.inventory.activateSlot(this.index);
  }
  override command(command: UiCommand): boolean {
    return command === 'cancel' && this.inventory.cancelCarry();
  }
  override pointerDown(x: number, y: number): boolean {
    return this.active && this.inventory.beginDrag(this.index, x, y);
  }
  override pointerMove(x: number, y: number): void {
    this.inventory.dragTo(x, y);
  }
  override pointerUp(x: number, y: number): void {
    this.inventory.endDrag(x, y);
  }
  override draw(context: DrawContext): void {
    const { list, ui, theme } = context,
      r = this.rect,
      inv = this.inventory,
      carried = inv.carried === this.index,
      selected = inv.selected === this.index,
      dragging = inv.dragging === this.index;
    list.rect(r.x, r.y, r.width, r.height, {
      fill: mixColors(ui.color('surfaceSunken'), ui.color('text'), 0.1 * this.levels.hover),
      border: carried ? ui.color('accent') : selected ? ui.color('primary') : ui.color('border'),
      borderWidth: carried || selected ? Math.max(2, theme.borderWidth + 1) : theme.borderWidth,
      radius: Math.min(theme.radius, 8),
    });
    if (this.item && !dragging) this.drawItem(context, r.x, r.y, r.width, r.height);
    this.drawFocus(context, 2);
  }
  /** Draw the item's icon, count and rim in a box. */
  drawItem({ list, ui }: DrawContext, x: number, y: number, w: number, h: number, alpha = 1): void {
    const item = this.item!;
    if (item.color) {
      const c = ui.color(item.color);
      list.rect(x + 6, y + h - 7, w - 12, 3, { fill: [c[0], c[1], c[2], c[3] * alpha], radius: 1.5 });
    }
    const icon = item.icon ?? item.name.slice(0, 1).toUpperCase(),
      layout = ui.textLayout(icon, Math.round(h * 0.5), Infinity, 1.2, 'center'),
      lh = layout.lineHeight * layout.lines.length,
      color = ui.color('text');
    list.text(
      x + (w - (layout.bounds.right - layout.bounds.left)) / 2 - layout.bounds.left,
      y + (h - lh) / 2 - 2,
      layout,
      ui.font,
      [color[0], color[1], color[2], color[3] * alpha],
    );
    if ((item.count ?? 1) > 1) {
      const n = ui.textLayout(String(item.count), 'small', Infinity, 1.2, 'end');
      list.text(
        x + w - 6 - (n.bounds.right - n.bounds.left) - n.bounds.left,
        y + h - 6 - n.lineHeight - 4,
        n,
        ui.font,
        color,
        { width: 2, color: ui.color('surfaceSunken') },
      );
    }
  }
}

/** Options for {@link Inventory}. */
export interface InventoryOptions extends WidgetOptions {
  /** Columns of the grid. Default 5. */
  columns?: number;
  /** Number of slots. Default `columns` times 4. */
  slots?: number;
  /** Slot edge length in UI units. Default 56. */
  slotSize?: number;
  /** Space between slots. Default 6. */
  slotGap?: number;
  /** The items, one per slot, `null` for an empty slot. */
  items?: readonly (InventoryItem | null)[];
  /** `'select'` when an item is picked up, with `index` and `item`. */
  onSelect?: (event: UiEvent) => void;
  /** `'move'` when an item is dropped on another slot, with `from` and `index`. The inventory has already swapped them. */
  onMove?: (event: UiEvent) => void;
  /** `'use'` when a picked-up item is activated again, with `index` and `item`. */
  onUse?: (event: UiEvent) => void;
}

/**
 * A grid of item slots. Drag an item to another slot with a mouse or finger; or with the keyboard or a gamepad, press
 * accept on an item to pick it up, move to another slot and press accept to put it there (accept on the same slot
 * again uses it; cancel puts it back). Hovering or focusing a slot shows the item's name and description.
 *
 * @example
 * const bag = new Inventory({ columns: 4, slots: 12, items: [{ id: 'potion', name: 'Potion', icon: '🧪', count: 3 }] });
 * bag.on('use', (e) => drink(e.item));
 */
export class Inventory extends Widget {
  private _items: (InventoryItem | null)[] = [];
  private slotWidgets: Slot[] = [];
  /** The slot being dragged with a pointer, or -1. */
  dragging = -1;
  private dragStart: { x: number; y: number } | null = null;
  private dragPoint = { x: 0, y: 0 };
  private _selected = -1;
  private _carried = -1;

  /** @throws RangeError for a non-integer `columns` or `slots`, or `slots` below 0. */
  constructor(options: InventoryOptions = {}) {
    const { columns = 5, slots, slotSize = 56, slotGap = 6, items = [], onSelect, onMove, onUse, ...rest } = options;
    if (!Number.isInteger(columns) || columns < 1)
      throw rangeError('Inventory columns must be an integer of at least 1', 'ui');
    const count = slots ?? columns * 4;
    if (!Number.isInteger(count) || count < 0 || count > 4096)
      throw rangeError('Inventory slots must be an integer from 0 to 4096', 'ui');
    super({ direction: 'grid', columns, cellWidth: slotSize, cellHeight: slotSize, gap: slotGap, ...rest });
    this.role = 'group';
    for (let i = 0; i < count; i++) {
      const slot = new Slot(this, i);
      this.slotWidgets.push(slot);
      this.add(slot);
    }
    this.items = items;
    if (onSelect) this.on('select', onSelect);
    if (onMove) this.on('move', onMove);
    if (onUse) this.on('use', onUse);
  }
  get slots(): number {
    return this.slotWidgets.length;
  }
  get columns(): number {
    return this.style.columns ?? 1;
  }
  get items(): readonly (InventoryItem | null)[] {
    return this._items;
  }
  /** Replace all items; extra items beyond the slots are ignored. */
  set items(items: readonly (InventoryItem | null)[]) {
    this._items = this.slotWidgets.map((_, i) => items[i] ?? null);
    this.slotWidgets.forEach((slot, i) => this.sync(i));
    this._carried = this._selected = -1;
    this.invalidate(false);
    this.ui?.touchMirror();
  }
  /** The slot widget at `index`, for tests and custom focus. */
  slot(index: number): Widget {
    const slot = this.slotWidgets[index];
    if (!slot) throw rangeError(`Inventory slot ${index} does not exist`, 'ui');
    return slot;
  }
  /** Index of the slot holding the selection, or -1. */
  get selected(): number {
    return this._selected;
  }
  /** Index of the picked-up item, or -1. */
  get carried(): number {
    return this._carried;
  }
  /** The item in a slot, or null. */
  get(index: number): InventoryItem | null {
    return this._items[index] ?? null;
  }
  /** Put an item (or null) in a slot. @throws RangeError for a slot that does not exist. */
  set(index: number, item: InventoryItem | null): void {
    this.slot(index);
    this._items[index] = item;
    this.sync(index);
    this.invalidate(false);
    this.ui?.touchMirror();
  }
  /** Swap the contents of two slots and emit `'move'`. */
  swap(from: number, to: number): void {
    this.slot(from);
    this.slot(to);
    if (from === to) return;
    [this._items[from], this._items[to]] = [this._items[to], this._items[from]];
    this.sync(from);
    this.sync(to);
    this.invalidate(false);
    this.ui?.touchMirror();
    this.emit('move', { from, index: to, item: this._items[to] });
  }
  private sync(index: number): void {
    const slot = this.slotWidgets[index],
      item = this._items[index];
    slot.item = item;
    slot.tooltip = item ? (item.description ? `${item.name}\n${item.description}` : item.name) : undefined;
  }
  /** Keyboard, gamepad and tap behaviour of a slot: pick up, put down or use. */
  activateSlot(index: number): void {
    if (this._carried >= 0) {
      const from = this._carried;
      this._carried = -1;
      if (from === index) this.emit('use', { index, item: this._items[index] });
      else this.swap(from, index);
    } else if (this._items[index]) {
      this._carried = index;
      this._selected = index;
      this.emit('select', { index, item: this._items[index] });
    }
    this.invalidate(false);
  }
  /** Put a picked-up item back. Returns true if one was picked up. */
  cancelCarry(): boolean {
    if (this._carried < 0) return false;
    this._carried = -1;
    this.invalidate(false);
    return true;
  }
  /** @internal Called by a slot on pointer down. */
  beginDrag(index: number, x: number, y: number): boolean {
    this.dragStart = { x, y };
    this.dragPoint = { x, y };
    this.dragging = -1;
    this.pendingDrag = index;
    return true;
  }
  private pendingDrag = -1;
  /** @internal */
  dragTo(x: number, y: number): void {
    this.dragPoint = { x, y };
    if (
      this.dragging < 0 &&
      this.dragStart &&
      this.items[this.pendingDrag] &&
      Math.hypot(x - this.dragStart.x, y - this.dragStart.y) > 6
    ) {
      this.dragging = this.pendingDrag;
      this.ui?.cancelTooltip();
    }
    if (this.dragging >= 0) this.invalidate(false);
  }
  /** @internal Drop on the slot under the pointer, or treat a short press as an activation. */
  endDrag(x: number, y: number): void {
    const from = this.dragging,
      pending = this.pendingDrag;
    this.dragging = this.pendingDrag = -1;
    this.dragStart = null;
    if (from >= 0) {
      const to = this.slotAt(x, y);
      if (to >= 0 && to !== from) this.swap(from, to);
      this._carried = -1;
    } else if (pending >= 0 && this.slotAt(x, y) === pending) this.activateSlot(pending);
    this.invalidate(false);
  }
  private slotAt(x: number, y: number): number {
    return this.slotWidgets.findIndex(
      (s) => x >= s.rect.x && x < s.rect.x + s.rect.width && y >= s.rect.y && y < s.rect.y + s.rect.height,
    );
  }
  override draw(): void {}
  /** The dragged item follows the pointer above every slot. */
  override drawAfter(context: DrawContext): void {
    if (this.dragging < 0) return;
    const slot = this.slotWidgets[this.dragging],
      s = slot.rect;
    context.list.rect(this.dragPoint.x - s.width / 2, this.dragPoint.y - s.height / 2, s.width, s.height, {
      fill: withAlpha(context.ui.color('surfaceRaised'), 0.9),
      border: context.ui.color('primary'),
      borderWidth: 2,
      radius: 8,
    });
    slot.drawItem(context, this.dragPoint.x - s.width / 2, this.dragPoint.y - s.height / 2, s.width, s.height);
  }
}

/** One entry of a {@link Menu}. */
export interface MenuItem extends Pick<ButtonOptions, 'icon' | 'variant'> {
  label: string;
  /** Called when the entry is chosen. */
  onSelect?: () => void;
  disabled?: boolean;
}

/** Options for {@link Menu}. */
export interface MenuOptions extends PanelOptions {
  /** Heading above the entries. */
  title?: string;
  /** The entries, top to bottom. The first gets the `primary` look unless it sets `variant`. */
  items?: readonly MenuItem[];
}

/**
 * A titled column of full-width buttons: a main menu, pause menu or context menu. It is centred on screen by default;
 * the first entry takes focus when the keyboard or gamepad is first used.
 *
 * @example
 * ui.add(new Menu({ title: 'Paused', items: [{ label: 'Resume', onSelect: resume }, { label: 'Quit', onSelect: quit }] }));
 */
export class Menu extends Panel {
  private readonly heading: Label;
  constructor(options: MenuOptions = {}) {
    const { title = '', items = [], ...rest } = options;
    super({
      background: 'surface',
      border: true,
      shadow: true,
      padding: 24,
      gap: 8,
      width: 340,
      anchor: 'center',
      ...rest,
    });
    this.role = 'group';
    this.heading = new Label({ text: title, size: 'title', align: 'center', margin: [0, 0, 8, 0], visible: !!title });
    this.label = title;
    this.add(this.heading);
    items.forEach((item, i) => {
      const button = new Button({
        text: item.label,
        icon: item.icon,
        variant: item.variant ?? (i === 0 ? 'primary' : 'secondary'),
        enabled: !item.disabled,
      });
      if (item.onSelect) button.on('click', () => item.onSelect!());
      this.add(button);
    });
  }
  /** The heading text; also the menu's accessible name. */
  get title(): string {
    return this.heading.text;
  }
  set title(value: string) {
    this.heading.text = value;
    this.heading.visible = !!value;
    this.label = value;
  }
}
