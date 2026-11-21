import type { Scene } from './internal.js';
import { sceneScope } from '../../shared/scene-scope.js';

/** The scene plugins of this binding join and leave: the enclosing `<Scene>`'s world, else the engine's default scene. */
export const sceneOwner = (scene: Scene) => scene.world ?? scene.engine;
/** Runs `work` with the enclosing scene active, so a plugin it attaches (`X.attach(engine)`) joins that scene. */
export function inScene<T>(scene: Scene, work: () => T): T {
  return sceneScope(scene.engine, scene.world ?? undefined).run(work);
}
