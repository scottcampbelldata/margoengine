import { fileURLToPath } from 'node:url';
process.chdir(fileURLToPath(new URL('../../..', import.meta.url)));
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { openBrowser } from '../../../scripts/browser.js';
const truth = JSON.parse(await readFile(new URL('./fixtures/objects-truth.json', import.meta.url), 'utf8'));
const browser = await openBrowser({ port: 'free', startPath: '/tests/modern-extension.html' });
const errors = [];
browser.page.on('pageerror', e => errors.push(e.message));
try {
  const result = await browser.page.evaluate(async truth => {
    const { Engine } = await import('/packages/core/dist/index.js');
    const { loadMargoObjects } = await import('/packages/blender/dist/objects.js');
    const { Animation } = await import('/packages/animation/dist/index.js');
    const { waitForPipelines } = await import('/scripts/support/gpu-ready.js');
    const canvas = document.createElement('canvas');
    canvas.style.cssText = 'width:128px;height:128px';
    document.body.append(canvas);
    const engine = await Engine.create(canvas, { backend: 'webgpu', capacity: 32 });
    engine.gpu.pushErrorScope('validation');
    const model = await loadMargoObjects(engine, '/packages/blender/tests/fixtures/objects.margo');
    const animation = Animation.attach(model);
    let worst = 0, compared = 0;
    for (const clip of model.asset.doc.animations) {
      animation.play(clip.name);
      for (const [frame, expected] of truth.clips[clip.name].entries()) {
        animation.seek(frame / 24);
        engine.render({ culling: false });
        for (const [name, matrix] of Object.entries(expected)) {
          const id = model.asset.doc.nodes.findIndex(n => n.name === name);
          matrix.forEach((value, k) => { worst = Math.max(worst, Math.abs(value - model.nodes[id].matrix[k])); compared++; });
        }
      }
    }
    const b = model.bounds;
    engine.camera.fitToBoundingBox([b[0], b[1], b[2]], [b[3], b[4], b[5]], { duration: 0 });
    await waitForPipelines(async () => { engine.render({ culling: false }); await engine.gpu.queue.onSubmittedWorkDone(); });
    const validation = (await engine.gpu.popErrorScope())?.message ?? null;
    const image = canvas.toDataURL();
    animation.dispose();
    model.dispose();
    const remaining = engine.meshes.size;
    engine.dispose();
    canvas.remove();
    return { worst, compared, validation, remaining, image };
  }, truth);
  assert.ok(result.compared >= 1728);
  assert.ok(result.worst < 4e-6, `world matrix error ${result.worst}`);
  assert.equal(result.validation, null);
  assert.equal(result.remaining, 0);
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ ...result, image: undefined }));
} finally {
  await browser.close();
}
