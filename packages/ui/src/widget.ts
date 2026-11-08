/// <reference lib="esnext.disposable" preserve="true" />
import { rangeError, typeError } from '../../shared/errors.js';
import type { Rgba } from './color.js';
import type { DrawList } from './draw.js';
import { edges, validateStyle, type LayoutNode, type LayoutStyle, type Rect } from './layout.js';
import type { Theme, ThemeColors } from './theme.js';
import type { Ui } from './ui.js';

/** What an event handler receives. Which optional fields are set depends on `type`; each widget documents its events. */
export interface UiEvent {
  /** `'click'`, `'change'`, `'select'`, `'move'`, `'focus'`, `'blur'`, `'hover'`, `'press'`, `'close'` and so on. */
  type: string;
  /** The widget the event happened on. */
  target: Widget;
  /** The new value of a `'change'`. */
  value?: number | boolean | string;
  /** The index of a `'select'` or `'use'`, or the target slot of a `'move'`. */
  index?: number;
  /** The source slot of a `'move'`. */
  from?: number;
  /** The item of a `'select'` or `'use'`. */
  item?: unknown;
}

/** Handler for {@link Widget.on}. */
export type UiHandler = (event: UiEvent) => void;

/** Returned by {@link Widget.on}: call it to unsubscribe, or put it in a `using` declaration. */
export type Unsubscribe = (() => void) & { [Symbol.dispose](): void };

/** The input commands that move focus and operate controls: from the keyboard, a gamepad or code. */
export type UiCommand = 'up' | 'down' | 'left' | 'right' | 'accept' | 'cancel' | 'next' | 'previous';

/** Everything a widget needs to draw itself. */
export interface DrawContext {
  list: DrawList;
  ui: Ui;
  theme: Theme;
}

/** Options shared by every widget, on top of the {@link LayoutStyle} fields. */
export interface WidgetOptions extends LayoutStyle {
  /** Stable name for tests and lookups with `ui.find(id)`. Default `w1`, `w2`, ... */
  id?: string;
  /** Hidden widgets take no space and cannot be focused. Default true. */
  visible?: boolean;
  /** Disabled widgets draw dimmed and ignore pointer, keyboard and gamepad. Default true. */
  enabled?: boolean;
  /** Name for screen readers; defaults to the widget's text. */
  label?: string;
  /** Longer description for screen readers. */
  description?: string;
  /** Text shown after hovering for half a second, or when the keyboard focuses the widget. */
  tooltip?: string;
  /** Whether pointers hit this widget. Default `'auto'` for anything that draws or reacts, `'none'` for plain layout boxes and labels. */
  pointerEvents?: 'auto' | 'none';
  /** Children, as with {@link Widget.add}. */
  children?: readonly Widget[];
}

let counter = 0;

/**
 * Base of every widget: a box in the layout tree with children, state, events and a draw method. Subclasses draw
 * themselves in `draw` and call `invalidate()` when something that changes size or looks has changed.
 */
export class Widget implements LayoutNode {
  /** Stable name, unique within a {@link Ui}. */
  readonly id: string;
  /** Child widgets in draw and focus order. Change them with `add`, `remove` and `clear`. */
  readonly children: Widget[] = [];
  parent: Widget | null = null;
  /** The UI this widget is part of, or null while detached. */
  ui: Ui | null = null;
  /** Position and size in UI units, written by the layout. */
  rect: Rect = { x: 0, y: 0, width: 0, height: 0 };
  scrollX = 0;
  scrollY = 0;
  contentWidth = 0;
  contentHeight = 0;
  /** The screen reader role this widget mirrors. */
  role = 'generic';
  /** True while a pointer is over the widget. */
  hovered = false;
  /** True while a pointer or the accept key is held on the widget. */
  pressed = false;
  /** True while the widget has input focus. */
  focused = false;
  /** True when the focus ring shows: focus that came from the keyboard or a gamepad. */
  focusVisible = false;
  /** Opacity of the widget and its children, 0..1. Default 1. */
  get opacity(): number {
    return 1;
  }
  /** Whether keyboard, gamepad and tab navigation can land on this widget. Controls set it. */
  focusable = false;
  /** Smoothed 0..1 hover, press and focus levels for transitions. */
  protected readonly levels = { hover: 0, press: 0, focus: 0 };
  private readonly handlers = new Map<string, Set<UiHandler>>();
  private _style: LayoutStyle;
  private _visible: boolean;
  private _enabled: boolean;
  private _label?: string;
  private _description?: string;
  private _tooltip?: string;
  pointerEvents: 'auto' | 'none';

