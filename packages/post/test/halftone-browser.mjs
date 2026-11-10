import assert from 'node:assert/strict';
import { launchBrowser } from '../../../scripts/lib/browser.mjs';
import { postBrowser } from './post-browser.mjs';
await postBrowser(
  'post-halftone',
  5384,
  () => launchBrowser({ headless: true }),
  async (page, shot) => {
    await page.evaluate(async () => {
      const { Engine, PbrMaterial, box } = await import('/packages/core/dist/index.js');
      const { Halftone, DotScreen } = await import('/packages/post/dist/halftone.js');
      const { PostStack } = await import('/packages/post/dist/stack.js');
      const engine = await Engine.create(document.querySelector('canvas'), {
        backend: 'webgpu',
        camera: { position: [0, 0, 5], target: [0, 0, 0] },
      });
      engine.stop();
      engine
        .createMesh()
        .setGeometry(box(8, 8, 0.1))
        .setMaterial(new PbrMaterial({ color: '#6080a0' }));
      const rgb = new Halftone({ cellSize: 12 }),
        mono = new DotScreen({ cellSize: 12, enabled: false });
      PostStack.attach(engine, [rgb, mono]);
      window.t = { engine, rgb, mono };
    });
    const frame = async (mode, shape = 'dot') => {
      await page.evaluate(
        async ([mode, shape]) => {
          const t = window.t;
          t.rgb.options.enabled = mode === 'rgb';
          t.mono.options.enabled = mode === 'mono';
          t.rgb.options.shape = shape;
          t.engine.render({ delta: 1 / 60 });
          await t.engine.gpu.queue.onSubmittedWorkDone();
        },
        [mode, shape],
      );
      return shot();
    };
    const plain = await frame('off'),
      rgb = await frame('rgb'),
      mono = await frame('mono');
    const changed = (image) => {
      let n = 0;
      for (let i = 0; i < image.data.length; i += 4) if (image.data[i] !== plain.data[i]) n++;
      return n;
    };
    let grayErrors = 0,
      rangeLow = 255,
      rangeHigh = 0;
    for (let y = 40; y < 200; y++)
      for (let x = 40; x < 280; x++) {
        const i = 4 * (y * 320 + x);
        if (mono.data[i] !== mono.data[i + 1] || mono.data[i] !== mono.data[i + 2]) grayErrors++;
        rangeLow = Math.min(rangeLow, mono.data[i]);
        rangeHigh = Math.max(rangeHigh, mono.data[i]);
      }
    assert.equal(grayErrors, 0);
    assert.ok(rangeHigh - rangeLow > 200);
    assert.ok(changed(rgb) > 30000);
    assert.ok(changed(mono) > 30000);
    const hashes = [];
    for (const shape of ['dot', 'ellipse', 'line', 'square']) {
      const image = await frame('rgb', shape);
      let hash = 2166136261;
      for (const value of image.data) hash = Math.imul(hash ^ value, 16777619);
      hashes.push(hash);
    }
    assert.equal(new Set(hashes).size, 4, 'four distinct screens');
    const back = await frame('off');
    assert.deepEqual(back.data, plain.data);
    console.log({ grayErrors, rangeLow, rangeHigh, changedRGB: changed(rgb), changedMono: changed(mono), hashes });
    await page.evaluate(() => window.t.engine.dispose());
  },
);
