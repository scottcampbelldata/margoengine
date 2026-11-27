// Real GPU and real workers: loadGLTFProgressive on Draco and meshopt files (the progressive worker, Draco answered by
// the decoder's own workers on the main thread) draws the same picture as loadGLTF, with a stand-in picture first.
// Natively and on the WebGL2 layer (--compat). Run from the repository root after building packages:
//   node scripts/run-with-timeout.mjs -- node packages/gltf/scripts/test-progressive-browser.mjs [--compat]
import assert from 'node:assert/strict';
import { openBrowser } from '../../../scripts/browser.js';
import { runSuite } from '../../../scripts/support/shutdown.mjs';
import { decodePNG } from '../../../tests/support/png.js';

const files = [
  '/examples/orrery/orrery.glb',
  '/examples/assets/robot-expressive.glb',
  '/examples/assets/boulder-robot.glb',
  '/examples/assets/khronos/MeshoptCubeTest/MeshoptCubeTest.gltf',
];
const browser = await openBrowser({ startPath: '/tests/modern-extension.html', port: 'free' });
await runSuite(
  async () => {
    const errors = [];
    browser.page.on('pageerror', (e) => errors.push(e.message));
    const result = await browser.page.evaluate(async (files) => {
      const { Engine } = await import('/packages/core/dist/index.js');
      const { loadGLTF } = await import('/packages/gltf/dist/pbr.js');
      const { loadGLTFProgressive } = await import('/packages/gltf/dist/progressive.js');
      const { waitForPipelines } = await import('/scripts/support/gpu-ready.js');
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = 256;
      document.body.append(canvas);
      const engine = await Engine.create(canvas, { backend: 'webgpu' });
      engine.stop();
      const validation = [];
      engine.gpu.addEventListener('uncapturederror', (e) => validation.push(e.error.message));
      const picture = async () => {
        await waitForPipelines(async () => {
          engine.render({ delta: 0 });
          await engine.gpu.queue.onSubmittedWorkDone();
        });
        return canvas.toDataURL('image/png');
      };
      const frame = (model) => {
        const b = model.bounds,
          centre = [0, 1, 2].map((k) => (b[k] + b[k + 3]) / 2),
          size = Math.hypot(b[3] - b[0], b[4] - b[1], b[5] - b[2]);
        engine.camera.target = centre;
        engine.camera.position = [centre[0] + 0.5 * size, centre[1] + 0.4 * size, centre[2] + 0.8 * size];
        engine.camera.near = size / 1000;
        engine.camera.far = size * 20;
      };
      const rows = [];
      try {
        for (const url of files) {
          const plain = await loadGLTF(engine, url);
          frame(plain);
          const expected = await picture();
          plain.dispose();
          const stages = [];
          const load = loadGLTFProgressive(engine, url, {
            maxJobs: 1,
            onProgress: (p) => stages.push(p.stage),
          });
          const model = await load.ready;
          const early = load.ready !== load.complete;
          frame(model);
          const standIn = await picture();
          await load.complete;
          // Framed again: the stand-in boxes of rotated parts reach past the geometry, so their bounds are wider.
          frame(model);
          const final = await picture();
          rows.push({ url, early, stages: [...new Set(stages)], expected, standIn, final });
          model.dispose();
        }
        return { rows, validation };
      } finally {
        engine.dispose();
        canvas.remove();
      }
    }, files);
    assert.deepEqual(errors, []);
    assert.deepEqual(result.validation, []);
    const pixels = async (url) => (await decodePNG(Buffer.from(url.split(',')[1], 'base64'))).data;
    const differing = (a, b) => {
      let count = 0;
      for (let i = 0; i < a.length; i += 4)
        if (a[i] !== b[i] || a[i + 1] !== b[i + 1] || a[i + 2] !== b[i + 2]) count++;
      return count;
    };
    for (const row of result.rows) {
      const expected = await pixels(row.expected),
        final = await pixels(row.final),
        // Pixels that differ from the top-left one: how much of the picture the model covers.
        drawn = differing(
          expected,
          expected.map((_, i) => expected[i & 3]),
        );
      assert.ok(row.early, `${row.url}: placeholders resolve before the load is complete`);
      assert.ok(row.stages.includes('geometry') && row.stages.at(-1) === 'complete', `${row.url}: ${row.stages}`);
      assert.ok(drawn > 500, `${row.url}: the model is on screen (${drawn} pixels)`);
      assert.equal(differing(final, expected), 0, `${row.url}: progressive draws what loadGLTF draws`);
      row.standInPixels = differing(await pixels(row.standIn), expected);
      assert.ok(row.standInPixels > 0, `${row.url}: the first picture is the stand-in`);
      delete row.expected;
      delete row.standIn;
      delete row.final;
    }
    console.log(JSON.stringify({ hardware: browser.hardware, rows: result.rows }));
  },
  () => browser.close(),
);
