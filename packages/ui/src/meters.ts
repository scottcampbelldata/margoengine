import { rangeError } from '../../shared/errors.js';
import type { Rgba } from './color.js';
import { Widget, type DrawContext, type WidgetOptions } from './widget.js';

/** Fill colour of a {@link ProgressBar}: a status colour, or `'health'` to move from success to warning to danger as it empties. */
export type MeterVariant = 'primary' | 'accent' | 'success' | 'warning' | 'danger' | 'info' | 'health';

/** Options for {@link ProgressBar}. */
export interface ProgressBarOptions extends WidgetOptions {
  /** Current value in 0..`max`. Default 0. */
  value?: number;
  /** Full value. Default 1. */
  max?: number;
  /** Caption drawn at the left inside the bar, also its accessible name, for example `'HP'`. */
  text?: string;
  /** Default `'primary'`. */
  variant?: MeterVariant;
  /** Show the value inside the bar: `'fraction'` (`72 / 100`), `'percent'` or `'none'`. Default `'percent'`. */
  display?: 'fraction' | 'percent' | 'none';
  /** Animate toward new values. Default true (off with reduced motion). */
  smooth?: boolean;
  /** Show a pale chip that lingers where the bar was before a drop, as in fighting-game health bars. Default false. */
  trail?: boolean;
}

/**
 * A horizontal meter. The number is drawn inside the bar, so the state never depends on its colour alone, and the
 * accessible mirror reads it as a progress bar.
 *
 * @example
 * const loading = new ProgressBar({ text: 'Loading', value: 0.4 });
 * loading.value = 0.75;
 */
export class ProgressBar extends Widget {
  readonly max: number;
  private _value: number;
  private _text: string;
  private _variant: MeterVariant;
  private readonly display: 'fraction' | 'percent' | 'none';
  private readonly smooth: boolean;
  private readonly trail: boolean;
  /** The drawn fraction, easing toward `value / max`. */
  protected shown_ = 0;
  protected chip = 0;
  private chipHold = 0;

  /** @throws RangeError when `max` is not above 0 or `value` is not finite. */
  constructor(options: ProgressBarOptions = {}) {
    const {
      value = 0,
      max = 1,
      text = '',
      variant = 'primary',
      display = 'percent',
      smooth = true,
      trail = false,
      ...rest
    } = options;
    super({ minHeight: 24, ...rest });
    if (!Number.isFinite(max) || !(max > 0)) throw rangeError('ProgressBar max must be a number above 0', 'ui');
    if (!Number.isFinite(value)) throw rangeError('ProgressBar value must be a finite number', 'ui');
    this.max = max;
    this._value = Math.max(0, Math.min(max, value));
    this._text = text;
    this._variant = variant;
    this.display = display;
    this.smooth = smooth;
    this.trail = trail;
    this.shown_ = this.chip = this._value / max;
    this.role = 'progressbar';
  }
  override get text(): string {
    return this._text;
  }
  override set text(value: string) {
    this._text = String(value);
    this.invalidate(false);
    this.ui?.touchMirror();
  }
  get value(): number {
    return this._value;
  }
  /** Set the value, clamped to 0..`max`. @throws RangeError for a value that is not finite. */
  set value(next: number) {
    if (!Number.isFinite(next)) throw rangeError('ProgressBar value must be a finite number', 'ui');
    const value = Math.max(0, Math.min(this.max, next));
    if (value === this._value) return;
    if (value < this._value && this.trail) {
      this.chip = Math.max(this.chip, this._value / this.max);
      this.chipHold = 0.45;
    }
    this._value = value;
    this.invalidate(false);
    this.ui?.touchMirror();
  }
  get variant(): MeterVariant {
    return this._variant;
  }
  set variant(value: MeterVariant) {
    this._variant = value;
    this.invalidate(false);
  }
  /** The value as shown and read aloud, for example `'72%'` or `'72 / 100'`. */
  get valueText(): string {
    return this.display === 'fraction'
      ? `${Math.round(this._value)} / ${Math.round(this.max)}`
      : `${Math.round((this._value / this.max) * 100)}%`;
  }

