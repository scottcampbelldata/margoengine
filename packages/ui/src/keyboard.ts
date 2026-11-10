import { Panel, Button, type WidgetOptions, type Ui } from '@margoengine/ui';
import { TextInput } from '@margoengine/ui/input';
import { graphemes } from '@margoengine/text';
import { rangeError, typeError } from '../../shared/errors.js';

/** A text key or W3C key name (Shift, CapsLock, Backspace, Delete, Enter, Space, arrows, Home, End). */
export interface KeyboardKey {
  /** Text inserted, or a named operation. */
  key: string;
  /** Display caption, default key. */
  label?: string;
  /** Text when shifted, default locale uppercase. */
  shifted?: string;
  /** Relative key width, default 1. */
  width?: number;
}
/** Options for an engine-rendered keyboard. */
export interface VirtualKeyboardOptions extends WidgetOptions {
  /** Target field, default null. Focusing another TextInput in the same Ui reconnects automatically. */
  target?: TextInput | null;
  /** Rows of text or key descriptors. Default familiar QWERTY with numbers, punctuation and editing controls. */
  rows?: readonly (readonly (string | KeyboardKey)[])[];
  /** Minimum width of a normal key in UI pixels, default 44. */
  keyWidth?: number;
}
const DEFAULT_ROWS: readonly (readonly (string | KeyboardKey)[])[] = [
  [...'1234567890'].map((key, i) => ({ key, shifted: ')!@#$%^&*('[i === 9 ? 0 : i + 1] })),
  [...'qwertyuiop', { key: 'Backspace', label: 'Backspace', width: 2 }],
  [...'asdfghjkl', { key: 'Enter', label: 'Enter', width: 2 }],
  [
    { key: 'Shift', width: 1.5 },
    ...'zxcvbnm',
    { key: ',', shifted: '<' },
    { key: '.', shifted: '>' },
    { key: '?', shifted: '?' },
  ],
  ['CapsLock', { key: 'Space', label: 'Space', width: 5 }, 'ArrowLeft', 'ArrowRight', 'Delete'],
];
/** Keyboard built from ordinary Buttons: spatial gamepad navigation and world-panel/XR rays work unchanged. */
export class VirtualKeyboard extends Panel {
  private field: TextInput | null = null;
  private shifted = false;
  private caps = false;
  private offFocus?: () => void;
  private readonly keys: { spec: KeyboardKey; button: Button }[] = [];
  constructor(options: VirtualKeyboardOptions = {}) {
    const { target = null, rows = DEFAULT_ROWS, keyWidth = 44, ...rest } = options;
    super({ direction: 'column', gap: 4, padding: 8, background: 'surface', ...rest });
    if (!(keyWidth > 0) || !Number.isFinite(keyWidth) || !rows.length || rows.some((row) => !row.length))
      throw rangeError('VirtualKeyboard needs positive keyWidth and non-empty rows; supply at least one key', 'ui');
    this.connect(target);
    this.role = 'group';
    this.label = options.label ?? 'On-screen keyboard';
    for (const row of rows) {
      const panel = new Panel({ direction: 'row', gap: 4 });
      for (const source of row) {
        const spec: KeyboardKey = typeof source === 'string' ? { key: source } : { ...source };
        if (
          !spec.key ||
          typeof spec.key !== 'string' ||
          (spec.width !== undefined && (!(spec.width > 0) || !Number.isFinite(spec.width)))
        )
          throw typeError('Keyboard keys need non-empty text and positive width; supply a key string', 'ui');
        const button = new Button({
          text: spec.label ?? spec.key,
          width: keyWidth * (spec.width ?? 1),
          height: 44,
          padding: 4,
          onClick: () => this.press(spec.key),
        });
        this.keys.push({ spec, button });
        panel.add(button);
      }
      this.add(panel);
    }
    this.refreshKeys();
  }
  /** Currently connected field; independent of focus on a keyboard button. */
  get target(): TextInput | null {
    return this.field;
  }
  /** Connect a field, or null to disconnect. Cross-UI targets support a separate XR keyboard panel. */
  connect(field: TextInput | null): void {
    if (field !== null && !(field instanceof TextInput))
      throw typeError('Connect a TextInput or null to the keyboard', 'ui');
    this.field = field;
  }
  protected override attached(ui: Ui | null): void {
    this.offFocus?.();
    this.offFocus = undefined;
    if (ui) {
      const track = () => {
        if (ui.focused instanceof TextInput) this.connect(ui.focused);
      };
      this.offFocus = ui.onFocus(track);
      track();
    }
  }
  /** Process one virtual key; returns false when no editable target or an active IME composition owns it. */
  press(key: string): boolean {
    if (!this.active) return false;
    if (key === 'Shift') {
      this.shifted = !this.shifted;
      this.refreshKeys();
      return true;
    }
    if (key === 'CapsLock') {
      this.caps = !this.caps;
      this.refreshKeys();
      return true;
    }
    const field = this.field;
    if (!field || !field.active || field.readOnly || field.composing) return false;
    let a = field.selectionStart,
      b = field.selectionEnd;
    const boundaries = [0, ...graphemes(field.value).map((g) => g.index + g.cluster.length)];
    const before = (at: number) => boundaries.filter((i) => i < at).at(-1) ?? 0;
    const after = (at: number) => boundaries.find((i) => i > at) ?? field.value.length;
    if (key === 'Backspace' || key === 'Delete') {
      if (a === b) {
        if (key === 'Backspace') a = before(a);
        else b = after(b);
      }
      field.setSelectionRange(a, b);
      field.insertText('');
    } else if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(key)) {
      const at =
        key === 'Home'
          ? 0
          : key === 'End'
            ? field.value.length
            : key === 'ArrowLeft'
              ? a !== b
                ? a
                : before(a)
              : a !== b
                ? b
                : after(b);
      field.setSelectionRange(at);
    } else if (key === 'Enter') {
      if (field.multiline) field.insertText('\n');
      else field.emit('submit', { value: field.value });
    } else {
      const spec = this.keys.find((k) => k.spec.key === key)?.spec;
      const text = key === 'Space' ? ' ' : this.caption(spec ?? { key });
      field.insertText(text);
      if (this.shifted) {
        this.shifted = false;
        this.refreshKeys();
      }
    }
    this.emit('keypress', { value: key });
    return true;
  }
  private caption(spec: KeyboardKey): string {
    const letter = spec.key.toLocaleUpperCase() !== spec.key.toLocaleLowerCase();
    const shifted = letter ? this.shifted !== this.caps : this.shifted;
    return shifted ? (spec.shifted ?? spec.key.toLocaleUpperCase()) : spec.key;
  }
  private refreshKeys(): void {
    for (const { spec, button } of this.keys) {
      button.text = spec.label ?? (spec.key.length === 1 ? this.caption(spec) : spec.key);
      if (spec.key === 'Shift' || spec.key === 'CapsLock')
        button.variant = (spec.key === 'Shift' ? this.shifted : this.caps) ? 'primary' : 'secondary';
    }
  }
}
