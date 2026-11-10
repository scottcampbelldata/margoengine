import type { EnginePlugin } from '@margoengine/core/extension';
import type { Scene } from './internal.js';

// Attach to the enclosing Scene, not the Canvas's default scene. Keep ownership next to creation so a prop change
// or a late import cannot detach another mount's plugin.
export function attachBinding<T extends EnginePlugin>(scene: Scene, plugin: T): T {
  (scene.world ?? scene.engine).use(plugin);
  return plugin;
}
export function detachBinding(scene: Scene, plugin: EnginePlugin): void {
  const owner = scene.world ?? scene.engine;
  if (!scene.engine.disposed) owner.removePlugin(plugin.name);
  plugin.dispose?.();
}
