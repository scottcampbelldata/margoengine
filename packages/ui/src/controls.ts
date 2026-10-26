import { rangeError, typeError } from '../../shared/errors.js';
import { mixColors, withAlpha, type Rgba } from './color.js';
import { Widget, type DrawContext, type UiCommand, type UiEvent, type WidgetOptions } from './widget.js';
import type { TextSize } from './basic.js';

/** Look of a {@link Button}. */
export type ButtonVariant = 'primary' | 'secondary' | 'danger' | 'ghost';

/** Options for {@link Button}. */
export interface ButtonOptions extends WidgetOptions {
  /** The caption. */
  text?: string;
  /** A symbol or emoji drawn before the caption. */
  icon?: string;
  /** Default `'secondary'`. */
  variant?: ButtonVariant;
  /** Default `'body'`. */
  size?: TextSize;
  /** Called on click, tap, Enter, Space and the gamepad's accept button. */
  onClick?: (event: UiEvent) => void;
}

/** What a control paints its text and fill with, by variant and state. */
function palette(
  ui: NonNullable<Widget['ui']>,
  variant: ButtonVariant,
  enabled: boolean,
): { fill: Rgba; text: Rgba; border: Rgba } {
  if (!enabled) return { fill: ui.color('disabled'), text: ui.color('onDisabled'), border: ui.color('disabled') };
  switch (variant) {
    case 'primary':
      return { fill: ui.color('primary'), text: ui.color('onPrimary'), border: ui.color('primary') };
    case 'danger':
      return { fill: ui.color('danger'), text: ui.color('onDanger'), border: ui.color('danger') };
    case 'ghost':
      return { fill: [0, 0, 0, 0], text: ui.color('text'), border: [0, 0, 0, 0] };
    default:
      return { fill: ui.color('surfaceRaised'), text: ui.color('text'), border: ui.color('border') };
  }
}

/**
 * A push button. It reacts to a pointer, a tap, Enter or Space when focused, and a gamepad's accept button. The
 * minimum height is 44 UI units, the usual touch target size.
 *
 * @example
 * const play = new Button({ text: 'Play', variant: 'primary', onClick: () => startGame() });
 */
export class Button extends Widget {
  private _text: string;
  private _icon: string;
  private _variant: ButtonVariant;
  private _size: TextSize;

  constructor(options: ButtonOptions = {}) {
    const { text = '', icon = '', variant = 'secondary', size = 'body', onClick, ...rest } = options;
    super({ padding: [8, 20], minHeight: 44, ...rest });
    if (typeof text !== 'string' || typeof icon !== 'string') throw typeError('Button text and icon are strings', 'ui');
    this._text = text;
    this._icon = icon;
    this._variant = variant;
    this._size = size;
    this.role = 'button';
    this.focusable = true;
    this.pointerEvents = 'auto';
    if (onClick) this.on('click', onClick);
  }
  override get text(): string {
    return this._text;
  }
  override set text(value: string) {
    this._text = String(value);
    this.invalidate();
    this.ui?.touchMirror();
  }
  get icon(): string {
    return this._icon;
  }
  set icon(value: string) {
    this._icon = value;
    this.invalidate();
  }
  get variant(): ButtonVariant {
    return this._variant;
  }
  set variant(value: ButtonVariant) {
    this._variant = value;
    this.invalidate(false);
  }
  private get caption(): string {
    return this._icon ? `${this._icon}  ${this._text}` : this._text;
  }

  override measure(maxWidth: number): { width: number; height: number } {
    if (!this.ui) return { width: 0, height: 0 };
    return this.ui.measureText(this.caption || ' ', this._size, maxWidth, 1.25);
  }

  override activate(): void {
    if (this.active) this.emit('click');
  }

