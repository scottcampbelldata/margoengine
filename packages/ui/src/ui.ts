/// <reference lib="esnext.disposable" preserve="true" />
import { Font, layoutText, type FontOptions, type TextLayout, type TextMeasurer } from '@margoengine/text';
import { fault, rangeError, typeError } from '../../shared/errors.js';
import { Panel, type TextSize } from './basic.js';
import { parseRgba, type Rgba } from './color.js';
import { DrawList } from './draw.js';
import { arrange, edges } from './layout.js';
import { Dialog, Toast, Tooltip, type DialogOptions, type ToastOptions } from './overlays.js';
import { themeForPreferences, type Theme, type ThemeColors } from './theme.js';
import type { ColorRef, DrawContext, Widget } from './widget.js';

/** Scale the UI with the window so a layout made for one resolution fills any other. */
export interface ScaleOptions {
  /** The window size, in CSS pixels, the layout was designed for, for example `[1280, 720]`. */
  reference: readonly [number, number];
  /** How much the height decides (1) rather than the width (0) when the aspect ratio differs. Default 0.5. */
  match?: number;
  /** Smallest scale. Default 0.5. */
  min?: number;
  /** Largest scale. Default 4. */
  max?: number;
}

/**
 * The factor that turns window CSS pixels into UI units for a window of `width` by `height`: 1 for a plain number
 * scale of 1 (the default), the number itself, or for a reference size `(w / rw) ** (1 - match) * (h / rh) ** match`
 * between `min` and `max`.
 * @throws RangeError for a non-positive size or an invalid reference.
 */
export function resolutionScale(width: number, height: number, scale: number | ScaleOptions = 1): number {
  if (typeof scale === 'number') {
    if (!Number.isFinite(scale) || scale <= 0) throw rangeError('scale must be a number above 0', 'ui');
    return scale;
  }
  const [rw, rh] = scale.reference ?? [],
    match = scale.match ?? 0.5;
  if (!(rw > 0) || !(rh > 0) || !Number.isFinite(rw) || !Number.isFinite(rh))
    throw rangeError('scale.reference is [width, height] above 0', 'ui');
  if (!(match >= 0 && match <= 1)) throw rangeError('scale.match is between 0 and 1', 'ui');
  if (!(width > 0) || !(height > 0)) return 1;
  const value = (width / rw) ** (1 - match) * (height / rh) ** match;
  return Math.max(scale.min ?? 0.5, Math.min(scale.max ?? 4, value));
}

/** Insets in CSS pixels: `[top, right, bottom, left]`. */
export type SafeArea = readonly [number, number, number, number];

/**
 * The device's safe-area insets (notches, rounded corners, system bars) in CSS pixels, read from the CSS `env()`
 * values. All zero where there is no document or the page has no `viewport-fit=cover`.
 */
export function readSafeArea(document: Document | undefined = globalThis.document): SafeArea {
  if (!document?.body) return [0, 0, 0, 0];
  const probe = document.createElement('div');
  probe.style.cssText =
    'position:fixed;visibility:hidden;pointer-events:none;padding:env(safe-area-inset-top,0px) env(safe-area-inset-right,0px) env(safe-area-inset-bottom,0px) env(safe-area-inset-left,0px)';
  document.body.append(probe);
  const style = getComputedStyle(probe),
    px = (value: string) => Number.parseFloat(value) || 0,
    result: SafeArea = [px(style.paddingTop), px(style.paddingRight), px(style.paddingBottom), px(style.paddingLeft)];
  probe.remove();
  return result;
}

/** Options for `new Ui(...)`. Every field is optional. */
export interface UiOptions {
  /** Width of the window or canvas in CSS pixels. Default 1280. Change it later with `ui.resize()`. */
  width?: number;
  /** Height in CSS pixels. Default 720. */
  height?: number;
  /** Device pixels per CSS pixel. Default 1. */
  pixelRatio?: number;
  /** Resolution scaling: a number of UI units per CSS pixel, or a reference size. Default 1 (UI units are CSS pixels). */
  scale?: number | ScaleOptions;
  /** The look. Default {@link themeForPreferences}: dark, or light / high contrast when the user asks for them. */
  theme?: Theme;
  /** The text package font, or options for one. Default `system-ui, sans-serif` at weight 500. */
  font?: Font | FontOptions;
  /** Measures text instead of the font; for tests and server rendering. */
  measurer?: TextMeasurer;
  /** The user's text size preference, 0.5 to 3. Default 1. */
  textScale?: number;
  /** Safe area in CSS pixels (`[top, right, bottom, left]`), or `'auto'` to read the device's. Default `'auto'`. */
  safeArea?: SafeArea | 'auto';
  /** Turn transitions off. Default the user's `prefers-reduced-motion`. */
  reducedMotion?: boolean;
}

