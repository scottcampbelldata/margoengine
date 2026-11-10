import type { Mesh, Scene } from '@margoengine/core';
import { rangeError, typeError } from '../../shared/errors.js';
import { find } from './graph.js';
import { tagState } from './tag-state.js';

export { SceneEvents } from './lifecycle.js';
export type { SceneEvent, SceneEventType, SceneListenerOptions } from './lifecycle.js';

/** A tag or an AND group. Multiple arguments to has/findByTag are OR alternatives. */
export type TagQuery = string | readonly string[];

/** Tag mutation event. `tag` is null for the final change event of a batch. */
export class TagChangeEvent extends Event {
  constructor(type: 'add' | 'remove' | 'change', public readonly mesh: Mesh, public readonly tag: string | null) { super(type); }
}

const names = (input: readonly TagQuery[]): string[] => {
  const flat = input.flatMap((value) => typeof value === 'string' ? [value] : Array.isArray(value) ? [...value] : [value]);
  if (flat.some((name) => typeof name !== 'string' || !name.length))
    throw typeError('tags: supply nonempty string tags or arrays', 'arguments');
  return flat as string[];
};
const sets = new WeakMap<Mesh, TagSet>();

/** A mesh's unique string tags, with DOM add/remove/change events and AbortSignal listener support. */
export class TagSet extends EventTarget {
  constructor(private readonly mesh: Mesh) { super(); }
  private values(): Set<string> {
    this.mesh.check();
    let values = tagState.get(this.mesh);
    if (!values) tagState.set(this.mesh, values = new Set());
    return values;
  }
  /** Number of unique tags. */
  get size(): number { return this.values().size; }
  /** Snapshot in insertion order. */
  list(): string[] { return [...this.values()]; }
  /** Add unique tags; returns whether the set changed. Validates the whole input before mutation. */
  add(...input: TagQuery[]): boolean { return this.mutate('add', names(input)); }
  /** Remove tags; returns whether the set changed. */
  remove(...input: TagQuery[]): boolean { return this.mutate('remove', names(input)); }
  /** Remove all tags. */
  clear(): void { this.mutate('remove', this.list()); }
  /** OR of string tags and AND groups; no alternatives or an empty group matches nothing. */
  has(...query: TagQuery[]): boolean {
    names(query);
    const values = this.values();
    return query.some((group) => typeof group === 'string' ? values.has(group) : group.length > 0 && group.every((tag) => values.has(tag)));
  }
  private mutate(type: 'add' | 'remove', input: string[]): boolean {
    const values = this.values(), changed: string[] = [];
    for (const tag of input) {
      if (type === 'add' ? !values.has(tag) : values.has(tag)) {
        if (type === 'add') values.add(tag); else values.delete(tag);
        changed.push(tag);
      }
    }
    for (const tag of changed) this.dispatchEvent(new TagChangeEvent(type, this.mesh, tag));
    if (changed.length) this.dispatchEvent(new TagChangeEvent('change', this.mesh, null));
    return changed.length > 0;
  }
}

/** Stable TagSet for a live mesh. Importing the entry changes no mesh or engine. */
export function tags(mesh: Mesh): TagSet {
  mesh.check();
  let result = sets.get(mesh);
  if (!result) sets.set(mesh, result = new TagSet(mesh));
  return result;
}

/** Inclusive depth-first tag query: OR between arguments, AND within arrays. */
export function findByTag(target: Mesh | Scene, ...query: TagQuery[]): Mesh[] {
  names(query);
  return find(target, (mesh) => tags(mesh).has(...query));
}

type Predicate = (values: ReadonlySet<string>) => boolean;
const compile = (expression: string): Predicate => {
  if (typeof expression !== 'string') throw typeError('tags query: supply a string expression', 'arguments');
  if (expression.length > 16384) throw rangeError('tags query: use at most 16384 characters', 'arguments');
  if (!expression.trim()) return () => true;
  const tokens: { value: string; literal: boolean; constant?: boolean }[] = [];
  let at = 0;
  const invalid = () => typeError('tags query: use tags, !, &&, || and balanced parentheses or quoted tags', 'arguments');
  while (at < expression.length) {
    if (/\s/.test(expression[at])) { at++; continue; }
    const rest = expression.slice(at), op = /^(\!|&&|\|\||\(|\))/.exec(rest);
    if (op) { tokens.push({ value: op[0], literal: false }); at += op[0].length; continue; }
    const quote = expression[at];
    if (quote === '"' || quote === "'") {
      let value = '', closed = false;
      at++;
      while (at < expression.length) {
        const c = expression[at++];
        if (c === quote) { closed = true; break; }
        if (c === '\\') { if (at === expression.length) throw invalid(); value += expression[at++]; }
        else value += c;
      }
      if (!closed || !value.length) throw invalid();
      tokens.push({ value, literal: true }); continue;
    }
    const tag = /^[^\s!&|()'"]+/.exec(rest);
    if (!tag) throw invalid();
    tokens.push({ value: tag[0], literal: true,
      constant: tag[0] === 'true' ? true : tag[0] === 'false' ? false : undefined }); at += tag[0].length;
  }
  let position = 0;
  const take = (token: string) => tokens[position]?.value === token && !tokens[position].literal;
  const atom = (depth: number): Predicate => {
    if (depth > 64) throw rangeError('tags query: use at most 64 nested operators', 'arguments');
    if (take('!')) { position++; const inner = atom(depth + 1); return (values) => !inner(values); }
    if (take('(')) {
      position++; const inner = or(depth + 1);
      if (!take(')')) throw invalid(); position++; return inner;
    }
    const token = tokens[position++];
    if (!token?.literal) throw invalid();
    return token.constant === undefined ? (values) => values.has(token.value) : () => token.constant!;
  };
  const and = (depth: number): Predicate => {
    const terms = [atom(depth)];
    while (take('&&')) { position++; terms.push(atom(depth)); }
    return (values) => terms.every((term) => term(values));
  };
  const or = (depth: number): Predicate => {
    const terms = [and(depth)];
    while (take('||')) { position++; terms.push(and(depth)); }
    return (values) => terms.some((term) => term(values));
  };
  const result = or(0);
  if (position !== tokens.length) throw invalid();
  return result;
};
const empty = new Set<string>();

/** Boolean expression query with !, &&, ||, parentheses and single/double quoted tags. Empty expression matches all. */
export function matchesTags(mesh: Mesh, expression: string): boolean {
  mesh.check();
  return compile(expression)(tagState.get(mesh) ?? empty);
}

/** Compile one expression and collect matching meshes, inclusive depth-first. No eval or dynamic code generation. */
export function queryTags(target: Mesh | Scene, expression: string): Mesh[] {
  const predicate = compile(expression);
  return find(target, (mesh) => predicate(tagState.get(mesh) ?? empty));
}
