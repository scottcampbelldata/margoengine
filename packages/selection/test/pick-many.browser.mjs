// pickMany answers what engine.pick answers, point for point, from one readback (p-gpu-pick: 100 picks waited for 100).
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { openBrowser } from '../../../scripts/browser.js';

process.chdir(fileURLToPath(new URL('../../../', import.meta.url)));
const browser = await openBrowser(),
  { page } = browser,
  errors = [];
page.on('pageerror', (error) => errors.push(error.message));
page.on('console', (message) => {
  if (message.type() === 'error' || /ValidationError/.test(message.text())) errors.push(message.text());
});
try {
  await page.waitForFunction(() => window.modern);
  for (const capture of [true, false]) {
    const report = await page.evaluate(async (capture) => {
      const { Engine, box, PbrMaterial } = await import('/packages/core/dist/extension.js'),
        { Picking } = await import('/packages/selection/dist/index.js'),
        canvas = document.createElement('canvas');
      canvas.style.cssText = 'width:128px;height:128px';
      document.body.append(canvas);
      const e = await Engine.create(canvas, {
        backend: 'webgpu',
        capacity: 64,
        camera: { position: [0, 0, 6], fov: 60 },
      });
      try {
        const geometry = box(),
          material = new PbrMaterial(),
          meshes = [];
        for (let i = 0; i < 9; i++)
          meshes.push(
            e
              .createMesh()
              .setGeometry(geometry)
              .setMaterial(material)
              .setScale([0.8, 0.8, 0.8])
              .setPosition([(i % 3) * 2 - 2, Math.floor(i / 3) * 2 - 2, 0]),
          );
        const picking = Picking.attach(e, { capture });
        meshes[4].visible = false;
        e.render();
        await e.gpu.queue.onSubmittedWorkDone();
        const points = [];
        for (let y = 8; y < 128; y += 24) for (let x = 8; x < 128; x += 24) points.push([x, y]);
        points.push([-1, 4], [4, 500]);
        const one = [];
        for (const [x, y] of points) one.push(await e.pick(x, y));

        const map = GPUBuffer.prototype.mapAsync;
        let maps = 0;
        GPUBuffer.prototype.mapAsync = function (...args) {
          maps++;
          return map.apply(this, args);
        };
        const many = await picking.pickMany(points);
        GPUBuffer.prototype.mapAsync = map;

        // Overlapping calls keep the engine's turn order: the pick queued first answers first.
        const order = [];
        await Promise.all([
          e.pick(64, 64).then(() => order.push('pick')),
          picking.pickMany(points).then(() => order.push('many')),
          e.pick(64, 64).then(() => order.push('pick')),
        ]);
        let invalid = '';
        await picking.pickMany([[Number.NaN, 0]]).catch((error) => (invalid = error.name));
        return {
          same: one.every((mesh, i) => (many[i]?.mesh ?? null) === mesh),
          hits: many.filter(Boolean).length,
          outside: many.slice(-2),
          maps,
          order,
          invalid,
          empty: (await picking.pickMany([])).length,
        };
      } finally {
        e.dispose();
        canvas.remove();
      }
    }, capture);
    assert.equal(report.same, true, 'every point answers what engine.pick answers');
    assert.ok(report.hits > 0, 'the points hit something');
    assert.deepEqual(report.outside, [null, null], 'a point off the canvas answers null');
    assert.equal(report.maps, 1, 'one readback for every point');
    assert.deepEqual(report.order, ['pick', 'many', 'pick'], 'pickMany keeps its turn in the pick queue');
    assert.equal(report.invalid, 'RangeError');
    assert.equal(report.empty, 0);
    console.log(JSON.stringify({ capture, ...report }));
  }
  assert.deepEqual(errors, []);
} finally {
  await browser.close();
}
