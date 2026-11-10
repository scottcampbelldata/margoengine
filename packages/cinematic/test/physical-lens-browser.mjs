import assert from 'node:assert/strict';
import { openBrowser } from '../../../scripts/browser.js';

const context = await openBrowser({ startPath: '/packages/cinematic/test/physical-lens-browser.html', port: 'free' });
try {
  const result = await context.page.evaluate(async () => {
    const { Engine, box } = await import('/packages/core/dist/index.js');
    const { engineRuntime } = await import('/packages/core/dist/extension.js');
    const { DOF } = await import('/packages/dof/dist/index.js');
    const { PhysicalLens } = await import('/packages/cinematic/dist/physical-lens.js');
    const { waitForPipelines } = await import('/scripts/support/gpu-ready.js');
    const canvas = document.createElement('canvas');
    document.body.replaceChildren(canvas);
    const engine = await Engine.create(canvas, { backend: 'webgpu', exactSize: [256, 128],
      camera: { position: [0, 0, 0], target: [0, 0, -1] } });
    engine.stop();
    const gpu = engineRuntime(engine).gpu, errors = [];
    gpu.addEventListener('uncapturederror', (e) => errors.push(e.error.message));
    try {
      engine.scene.background = '#000000';
      const mesh = engine.createMesh().setGeometry(box(2, 2, 0.05)).setPosition([0, 0, -6]);
      mesh.material.set({ color: [1, 1, 1], unlit: true });
      const lens = new PhysicalLens({ focalLength: 85, filmGauge: 36, focusDistance: 2, fStop: 1 });
      lens.apply({ camera: engine.camera, aspect: 2 });
      const dof = DOF.attach(engine, { focalLength: 0.085, focalDistance: 2, aperture: 1, maxRadius: 32 });
      const rows = [];
      for (const fStop of [1, 16]) {
        lens.fStop = fStop;
        lens.apply({ camera: engine.camera, dof, aspect: 2 });
        await waitForPipelines(async () => {
          engine.render({ delta: 0 });
          await gpu.queue.onSubmittedWorkDone();
        });
        engine.render({ delta: 0 });
        const bitmap = await createImageBitmap(canvas);
        const flat = new OffscreenCanvas(256, 128).getContext('2d');
        flat.drawImage(bitmap, 0, 0);
        bitmap.close();
        const pixels = flat.getImageData(0, 0, 256, 128).data;
        const row = Array.from({ length: 256 }, (_, x) => pixels[(64 * 256 + x) * 4]);
        const peak = Math.max(...row), low = Math.min(...row);
        rows.push({ fStop, peak, middle: row.filter((v) => v > low + (peak - low) * 0.1 && v < low + (peak - low) * 0.9).length,
          bright: row.filter((v) => v >= peak * 0.9).length, fov: engine.camera.fov, focalLength: dof.focalLength,
          focus: dof.options.focalDistance, aperture: dof.options.aperture });
      }
      lens.focalLength = 35;
      lens.apply({ camera: engine.camera, dof, aspect: 2 });
      engine.render({ delta: 0 });
      await gpu.queue.onSubmittedWorkDone();
      return { rows, zoom: engine.camera.fov, focalLength: dof.focalLength, errors };
    } finally { engine.dispose(); canvas.remove(); }
  });
  console.log(JSON.stringify(result));
  assert.deepEqual(result.errors, []);
  const [wide, stopped] = result.rows;
  assert.ok(wide.middle > stopped.middle * 2, `f/1 blur exceeds f/16: ${wide.middle} vs ${stopped.middle}`);
  assert.ok(stopped.bright > 20, 'the card rendered');
  for (const row of result.rows) {
    assert.ok(row.peak > 150, 'white diagnostic card rendered');
    assert.ok(Math.abs(row.fov - 2 * Math.atan(18 / 170) * 180 / Math.PI) < 1e-9);
    assert.ok(Math.abs(row.focalLength - 0.085) < 1e-6);
    assert.equal(row.focus, 2);
    assert.equal(row.aperture, row.fStop);
  }
  assert.ok(result.zoom > wide.fov);
  assert.ok(Math.abs(result.focalLength - 0.035) < 1e-6);
} finally { await context.close(); }
