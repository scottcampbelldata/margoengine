import { MargoError } from '@margoengine/math/errors';
import type { ComponentStore as Component, Entity, World } from './index.js';

/** Terms of a {@link Query}. Tags from `world.tag()` work in all three lists. */
export interface QueryTerms {
  /** An entity must have every one of these. At least one. */
  with: readonly Component[];
  /** An entity must have none of these. Default none. */
  without?: readonly Component[];
  /** An entity may have these or not; they never change the match, only the rows given to `forEach`. Default none. */
  optional?: readonly Component[];
}

/** A reusable set of terms: required components, excluded components and optional ones. */
export class Query {
  private readonly required: readonly Component[];
  private readonly excluded: readonly Component[];
  private readonly reads: readonly Component[];
  private readonly rows: Int32Array;
  private matches = new Uint32Array(0);
  private visiting = false;
  /** @throws TypeError when `with` is empty or a term belongs to another world. */
  constructor(
    readonly world: World,
    terms: QueryTerms,
  ) {
    const required = [...(terms.with ?? [])],
      excluded = [...(terms.without ?? [])],
      optional = [...(terms.optional ?? [])];
    if (!required.length || [...required, ...excluded, ...optional].some((component) => component.world !== world))
      throw new TypeError('Query needs components of this world; pass at least one in with');
    this.required = required;
    this.excluded = excluded;
    this.reads = [...required, ...optional];
    this.rows = new Int32Array(this.reads.length);
  }
  /** Fill the private match list; `world.query` does the intersection and the rows that fail `without` drop out. */
  private collect(): number {
    const { world, excluded } = this;
    if (this.matches.length < world.capacity) this.matches = new Uint32Array(world.capacity);
    const matches = this.matches,
      found = world.query(this.required, matches);
    if (!excluded.length) return found;
    let count = 0;
    for (let i = 0; i < found; i++) {
      const entity = matches[i];
      if (this.allowed(entity)) matches[count++] = entity;
    }
    return count;
  }
  private allowed(entity: Entity): boolean {
    const { excluded } = this;
    for (let j = 0; j < excluded.length; j++) if (excluded[j].index(entity) >= 0) return false;
    return true;
  }
  /**
   * Write the matching entities into caller-owned `output`; returns how many. Optional terms have no effect here.
   * @throws RangeError when `output` is too small (`world.capacity` entries always fit).
   * @throws MargoError `'state'` when called from this query's own `forEach`.
   */
  run(output: Uint32Array): number {
    this.enter();
    const count = this.collect();
    if (output.length < count)
      throw new RangeError(
        'Query output is too small; pass a Uint32Array at least as long as the entity count (world.capacity always fits)',
      );
    output.set(this.matches.subarray(0, count));
    return count;
  }
  /**
   * Call `visit` for each match with its rows: `rows[i]` is the row in the i-th `with` term, then the `optional` terms
   * in order, -1 for an optional term the entity lacks. `rows` is reused, so read it during the call.
   *
   * The match list is taken first, so `visit` may add, remove and destroy freely: rows are looked up just before each
   * call, and an entity that stopped matching meanwhile is passed over. Entities that start matching are not visited.
   * Returns the number of calls made.
   * @throws MargoError `'state'` when called from this query's own `forEach`; a second Query object may nest.
   */
  forEach(visit: (entity: Entity, rows: Int32Array) => void): number {
    this.enter();
    const { reads, rows, required } = this,
      width = required.length,
      found = this.collect(),
      matches = this.matches;
    let calls = 0;
    this.visiting = true;
    try {
      next: for (let i = 0; i < found; i++) {
        const entity = matches[i];
        for (let j = 0; j < reads.length; j++) {
          const row = reads[j].index(entity);
          if (row < 0 && j < width) continue next;
          rows[j] = row;
        }
        if (!this.allowed(entity)) continue;
        visit(entity, rows);
        calls++;
      }
    } finally {
      this.visiting = false;
    }
    return calls;
  }
  private enter(): void {
    if (this.visiting)
      throw new MargoError('state', 'Query is inside its own forEach; use a second Query for a nested loop');
  }
}
