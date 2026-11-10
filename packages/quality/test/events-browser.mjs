import assert from 'node:assert/strict';
import { openBrowser } from '../../../scripts/browser.js';
setTimeout(() => {
  console.error('adaptive events GPU hard timeout');
  process.exit(124);
}, 120000).unref();
const context = await openBrowser({ startPath: '/packages/quality/test/ssaa-browser.html', port: 5228 });
try {
  for (const backend of ['webgpu', 'webgl2']) {
    await context.page.reload();
    const result = await context.page.evaluate(async (backend) => {
      if (backend === 'webgl2') {
        const { install } = await import('/packages/webgl2-compat/dist/index.js');
        await install({ force: true });
      }
      globalThis.margoLow = 1;
      const { Engine, box } = await import('/packages/core/dist/index.js');
      const { adaptiveEvents } = await import('/packages/quality/dist/events.js');
      const engine = await Engine.create(document.querySelector('canvas'), {
        backend: 'webgpu',
        camera: { position: [0, 0, 5], target: [0, 0, 0] },
      });
      const mesh = engine.createMesh().setGeometry(box(2, 2, 2));
      engine.render();
      const source = new EventTarget();
      let calls = 0,
        active = 0,
        maximum = 0;
      const errors = [];
      engine.gpu.addEventListener('uncapturederror', (event) => errors.push(event.error.message));
      const events = adaptiveEvents(
        async (x, y) => {
          calls++;
          active++;
          maximum = Math.max(maximum, active);
          try {
            return await engine.pick(x, y);
          } finally {
            active--;
          }
        },
        { sources: [source], interval: Infinity, debounce: 10000 },
      );
      source.dispatchEvent(new Event('change'));
      const pending = [];
      for (let i = 0; i < 200; i++)
        pending.push(events.run(i === 199 ? engine.canvas.width / 2 : 0, i === 199 ? engine.canvas.height / 2 : 0));
      const movingCalls = calls;
      events.setMoving(false);
      const hits = await Promise.all(pending);
      const settledCalls = calls;
      const direct = await events.run(engine.canvas.width / 2, engine.canvas.height / 2);
      events.dispose();
      await engine.gpu.queue.onSubmittedWorkDone();
      engine.dispose();
      return {
        movingCalls,
        settledCalls,
        calls,
        maximum,
        allHit: hits.every((hit) => hit === mesh),
        direct: direct === mesh,
        errors,
      };
    }, backend);
    console.log(backend, result);
    assert.equal(result.movingCalls, 0);
    assert.equal(result.settledCalls, 1);
    assert.equal(result.calls, 2);
    assert.equal(result.maximum, 1);
    assert.equal(result.allHit, true);
    assert.equal(result.direct, true);
    assert.deepEqual(result.errors, []);
  }
} finally {
  await context.close();
}
