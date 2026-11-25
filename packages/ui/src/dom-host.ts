/// <reference lib="esnext.disposable" preserve="true" />
import { rangeError, typeError } from '../../shared/errors.js';
import {
  Button,
  Dialog,
  Inventory,
  Label,
  Panel,
  ProgressBar,
  Slider,
  Toast,
  Toggle,
  Ui,
  Widget,
  describeWidget,
  edges,
  handleKeyDown,
  WIDGET_SKIP as SKIP,
  type Anchor,
  type LayoutStyle,
  type Size,
  type Theme,
} from '@margoengine/ui';

type Attrs = Record<string, string | null>;

/** Options for {@link mountDom}. */
export interface DomHostOptions {
  /** The look. Default the UI's own theme, followed when it changes. */
  theme?: Theme;
  /** Accessible name of the mounted region. Default none (the page names it). */
  label?: string;
  /** Smallest pointer target of a control in CSS pixels, 24 or more (WCAG 2.2 SC 2.5.8). Default 44. */
  targetSize?: number;
  /** Advance toasts and transitions with `ui.update` on animation frames. Pass false when a UiRenderer drives the same UI. Default true. */
  update?: boolean;
  /** Send `ui.announce` messages and toasts to live regions in the host. Pass false when a mirror already does. Default true. */
  announce?: boolean;
  /** Nonce of the fallback `<style>` element, for a page whose CSP has no constructable stylesheets. */
  nonce?: string;
  /** Start of every element id. Default `'margo-dom-'`. */
  idPrefix?: string;
  /** Unmount when the signal aborts. */
  signal?: AbortSignal;
}

/** Returned by {@link mountDom}. Dispose it (or use `using`) to remove every element and listener. */
export interface DomHost {
  /** The element the widgets are mounted in (the container). */
  readonly element: HTMLElement;
  /** The element that shows `widget`, or undefined while it has none. */
  elementOf(widget: Widget): HTMLElement | undefined;
  /** The widget an element (or any node inside it) shows. */
  widgetOf(node: Node | null): Widget | undefined;
  /** Apply every pending widget change now instead of on the next microtask. */
  flush(): void;
  dispose(): void;
  [Symbol.dispose](): void;
}

type Kind = 'toggle' | 'slider' | 'progress' | 'text' | 'select' | 'radio' | 'dialog' | 'label' | 'box' | 'spec';
interface Entry {
  widget: Widget;
  kind: Kind;
  tag: string;
  el: HTMLElement;
  /** The element that takes focus and holds the value. */
  control: HTMLElement;
  /** Where the children go, or null for a leaf. */
  box: HTMLElement | null;
  /** Visible text of a toggle, slider or radio group. */
  caption?: HTMLElement;
  attrs: Map<string, string | null>;
  text: string;
  css: string;
  options: string;
  description?: HTMLElement;
}
type Choice = Widget & {
  readonly options: readonly { value: string; label: string; disabled?: boolean }[];
  readonly value: string;
};
type SelectLike = Choice & { select(value: string, emit?: boolean): void };
type RadioLike = Choice & {
  readonly orientation: string;
  readonly buttons: readonly Widget[];
  selectIndex(i: number, emit?: boolean): void;
};
type TabsLike = RadioLike & { readonly panels: readonly Widget[] };
type TextLike = Widget & {
  readonly multiline: boolean;
  readonly type: string;
  readonly maxLength: number;
  readonly autocomplete: string;
  readonly spellcheck: boolean;
  readonly required: boolean;
  readonly invalid: boolean;
  readonly value: string;
  readonly placeholder: string;
  readonly readOnly: boolean;
  readonly selectionStart: number;
  readonly selectionEnd: number;
  readonly selectionDirection: 'forward' | 'backward' | 'none';
  composing: boolean;
  edit(value: string, start: number, end: number, direction: 'forward' | 'backward' | 'none'): void;
};

// The forms and text input entries are optional: they are recognised by shape so this entry does not import them.
const isText = (w: Widget): w is TextLike => w.role === 'textbox' && 'multiline' in w && 'edit' in w;
const isSelect = (w: Widget): w is SelectLike => w instanceof Button && 'expanded' in w && 'options' in w;
const isTabs = (w: Widget): w is TabsLike => 'panels' in w && 'buttons' in w;
const isRadio = (w: Widget): w is RadioLike => 'buttons' in w && 'selectIndex' in w && !isTabs(w);
const tabsOf = (w: Widget | null): TabsLike | undefined => (w && isTabs(w) ? w : undefined);

const kebab = (name: string) => name.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
const px = (n: number) => `${Math.round(n * 100) / 100}px`;
const box4 = (e: Parameters<typeof edges>[0]) => edges(e).map(px).join(' ');
const FLEX = { start: 'flex-start', center: 'center', end: 'flex-end', stretch: 'stretch' } as const;
const SPREAD: Record<string, string> = { start: 'flex-start', end: 'flex-end' };
const ANCHOR: Record<Anchor, [string, string]> = {
  stretch: ['stretch', 'stretch'],
  'top-left': ['start', 'start'],
  top: ['center', 'start'],
  'top-right': ['end', 'start'],
  left: ['start', 'center'],
  center: ['center', 'center'],
  right: ['end', 'center'],
  'bottom-left': ['start', 'end'],
  bottom: ['center', 'end'],
  'bottom-right': ['end', 'end'],
};
const SURFACE: Record<string, string> = {
  surface: 'var(--mg-surface)',
  raised: 'var(--mg-surface-raised)',
  sunken: 'var(--mg-surface-sunken)',
  scrim: 'var(--mg-scrim)',
};

