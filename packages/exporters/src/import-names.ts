// Node and clip naming conventions that engine importers read from a glTF file: Godot's collision suffixes (also
// honoured by the Unity import profile) and the `-loop` clip token. Strings only; no scene or file is touched.

/** A collision suffix: `-col` (mesh plus concave body), `-convcol` (mesh plus convex body), `-colonly` (concave body,
 * no mesh) or `-convcolonly` (convex body, no mesh). */
export type CollisionTag = 'col' | 'convcol' | 'colonly' | 'convcolonly';

const TAGS: readonly CollisionTag[] = ['col', 'convcol', 'colonly', 'convcolonly'];
const SUFFIX = /-(convcolonly|convcol|colonly|col)$/i;
const LOOP_HEAD = /^(?:loop|cycle)(?:[-_$\s]+|$)/i;
const LOOP_TAIL = /(?:[-_$\s]+|^)(?:loop|cycle)$/i;

const text = (value: unknown, label: string): string => {
  if (typeof value !== 'string') throw new TypeError(`${label} must be a string`);
  return value;
};

/** The collision suffix at the end of a node name, case-insensitive, or null when it has none. */
export function collisionTag(name: string): CollisionTag | null {
  return (SUFFIX.exec(text(name, 'Node name'))?.[1].toLowerCase() as CollisionTag | undefined) ?? null;
}

/** `name` without any collision suffixes (repeated ones included). */
export function collisionBase(name: string): string {
  let base = text(name, 'Node name');
  while (SUFFIX.test(base)) base = base.replace(SUFFIX, '');
  return base;
}

/**
 * `name` with its collision suffixes replaced by `tag`, or removed for null.
 * @throws TypeError for a tag other than `col`, `convcol`, `colonly`, `convcolonly` or null.
 */
export function withCollisionTag(name: string, tag: CollisionTag | null): string {
  if (tag !== null && !TAGS.includes(tag))
    throw new TypeError("Collision tag must be 'col', 'convcol', 'colonly', 'convcolonly' or null");
  const base = collisionBase(name);
  return tag === null ? base : `${base}-${tag}`;
}

/**
 * A clip name for importers that loop clips by name: the leading and trailing `loop` and `cycle` tokens (with any
 * `-`, `_`, `$` or space separator) are removed, then `-loop` is appended when `loop` is true. An empty result
 * becomes `fallback`.
 */
export function clipImportName(name: string, loop: boolean, fallback = 'Animation'): string {
  if (typeof loop !== 'boolean') throw new TypeError('loop must be a boolean');
  let base = text(name, 'Clip name').trim(),
    previous = '';
  while (base !== previous) {
    previous = base;
    base = base.replace(LOOP_HEAD, '').replace(LOOP_TAIL, '').trim();
  }
  base ||= text(fallback, 'fallback');
  return loop ? `${base}-loop` : base;
}
