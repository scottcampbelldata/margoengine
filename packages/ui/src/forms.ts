import { hexColor } from '@margoengine/math/color';
import {
  Button,
  Panel,
  List,
  Dialog,
  Slider,
  Toggle,
  Widget,
  parseRgba,
  type ButtonOptions,
  type PanelOptions,
  type ToggleOptions,
  type UiCommand,
  type UiEvent,
  type DrawContext,
  type WidgetOptions,
  type Detach,
  type Ui,
  type Rgba,
} from '@margoengine/ui';
import { TextInput } from '@margoengine/ui/input';
import { rangeError, typeError } from '../../shared/errors.js';
/** One named, uniquely valued choice. */
export interface FormOption {
  label: string;
  value: string;
  disabled?: boolean;
}
/** A change handler receives the chosen string as value and index. */
export interface ChoiceOptions extends WidgetOptions {
  options: readonly FormOption[];
  value?: string;
  onChange?: (event: UiEvent) => void;
}
function optionsCopy(values: readonly FormOption[]): FormOption[] {
  if (
    !Array.isArray(values) ||
    values.some((v) => !v || typeof v.label !== 'string' || typeof v.value !== 'string') ||
    new Set(values.map((v) => v.value)).size !== values.length
  )
    throw typeError('Form options need labels and unique string values', 'ui');
  return values.map((v) => ({ ...v }));
}
/** Select control with a modal listbox, keyboard and gamepad arrows and cancellation. */
export class Select extends Button {
  readonly options: readonly FormOption[];
  private _value: string;
  private popup?: Dialog;
  constructor({ options, value, onChange, ...rest }: ChoiceOptions) {
    super({ ...rest });
    this.options = optionsCopy(options);
    this._value = value ?? this.options.find((v) => !v.disabled)?.value ?? '';
    this.validate(this._value);
    this.refresh();
    if (onChange) this.on('change', onChange);
  }
  private validate(v: string): void {
    if (v !== '' && !this.options.some((o) => o.value === v))
      throw rangeError('Select value must name an option or be empty', 'ui');
  }
  private refresh(): void {
    this.text = `${this.options.find((v) => v.value === this._value)?.label ?? 'Choose'}  \u25be`;
    this.ui?.touchMirror();
  }
  /** Selected option value. Programmatic writes do not emit change. */
  get value(): string {
    return this._value;
  }
  set value(v: string) {
    this.validate(v);
    this._value = v;
    this.refresh();
  }
  /** Whether the choice dialog is open. */
  get expanded(): boolean {
    return !!this.popup?.open;
  }
  /** ID of the choice dialog while expanded, for accessible relationships. */
  get popupId(): string | undefined {
    return this.popup?.id;
  }
  /** Select by value, optionally announcing a user change. */
  select(value: string, emit = false): void {
    const o = this.options.find((v) => v.value === value);
    if (!this.active || !o || o.disabled) return;
    const changed = this.value !== value;
    this.value = value;
    if (changed && emit) this.emit('change', { value, index: this.options.indexOf(o) });
  }
  /** Close the owned popup and release widget listeners. */
  override dispose(): void {
    this.popup?.close();
    this.popup = undefined;
    super.dispose();
  }
  override command(command: UiCommand): boolean {
    if (command !== 'up' && command !== 'down' && command !== 'left' && command !== 'right') return false;
    const options = this.options.filter((o) => !o.disabled);
    if (!options.length) return true;
    const at = options.findIndex((v) => v.value === this.value),
      step = command === 'up' || command === 'left' ? -1 : 1;
    this.select(options[(at + step + options.length) % options.length].value, true);
    return true;
  }
  override activate(): void {
    if (!this.active || !this.ui || this.expanded) return;
    const ui = this.ui,
      dialog = new Dialog({ title: this.label || 'Choose an option', buttons: [], width: Math.min(400, ui.width) }),
      list = new List({
        id: `${this.id}-options`,
        label: this.label || 'Options',
        items: this.options.map((o) => ({ label: o.label, value: o.value, disabled: o.disabled })),
        maxHeight: Math.max(44, ui.height - 100),
        overflow: 'scroll',
      });
    list.select(this.options.findIndex((o) => o.value === this.value));
    list.on('select', (e) => {
      this.select(String(e.item), true);
      dialog.close();
    });
    dialog.add(list);
    this.popup = dialog;
    ui.modalLayer.add(dialog);
    ui.dialogOpened(dialog);
    ui.focus(
      list.children.find((w, i) => w.enabled && this.options[i].value === this.value) ??
        list.children.find((w) => w.enabled) ??
        null,
      'keyboard',
    );
    this.invalidate(false);
    void dialog.result.then(() => {
      if (this.popup !== dialog) return;
      this.popup = undefined;
      this.invalidate(false);
    });
  }
}
/** Checkbox appearance backed by the existing complete toggle input and mirror. */
export class Checkbox extends Toggle {
  constructor(options: Omit<ToggleOptions, 'variant'> = {}) {
    super({ ...options, variant: 'checkbox' });
  }
}
/** Options for a radio group. */
export interface RadioGroupOptions extends ChoiceOptions {
  /** Default vertical. */ orientation?: 'horizontal' | 'vertical';
}
class ChoiceButton extends Button {
  constructor(
    readonly group: RadioGroup | Tabs,
    readonly index: number,
    options: ButtonOptions,
  ) {
    super(options);
  }
  override activate(): void {
    if (this.active) this.group.selectIndex(this.index, true);
  }
  override command(c: UiCommand): boolean {
    return this.group.move(this.index, c);
  }
}
/** Single selection, one tab stop, wrapping arrows, disabled-option exclusion. */
export class RadioGroup extends Panel {
  readonly options: readonly FormOption[];
  readonly orientation: 'horizontal' | 'vertical';
  protected _value: string;
  protected readonly choiceButtons: ChoiceButton[] = [];
  /** The controls in option order. */
  get buttons(): readonly Button[] {
    return this.choiceButtons;
  }
  constructor({ options, value, onChange, orientation = 'vertical', ...rest }: RadioGroupOptions) {
    super({ label: 'Choices', direction: orientation === 'horizontal' ? 'row' : 'column', gap: 8, ...rest });
    this.options = optionsCopy(options);
    this.orientation = orientation;
    this._value = value ?? this.options.find((o) => !o.disabled)?.value ?? '';
    if (this._value !== '' && !this.options.some((o) => o.value === this._value))
      throw rangeError('RadioGroup value must name an option', 'ui');
    this.options.forEach((o, i) => {
      const button = new ChoiceButton(this, i, { id: `${this.id}-choice-${i}`, text: o.label, enabled: !o.disabled });
      this.choiceButtons.push(button);
      this.add(button);
    });
    this.refresh();
    if (onChange) this.on('change', onChange);
  }
  /** Selected value. Programmatic writes do not emit change. */
  get value(): string {
    return this._value;
  }
  set value(v: string) {
    if (v !== '' && !this.options.some((o) => o.value === v))
      throw rangeError('Choice value must name an option', 'ui');
    this._value = v;
    this.refresh();
  }
  protected refresh(): void {
    const selected = this.options.findIndex((o) => o.value === this.value),
      first = this.options.findIndex((o) => !o.disabled),
      focus = selected >= 0 && !this.options[selected].disabled ? selected : first;
    this.choiceButtons.forEach((w, i) => {
      w.focusable = i === focus;
      w.variant = i === selected ? 'primary' : 'secondary';
      if (!(this instanceof Tabs)) w.text = `${i === selected ? '\u25c9' : '\u25cb'} ${this.options[i].label}`;
    });
    this.ui?.touchMirror();
  }
  /** Choose an enabled option by index. */
  selectIndex(i: number, emit = false): void {
    const option = this.options[i];
    if (!this.active || !option || option.disabled) return;
    const changed = this.value !== option.value;
    this.value = option.value;
    if (emit && changed) this.emit('change', { value: this.value, index: i });
  }
  /** @internal Arrow navigation shares the same path for keyboard and gamepad. */
  move(at: number, c: UiCommand): boolean {
    const backwards = c === 'left' || c === 'up',
      forwards = c === 'right' || c === 'down';
    if (!backwards && !forwards) return false;
    for (let n = 1; n <= this.options.length; n++) {
      const next = (at + (backwards ? -n : n) + this.options.length) % this.options.length;
      if (!this.options[next].disabled) {
        this.selectIndex(next, true);
        this.ui?.focus(this.choiceButtons[next], this.ui.inputMode);
        break;
      }
    }
    return true;
  }
}
/** A tab and its associated content panel. */
export interface TabOption extends FormOption {
  panel: Widget;
}
/** Options for Tabs. */
export interface TabsOptions extends Omit<RadioGroupOptions, 'options'> {
  options: readonly TabOption[];
}
/** Tablist with automatic activation, one tab stop and an associated visible panel. */
export class Tabs extends RadioGroup {
  readonly panels: readonly Widget[];
  constructor({ options, ...rest }: TabsOptions) {
    super({ ...rest, options, orientation: rest.orientation ?? 'horizontal' });
    this.setStyle({ direction: 'column' });
    const bar = new Panel({
      id: `${this.id}-tablist`,
      label: this.label,
      direction: this.orientation === 'horizontal' ? 'row' : 'column',
    });
    for (const button of this.choiceButtons) bar.add(button);
    this.add(bar);
    this.panels = options.map(
      (o, i) => new Panel({ id: `${this.id}-panel-${i}`, label: o.label, children: [o.panel] }),
    );
    this.add(...this.panels);
    this.refresh();
  }
  protected override refresh(): void {
    super.refresh();
    if (!this.panels) return;
    this.panels.forEach((p, i) => {
      p.visible = this.options[i].value === this.value;
    });
  }
}
/** A colour picker with HSV, RGB and alpha sliders plus a hex field. */
export interface ColorPickerOptions extends PanelOptions {
  /** Initial #rrggbb or #rrggbbaa. Default #ffffff. */ value?: string;
  onChange?: (event: UiEvent) => void;
}
function hsv(rgb: readonly number[]): [number, number, number] {
  const [r, g, b] = rgb,
    max = Math.max(r, g, b),
    min = Math.min(r, g, b),
    d = max - min;
  return [
    d === 0 ? 0 : (max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4) / 6,
    max === 0 ? 0 : d / max,
    max,
  ];
}
function rgb(h: number, s: number, v: number): [number, number, number] {
  const f = (n: number) => {
    const k = (n + h * 6) % 6;
    return v - v * s * Math.max(0, Math.min(k, 4 - k, 1));
  };
  return [f(5), f(3), f(1)];
}
const hex = (v: readonly number[]) =>
  '#' +
  v
    .map((n) =>
      Math.round(n * 255)
        .toString(16)
        .padStart(2, '0'),
    )
    .join('');
