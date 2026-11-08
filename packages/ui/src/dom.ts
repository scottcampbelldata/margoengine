/// <reference lib="esnext.disposable" preserve="true" />
import type { PointerInfo } from './interaction.js';
import type { Ui } from './ui.js';

/** Options for {@link attachInput}. */
export interface AttachOptions {
  /** Detach when the signal aborts. */
  signal?: AbortSignal;
  /** Handle arrow keys, Tab, Enter, Space and Escape on the element. Default true. */
  keyboard?: boolean;
  /** Handle mouse, touch and pen. Default true. */
  pointer?: boolean;
  /** Scroll lists with the wheel. Default true. */
  wheel?: boolean;
}

/** What {@link attachInput} returns: call it to detach, or put it in a `using` declaration. */
export type Detach = (() => void) & { [Symbol.dispose](): void };

const KEYS: Record<string, 'up' | 'down' | 'left' | 'right' | 'accept' | 'cancel'> = {
  ArrowUp: 'up',
  ArrowDown: 'down',
  ArrowLeft: 'left',
  ArrowRight: 'right',
  Enter: 'accept',
  ' ': 'accept',
  Escape: 'cancel',
};

/**
 * Run a key press through the UI: arrows, Tab, Enter, Space and Escape. Returns true when the UI used it, and the caller
 * should then stop the event. Keys with Alt, Ctrl or Meta are never the UI's.
 * @internal
 */
export function handleKeyDown(ui: Ui, e: KeyboardEvent, skip: ReadonlySet<string> = NONE): boolean {
  if (e.altKey || e.ctrlKey || e.metaKey || skip.has(e.key)) return false;
  if (e.key === 'Tab') {
    // Tab walks the widgets; at the end it hands focus back to the page.
    return ui.focusables().length > 0 && ui.tab(!e.shiftKey, 'keyboard');
  }
  const command = KEYS[e.key];
  return !!command && ui.wantsKeys() && ui.execute(command, 'keyboard');
}
const NONE: ReadonlySet<string> = new Set();
const consume = (event: Event) => {
  event.preventDefault();
  event.stopImmediatePropagation();
};

/**
 * Connect an element (normally the engine's canvas) to a {@link Ui}: pointer, touch and wheel go to the widgets under
 * them, and the keyboard moves focus. Listeners run in the capture phase and stop an event the UI used, so a click on a
 * button does not also orbit the camera; a press that lands on no widget reaches the game as before.
 *
 * Keyboard: the arrow keys move focus, Tab and Shift+Tab step through the widgets (and leave the UI at the end, so
 * keyboard users are never trapped; a dialog does trap, as dialogs should), Enter and Space press the focused widget,
 * Escape closes a tooltip or dialog. Keys are taken only while a widget has focus, a dialog is open, or `ui.captureKeys`
 * is true; otherwise they reach the game. The element gets `tabindex="0"` if it has none so it can receive keys.
 *
 * @example
 * const detach = attachInput(ui, engine.canvas);
 * detach();
 */
export function attachInput(ui: Ui, target: HTMLElement, options: AttachOptions = {}): Detach {
  const { signal, keyboard = true, pointer = true, wheel = true } = options;
  const cleanups: (() => void)[] = [];
  const on = listener(target, cleanups);
  attachPointer(ui, target, on, { pointer, wheel });
  if (keyboard) {
    if (!target.hasAttribute('tabindex')) {
      target.setAttribute('tabindex', '0');
      cleanups.push(() => target.removeAttribute('tabindex'));
    }
    on('keydown', (e) => {
      if (handleKeyDown(ui, e)) consume(e);
    });
    on('blur', () => ui.pointerCancel());
  }
  return detacher(cleanups, signal);
}

/** What {@link attachPointer} sends pointer events to: a {@link Ui}, or world panels picked by a ray. @internal */
export interface PointerSink {
  pointerMove(x: number, y: number, info: PointerInfo): boolean;
  pointerDown(x: number, y: number, info: PointerInfo): boolean;
  pointerUp(x: number, y: number, info: PointerInfo): boolean;
  pointerCancel(): void;
  pointerLeave(): void;
  wheel(x: number, y: number, dy: number): boolean;
}
type Listen = <K extends keyof HTMLElementEventMap>(type: K, handler: (event: HTMLElementEventMap[K]) => void) => void;

/**
 * The pointer and wheel listeners of {@link attachInput}, in CSS pixels from the element's top left: an event the sink
 * used is stopped, so it does not also reach the game.
 * @internal
 */
export function attachPointer(
  sink: PointerSink,
  target: HTMLElement,
  on: Listen,
  { pointer = true, wheel = true }: { pointer?: boolean; wheel?: boolean } = {},
): void {
  const local = (event: MouseEvent): [number, number] => {
    const r = target.getBoundingClientRect();
    return [event.clientX - r.left, event.clientY - r.top];
  };
  const info = (e: PointerEvent) => ({
    id: e.pointerId,
    button: e.button,
    type: (e.pointerType || 'mouse') as 'mouse' | 'touch' | 'pen',
  });
  if (pointer) {
    on('pointermove', (e) => {
      const [x, y] = local(e);
      if (sink.pointerMove(x, y, info(e)) && e.buttons) e.stopImmediatePropagation();
    });
    on('pointerdown', (e) => {
      const [x, y] = local(e);
      if (sink.pointerDown(x, y, info(e))) {
        consume(e);
        target.setPointerCapture?.(e.pointerId);
        target.focus?.({ preventScroll: true });
      }
    });
    const up = (e: PointerEvent) => {
      const [x, y] = local(e);
      if (sink.pointerUp(x, y, info(e))) {
        e.stopImmediatePropagation();
        target.releasePointerCapture?.(e.pointerId);
      }
    };
    on('pointerup', up);
    on('pointercancel', () => sink.pointerCancel());
    on('pointerleave', () => sink.pointerLeave());
  }
  if (wheel)
    on('wheel', (e) => {
      const [x, y] = local(e);
      if (sink.wheel(x, y, e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY)) consume(e);
    });
}

/** Adds capture-phase listeners to `target`, each removed by a function pushed onto `cleanups`. @internal */
export function listener(target: HTMLElement, cleanups: (() => void)[]): Listen {
  return (type, handler) => {
    target.addEventListener(type, handler as EventListener, { capture: true, passive: false });
    cleanups.push(() => target.removeEventListener(type, handler as EventListener, { capture: true }));
  };
}

/** A function that runs `cleanups` in reverse once, also disposable, and runs when `signal` aborts. @internal */
export function detacher(cleanups: (() => void)[], signal?: AbortSignal): Detach {
  const detach = (() => {
    for (const cleanup of cleanups.splice(0).reverse()) cleanup();
  }) as Detach;
  detach[Symbol.dispose ?? Symbol.for('Symbol.dispose')] = detach;
  if (signal) {
    if (signal.aborted) detach();
    else signal.addEventListener('abort', detach, { once: true });
  }
  return detach;
}
