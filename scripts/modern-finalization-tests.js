import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { openBrowser } from './browser.js';
import { decodePNG } from '../tests/support/png.js';
import { closeAll } from './support/shutdown.mjs';
const browser = await openBrowser({ startPath: '/tests/modern.html' }),
  { page, hardware } = browser,
  errors = [],
  checks = [];
page.on('pageerror', (error) => errors.push(error.message));
page.on('console', (message) => {
  if (message.type() === 'error' || /Error while parsing|Invalid .*Pipeline|ValidationError/.test(message.text()))
    errors.push(message.text());
});
try {
  await page.waitForFunction(() => window.modern);
  await page.evaluate(() => window.modern.core('webgpu'));
  const picking = await page.evaluate(async () => {
    const e = window.modern.state.core,
      original = [...e.meshes.values()][0],
      front = e.createMesh().setGeometry(original.geometry).setPosition([0, 0, 1]);
    front.name = 'Front';
    const hit = await e.pick(160, 120),
      blank = await e.pick(1, 1);
    front.visible = false;
    const behind = await e.pick(160, 120);
    front.visible = true;
    const pending = e.pick(160, 120);
    front.dispose();
    e.createMesh().setGeometry(original.geometry).setPosition([0, 0, 1]);
    const stale = await pending;
    await e.rebootDevice();
    const restored = await e.pick(160, 120);
    return {
      front: hit === front,
      blank: blank === null,
      behind: behind === original,
      stale: stale === null,
      restored: restored !== null,
    };
  });
  assert.ok(Object.values(picking).every(Boolean), JSON.stringify(picking));
  checks.push({
    name: '1x1 r32uint GPU picking: occlusion, misses, instance IDs, visibility, stale-slot reuse and reboot',
    ...picking,
  });
  await page.evaluate(async () => {
    const e = window.modern.state.core;
    for (const m of [...e.meshes.values()]) m.dispose();
    e.camera.position = [0, 0, 0];
    e.camera.target = [0, 0, -1];
    e.camera.near = 0.001;
    e.camera.far = 10000;
    const { box, PbrMaterial } = await import('/packages/core/dist/index.js'),
      geometry = box();
    e.createMesh()
      .setGeometry(geometry)
      .setPosition([0, 0, -500])
      .setScale([20, 20, 0.00001])
      .setMaterial(new PbrMaterial({ color: '#00ff00' }));
    e.createMesh()
      .setGeometry(geometry)
      .setPosition([0, 0, -500.0001])
      .setScale([20, 20, 0.00001])
      .setMaterial(new PbrMaterial({ color: '#ff0000' }));
    e.render();
    await e.gpu.queue.onSubmittedWorkDone();
  });
  const precisionImage = await decodePNG(
      await page.locator('[data-core]').screenshot({ path: 'test-results/modern-depth-precision.png' }),
    ),
    precisionAt = (120 * precisionImage.width + 160) * 4,
    precision = [...precisionImage.data.slice(precisionAt, precisionAt + 3)];
  assert.ok(
    precision[1] > precision[0] + 30,
    'Reversed float depth failed to separate surfaces 0.1 mm apart at 500 m: ' + precision,
  );
  checks.push({
    name: 'GPU depth precision: near=1 mm, far=10 km, 0.1 mm surface separation at 500 m survives adverse draw order',
    pixel: precision,
  });
  const stress = await page.evaluate(async () => {
    const { Engine, box } = await import('/packages/core/dist/extension.js');
    const canvas = document.createElement('canvas');
    canvas.style.cssText = 'width:640px;height:400px';
    document.body.append(canvas);
    const e = await Engine.create(canvas, {
        backend: 'webgpu',
        capacity: 15000,
        camera: { position: [6, 4, 9], target: [0, 0, 0], near: 0.001, far: 10000 },
      }),
      root = e.createMesh(),
      geometry = box();
    for (let i = 0; i < 10000; i++)
      e.createMesh(root)
        .setGeometry(geometry)
        .setScale([0.03, 0.03, 0.03])
        .setPosition([(i % 100) * 0.06 - 3, Math.floor(i / 100) * 0.01, 0]);
    const samples = [],
      gpu = [];
    for (let i = 0; i < 70; i++) {
      root.position.y = Math.sin(i / 10) * 0.2;
      const start = performance.now();
      e.render({ delta: 1 / 60 });
      const end = performance.now();
      await e.gpu.queue.onSubmittedWorkDone();
      if (i >= 10) {
        samples.push(end - start);
        gpu.push(performance.now() - start);
      }
    }
    const percentile = (values, p) => values.sort((a, b) => a - b)[Math.ceil(values.length * p) - 1],
      report = {
        entities: e.meshes.size,
        visible: e.stats.visible,
        batches: e.stats.drawCalls,
        frames: samples.length,
        cpuMedianMs: percentile(samples, 0.5),
        cpuP95Ms: percentile(samples, 0.95),
        completedGpuMedianMs: percentile(gpu, 0.5),
        completedGpuP95Ms: percentile(gpu, 0.95),
        memoryBytes: e.store.matrices.buffer.byteLength,
      };
    await e.rebootDevice();
    e.render();
    await e.gpu.queue.onSubmittedWorkDone();
    e.dispose();
    canvas.remove();
    return report;
  });
  assert.ok(stress.entities > 10000 && stress.frames === 60 && stress.batches < 10);
  checks.push({
    name: 'Hierarchy stress: 10000 shared-geometry parts under a moving parent, batched draws and reboot',
    ...stress,
  });
  assert.deepEqual(errors, []);
  await writeFile('test-results/modern-finalization.json', JSON.stringify({ hardware, checks }, null, 2));
  console.log(JSON.stringify({ hardware, checks }, null, 2));
} finally {
  await closeAll({ browser });
}
