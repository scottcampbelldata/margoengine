// Real-GPU check of KB-PICK-BUDGET1, on WebGPU and then on the WebGL2 compatibility layer. Run from the repository
// root after `npm run build:packages`:
//   node packages/selection/test/many-models.browser.mjs            (both backends)
//   MARGO_COMPAT=1 node packages/selection/test/many-models.browser.mjs   (the compatibility layer only)
// Picking attached to a scene of 5,000 gltf/pbr models (materials meshes) renders every frame without an error and
// picks the last model made.
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { openBrowser } from '../../../scripts/browser.js';
import { compatRun } from '../../../scripts/support/compat-shim.js';

process.chdir(fileURLToPath(new URL('../../../', import.meta.url)));
for (const compat of compatRun() ? [true] : [false, true]) {
  const browser = await openBrowser({ port: 'free', compat }),
    { page } = browser,
    errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  const leg = compat ? 'compat' : 'webgpu';
  try {
    await page.waitForFunction(() => window.modern, null, { timeout: 30000 });
    const out = await page.evaluate(async () => {
      const { Engine } = await import('/packages/core/dist/index.js'),
        { UnlitMaterial, createMesh } = await import('/packages/materials/dist/index.js'),
        { Picking } = await import('/packages/selection/dist/index.js');
      const size = 512,
        half = 5 * Math.tan(Math.PI / 6),
        canvas = document.createElement('canvas');
      canvas.width = canvas.height = size;
      canvas.style.cssText = `width:${size}px;height:${size}px;display:block`;
      document.body.prepend(canvas);
      const engine = await Engine.create(canvas, {
          backend: 'webgpu',
          capacity: 16384,
          camera: { position: [0, 0, 5], target: [0, 0, 0], fov: 60 },
        }),
        gpu = [],
        thrown = [];
      engine.stop();
      engine.onError = (e) => thrown.push(String(e));
      engine.gpu.addEventListener('uncapturederror', (e) => gpu.push(e.error.message));
      const picking = Picking.attach(engine);
      // 5,000 models, past the old 4,096-source budget, in a 71 x 71 grid that fills the view.
      const count = 5000,
        side = 71,
        step = (2 * half * 0.95) / side,
        h = step * 0.4,
        quad = {
          positions: [-h, -h, 0, h, -h, 0, h, h, 0, -h, h, 0],
          normals: [0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1],
          indices: [0, 1, 2, 0, 2, 3],
        },
        material = new UnlitMaterial(),
        meshes = [];
      for (let k = 0; k < count; k++) {
        const mesh = createMesh(engine, quad, material);
        const at = [
          (k % side) * step - half * 0.95 + step / 2,
          half * 0.95 - Math.floor(k / side) * step - step / 2,
          0,
        ];
        mesh.root.setPosition(at);
        meshes.push([mesh, at]);
      }
      let frames = 0;
      for (let i = 0; i < 4; i++) {
        try {
          engine.render({ delta: 1 / 60 });
          frames++;
        } catch (error) {
          thrown.push(String(error));
        }
        await engine.gpu.queue.onSubmittedWorkDone();
      }
      const px = (v) => ((v / half + 1) * size) / 2,
        pick = ([mesh, [x, y]]) =>
          picking.pick(px(x), size - px(y)).then((hit) => hit?.mesh === mesh.primitives[0].node);
      const result = {
        gpu,
        thrown,
        frames,
        last: await pick(meshes[count - 1]),
        first: await pick(meshes[0]),
      };
      engine.dispose();
      return result;
    });
    console.log(leg, JSON.stringify(out));
    assert.deepEqual(out.thrown, [], `${leg}: no frame throws`);
    assert.equal(out.frames, 4, `${leg}: every frame renders`);
    assert.deepEqual(out.gpu, [], `${leg}: GPU errors`);
    assert.equal(out.last, true, `${leg}: a pick hits the last of 5,000 models`);
    assert.equal(out.first, true, `${leg}: and the first`);
    assert.deepEqual(errors, [], `${leg}: page errors`);
  } finally {
    await browser.close();
  }
}
console.log('Picking renders and picks a scene of 5,000 models on WebGPU and the WebGL2 layer.');
