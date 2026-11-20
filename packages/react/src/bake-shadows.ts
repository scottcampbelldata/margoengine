import { useEffect, useSyncExternalStore } from 'react';
import { useScene, type Scene } from './internal.js';

interface Bake {
  count: number;
  listeners: Set<() => void>;
}
// Per Canvas engine: every Scene of one Canvas shares its shadows, and so its bake.
const bakes = new WeakMap<object, Bake>();
function bakeOf(scene: Scene): Bake {
  let bake = bakes.get(scene.engine);
  if (!bake) bakes.set(scene.engine, (bake = { count: 0, listeners: new Set() }));
  return bake;
}
/** Whether a `<BakeShadows>` is mounted on this Canvas: shadow casters added now should be static. */
export function useBakedShadows(): boolean {
  const bake = bakeOf(useScene());
  return useSyncExternalStore(
    (listener) => {
      bake.listeners.add(listener);
      return () => bake.listeners.delete(listener);
    },
    () => bake.count > 0,
    () => false,
  );
}
/**
 * Bakes the Canvas shadows while mounted, as drei's `<BakeShadows>`: every caster (`castShadow` meshes, shapes,
 * models and batches) becomes a static caster of `@margoengine/shadows`, drawn into its still map once and not again
 * each frame, so a scene that does not move pays nothing for its shadows. Casters that move later keep the shadow they
 * had; the map still re-renders when the cascades follow the camera or the light turns. Unmounting it makes them
 * dynamic again. Use it with `<Shadows>`.
 */
export function BakeShadows(): null {
  const scene = useScene();
  useEffect(() => {
    const bake = bakeOf(scene),
      notify = () => {
        for (const listener of [...bake.listeners]) listener();
      };
    bake.count++;
    notify();
    return () => {
      bake.count--;
      notify();
    };
  }, [scene]);
  return null;
}
