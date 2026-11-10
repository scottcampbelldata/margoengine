/// <reference lib="esnext.disposable" preserve="true" />
import { Label, Panel } from './basic.js';
import { Inventory, List, type ListItem } from './collections.js';
import { Button, Slider, Toggle } from './controls.js';
import { handleKeyDown, type Detach } from './dom.js';
import { ProgressBar } from './meters.js';
import { Dialog, Toast, Tooltip } from './overlays.js';
import type { Ui } from './ui.js';
import { VirtualList } from './virtual.js';
import type { Widget } from './widget.js';

/** Options for {@link attachMirror}. */
export interface MirrorOptions {
  /** Where to put the mirror. Default: right after the canvas, over it. */
  container?: HTMLElement;
  /** Accessible name of the whole interface. Default `'Game interface'`. */
  label?: string;
  /** Detach when the signal aborts. */
  signal?: AbortSignal;
}

type Attrs = Record<string, string | null>;
interface Spec {
  tag: string;
  attrs: Attrs;
  text?: string;
  /** Children are mirrored inside this element. */
  container: boolean;
  /** `value` property of a range input. */
  value?: string;
}
interface Entry {
  el: HTMLElement;
  widget: Widget;
  tag: string;
  attrs: Map<string, string | null>;
  text: string;
  style: string;
  value: string;
  description?: HTMLElement;
}

const SKIP = Symbol('skip');
const HIDDEN_STYLE =
  'position:absolute;width:1px;height:1px;margin:-1px;padding:0;border:0;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap;';

/**
 * Give screen readers and other assistive technology the UI that is drawn on the canvas: a real DOM tree of buttons,
 * switches, sliders, progress bars, listboxes, dialogs and text, kept in step with the widgets and laid over the canvas
 * (so touch exploration lands on the right widget). It is invisible, takes no pointer events, and follows the widgets:
 *
 * - Focus is shared. Tab or a screen reader moving to an element focuses its widget (the visible ring follows), and
 *   keyboard focus moving in the UI moves DOM focus, so the reader announces it.
 * - Activating an element (Enter, Space, a screen reader's click) activates the widget; a range input sets a slider.
 * - Toasts and {@link Ui.announce} messages go to polite and assertive live regions.
 * - While a dialog is open the rest of the interface is inert; the dialog is `role="dialog"` with `aria-modal`.
 * - A widget's `tooltip` and `description` become `aria-describedby`.
 *
 * {@link UiRenderer} attaches one by default. Returns a function that removes it again; it is also disposable.
 *
 * @example
 * const detach = attachMirror(ui, engine.canvas);
 */