class ColorSquare extends Widget {
  constructor(readonly picker: ColorPicker) {
    super({ width: 'fill', height: 140 });
    this.pointerEvents = 'auto';
  }
  override pointerDown(x: number, y: number): boolean {
    if (!this.active) return false;
    this.pointerMove(x, y);
    return true;
  }
  override pointerMove(x: number, y: number): void {
    const r = this.rect;
    this.picker.setHSV(
      this.picker.hue,
      Math.max(0, Math.min(1, (x - r.x) / r.width)),
      1 - Math.max(0, Math.min(1, (y - r.y) / r.height)),
    );
  }
  override draw({ list }: DrawContext): void {
    const r = this.rect;
    for (let y = 0; y < 64; y++)
      for (let x = 0; x < 64; x++)
        list.rect(r.x + (x * r.width) / 64, r.y + (y * r.height) / 64, r.width / 64 + 0.5, r.height / 64 + 0.5, {
          fill: [...rgb(this.picker.hue, (x + 0.5) / 64, 1 - (y + 0.5) / 64), 1],
        });
    const [, , v] = hsv(parseRgba(this.picker.value)),
      s = this.picker.saturation;
    list.rect(r.x + s * r.width - 4, r.y + (1 - v) * r.height - 4, 8, 8, { border: [0, 0, 0, 1], borderWidth: 2 });
    list.rect(r.x + s * r.width - 2, r.y + (1 - v) * r.height - 2, 4, 4, { border: [1, 1, 1, 1], borderWidth: 1 });
  }
}
/** Pointer saturation/value square and precise keyboard, gamepad and accessible channel controls. */
export class ColorPicker extends Panel {
  private rgba: Rgba = [1, 1, 1, 1];
  private hueValue = 0;
  // Kept apart from the colour: black has no saturation, so Value 0 must not lose it (as grey must not lose hue).
  private saturationValue = 0;
  private readonly channels: Slider[] = [];
  readonly hexInput: TextInput;
  constructor({ value = '#ffffff', onChange, ...rest }: ColorPickerOptions = {}) {
    super({ label: 'Colour', width: 280, gap: 6, ...rest });
    this.rgba = parseRgba(value);
    [this.hueValue, this.saturationValue] = hsv(this.rgba);
    this.add(new ColorSquare(this));
    for (const name of ['Hue', 'Saturation', 'Value', 'Red', 'Green', 'Blue', 'Alpha']) {
      const i = this.channels.length,
        slider = new Slider({
          text: name,
          min: 0,
          max: 1,
          step: 1 / 255,
          onChange: (e) => {
            const n = Number(e.value),
              current: [number, number, number] = [this.hue, this.saturation, hsv(this.rgba)[2]];
            if (i < 3) {
              current[i] = n;
              this.setHSV(...current);
            } else {
              const next = [...this.rgba] as [number, number, number, number];
              next[i - 3] = n;
              this.change(next);
            }
          },
        });
      this.channels.push(slider);
      this.add(slider);
    }
    this.hexInput = new TextInput({
      label: 'Hex colour',
      maxLength: 9,
      onChange: () => {
        const s = this.hexInput.value;
        const color = s.length === 7 || s.length === 9 ? hexColor(s) : undefined;
        if (color) this.change(color, false);
      },
    });
    this.add(this.hexInput);
    this.refresh();
    if (onChange) this.on('change', onChange);
  }
  /** Normalized #rrggbbaa value, including alpha. */
  get value(): string {
    return hex(this.rgba);
  }
  set value(v: string) {
    this.rgba = parseRgba(v);
    this.keep();
    this.refresh();
  }
  /** Current hue in [0,1]. */
  get hue(): number {
    return this.hueValue;
  }
  /** Current saturation in [0,1], kept while Value is 0. */
  get saturation(): number {
    return this.saturationValue;
  }
  /** Set HSV from a pointer or application, emitting a change. */
  setHSV(h: number, s: number, v: number): void {
    if (![h, s, v].every((n) => Number.isFinite(n) && n >= 0 && n <= 1))
      throw rangeError('HSV channels must be in [0,1]', 'ui');
    if (!this.active) return;
    this.hueValue = h;
    this.saturationValue = s;
    this.change([...rgb(h, s, v), this.rgba[3]]);
  }
  private change(v: Rgba, syncHex = true): void {
    if (!this.active) return;
    const before = this.value;
    this.rgba = v;
    this.keep();
    this.refresh(syncHex);
    if (this.value !== before) this.emit('change', { value: this.value });
  }
  private keep(): void {
    const [h, s, v] = hsv(this.rgba);
    if (s > 0) this.hueValue = h;
    if (v > 0) this.saturationValue = s;
  }
  private refresh(syncHex = true): void {
    const values = [this.hue, this.saturation, hsv(this.rgba)[2], ...this.rgba];
    this.channels.forEach((s, i) => {
      s.value = values[i];
    });
    if (syncHex && this.hexInput) this.hexInput.value = this.value;
    this.invalidate(false);
  }
}