  override draw(context: DrawContext): void {
    const { list, ui, theme } = context,
      r = this.rect,
      colors = palette(ui, this._variant, this.active),
      hover = this.levels.hover,
      press = this.levels.press;
    let fill = colors.fill;
    if (this.active) {
      const strength = 0.14 * hover + 0.1 * press;
      fill =
        this._variant === 'ghost' ? withAlpha(ui.color('text'), strength) : mixColors(fill, ui.color('text'), strength);
    }
    list.rect(r.x, r.y, r.width, r.height, {
      fill,
      border: colors.border,
      borderWidth: this._variant === 'secondary' ? theme.borderWidth : 0,
      radius: theme.radius,
    });
    const layout = ui.textLayout(this.caption, this._size, Infinity, 1.25, 'center'),
      w = layout.bounds.right - layout.bounds.left,
      h = layout.lineHeight * layout.lines.length;
    list.text(r.x + (r.width - w) / 2 - layout.bounds.left, r.y + (r.height - h) / 2, layout, ui.font, colors.text);
    this.drawFocus(context);
  }
}

/** Options for {@link Toggle}. */
export interface ToggleOptions extends WidgetOptions {
  /** Text beside the control. */
  text?: string;
  /** Initial state. Default false. */
  checked?: boolean;
  /** `'switch'` (default) or `'checkbox'`. */
  variant?: 'switch' | 'checkbox';
  /** Called with `value` set to the new state. */
  onChange?: (event: UiEvent) => void;
}

/** A switch or checkbox. The state shows by position (switch) or a filled box (checkbox) as well as by colour. */
export class Toggle extends Widget {
  private _text: string;
  private _checked: boolean;
  private readonly variant: 'switch' | 'checkbox';
  private slide: number;

  constructor(options: ToggleOptions = {}) {
    const { text = '', checked = false, variant = 'switch', onChange, ...rest } = options;
    super({ padding: [6, 0], minHeight: 44, ...rest });
    this._text = String(text);
    this._checked = !!checked;
    this.slide = checked ? 1 : 0;
    this.variant = variant;
    this.role = variant === 'switch' ? 'switch' : 'checkbox';
    this.focusable = true;
    this.pointerEvents = 'auto';
    if (onChange) this.on('change', onChange);
  }
  override get text(): string {
    return this._text;
  }
  override set text(value: string) {
    this._text = String(value);
    this.invalidate();
    this.ui?.touchMirror();
  }
  get checked(): boolean {
    return this._checked;
  }
  /** Set the state without emitting `'change'`. */
  set checked(value: boolean) {
    value = !!value;
    if (value === this._checked) return;
    this._checked = value;
    this.invalidate(false);
    this.ui?.touchMirror();
  }
  /** Flip the state and emit `'change'`. */
  override activate(): void {
    if (!this.active) return;
    this.checked = !this._checked;
    this.emit('change', { value: this._checked });
  }
  private get track(): { width: number; height: number } {
    return this.variant === 'switch' ? { width: 48, height: 28 } : { width: 28, height: 28 };
  }
  override measure(maxWidth: number): { width: number; height: number } {
    if (!this.ui) return { width: 0, height: 0 };
    const t = this.track,
      text = this._text
        ? this.ui.measureText(this._text, 'body', Math.max(0, maxWidth - t.width - 12), 1.25)
        : { width: 0, height: 0 };
    return { width: t.width + (this._text ? 12 + text.width : 0), height: Math.max(t.height, text.height) };
  }
  override tick(dt: number): boolean {
    let moving = super.tick(dt);
    const target = this._checked ? 1 : 0;
    if (this.slide !== target) {
      const step = this.ui && this.ui.motion ? dt / Math.max(0.001, this.ui.theme.transition) : 1;
      this.slide = target > this.slide ? Math.min(1, this.slide + step) : Math.max(0, this.slide - step);
      moving = true;
    }
    return moving;
  }
  override draw(context: DrawContext): void {
    const { list, ui, theme } = context,
      r = this.rect,
      t = this.track,
      active = this.active,
      top = r.y + (r.height - t.height) / 2;
    const on = this._checked,
      border = active ? ui.color('border') : ui.color('disabled'),
      fill = active ? (on ? ui.color('primary') : ui.color('surfaceSunken')) : ui.color('disabled');
    const glow = mixColors(fill, ui.color('text'), 0.16 * this.levels.hover);
    if (this.variant === 'switch') {
      list.rect(r.x, top, t.width, t.height, {
        fill: glow,
        border,
        borderWidth: theme.borderWidth,
        radius: t.height / 2,
      });
      const knob = t.height - 8,
        x = r.x + 4 + (t.width - knob - 8) * this.slide;
      list.rect(x, top + 4, knob, knob, {
        fill: active ? (on ? ui.color('onPrimary') : ui.color('text')) : ui.color('onDisabled'),
        radius: knob / 2,
      });
    } else {
      list.rect(r.x, top, t.width, t.height, {
        fill: ui.color('surfaceSunken'),
        border,
        borderWidth: Math.max(theme.borderWidth, 2),
        radius: Math.min(theme.radius, 6),
      });
      if (on)
        list.rect(r.x + 6, top + 6, t.width - 12, t.height - 12, {
          fill: active ? ui.color('primary') : ui.color('onDisabled'),
          radius: 3,
        });
    }
    if (this._text) {
      const layout = ui.textLayout(this._text, 'body', Math.max(0, r.width - t.width - 12), 1.25, 'start'),
        h = layout.lineHeight * layout.lines.length;
      list.text(
        r.x + t.width + 12 - layout.bounds.left,
        r.y + (r.height - h) / 2,
        layout,
        ui.font,
        active ? ui.color('text') : ui.color('onDisabled'),
      );
    }
    this.drawFocus(context, 2);
  }
}

