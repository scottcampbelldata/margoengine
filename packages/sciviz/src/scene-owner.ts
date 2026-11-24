// A figure's plugins live in the scene its renderer was added to. A plugin the figure adds later (the lines and points
// plugins, labels, the depth capture) is made after a promise has settled, when the engine's active scene is the default
// one again, so `Lines.attach(engine)` there would join the wrong scene and outlive the scene that owns the figure.
import type { Engine, EnginePlugin } from '@margoengine/core/extension';

let serial = 0;

/**
 * Runs `make` (which calls `X.attach(engine)` or `engine.use(plugin)`) with the scene `owner` lives in as the active
 * scene. In the engine's own scene, or for an engine that has no scenes (a test double), it just runs `make`.
 */
export function inSceneOf<T>(engine: unknown, owner: EnginePlugin, make: () => T): T {
  const runtime = engine as Engine;
  const scene = runtime.sceneOf?.(owner);
  if (!scene || scene === runtime.scene) return make();
  // The scene is active while a plugin's `setup` runs: a short-lived plugin is the scene's way to run code in it.
  let made: { value: T } | undefined;
  const scope: EnginePlugin = {
    name: `sciviz-scene-scope:${serial++}`,
    setup() {
      made = { value: make() };
    },
    dispose() {},
  };
  runtime.use(scope, scene);
  runtime.removePlugin(scope.name, scene);
  return (made as { value: T }).value;
}
