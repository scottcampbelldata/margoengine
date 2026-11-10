/// <reference lib="esnext.disposable" preserve="true" />
import { Widget, edges, type DrawContext, type UiCommand, type UiEvent, type WidgetOptions } from '@margoengine/ui';
import { caretRect, graphemes, hitTest, type TextLayout } from '@margoengine/text';
import { rangeError, typeError } from '../../shared/errors.js';
import { attachTextInputs } from './input-dom.js';

export { attachTextInputs };
export type { TextInputMirrorOptions } from './input-dom.js';

/** Options shared by single-line, password and multiline fields. */
export interface TextInputOptions extends WidgetOptions {
  /** Initial text. Default ''. Programmatic changes do not emit change. */
  value?: string;
  /** Hint shown only while empty. Default ''. */
  placeholder?: string;
  /** Default 'text'. Passwords draw one bullet per grapheme. */
  type?: 'text' | 'password';
  /** Default false. Read-only text can still be selected and copied. */
  readOnly?: boolean;
  /** Native UTF-16 user-input limit; default unlimited. */
  maxLength?: number;
  /** Native autofill hint. Default 'off'. */
  autocomplete?: string;
  /** Native spellchecking. Default true, false for passwords. */
  spellcheck?: boolean;
  /** Default false. Mirrored as aria-required. */
  required?: boolean;
  /** Default false. Mirrored as aria-invalid. */
  invalid?: boolean;
  /** Called for user edits (including IME updates). */
  onChange?: (event: UiEvent) => void;
  /** Single-line Enter, outside composition. */
  onSubmit?: (event: UiEvent) => void;
}

/** A canvas text field backed by a native input through attachTextInputs. */
export class TextInput extends Widget {
  readonly multiline: boolean = false;
  readonly type: 'text' | 'password';
  readonly maxLength: number;
  readonly autocomplete: string;
  readonly spellcheck: boolean;
  readonly required: boolean;
  readonly invalid: boolean;
  private _value: string;
  private _placeholder: string;
  private _readOnly: boolean;
  private start = 0;
  private end = 0;
  private direction: 'forward' | 'backward' | 'none' = 'none';
  private anchor = 0;
  private blink = 0;
  private offsetX = 0;
  private offsetY = 0;
  private clicks = 0;
  private clickAge = Infinity;
  /** True between native compositionstart and compositionend. */
  composing = false;

