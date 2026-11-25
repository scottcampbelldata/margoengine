// Owner/lifetime fixture for @margoengine/headless. What headless owns on a device is the texture of its stand-in canvas
// context (createHeadlessCanvas) and the readback buffer of each readPixels call. The harness watches the GPU objects of
// its own engines, so both are made on the harness engine's device, in the owner's scope, and tied to a plugin
// registration (ownedByEngine) that releases them the way a scene or engine disposal does:
// - HeadlessContext: configure, draw target, resize (the old texture must be destroyed), unconfigure on release.
// - readPixels: a read of that context's frame; its buffer must be gone when the promise settles.
// - readPixels.abort: a read stopped by its signal; the buffer and the abort listener must be gone when it rejects.
// The engine handed to readPixels is the harness engine seen with the stand-in canvas: readPixels reads only the
// engine's `canvas` and `gpu`. createHeadlessStage makes an engine of its own, which no harness device watches; its
// registration and the shared GPU installation are covered by tests/stage.test.js.
import { ownedByEngine, lifetimeFault } from '../../../tests/support/owner-shell.js';

export async function fixtures(load = (entry) => import(entry)) {
  const { createHeadlessCanvas, readPixels } = await load('../dist/index.js');
  // A canvas context configured on the harness device, its texture made; `release` unconfigures it, safe to repeat.
  const context = (engine, width, height) => {
    const canvas = createHeadlessCanvas({ width, height }),
      gpu = canvas.getContext('webgpu');
    gpu.configure({ device: engine.gpu, format: 'rgba8unorm', alphaMode: 'premultiplied' });
    const texture = gpu.getCurrentTexture();
    if (texture.width !== width || texture.height !== height)
      lifetimeFault('headless canvas texture has the wrong size');
    const view = new Proxy(engine, { get: (target, key) => (key === 'canvas' ? canvas : Reflect.get(target, key)) });
    return { canvas, gpu, texture, view, release: () => gpu.unconfigure() };
  };
  return [
    {
      name: 'HeadlessContext',
      create({ engine, scene }) {
        const made = context(engine, 8, 4);
        made.canvas.width = 6;
        if (made.gpu.getCurrentTexture() === made.texture) lifetimeFault('a resized headless canvas kept its texture');
        return ownedByEngine(scene, 'HeadlessContext', made.release);
      },
    },
    {
      name: 'readPixels',
      async create({ engine, scene }) {
        const made = context(engine, 4, 2);
        const pixels = await readPixels(made.view, { signal: new AbortController().signal });
        if (pixels.width !== 4 || pixels.height !== 2 || pixels.data.length !== 32)
          lifetimeFault('readPixels gave the wrong size');
        return ownedByEngine(scene, 'readPixels', made.release);
      },
    },
    {
      name: 'readPixels.abort',
      async create({ engine, scene }) {
        const made = context(engine, 4, 2),
          stop = new AbortController(),
          reading = readPixels(made.view, { signal: stop.signal });
        stop.abort(new Error('stopped'));
        const outcome = await reading.then(
          () => 'read',
          (error) => error?.message,
        );
        // The map may finish before the abort is seen; either way nothing may stay behind.
        if (outcome !== 'read' && outcome !== 'stopped') lifetimeFault(`readPixels.abort rejected with ${outcome}`);
        return ownedByEngine(scene, 'readPixels.abort', made.release);
      },
    },
  ];
}
