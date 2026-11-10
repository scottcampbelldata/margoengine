import assert from 'node:assert/strict';
import { launchBrowser } from '../../../scripts/lib/browser.mjs';
import { postBrowser } from './post-browser.mjs';
await postBrowser(
  'post-pixelate',
  5383,
  () => launchBrowser({ headless: true }),
  async (page, shot) => {
    await page.evaluate(async () => {
      const { Engine, PbrMaterial, box } = await import('/packages/core/dist/index.js');
      const { Pixelate } = await import('/packages/post/dist/pixelate.js');
      const engine = await Engine.create(document.querySelector('canvas'), {
        backend: 'webgpu',
        camera: { position: [3, 2, 5], target: [0, 0, 0] },
      });
      engine.stop();
      engine
        .createMesh()
        .setGeometry(box(2, 2, 2))
        .setMaterial(new PbrMaterial({ color: '#606060' }));
      const effect = Pixelate.attach(engine, { pixelSize: 6 });
      window.t = { engine, effect };
    });
    const frame = async (options) => {
      await page.evaluate(async (options) => {
        const t = window.t;
        Object.assign(t.effect.options, options);
        t.engine.render({ delta: 1 / 60 });
        await t.engine.gpu.queue.onSubmittedWorkDone();
      }, options);
      return shot();
    };
    const plain = await frame({ depthEdgeStrength: 0, normalEdgeStrength: 0 });
    const depth = await frame({ depthEdgeStrength: 0.7 });
    const normals = await frame({ depthEdgeStrength: 0, normalEdgeStrength: 0.7 });
    let nonuniform = 0,
      darker = 0,
      brighter = 0;
    for (let y = 0; y < 240; y++)
      for (let x = 0; x < 320; x++) {
        const i = 4 * (y * 320 + x),
          origin = 4 * (Math.floor(y / 6) * 6 * 320 + Math.floor(x / 6) * 6);
        for (let c = 0; c < 3; c++) if (plain.data[i + c] !== plain.data[origin + c]) nonuniform++;
        if (depth.data[i] < plain.data[i]) darker++;
        if (normals.data[i] > plain.data[i]) brighter++;
      }
    const off = await frame({ enabled: false });
    const identity = await frame({ enabled: true, pixelSize: 1, depthEdgeStrength: 0, normalEdgeStrength: 0 });
    console.log({ nonuniform, darker, brighter });
    assert.equal(nonuniform, 0);
    assert.ok(darker > 100);
    assert.ok(brighter > 30);
    assert.deepEqual(identity.data, off.data);
    await page.evaluate(() => window.t.engine.dispose());
  },
);
