import type { Binding, Input } from '@margoengine/input';
import { typeError } from '../../shared/errors.js';
import { moveFocus, type Direction } from './focus.js';
import { translate } from './layout.js';
import { Dialog } from './overlays.js';
import type { Ui } from './ui.js';
import type { UiCommand, Widget } from './widget.js';

/** Where the latest input came from. Keyboard and gamepad show the focus ring; pointer and touch hide it. */
export type InputSource = 'pointer' | 'touch' | 'keyboard' | 'gamepad';

/** Details of a pointer event given to {@link Ui.pointerDown} and friends. */
export interface PointerInfo {
  /** Pointer id; a second pointer is ignored while the first is down. Default 0. */
  id?: number;
  /** Button number; only 0 (primary) clicks. Default 0. */
  button?: number;
  /** `'touch'` pointers never hover. Default `'mouse'`. */
  type?: 'mouse' | 'touch' | 'pen';
}

/** The action names {@link uiActions} defines and {@link Ui.bindInput} reads. */
export const UI_ACTIONS = {
  up: 'ui.up',
  down: 'ui.down',
  left: 'ui.left',
  right: 'ui.right',
  accept: 'ui.accept',
  cancel: 'ui.cancel',
  next: 'ui.next',
  previous: 'ui.previous',
} as const satisfies Record<UiCommand, string>;

/** Options for {@link uiActions}. */
export interface UiActionOptions {
  /** Also bind arrow keys, Enter, Space, Escape and Tab. Default false: {@link attachInput} already handles the keyboard. */
  keyboard?: boolean;
  /** Bind the standard gamepad: d-pad and left stick to move, A to accept, B to cancel, bumpers for next and previous. Default true. */
  gamepad?: boolean;
  /** Gamepad index. Default 0. */
  pad?: number;
}

/**
 * Bindings for an `Input` from `@margoengine/input` that drive the UI from a gamepad (and optionally the keyboard):
 * `new Input(uiActions(), { target })`, then `ui.bindInput(input)`. Merge them with your game's own actions:
 * `new Input({ ...uiActions(), jump: [...] })`.
 * @example
 * const input = new Input(uiActions());
 * ui.bindInput(input);
 */
export function uiActions({
  keyboard = false,
  gamepad = true,
  pad = 0,
}: UiActionOptions = {}): Record<string, Binding[]> {
  const button = (index: number): Binding => ({ type: 'gamepad-button', index, gamepad: pad }),
    axis = (index: number, scale: number): Binding => ({ type: 'gamepad-axis', index, gamepad: pad, scale }),
    key = (code: string): Binding => ({ type: 'key', code });
  const pick = (keys: string[], pads: Binding[]): Binding[] => [
    ...(keyboard ? keys.map(key) : []),
    ...(gamepad ? pads : []),
  ];
  const actions: Record<string, Binding[]> = {
    [UI_ACTIONS.up]: pick(['ArrowUp'], [button(12), axis(1, -1)]),
    [UI_ACTIONS.down]: pick(['ArrowDown'], [button(13), axis(1, 1)]),
    [UI_ACTIONS.left]: pick(['ArrowLeft'], [button(14), axis(0, -1)]),
    [UI_ACTIONS.right]: pick(['ArrowRight'], [button(15), axis(0, 1)]),
    [UI_ACTIONS.accept]: pick(['Enter', 'Space'], [button(0)]),
    [UI_ACTIONS.cancel]: pick(['Escape'], [button(1)]),
    [UI_ACTIONS.next]: pick(['Tab'], [button(5)]),
    [UI_ACTIONS.previous]: pick([], [button(4)]),
  };
  // An Input action needs at least one binding.
  for (const name of Object.keys(actions)) if (!actions[name].length) delete actions[name];
  return actions;
}

const REPEAT_DELAY = 0.4,
  REPEAT_RATE = 0.1,
  HOVER_DELAY = 0.5,
  FLASH = 0.12;
const DIRECTIONS: readonly UiCommand[] = ['up', 'down', 'left', 'right'];

/**
 * Focus, pointer, keyboard and gamepad handling for a {@link Ui}. The Ui owns one and forwards to it.
 * @internal
 */
export class Interaction {
  focused: Widget | null = null;
  inputMode: InputSource = 'pointer';
  captureKeys = false;
  wrapFocus = true;
  private hoverChain: Widget[] = [];
  private pressed: Widget | null = null;
  private captured: Widget | null = null;
  private pointer = -1;
  private flash: { widget: Widget; left: number } | null = null;
  private restore: Widget | null = null;
  private binding?: { input: Pick<Input, 'state'>; commands: UiCommand[]; held: Map<UiCommand, number> };
  private tipTarget: Widget | null = null;
  private tipTime = 0;
  private tipDismissed = false;
  private tipShown = false;

