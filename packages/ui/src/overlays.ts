import { Label, Panel } from './basic.js';
import { Button, type ButtonVariant } from './controls.js';
import type { Widget, DrawContext, UiCommand } from './widget.js';

/** A button of a {@link Dialog}. */
export interface DialogButton {
  /** Caption. */
  label: string;
  /** What the dialog's promise resolves with when this button is chosen. Default the label. */
  value?: unknown;
  /** Default `'primary'` for the first button and `'secondary'` for the others. */
  variant?: ButtonVariant;
}

/** Options for `ui.dialog()`. */
export interface DialogOptions {
  /** Heading. */
  title?: string;
  /** Body text; wraps. */
  message?: string;
  /** Buttons, left to right. Default one `OK` button resolving `true`. */
  buttons?: readonly DialogButton[];
  /** What the promise resolves with on Escape, the gamepad's cancel button or a click on the dimmed area. Default `undefined`. */
  cancelValue?: unknown;
  /** Whether Escape, cancel and clicks outside close the dialog. Default true. */
  dismissible?: boolean;
  /** Width in UI units. Default 440. */
  width?: number;
  /** Closing the signal removes the dialog and rejects the promise with the signal's reason. */
  signal?: AbortSignal;
}

/**
 * A modal dialog: dims the game, traps focus inside, closes on Escape, and returns focus to what had it. Make one with
 * `ui.dialog()`, `ui.confirm()` or `ui.alert()`.
 */
export class Dialog extends Panel {
  /** Settles when the dialog closes. */
  readonly result: Promise<unknown>;
  /** True while it is shown. */
  open = true;
  private resolve!: (value: unknown) => void;
  private reject!: (reason: unknown) => void;
  private readonly cancelValue: unknown;
  readonly dismissible: boolean;
  private removeAbort?: () => void;

  constructor(options: DialogOptions = {}) {
    const {
      title = '',
      message = '',
      buttons = [{ label: 'OK', value: true }],
      cancelValue,
      dismissible = true,
      width = 440,
      signal,
    } = options;
    super({
      background: 'surface',
      border: true,
      shadow: true,
      padding: 24,
      gap: 14,
      width,
      anchor: 'center',
      pointerEvents: 'auto',
    });
    this.role = 'dialog';
    this.label = title || message;
    this.description = title ? message : undefined;
    this.cancelValue = cancelValue;
    this.dismissible = dismissible;
    this.result = new Promise((resolve, reject) => {
      this.resolve = resolve;
      this.reject = reject;
    });
    // A dialog nobody awaits must not report an unhandled rejection when it is aborted.
    this.result.catch(() => {});
    if (title) this.add(new Label({ text: title, size: 'large', id: `${this.id}-title` }));
    if (message) this.add(new Label({ text: message, color: 'textMuted', id: `${this.id}-message` }));
    const row = new Panel({ direction: 'row', gap: 10, justify: 'end', margin: [8, 0, 0, 0] });
    buttons.forEach((spec, i) => {
      const button = new Button({
        text: spec.label,
        variant: spec.variant ?? (i === 0 ? 'primary' : 'secondary'),
        minWidth: 96,
      });
      button.on('click', () => this.close('value' in spec ? spec.value : spec.label));
      row.add(button);
    });
    this.add(row);
    if (signal) {
      if (signal.aborted) queueMicrotask(() => this.abort(signal.reason));
      else {
        const onAbort = () => this.abort(signal.reason);
        signal.addEventListener('abort', onAbort, { once: true });
        this.removeAbort = () => signal.removeEventListener('abort', onAbort);
      }
    }
  }
  /** The first button, which takes focus when the dialog opens. */
  get firstButton(): Widget | undefined {
    return this.children.at(-1)?.children[0];
  }
  /** Close the dialog and resolve the promise with `value`. */
  close(value?: unknown): void {
    if (!this.open) return;
    this.open = false;
    this.removeAbort?.();
    const ui = this.ui;
    this.removeFromParent();
    ui?.dialogClosed(this);
    this.resolve(value);
  }
  /** Close the dialog and reject the promise. */
  abort(reason?: unknown): void {
    if (!this.open) return;
    this.open = false;
    this.removeAbort?.();
    const ui = this.ui;
    this.removeFromParent();
    ui?.dialogClosed(this);
    this.reject(reason ?? new DOMException('The dialog was aborted', 'AbortError'));
  }
  override command(command: UiCommand): boolean {
    if (command === 'cancel' && this.dismissible) {
      this.close(this.cancelValue);
      return true;
    }
    return false;
  }
}