/** Options for {@link Slider}. */
export interface SliderOptions extends WidgetOptions {
  /** Default 0. */
  min?: number;
  /** Default 1. */
  max?: number;
  /** Snap values to multiples of `step` from `min`. 0 is continuous. Default 0. */
  step?: number;
  /** Initial value. Default `min`. */
  value?: number;
  /** Text to the left of the track. */
  text?: string;
  /** Show the value to the right of the track. Default true. */
  showValue?: boolean;
  /** Turn the value into the text shown. Default two significant decimals. */
  format?: (value: number) => string;
  /** Called with `value` set to the new value, while dragging and on every key step. */
  onChange?: (event: UiEvent) => void;
}

/** A horizontal slider. Drag it, tap on the track, or use the left and right keys or the gamepad's d-pad when focused. */
export class Slider extends Widget {
  readonly min: number;
  readonly max: number;
  readonly step: number;
  private _value: number;
  private _text: string;
  private readonly showValue: boolean;
  private readonly format: (value: number) => string;
  private dragging = false;

  /** @throws RangeError when `min >= max`, `step` is negative, or `value` is not finite. */
  constructor(options: SliderOptions = {}) {
    const { min = 0, max = 1, step = 0, value, text = '', showValue = true, format, onChange, ...rest } = options;
    super({ minHeight: 44, ...rest });
    if (![min, max, step].every(Number.isFinite) || !(min < max))
      throw rangeError('Slider needs finite min < max', 'ui');
    if (step < 0) throw rangeError('Slider step must be 0 or more', 'ui');
    this.min = min;
    this.max = max;
    this.step = step;
    this._text = text;
    this.showValue = showValue;
    this.format = format ?? ((v) => String(Math.round(v * 100) / 100));
    this._value = this.snap(value ?? min);
    this.role = 'slider';
    this.focusable = true;
    this.pointerEvents = 'auto';
    if (onChange) this.on('change', onChange);
  }
  override get text(): string {
    return this._text;
  }
  get value(): number {
    return this._value;
  }
  /** Set the value (clamped and snapped) without emitting `'change'`. */
  set value(next: number) {
    if (!Number.isFinite(next)) throw rangeError('Slider value must be a finite number', 'ui');
    const value = this.snap(next);
    if (value === this._value) return;
    this._value = value;
    this.invalidate(false);
    this.ui?.touchMirror();
  }
  /** The value as text, as drawn and read by screen readers. */
  get valueText(): string {
    return this.format(this._value);
  }
  private snap(value: number): number {
    let v = Math.max(this.min, Math.min(this.max, value));
    if (this.step > 0) v = Math.min(this.max, this.min + Math.round((v - this.min) / this.step) * this.step);
    return Math.round(v * 1e9) / 1e9;
  }
  private change(next: number): void {
    const before = this._value;
    this.value = next;
    if (this._value !== before) this.emit('change', { value: this._value });
  }
  /** Set the value and emit `'change'` if it changed. */
  setValue(next: number): void {
    if (this.active) this.change(next);
  }
  override command(command: UiCommand): boolean {
    if (!this.active || (command !== 'left' && command !== 'right')) return false;
    const step = this.step || (this.max - this.min) / 20;
    this.change(this._value + (command === 'right' ? step : -step));
    return true;
  }
  override measure(): { width: number; height: number } {
    return { width: 220, height: 32 };
  }
  private get trackRect(): { x: number; width: number } {
    const r = this.rect,
      label = this._text ? Math.min(r.width * 0.35, 140) : 0,
      value = this.showValue ? 56 : 0;
    return {
      x: r.x + label + (label ? 12 : 0) + 14,
      width: Math.max(1, r.width - label - (label ? 12 : 0) - value - 28 - (value ? 8 : 0)),
    };
  }
  private fromPointer(x: number): void {
    const t = this.trackRect;
    this.change(this.min + ((x - t.x) / t.width) * (this.max - this.min));
  }
  override pointerDown(x: number): boolean {
    if (!this.active) return false;
    this.dragging = true;
    this.fromPointer(x);
    return true;
  }
  override pointerMove(x: number): void {
    if (this.dragging) this.fromPointer(x);
  }
  override pointerUp(): void {
    this.dragging = false;
  }
  override draw(context: DrawContext): void {
    const { list, ui, theme } = context,
      r = this.rect,
      t = this.trackRect,
      active = this.active,
      cy = r.y + r.height / 2,
      fraction = (this._value - this.min) / (this.max - this.min);
    if (this._text) {
      const layout = ui.textLayout(this._text, 'body', Math.min(r.width * 0.35, 140), 1.25, 'start'),
        h = layout.lineHeight * layout.lines.length;
      list.text(r.x, r.y + (r.height - h) / 2, layout, ui.font, active ? ui.color('text') : ui.color('onDisabled'));
    }
    list.rect(t.x - 14, cy - 5, t.width + 28, 10, {
      fill: ui.color('surfaceSunken'),
      border: ui.color('border'),
      borderWidth: theme.borderWidth,
      radius: 5,
    });
    if (fraction > 0)
      list.rect(t.x - 14, cy - 5, 14 + t.width * fraction, 10, {
        fill: active ? ui.color('primary') : ui.color('onDisabled'),
        radius: 5,
      });
    const kx = t.x + t.width * fraction,
      grow = 1 + 0.12 * this.levels.hover;
    list.rect(kx - 12 * grow, cy - 12 * grow, 24 * grow, 24 * grow, {
      fill: active ? ui.color('text') : ui.color('disabled'),
      border: active ? ui.color('primary') : ui.color('onDisabled'),
      borderWidth: 3,
      radius: 12 * grow,
    });
    if (this.showValue) {
      const layout = ui.textLayout(this.valueText, 'body', Infinity, 1.25, 'end'),
        h = layout.lineHeight * layout.lines.length,
        w = layout.bounds.right - layout.bounds.left;
      list.text(
        r.x + r.width - w - layout.bounds.left,
        r.y + (r.height - h) / 2,
        layout,
        ui.font,
        active ? ui.color('textMuted') : ui.color('onDisabled'),
      );
    }
    this.drawFocus(context, 0);
  }
}
