import assert from 'node:assert/strict';
import { openBrowser } from '../../../scripts/browser.js';
const context = await openBrowser({ startPath: '/packages/cinematic/test/physical-lens-browser.html', port: 'free' });
try {
  const result = await context.page.evaluate(async () => {
    const { Engine, box } = await import('/packages/core/dist/index.js');
    const { engineRuntime } = await import('/packages/core/dist/extension.js');
    const { CameraProjection } = await import('/packages/cameras/dist/index.js');
    const { CameraBrain } = await import('/packages/cinematic/dist/brain.js');
    const { OrthographicCamera, OrthographicFraming, OrthographicGroupFraming, orthographicOutput } = await import(
      '/packages/cinematic/dist/ortho.js'
    );
    const { waitForPipelines } = await import('/scripts/support/gpu-ready.js');
    const canvas = document.createElement('canvas');
    canvas.style.width = '256px';
    canvas.style.height = '128px';
    document.body.replaceChildren(canvas);
    const engine = await Engine.create(canvas, { backend: 'webgpu', exactSize: [256, 128] });
    engine.stop();
    const gpu = engineRuntime(engine).gpu,
      errors = [];
    gpu.addEventListener('uncapturederror', (e) => errors.push(e.error.message));
    try {
      const projection = CameraProjection.attach(engine, { mode: 'orthographic', height: 10, near: 0.1, far: 100 });
      const brain = CameraBrain.attach(engine, { aspect: 2, blend: { duration: 1, ease: (u) => u } });
      brain.stages.push(orthographicOutput(projection));
      const mesh = engine
        .createMesh()
        .setGeometry(box(1, 1, 1))
        .setPosition([3, 2, 0]);
      mesh.material.set({ color: [1, 0, 0], unlit: true });
      const framing = new OrthographicFraming(mesh, { screen: [0.25, 0.75] });
      const a = brain.add(new OrthographicCamera({ height: 10, position: [0, 0, 10], stages: [framing] }));
      const frame = async () => {
        engine.render({ delta: 0 });
        await gpu.queue.onSubmittedWorkDone();
      };
      await waitForPipelines(frame);
      const framed = (await engine.pick(64, 96)) === mesh;
      const outside = (await engine.pick(128, 64)) === null;
      mesh.setPosition([3, 2, -20]);
      framing.reset();
      await waitForPipelines(frame);
      const sameAtDepth = (await engine.pick(64, 96)) === mesh;
      const b = brain.add(new OrthographicCamera({ height: 20, position: [0, 0, 10], priority: -1 }));
      b.priority = 2;
      brain.update(0);
      brain.update(0.5);
      const midHeight = projection.height;
      brain.cut();
      brain.update(0);
      const endHeight = projection.height;
      a.enabled = b.enabled = false;
      const left = engine
        .createMesh()
        .setGeometry(box(1, 1, 1))
        .setPosition([-4, 0, 0]);
      const right = engine
        .createMesh()
        .setGeometry(box(1, 1, 1))
        .setPosition([4, 0, -4]);
      for (const m of [left, right]) m.material.set({ color: [0, 1, 0], unlit: true });
      const group = new OrthographicGroupFraming(
        [
          { target: left, radius: 0.5 },
          { target: right, radius: 0.5 },
        ],
        { padding: 0.1 },
      );
      brain.add(new OrthographicCamera({ height: 10, position: [0, 0, 10], priority: 5, stages: [group] }));
      brain.update(0);
      brain.cut();
      await waitForPipelines(frame);
      const height = projection.height;
      const groupHits = [
        (await engine.pick(128 - (4 / (height * 2)) * 256, 64)) === left,
        (await engine.pick(128 + (4 / (height * 2)) * 256, 64)) === right,
      ];
      engine.render({ delta: 0 });
      const bitmap = await createImageBitmap(canvas),
        flat = new OffscreenCanvas(256, 128).getContext('2d');
      flat.drawImage(bitmap, 0, 0);
      bitmap.close();
      const pixels = flat.getImageData(0, 0, 256, 128).data;
      let green = 0;
      for (let i = 0; i < pixels.length; i += 4) if (pixels[i + 1] > 100 && pixels[i] < 20) green++;
      return { framed, outside, sameAtDepth, midHeight, endHeight, height, groupHits, fits: group.fits, green, errors };
    } finally {
      engine.dispose();
      canvas.remove();
    }
  });
  console.log(JSON.stringify(result));
  assert.deepEqual(result.errors, []);
  assert.equal(result.framed, true);
  assert.equal(result.outside, true);
  assert.equal(result.sameAtDepth, true);
  assert.equal(result.midHeight, 15);
  assert.equal(result.endHeight, 20);
  assert.ok(Math.abs(result.height - 5.625) < 1e-9);
  assert.deepEqual(result.groupHits, [true, true]);
  assert.equal(result.fits, true);
  assert.ok(result.green > 500, `group rendered ${result.green} green pixels`);
} finally {
  await context.close();
}
