/// <reference lib="esnext.disposable" preserve="true" />
import { EditHistory } from './history.js';
import { hexColor } from '@margoengine/math/color';
import { fault, rangeError, typeError } from '../../shared/errors.js';

/** Numeric bounds. Unset bounds are unlimited; unset step accepts any finite number. */
export interface TweakRange {
  min?: number;
  max?: number;
  step?: number;
}
/** Binding options. Colours use normalized RGB(A) unless colorScale is 255. */
export interface TweakBindingOptions extends TweakRange {
  label?: string;
  kind?: 'color' | 'vector' | 'text';
  options?: readonly unknown[] | Record<string, unknown>;
  colorScale?: 1 | 255;
  axes?: Record<string, TweakRange>;
  readonly?: boolean;
  /** Reverses a function button. Functions without this are actions outside the edit history. */
  undo?: () => void;
}
/** Panel placement, shared history and cancellation. */
export interface TweakPanelOptions {
  /** Default document.body. Pass a parent to use a different document. */
  parent?: HTMLElement;
  title?: string;
  history?: EditHistory;
  signal?: AbortSignal;
}
const copy = (v: unknown): unknown => {
  if (ArrayBuffer.isView(v)) return Array.from(v as unknown as ArrayLike<number>);
  if (Array.isArray(v)) return [...v];
  if (v && typeof v === 'object') return { ...v };
  return v;
};
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
function number(v: unknown, range: TweakRange): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) throw typeError('Binding needs a finite number', 'transform');
  let result = v;
  if (range.step !== undefined)
    result = (range.min ?? 0) + Math.round((v - (range.min ?? 0)) / range.step) * range.step;
  result = Math.max(range.min ?? -Infinity, Math.min(range.max ?? Infinity, result));
  return result;
}
function checkRange(r: TweakRange): void {
  if (
    [r.min, r.max, r.step].some((n) => n !== undefined && !Number.isFinite(n)) ||
    (r.step !== undefined && r.step <= 0) ||
    (r.min ?? -Infinity) > (r.max ?? Infinity)
  )
    throw rangeError('Binding bounds must be finite, min <= max and step > 0', 'transform');
}

