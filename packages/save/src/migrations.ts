// A registry of schema migrations: one step per version, applied in order to a copy, each checked to land on the
// version it promised. Old saves keep loading after the game's data changes shape.
import { MargoError } from '@margoengine/math/errors';
import type { SaveDocument } from './document.js';

/** One migration step: takes a document at version `from` and returns it at `from + 1` (a copy or the same object). */
export type Migration = (document: SaveDocument) => SaveDocument;

/**
 * Migrations between schema versions. Register one step per version (`register(1, fn)` moves 1 to 2); `migrate`
 * applies the steps from the document's version up to `latest` (or a given target) on a deep copy, so the input is
 * never changed and a failing step leaves nothing half-migrated.
 */
export class Migrations {
  private readonly steps = new Map<number, Migration>();
  /** @param latest The current schema version (default 1, or the highest registered `from + 1`, whichever is higher). */
  constructor(private readonly current = 1) {
    if (!Number.isInteger(current) || current < 1)
      throw new RangeError('Latest schema version must be a whole number of 1 or more');
  }
  /** The version `migrate` brings documents to by default. */
  get latest(): number {
    let latest = this.current;
    for (const from of this.steps.keys()) latest = Math.max(latest, from + 1);
    return latest;
  }
  /**
   * Register the step from version `from` to `from + 1`.
   * @throws RangeError for a version that is not a whole number of 1 or more; MargoError `'state'` for a version
   * that already has a step.
   */
  register(from: number, migration: Migration): this {
    if (!Number.isInteger(from) || from < 1)
      throw new RangeError('Migration version must be a whole number of 1 or more');
    if (typeof migration !== 'function') throw new TypeError('Migration must be a function (document) => document');
    if (this.steps.has(from))
      throw new MargoError(
        'state',
        `A migration from version ${from} is already registered; register each version once`,
      );
    this.steps.set(from, migration);
    return this;
  }
  /** True when every step from `from` up to `to` is registered. */
  covers(from: number, to = this.latest): boolean {
    for (let v = from; v < to; v++) if (!this.steps.has(v)) return false;
    return true;
  }
  /**
   * A copy of `document` at version `to` (default `latest`). A document already there is returned as a copy.
   * @throws MargoError `'failed'` when a step is missing, a step throws (the error is its `cause`), or a step returns
   * something that is not a save at the next version; RangeError for a document newer than `to` (a save from a
   * newer game).
   */
  migrate(document: SaveDocument, to = this.latest): SaveDocument {
    const from = document?.version;
    if (!Number.isInteger(from) || from < 1)
      throw new TypeError('Save version must be a whole number of 1 or more; is this a save document?');
    if (from > to) throw new RangeError(`Save is version ${from}, newer than ${to}; update the game to load it`);
    let current = structuredClone(document);
    for (let v = from; v < to; v++) {
      const step = this.steps.get(v);
      if (!step)
        throw new MargoError(
          'failed',
          `No migration from save version ${v} to ${v + 1}; register one with migrations.register(${v}, fn)`,
        );
      let next: SaveDocument;
      try {
        next = step(current);
      } catch (error) {
        throw Object.assign(
          new MargoError(
            'failed',
            `Migration from save version ${v} to ${v + 1} threw; fix that step (the error is the cause)`,
          ),
          {
            cause: error,
          },
        );
      }
      if (next == null || typeof next !== 'object' || next.version !== v + 1)
        throw new MargoError(
          'failed',
          `Migration from save version ${v} must return the document with version ${v + 1}; set document.version in the step`,
        );
      current = next;
    }
    return current;
  }
}