  constructor(private readonly ui: Ui) {}

  /** The widgets keyboard navigation moves between: the top dialog's, or the screen's and the toasts'. */
  scope(): Widget[] {
    const dialogs = this.ui.modalLayer.children;
    for (let i = dialogs.length - 1; i >= 0; i--) {
      const dialog = dialogs[i];
      if (dialog instanceof Dialog && dialog.open) return [dialog];
    }
    return [this.ui.root, this.ui.toastLayer];
  }

  focusables(): Widget[] {
    this.ui.layout();
    const out: Widget[] = [];
    const visit = (w: Widget) => {
      if (!w.visible || !w.enabled) return;
      if (w.focusable && w.rect.width > 0 && w.rect.height > 0) out.push(w);
      for (const child of w.children) visit(child);
    };
    for (const root of this.scope()) visit(root);
    return out;
  }

  private contains(ancestor: Widget, widget: Widget | null): boolean {
    for (let w = widget; w; w = w.parent) if (w === ancestor) return true;
    return false;
  }

  setMode(source: InputSource): void {
    if (source === this.inputMode) return;
    this.inputMode = source;
    if (this.focused) this.focused.focusVisible = source === 'keyboard' || source === 'gamepad';
    this.ui.invalidate(false);
  }

  focus(widget: Widget | null, source: InputSource = this.inputMode): boolean {
    if (widget && (!widget.focusable || !widget.shown || !widget.active || widget.ui !== this.ui)) return false;
    const before = this.focused;
    this.inputMode = source;
    if (before === widget) {
      if (widget) widget.focusVisible = source === 'keyboard' || source === 'gamepad';
      return true;
    }
    if (before) {
      before.focused = false;
      before.focusVisible = false;
      before.emit('blur');
    }
    this.focused = widget;
    if (widget) {
      widget.focused = true;
      widget.focusVisible = source === 'keyboard' || source === 'gamepad';
      widget.scrollIntoView();
      widget.emit('focus');
    }
    this.ui.invalidate(false);
    this.ui.focusChanged();
    return true;
  }

  private first(from: 'start' | 'end' = 'start'): Widget | null {
    const list = this.focusables();
    return (from === 'start' ? list[0] : list.at(-1)) ?? null;
  }

  navigate(direction: Direction, source: InputSource = 'keyboard'): boolean {
    this.setMode(source);
    const current = this.focused;
    if (!current || !this.focusables().includes(current)) {
      const target = this.first(direction === 'up' || direction === 'left' ? 'end' : 'start');
      return target ? this.focus(target, source) : false;
    }
    current.focusVisible = true;
    if (current.command(direction)) return true;
    const candidates = this.focusables().filter((w) => w !== current),
      index = moveFocus(
        current.rect,
        candidates.map((w) => w.rect),
        direction,
        this.wrapFocus,
      );
    return index >= 0 && this.focus(candidates[index], source);
  }

  /** Tab order. Returns false when focus leaves the UI (Tab past the last widget with no dialog open). */
  step(delta: 1 | -1, source: InputSource = 'keyboard'): boolean {
    this.setMode(source);
    const list = this.focusables();
    if (!list.length) return false;
    const at = this.focused ? list.indexOf(this.focused) : -1;
    if (at < 0) return this.focus(delta > 0 ? list[0] : list[list.length - 1], source);
    const to = at + delta;
    if (to >= 0 && to < list.length) return this.focus(list[to], source);
    if (this.scope()[0] !== this.ui.root) return this.focus(list[(to + list.length) % list.length], source);
    this.focus(null, source);
    return false;
  }

  accept(source: InputSource = 'keyboard'): boolean {
    this.setMode(source);
    const current = this.focused;
    if (!current || !this.focusables().includes(current)) {
      const target = this.first();
      return target ? this.focus(target, source) : false;
    }
    current.pressed = true;
    this.flash = { widget: current, left: FLASH };
    current.activate();
    this.ui.invalidate(false);
    return true;
  }

  cancel(source: InputSource = 'keyboard'): boolean {
    this.setMode(source);
    if (this.tipShown && !this.tipDismissed) {
      this.tipDismissed = true;
      this.hideTip();
      return true;
    }
    if (this.focused?.command('cancel')) return true;
    const dialog = this.scope()[0];
    return dialog instanceof Dialog ? dialog.command('cancel') : false;
  }

  execute(command: UiCommand, source: InputSource = 'keyboard'): boolean {
    switch (command) {
      case 'up':
      case 'down':
      case 'left':
      case 'right':
        return this.navigate(command, source);
      case 'accept':
        return this.accept(source);
      case 'cancel':
        return this.cancel(source);
      case 'next':
        return this.step(1, source);
      case 'previous':
        return this.step(-1, source);
    }
  }

