// Actual redraws of an owning scene, with queued work cancelled at plugin lifetime end.
import assert from 'node:assert/strict';
import { openBrowser } from '../../../scripts/browser.js';

setTimeout(() => process.exit(124), 120_000).unref();
const context = await openBrowser({ startPath: '/packages/quality/test/ssaa-browser.html', port: 'free' });
const problems = [];
context.page.on('pageerror', (error) => problems.push(error.message));
try {
  const result = await context.page.evaluate(async () => {
    globalThis.margoLow = 1;
    const { Engine, box } = await import('/packages/core/dist/index.js');
    const { redrawAfterRestore } = await import('/packages/quality/dist/index.js');
    const engine = await Engine.create(document.querySelector('canvas'), {
      backend: 'webgpu',
      exactSize: [64, 64],
      camera: { position: [0, 0, 3], target: [0, 0, 0] },
    });
    engine.stop();
    const errors = [],
      rows = [];
    engine.gpu.addEventListener('uncapturederror', (event) => errors.push(event.error.message));
    try {
      for (const target of ['default', 'secondary']) {
        const scene = target === 'default' ? engine.scene : engine.createScene(target);
        scene.background = '#000000';
        const mesh = scene.createMesh().setGeometry(box());
        mesh.material.set({ color: [1, 0, 0], unlit: true });
        for (const mode of ['live', 'stop', 'remove', 'second-stop']) {
          const frames = [];
          let stop,
            plugin,
            renders = 0;
          const scope = {
            name: 'scope',
            setup() {
              stop = redrawAfterRestore(
                engine,
                () => {
                  renders++;
                  engine.render({ delta: 0, views: [{ scene, camera: engine.camera, viewport: [0, 0, 1, 1] }] });
                },
                (callback) => frames.push(callback),
              );
              plugin = [...scene.plugins.values()].find((value) => value !== scope);
            },
          };
          scene.use(scope);
          scene.removePlugin(scope.name);
          const sentinel = { name: plugin.name, setup() {} };
          if (target === 'secondary') engine.use(sentinel);
          plugin.onDeviceRestored(engine);
          if (mode === 'stop') stop();
          if (mode === 'remove') scene.removePlugin(plugin.name);
          if (mode === 'second-stop') {
            frames.shift()();
            stop();
          }
          while (frames.length) frames.shift()();
          let red = 0;
          if (mode === 'live') {
            const bitmap = await createImageBitmap(engine.canvas);
            const flat = new OffscreenCanvas(64, 64).getContext('2d');
            flat.drawImage(bitmap, 0, 0);
            bitmap.close();
            const pixels = flat.getImageData(0, 0, 64, 64).data;
            for (let i = 0; i < pixels.length; i += 4) if (pixels[i] > 100 && pixels[i + 1] < 20) red++;
          }
          stop();
          const isolated = target === 'default' || engine.scene.plugins.get(plugin.name) === sentinel;
          const detached = engine.sceneOf(plugin) === undefined;
          if (target === 'secondary') engine.removePlugin(sentinel.name);
          rows.push({ target, mode, renders, red, isolated, detached });
        }
        mesh.dispose();
        if (target === 'secondary') scene.dispose();
      }
      await engine.gpu.queue.onSubmittedWorkDone();
      return { rows, errors };
    } finally {
      engine.dispose();
    }
  });
  console.log(JSON.stringify(result));
  for (const row of result.rows) {
    assert.equal(row.renders, row.mode === 'live' ? 2 : row.mode === 'second-stop' ? 1 : 0);
    if (row.mode === 'live') assert.ok(row.red > 100, `${row.target}: owning scene must render red pixels`);
    assert.equal(row.isolated, true);
    assert.equal(row.detached, true);
  }
  assert.deepEqual(result.errors, []);
  assert.deepEqual(problems, []);
  console.log('quality owner GPU check passed');
} finally {
  await context.close();
}
