/** Shared complementary screen-space threshold for mesh and imposter LOD transitions (Jimenez 2014). */
export const fadeTest = `fn lod_fade_keep(lod_at:vec2f,lod_f:f32)->bool {let d=fract(52.9829189*fract(dot(floor(lod_at),vec2f(0.06711056,0.00583715))));if(lod_f>0.0){return d<lod_f;}return lod_f==0.0||d>=-lod_f;}`;

type StandIn = (from: object, to: object) => void;
const standIns = new WeakMap<object, Set<StandIn>>();
/**
 * Calls `listener` whenever something of `engine` starts to draw in place of something else: a cross-fade's incoming
 * level for its outgoing one, or the ghost that keeps an old geometry on screen for its mesh. Each is a core mesh or a
 * model. Returns the remover.
 */
export function onStandIn(engine: object, listener: StandIn): () => void {
  let set = standIns.get(engine);
  if (!set) standIns.set(engine, (set = new Set()));
  set.add(listener);
  return () => void set.delete(listener);
}
/** Tells `engine`'s listeners that `to` now draws in place of `from`. */
export function standIn(engine: object, from: object, to: object): void {
  for (const listener of standIns.get(engine) ?? []) listener(from, to);
}
