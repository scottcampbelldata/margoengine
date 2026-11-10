import { Engine, box, PbrMaterial } from '@margoengine/core';
import { installCompat } from '@margoengine/webgl2-compat/device';
import type { SceneContext } from '@margoengine/worker/auto';
/** Test-only scene: the same native engine setup on page and worker. */
export async function createScene({ canvas, data, attach }: SceneContext) {
  Object.assign(globalThis, { margoLow: 1 });
  const settings = data as { compat: boolean; color: string };
  if (settings.compat && !(globalThis as { __margoCompat?: boolean }).__margoCompat) {
    await installCompat({ force: true });
  }
  const engine = await Engine.create(canvas, { backend: 'webgpu', exactSize: true, camera: { position: [0, 0, 3], target: [0, 0, 0] } });
  attach(engine);
  engine.createMesh().setGeometry(box()).setMaterial(new PbrMaterial({ color: settings.color }));
  engine.start();
  engine.render({ delta: 0 });
  if ((await engine.pick(64, 64))?.id !== 0) throw new Error('Shared scene did not render and pick its box');
  return engine;
}