  /** True when a key press should go to the UI rather than the game. */
  wantsKeys(): boolean {
    return this.captureKeys || this.focused !== null || this.scope()[0] !== this.ui.root;
  }

  // --- Pointer ---------------------------------------------------------------------------------------------------

  hitTest(x: number, y: number): Widget | null {
    const ui = this.ui;
    const toast = ui.toastLayer.hitTest(x, y);
    if (toast) return toast;
    if (ui.modalLayer.children.length) return ui.modalLayer.hitTest(x, y);
    return ui.root.hitTest(x, y);
  }

  private setHover(target: Widget | null): void {
    const chain: Widget[] = [];
    for (let w = target; w; w = w.parent) chain.push(w);
    for (const w of this.hoverChain)
      if (!chain.includes(w)) {
        w.hovered = false;
        w.emit('hover', { value: false });
      }
    for (const w of chain)
      if (!this.hoverChain.includes(w)) {
        w.hovered = true;
        w.emit('hover', { value: true });
      }
    if (chain.length !== this.hoverChain.length || chain.some((w, i) => w !== this.hoverChain[i]))
      this.ui.invalidate(false);
    this.hoverChain = chain;
  }

  private toUnits(x: number, y: number): [number, number] {
    const s = this.ui.cssScale;
    return [x / s, y / s];
  }

  pointerMove(cx: number, cy: number, info: PointerInfo = {}): boolean {
    const [x, y] = this.toUnits(cx, cy),
      touch = info.type === 'touch';
    if (this.captured) {
      if ((info.id ?? 0) === this.pointer) this.captured.pointerMove(x, y);
      return true;
    }
    if (touch) return false;
    this.setMode('pointer');
    const target = this.hitTest(x, y);
    this.setHover(target);
    return target !== null;
  }

  pointerDown(cx: number, cy: number, info: PointerInfo = {}): boolean {
    if (this.captured || this.pressed) return true;
    const [x, y] = this.toUnits(cx, cy),
      touch = info.type === 'touch';
    this.setMode(touch ? 'touch' : 'pointer');
    const target = this.hitTest(x, y);
    if (!touch) this.setHover(target);
    if (!target) {
      this.focus(null, this.inputMode);
      return false;
    }
    if (target === this.ui.modalLayer) {
      const dialog = this.scope()[0];
      if (dialog instanceof Dialog && dialog.dismissible && (info.button ?? 0) === 0) dialog.command('cancel');
      return true;
    }
    if ((info.button ?? 0) !== 0) return true;
    this.pointer = info.id ?? 0;
    let focusTarget: Widget | null = target;
    while (focusTarget && !focusTarget.focusable) focusTarget = focusTarget.parent;
    this.focus(focusTarget && focusTarget.active ? focusTarget : null, this.inputMode);
    if (!target.active) return true;
    target.pressed = true;
    this.pressed = target;
    if (target.pointerDown(x, y)) this.captured = target;
    this.ui.invalidate(false);
    return true;
  }

  pointerUp(cx: number, cy: number, info: PointerInfo = {}): boolean {
    if ((info.id ?? 0) !== this.pointer || (!this.pressed && !this.captured)) return false;
    const [x, y] = this.toUnits(cx, cy),
      captured = this.captured,
      pressed = this.pressed;
    this.captured = this.pressed = null;
    this.pointer = -1;
    if (pressed) pressed.pressed = false;
    if (captured) captured.pointerUp(x, y);
    else if (pressed && pressed.active && this.hitTest(x, y) === pressed) pressed.activate();
    if (info.type === 'touch') this.setHover(null);
    this.ui.invalidate(false);
    return true;
  }

  pointerCancel(): void {
    const captured = this.captured,
      pressed = this.pressed;
    this.captured = this.pressed = null;
    this.pointer = -1;
    if (pressed) pressed.pressed = false;
    captured?.pointerUp(-1e9, -1e9);
    this.setHover(null);
    this.ui.invalidate(false);
  }

  leave(): void {
    if (!this.captured) this.setHover(null);
  }

  wheel(cx: number, cy: number, dy: number): boolean {
    const [x, y] = this.toUnits(cx, cy);
    for (let w = this.hitTest(x, y); w; w = w.parent) if (w.wheel(dy / this.ui.cssScale)) return true;
    return false;
  }

  wantsPointer(cx: number, cy: number): boolean {
    if (this.captured || this.pressed) return true;
    const [x, y] = this.toUnits(cx, cy);
    return this.hitTest(x, y) !== null;
  }

  // --- Lifecycle hooks from the widget tree --------------------------------------------------------------------

