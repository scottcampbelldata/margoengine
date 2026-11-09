import assert from 'node:assert/strict';
import { openBrowser } from '../../../scripts/browser.js';
const context = await openBrowser({ startPath: '/tests/modern-game.html', port: 'free' });
try {
  for (const compat of [false, true]) {
    if (compat) await context.page.reload();
    const result = await context.page.evaluate(async (compat) => {
      if (compat) {
        const { install } = await import('/packages/webgl2-compat/dist/index.js');
        await install({ force: true });
      }
      const { Engine } = await import('/packages/core/dist/index.js');
      const { ComputeFrame } = await import('/packages/compute/dist/frame.js');
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = 32;
      document.body.append(canvas);
      const e = await Engine.create(canvas, { backend: 'webgpu' });
      const errors = [];
      e.gpu.addEventListener('uncapturederror', (event) => errors.push(event.error.message));
      try {
        const scene = e.createScene('compute-owner');
        const frame = new ComputeFrame();
        scene.use(frame);
        let defaultDisposals = 0,
          steps = 0;
        const sentinel = {
          name: frame.name,
          setup() {},
          dispose() {
            defaultDisposals++;
          },
        };
        e.use(sentinel);
        const array = frame.gpu.zeros(1024);
        const step = frame.gpu
          .kernel(`
          @group(0) @binding(0) var<storage, read_write> data: array<f32>;
          @compute @workgroup_size(64) fn main(@builtin(global_invocation_id) id: vec3u) {
            if (id.x < arrayLength(&data)) { data[id.x] += 1.0; }
          }`)
          .bind({ data: array });
        frame.add(step, () => {
          steps++;
          return { count: 1024 };
        });
        const render = () => e.render({ delta: 1 / 60, views: [{ camera: e.camera, scene, viewport: [0, 0, 1, 1] }] });
        for (let i = 0; i < 4; i++) render();
        const values = Array.from(await array.read());
        const gpu = frame.gpu;
        frame.dispose();
        frame.dispose();
        render();
        await e.gpu.queue.onSubmittedWorkDone();
        return {
          values,
          steps,
          detached: e.sceneOf(frame) === undefined,
          isolated: e.scene.plugins.get(frame.name) === sentinel && defaultDisposals === 0,
          contextDisposed: gpu.disposed,
          arrayDisposed: array.disposed,
          errors,
        };
      } finally {
        e.dispose();
        canvas.remove();
      }
    }, compat);
    assert.deepEqual(result.values, Array(1024).fill(4));
    assert.equal(result.steps, 4);
    assert.equal(result.detached, true);
    assert.equal(result.isolated, true);
    assert.equal(result.contextDisposed, true);
    assert.equal(result.arrayDisposed, true);
    assert.deepEqual(result.errors, []);
    console.log(
      `ComputeFrame ${compat ? 'compatibility' : 'native'}: 1024 exact four-step values; ownership, context and arrays released`,
    );
  }
} finally {
  await context.close();
}