  override measure(): { width: number; height: number } {
    return { width: 200, height: 24 };
  }

  override tick(dt: number): boolean {
    let moving = super.tick(dt);
    const target = this._value / this.max,
      animated = this.smooth && !!this.ui?.motion;
    if (this.shown_ !== target) {
      const speed = Math.max(Math.abs(target - this.shown_) * 8, 0.5) * dt;
      this.shown_ =
        !animated || Math.abs(target - this.shown_) <= speed
          ? target
          : this.shown_ + Math.sign(target - this.shown_) * speed;
      moving = true;
    }
    if (this.chip < this.shown_) this.chip = this.shown_;
    if (this.chip > this.shown_) {
      if (this.chipHold > 0) this.chipHold = Math.max(0, this.chipHold - dt);
      else {
        const speed = 0.6 * dt;
        this.chip = !animated || this.chip - speed <= this.shown_ ? this.shown_ : this.chip - speed;
      }
      moving = true;
    }
    return moving;
  }

  /** The status colour for a fraction of the bar. */
  protected fillColor(ui: NonNullable<Widget['ui']>, fraction: number): Rgba {
    const v = this._variant;
    if (v === 'health') return ui.color(fraction > 0.5 ? 'success' : fraction > 0.25 ? 'warning' : 'danger');
    return ui.color(v);
  }

  override draw({ list, ui, theme }: DrawContext): void {
    const r = this.rect,
      radius = Math.min(theme.radius, r.height / 2),
      fraction = Math.max(0, Math.min(1, this.shown_)),
      target = this._value / this.max;
    list.rect(r.x, r.y, r.width, r.height, {
      fill: ui.color('surfaceSunken'),
      border: ui.color('border'),
      borderWidth: theme.borderWidth,
      radius,
    });
    const inset = theme.borderWidth;
    const width = r.width - 2 * inset;
    if (this.trail && this.chip > fraction) {
      const chip = ui.color('text');
      list.rect(r.x + inset, r.y + inset, width * Math.min(1, this.chip), r.height - 2 * inset, {
        fill: [chip[0], chip[1], chip[2], 0.55],
        radius: radius - 1,
      });
    }
    if (fraction > 0)
      list.rect(
        r.x + inset,
        r.y + inset,
        Math.max(width * fraction, Math.min(width, 2 * radius)),
        r.height - 2 * inset,
        {
          fill: this.fillColor(ui, target),
          radius: radius - 1,
        },
      );
    const outline = { width: 2, color: ui.color('surfaceSunken') };
    if (r.height >= 20) {
      if (this._text) {
        const layout = ui.textLayout(this._text, 'small', Math.max(0, r.width - 16), 1.2, 'start'),
          h = layout.lineHeight * layout.lines.length;
        list.text(r.x + 10 - layout.bounds.left, r.y + (r.height - h) / 2, layout, ui.font, ui.color('text'), outline);
      }
      if (this.display !== 'none') {
        const layout = ui.textLayout(this.valueText, 'small', Infinity, 1.2, 'end'),
          h = layout.lineHeight * layout.lines.length,
          w = layout.bounds.right - layout.bounds.left;
        list.text(
          r.x + r.width - 10 - w - layout.bounds.left,
          r.y + (r.height - h) / 2,
          layout,
          ui.font,
          ui.color('text'),
          outline,
        );
      }
    }
  }
}

/** Options for {@link HealthBar}. */
export interface HealthBarOptions extends Omit<ProgressBarOptions, 'variant' | 'trail'> {
  /** Starting health. Default `max`. */
  value?: number;
  /** Maximum health. Default 100. */
  max?: number;
}

/** A {@link ProgressBar} preset for hit points: colour by remaining health, a trailing damage chip, and `72 / 100` text. */
export class HealthBar extends ProgressBar {
  constructor(options: HealthBarOptions = {}) {
    const max = options.max ?? 100;
    super({
      text: 'HP',
      display: 'fraction',
      ...options,
      max,
      value: options.value ?? max,
      variant: 'health',
      trail: true,
    });
  }
}