  widgetGone(widget: Widget): void {
    if (this.focused && this.contains(widget, this.focused)) this.focus(null);
    if (this.restore && this.contains(widget, this.restore)) this.restore = null;
    if (this.pressed && this.contains(widget, this.pressed)) this.pressed = null;
    if (this.captured && this.contains(widget, this.captured)) {
      this.captured = null;
      this.pointer = -1;
    }
    if (this.hoverChain.some((w) => this.contains(widget, w))) this.setHover(null);
    if (this.tipTarget && this.contains(widget, this.tipTarget)) this.tipTarget = null;
    if (this.flash && this.contains(widget, this.flash.widget)) this.flash = null;
  }

  dialogOpened(dialog: Dialog): void {
    this.restore = this.focused;
    const first = dialog.firstButton;
    if (first) this.focus(first, this.inputMode);
  }

  dialogClosed(): void {
    const target = this.restore;
    this.restore = null;
    if (target && target.shown && target.active && target.ui === this.ui) this.focus(target);
  }

  // --- Gamepad and Input ---------------------------------------------------------------------------------------

  bindInput(input: Pick<Input, 'state'>): void {
    if (!input || typeof input.state !== 'function')
      throw typeError('bindInput takes an Input from @margoengine/input made with uiActions()', 'ui');
    const commands: UiCommand[] = [];
    for (const command of Object.keys(UI_ACTIONS) as UiCommand[]) {
      try {
        input.state(UI_ACTIONS[command]);
        commands.push(command);
      } catch {
        // Only the directions and accept need to exist; the rest are optional.
        if (command === 'up' || command === 'down' || command === 'left' || command === 'right' || command === 'accept')
          throw typeError(
            `bindInput: the Input has no '${UI_ACTIONS[command]}' action; create it with new Input(uiActions())`,
            'ui',
          );
      }
    }
    this.binding = { input, commands, held: new Map() };
  }

  unbindInput(): void {
    this.binding = undefined;
  }

  private poll(dt: number): void {
    const binding = this.binding;
    if (!binding) return;
    // Only the actions the Input had at bindInput: a throw from one of them is a real error, not a missing action.
    for (const command of binding.commands) {
      const value = binding.input.state(UI_ACTIONS[command]).value;
      // An action's value is signed: "ui.down" bound to a stick axis reads negative when the stick is pushed up.
      const active = value > 0.5,
        held = binding.held.get(command);
      if (!active) binding.held.delete(command);
      else if (held === undefined) {
        binding.held.set(command, 0);
        this.execute(command, 'gamepad');
      } else if (DIRECTIONS.includes(command)) {
        const time = held + dt;
        if (time >= REPEAT_DELAY) {
          binding.held.set(command, time - REPEAT_RATE);
          this.execute(command, 'gamepad');
        } else binding.held.set(command, time);
      }
    }
  }

  // --- Time ----------------------------------------------------------------------------------------------------

  tick(dt: number): void {
    this.poll(dt);
    if (this.flash) {
      this.flash.left -= dt;
      if (this.flash.left <= 0) {
        this.flash.widget.pressed = this.flash.widget === this.pressed;
        this.flash = null;
        this.ui.invalidate(false);
      }
    }
    this.tickTip(dt);
  }

  private hideTip(): void {
    this.tipShown = false;
    const tip = this.ui.tooltipWidget;
    if (tip.visible) tip.visible = false;
  }

  private tipSource(): { widget: Widget; delay: number } | null {
    const focused = this.focused;
    if (focused && focused.focusVisible && focused.tooltip) return { widget: focused, delay: 0.15 };
    if (this.captured) return null;
    for (const w of [...this.hoverChain].reverse()) if (w.tooltip) return { widget: w, delay: HOVER_DELAY };
    return null;
  }

  private tickTip(dt: number): void {
    const source = this.tipSource();
    if (source?.widget !== this.tipTarget) {
      this.tipTarget = source?.widget ?? null;
      this.tipTime = 0;
      this.tipDismissed = false;
      this.hideTip();
    }
    if (!source || this.tipDismissed) return;
    this.tipTime += dt;
    const text = source.widget.tooltip!;
    if (this.tipTime >= source.delay) {
      const tip = this.ui.tooltipWidget;
      if (tip.text !== text) tip.text = text;
      if (!tip.visible) tip.visible = true;
      this.tipShown = true;
    }
  }

  cancelTip(): void {
    this.tipDismissed = true;
    this.hideTip();
  }

  /** Put the tooltip next to the widget it describes, inside the safe area, below it or above when there is no room. */
  placeTip(): void {
    const tip = this.ui.tooltipWidget,
      target = this.tipTarget;
    if (!tip.visible || !target) return;
    const [top, right, bottom, left] = this.ui.safeArea,
      W = this.ui.width,
      H = this.ui.height,
      r = tip.rect,
      t = target.rect;
    const x = Math.max(left, Math.min(t.x, W - right - r.width)),
      below = t.y + t.height + 8,
      y = below + r.height <= H - bottom ? below : Math.max(top, t.y - r.height - 8);
    translate(tip, x - r.x, y - r.y);
  }
}
