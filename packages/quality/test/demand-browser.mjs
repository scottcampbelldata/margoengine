import assert from 'node:assert/strict';
import { openBrowser } from '../../../scripts/browser.js';
setTimeout(() => {
  console.error('demand GPU hard timeout');
  process.exit(124);
}, 120000).unref();
const context = await openBrowser({ startPath: '/packages/quality/test/ssaa-browser.html', port: 5227 });
try {
  for (const backend of ['webgpu', 'webgl2']) {
    await context.page.reload();
    const result = await context.page.evaluate(async (backend) => {
      globalThis.margoLow = 1;
      if (backend === 'webgl2') {
        const { install } = await import('/packages/webgl2-compat/dist/index.js');
        await install({ force: true });
      }
      const { Engine, box } = await import('/packages/core/dist/index.js');
      const { OrbitControls } = await import('/packages/controls/dist/orbit.js');
      const { renderOnDemand } = await import('/packages/quality/dist/demand.js');
      const engine = await Engine.create(document.querySelector('canvas'), { backend: 'webgpu' });
      engine.createMesh().setGeometry(box());
      const controls = OrbitControls.attach(engine);
      controls.enableDamping = true;
      let draws = 0;
      const original = engine.render.bind(engine);
      engine.render = (options) => {
        draws++;
        original(options);
      };
      let queued,
        time = 0;
      const loop = renderOnDemand(engine, {
        sources: [controls],
        request(callback) {
          queued = callback;
          return 1;
        },
        cancel() {
          queued = undefined;
        },
      });
      const frames = async (n) => {
        for (let i = 0; i < n; i++) {
          const callback = queued;
          queued = undefined;
          time += 1000 / 60;
          callback?.(time);
        }
        await engine.gpu.queue.onSubmittedWorkDone();
      };
      await frames(60);
      const idle = draws;
      await frames(5);
      const idleAfter = draws;
      controls.rotateLeft(0.3);
      controls.rotateUp(0.2);
      const before = [...engine.camera.position];
      loop.invalidate();
      // Deterministic virtual refreshes, not a timing budget on a loaded PC.
      await frames(1000);
      const moved = draws;
      await frames(5);
      const settled = draws;
      await loop.loaded(Promise.resolve());
      await frames(5);
      const loaded = draws;
      loop.dispose();
      controls.dispose();
      engine.dispose();
      return {
        idle,
        idleAfter,
        moved,
        settled,
        loaded,
        changed: before.some((v, i) => v !== engine.camera.position[i]),
      };
    }, backend);
    console.log(backend, result);
    assert.ok(result.idle >= 1);
    assert.equal(result.idle, result.idleAfter);
    assert.ok(result.moved > result.idle);
    assert.equal(result.moved, result.settled);
    assert.equal(result.loaded, result.moved + 1);
    assert.equal(result.changed, true);
  }
} finally {
  await context.close();
}