/** One generated stylesheet per document, shared by its hosts. Rules are scoped to the hosts and use the theme's variables. */
const S = '[data-margo-ui="dom"]';
const RULES = `
:where(${S}){position:relative;color:var(--mg-text);font:500 var(--mg-body)/1.25 system-ui,sans-serif}
:where(${S}) *,:where(${S}) ::before,:where(${S}) ::after{box-sizing:border-box}
:where(${S}) [hidden]{display:none!important}
:where(${S}) .mg-box{position:relative;display:flex;flex-direction:column;min-width:0}
:where(${S}) .mg-label{margin:0;white-space:pre-wrap;overflow-wrap:anywhere}
:where(${S}) .mg-label[data-size=small]{font-size:var(--mg-small)}
:where(${S}) .mg-label[data-size=large]{font-size:var(--mg-large)}
:where(${S}) .mg-label[data-size=title]{font-size:var(--mg-title);font-weight:700}
:where(${S}) .mg-label[data-size=display]{font-size:var(--mg-display);font-weight:800}
:where(${S}) .mg-label[data-nowrap]{white-space:pre}
:where(${S}) .mg-label[data-outline]{text-shadow:0 0 2px #000,0 0 2px #000}
:where(${S}) [data-border]{border:var(--mg-border-width) solid var(--mg-border)}
:where(${S}) [data-shadow]{box-shadow:0 2px var(--mg-shadow-blur) var(--mg-shadow)}
:where(${S}) [data-border],:where(${S}) [data-bg]{border-radius:var(--mg-radius)}
:where(${S}) button,:where(${S}) select,:where(${S}) input,:where(${S}) textarea,:where(${S}) [role=option]{font:inherit;color:var(--mg-text);min-height:var(--mg-target);min-width:var(--mg-target);margin:0}
:where(${S}) button,:where(${S}) select,:where(${S}) input:not([type=checkbox],[type=radio],[type=range]),:where(${S}) textarea{background:var(--mg-surface-raised);border:var(--mg-border-width) solid var(--mg-border);border-radius:var(--mg-radius);padding:0 calc(var(--mg-spacing) * 1.5)}
:where(${S}) textarea{padding:calc(var(--mg-spacing)) calc(var(--mg-spacing) * 1.5);resize:vertical}
:where(${S}) input:not([type=checkbox],[type=radio],[type=range]),:where(${S}) textarea{background:var(--mg-surface-sunken)}
:where(${S}) button{cursor:pointer;transition:background-color var(--mg-transition),color var(--mg-transition)}
:where(${S}) button[data-variant=primary]{background:var(--mg-primary);color:var(--mg-on-primary);border-color:transparent}
:where(${S}) button[data-variant=danger]{background:var(--mg-danger);color:var(--mg-on-danger);border-color:transparent}
:where(${S}) button[data-variant=ghost]{background:transparent;border-color:transparent}
:where(${S}) :disabled,:where(${S}) [aria-disabled=true]{background:var(--mg-disabled);color:var(--mg-on-disabled);cursor:default}
:where(${S}) :focus-visible{outline:var(--mg-focus-width) solid var(--mg-focus);outline-offset:2px}
:where(${S}) [role=listbox]{list-style:none;margin:0}
:where(${S}) [role=option]{display:flex;align-items:center;padding:0 calc(var(--mg-spacing) * 1.75);border-radius:var(--mg-radius);cursor:pointer}
:where(${S}) [role=option][aria-selected=true],:where(${S}) [aria-pressed=true]{background:var(--mg-primary);color:var(--mg-on-primary)}
:where(${S}) [role=tab]{border-radius:var(--mg-radius) var(--mg-radius) 0 0}
:where(${S}) [role=tab][aria-selected=true]{box-shadow:inset 0 -3px var(--mg-primary)}
:where(${S}) .mg-toggle,:where(${S}) .mg-slider,:where(${S}) .mg-choice{display:flex;align-items:center;gap:calc(var(--mg-spacing) * 1.5);min-height:var(--mg-target);cursor:pointer}
:where(${S}) .mg-slider{cursor:default}
:where(${S}) .mg-slider>input{flex:1 1 auto}
:where(${S}) input[type=checkbox],:where(${S}) input[type=radio]{width:24px;height:24px;min-width:24px;min-height:24px;accent-color:var(--mg-primary)}
:where(${S}) input[type=range],:where(${S}) progress{accent-color:var(--mg-primary)}
:where(${S}) progress{width:100%;height:calc(var(--mg-spacing) * 2.5)}
:where(${S}) progress[data-variant=health],:where(${S}) progress[data-variant=success]{accent-color:var(--mg-success)}
:where(${S}) progress[data-variant=danger]{accent-color:var(--mg-danger)}
:where(${S}) progress[data-variant=warning]{accent-color:var(--mg-warning)}
:where(${S}) progress[data-variant=accent]{accent-color:var(--mg-accent)}
:where(${S}) progress[data-variant=info]{accent-color:var(--mg-info)}
:where(${S}) fieldset{border:0;margin:0;padding:0;display:flex;flex-direction:column;gap:var(--mg-spacing)}
:where(${S}) fieldset[data-orientation=horizontal]{flex-direction:row;flex-wrap:wrap}
:where(${S}) legend{padding:0;margin-bottom:var(--mg-spacing)}
:where(${S}) dialog{background:var(--mg-surface);color:var(--mg-text);border:var(--mg-border-width) solid var(--mg-border);border-radius:var(--mg-radius);box-shadow:0 4px var(--mg-shadow-blur) var(--mg-shadow);max-width:calc(100vw - 32px)}
:where(${S}) dialog::backdrop{background:var(--mg-scrim)}
:where(${S}) .mg-toasts{position:absolute;inset:0;pointer-events:none}
:where(${S}) .mg-toasts *{pointer-events:auto}
:where(${S}) [data-tip]:is(:hover,:focus-visible)::after{content:attr(data-tip);position:absolute;z-index:1;inset:calc(100% + 6px) auto auto 0;width:max-content;max-width:320px;padding:6px 10px;background:var(--mg-surface-raised);color:var(--mg-text);border:var(--mg-border-width) solid var(--mg-border);border-radius:var(--mg-radius);font-size:var(--mg-small);pointer-events:none}
:where(${S}) [data-tip]{position:relative}
:where(${S}) .mg-sr{position:absolute;width:1px;height:1px;margin:-1px;padding:0;border:0;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
@media (prefers-reduced-motion:reduce){:where(${S}) *{transition:none!important;animation:none!important;scroll-behavior:auto!important}}
@media (forced-colors:active){:where(${S}) :focus-visible{outline-color:Highlight}:where(${S}) [role=option][aria-selected=true],:where(${S}) [aria-pressed=true],:where(${S}) [role=tab][aria-selected=true]{outline:2px solid Highlight;forced-color-adjust:none;background:Highlight;color:HighlightText}}
`;
interface SheetUse {
  count: number;
  remove: () => void;
}
const sheets = new WeakMap<Document, SheetUse>();
function useSheet(doc: Document, nonce: string | undefined): () => void {
  let use = sheets.get(doc);
  if (!use) {
    const win = doc.defaultView as (Window & typeof globalThis) | null,
      Sheet = win?.CSSStyleSheet;
    let remove: () => void;
    // A constructable stylesheet needs no inline style, so it passes a strict Content Security Policy.
    if (Sheet && 'adoptedStyleSheets' in doc && typeof Sheet.prototype.replaceSync === 'function') {
      const sheet = new Sheet();
      sheet.replaceSync(RULES);
      doc.adoptedStyleSheets = [...doc.adoptedStyleSheets, sheet];
      remove = () => (doc.adoptedStyleSheets = doc.adoptedStyleSheets.filter((s) => s !== sheet));
    } else {
      const style = doc.createElement('style');
      if (nonce) style.nonce = nonce;
      style.dataset.margoUi = 'dom';
      style.textContent = RULES;
      (doc.head ?? doc.documentElement).append(style);
      remove = () => style.remove();
    }
    use = { count: 0, remove };
    sheets.set(doc, use);
  }
  const held = use;
  held.count++;
  return () => {
    if (--held.count === 0) {
      held.remove();
      sheets.delete(doc);
    }
  };
}