/** One live binding; setValue is one undo step, a DOM input gesture is one step until change/blur. */
export class TweakBinding<T extends object = object, K extends keyof T = keyof T> {
  readonly element: HTMLDivElement;
  private readonly inputs: (HTMLInputElement | HTMLSelectElement | HTMLButtonElement)[] = [];
  private readonly axes: string[];
  private readonly initial: unknown;
  private pending?: { before: unknown };
  private dead = false;
  private readonly choices?: [string, unknown][];
  private readonly kind: string;
  private readonly listeners = new Set<(value: T[K]) => void>();
  constructor(
    readonly panel: TweakPanel,
    readonly object: T,
    readonly key: K,
    readonly options: TweakBindingOptions,
  ) {
    checkRange(options);
    for (const range of Object.values(options.axes ?? {})) checkRange(range);
    if (options.colorScale !== undefined && options.colorScale !== 1 && options.colorScale !== 255)
      throw rangeError('colorScale must be 1 or 255', 'transform');
    const value = object[key];
    this.initial = options.options ? value : copy(value);
    this.axes =
      !options.options && value && typeof value === 'object'
        ? Array.isArray(value) || ArrayBuffer.isView(value)
          ? Array.from({ length: (value as unknown as ArrayLike<number>).length }, (_, i) => String(i))
          : Object.keys(value)
        : [];
    this.choices = options.options
      ? Array.isArray(options.options)
        ? options.options.map((v) => [String(v), v])
        : Object.entries(options.options)
      : undefined;
    this.kind = this.choices
      ? 'enum'
      : typeof value === 'function'
        ? 'button'
        : (options.kind ?? (this.axes.length ? (this.axes.includes('r') ? 'color' : 'vector') : typeof value));
    if (!['enum', 'button', 'color', 'vector', 'text', 'string', 'number', 'boolean'].includes(this.kind))
      throw typeError('Binding supports numbers, strings, booleans, vectors, colours and functions', 'transform');
    this.normalize(value);
    const doc = panel.element.ownerDocument;
    this.element = doc.createElement('div');
    this.element.className = 'binding';
    Object.assign(this.element.style, {
      display: 'flex',
      alignItems: 'center',
      flexWrap: 'wrap',
      gap: '6px',
      margin: '6px 0',
    });
    const title = doc.createElement('span');
    title.textContent = options.label ?? String(key);
    this.element.append(title);
    const add = (type: string, axis?: string) => {
      const input = doc.createElement('input');
      input.type = type;
      input.setAttribute('aria-label', `${title.textContent}${axis === undefined ? '' : `.${axis}`}`);
      if (type === 'number' || type === 'range') {
        const r = { ...options, ...options.axes?.[axis ?? ''] };
        if (r.min !== undefined) input.min = String(r.min);
        if (r.max !== undefined) input.max = String(r.max);
        input.step = r.step === undefined ? 'any' : String(r.step);
      }
      input.addEventListener('input', () => this.input(input, axis));
      input.addEventListener('change', () => {
        this.input(input, axis);
        this.finish();
      });
      input.addEventListener('blur', () => this.finish());
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
          this.cancel();
          e.stopPropagation();
        }
      });
      this.inputs.push(input);
      this.element.append(input);
    };
    if (this.kind === 'enum') {
      const select = doc.createElement('select');
      select.setAttribute('aria-label', title.textContent!);
      for (const [i, [label]] of this.choices!.entries()) {
        const option = doc.createElement('option');
        option.value = String(i);
        option.textContent = label;
        select.append(option);
      }
      select.addEventListener('change', () => this.setValue(this.choices![Number(select.value)][1] as T[K]));
      this.inputs.push(select);
      this.element.append(select);
    } else if (this.kind === 'button') {
      const button = doc.createElement('button');
      button.textContent = title.textContent;
      button.addEventListener('click', () => this.fire());
      this.inputs.push(button);
      this.element.append(button);
      title.hidden = true;
    } else if (this.kind === 'vector' || (this.kind === 'color' && this.axes.length)) {
      for (const axis of this.axes) add('number', axis);
    } else if (this.kind === 'color') add('color');
    else if (this.kind === 'number') {
      add('number');
      if (options.min !== undefined && options.max !== undefined) add('range');
    } else add(this.kind === 'boolean' ? 'checkbox' : 'text');
    if (this.kind === 'color' && this.axes.length) add('color');
    panel.content.append(this.element);
    this.refresh();
  }
  private alive(): void {
    if (this.dead) throw fault('disposed', 'Binding is disposed; add a new binding');
  }
  private normalize(v: unknown): unknown {
    if (this.kind === 'enum') {
      if (!this.choices!.some(([, choice]) => Object.is(choice, v)))
        throw rangeError('Value is absent from binding options', 'transform');
      return v;
    }
    if (this.kind === 'number') return number(v, this.options);
    if (this.kind === 'color' && !this.axes.length) {
      if (typeof this.initial === 'number') {
        if (!Number.isInteger(v) || (v as number) < 0 || (v as number) > 0xffffff)
          throw rangeError('Colour must be a 24-bit integer', 'transform');
      } else if (typeof v !== 'string' || v.length !== 7 || !hexColor(v))
        throw typeError('Colour string must be #rrggbb', 'transform');
      return v;
    }
    if (this.axes.length) {
      if (!v || typeof v !== 'object') throw typeError('Vector or colour must retain its component shape', 'transform');
      const out = copy(v) as Record<string, unknown>;
      for (const axis of this.axes) {
        const colorRange =
          this.kind === 'color'
            ? { min: 0, max: axis === 'a' || axis === '3' ? 1 : (this.options.colorScale ?? 1) }
            : {};
        out[axis] = number((v as Record<string, unknown>)[axis], {
          ...this.options,
          ...colorRange,
          ...this.options.axes?.[axis],
        });
      }
      return out;
    }
    if (typeof v !== typeof this.initial) throw typeError('Binding value must keep its type', 'transform');
    return v;
  }
  private write(v: unknown): void {
    if (this.axes.length) {
      const target = this.object[this.key] as Record<string, unknown>;
      for (const axis of this.axes) target[axis] = (v as Record<string, unknown>)[axis];
    } else this.object[this.key] = v as T[K];
    this.refresh();
    for (const listener of this.listeners) listener(this.object[this.key]);
  }
  private record(before: unknown, after: unknown): void {
    if (this.kind === 'enum' ? Object.is(before, after) : same(before, after)) return;
    this.panel.history.record({
      label: `Set ${this.options.label ?? String(this.key)}`,
      undo: () => this.write(before),
      redo: () => this.write(after),
    });
  }
  /** Checked programmatic edit; vectors and colours keep the bound object's identity. */
  setValue(value: T[K]): this {
    this.alive();
    if (this.options.readonly) throw fault('state', 'Binding is read only; edit the source object');
    if (this.kind === 'button') throw fault('state', 'Call fire() to invoke a button');
    this.finish();
    const after = this.normalize(value),
      before = this.kind === 'enum' ? this.object[this.key] : copy(this.object[this.key]);
    if (!(this.kind === 'enum' ? Object.is(before, after) : same(before, after))) {
      this.write(after);
      this.record(before, this.kind === 'enum' ? this.object[this.key] : copy(this.object[this.key]));
    }
    return this;
  }
  getValue(): T[K] {
    this.alive();
    return this.object[this.key];
  }
  /** Called on changes, including history replay. Returns an unsubscribe function. */
  onChange(listener: (value: T[K]) => void): () => void {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  }
  reset(): this {
    return this.setValue((this.kind === 'enum' ? this.initial : copy(this.initial)) as T[K]);
  }
  fire(): void {
    this.alive();
    if (this.options.readonly || this.kind !== 'button') throw fault('state', 'Binding is not an enabled button');
    const run = () => (this.object[this.key] as () => void).call(this.object);
    run();
    if (this.options.undo)
      this.panel.history.record({ label: this.options.label ?? String(this.key), undo: this.options.undo, redo: run });
  }
  private input(input: HTMLInputElement, axis?: string): void {
    if (this.dead || this.options.readonly) return;
    let value: unknown = this.object[this.key];
    if (input.type === 'color') {
      const hex = parseInt(input.value.slice(1), 16);
      if (this.axes.length) {
        value = copy(value);
        const keys = this.axes.includes('r') ? ['r', 'g', 'b'] : ['0', '1', '2'];
        keys.forEach((k, i) => {
          (value as Record<string, unknown>)[k] =
            (((hex >> ((2 - i) * 8)) & 255) / 255) * (this.options.colorScale ?? 1);
        });
      } else value = typeof this.initial === 'number' ? hex : input.value;
    } else if (axis !== undefined) {
      value = copy(value);
      (value as Record<string, unknown>)[axis] = input.valueAsNumber;
    } else
      value = input.type === 'checkbox' ? input.checked : this.kind === 'number' ? input.valueAsNumber : input.value;
    // Invalid partial text stays visible for correction; the last valid source value is retained.
    if ((input.type === 'number' || input.type === 'range') && !Number.isFinite(input.valueAsNumber)) {
      input.setCustomValidity('Enter a finite number');
      return;
    }
    input.setCustomValidity('');
    const normalized = this.normalize(value);
    this.pending ??= { before: copy(this.object[this.key]) };
    this.write(normalized);
  }
  finish(): void {
    if (this.pending) {
      const { before } = this.pending;
      this.pending = undefined;
      this.record(before, copy(this.object[this.key]));
    }
  }
  cancel(): void {
    if (this.pending) {
      const { before } = this.pending;
      this.pending = undefined;
      this.write(before);
    }
  }
  refresh(): this {
    if (this.dead) return this;
    const value = this.object[this.key];
    let axis = 0;
    for (const input of this.inputs) {
      input.disabled = !!this.options.readonly;
      if (input.tagName === 'BUTTON') continue;
      if (this.kind === 'enum') {
        (input as HTMLSelectElement).value = String(this.choices!.findIndex(([, v]) => Object.is(v, value)));
        continue;
      }
      const field = input as HTMLInputElement;
      if (field.type === 'checkbox') field.checked = !!value;
      else if (field.type === 'color') {
        let hex: number;
        if (this.axes.length) {
          const keys = this.axes.includes('r') ? ['r', 'g', 'b'] : ['0', '1', '2'];
          hex = keys.reduce(
            (n, k) =>
              (n << 8) |
              Math.round((Number((value as Record<string, unknown>)[k]) / (this.options.colorScale ?? 1)) * 255),
            0,
          );
        } else hex = typeof value === 'number' ? value : parseInt(String(value).slice(1), 16);
        field.value = '#' + hex.toString(16).padStart(6, '0');
      } else field.value = String(this.axes.length ? (value as Record<string, unknown>)[this.axes[axis++]] : value);
    }
    return this;
  }
  dispose(): void {
    if (this.dead) return;
    this.finish();
    this.dead = true;
    this.listeners.clear();
    this.element.remove();
  }
  [Symbol.dispose](): void {
    this.dispose();
  }
}

