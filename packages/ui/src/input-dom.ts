import { edges, type Detach, type Ui, type Widget } from '@margoengine/ui';
import { TextInput } from './input.js';

/** DOM ownership and lifetime for attachTextInputs. */
export interface TextInputMirrorOptions {
  /** Parent for the invisible accessible controls. Default canvas parent. */
  container?: HTMLElement;
  /** Remove controls and listeners when aborted. */
  signal?: AbortSignal;
}

/**
 * Attach once per Ui next to its canvas. Real input/textarea elements own clipboard,
 * undo, selection, mobile keyboards and IME; the canvas paints their value and caret.
 * Controls remain in the accessibility tree, with no duplicate password text nodes.
 */
export function attachTextInputs(ui: Ui, target: HTMLElement, options: TextInputMirrorOptions = {}): Detach {
  const doc = target.ownerDocument,
    root = doc.createElement('div');
  root.dataset.margoUi = 'text-inputs';
  root.style.cssText = 'position:absolute;inset:0;pointer-events:none;overflow:hidden;';
  (options.container ?? target.parentElement ?? doc.body).append(root);
  type Control = HTMLInputElement | HTMLTextAreaElement;
  const entries = new Map<TextInput, { el: Control; clean: (() => void)[] }>();
  const cleanup: (() => void)[] = [];
  let syncing = false,
    detached = false,
    queued = false;
  const listen = (el: EventTarget, type: string, handler: EventListener, capture = false) => {
    el.addEventListener(type, handler, capture);
    return () => el.removeEventListener(type, handler, capture);
  };
  const fromDom = (field: TextInput, el: Control) => {
    if (syncing) return;
    field.edit(el.value, el.selectionStart ?? 0, el.selectionEnd ?? 0, el.selectionDirection ?? 'none');
  };
  const create = (field: TextInput) => {
    const el = doc.createElement(field.multiline ? 'textarea' : 'input') as Control;
    if (el instanceof doc.defaultView!.HTMLInputElement) el.type = field.type;
    el.dataset.margoTextInput = field.id;
    // Tab order belongs to the Ui tree, including ordinary mirrored widgets.
    el.tabIndex = -1;
    el.style.cssText =
      'position:absolute;opacity:0;pointer-events:none;margin:0;border:0;padding:0;resize:none;overflow:hidden;';
    root.append(el);
    const clean = [
      listen(el, 'input', () => fromDom(field, el)),
      listen(el, 'select', () => fromDom(field, el)),
      listen(el, 'keyup', () => fromDom(field, el)),
      listen(el, 'compositionstart', () => {
        field.composing = true;
        field.invalidate(false);
      }),
      listen(el, 'compositionend', () => {
        field.composing = false;
        fromDom(field, el);
        field.invalidate(false);
      }),
      listen(el, 'focus', () => {
        if (!syncing) ui.focus(field, 'keyboard');
      }),
      listen(el, 'blur', (event) => {
        if (field.composing) {
          field.composing = false;
          field.invalidate(false);
        }
        // attachInput focuses the canvas after a pointerdown; retain the widget
        // until its focus listener transfers the native focus back to the editor.
        if (!syncing && (event as FocusEvent).relatedTarget !== target && ui.focused === field) ui.focus(null);
      }),
      listen(el, 'keydown', (event) => {
        const e = event as KeyboardEvent;
        if (e.isComposing || field.composing || e.keyCode === 229) {
          e.stopPropagation();
          return;
        }
        if (e.key === 'Escape') {
          el.blur();
          target.focus({ preventScroll: true });
          e.preventDefault();
        } else if (e.key === 'Enter' && !field.multiline) {
          field.emit('submit', { value: field.value });
          e.preventDefault();
        }
        e.stopPropagation();
      }),
      field.on('editrequest', () => {
        if (!el.disabled) el.focus({ preventScroll: true });
      }),
    ];
    return { el, clean };
  };
  const sync = () => {
    queued = false;
    if (detached || syncing) return;
    syncing = true;
    try {
      ui.layout();
      const live = new Set<TextInput>(),
        available = new Set(ui.focusables());
      const visit = (w: Widget) => {
        if (!(w instanceof TextInput)) return;
        live.add(w);
        let entry = entries.get(w);
        if (!entry) {
          entry = create(w);
          entries.set(w, entry);
        }
        const { el } = entry;
        el.hidden = !w.shown;
        el.disabled = !w.active || !available.has(w);
        el.readOnly = w.readOnly;
        el.placeholder = w.placeholder;
        el.setAttribute('autocomplete', w.autocomplete);
        el.spellcheck = w.spellcheck;
        el.setAttribute('aria-label', w.label || w.placeholder || (w.multiline ? 'Text area' : 'Text input'));
        el.setAttribute('aria-required', String(w.required));
        el.setAttribute('aria-invalid', String(w.invalid));
        if (w.description) el.setAttribute('aria-description', w.description);
        else el.removeAttribute('aria-description');
        if (w.maxLength >= 0) el.maxLength = w.maxLength;
        // Never reassign a native value/selection unnecessarily: doing so destroys undo and IME.
        if (el.value !== w.value) el.value = w.value;
        if (
          !w.composing &&
          (el.selectionStart !== w.selectionStart ||
            el.selectionEnd !== w.selectionEnd ||
            el.selectionDirection !== w.selectionDirection)
        )
          el.setSelectionRange(w.selectionStart, w.selectionEnd, w.selectionDirection);
        const r = w.rect,
          s = ui.cssScale;
        el.style.left = `${target.offsetLeft + r.x * s}px`;
        el.style.top = `${target.offsetTop + r.y * s}px`;
        el.style.width = `${r.width * s}px`;
        el.style.height = `${r.height * s}px`;
        const [top, right, bottom, left] = edges(w.style.padding);
        el.style.boxSizing = 'border-box';
        el.style.padding = `${top * s}px ${right * s}px ${bottom * s}px ${left * s}px`;
        el.style.font = `${ui.font.style} ${ui.font.weight} ${ui.fontSize('body') * s}px ${ui.font.family}`;
        el.style.lineHeight = '1.25';
        el.style.direction = ui.textDirection(w.value);
      };
      ui.root.walk(visit);
      ui.modalLayer.walk(visit);
      for (const [w, entry] of entries)
        if (!live.has(w)) {
          for (const off of entry.clean) off();
          entry.el.remove();
          w.composing = false;
          entries.delete(w);
        }
    } finally {
      syncing = false;
    }
  };
  const schedule = () => {
    if (!queued && !detached) {
      queued = true;
      queueMicrotask(() => {
        sync();
        focus();
      });
    }
  };
  const focus = () => {
    if (syncing || detached) return;
    sync();
    const field = ui.focused,
      entry = field instanceof TextInput ? entries.get(field) : undefined;
    // Keep canvas focus until pointer capture is released. Blurring during a
    // drag would cancel the captured pointer before its pointerup.
    if (field instanceof TextInput && field.pressed) return;
    if (entry && !entry.el.disabled && !entry.el.hidden) {
      syncing = true;
      try {
        entry.el.focus({ preventScroll: true });
      } finally {
        syncing = false;
      }
    } else if (root.contains(doc.activeElement)) {
      // Hand focus back through the canvas, where the ordinary mirror can pick it up.
      syncing = true;
      try {
        target.focus({ preventScroll: true });
      } finally {
        syncing = false;
      }
      ui.focusChanged();
    }
  };
  const focusChanged = () => {
    // onFocus fires before pointerDown sets pressed; observe the completed state.
    if (ui.inputMode === 'pointer' || ui.inputMode === 'touch') schedule();
    else focus();
  };
  cleanup.push(ui.onChange(schedule), ui.onFocus(focusChanged), listen(target, 'focus', focus));
  cleanup.push(
    listen(
      doc,
      'keydown',
      (event) => {
        const e = event as KeyboardEvent,
          el = e.target as HTMLElement | null;
        if (
          e.key !== 'Tab' ||
          e.ctrlKey ||
          e.metaKey ||
          e.altKey ||
          e.isComposing ||
          !el ||
          (ui.focused instanceof TextInput && ui.focused.composing)
        )
          return;
        const ownMirror = el.id === `margo-ui-${ui.focused?.id}` && target.parentElement?.contains(el);
        if (!root.contains(el) && !ownMirror) return;
        const forward = !e.shiftKey;
        if (!ui.tab(forward, 'keyboard')) {
          // Native controls have tabindex=-1. At either edge, leave the whole Ui,
          // rather than reentering a second DOM tree representing the same screen.
          const candidates = Array.from(
            doc.querySelectorAll<HTMLElement>('a[href],button,input,textarea,select,[tabindex]'),
          ).filter((node) => {
            if (
              node === target ||
              node.tabIndex < 0 ||
              node.closest('[data-margo-ui],[hidden],[inert]') ||
              node.matches(':disabled')
            )
              return false;
            for (let ancestor: HTMLElement | null = node; ancestor; ancestor = ancestor.parentElement) {
              const style = doc.defaultView!.getComputedStyle(ancestor);
              if (style.display === 'none' || style.visibility === 'hidden') return false;
            }
            return true;
          });
          const next = forward
            ? candidates.find((node) => (target.compareDocumentPosition(node) & 4) !== 0)
            : candidates.filter((node) => (target.compareDocumentPosition(node) & 2) !== 0).at(-1);
          if (next) next.focus({ preventScroll: true });
          else (doc.activeElement as HTMLElement | null)?.blur();
        }
        e.preventDefault();
        e.stopImmediatePropagation();
      },
      true,
    ),
  );
  cleanup.push(
    listen(doc, 'selectionchange', () => {
      for (const [field, { el }] of entries) if (doc.activeElement === el) fromDom(field, el);
    }),
  );
  sync();
  focus();
  const detach = (() => {
    if (detached) return;
    detached = true;
    options.signal?.removeEventListener('abort', detach);
    for (const off of cleanup) off();
    for (const [field, entry] of entries) {
      for (const off of entry.clean) off();
      field.composing = false;
      field.invalidate(false);
    }
    entries.clear();
    root.remove();
  }) as Detach;
  detach[Symbol.dispose ?? Symbol.for('Symbol.dispose')] = detach;
  if (options.signal?.aborted) detach();
  else options.signal?.addEventListener('abort', detach, { once: true });
  return detach;
}