/** The layout style as CSS (Flexbox Level 1 and Grid), for an element in a parent with direction `parent`. */
function layoutCss(w: Widget, parent: LayoutStyle['direction'] | undefined, container: boolean): [string, string][] {
  const s = w.style,
    out: [string, string][] = [],
    set = (k: string, v: string | number | undefined) => {
      if (v !== undefined) out.push([k, String(v)]);
    };
  const dir = s.direction ?? 'column';
  if (container) {
    if (dir === 'stack') {
      set('display', 'grid');
      set('grid-template', 'minmax(0, 1fr) / minmax(0, 1fr)');
    } else if (dir === 'grid') {
      set('display', 'grid');
      const cell = s.cellWidth === undefined ? 'max-content' : px(s.cellWidth);
      set('grid-template-columns', `repeat(${s.columns ?? 1}, ${cell})`);
      if (s.cellHeight !== undefined) set('grid-auto-rows', px(s.cellHeight));
    } else {
      set('display', 'flex');
      set('flex-direction', dir);
      if (s.wrap && dir === 'row') set('flex-wrap', 'wrap');
    }
    if (s.gap !== undefined) set('gap', typeof s.gap === 'number' ? px(s.gap) : `${px(s.gap[1])} ${px(s.gap[0])}`);
    if (dir === 'row' || dir === 'column') {
      set('align-items', FLEX[s.align ?? (dir === 'row' ? 'center' : 'stretch')]);
      if (s.justify) set('justify-content', SPREAD[s.justify] ?? s.justify);
    }
    if (s.overflow === 'scroll') set('overflow', 'auto');
    else if (s.overflow === 'hidden') set('overflow', 'hidden');
  }
  if (s.padding !== undefined) set('padding', box4(s.padding));
  if (s.margin !== undefined) set('margin', box4(s.margin));
  const main = parent === 'row' ? 'width' : 'height';
  const size = (name: 'width' | 'height', v: Size | undefined) => {
    if (v === undefined || v === 'auto') return;
    if (v === 'fill') {
      if (name === main && (parent === 'row' || parent === 'column' || parent === undefined)) {
        set('flex', `${s.grow ?? 1} ${s.shrink ?? 1} 0`);
        set(`min-${name}`, '0');
      } else set(name, '100%');
    } else set(name, typeof v === 'number' ? px(v) : v);
  };
  size('width', s.width);
  size('height', s.height);
  if (s.minWidth !== undefined) set('min-width', px(s.minWidth));
  if (s.maxWidth !== undefined) set('max-width', px(s.maxWidth));
  if (s.minHeight !== undefined) set('min-height', px(s.minHeight));
  if (s.maxHeight !== undefined) set('max-height', px(s.maxHeight));
  if (s.grow !== undefined && !out.some(([k]) => k === 'flex')) set('flex-grow', s.grow);
  if (s.shrink !== undefined && !out.some(([k]) => k === 'flex')) set('flex-shrink', s.shrink);
  if (s.alignSelf && s.alignSelf !== 'auto') set('align-self', FLEX[s.alignSelf]);
  if (parent === 'stack' && s.position !== 'absolute') {
    // Every child of a stack takes the one grid cell and is placed in it by its anchor.
    const [x, y] = ANCHOR[s.anchor ?? 'stretch'];
    set('grid-area', '1 / 1');
    set('justify-self', x);
    set('align-self', y);
  } else if (s.position === 'absolute') {
    const [x, y] = ANCHOR[s.anchor ?? 'top-left'],
      [mt, mr, mb, ml] = edges(s.margin).map(px);
    set('position', 'absolute');
    set('margin', '0');
    if (x === 'stretch' || x === 'start') set('left', ml);
    if (x === 'stretch' || x === 'end') set('right', mr);
    if (y === 'stretch' || y === 'start') set('top', mt);
    if (y === 'stretch' || y === 'end') set('bottom', mb);
    if (x === 'center') set('left', '50%');
    if (y === 'center') set('top', '50%');
    const tx = x === 'center' ? '-50%' : '0',
      ty = y === 'center' ? '-50%' : '0';
    if (tx !== '0' || ty !== '0') set('transform', `translate(${tx}, ${ty})`);
  }
  if (s.offset && (s.offset[0] || s.offset[1])) set('translate', `${px(s.offset[0])} ${px(s.offset[1])}`);
  return out;
}

/**
 * The longest run of `positions` (-1 = not there yet) that is already in order: those elements stay where they are and
 * only the others move, the fewest moves a keyed list needs (patience sorting, O(n log n); Fredman 1975).
 */
