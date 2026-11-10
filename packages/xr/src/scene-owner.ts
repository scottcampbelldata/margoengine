import type { Scene } from '@margoengine/core';
let serial = 0;
/** Bind an XR subscription to an explicitly selected scene without changing the ambient scene. */
export function ownScene(scene: Scene, close: () => void): () => void {
  const name = `xr-subscription-${serial++}`;
  scene.use({ name, setup() {}, dispose: close });
  return () => scene.removePlugin(name);
}