/** Standalone, engine-free parameter panel. Folders share the root's history and lifecycle. */
export class TweakPanel {
  readonly element: HTMLElement;
  readonly content: HTMLElement;
  readonly history: EditHistory;
  private readonly bindings = new Set<{ finish(): void; refresh(): unknown; dispose(): void }>();
  private readonly folders = new Set<TweakPanel>();
  private dead = false;
  private readonly unsubscribe: () => void;
  private readonly abort: () => void;
  private readonly signal?: AbortSignal;
  private readonly titleElement: HTMLElement;
  constructor(options: TweakPanelOptions = {}) {
    options.signal?.throwIfAborted();
    const parent = options.parent ?? document.body,
      doc = parent.ownerDocument;
    this.history = options.history ?? new EditHistory();
    this.element = doc.createElement('details');
    (this.element as HTMLDetailsElement).open = true;
    this.titleElement = doc.createElement('summary');
    this.titleElement.textContent = options.title ?? 'Parameters';
    this.content = doc.createElement('div');
    Object.assign(this.element.style, {
      font: '12px system-ui',
      background: '#fafbfc',
      color: '#202226',
      padding: '10px',
      maxWidth: '360px',
    });
    this.element.append(this.titleElement, this.content);
    parent.append(this.element);
    const bar = doc.createElement('div');
    for (const action of ['undo', 'redo'] as const) {
      const button = doc.createElement('button');
      button.textContent = action === 'undo' ? 'Undo' : 'Redo';
      button.addEventListener('click', () => this[action]());
      bar.append(button);
    }
    this.content.append(bar);
    this.unsubscribe = this.history.onChange(() => {
      this.refresh();
      (bar.children[0] as HTMLButtonElement).disabled = !this.history.undoCount;
      (bar.children[1] as HTMLButtonElement).disabled = !this.history.redoCount;
    });
    this.element.addEventListener('keydown', (event) => {
      const e = event as KeyboardEvent;
      if ((!e.ctrlKey && !e.metaKey) || /INPUT|TEXTAREA|SELECT/.test((e.target as HTMLElement).tagName)) return;
      if (e.key.toLowerCase() === 'z') {
        e.preventDefault();
        e.stopPropagation();
        e.shiftKey ? this.redo() : this.undo();
      } else if (e.key.toLowerCase() === 'y') {
        e.preventDefault();
        e.stopPropagation();
        this.redo();
      }
    });
    this.signal = options.signal;
    this.abort = () => this.dispose();
    this.signal?.addEventListener('abort', this.abort, { once: true });
  }
  private alive(): void {
    if (this.dead) throw fault('disposed', 'TweakPanel is disposed; create a new panel');
  }
  add<T extends object, K extends keyof T>(object: T, key: K, options: TweakBindingOptions = {}): TweakBinding<T, K> {
    this.alive();
    const binding = new TweakBinding(this, object, key, options);
    this.bindings.add(binding);
    return binding;
  }
  addColor<T extends object, K extends keyof T>(
    object: T,
    key: K,
    options: TweakBindingOptions = {},
  ): TweakBinding<T, K> {
    return this.add(object, key, { ...options, kind: 'color' });
  }
  addFolder(title: string): TweakPanel {
    this.alive();
    const folder = new TweakPanel({ parent: this.content, title, history: this.history });
    this.folders.add(folder);
    return folder;
  }
  /** Explicit refresh follows external application writes without timers or globals. */
  refresh(): void {
    for (const b of this.bindings) b.refresh();
    for (const f of this.folders) f.refresh();
  }
  private finish(): void {
    for (const b of this.bindings) b.finish();
    for (const f of this.folders) f.finish();
  }
  undo(): boolean {
    this.alive();
    this.finish();
    return this.history.undo();
  }
  redo(): boolean {
    this.alive();
    this.finish();
    return this.history.redo();
  }
  dispose(): void {
    if (this.dead) return;
    this.dead = true;
    this.signal?.removeEventListener('abort', this.abort);
    this.unsubscribe();
    for (const b of this.bindings) b.dispose();
    for (const f of this.folders) f.dispose();
    this.bindings.clear();
    this.folders.clear();
    this.element.remove();
  }
  [Symbol.dispose](): void {
    this.dispose();
  }
}