export function stayingInOrder(positions: readonly number[]): Set<number> {
  const tails: number[] = [],
    prev = new Array<number>(positions.length).fill(-1);
  for (let i = 0; i < positions.length; i++) {
    const p = positions[i];
    if (p < 0) continue;
    let lo = 0,
      hi = tails.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (positions[tails[mid]] < p) lo = mid + 1;
      else hi = mid;
    }
    if (lo > 0) prev[i] = tails[lo - 1];
    tails[lo] = i;
  }
  const keep = new Set<number>();
  for (let i = tails.length ? tails[tails.length - 1] : -1; i >= 0; i = prev[i]) keep.add(i);
  return keep;
}

/**
 * Show a widget tree as real, visible HTML: the same widgets, events and themes as a canvas {@link Ui}, with the
 * browser's own keyboard handling, screen reader support, text input (IME, autofill, spellcheck), zoom and touch.
 * Buttons are `<button>`, toggles and checkboxes `<input type="checkbox">` (a switch role for toggles), sliders range
 * inputs, selects `<select>`, radio groups a `<fieldset>` of radios, tabs the tablist pattern, lists listboxes,
 * dialogs a modal `<dialog>`, meters `<progress>` and text inputs `<input>` or `<textarea>`.
 *
 * Changes flow both ways and only touch what changed: setting a widget's text, value or style patches its own element
 * (focus, caret and scroll stay), and using an element calls the widget's own setters, so its `'click'`, `'change'`
 * and `'select'` events fire just as on the canvas. The theme becomes CSS custom properties (`--mg-primary`, ...) on
 * the container and one shared stylesheet, so the page can restyle it; no style attributes are written, so a strict
 * Content Security Policy passes.
 *
 * @param source A {@link Ui} (its screen, toasts and dialogs), or one widget of it (that subtree only).
 * @throws TypeError when `source` is not a Ui or a widget in one, or `container` is not an element.
 * @throws RangeError for a `targetSize` under 24.
 *
 * @example
 * import { Button, Label, Panel, Ui } from '@margoengine/ui';
 * import { mountDom } from '@margoengine/ui/dom';
 *
 * const ui = new Ui();
 * const save = new Button({ text: 'Save', variant: 'primary' });
 * ui.add(new Panel({ gap: 8, children: [new Label({ text: 'Your changes' }), save] }));
 * save.on('click', () => ui.toast('Saved'));
 * using host = mountDom(ui, document.body);
 */
