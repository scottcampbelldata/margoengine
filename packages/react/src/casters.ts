import { live, type Registry } from './internal.js';

// Every mounted `castShadow` mesh registry and model caster source, per engine, whether or not the Canvas shadows are
// on: `<AccumulativeShadows>` adds them to its own shadow catcher, `<ClusteredLighting shadows>` to its light maps.
const all = new WeakMap<object, Set<object>>();
export function casters(engine: object): Set<object> {
  let set = all.get(engine);
  if (!set) all.set(engine, (set = new Set()));
  return set;
}
const pbrSource = Symbol.for('margoengine.pbr-source.v1');
// A mesh drawn by <TextureMaterial> or another materials owner casts through its materials mesh (its own geometry is
// cleared); the materials mesh is re-added when the owner rebuilds it.
const target = (entry: object): object | null => {
  if (!('attachments' in entry)) return entry;
  const mesh = live(entry as Registry);
  return (mesh && (mesh as unknown as Record<symbol, object | undefined>)[pbrSource]) || mesh;
};
/** What `syncCasters` added: each registry entry with the engine object it casts through and its remover. */
export type AddedCasters = Map<object, { target: object; remove: () => void }>;
/**
 * Brings `added` in line with the Canvas's `castShadow` meshes and models: `add` takes each new one and returns its
 * remover, and an entry that left or whose mesh was recreated is removed. Its owner calls it every frame.
 */
export function syncCasters(engine: object, added: AddedCasters, add: (target: object) => () => void): void {
  const set = casters(engine);
  for (const [entry, was] of added)
    if (!set.has(entry) || target(entry) !== was.target) {
      was.remove();
      added.delete(entry);
    }
  for (const entry of set) {
    const t = target(entry);
    if (!t || added.has(entry)) continue;
    added.set(entry, { target: t, remove: add(t) });
  }
}