  /** @throws TypeError or RangeError for an invalid style field, `children` entry or `pointerEvents`. */
  constructor(options: WidgetOptions = {}) {
    const { id, visible, enabled, label, description, tooltip, pointerEvents, children, ...style } = options;
    this.id = id ?? `w${++counter}`;
    if (typeof this.id !== 'string' || !this.id) throw typeError('A widget id is a non-empty string', 'ui');
    this._style = validateStyle({ ...style });
    this._visible = visible ?? true;
    this._enabled = enabled ?? true;
    this._label = label;
    this._description = description;
    this._tooltip = tooltip;
    if (pointerEvents !== undefined && pointerEvents !== 'auto' && pointerEvents !== 'none')
      throw typeError("pointerEvents is 'auto' or 'none'", 'ui');
    this.pointerEvents = pointerEvents ?? 'none';
    if (children) this.add(...children);
  }

  /** The layout style. Change it with {@link Widget.setStyle}. */
  get style(): Readonly<LayoutStyle> {
    return this._style;
  }
  /** Merge layout fields into the style (set a field to `undefined` to reset it). */
  setStyle(patch: LayoutStyle): this {
    this._style = validateStyle({ ...this._style, ...patch });
    this.invalidate();
    return this;
  }

  /** @internal Change the style without asking for a layout; for the UI's own layers. */
  setStyleQuiet(patch: LayoutStyle): void {
    this._style = { ...this._style, ...patch };
  }

  get visible(): boolean {
    return this._visible;
  }
  set visible(value: boolean) {
    if (value === this._visible) return;
    this._visible = value;
    if (!value) this.ui?.widgetHidden(this);
    this.invalidate();
  }
  get enabled(): boolean {
    return this._enabled;
  }
  set enabled(value: boolean) {
    if (value === this._enabled) return;
    this._enabled = value;
    if (!value) this.ui?.widgetHidden(this);
    this.invalidate(false);
  }
  /** The accessible name: the `label` option, or the widget's own text. */
  get label(): string {
    return this._label ?? this.text ?? '';
  }
  set label(value: string | undefined) {
    this._label = value;
    this.ui?.touchMirror();
  }
  get description(): string | undefined {
    return this._description;
  }
  set description(value: string | undefined) {
    this._description = value;
    this.ui?.touchMirror();
  }
  get tooltip(): string | undefined {
    return this._tooltip;
  }
  set tooltip(value: string | undefined) {
    this._tooltip = value;
  }
  /** Text the widget shows, if any. Labels, buttons and toggles override it. */
  get text(): string | undefined {
    return undefined;
  }

  /** True when this widget and every ancestor is visible. */
  get shown(): boolean {
    for (let w: Widget | null = this; w; w = w.parent) if (!w._visible) return false;
    return true;
  }
  /** True when this widget and every ancestor is enabled. */
  get active(): boolean {
    for (let w: Widget | null = this; w; w = w.parent) if (!w._enabled) return false;
    return true;
  }

