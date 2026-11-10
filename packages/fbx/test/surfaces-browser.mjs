import assert from 'node:assert/strict';
import { openBrowser } from '../../../scripts/browser.js';
const browser = await openBrowser({ startPath: '/packages/fbx/test/textures.html', port: 'free' });
try {
  const errors = [];
  browser.page.on('pageerror', (e) => errors.push(e.message));
  for (const worker of [false, true]) {
    const result = await browser.page.evaluate(async (worker) => {
      const [{ Engine }, { parseFBX }, { parseFBXInWorker }, { surfaces }, { readPixels, createHeadlessCanvas }] =
        await Promise.all([
          import('/packages/core/dist/index.js'),
          import('/packages/fbx/dist/index.js'),
          import('/packages/fbx/dist/worker.js'),
          import('/packages/fbx/dist/surfaces.js'),
          import('/packages/headless/dist/index.js'),
        ]);
      const engine = await Engine.create(createHeadlessCanvas({ width: 128, height: 128 }), {
        camera: { position: [0.015, 0.02, 0.02], target: [0, 0, 0], near: 0.0001, far: 10 },
      });
      engine.gpu.pushErrorScope('validation');
      const bytes = await (
        await fetch('/packages/fbx/test/fixtures/real/maya_nurbs_surface_plane_7500_binary.fbx')
      ).arrayBuffer();
      const model = await (worker ? parseFBXInWorker : parseFBX)(engine, bytes, { extensions: [surfaces] });
      engine.render();
      await engine.gpu.queue.onSubmittedWorkDone();
      const { data } = await readPixels(engine);
      let lit = 0;
      for (let i = 0; i < data.length; i += 4) if (data[i] > 40 && data[i + 1] > 40 && data[i + 2] > 40) lit++;
      const count = model.primitives.length,
        error = await engine.gpu.popErrorScope();
      model.dispose();
      engine.dispose();
      return { lit, count, error: error?.message };
    }, worker);
    assert.equal(result.error, undefined);
    assert.equal(result.count, 1);
    assert.ok(result.lit > 50, JSON.stringify(result));
  }
  assert.deepEqual(errors, []);
  console.log('Real FBX NURBS plane rendered pixels in page and worker');
} finally {
  await browser.close();
}
