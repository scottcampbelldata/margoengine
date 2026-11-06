/// <reference lib="esnext.disposable" />
import type { Entity, World } from './index.js';

/** Rules of a {@link Relation}. For parent and child use all three: `{exclusive: true, cascade: true, acyclic: true}`. */
export interface RelationOptions {
  /** A source has at most one target: a new pair replaces the old one. Default false. */
  exclusive?: boolean;
  /** Destroying a target destroys its sources, and theirs, all the way down. Default false: only the pairs end. */
  cascade?: boolean;
  /** Refuse a pair that would close a loop. Default false. */
  acyclic?: boolean;
}

const copy = (set: Set<Entity> | undefined, output: Uint32Array): number => {
  if (!set) return 0;
  if (output.length < set.size)
    throw new RangeError(
      'Relation output is too small; pass a Uint32Array at least as long as the entity count (world.capacity always fits)',
    );
  let count = 0;
  for (const entity of set) output[count++] = entity;
  return count;
};

/**
 * Pairs of entities with a meaning you name: `childOf`, `owns`, `targets`. A pair goes from a source to a target, and
 * both directions can be read directly. Pairs of a destroyed entity end with it.
 */
export class Relation {
  /** Pairs held now. */
  size = 0;
  /** True when a source has at most one target. */
  readonly exclusive: boolean;
  /** True when destroying a target destroys its sources. */
  readonly cascade: boolean;
  /** True when pairs that close a loop are refused. */
  readonly acyclic: boolean;
  private readonly forward = new Map<Entity, Set<Entity>>();
  private readonly backward = new Map<Entity, Set<Entity>>();
  private readonly pending: Entity[] = [];
  private draining = false;
  private readonly store = { remove: (entity: Entity) => this.forget(entity) };
  constructor(
    readonly world: World,
    { exclusive = false, cascade = false, acyclic = false }: RelationOptions = {},
  ) {
    this.exclusive = exclusive;
    this.cascade = cascade;
    this.acyclic = acyclic;
    world.attach(this.store);
  }
  /**
   * Add the pair; false when it already exists. On an exclusive relation it replaces the source's old pair.
   * @throws MargoError `'state'` when either entity is stale or destroyed.
   * @throws TypeError on an acyclic relation when the pair would close a loop; nothing changes.
   */
  add(source: Entity, target: Entity): boolean {
    this.world.check(source);
    this.world.check(target);
    if (this.has(source, target)) return false;
    if (this.acyclic && this.reaches(target, source))
      throw new TypeError('Relation pair would close a loop; remove a pair first, or drop the acyclic option');
    if (this.exclusive) {
      const old = this.forward.get(source);
      if (old) for (const previous of old) this.remove(source, previous);
    }
    this.link(this.forward, source, target);
    this.link(this.backward, target, source);
    this.size++;
    return true;
  }
  /** End the pair; false when there is none. Neither entity is destroyed. */
  remove(source: Entity, target: Entity): boolean {
    if (!this.has(source, target)) return false;
    this.unlink(this.forward, source, target);
    this.unlink(this.backward, target, source);
    this.size--;
    return true;
  }
  /** True when the pair exists. */
  has(source: Entity, target: Entity): boolean {
    return this.forward.get(source)?.has(target) ?? false;
  }
  /** The first target of `source`, the only one on an exclusive relation (a child's parent); undefined when it has none. */
  target(source: Entity): Entity | undefined {
    const set = this.forward.get(source);
    if (set) for (const target of set) return target;
    return undefined;
  }
  /**
   * Write what `source` points at into `output`, oldest pair first; returns how many.
   * @throws RangeError when `output` is too small (`world.capacity` entries always fit).
   */
  targets(source: Entity, output: Uint32Array): number {
    return copy(this.forward.get(source), output);
  }
  /**
   * Write what points at `target` into `output`, oldest pair first (a parent's children); returns how many.
   * @throws RangeError when `output` is too small (`world.capacity` entries always fit).
   */
  sources(target: Entity, output: Uint32Array): number {
    return copy(this.backward.get(target), output);
  }
  /**
   * Write everything below `target`, breadth first (nearest first): its sources, their sources and so on, without
   * `target` itself and each entity once, even in a loop; returns how many.
   * @throws RangeError when `output` is too small (`world.capacity` entries always fit).
   */
  descendants(target: Entity, output: Uint32Array): number {
    const seen = new Set<Entity>([target]);
    let count = 0;
    for (let at = -1; at < count; at++) {
      const set = this.backward.get(at < 0 ? target : output[at]);
      if (!set) continue;
      for (const entity of set) {
        if (seen.has(entity)) continue;
        seen.add(entity);
        if (count === output.length)
          throw new RangeError(
            'Relation output is too small; pass a Uint32Array at least as long as the entity count (world.capacity always fits)',
          );
        output[count++] = entity;
      }
    }
    return count;
  }
  /** Call `visit` for every pair. Pairs added during the loop may or may not be visited. */
  forEach(visit: (source: Entity, target: Entity) => void): void {
    for (const [source, targets] of this.forward) for (const target of targets) visit(source, target);
  }
  /** End every pair and stop following the world. Safe to call twice. */
  stop(): void {
    this.world.detach(this.store);
    this.forward.clear();
    this.backward.clear();
    this.size = 0;
  }
  declare [Symbol.dispose]: () => void;
  [(Symbol.dispose ?? Symbol()) as symbol](): void {
    this.stop();
  }
  private link(map: Map<Entity, Set<Entity>>, from: Entity, to: Entity): void {
    const set = map.get(from);
    if (set) set.add(to);
    else map.set(from, new Set([to]));
  }
  private unlink(map: Map<Entity, Set<Entity>>, from: Entity, to: Entity): void {
    const set = map.get(from) as Set<Entity>;
    set.delete(to);
    if (!set.size) map.delete(from);
  }
  /** True when walking targets from `from` arrives at `goal`, `from` itself included. */
  private reaches(from: Entity, goal: Entity): boolean {
    const seen = new Set<Entity>([from]),
      stack = [from];
    while (stack.length) {
      const entity = stack.pop() as Entity;
      if (entity === goal) return true;
      for (const next of this.forward.get(entity) ?? [])
        if (!seen.has(next)) {
          seen.add(next);
          stack.push(next);
        }
    }
    return false;
  }
  /** The world is destroying `entity`. Cascades run from a list, so a deep hierarchy cannot overflow the call stack. */
  private forget(entity: Entity): void {
    for (const target of [...(this.forward.get(entity) ?? [])]) this.remove(entity, target);
    for (const source of [...(this.backward.get(entity) ?? [])]) {
      this.remove(source, entity);
      if (this.cascade) this.pending.push(source);
    }
    if (this.draining) return;
    this.draining = true;
    try {
      while (this.pending.length) {
        const next = this.pending.pop() as Entity;
        if (this.world.alive(next)) this.world.destroy(next);
      }
    } finally {
      this.draining = false;
      this.pending.length = 0;
    }
  }
}
