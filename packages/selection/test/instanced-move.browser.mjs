// Real-GPU check of KB-PICK-INSTMOVE1, on WebGPU and then on the WebGL2 compatibility layer. Run from the repository
// root after `npm run build:packages`:
//   node packages/selection/test/instanced-move.browser.mjs            (both backends)
//   MARGO_COMPAT=1 node packages/selection/test/instanced-move.browser.mjs   (the compatibility layer only)
// GPU picking and the selection outline of an instanced mesh find each instance where its instance transform and its
// material's vertex move draw it, and nothing where the instance would stand unmoved.
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
        { UnlitMaterial, createInstancedMesh } = await import('/packages/materials/dist/index.js'),
        { materialPlugin } = await import('/packages/materials/dist/plugins.js'),
        { Picking, Selection } = await import('/packages/selection/dist/index.js');
      const size = 256,
        half = 5 * Math.tan(Math.PI / 6),
        canvas = document.createElement('canvas');
      canvas.width = canvas.height = size;
      canvas.style.cssText = `width:${size}px;height:${size}px;display:block`;
      document.body.prepend(canvas);
      const engine = await Engine.create(canvas, {
          backend: 'webgpu',
          camera: { position: [0, 0, 5], target: [0, 0, 0], fov: 60 },
        }),
        gpu = [];
      engine.stop();
      engine.gpu.addEventListener('uncapturederror', (e) => gpu.push(e.error.message));
      const render = async () => {
        for (let i = 0; i < 3; i++) {
          engine.render({ delta: 1 / 60 });
          await engine.gpu.queue.onSubmittedWorkDone();
        }
      };
      const h = 0.4,
        quad = {
          positions: [-h, -h, 0, h, -h, 0, h, h, 0, -h, h, 0],
          normals: [0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1],
          uvs: [0, 0, 1, 0, 1, 1, 0, 1],
          indices: [0, 1, 2, 0, 2, 3],
        };
      // The vertex stage moves every instance 1.5 to the right; the instance transforms stand them at y = +1.5 and -1.5.
      const material = new UnlitMaterial({
          features: [materialPlugin({ name: 'move', vertex: 'position.x += 1.5;' })],
        }),
        mesh = createInstancedMesh(engine, quad, material, 2);
      mesh.instances.setMatrixAt(0, [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 1.5, 0, 1]);
      mesh.instances.setMatrixAt(1, [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, -1.5, 0, 1]);
      const picking = Picking.attach(engine);
      await render();
      const pick = async (x, y) => {
        const hit = await picking.pick(((x / half + 1) * size) / 2, ((1 - y / half) * size) / 2);
        return hit ? { instanceId: hit.instanceId ?? null, own: hit.mesh === mesh.primitives[0].node } : null;
      };
      const result = {
        gpu,
        movedUp: await pick(1.5, 1.5),
        movedDown: await pick(1.5, -1.5),
        unmovedUp: await pick(0, 1.5),
        unmovedDown: await pick(0, -1.5),
      };
      // The outline marks the same places (KB-SEL-INSTMOVE1): magenta pixels within 0.7 of each place.
      Selection.attach(engine, { color: [1, 0, 1], width: 3 }).set([mesh]);
      await render();
      engine.render({ delta: 1 / 60 });
      const bitmap = await createImageBitmap(canvas),
        copy = new OffscreenCanvas(size, size).getContext('2d');
      copy.drawImage(bitmap, 0, 0);
      const data = copy.getImageData(0, 0, size, size).data,
        px = (x) => Math.round(((x / half + 1) * size) / 2),
        outline = (x, y) => {
          let n = 0;
          for (let row = px(-y - 0.7); row < px(-y + 0.7); row++)
            for (let col = px(x - 0.7); col < px(x + 0.7); col++) {
              const k = (row * size + col) * 4;
              if (data[k] > 200 && data[k + 1] < 60 && data[k + 2] > 200) n++;
            }
          return n;
        };
      result.outline = {
        movedUp: outline(1.5, 1.5),
        movedDown: outline(1.5, -1.5),
        unmovedUp: outline(0, 1.5),
        unmovedDown: outline(0, -1.5),
      };
      engine.dispose();
      return result;
    });
    console.log(leg, JSON.stringify(out));
    assert.deepEqual(out.gpu, [], `${leg}: GPU errors`);
    assert.deepEqual(out.movedUp, { instanceId: 0, own: true }, `${leg}: instance 0 is picked where it is drawn`);
    assert.deepEqual(out.movedDown, { instanceId: 1, own: true }, `${leg}: instance 1 is picked where it is drawn`);
    assert.equal(out.unmovedUp, null, `${leg}: instance 0 is not picked where it would stand unmoved`);
    assert.equal(out.unmovedDown, null, `${leg}: instance 1 is not picked where it would stand unmoved`);
    const o = out.outline;
    assert.ok(o.movedUp > 20 && o.movedDown > 20, `${leg}: the outline covers both instances where they draw`);
    assert.deepEqual([o.unmovedUp, o.unmovedDown], [0, 0], `${leg}: and nothing where they would stand unmoved`);
    assert.deepEqual(errors, [], `${leg}: page errors`);
  } finally {
    await browser.close();
  }
}
console.log(
  'Instanced picking and outlines follow the instance transform and the vertex move on WebGPU and the WebGL2 layer.',
);
