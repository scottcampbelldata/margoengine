// Every mounted `castShadow` mesh registry and model caster source, per engine, whether or not the Canvas shadows are
// on: `<AccumulativeShadows>` adds them to its own shadow catcher.
const all = new WeakMap<object, Set<object>>();
export function casters(engine: object): Set<object> {
  let set = all.get(engine);
  if (!set) all.set(engine, (set = new Set()));
  return set;
}