export function mountDom(source: Ui | Widget, container: HTMLElement, options: DomHostOptions = {}): DomHost {
  const owner = source instanceof Ui ? source : source instanceof Widget ? source.ui : null;
  if (!owner) throw typeError('mountDom(source) takes a Ui or a widget that is part of one', 'ui');
  const ui: Ui = owner;
  if (!container || typeof container.ownerDocument?.createElement !== 'function')
    throw typeError('mountDom(source, container) needs a DOM element to mount in', 'ui');
  const target = options.targetSize ?? 44;
  if (!(Number.isFinite(target) && target >= 24))
    throw rangeError('targetSize is 24 CSS pixels or more (WCAG 2.2 SC 2.5.8)', 'ui');
  const doc = container.ownerDocument,
    prefix = options.idPrefix ?? 'margo-dom-',
    entries = new Map<Widget, Entry>(),
    byElement = new WeakMap<Element, Widget>(),
    cleanups: (() => void)[] = [],
    live = new Set<Widget>();
  let disposed = false,
    scheduled = false,
    syncing = false,
    themeKey = '';
  const idOf = (w: Widget) => `${prefix}${w.id}`;
  const make = (tag: string, cls?: string) => {
    const el = doc.createElement(tag);
    if (cls) el.className = cls;
    return el;
  };

  container.dataset.margoUi = 'dom';
  if (options.label) {
    container.setAttribute('role', 'region');
    container.setAttribute('aria-label', options.label);
  }
  cleanups.push(useSheet(doc, options.nonce));
  const content = make('div', 'mg-box'),
    toasts = make('div', 'mg-toasts'),
    dialogs = make('div'),
    descriptions = make('div'),
    polite = make('div', 'mg-sr'),
    assertive = make('div', 'mg-sr');
  descriptions.hidden = true;
  polite.setAttribute('aria-live', 'polite');
  polite.setAttribute('role', 'log');
  assertive.setAttribute('aria-live', 'assertive');
  assertive.setAttribute('role', 'alert');
  const own = [content, toasts, dialogs, descriptions, polite, assertive];
  container.append(...own);
  cleanups.push(() => {
    for (const el of own) el.remove();
    const style = container.style,
      names: string[] = [];
    for (let i = 0; i < style.length; i++) if (style.item(i).startsWith('--mg-')) names.push(style.item(i));
    for (const name of names) style.removeProperty(name);
    delete container.dataset.margoUi;
    if (options.label) {
      container.removeAttribute('role');
      container.removeAttribute('aria-label');
    }
  });

  const applyTheme = () => {
    const theme = options.theme ?? ui.theme;
    const vars: [string, string][] = Object.entries(theme.colors).map(([k, v]) => [`--mg-${kebab(k)}`, v]);
    vars.push(
      ['--mg-radius', px(theme.radius)],
      ['--mg-border-width', px(theme.borderWidth)],
      ['--mg-focus-width', px(Math.max(2, theme.focusWidth))],
      ['--mg-spacing', px(theme.spacing)],
      ['--mg-shadow-blur', px(theme.shadowBlur)],
      ['--mg-transition', `${theme.transition}s`],
      ['--mg-target', px(target)],
    );
    for (const [k, v] of Object.entries(theme.fontSize)) vars.push([`--mg-${k}`, px(v * ui.textScale)]);
    const key = vars.join(';');
    if (key === themeKey) return;
    themeKey = key;
    for (const [k, v] of vars) container.style.setProperty(k, v);
  };

  // --- Building and patching elements ----------------------------------------------------------------------------

  const kindOf = (w: Widget): Kind => {
    if (w instanceof Toggle) return 'toggle';
    if (w instanceof Slider) return 'slider';
    if (w instanceof ProgressBar) return 'progress';
    if (isText(w)) return 'text';
    if (isSelect(w)) return 'select';
    if (isRadio(w)) return 'radio';
    if (w instanceof Dialog) return 'dialog';
    if (w instanceof Label) return 'label';
    const tabs = tabsOf(w.parent?.parent ?? null);
    if (tabs && w.parent!.id === `${tabs.id}-tablist`) return 'spec';
    if (w instanceof Button || w.role === 'option' || w.parent instanceof Inventory) return 'spec';
    if (w.focusable) return 'spec';
    return 'box';
  };
  const tagOf = (w: Widget, kind: Kind): string => {
    switch (kind) {
      case 'toggle':
      case 'slider':
        return 'label';
      case 'progress':
        return 'progress';
      case 'text':
        return (w as TextLike).multiline ? 'textarea' : 'input';
      case 'select':
        return 'select';
      case 'radio':
        return 'fieldset';
      case 'dialog':
        return 'dialog';
      case 'label':
        return 'p';
      case 'box':
        return 'div';
      default: {
        const spec = describeWidget(w, prefix);
        return spec && spec !== SKIP ? spec.tag : 'div';
      }
    }
  };
  const create = (w: Widget, kind: Kind, tag: string): Entry => {
    const el = make(tag);
    el.id = idOf(w);
    let control = el,
      caption: HTMLElement | undefined;
    if (kind === 'toggle' || kind === 'slider') {
      el.className = kind === 'toggle' ? 'mg-toggle' : 'mg-slider';
      control = make('input');
      (control as HTMLInputElement).type = kind === 'toggle' ? 'checkbox' : 'range';
      control.id = `${idOf(w)}-control`;
      caption = make('span');
      if (kind === 'toggle') el.append(control, caption);
      else el.append(caption, control);
    } else if (kind === 'radio') {
      caption = make('legend');
      el.append(caption);
    } else if (kind === 'label') el.className = 'mg-label';
    const isBox = kind === 'box' || kind === 'dialog' || (kind === 'spec' && !!w.children.length && tag === 'div');
    if (isBox && kind !== 'dialog') el.classList.add('mg-box');
    if (kind === 'dialog') el.classList.add('mg-box');
    const entry: Entry = {
      widget: w,
      kind,
      tag,
      el,
      control,
      box: isBox ? el : null,
      caption,
      attrs: new Map(),
      text: '',
      css: '',
      options: '',
    };
    byElement.set(el, w);
    if (control !== el) byElement.set(control, w);
    return entry;
  };
  const setAttrs = (entry: Entry, el: HTMLElement, attrs: Attrs, scope = '') => {
    for (const [k, v] of Object.entries(attrs)) {
      const key = scope + k;
      if (entry.attrs.get(key) === v && el.hasAttribute(k) === (v !== null)) continue;
      entry.attrs.set(key, v);
      if (v === null) el.removeAttribute(k);
      else el.setAttribute(k, v);
    }
  };
  const setText = (el: HTMLElement, text: string) => {
    if (el.textContent !== text) el.textContent = text;
  };
  const prop = <T extends HTMLElement, K extends keyof T>(el: T, key: K, value: T[K]) => {
    if (el[key] !== value) el[key] = value;
  };

  const patch = (entry: Entry, parentDir: LayoutStyle['direction'] | undefined) => {
    const { widget: w, el, control } = entry,
      attrs: Attrs = {};
    const disabled = !w.active;
    switch (entry.kind) {
      case 'toggle': {
        const input = control as HTMLInputElement;
        setAttrs(entry, input, { role: w.role === 'switch' ? 'switch' : null }, 'c:');
        prop(input, 'checked', (w as Toggle).checked);
        prop(input, 'disabled', disabled);
        setText(entry.caption!, w.text || w.label);
        break;
      }
      case 'slider': {
        const input = control as HTMLInputElement,
          spec = describeWidget(w, prefix);
        if (spec && spec !== SKIP) {
          const { type: _t, disabled: _d, 'aria-label': _l, ...rest } = spec.attrs;
          setAttrs(entry, input, { ...rest, 'aria-label': w.label ? null : 'Slider' }, 'c:');
          if (input.value !== spec.value) input.value = spec.value!;
        }
        prop(input, 'disabled', disabled);
        setText(entry.caption!, w.label);
        break;
      }
      case 'progress': {
        const bar = w as ProgressBar,
          p = el as HTMLProgressElement;
        if (p.max !== bar.max) p.max = bar.max;
        if (p.value !== bar.value) p.value = bar.value;
        Object.assign(attrs, {
          'aria-label': bar.label || 'Progress',
          'aria-valuetext': bar.valueText,
          'data-variant': bar.variant,
        });
        break;
      }
      case 'text': {
        const t = w as TextLike,
          field = el as HTMLInputElement | HTMLTextAreaElement;
        if (field instanceof doc.defaultView!.HTMLInputElement) prop(field, 'type', t.type);
        Object.assign(attrs, {
          'aria-label': t.label || t.placeholder || (t.multiline ? 'Text area' : 'Text input'),
          placeholder: t.placeholder || null,
          autocomplete: t.autocomplete,
          spellcheck: String(t.spellcheck),
          maxlength: t.maxLength >= 0 ? String(t.maxLength) : null,
          required: t.required ? '' : null,
          'aria-invalid': t.invalid ? 'true' : null,
          readonly: t.readOnly ? '' : null,
        });
        prop(field, 'disabled', disabled);
        // Writing an unchanged value or selection would break native undo and an IME composition.
        if (field.value !== t.value) field.value = t.value;
        if (
          !t.composing &&
          doc.activeElement === field &&
          (field.selectionStart !== t.selectionStart || field.selectionEnd !== t.selectionEnd)
        )
          field.setSelectionRange(t.selectionStart, t.selectionEnd, t.selectionDirection);
        break;
      }
      case 'select': {
        const s = w as SelectLike,
          select = el as HTMLSelectElement,
          key = JSON.stringify(s.options);
        if (key !== entry.options) {
          entry.options = key;
          select.replaceChildren(
            ...s.options.map((o) => {
              const option = make('option') as HTMLOptionElement;
              option.value = o.value;
              option.textContent = o.label;
              option.disabled = !!o.disabled;
              return option;
            }),
          );
        }
        if (select.value !== s.value) select.value = s.value;
        prop(select, 'disabled', disabled);
        attrs['aria-label'] = s.label || 'Select';
        break;
      }
      case 'radio': {
        const r = w as RadioLike,
          key = JSON.stringify(r.options);
        setText(entry.caption!, r.label);
        entry.caption!.hidden = !r.label;
        attrs['data-orientation'] = r.orientation;
        if (!r.label) attrs['aria-label'] = 'Choices';
        if (key !== entry.options) {
          entry.options = key;
          for (const old of [...el.querySelectorAll('.mg-choice')]) old.remove();
          r.options.forEach((o, i) => {
            const row = make('label', 'mg-choice'),
              input = make('input') as HTMLInputElement,
              text = make('span');
            input.type = 'radio';
            input.name = idOf(w);
            input.value = o.value;
            input.dataset.index = String(i);
            text.textContent = o.label;
            row.append(input, text);
            el.append(row);
            byElement.set(input, w);
            byElement.set(row, w);
          });
        }
        el.querySelectorAll<HTMLInputElement>('input[type=radio]').forEach((input, i) => {
          prop(input, 'checked', r.value === r.options[i].value);
          prop(input, 'disabled', disabled || !!r.options[i].disabled);
        });
        entry.control = el.querySelector<HTMLElement>('input:checked') ?? el.querySelector('input') ?? el;
        break;
      }
      case 'dialog': {
        const spec = describeWidget(w, prefix);
        if (spec && spec !== SKIP) {
          const { role: _r, ...rest } = spec.attrs;
          Object.assign(attrs, rest);
        }
        break;
      }
      case 'label': {
        const l = w as Label;
        setText(el, l.text);
        Object.assign(attrs, {
          'data-size': l.size === 'body' ? null : l.size,
          'data-nowrap': l.wrap ? null : '',
          'data-outline': l.outline ? '' : null,
          'aria-hidden': w.id.endsWith('-badge') && w.parent instanceof Toast ? 'true' : null,
        });
        break;
      }
      case 'spec':
      case 'box': {
        const spec = describeWidget(w, prefix);
        const tabs = tabsOf(w.parent?.parent ?? null),
          ownerTabs = tabsOf(w.parent);
        if (tabs && w.parent!.id === `${tabs.id}-tablist`) {
          const i = tabs.buttons.indexOf(w);
          Object.assign(attrs, {
            type: 'button',
            role: 'tab',
            'aria-selected': String(tabs.value === tabs.options[i]?.value),
            'aria-controls': tabs.panels[i] ? idOf(tabs.panels[i]) : null,
            tabindex: w.focusable ? '0' : '-1',
            disabled: w.active ? null : '',
          });
          setText(el, w.label);
        } else if (ownerTabs && w.id === `${ownerTabs.id}-tablist`) {
          Object.assign(attrs, {
            role: 'tablist',
            'aria-orientation': ownerTabs.orientation,
            'aria-label': ownerTabs.label || null,
          });
        } else if (ownerTabs && ownerTabs.panels.includes(w)) {
          const tab = ownerTabs.buttons[ownerTabs.panels.indexOf(w)];
          Object.assign(attrs, { role: 'tabpanel', 'aria-labelledby': tab ? idOf(tab) : null, tabindex: '0' });
        } else if (spec && spec !== SKIP) {
          Object.assign(attrs, spec.attrs);
          // One tab stop per listbox (WAI-ARIA APG listbox): the focused, else the selected, else the first option.
          if (spec.attrs.role === 'option' && w.active) {
            const list = w.parent as Widget & { selected: number },
              rows = list.children.filter((c) => c.role === 'option' && c.active),
              at = (c: Widget) => ('index' in c ? (c as Widget & { index: number }).index : list.children.indexOf(c)),
              focused = rows.find((c) => c === ui.focused),
              selected = rows.find((c) => at(c) === list.selected),
              stop = focused ?? selected ?? rows[0];
            attrs.tabindex = stop === w ? '0' : '-1';
          }
          if (spec.text !== undefined && !entry.box) setText(el, spec.text);
          if (spec.value !== undefined && (el as HTMLInputElement).value !== spec.value)
            (el as HTMLInputElement).value = spec.value;
        }
        if (w instanceof Button) attrs['data-variant'] = w.variant === 'secondary' ? null : w.variant;
        if (w instanceof Panel) {
          const bg = w.background;
          attrs['data-bg'] = bg === 'none' ? null : bg;
          attrs['data-border'] = w.border ? '' : null;
          attrs['data-shadow'] = w.shadow ? '' : null;
        }
        break;
      }
    }
    // Shared by every kind: visibility, descriptions and the tooltip.
    attrs.hidden = w.visible ? null : '';
    const described = [w.description, w.tooltip].filter(Boolean).join('. ');
    if (described && entry.kind !== 'dialog') {
      entry.description ??= make('span');
      entry.description.id = `${idOf(w)}-desc`;
      setText(entry.description, described);
      if (entry.description.parentElement !== descriptions) descriptions.append(entry.description);
    } else if (entry.description) {
      entry.description.remove();
      entry.description = undefined;
    }
    const describedTarget = entry.control === el ? el : entry.control;
    if (entry.kind !== 'dialog') {
      if (describedTarget === el) attrs['aria-describedby'] = entry.description ? entry.description.id : null;
      else
        setAttrs(entry, describedTarget, { 'aria-describedby': entry.description ? entry.description.id : null }, 'c:');
    }
    attrs['data-tip'] = w.tooltip || null;
    setAttrs(entry, el, attrs);
    // Layout and colours go through the CSS object model, which a strict style-src allows.
    const css = layoutCss(w, parentDir, !!entry.box);
    if (w instanceof Panel && w.background !== 'none' && !SURFACE[w.background]) css.push(['background', w.background]);
    else if (w instanceof Panel && SURFACE[w.background]) css.push(['background', SURFACE[w.background]]);
    if (w instanceof Label) {
      const c = w.color;
      css.push(['color', c.startsWith('#') ? c : `var(--mg-${kebab(c)})`]);
      if (w.align !== 'start') css.push(['text-align', w.align === 'center' ? 'center' : 'end']);
    }
    entry.css = applyCss(el, css, entry.css);
    if (entry.box && w.style.overflow === 'scroll' && Math.abs(el.scrollTop - w.scrollY) >= 1) el.scrollTop = w.scrollY;
  };

  const applyCss = (el: HTMLElement, css: [string, string][], prev: string): string => {
    const key = css.map(([k, v]) => `${k}:${v}`).join(';');
    if (key === prev) return prev;
    const before = new Set(prev ? prev.split(';').map((kv) => kv.slice(0, kv.indexOf(':'))) : []);
    for (const [k, v] of css) {
      before.delete(k);
      el.style.setProperty(k, v);
    }
    for (const k of before) el.style.removeProperty(k);
    return key;
  };
  let contentCss = '',
    toastsCss = '';

  const render = (w: Widget, parentDir: LayoutStyle['direction'] | undefined): HTMLElement | null => {
    if (describeWidget(w, prefix) === SKIP && !(w instanceof Label)) return null;
    const kind = kindOf(w),
      tag = tagOf(w, kind);
    let entry = entries.get(w);
    if (!entry || entry.tag !== tag || entry.kind !== kind) {
      if (entry) remove(entry);
      entry = create(w, kind, tag);
      entries.set(w, entry);
    }
    live.add(w);
    patch(entry, parentDir);
    if (entry.box) {
      const dir = w.style.direction ?? 'column';
      reconcile(entry.box, renderAll(w.children, dir));
    }
    return entry.el;
  };
  const renderAll = (widgets: readonly Widget[], dir: LayoutStyle['direction']) => {
    const out: HTMLElement[] = [];
    for (const child of widgets) {
      const el = render(child, dir);
      if (el) out.push(el);
    }
    return out;
  };
  /** Put `wanted` into `parent` in order, moving only the elements that are out of order. */
  const reconcile = (parent: HTMLElement, wanted: HTMLElement[]) => {
    const set = new Set(wanted);
    for (const child of [...parent.children]) if (!set.has(child as HTMLElement)) child.remove();
    const index = new Map<Element, number>();
    [...parent.children].forEach((c, i) => index.set(c, i));
    const keep = stayingInOrder(wanted.map((el) => index.get(el) ?? -1));
    for (let i = wanted.length - 1; i >= 0; i--) {
      if (keep.has(i)) continue;
      parent.insertBefore(wanted[i], wanted[i + 1] ?? null);
    }
  };
  const remove = (entry: Entry) => {
    const d = entry.el as HTMLDialogElement;
    if (entry.kind === 'dialog' && d.open && typeof d.close === 'function') d.close();
    entry.el.remove();
    entry.description?.remove();
    entries.delete(entry.widget);
  };

  const openDialogs = () => {
    for (const el of dialogs.children) {
      const d = el as HTMLDialogElement;
      if (d.open) continue;
      // showModal makes the rest of the page inert and traps Tab (WHATWG HTML, the dialog element).
      if (typeof d.showModal === 'function' && d.isConnected) d.showModal();
      else d.setAttribute('open', '');
    }
  };

  const sync = () => {
    scheduled = false;
    if (disposed) return;
    syncing = true;
    const hadFocus = container.contains(doc.activeElement);
    try {
      ui.layout();
      live.clear();
      applyTheme();
      if (source instanceof Ui) {
        // The screen and toast layers are stacks: each child is placed by its anchor, as on the canvas.
        contentCss = applyCss(content, layoutCss(ui.root, undefined, true), contentCss);
        toastsCss = applyCss(toasts, layoutCss(ui.toastLayer, undefined, true), toastsCss);
        reconcile(content, renderAll(ui.root.children, ui.root.style.direction));
        reconcile(toasts, renderAll(ui.toastLayer.children, ui.toastLayer.style.direction));
        reconcile(dialogs, renderAll(ui.modalLayer.children, undefined));
      } else {
        const el = source.ui ? render(source, source.parent?.style.direction) : null;
        reconcile(content, el ? [el] : []);
      }
      for (const entry of [...entries.values()]) if (!live.has(entry.widget)) remove(entry);
      const modal = dialogs.children.length > 0;
      if (modal) content.setAttribute('inert', '');
      else content.removeAttribute('inert');
      openDialogs();
    } finally {
      syncing = false;
    }
    focusCurrent(hadFocus);
  };
  const schedule = () => {
    if (scheduled || disposed) return;
    scheduled = true;
    queueMicrotask(sync);
  };

  // --- Focus -----------------------------------------------------------------------------------------------------

  const widgetOf = (node: Node | null): Widget | undefined => {
    for (let el = node as Element | null; el && el !== container; el = el.parentElement) {
      const w = byElement.get(el);
      if (w) return w;
    }
    return undefined;
  };
  /** Move DOM focus to the focused widget's element, when focus is in the host (or nowhere) and not there already. */
  function focusCurrent(hadFocus = false): void {
    const w = ui.focused,
      entry = w && entries.get(w),
      active = doc.activeElement;
    if (!entry || entry.control === active) return;
    if (!(hadFocus || container.contains(active) || active === doc.body || active === null)) return;
    if (!entry.control.isConnected || entry.control.closest('[hidden],[inert]')) return;
    syncing = true;
    try {
      entry.control.focus({ preventScroll: false });
    } finally {
      syncing = false;
    }
  }
  const listen = <K extends keyof HTMLElementEventMap>(
    type: K,
    handler: (event: HTMLElementEventMap[K]) => void,
    capture = false,
  ) => {
    container.addEventListener(type, handler as EventListener, capture);
    cleanups.push(() => container.removeEventListener(type, handler as EventListener, capture));
  };
  listen('focusin', (e) => {
    if (syncing) return;
    const w = widgetOf(e.target as Node);
    if (w?.focusable && ui.focused !== w) ui.focus(w, 'keyboard');
  });
  listen('focusout', (e) => {
    if (syncing || container.contains(e.relatedTarget as Node | null)) return;
    const w = widgetOf(e.target as Node);
    if (w && ui.focused === w) ui.focus(null);
  });
  cleanups.push(ui.onFocus(() => (scheduled ? undefined : focusCurrent())));

  // --- From the elements to the widgets --------------------------------------------------------------------------

  const entryAt = (node: EventTarget | null) => {
    const w = widgetOf(node as Node);
    return w ? entries.get(w) : undefined;
  };
  listen('click', (e) => {
    const entry = entryAt(e.target);
    if (!entry || entry.kind !== 'spec' || !entry.widget.focusable) return;
    if (ui.focused !== entry.widget) ui.focus(entry.widget, 'pointer');
    entry.widget.activate();
  });
  listen('change', (e) => {
    const entry = entryAt(e.target);
    if (!entry) return;
    const w = entry.widget,
      input = e.target as HTMLInputElement;
    if (entry.kind === 'toggle' && (w as Toggle).checked !== input.checked) w.activate();
    else if (entry.kind === 'select') (w as SelectLike).select((e.target as HTMLSelectElement).value, true);
    else if (entry.kind === 'radio' && input.dataset.index)
      (w as RadioLike).selectIndex(Number(input.dataset.index), true);
    else if (entry.kind === 'slider') (w as Slider).setValue(Number(input.value));
  });
  const fromField = (entry: Entry) => {
    const field = entry.el as HTMLInputElement | HTMLTextAreaElement;
    (entry.widget as TextLike).edit(
      field.value,
      field.selectionStart ?? field.value.length,
      field.selectionEnd ?? field.value.length,
      field.selectionDirection ?? 'none',
    );
  };
  listen('input', (e) => {
    const entry = entryAt(e.target);
    if (entry?.kind === 'slider') (entry.widget as Slider).setValue(Number((e.target as HTMLInputElement).value));
    else if (entry?.kind === 'text') fromField(entry);
  });
  listen('select', (e) => {
    const entry = entryAt(e.target);
    if (entry?.kind === 'text') fromField(entry);
  });
  listen('compositionstart', (e) => {
    const entry = entryAt(e.target);
    if (entry?.kind === 'text') (entry.widget as TextLike).composing = true;
  });
  listen('compositionend', (e) => {
    const entry = entryAt(e.target);
    if (entry?.kind !== 'text') return;
    (entry.widget as TextLike).composing = false;
    fromField(entry);
  });
  // Scroll does not bubble: listen in the capture phase so every scrolling box reports to its widget.
  listen(
    'scroll',
    (e) => {
      const entry = entryAt(e.target);
      if (!entry || entry.el !== e.target || syncing) return;
      if (Math.abs(entry.widget.scrollY - entry.el.scrollTop) < 1) return;
      entry.widget.scrollY = entry.el.scrollTop;
      entry.widget.invalidate();
    },
    true,
  );
  // cancel does not bubble either.
  listen(
    'cancel',
    (e) => {
      // Escape on a <dialog>: the widget decides (a dialog that cannot be dismissed stays open).
      const entry = entryAt(e.target);
      e.preventDefault();
      if (entry?.widget instanceof Dialog) entry.widget.command('cancel');
    },
    true,
  );
  const NATIVE_KEYS = ['Enter', ' '];
  const ARROWS = ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown'];
  listen('keydown', (e) => {
    if (e.defaultPrevented || e.isComposing) return;
    const entry = entryAt(e.target);
    if (!entry) return;
    if (entry.kind === 'text') {
      if (e.key === 'Enter' && !(entry.widget as TextLike).multiline) {
        entry.widget.emit('submit', { value: (entry.widget as TextLike).value });
        e.preventDefault();
      }
      return;
    }
    // Native controls keep their own keys; the widget patterns (listbox, tabs, menus) take the UI's commands.
    const skip = new Set<string>(['Tab']);
    const el = e.target as Element;
    if (el.closest('button,input,select,textarea,summary')) for (const k of NATIVE_KEYS) skip.add(k);
    if (['slider', 'select', 'radio'].includes(entry.kind)) for (const k of ARROWS) skip.add(k);
    if (handleKeyDown(ui, e, skip)) e.preventDefault();
  });

  // --- Announcements and the update loop --------------------------------------------------------------------------

  if (options.announce !== false && source instanceof Ui) {
    const timers = new Set<ReturnType<typeof setTimeout>>();
    cleanups.push(() => {
      for (const t of timers) clearTimeout(t);
    });
    cleanups.push(
      ui.onAnnounce((message, politeness) => {
        const line = make('p');
        line.textContent = message;
        (politeness === 'assertive' ? assertive : polite).append(line);
        const t = setTimeout(() => {
          timers.delete(t);
          line.remove();
        }, 8000);
        timers.add(t);
      }),
    );
  }
  const win = doc.defaultView as (Window & typeof globalThis) | null;
  if (options.update !== false && typeof win?.requestAnimationFrame === 'function') {
    let frame = 0,
      last = -1;
    const step = (time: number) => {
      if (disposed) return;
      ui.update(last < 0 ? 0 : (time - last) / 1000);
      last = time;
      frame = win.requestAnimationFrame(step);
    };
    frame = win.requestAnimationFrame(step);
    cleanups.push(() => win.cancelAnimationFrame(frame));
  }

  cleanups.push(ui.onChange(schedule));
  sync();

  const dispose = () => {
    if (disposed) return;
    disposed = true;
    for (const entry of [...entries.values()]) remove(entry);
    for (const cleanup of cleanups.splice(0).reverse()) cleanup();
    options.signal?.removeEventListener('abort', dispose);
  };
  const host: DomHost = {
    element: container,
    elementOf: (w) => entries.get(w)?.el,
    widgetOf: (node) => widgetOf(node),
    flush: () => {
      if (scheduled) sync();
    },
    dispose,
    [Symbol.dispose ?? Symbol.for('Symbol.dispose')]: dispose,
  } as DomHost;
  if (options.signal?.aborted) dispose();
  else options.signal?.addEventListener('abort', dispose, { once: true });
  return host;
}