const MAX_TOASTS = 5;
const LINE_HEIGHT = 1.25;
const ALIGN = { start: 'left', center: 'center', end: 'right' } as const;

/**
 * A game user interface: a tree of widgets in layers (screen, dialogs, toasts, tooltips), a theme, resolution and text
 * scaling, and a draw list for the engine to render. It owns no GPU resources and touches no DOM, so it runs
 * anywhere; {@link UiRenderer} draws it and {@link UiInput} connects a canvas.
 *
 * @example
 * const ui = new Ui();
 * ui.add(new Menu({ title: 'Paused', items: [{ label: 'Resume', onSelect: () => ui.toast('Resumed') }] }));
 * ui.update(1 / 60);
 * const commands = ui.draw().commands; // rectangles and text, in pixels
 */
export class Ui {
  /** The screen layer: add HUD and menu widgets here (or with {@link Ui.add}). */
  readonly root: Panel;
  /** Dialogs, above the screen, dimming it. */
  readonly modalLayer: Panel;
  /** Toasts, above dialogs. */
  readonly toastLayer: Panel;
  /** The tooltip bubble, above everything. */
  readonly tooltipLayer: Panel;
  readonly font: Font;
  /** Resolves when the font is ready to draw with. */
  readonly ready: Promise<void>;
  private readonly measurer: TextMeasurer;
  private readonly toastStack: Panel;
  private readonly tooltip: Tooltip;
  private readonly layers: Panel[];
  private readonly list = new DrawList();
  private readonly context: DrawContext;
  private readonly cache = new Map<string, TextLayout>();
  private readonly colors = new Map<string, Rgba>();
  private _theme: Theme;
  private _textScale = 1;
  private _scale: number | ScaleOptions;
  private _width: number;
  private _height: number;
  private _pixelRatio: number;
  private _safeArea: SafeArea | 'auto';
  private _motion: boolean;
  private resolved = 1;
  private layoutDirty = true;
  private drawDirty = true;
  private fontRevision = 0;
  private disposed = false;
  private readonly changeListeners = new Set<() => void>();
  /** Increases whenever any widget's text, state or position changed; the accessibility mirror syncs on it. */
  mirrorRevision = 0;

  /**
   * @throws RangeError for a size, ratio, scale or text scale outside its range.
   * @throws TypeError for a theme, font or measurer of the wrong type.
   */
  constructor(options: UiOptions = {}) {
    const { width = 1280, height = 720, pixelRatio = 1, scale = 1, textScale = 1, safeArea = 'auto' } = options;
    this._theme = options.theme ?? themeForPreferences();
    if (!this._theme || typeof this._theme !== 'object' || !this._theme.colors)
      throw typeError('theme must come from createTheme() or themes', 'ui');
    if (
      options.measurer &&
      (typeof options.measurer.advance !== 'function' || typeof options.measurer.metrics !== 'function')
    )
      throw typeError('measurer needs advance(), kerning() and metrics()', 'ui');
    this.font =
      options.font instanceof Font
        ? options.font
        : new Font({ family: 'system-ui, sans-serif', weight: 500, ...options.font });
    this.measurer = options.measurer ?? this.font;
    this._motion = !(
      options.reducedMotion ??
      (typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches)
    );
    this._scale = scale;
    resolutionScale(1, 1, scale);
    this._width = this._height = 0;
    this._pixelRatio = 1;
    this._safeArea = safeArea;
    this.checkSize(width, height, pixelRatio);
    this._width = width;
    this._height = height;
    this._pixelRatio = pixelRatio;
    this.setTextScale(textScale);
    this.root = new Panel({ id: 'ui-root', direction: 'stack', radius: 0 });
    this.modalLayer = new Panel({ id: 'ui-modal', direction: 'stack', radius: 0 });
    this.toastLayer = new Panel({ id: 'ui-toasts', direction: 'stack', radius: 0 });
    this.tooltipLayer = new Panel({ id: 'ui-tooltip', direction: 'stack', radius: 0 });
    this.toastStack = new Panel({ id: 'ui-toast-stack', anchor: 'bottom', gap: 8, margin: 24, align: 'center' });
    this.tooltip = new Tooltip();
    this.toastLayer.add(this.toastStack);
    this.tooltipLayer.add(this.tooltip);
    this.layers = [this.root, this.modalLayer, this.toastLayer, this.tooltipLayer];
    for (const layer of this.layers) layer.attachTo(this);
    this.context = { list: this.list, ui: this, theme: this._theme };
    this.resolved = resolutionScale(width, height, scale);
    this.ready = this.measurer === this.font ? this.font.load() : Promise.resolve();
  }

