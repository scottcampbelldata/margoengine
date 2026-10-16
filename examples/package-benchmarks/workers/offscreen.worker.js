// Core and packages on an OffscreenCanvas inside a module worker (offscreen.html posts the canvas; run.mjs drives it).
// Each step reports ok or its error, so one failure does not hide the rest.
import { Engine, box } from '/packages/core/dist/index.js';
import { loadGLTF } from '/packages/gltf-pro/dist/index.js';
import { loadGLTFInWorker } from '/packages/gltf-pro/dist/worker.js';
import { DracoDecoder } from '/packages/decoders/dist/index.js';
import { PostStack, FXAA, Bloom } from '/packages/post/dist/index.js';
import { Picking } from '/packages/selection/dist/index.js';

const steps = [],
  step = async (name, run) => {
    try {
      steps.push({ name, ok: true, value: (await run()) ?? null });
    } catch (error) {
      steps.push({ name, ok: false, error: String(error?.message ?? error) });
    }
  };
const frames = (n) =>
  new Promise((resolve) => {
    let i = 0;
    const tick = () => {
      if (++i >= n) resolve();
      else requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
self.onmessage = async ({ data }) => {
  const { canvas } = data;
  let engine, picked;
  await step('globals', () => ({
    window: typeof window,
    document: typeof document,
    devicePixelRatio: globalThis.devicePixelRatio ?? null,
    requestAnimationFrame: typeof requestAnimationFrame,
    gpu: !!navigator.gpu,
    ResizeObserver: typeof ResizeObserver,
  }));
  await step('Engine.create(OffscreenCanvas)', async () => {
    engine = await Engine.create(canvas, {
      backend: 'webgpu',
      capacity: 1024,
      camera: { position: [0, 2.5, 6], target: [0, 0.5, 0], near: 0.05, far: 100 },
    });
    return { backend: engine.backend, width: canvas.width, height: canvas.height };
  });
  if (!engine) {
    self.postMessage({ steps });
    return;
  }
  const errors = [];
  engine.gpu.addEventListener('uncapturederror', (e) => errors.push(e.error.message));
  await step('mesh + render()', () => {
    picked = engine
      .createMesh()
      .setGeometry(box(1, 1, 1))
      .setPosition([-1.6, 0.5, 0]);
    engine.render();
    return { width: canvas.width, height: canvas.height };
  });
  await step('start() requestAnimationFrame loop', async () => {
    engine.start();
    await frames(10);
    engine.stop();
    return { running: false };
  });
  await step('resize: set canvas.width/height (no clientWidth)', () => {
    canvas.width = 800;
    canvas.height = 450;
    engine.render();
    return { width: canvas.width, height: canvas.height };
  });
  await step('gltf-pro loadGLTF (fetch + createImageBitmap in a worker)', async () => {
    const model = await loadGLTF(engine, '/examples/assets/damaged-helmet.glb');
    model.root.setPosition([0.4, 0.9, 0]);
    engine.render();
    return { primitives: model.primitives.length };
  });
  await step('gltf-pro loadGLTFInWorker (nested worker)', async () => {
    const model = await loadGLTFInWorker(engine, '/examples/assets/damaged-helmet.glb');
    model.root.setPosition([2.2, 0.9, 0]).setScale([0.6, 0.6, 0.6]);
    engine.render();
    return { primitives: model.primitives.length };
  });
  await step('decoders DracoDecoder (nested worker pool)', async () => {
    const draco = new DracoDecoder();
    try {
      const model = await loadGLTF(engine, '/packages/decoders/tests/fixtures/Box.gltf', { decoders: { draco } });
      model.root.setPosition([-1.6, 1.6, 0]).setScale([0.6, 0.6, 0.6]);
      return { primitives: model.primitives.length };
    } finally {
      draco.dispose?.();
    }
  });
  await step('post PostStack [Bloom, FXAA]', () => {
    PostStack.attach(engine, [new Bloom({ strength: 0.4 }), new FXAA()]);
    engine.render();
    return { ok: true };
  });
  await step('core engine.pick (centre of the box)', async () => {
    const hit = await engine.pick(canvas.width * 0.5, canvas.height * 0.5);
    return { hit: hit ? hit.id : null };
  });
  await step('selection Picking', async () => {
    const picking = Picking.attach(engine);
    try {
      const hit = await picking.pick(canvas.width * 0.5, canvas.height * 0.5);
      return { hit: !!hit };
    } finally {
      picking.dispose();
    }
  });
  await frames(3);
  engine.render();
  await engine.gpu.queue.onSubmittedWorkDone();
  steps.push({ name: 'GPU errors', ok: !errors.length, value: errors });
  self.postMessage({ steps });
};
