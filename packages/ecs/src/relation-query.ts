import { MargoError } from '@margoengine/math/errors';
import type { Component, Entity, World } from './index.js';
import type { Relation } from './relations.js';

/** A required pair and optional required components on its target. */
export interface RelationTerm {
  /** Relationship owned by this world. */
  relation: Relation;
  /** Exact target id, or '*' for every target. Default '*'. */
  target?: Entity | '*';
  /** Components required on the target, with rows returned in term order. Default none. */
  with?: readonly Component[];
}
/** Source component filters and required relationship pairs. */
export interface RelationQueryTerms {
  /** Required pair terms; at least one. Wildcards enumerate every combination. */
  relations: readonly RelationTerm[];
  /** Required source components. Default none. */
  with?: readonly Component[];
  /** Excluded source components. Default none. */
  without?: readonly Component[];
  /** Optional source components; rows use -1 when absent. Default none. */
  optional?: readonly Component[];
}

/** A relation join query returning source rows, matched targets and target component rows. */
export class RelationQuery {
  private readonly terms: RelationQueryTerms;
  private visiting = false;
  /** @throws TypeError for empty relation terms, invalid targets or foreign-world terms. */
  constructor(
    readonly world: World,
    terms: RelationQueryTerms,
  ) {
    const relations = terms.relations.map((t) => ({ ...t, with: [...(t.with ?? [])] }));
    const required = [...(terms.with ?? [])],
      excluded = [...(terms.without ?? [])],
      optional = [...(terms.optional ?? [])];
    if (
      !relations.length ||
      relations.some(
        (t) =>
          t.relation.world !== world ||
          (t.target !== undefined &&
            t.target !== '*' &&
            (!Number.isInteger(t.target) || t.target < 0 || t.target > 0xffffffff)),
      ) ||
      [...required, ...excluded, ...optional, ...relations.flatMap((t) => t.with)].some((c) => c.world !== world)
    )
      throw new TypeError(
        'Invalid relation query; use at least one relation and components of this world with Uint32 targets or *',
      );
    this.terms = { relations, with: required, without: excluded, optional };
  }
  private allowed(source: Entity, targets?: readonly Entity[]): boolean {
    const t = this.terms;
    return (
      this.world.alive(source) &&
      t.with!.every((c) => c.has(source)) &&
      t.without!.every((c) => !c.has(source)) &&
      (!targets ||
        t.relations.every(
          (term, i) =>
            this.world.alive(targets[i]) &&
            term.relation.has(source, targets[i]) &&
            term.with!.every((c) => c.has(targets[i])),
        ))
    );
  }
  private collect(): { source: Entity; targets: Entity[] }[] {
    if (this.visiting)
      throw new MargoError('state', 'Relation query is visiting; use a second query for a nested call');
    const maps = this.terms.relations.map((term) => {
      const map = new Map<Entity, Entity[]>();
      term.relation.forEach((source, target) => {
        if (
          (term.target === undefined || term.target === '*' || term.target === target) &&
          term.with!.every((c) => c.has(target))
        ) {
          const list = map.get(source);
          if (list) list.push(target);
          else map.set(source, [target]);
        }
      });
      return map;
    });
    const matches: { source: Entity; targets: Entity[] }[] = [];
    for (const source of maps[0].keys()) {
      if (!this.allowed(source) || maps.some((m) => !m.has(source))) continue;
      // Iterative product has no recursion limit for many pair terms.
      let products: Entity[][] = [[]];
      for (const map of maps)
        products = products.flatMap((prefix) => map.get(source)!.map((target) => [...prefix, target]));
      for (const targets of products) matches.push({ source, targets });
    }
    return matches;
  }
  /**
   * Write sources (repeated for each matching pair combination) and optional target columns.
   * @throws RangeError when any output is too small, or target column count differs from the term count.
   */
  run(output: Uint32Array, targets?: readonly Uint32Array[]): number {
    const matches = this.collect();
    if (
      output.length < matches.length ||
      (targets && (targets.length !== this.terms.relations.length || targets.some((t) => t.length < matches.length)))
    )
      throw new RangeError(
        'Relation query output is too small; allocate one row per pair combination and one target column per term',
      );
    matches.forEach((m, row) => {
      output[row] = m.source;
      targets?.forEach((column, i) => {
        column[row] = m.targets[i];
      });
    });
    return matches.length;
  }
  /**
   * Visit snapshot matches, rechecking membership and resolving current rows before each call.
   * Source rows are with then optional. Target rows flatten each relation term's with list.
   * Callback arrays are reused. Added pairs wait for the next call; removed pairs are passed over.
   * @throws MargoError 'state' for a nested call on this query.
   */
  forEach(visit: (source: Entity, rows: Int32Array, targets: Uint32Array, targetRows: Int32Array) => void): number {
    const matches = this.collect(),
      reads = [...this.terms.with!, ...this.terms.optional!];
    const rows = new Int32Array(reads.length),
      targets = new Uint32Array(this.terms.relations.length);
    const targetRows = new Int32Array(this.terms.relations.reduce((n, t) => n + t.with!.length, 0));
    let count = 0;
    this.visiting = true;
    try {
      for (const match of matches) {
        if (!this.allowed(match.source, match.targets)) continue;
        reads.forEach((c, i) => {
          rows[i] = c.index(match.source);
        });
        targets.set(match.targets);
        let at = 0;
        this.terms.relations.forEach((t, i) => {
          for (const c of t.with!) targetRows[at++] = c.index(targets[i]);
        });
        visit(match.source, rows, targets, targetRows);
        count++;
      }
    } finally {
      this.visiting = false;
    }
    return count;
  }
}