  private checkSize(width: number, height: number, pixelRatio: number): void {
    if (![width, height].every((n) => Number.isFinite(n) && n > 0 && n <= 65536))
      throw rangeError('Ui width and height must be numbers from 0 to 65536', 'ui');
    if (!Number.isFinite(pixelRatio) || pixelRatio <= 0 || pixelRatio > 16)
      throw rangeError('pixelRatio must be a number above 0 and up to 16', 'ui');
  }

  /** The theme. Set another one to restyle the whole UI at once. */
  get theme(): Theme {
    return this._theme;
  }
  set theme(theme: Theme) {
    if (!theme || typeof theme !== 'object' || !theme.colors)
      throw typeError('theme must come from createTheme() or themes', 'ui');
    this._theme = theme;
    this.context.theme = theme;
    this.colors.clear();
    this.invalidate(true);
  }
  /** The user's text size multiplier. */
  get textScale(): number {
    return this._textScale;
  }
  set textScale(value: number) {
    this.setTextScale(value);
    this.invalidate(true);
  }
  private setTextScale(value: number): void {
    if (!Number.isFinite(value) || value < 0.5 || value > 3)
      throw rangeError('textScale must be a number from 0.5 to 3', 'ui');
    this._textScale = value;
    this.cache.clear();
  }
  /** False when transitions are off (reduced motion). */
  get motion(): boolean {
    return this._motion;
  }
  set motion(value: boolean) {
    this._motion = !!value;
  }
  /** Width of the screen in UI units. */
  get width(): number {
    return this._width / this.resolved;
  }
  /** Height of the screen in UI units. */
  get height(): number {
    return this._height / this.resolved;
  }
  /** Device pixels per UI unit: the pixel ratio times the resolution scaling. */
  get scale(): number {
    return this._pixelRatio * this.resolved;
  }
  /** CSS pixels per UI unit; pointer coordinates in CSS pixels are divided by it. */
  get cssScale(): number {
    return this.resolved;
  }
  get pixelRatio(): number {
    return this._pixelRatio;
  }
  /** Safe-area insets in UI units, `[top, right, bottom, left]`. */
  get safeArea(): readonly [number, number, number, number] {
    const inset = this._safeArea === 'auto' ? readSafeArea() : this._safeArea;
    return inset.map((v) => v / this.resolved) as unknown as [number, number, number, number];
  }
  /** Set the safe area in CSS pixels, or `'auto'` to read the device's on each resize. */
  setSafeArea(inset: SafeArea | 'auto'): void {
    if (inset !== 'auto') edges(inset as [number, number, number, number]);
    this._safeArea = inset;
    this.invalidate(true);
  }

  /**
   * Set the window size in CSS pixels and the device pixel ratio. {@link UiRenderer} calls this each frame from the
   * canvas; call it yourself when drawing the list elsewhere.
   * @throws RangeError for a size or ratio outside its range.
   */
  resize(width: number, height: number, pixelRatio = this._pixelRatio): void {
    this.checkSize(width, height, pixelRatio);
    if (width === this._width && height === this._height && pixelRatio === this._pixelRatio) return;
    this._width = width;
    this._height = height;
    this._pixelRatio = pixelRatio;
    this.resolved = resolutionScale(width, height, this._scale);
    this.invalidate(true);
  }
  /** Change the resolution scaling. */
  setScale(scale: number | ScaleOptions): void {
    resolutionScale(1, 1, scale);
    this._scale = scale;
    this.resolved = resolutionScale(this._width, this._height, scale);
    this.invalidate(true);
  }

