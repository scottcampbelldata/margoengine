// The device-restore and dispose steps every PostStack effect that owns GPU resources shares: on a restore the effect
// releases, forgets its engine and sets up again; on dispose it leaves the scene, then releases.
export function restoreEffect(effect, engine) {
  effect.release();
  effect.engine = undefined;
  effect.setup(engine);
}
// Returns false when the effect was already disposed (so the caller stops), otherwise marks it disposed, detaches
// it from its scene and releases its GPU resources.
export function retireEffect(effect) {
  if (effect.disposed) return false;
  effect.disposed = true;
  const engine = effect.engine;
  effect.engine = undefined;
  engine?.sceneOf(effect)?.removePlugin(effect.name);
  effect.release();
  return true;
}