  /**
   * Append children, moving a child that already has a parent.
   * @throws TypeError for a non-widget or a widget's own ancestor.
   */
  add(...children: Widget[]): this {
    for (const child of children) this.insert(child, this.children.length);
    return this;
  }
  /** Insert `child` at `index` (clamped), moving it if it already has a parent. */
  insert(child: Widget, index: number): this {
    if (!(child instanceof Widget)) throw typeError('Expected a Widget; create one with new Panel() and similar', 'ui');
    for (let w: Widget | null = this; w; w = w.parent)
      if (w === child) throw typeError('A widget cannot contain itself or its ancestor', 'ui');
    if (!Number.isInteger(index)) throw rangeError('index must be an integer', 'ui');
    const from = child.parent === this ? this.children.indexOf(child) : -1;
    child.parent?.detach(child);
    if (from >= 0 && from < index) index--;
    this.children.splice(Math.max(0, Math.min(this.children.length, index)), 0, child);
    child.parent = this;
    child.attachTo(this.ui);
    this.invalidate();
    return this;
  }
  /** Remove `child` if it is one of the children. */
  remove(child: Widget): this {
    if (child.parent === this) this.detach(child);
    return this;
  }
  /** Remove every child. */
  clear(): this {
    for (const child of [...this.children]) this.detach(child);
    return this;
  }
  /** Remove this widget from its parent. */
  removeFromParent(): this {
    this.parent?.detach(this);
    return this;
  }
  private detach(child: Widget): void {
    const index = this.children.indexOf(child);
    if (index < 0) return;
    this.children.splice(index, 1);
    child.parent = null;
    this.ui?.widgetRemoved(child);
    child.attachTo(null);
    this.invalidate();
  }
  /** @internal Set `ui` for this subtree. */
  attachTo(ui: Ui | null): void {
    if (this.ui === ui) return;
    this.ui = ui;
    this.attached(ui);
    for (const child of this.children) child.attachTo(ui);
    ui?.widgetAdded(this);
  }
  /** Called when the widget joins or leaves a {@link Ui}. */
  protected attached(_ui: Ui | null): void {}

  /** The first widget in this subtree with this `id`, or undefined. */
  find(id: string): Widget | undefined {
    if (this.id === id) return this;
    for (const child of this.children) {
      const found = child.find(id);
      if (found) return found;
    }
    return undefined;
  }
  /** Visit this widget and every descendant, parents first. */
  walk(visit: (widget: Widget) => void): void {
    visit(this);
    for (const child of [...this.children]) child.walk(visit);
  }

  /**
   * Listen for an event. Returns a function that removes the listener; it is also disposable, so
   * `using off = button.on('click', fn)` works.
   */
  on(type: string, handler: UiHandler): Unsubscribe {
    if (typeof type !== 'string' || typeof handler !== 'function')
      throw typeError('on(type, handler) takes an event name and a function', 'ui');
    let set = this.handlers.get(type);
    if (!set) this.handlers.set(type, (set = new Set()));
    set.add(handler);
    const off = (() => void set!.delete(handler)) as Unsubscribe;
    off[Symbol.dispose ?? Symbol.for('Symbol.dispose')] = off;
    return off;
  }
  /** Call the listeners of `type`. */
  emit(type: string, detail: Omit<UiEvent, 'type' | 'target'> = {}): void {
    const set = this.handlers.get(type);
    if (!set) return;
    const event: UiEvent = { ...detail, type, target: this };
    for (const handler of [...set]) handler(event);
  }

  /** Ask the UI to lay out (default) or only redraw the next frame. */
  invalidate(layout = true): void {
    this.ui?.invalidate(layout);
  }

  /** Content size without padding, for a box with no children; wrapped to at most `maxWidth`. */
  measure(_maxWidth: number): { width: number; height: number } {
    return { width: 0, height: 0 };
  }
  /** Draw this widget's own look; the children are drawn after it. */
  draw(_context: DrawContext): void {}
  /** Draw above the children, for example a dragged item. */
  drawAfter(_context: DrawContext): void {}
  /**
   * Advance transitions by `dt` seconds. Return true while something still moves, which keeps the UI redrawing.
   * Subclasses extend it and call `super.tick`.
   */
  tick(dt: number): boolean {
    const rate = this.ui && this.ui.motion ? dt / Math.max(0.001, this.ui.theme.transition) : 1;
    const move = (key: 'hover' | 'press' | 'focus', target: boolean) => {
      const from = this.levels[key],
        to = target ? 1 : 0;
      if (from === to) return false;
      this.levels[key] = target ? Math.min(1, from + rate) : Math.max(0, from - rate);
      return true;
    };
    const a = move('hover', this.hovered && this.active),
      b = move('press', this.pressed),
      c = move('focus', this.focusVisible);
    return a || b || c;
  }