  constructor(options: TextInputOptions = {}) {
    const {
      value = '',
      placeholder = '',
      type = 'text',
      readOnly = false,
      maxLength = -1,
      autocomplete = 'off',
      spellcheck = type !== 'password',
      required = false,
      invalid = false,
      onChange,
      onSubmit,
      ...rest
    } = options;
    super({ width: 240, minHeight: 44, padding: [10, 12], ...rest });
    if (typeof value !== 'string' || typeof placeholder !== 'string' || typeof autocomplete !== 'string')
      throw typeError('TextInput value, placeholder and autocomplete must be strings', 'ui');
    if (type !== 'text' && type !== 'password') throw typeError("TextInput type is 'text' or 'password'", 'ui');
    if (!Number.isInteger(maxLength) || maxLength < -1)
      throw rangeError('maxLength is -1 or a non-negative integer', 'ui');
    this.type = type;
    this.maxLength = maxLength;
    this.autocomplete = autocomplete;
    this.spellcheck = spellcheck;
    this.required = required;
    this.invalid = invalid;
    this._readOnly = readOnly;
    this._placeholder = placeholder;
    this._value = this.normalize(value);
    this.role = 'textbox';
    this.focusable = true;
    this.pointerEvents = 'auto';
    if (onChange) this.on('change', onChange);
    if (onSubmit) this.on('submit', onSubmit);
    this.on('focus', () => {
      this.blink = 0;
      this.invalidate(false);
    });
  }
  protected normalize(value: string): string {
    return value.replace(/[\r\n]/g, '');
  }
  get value(): string {
    return this._value;
  }
  set value(value: string) {
    if (typeof value !== 'string') throw typeError('TextInput value must be a string', 'ui');
    const next = this.normalize(value);
    if (next === this._value) return;
    this._value = next;
    this.start = Math.min(this.start, next.length);
    this.end = Math.min(this.end, next.length);
    this.invalidate();
  }
  get placeholder(): string {
    return this._placeholder;
  }
  set placeholder(value: string) {
    this._placeholder = String(value);
    this.invalidate();
  }
  get readOnly(): boolean {
    return this._readOnly;
  }
  set readOnly(value: boolean) {
    this._readOnly = value;
    this.invalidate(false);
  }
  get selectionStart(): number {
    return this.start;
  }
  get selectionEnd(): number {
    return this.end;
  }
  get selectionDirection(): 'forward' | 'backward' | 'none' {
    return this.direction;
  }
  /** HTML-compatible UTF-16 selection; reversed bounds collapse at end. */
  setSelectionRange(start: number, end = start, direction: 'forward' | 'backward' | 'none' = 'none'): void {
    if (!Number.isFinite(start) || !Number.isFinite(end)) throw rangeError('Selection offsets must be finite', 'ui');
    if (!['forward', 'backward', 'none'].includes(direction)) throw typeError('Invalid selection direction', 'ui');
    const b = Math.max(0, Math.min(this.value.length, Math.trunc(end)));
    const a = Math.min(b, Math.max(0, Math.trunc(start)));
    if (a === this.start && b === this.end && direction === this.direction) return;
    this.start = a;
    this.end = b;
    this.direction = direction;
    this.blink = 0;
    this.invalidate(false);
    this.emit('select');
  }
  select(): void {
    this.setSelectionRange(0, this.value.length);
  }
  /** Replace selection from a virtual keyboard or application. Native edits use the browser's undo stack. */
  insertText(text: string): void {
    if (!this.active || this.readOnly) return;
    if (typeof text !== 'string') throw typeError('insertText needs a string', 'ui');
    const room =
      this.maxLength < 0 ? Infinity : Math.max(0, this.maxLength - this.value.length + this.end - this.start);
    let inserted = '';
    for (const g of graphemes(this.normalize(text))) {
      if (inserted.length + g.cluster.length > room) break;
      inserted += g.cluster;
    }
    const at = this.start + inserted.length;
    const next = this.value.slice(0, this.start) + inserted + this.value.slice(this.end);
    this.edit(next, at, at, 'none');
  }
  /** @internal Mirror an edit already performed by the native control. */
  edit(value: string, start: number, end: number, direction: 'forward' | 'backward' | 'none'): void {
    const changed = this.value !== this.normalize(value);
    this.value = value;
    this.setSelectionRange(start, end, direction);
    this.blink = 0;
    this.invalidate(false);
    if (changed) this.emit('change', { value: this.value });
  }
  override measure(): { width: number; height: number } {
    return { width: 216, height: (this.ui?.fontSize('body') ?? 16) * 1.25 * (this.multiline ? 4 : 1) };
  }
  private display(): { text: string; offsets: number[] } {
    const offsets = [0];
    if (this.type !== 'password') return { text: this.value, offsets };
    for (const g of graphemes(this.value)) offsets.push(offsets.at(-1)! + g.cluster.length);
    return { text: '\u2022'.repeat(offsets.length - 1), offsets };
  }
  private geometry() {
    const ui = this.ui!,
      r = this.rect,
      [t, right, b, left] = edges(this.style.padding);
    const width = Math.max(0, r.width - left - right),
      height = Math.max(0, r.height - t - b);
    const display = this.display();
    const layout = ui.textLayout(display.text, 'body', this.multiline ? width : Infinity);
    const map = (at: number) =>
      this.type === 'password'
        ? Math.max(
            0,
            display.offsets.findIndex((v) => v >= at),
          )
        : at;
    const caret = caretRect(layout, map(this.direction === 'backward' ? this.start : this.end));
    const shift = ui.textDirection(display.text) === 'rtl' ? Math.max(0, width - layout.bounds.right) : 0;
    this.offsetX = Math.max(0, Math.min(this.offsetX, Math.max(0, layout.bounds.right - width + 2)));
    this.offsetY = Math.max(0, Math.min(this.offsetY, Math.max(0, -layout.bounds.bottom - height)));
    if (this.focused) {
      if (caret.x + shift < this.offsetX) this.offsetX = caret.x + shift;
      else if (caret.x + shift + 2 > this.offsetX + width) this.offsetX = caret.x + shift + 2 - width;
      if (-caret.top < this.offsetY) this.offsetY = -caret.top;
      else if (-caret.bottom > this.offsetY + height) this.offsetY = -caret.bottom - height;
    }
    return { x: r.x + left, y: r.y + t, width, height, shift, layout, map, offsets: display.offsets, caret };
  }
  private indexAt(x: number, y: number): number {
    const g = this.geometry(),
      at = hitTest(g.layout, x - g.x - g.shift + this.offsetX, g.y - y - this.offsetY);
    return this.type === 'password' ? (g.offsets[at] ?? this.value.length) : at;
  }
  override pointerDown(x: number, y: number): boolean {
    if (!this.active || !this.ui) return false;
    this.blink = 0;
    const at = this.indexAt(x, y);
    this.clicks = this.clickAge < 0.4 && Math.abs(at - this.anchor) <= 1 ? this.clicks + 1 : 1;
    this.clickAge = 0;
    this.anchor = at;
    this.setSelectionRange(at);
    if (this.clicks === 2) {
      const words = new Intl.Segmenter(undefined, { granularity: 'word' }).segment(this.value);
      for (const word of words)
        if (at >= word.index && at < word.index + word.segment.length) {
          this.setSelectionRange(word.index, word.index + word.segment.length);
          break;
        }
    } else if (this.clicks >= 3) {
      this.select();
      this.clicks = 0;
    }
    return true;
  }
  override pointerMove(x: number, y: number): void {
    if (!this.ui) return;
    const at = this.indexAt(x, y);
    this.setSelectionRange(
      Math.min(at, this.anchor),
      Math.max(at, this.anchor),
      at < this.anchor ? 'backward' : 'forward',
    );
  }
  override command(command: UiCommand): boolean {
    // The DOM receives editing keys. Gamepad A requests editing; B leaves it.
    if (command === 'accept') {
      this.emit('editrequest');
      return true;
    }
    return false;
  }
  override activate(): void {
    this.emit('editrequest');
  }
  override tick(dt: number): boolean {
    const changed = super.tick(dt),
      before = Math.floor(this.blink * 2) % 2;
    this.clickAge += dt;
    this.blink += dt;
    return changed || (this.focused && before !== Math.floor(this.blink * 2) % 2);
  }
  override draw(context: DrawContext): void {
    const { ui, list, theme } = context,
      r = this.rect;
    list.rect(r.x, r.y, r.width, r.height, {
      fill: ui.color(this.active ? 'surfaceRaised' : 'disabled'),
      border: ui.color(this.invalid ? 'danger' : this.focused ? 'focus' : 'border'),
      borderWidth: 1,
      radius: theme.radius,
    });
    const g = this.geometry(),
      x = g.x + g.shift - this.offsetX,
      y = g.y - this.offsetY;
    list.pushClip(g.x, g.y, g.width, g.height);
    const selected =
      this.focused && this.start !== this.end
        ? this.drawSelection(g.layout, g.map(this.start), g.map(this.end), x, y, context)
        : [];
    if (!this.value && this.placeholder)
      list.text(
        g.x,
        g.y,
        ui.textLayout(this.placeholder, 'body', this.multiline ? g.width : Infinity),
        ui.font,
        ui.color('textMuted'),
      );
    else list.text(x, y, g.layout, ui.font, ui.color(this.active ? 'text' : 'onDisabled'));
    for (const span of selected) {
      list.pushClip(span.x, span.y, span.width, span.height);
      // Only this span's glyphs: repainting the entire layout for every line
      // would make a large multiline selection do quadratic work.
      list.text(x, y, { ...g.layout, glyphs: span.glyphs }, ui.font, ui.color('onPrimary'));
      list.popClip();
    }
    if (this.focused && (this.composing || Math.floor(this.blink * 2) % 2 === 0))
      list.rect(x + g.caret.x, y - g.caret.top, 1, g.caret.top - g.caret.bottom, { fill: ui.color('text') });
    list.popClip();
    this.drawFocus(context);
  }
  private drawSelection(
    layout: TextLayout,
    start: number,
    end: number,
    x: number,
    y: number,
    { list, ui }: DrawContext,
  ): Array<{ x: number; y: number; width: number; height: number; glyphs: TextLayout['glyphs'] }> {
    const spans: Array<{ x: number; y: number; width: number; height: number; glyphs: TextLayout['glyphs'] }> = [];
    for (const glyph of layout.glyphs) {
      const a = Math.max(start, glyph.index),
        b = Math.min(end, glyph.index + glyph.length);
      if (a >= b) continue;
      const distance = (at: number) =>
        at <= glyph.index
          ? 0
          : at >= glyph.index + glyph.length
            ? glyph.advance
            : (glyph.carets?.find(([offset]) => glyph.index + offset >= at)?.[1] ?? glyph.advance);
      const da = distance(a),
        db = distance(b),
        line = layout.lines[glyph.line];
      const left = glyph.x + (glyph.rtl ? glyph.advance - db : da);
      list.rect(x + left, y - line.top, db - da, line.top - line.bottom, { fill: ui.color('primary') });
      const previous = spans.at(-1),
        sx = x + left,
        sy = y - line.top;
      if (previous && previous.y === sy && Math.abs(previous.x + previous.width - sx) < 1e-6) {
        previous.width += db - da;
        previous.glyphs.push(glyph);
      } else spans.push({ x: sx, y: sy, width: db - da, height: line.top - line.bottom, glyphs: [glyph] });
    }
    // Newlines have a selectable advance even though they have no glyph.
    for (const line of layout.lines)
      if (start <= line.end && end > line.end && layout.text[line.end] === '\n')
        list.rect(x + (line.rtl ? line.left : line.right), y - line.top, layout.fontSize / 2, layout.lineHeight, {
          fill: ui.color('primary'),
        });
    return spans;
  }
}

/** Multiline field with wrapping, native navigation and an independently scrolling caret. */
export class TextArea extends TextInput {
  override readonly multiline = true;
  constructor(options: Omit<TextInputOptions, 'type'> = {}) {
    super(options);
  }
  protected override normalize(value: string): string {
    return value.replace(/\r\n?/g, '\n');
  }
}
