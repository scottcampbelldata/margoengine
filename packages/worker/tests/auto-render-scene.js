import { box, Engine, PbrMaterial } from '/packages/core/dist/index.js';
import { webglRenderer } from '/packages/webgl2-compat/dist/preview.js';

export async function createScene({ canvas, data, signal, mode, attach }) {
  if (data.failInWorker && mode === 'worker') throw new Error('scene startup deliberately failed');
  const engine = await Engine.create(canvas, {
    backend: data.backend,
    fallback: webglRenderer,
    camera: { position: [0, 0, 3], target: [0, 0, 0] },
    exactSize: true,
  });
  attach(engine);
  engine
    .createMesh()
    .setGeometry(box())
    .setMaterial(new PbrMaterial({ color: '#ff2000' }));
  engine.start();
  engine.render({ delta: 0 });
  if (data.backend === 'webgpu' && (await engine.pick(64, 64))?.id !== 0)
    throw new Error('shared scene did not render and pick its box');
  await new Promise((resolve) => requestAnimationFrame(resolve));
  if (mode === 'page') canvas.dataset.sceneMode = mode;
  signal.addEventListener(
    'abort',
    () => {
      if (mode === 'page') canvas.dataset.sceneAborted = 'true';
    },
    { once: true },
  );
  return engine;
}