/** How a toast looks and is announced. `'danger'` is announced at once; the others politely. */
export type ToastKind = 'info' | 'success' | 'warning' | 'danger';

/** Options for `ui.toast()`. */
export interface ToastOptions {
  /** Default `'info'`. */
  kind?: ToastKind;
  /** Seconds on screen, paused while the pointer or focus is on it. 0 keeps it until dismissed. Default grows with the message length, at least 4. */
  duration?: number;
  /** A button on the toast, for example `'Undo'`. */
  action?: { label: string; onClick: () => void };
}

const BADGE: Record<ToastKind, string> = { info: 'i', success: '✓', warning: '!', danger: '×' };
const KIND_NAME: Record<ToastKind, string> = { info: 'Info', success: 'Done', warning: 'Warning', danger: 'Error' };

/** A short message that fades after a few seconds. Make one with `ui.toast()`. */
export class Toast extends Panel {
  readonly kind: ToastKind;
  /** Seconds left; Infinity when persistent. */
  remaining: number;
  readonly message: string;
  private fade = 0;
  private closing = false;

  constructor(message: string, options: ToastOptions = {}) {
    const kind = options.kind ?? 'info';
    super({
      direction: 'row',
      background: 'raised',
      border: true,
      shadow: true,
      padding: [8, 14, 8, 8],
      gap: 12,
      align: 'center',
      maxWidth: 520,
      pointerEvents: 'auto',
    });
    this.kind = kind;
    this.message = message;
    this.remaining = options.duration === 0 ? Infinity : (options.duration ?? Math.max(4, 2 + message.length * 0.06));
    this.role = kind === 'danger' ? 'alert' : 'status';
    this.label = `${KIND_NAME[kind]}: ${message}`;
    this.add(
      new Label({
        text: BADGE[kind],
        align: 'center',
        size: 'body',
        width: 28,
        height: 28,
        color: kind === 'warning' ? 'onWarning' : 'onPrimary',
        id: `${this.id}-badge`,
      }),
    );
    this.add(new Label({ text: message, grow: 1, shrink: 1 }));
    if (options.action) {
      const action = options.action;
      const button = new Button({ text: action.label, variant: 'ghost', minHeight: 36 });
      button.on('click', () => {
        action.onClick();
        this.dismiss();
      });
      this.add(button);
    }
  }
  /** Start fading out; it is removed when the fade ends. */
  dismiss(): void {
    this.remaining = 0;
    this.closing = true;
  }
  get dismissed(): boolean {
    return this.closing;
  }
  override tick(dt: number): boolean {
    let moving = super.tick(dt);
    const hold = this.hovered || this.focused || this.children.some((c) => c.focused);
    if (!hold && this.remaining !== Infinity && !this.closing) {
      this.remaining -= dt;
      if (this.remaining <= 0) this.closing = true;
    }
    const target = this.closing ? 0 : 1,
      speed = this.ui && this.ui.motion ? dt * 5 : 1;
    if (this.fade !== target) {
      this.fade = target > this.fade ? Math.min(1, this.fade + speed) : Math.max(0, this.fade - speed);
      moving = true;
    }
    if (this.closing && this.fade <= 0) this.removeFromParent();
    return moving;
  }
  override draw(context: DrawContext): void {
    super.draw(context);
    const { list, ui } = context,
      key =
        this.kind === 'danger'
          ? 'danger'
          : this.kind === 'success'
            ? 'success'
            : this.kind === 'warning'
              ? 'warning'
              : 'info',
      badge = this.children[0].rect;
    list.rect(badge.x, badge.y, badge.width, badge.height, { fill: ui.color(key), radius: 6 });
  }
  override get opacity(): number {
    return this.fade;
  }
}

/** The floating text bubble `ui` shows for a widget's `tooltip`. */
export class Tooltip extends Panel {
  private readonly body: Label;
  constructor() {
    super({
      background: 'raised',
      border: true,
      shadow: true,
      padding: [8, 12],
      maxWidth: 320,
      anchor: 'top-left',
      visible: false,
    });
    this.role = 'tooltip';
    this.body = new Label({ text: '', size: 'small' });
    this.add(this.body);
    this.pointerEvents = 'none';
  }
  override get text(): string {
    return this.body.text;
  }
  override set text(value: string) {
    this.body.text = value;
  }
}