export function attachMirror(ui: Ui, target: HTMLElement, options: MirrorOptions = {}): Detach {
  const doc = target.ownerDocument,
    entries = new Map<Widget, Entry>(),
    byElement = new WeakMap<Element, Widget>(),
    cleanups: (() => void)[] = [];
  const make = (tag: string, style = '', attrs: Attrs = {}) => {
    const el = doc.createElement(tag);
    if (style) el.setAttribute('style', style);
    for (const [k, v] of Object.entries(attrs)) if (v !== null) el.setAttribute(k, v);
    return el;
  };
  const root = make('div', 'position:absolute;overflow:hidden;pointer-events:none;opacity:0;', {
    role: 'region',
    'aria-label': options.label ?? 'Game interface',
    'data-margo-ui': 'mirror',
  });
  const content = make('div', 'position:absolute;inset:0;'),
    modal = make('div', 'position:absolute;inset:0;'),
    descriptions = make('div', 'display:none;'),
    polite = make('div', HIDDEN_STYLE, { 'aria-live': 'polite', 'aria-atomic': 'false', role: 'log' }),
    assertive = make('div', HIDDEN_STYLE, { 'aria-live': 'assertive', 'aria-atomic': 'false', role: 'alert' });
  root.append(content, modal, descriptions, polite, assertive);
  if (options.container) options.container.append(root);
  else target.after(root);
  cleanups.push(() => root.remove());

  // --- Describing widgets ----------------------------------------------------------------------------------------

  const idOf = (w: Widget) => `margo-ui-${w.id}`;
  const describe = (w: Widget): Spec | typeof SKIP | null => {
    if (w instanceof Tooltip) return SKIP;
    if (w instanceof Label) {
      return w.parent instanceof Toast ? SKIP : { tag: 'p', attrs: {}, text: w.text, container: false };
    }
    if (w instanceof Toggle)
      return {
        tag: 'button',
        attrs: { type: 'button', role: w.role, 'aria-checked': String(w.checked), disabled: w.active ? null : '' },
        text: w.label,
        container: false,
      };
    if (w instanceof Button)
      return {
        tag: 'button',
        attrs: { type: 'button', disabled: w.active ? null : '' },
        text: w.label,
        container: false,
      };
    if (w instanceof Slider)
      return {
        tag: 'input',
        attrs: {
          type: 'range',
          min: String(w.min),
          max: String(w.max),
          step: w.step > 0 ? String(w.step) : 'any',
          'aria-label': w.label || 'Slider',
          'aria-valuetext': w.valueText,
          disabled: w.active ? null : '',
        },
        value: String(w.value),
        container: false,
      };
    if (w instanceof ProgressBar)
      return {
        tag: 'div',
        attrs: {
          role: 'progressbar',
          'aria-label': w.label || 'Progress',
          'aria-valuemin': '0',
          'aria-valuemax': String(w.max),
          'aria-valuenow': String(w.value),
          'aria-valuetext': w.valueText,
        },
        container: false,
      };
    if (w instanceof List)
      return { tag: 'div', attrs: { role: 'listbox', 'aria-label': w.label || 'List' }, container: true };
    if (w.role === 'option' && w.parent instanceof List)
      return {
        tag: 'div',
        attrs: {
          role: 'option',
          tabindex: w.active ? '0' : null,
          'aria-selected': String(w.parent.children.indexOf(w) === w.parent.selected),
          'aria-disabled': w.active ? null : 'true',
        },
        text: w.label,
        container: false,
      };
    if (w instanceof VirtualList)
      return { tag: 'div', attrs: { role: 'listbox', 'aria-label': w.label || 'List' }, container: true };
    // A virtual list mirrors only its built rows; each says where it stands in the whole list (WAI-ARIA 1.2 setsize, posinset).
    if (w.role === 'option' && w.parent instanceof VirtualList) {
      const row = w as ListItem;
      return {
        tag: 'div',
        attrs: {
          role: 'option',
          tabindex: w.active ? '0' : null,
          'aria-selected': String(row.selected),
          'aria-disabled': w.active ? null : 'true',
          'aria-setsize': String(w.parent.count),
          'aria-posinset': String(row.index + 1),
        },
        text: w.label,
        container: false,
      };
    }
    if (w instanceof Inventory)
      return { tag: 'div', attrs: { role: 'group', 'aria-label': w.label || 'Inventory' }, container: true };
    if (w.parent instanceof Inventory)
      return {
        tag: 'button',
        attrs: { type: 'button', 'aria-pressed': String(w.parent.carried === w.parent.children.indexOf(w)) },
        text: w.label,
        container: false,
      };
    if (w instanceof Dialog)
      return {
        tag: 'div',
        attrs: {
          role: 'dialog',
          'aria-modal': 'true',
          'aria-label': w.find(`${w.id}-title`) ? null : w.label,
          'aria-labelledby': w.find(`${w.id}-title`) ? `margo-ui-${w.id}-title` : null,
          'aria-describedby': w.find(`${w.id}-message`) ? `margo-ui-${w.id}-message` : null,
        },
        container: true,
      };
    if (w instanceof Toast) return { tag: 'div', attrs: { role: 'group', 'aria-label': w.label }, container: true };
    if (w instanceof Panel && w.label)
      return { tag: 'div', attrs: { role: 'group', 'aria-label': w.label }, container: true };
    return null;
  };

  // --- Syncing the tree ------------------------------------------------------------------------------------------

  const css = (n: number) => `${Math.round(n * ui.cssScale * 10) / 10}px`;
  const live = new Set<Widget>();
  const reconcile = (parent: HTMLElement, wanted: HTMLElement[]) => {
    const set = new Set(wanted);
    for (const child of Array.from(parent.children)) if (!set.has(child as HTMLElement)) child.remove();
    wanted.forEach((el, i) => {
      if (parent.children[i] !== el) parent.insertBefore(el, parent.children[i] ?? null);
    });
  };
  const place = (widgets: readonly Widget[], origin: { x: number; y: number }, out: HTMLElement[]) => {
    for (const w of widgets) {
      if (!w.visible) continue;
      const spec = describe(w);
      if (spec === SKIP) continue;
      if (spec === null) {
        place(w.children, origin, out);
        continue;
      }
      let entry = entries.get(w);
      if (!entry || entry.tag !== spec.tag) {
        entry?.el.remove();
        entry = {
          el: make(spec.tag, '', { id: idOf(w) }),
          widget: w,
          tag: spec.tag,
          attrs: new Map(),
          text: '',
          style: '',
          value: '',
        };
        entries.set(w, entry);
        byElement.set(entry.el, w);
      }
      live.add(w);
      const el = entry.el;
      const attrs: Attrs = { ...spec.attrs };
      const described = w.tooltip || w.description;
      if (described) {
        entry.description ??= make('span', '', { id: `${idOf(w)}-desc` });
        const text = [w.description, w.tooltip].filter(Boolean).join('. ');
        if (entry.description.textContent !== text) entry.description.textContent = text;
        if (entry.description.parentElement !== descriptions) descriptions.append(entry.description);
        attrs['aria-describedby'] = attrs['aria-describedby'] ?? `${idOf(w)}-desc`;
      } else if (entry.description) {
        entry.description.remove();
        entry.description = undefined;
      }
      for (const [k, v] of Object.entries(attrs)) {
        if (entry.attrs.get(k) === v) continue;
        entry.attrs.set(k, v);
        if (v === null) el.removeAttribute(k);
        else el.setAttribute(k, v);
      }
      if (spec.text !== undefined && spec.text !== entry.text) {
        entry.text = spec.text;
        el.textContent = spec.text;
      }
      if (spec.value !== undefined && spec.value !== entry.value) {
        entry.value = spec.value;
        (el as HTMLInputElement).value = spec.value;
      }
      const r = w.rect,
        style = `position:absolute;left:${css(r.x - origin.x)};top:${css(r.y - origin.y)};width:${css(r.width)};height:${css(r.height)};margin:0;padding:0;border:0;outline:none;background:transparent;pointer-events:none;font:inherit;`;
      if (style !== entry.style) {
        entry.style = style;
        el.setAttribute('style', style);
      }
      out.push(el);
      if (spec.container) {
        const children: HTMLElement[] = [];
        place(w.children, r, children);
        reconcile(el, children);
      }
    }
  };
  let scheduled = false,
    frame = 0,
    syncing = false;
  const sync = () => {
    scheduled = false;
    ui.layout();
    live.clear();
    const hasModal = ui.modalLayer.children.length > 0;
    root.style.left = `${target.offsetLeft}px`;
    root.style.top = `${target.offsetTop}px`;
    root.style.width = `${target.clientWidth}px`;
    root.style.height = `${target.clientHeight}px`;
    const screen: HTMLElement[] = [],
      dialogs: HTMLElement[] = [],
      origin = { x: 0, y: 0 };
    place(ui.root.children, origin, screen);
    place(ui.toastLayer.children, origin, screen);
    place(ui.modalLayer.children, origin, dialogs);
    reconcile(content, screen);
    reconcile(modal, dialogs);
    for (const [w, entry] of entries)
      if (!live.has(w)) {
        entry.el.remove();
        entry.description?.remove();
        entries.delete(w);
      }
    // Everything behind a dialog is out of reach of assistive technology and the keyboard.
    if (hasModal) content.setAttribute('inert', '');
    else content.removeAttribute('inert');
    if (hasModal) content.setAttribute('aria-hidden', 'true');
    else content.removeAttribute('aria-hidden');
    focusCurrent();
  };
  const schedule = () => {
    if (scheduled) return;
    scheduled = true;
    const raf = (globalThis as { requestAnimationFrame?: (cb: () => void) => number }).requestAnimationFrame;
    if (raf) frame = raf(sync);
    else queueMicrotask(sync);
  };
  cleanups.push(ui.onChange(schedule));
  sync();

  // --- Focus -----------------------------------------------------------------------------------------------------

  const inside = (node: Node | null) => !!node && root.contains(node);
  const widgetOf = (node: EventTarget | null): Widget | undefined => {
    for (let el = node as Element | null; el && el !== root; el = el.parentElement) {
      const w = byElement.get(el);
      if (w) return w;
    }
    return undefined;
  };
  const listen = <K extends keyof HTMLElementEventMap>(type: K, handler: (event: HTMLElementEventMap[K]) => void) => {
    root.addEventListener(type, handler as EventListener);
    cleanups.push(() => root.removeEventListener(type, handler as EventListener));
  };
  listen('focusin', (e) => {
    if (syncing) return;
    const w = widgetOf(e.target);
    if (w?.focusable) ui.focus(w, 'keyboard');
  });
  listen('focusout', (e) => {
    if (syncing || inside(e.relatedTarget as Node | null)) return;
    const w = widgetOf(e.target);
    if (w && ui.focused === w) ui.focus(null);
  });
  function focusCurrent(): void {
    const w = ui.focused,
      el = w && entries.get(w)?.el,
      active = doc.activeElement;
    if (w && !w.pressed && el && (active === target || root.contains(active)) && active !== el) {
      syncing = true;
      try {
        el.focus({ preventScroll: true });
      } finally {
        syncing = false;
      }
    }
  }
  cleanups.push(
    ui.onFocus(() => {
      if (ui.inputMode === 'pointer' || ui.inputMode === 'touch') schedule();
      else focusCurrent();
    }),
  );

  // --- Activation and keys ---------------------------------------------------------------------------------------

  listen('click', (e) => {
    const w = widgetOf(e.target);
    if (!w || !w.focusable) return;
    ui.focus(w, ui.inputMode === 'pointer' ? 'pointer' : 'keyboard');
    if (!(w instanceof Slider)) w.activate();
  });
  listen('input', (e) => {
    const w = widgetOf(e.target);
    if (w instanceof Slider) w.setValue(Number((e.target as HTMLInputElement).value));
  });
  listen('keydown', (e) => {
    // Native form controls own their activation; div-based options use UI commands. Arrows belong to range inputs.
    const skip = new Set<string>();
    if ((e.target as Element | null)?.closest?.('button,input,textarea,select')) {
      skip.add('Enter');
      skip.add(' ');
    }
    if (!ui.modalLayer.children.length) skip.add('Tab');
    if ((e.target as Element | null)?.getAttribute?.('type') === 'range')
      for (const key of ['ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown']) skip.add(key);
    if (handleKeyDown(ui, e, skip)) {
      e.preventDefault();
      e.stopPropagation();
    }
  });

  // --- Announcements ---------------------------------------------------------------------------------------------

  const timers = new Set<ReturnType<typeof setTimeout>>();
  cleanups.push(() => {
    for (const timer of timers) clearTimeout(timer);
    timers.clear();
  });
  cleanups.push(
    ui.onAnnounce((message, politeness) => {
      const region = politeness === 'assertive' ? assertive : polite,
        line = make('p');
      line.textContent = message;
      region.append(line);
      // Each message is a new node so a repeat is read again; they are tidied up after the reader had time to read.
      const timer = setTimeout(() => {
        timers.delete(timer);
        line.remove();
      }, 8000);
      timers.add(timer);
    }),
  );

  const detach = (() => {
    const caf = (globalThis as { cancelAnimationFrame?: (id: number) => void }).cancelAnimationFrame;
    if (frame && caf) caf(frame);
    for (const cleanup of cleanups.splice(0).reverse()) cleanup();
    entries.clear();
  }) as Detach;
  detach[Symbol.dispose ?? Symbol.for('Symbol.dispose')] = detach;
  const signal = options.signal;
  if (signal) {
    if (signal.aborted) detach();
    else signal.addEventListener('abort', detach, { once: true });
  }
  return detach;
}
