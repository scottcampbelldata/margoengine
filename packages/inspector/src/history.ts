import { MargoError } from '@margoengine/math/errors';

/** One undoable edit: how to take it back and how to do it again. */
export interface Edit {
  /** Shown to people, e.g. `'Set position.x'`. */
  label: string;
  /** Puts the old value back. */
  undo(): void;
  /** Puts the new value back. */
  redo(): void;
  /**
   * Edits with the same `key` recorded within the history's `coalesceMs` of each other become one: a slider dragged
   * across fifty values undoes in one step. The merged edit keeps the first `undo` and takes the latest `redo`.
   */
  key?: string;
}

/**
 * A bounded undo/redo stack. `record` adds an edit that has already happened (it clears the redo side); `undo` and
 * `redo` run the edits and move along. Edits made by `undo`/`redo` themselves are never recorded.
 *
 * ```ts
 * const history = new EditHistory();
 * history.record({ label: 'Move', undo: () => (x = 0), redo: () => (x = 5) });
 * history.undo();
 * ```
 */
export class EditHistory {
  private readonly done: Edit[] = [];
  private readonly undone: Edit[] = [];
  private last = -Infinity;
  private running = false;
  private readonly listeners = new Set<() => void>();

  /**
   * @param limit Most edits kept (the oldest are dropped), 1 to 100,000. Default 200.
   * @param coalesceMs Window in milliseconds for merging edits with one `key`, 0 or more. Default 800.
   * @param now Clock in milliseconds. Default `performance.now`.
   */
  constructor(
    readonly limit = 200,
    readonly coalesceMs = 800,
    private readonly now: () => number = () => performance.now(),
  ) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100000)
      throw new RangeError('History limit must be an integer from 1 to 100000; pass a whole number in range');
    if (!Number.isFinite(coalesceMs) || coalesceMs < 0)
      throw new RangeError('History coalesceMs must be 0 or more; pass a number of milliseconds');
  }

  /** Edits that `undo()` would take back. */
  get undoCount(): number {
    return this.done.length;
  }
  /** Edits that `redo()` would do again. */
  get redoCount(): number {
    return this.undone.length;
  }
  /** Label of the edit `undo()` would take back, or undefined. */
  get nextUndo(): string | undefined {
    return this.done.at(-1)?.label;
  }
  /** Label of the edit `redo()` would do again, or undefined. */
  get nextRedo(): string | undefined {
    return this.undone.at(-1)?.label;
  }

  /**
   * Adds an edit that has just been applied and forgets the redo side.
   * @throws TypeError when `edit` lacks a label, `undo` or `redo`; MargoError `'state'` from inside an undo or redo.
   */
  record(edit: Edit): void {
    if (!edit || typeof edit.label !== 'string' || typeof edit.undo !== 'function' || typeof edit.redo !== 'function')
      throw new TypeError('History edit needs a label, undo and redo; pass {label, undo, redo}');
    if (this.running) throw new MargoError('state', 'History is replaying an edit; record edits outside undo and redo');
    const time = this.now(),
      previous = this.done.at(-1);
    if (
      edit.key !== undefined &&
      previous?.key === edit.key &&
      !this.undone.length &&
      time - this.last <= this.coalesceMs
    )
      this.done[this.done.length - 1] = { label: edit.label, key: edit.key, undo: previous.undo, redo: edit.redo };
    else {
      this.done.push(edit);
      if (this.done.length > this.limit) this.done.shift();
    }
    this.last = time;
    this.undone.length = 0;
    this.changed();
  }

  /** Takes back the latest edit; false when there is none. */
  undo(): boolean {
    return this.step(this.done, this.undone, 'undo');
  }
  /** Does the latest undone edit again; false when there is none. */
  redo(): boolean {
    return this.step(this.undone, this.done, 'redo');
  }
  /** Forgets every edit. */
  clear(): void {
    this.done.length = this.undone.length = 0;
    this.last = -Infinity;
    this.changed();
  }
  /** Calls `listener` after every record, undo, redo and clear. Returns a function that removes it. */
  onChange(listener: () => void): () => void {
    if (typeof listener !== 'function') throw new TypeError('History onChange needs a function; pass a listener');
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  }

  private step(from: Edit[], to: Edit[], action: 'undo' | 'redo'): boolean {
    if (this.running) throw new MargoError('state', 'History is replaying an edit; call undo and redo outside edits');
    const edit = from.at(-1);
    if (!edit) return false;
    this.running = true;
    try {
      edit[action]();
    } finally {
      this.running = false;
    }
    // Moved only once it ran: an edit that throws stays where it was, so it can be retried or cleared.
    from.pop();
    to.push(edit);
    // An edit after an undo or redo is a new step, never merged into the one just replayed.
    this.last = -Infinity;
    this.changed();
    return true;
  }
  private changed(): void {
    for (const listener of [...this.listeners]) listener();
  }
}
