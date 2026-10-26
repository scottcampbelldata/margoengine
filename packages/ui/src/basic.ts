import { typeError } from '../../shared/errors.js';
import type { Rgba } from './color.js';
import { Widget, type ColorRef, type DrawContext, type WidgetOptions } from './widget.js';

/** Which surface colour a {@link Panel} draws. `'none'` draws nothing, so the panel is only a layout box. */
export type PanelBackground = 'none' | 'surface' | 'raised' | 'sunken' | 'scrim' | (string & {});

/** Options for {@link Panel}. */
export interface PanelOptions extends WidgetOptions {
  /** `'surface'` (default), `'raised'`, `'sunken'`, `'scrim'`, `'none'` or a `#rrggbb[aa]` colour. Default `'none'`. */
  background?: PanelBackground;
  /** Draw the theme's outline. Default false. */
  border?: boolean;
  /** Draw a soft drop shadow (the theme's blur; none in high contrast). Default false. */
  shadow?: boolean;
  /** Corner radius in UI units. Default the theme's. */
  radius?: number;
}

/**
 * A container with an optional background. Children stack in a column by default; set `direction: 'row'`, `'stack'`
 * or `'grid'`. A panel with a background takes pointer events, so clicks on it do not reach the game.
 *
 * @example
 * ui.add(new Panel({ background: 'surface', padding: 16, gap: 8, anchor: 'top-left', margin: 16, position: 'absolute',
 *   children: [new Label({ text: 'Inventory', size: 'large' })] }));
 */
export class Panel extends Widget {
  private _background: PanelBackground;
  private _border: boolean;
  private _shadow: boolean;
  private _radius?: number;

  constructor(options: PanelOptions = {}) {
    const { background = 'none', border = false, shadow = false, radius, ...rest } = options;
    super({ direction: 'column', ...rest });
    this._background = background;
    this._border = border;
    this._shadow = shadow;
    this._radius = radius;
    this.pointerEvents = options.pointerEvents ?? (background === 'none' ? 'none' : 'auto');
  }
  get background(): PanelBackground {
    return this._background;
  }
  set background(value: PanelBackground) {
    this._background = value;
    if (this.pointerEvents === 'none' && value !== 'none') this.pointerEvents = 'auto';
    this.invalidate(false);
  }
  get border(): boolean {
    return this._border;
  }
  set border(value: boolean) {
    this._border = value;
    this.invalidate(false);
  }
  get shadow(): boolean {
    return this._shadow;
  }
  set shadow(value: boolean) {
    this._shadow = value;
    this.invalidate(false);
  }

  override draw(context: DrawContext): void {
    const { list, theme, ui } = context,
      r = this.rect,
      radius = this._radius ?? theme.radius;
    if (this._background === 'none' && !this._border) return;
    if (this._shadow && theme.shadowBlur > 0 && this._background !== 'none')
      list.rect(r.x, r.y + 4, r.width, r.height, { fill: ui.color('shadow'), radius, blur: theme.shadowBlur / 2 });
    const key =
      this._background === 'raised'
        ? 'surfaceRaised'
        : this._background === 'sunken'
          ? 'surfaceSunken'
          : this._background;
    list.rect(r.x, r.y, r.width, r.height, {
      fill: this._background === 'none' ? undefined : ui.color(key),
      border: this._border ? ui.color('border') : undefined,
      borderWidth: this._border ? theme.borderWidth : 0,
      radius,
    });
  }
}

/** Text sizes by name: the theme's `small`, `body`, `large`, `title` and `display`; or a number of UI units. */
export type TextSize = 'small' | 'body' | 'large' | 'title' | 'display' | number;

/** Options for {@link Label}. */
export interface LabelOptions extends WidgetOptions {
  /** The text. Newlines break lines. Default ''. */
  text?: string;
  /** Default `'body'`. */
  size?: TextSize;
  /** A colour role such as `'textMuted'` or `'danger'`, or `#rrggbb[aa]`. Default `'text'`. */
  color?: ColorRef;
  /** Alignment of the text inside the label's box. Default `'start'`. */
  align?: 'start' | 'center' | 'end';
  /** Wrap at the box's width. Default true; false keeps one line per newline. */
  wrap?: boolean;
  /** Draw a dark outline round the glyphs so the text reads over any game scene. Default false. */
  outline?: boolean;
  /** Line height as a multiple of the size. Default 1.25. */
  lineHeight?: number;
}

/**
 * Text. It wraps to the width it is given, scales with the user's text scale and is drawn with the text package's
 * signed distance field glyphs, so it stays sharp at any resolution.
 */
export class Label extends Widget {
  private _text: string;
  private _size: TextSize;
  private _color: ColorRef;
  private _align: 'start' | 'center' | 'end';
  private _wrap: boolean;
  private _outline: boolean;
  private _lineHeight: number;

  constructor(options: LabelOptions = {}) {
    const {
      text = '',
      size = 'body',
      color = 'text',
      align = 'start',
      wrap = true,
      outline = false,
      lineHeight = 1.25,
      ...rest
    } = options;
    super(rest);
    if (typeof text !== 'string') throw typeError('Label text is a string', 'ui');
    this._text = text;
    this._size = size;
    this._color = color;
    this._align = align;
    this._wrap = wrap;
    this._outline = outline;
    this._lineHeight = lineHeight;
    this.role = 'text';
  }
  override get text(): string {
    return this._text;
  }
  /** Set the text; the layout updates on the next frame. */
  override set text(value: string) {
    const text = String(value);
    if (text === this._text) return;
    this._text = text;
    this.invalidate();
    this.ui?.touchMirror();
  }
  get size(): TextSize {
    return this._size;
  }
  set size(value: TextSize) {
    this._size = value;
    this.invalidate();
  }
  get color(): ColorRef {
    return this._color;
  }
  set color(value: ColorRef) {
    this._color = value;
    this.invalidate(false);
  }
  get align(): 'start' | 'center' | 'end' {
    return this._align;
  }
  set align(value: 'start' | 'center' | 'end') {
    this._align = value;
    this.invalidate(false);
  }
  get wrap(): boolean {
    return this._wrap;
  }
  set wrap(value: boolean) {
    this._wrap = value;
    this.invalidate();
  }
  get outline(): boolean {
    return this._outline;
  }
  set outline(value: boolean) {
    this._outline = value;
    this.invalidate(false);
  }

  override measure(maxWidth: number): { width: number; height: number } {
    if (!this.ui || !this._text) return { width: 0, height: 0 };
    return this.ui.measureText(this._text, this._size, this._wrap ? maxWidth : Infinity, this._lineHeight);
  }

  override draw({ list, ui }: DrawContext): void {
    if (!this._text) return;
    const r = this.rect,
      layout = ui.textLayout(this._text, this._size, this._wrap ? r.width : Infinity, this._lineHeight, this._align),
      width = layout.bounds.right - layout.bounds.left;
    const x = this._align === 'center' ? (r.width - width) / 2 : this._align === 'end' ? r.width - width : 0;
    const color: Rgba = ui.color(this._color);
    list.text(
      r.x + x - layout.bounds.left,
      r.y,
      layout,
      ui.font,
      color,
      this._outline ? { width: 1.5, color: ui.color('background') } : undefined,
    );
  }
}