  /**
   * Handle a navigation or accept command before the UI uses it to move focus. Return true to consume it:
   * a slider takes left and right, a text field would take everything.
   */
  command(_command: UiCommand): boolean {
    return false;
  }
  /** Do what the widget does when clicked, tapped, or accepted with the keyboard or a gamepad. */
  activate(): void {}
  /** A pointer went down on this widget (`x`, `y` in UI units). Return true to capture the pointer for drags. */
  pointerDown(_x: number, _y: number): boolean {
    return false;
  }
  /** A captured pointer moved. */
  pointerMove(_x: number, _y: number): void {}
  /** A captured pointer was released. */
  pointerUp(_x: number, _y: number): void {}
  /** The wheel turned over this widget (`dy` in UI units, positive scrolls down). Return true if it was used. */
  wheel(dy: number): boolean {
    if (this._style.overflow !== 'scroll') return false;
    // The children scroll inside the padding: the view is the box less its top and bottom padding, as arrange clamps it.
    const [top, , bottom] = edges(this._style.padding),
      view = Math.max(0, this.rect.height - top - bottom),
      before = this.scrollY;
    this.scrollY = Math.max(0, Math.min(Math.max(0, this.contentHeight - view), this.scrollY + dy));
    if (this.scrollY !== before) this.invalidate();
    return this.scrollY !== before;
  }

  /** The deepest widget under (x, y) in UI units that takes pointer events, honouring clipping. */
  hitTest(x: number, y: number): Widget | null {
    if (!this._visible) return null;
    const r = this.rect;
    const inside = x >= r.x && x < r.x + r.width && y >= r.y && y < r.y + r.height;
    const clips = this._style.overflow && this._style.overflow !== 'visible';
    if (clips && !inside) return null;
    for (let i = this.children.length - 1; i >= 0; i--) {
      const hit = this.children[i].hitTest(x, y);
      if (hit) return hit;
    }
    return inside && this.pointerEvents === 'auto' ? this : null;
  }

  /** Draw the focus ring around the widget when the keyboard or gamepad focus is on it. */
  protected drawFocus({ list, theme }: DrawContext, grow = 3): void {
    if (this.levels.focus <= 0) return;
    const r = this.rect,
      color = this.ui!.color('focus'),
      c: Rgba = [color[0], color[1], color[2], color[3] * this.levels.focus];
    list.rect(r.x - grow, r.y - grow, r.width + 2 * grow, r.height + 2 * grow, {
      border: c,
      borderWidth: theme.focusWidth,
      radius: theme.radius + grow,
    });
  }

  /** Scroll the scrolling ancestors so this widget is fully visible. */
  scrollIntoView(): void {
    for (let a = this.parent; a; a = a.parent) {
      if (a._style.overflow !== 'scroll') continue;
      const r = this.rect,
        v = a.rect;
      if (r.y < v.y) a.scrollY = Math.max(0, a.scrollY - (v.y - r.y) - 4);
      else if (r.y + r.height > v.y + v.height) a.scrollY += r.y + r.height - (v.y + v.height) + 4;
      a.invalidate();
    }
  }

  /** Remove the widget from its parent and release what it holds. */
  dispose(): void {
    this.removeFromParent();
    for (const child of [...this.children]) child.dispose();
    this.handlers.clear();
  }
  declare [Symbol.dispose]: () => void;
  [(Symbol.dispose ?? Symbol.for('Symbol.dispose')) as symbol](): void {
    this.dispose();
  }
}

/** A colour role of the theme or a `#rrggbb[aa]` string. */
export type ColorRef = keyof ThemeColors | (string & {});
