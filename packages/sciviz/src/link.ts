// Clean room: Vega-Lite selection algebra (Satyanarayan et al., 2017) and linked
// sources (Heer and Agrawala, 2006). The renderer is separate from the store.
import { fault, rangeError, typeError } from '../../shared/errors.js';
import { recordSelectionValue } from './spec-hooks.js';

export { bindSelection, type SelectionBinding, type SelectionBindingOptions } from './link-layer.js';

/** Stable dataset identity, independent of layer order or subset. */
export type RowKey = string | number;
/** Across views: one brush, any brush, or every active brush. Default global. */
export type SelectionResolve = 'global' | 'union' | 'intersect';
/** Within a brush. Default replace. */
export type SelectionOperation = 'replace' | 'union' | 'intersect' | 'toggle' | 'subtract';
/** Immutable selection notification with lazy row-id materialization. */
export interface SelectionChange {
  readonly source: string;
  readonly active: boolean;
  readonly version: number;
  /** A fresh snapshot in dataset order; evaluated only when requested. */
  readonly rowIds: readonly RowKey[];
}
/** Resolution, empty-predicate and undo policy for a shared dataset. */
export interface SelectionOptions {
  /** Open accepts stable keys as they arrive from streamed sources; rowIds enumerates explicit selections only. Default fixed. */
  readonly universe?: 'fixed' | 'open';
  readonly resolve?: SelectionResolve;
  /** Rows pass when there is no brush. Default true. An explicit empty brush rejects every row. */
  readonly empty?: boolean;
  /** Undo snapshots, default 32. */
  readonly history?: number;
}

/** Shift toggles, Ctrl/Meta adds, Alt intersects. */
export function selectionOperation(
  event: Pick<MouseEvent, 'shiftKey' | 'ctrlKey' | 'metaKey' | 'altKey'>,
): SelectionOperation {
  return event.shiftKey ? 'toggle' : event.altKey ? 'intersect' : event.ctrlKey || event.metaKey ? 'union' : 'replace';
}

type Brushes = Map<string, Set<RowKey>>;
/** Portable brush and undo/redo state for a shared dataset. */
export interface SelectionJSON {
  readonly version: 1;
  readonly rowIds: readonly RowKey[];
  readonly options: Required<SelectionOptions>;
  readonly brushes: readonly { readonly source: string; readonly rows: readonly RowKey[] }[];
  readonly past: readonly SelectionJSON['brushes'][];
  readonly future: readonly SelectionJSON['brushes'][];
  readonly revision: number;
}
const copy = (brushes: Brushes): Brushes => new Map([...brushes].map(([key, rows]) => [key, new Set(rows)]));

/** Shared keyed selection. All mutations validate before publishing; no globals or import side effects. */
export class SelectionStore extends EventTarget {
  readonly #keys: readonly RowKey[];
  readonly #universe: Set<RowKey>;
  readonly #resolve: SelectionResolve;
  readonly #empty: boolean;
  readonly #limit: number;
  readonly #open: boolean;
  #brushes: Brushes = new Map();
  #selected = new Set<RowKey>();
  #past: Brushes[] = [];
  #future: Brushes[] = [];
  #version = 0;
  #disposed = false;