  /** Add widgets to the screen layer. */
  add(...widgets: Widget[]): this {
    this.root.add(...widgets);
    return this;
  }
  /** Remove a widget from the screen layer. */
  remove(widget: Widget): this {
    this.root.remove(widget);
    return this;
  }
  /** The first widget with this id in any layer, or undefined. */
  find(id: string): Widget | undefined {
    for (const layer of this.layers) {
      const found = layer.find(id);
      if (found) return found;
    }
    return undefined;
  }
  /** Visit every widget in every layer, back to front. */
  walk(visit: (widget: Widget) => void): void {
    for (const layer of this.layers) layer.walk(visit);
  }

  /** The colour of a theme role or `#rrggbb[aa]` string as straight sRGB. */
  color(ref: ColorRef): Rgba {
    const hex = (this._theme.colors as unknown as Record<string, string>)[ref as keyof ThemeColors] ?? ref;
    let color = this.colors.get(hex);
    if (!color) this.colors.set(hex, (color = parseRgba(hex)));
    return color;
  }

  /** A text size in UI units, with the user's text scale applied. */
  fontSize(size: TextSize): number {
    const base = typeof size === 'number' ? size : this._theme.fontSize[size];
    if (!(base > 0))
      throw rangeError(`Unknown text size '${String(size)}'; use small, body, large, title, display or a number`, 'ui');
    return base * this._textScale;
  }

  /**
   * Lay out text with the font: wrapped to `maxWidth` UI units, `align`ed within its widest line. Results are cached.
   * @throws TypeError or RangeError for a bad size or width.
   */
  textLayout(
    text: string,
    size: TextSize,
    maxWidth = Infinity,
    lineHeight = LINE_HEIGHT,
    align: 'start' | 'center' | 'end' = 'start',
  ): TextLayout {
    const fontSize = this.fontSize(size);
    if (this.font.revision !== this.fontRevision) {
      this.fontRevision = this.font.revision;
      this.cache.clear();
    }
    const key = `${fontSize}|${maxWidth}|${lineHeight}|${align}|${text}`;
    let layout = this.cache.get(key);
    if (!layout) {
      if (this.cache.size > 4000) this.cache.clear();
      layout = layoutText(
        text,
        {
          fontSize,
          lineHeight,
          maxWidth: Math.max(0, maxWidth),
          textAlign: ALIGN[align],
          whiteSpace: 'normal',
          anchorX: 'left',
          anchorY: 'top',
        },
        this.measurer,
      );
      this.cache.set(key, layout);
    }
    return layout;
  }
  /** Size of `text` wrapped to `maxWidth`, in UI units. */
  measureText(
    text: string,
    size: TextSize,
    maxWidth = Infinity,
    lineHeight = LINE_HEIGHT,
  ): { width: number; height: number } {
    const layout = this.textLayout(text, size, maxWidth, lineHeight);
    return { width: layout.bounds.right - layout.bounds.left, height: layout.lineHeight * layout.lines.length };
  }

  /** Ask for a layout (default) or only a redraw on the next update. */
  invalidate(layout = true): void {
    if (layout) this.layoutDirty = true;
    this.drawDirty = true;
    this.mirrorRevision++;
    for (const listener of this.changeListeners) listener();
  }
  /** Tell the accessibility mirror that text or state changed. */
  touchMirror(): void {
    this.mirrorRevision++;
    this.drawDirty = true;
  }
  /** Run `listener` whenever the UI changed; returns a function that stops it. */
  onChange(listener: () => void): () => void {
    this.changeListeners.add(listener);
    return () => this.changeListeners.delete(listener);
  }
  /** @internal */
  widgetAdded(_widget: Widget): void {}
  /** @internal */
  widgetRemoved(_widget: Widget): void {}
  /** @internal */
  widgetHidden(_widget: Widget): void {}
  /** @internal */
  cancelTooltip(): void {}
  /** @internal */
  dialogClosed(_dialog: Dialog): void {
    const open = this.modalLayer.children.length > 0;
    this.modalLayer.background = open ? 'scrim' : 'none';
    this.modalLayer.pointerEvents = open ? 'auto' : 'none';
  }

  /** Lay out the layers now, if anything changed. {@link Ui.update} and {@link Ui.draw} do this for you. */
  layout(): void {
    if (!this.layoutDirty) return;
    this.layoutDirty = false;
    const w = this.width,
      h = this.height,
      safe = this.safeArea;
    for (const layer of this.layers) {
      layer.setStyleQuiet({ padding: safe });
      arrange(layer, { x: 0, y: 0, width: w, height: h });
    }
    this.drawDirty = true;
  }