/** Add radio, tab and select ARIA states to the ordinary UiRenderer mirror. Attach after UiRenderer. */
export function attachFormsMirror(ui: Ui, target: HTMLElement, options: { signal?: AbortSignal } = {}): Detach {
  let detached = false,
    queued = false,
    frame = 0,
    hadPopup = false;
  const sync = () => {
    queued = false;
    frame = 0;
    if (detached) return;
    let popup = false;
    const visit = (w: Widget) => {
      const el = target.ownerDocument.getElementById(`margo-ui-${w.id}`);
      if (!el) return;
      if (w instanceof Select) {
        popup ||= w.expanded;
        el.setAttribute('role', 'combobox');
        el.setAttribute('aria-haspopup', 'dialog');
        el.setAttribute('aria-expanded', String(w.expanded));
        el.setAttribute('aria-label', w.label || 'Select');
        el.textContent = w.options.find((option) => option.value === w.value)?.label ?? 'Choose';
        if (w.popupId) el.setAttribute('aria-controls', `margo-ui-${w.popupId}`);
        else el.removeAttribute('aria-controls');
      }
      if (w instanceof RadioGroup) {
        el.setAttribute('role', w instanceof Tabs ? 'group' : 'radiogroup');
        const bar = w instanceof Tabs ? target.ownerDocument.getElementById(`margo-ui-${w.id}-tablist`) : el;
        if (bar) {
          bar.setAttribute('role', w instanceof Tabs ? 'tablist' : 'radiogroup');
          bar.setAttribute('aria-orientation', w.orientation);
        }
        w.buttons.forEach((child, i) => {
          const node = target.ownerDocument.getElementById(`margo-ui-${child.id}`);
          if (!node) return;
          const selected = w.value === w.options[i].value;
          node.setAttribute('role', w instanceof Tabs ? 'tab' : 'radio');
          node.setAttribute('aria-label', w.options[i].label);
          node.setAttribute(w instanceof Tabs ? 'aria-selected' : 'aria-checked', String(selected));
          node.tabIndex = child.focusable ? 0 : -1;
          if (w instanceof Tabs) {
            const panel = w.panels[i];
            node.setAttribute('aria-controls', `margo-ui-${panel.id}`);
            const p = target.ownerDocument.getElementById(`margo-ui-${panel.id}`);
            if (p) {
              p.setAttribute('role', 'tabpanel');
              p.setAttribute('aria-labelledby', node.id);
            }
          }
        });
      }
    };
    ui.root.walk(visit);
    ui.modalLayer.walk(visit);
    // The ordinary mirror creates modal nodes on its frame callback. Transfer
    // focus only after that reconciliation, including focus restoration when
    // its background content stops being inert.
    if ((popup || hadPopup) && ui.focused) {
      const el = target.ownerDocument.getElementById(`margo-ui-${ui.focused.id}`);
      if (el && el !== target.ownerDocument.activeElement) el.focus({ preventScroll: true });
    }
    hadPopup = popup;
  };
  const schedule = () => {
    if (queued || detached) return;
    queued = true;
    const raf = (globalThis as { requestAnimationFrame?: (callback: () => void) => number }).requestAnimationFrame;
    if (raf) frame = raf(sync);
    else queueMicrotask(sync);
  };
  const off = ui.onChange(schedule),
    focus = ui.onFocus(schedule);
  const detach = (() => {
    if (detached) return;
    detached = true;
    if (frame && globalThis.cancelAnimationFrame) globalThis.cancelAnimationFrame(frame);
    off();
    focus();
    options.signal?.removeEventListener('abort', detach);
  }) as Detach;
  detach[Symbol.dispose ?? Symbol.for('Symbol.dispose')] = detach;
  if (options.signal?.aborted) detach();
  else options.signal?.addEventListener('abort', detach, { once: true });
  schedule();
  return detach;
}