  constructor(rowIds: ArrayLike<RowKey>, options: SelectionOptions = {}) {
    super();
    const keys = Array.from(rowIds);
    for (const key of keys)
      if (!(typeof key === 'string' || (typeof key === 'number' && Number.isFinite(key))))
        throw typeError('Selection row keys must be strings or finite numbers', 'sciviz');
    this.#universe = new Set(keys);
    if (this.#universe.size !== keys.length) throw rangeError('Selection dataset row keys must be unique', 'sciviz');
    this.#keys = keys;
    this.#open = options.universe === 'open';
    if (options.universe !== undefined && !['fixed', 'open'].includes(options.universe))
      throw rangeError('Unknown selection universe', 'sciviz');
    this.#resolve = options.resolve ?? 'global';
    if (!['global', 'union', 'intersect'].includes(this.#resolve))
      throw rangeError('Unknown selection resolve rule', 'sciviz');
    this.#empty = options.empty ?? true;
    this.#limit = options.history ?? 32;
    if (!Number.isInteger(this.#limit) || this.#limit < 0)
      throw rangeError('Selection history must be a nonnegative integer', 'sciviz');
    recordSelectionValue(this, () => this.toJSON());
  }

  /** Snapshot keys, resolution, brushes and history without materializing renderer masks. */
  toJSON(): SelectionJSON {
    this.#check();
    const snapshot = (brushes: Brushes) => [...brushes].map(([source, rows]) => ({ source, rows: [...rows] }));
    return {
      version: 1,
      rowIds: [...this.#keys],
      options: { universe: this.#open ? 'open' : 'fixed', resolve: this.#resolve, empty: this.#empty, history: this.#limit },
      brushes: snapshot(this.#brushes),
      past: this.#past.map(snapshot),
      future: this.#future.map(snapshot),
      revision: this.#version,
    };
  }
  /** Restore validated state without dispatching application events during construction. */
  static fromJSON(state: SelectionJSON): SelectionStore {
    if (
      !state ||
      state.version !== 1 ||
      !Array.isArray(state.rowIds) ||
      !Array.isArray(state.brushes) ||
      !Array.isArray(state.past) ||
      !Array.isArray(state.future) ||
      !Number.isSafeInteger(state.revision) ||
      state.revision < 0
    )
      throw typeError('Invalid selection state; use a version 1 snapshot', 'sciviz');
    const store = new SelectionStore(state.rowIds, state.options);
    const restore = (brushes: SelectionJSON['brushes']): Brushes => {
      if (!Array.isArray(brushes)) throw typeError('Invalid brush history; supply ordered brush arrays', 'sciviz');
      const result: Brushes = new Map();
      for (const brush of brushes) {
        if (
          !brush ||
          typeof brush.source !== 'string' ||
          result.has(brush.source) ||
          !Array.isArray(brush.rows) ||
          brush.rows.some((key: RowKey) => !store.contains(key)) ||
          new Set(brush.rows).size !== brush.rows.length
        )
          throw typeError('Invalid brush keys; use unique sources and dataset row IDs', 'sciviz');
        result.set(brush.source, new Set(brush.rows));
      }
      return result;
    };
    if (state.past.length + state.future.length > store.#limit)
      throw rangeError('Selection history exceeds its limit; correct the saved history', 'sciviz');
    store.#brushes = restore(state.brushes);
    store.#past = state.past.map(restore);
    store.#future = state.future.map(restore);
    store.#version = state.revision - 1;
    store.#publish('restore');
    return store;
  }

  get active(): boolean {
    return this.#brushes.size > 0;
  }
  get version(): number {
    return this.#version;
  }
  get resolve(): SelectionResolve {
    return this.#resolve;
  }
  get rowIds(): readonly RowKey[] {
    if (this.#open) return this.active ? [...this.#selected] : [];
    return this.#keys.filter((key) => this.has(key));
  }
  get canUndo(): boolean {
    return this.#past.length > 0;
  }
  get canRedo(): boolean {
    return this.#future.length > 0;
  }
  has(key: RowKey): boolean {
    return this.contains(key) && (this.active ? this.#selected.has(key) : this.#empty);
  }
  contains(key: RowKey): boolean {
    return this.#open
      ? typeof key === 'string' || (typeof key === 'number' && Number.isFinite(key))
      : this.#universe.has(key);
  }

  #check(): void {
    if (this.#disposed) throw fault('state', 'SelectionStore is disposed', 'sciviz');
  }
  #remember(): void {
    if (this.#limit) {
      this.#past.push(copy(this.#brushes));
      if (this.#past.length > this.#limit) this.#past.shift();
    }
    this.#future = [];
  }
  #publish(source: string): void {
    const sets = [...this.#brushes.values()];
    this.#selected = new Set();
    if (sets.length) {
      if (this.#resolve === 'intersect') {
        for (const key of sets[0]) if (sets.every((set) => set.has(key))) this.#selected.add(key);
      } else for (const set of sets) for (const key of set) this.#selected.add(key);
    }
    const selected = this.#selected,
      active = this.active,
      empty = this.#empty,
      keys = this.#keys;
    const open = this.#open;
    this.dispatchEvent(
      new CustomEvent<SelectionChange>('change', {
        detail: {
          source,
          active,
          version: ++this.#version,
          get rowIds() {
            return open ? (active ? [...selected] : []) : keys.filter((key) => (active ? selected.has(key) : empty));
          },
        },
      }),
    );
  }

  select(
    rowIds: Iterable<RowKey>,
    options: { readonly source?: string; readonly operation?: SelectionOperation } = {},
  ): void {
    this.#check();
    const source = options.source ?? 'default',
      operation = options.operation ?? 'replace';
    if (!['replace', 'union', 'intersect', 'toggle', 'subtract'].includes(operation))
      throw rangeError('Unknown selection operation', 'sciviz');
    const incoming = new Set(rowIds);
    for (const key of incoming) if (!this.contains(key)) throw rangeError(`Unknown selection row key ${key}`, 'sciviz');
    const previous = this.#brushes.get(source) ?? (this.#resolve === 'global' ? this.#selected : new Set<RowKey>());
    const next = operation === 'replace' ? incoming : new Set(previous);
    if (operation === 'intersect')
      for (const key of next) {
        if (!incoming.has(key)) next.delete(key);
      }
    else if (operation !== 'replace')
      for (const key of incoming) {
        if (operation === 'subtract' || (operation === 'toggle' && next.has(key))) next.delete(key);
        else next.add(key);
      }
    this.#remember();
    if (this.#resolve === 'global') this.#brushes.clear();
    this.#brushes.set(source, next);
    this.#publish(source);
  }

  clear(source?: string): void {
    this.#check();
    if (!this.active || (source !== undefined && !this.#brushes.has(source))) return;
    this.#remember();
    if (source === undefined) this.#brushes.clear();
    else this.#brushes.delete(source);
    this.#publish(source ?? 'clear');
  }
  undo(): boolean {
    this.#check();
    const state = this.#past.pop();
    if (!state) return false;
    this.#future.push(this.#brushes);
    this.#brushes = state;
    this.#publish('undo');
    return true;
  }
  redo(): boolean {
    this.#check();
    const state = this.#future.pop();
    if (!state) return false;
    this.#past.push(this.#brushes);
    this.#brushes = state;
    this.#publish('redo');
    return true;
  }
  /** Subscription removed by its return value or AbortSignal. */
  subscribe(listener: (change: SelectionChange) => void, options: { readonly signal?: AbortSignal } = {}): () => void {
    this.#check();
    const onChange = (event: Event) => listener((event as CustomEvent<SelectionChange>).detail);
    this.addEventListener('change', onChange, options);
    return () => this.removeEventListener('change', onChange);
  }
  dispose(): void {
    this.#disposed = true;
    this.#brushes.clear();
    this.#selected.clear();
    this.#past = [];
    this.#future = [];
  }
  [Symbol.dispose](): void {
    this.dispose();
  }
}