  /**
   * Advance transitions, toasts and tooltips by `dt` seconds (clamped to 0.1) and lay out whatever changed.
   * {@link UiRenderer} calls this every frame; call it yourself when you render the draw list elsewhere.
   */
  update(dt = 0): void {
    if (this.disposed) throw fault('disposed', 'Ui is disposed; create a new Ui', 'ui');
    if (!Number.isFinite(dt) || dt < 0) throw rangeError('dt must be a finite number of seconds, 0 or more', 'ui');
    if (this.font.revision !== this.fontRevision) {
      this.fontRevision = this.font.revision;
      this.cache.clear();
      this.layoutDirty = true;
    }
    this.layout();
    dt = Math.min(dt, 0.1);
    let moving = false;
    for (const layer of this.layers) layer.walk((w) => (moving = w.tick(dt) || moving));
    if (moving) this.drawDirty = true;
    if (this.layoutDirty) this.layout();
  }

  /** The draw list for the current state: rebuilt only when something changed since the last call. */
  draw(): DrawList {
    this.layout();
    if (this.drawDirty || this.list.scale !== this.scale) {
      this.drawDirty = false;
      this.list.clear(this.scale);
      for (const layer of this.layers) this.drawWidget(layer);
    }
    return this.list;
  }
  private drawWidget(widget: Widget): void {
    if (!widget.visible) return;
    const list = this.list,
      before = list.alpha;
    list.alpha = before * widget.opacity;
    widget.draw(this.context);
    const clip = widget.style.overflow && widget.style.overflow !== 'visible';
    if (clip) list.pushClip(widget.rect.x, widget.rect.y, widget.rect.width, widget.rect.height);
    for (const child of widget.children) this.drawWidget(child);
    if (clip) list.popClip();
    widget.drawAfter(this.context);
    list.alpha = before;
  }

  /**
   * Show a modal dialog and resolve with the chosen button's value (see {@link DialogOptions}).
   * @throws TypeError or RangeError for invalid options; the promise rejects with the signal's reason when aborted.
   */
  dialog(options: DialogOptions = {}): Promise<unknown> {
    this.live();
    const dialog = new Dialog(options);
    this.modalLayer.add(dialog);
    this.dialogOpened(dialog);
    return dialog.result;
  }
  /** @internal */
  dialogOpened(_dialog: Dialog): void {
    this.modalLayer.background = 'scrim';
    this.modalLayer.pointerEvents = 'auto';
  }
  /** Ask a yes or no question; resolves true for the confirm button and false otherwise. */
  async confirm(
    message: string,
    options: { title?: string; confirmLabel?: string; cancelLabel?: string; signal?: AbortSignal } = {},
  ): Promise<boolean> {
    const answer = await this.dialog({
      title: options.title,
      message,
      signal: options.signal,
      cancelValue: false,
      buttons: [
        { label: options.confirmLabel ?? 'OK', value: true },
        { label: options.cancelLabel ?? 'Cancel', value: false },
      ],
    });
    return answer === true;
  }
  /** Show a message with one OK button. */
  async alert(message: string, options: { title?: string; signal?: AbortSignal } = {}): Promise<void> {
    await this.dialog({ title: options.title, message, signal: options.signal, cancelValue: undefined });
  }
  /**
   * Show a short message that fades after a few seconds. At most five toasts show at once; the oldest is dismissed
   * first.
   */
  toast(message: string, options: ToastOptions = {}): Toast {
    this.live();
    if (typeof message !== 'string' || !message) throw typeError('toast(message) takes a non-empty string', 'ui');
    const toast = new Toast(message, options);
    this.toastStack.add(toast);
    const live = this.toastStack.children.filter((t) => t instanceof Toast && !t.dismissed);
    for (const old of live.slice(0, Math.max(0, live.length - MAX_TOASTS))) (old as Toast).dismiss();
    return toast;
  }
  /** The tooltip widget, for tests and custom placement. */
  get tooltipWidget(): Tooltip {
    return this.tooltip;
  }
  private live(): void {
    if (this.disposed) throw fault('disposed', 'Ui is disposed; create a new Ui', 'ui');
  }
  /** Remove every widget and stop. Idempotent. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const layer of this.layers) layer.dispose();
    this.changeListeners.clear();
  }
  declare [Symbol.dispose]: () => void;
  [(Symbol.dispose ?? Symbol.for('Symbol.dispose')) as symbol](): void {
    this.dispose();
  }
}
