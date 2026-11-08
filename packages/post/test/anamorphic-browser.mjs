// Real-GPU check of Anamorphic, built packages. A small white box (a few pixels) in the middle of a dark frame is the
// only light above the threshold. With streaks it draws a thin horizontal line: pixels far left and right on its rows
// brighten, pixels well above and below it are unchanged to the bit (the bright pass gives exactly 0 below the knee),
// and a threshold above everything equals the effect disabled exactly.
import assert from 'node:assert/strict';
import { launchBrowser } from '../../../scripts/lib/browser.mjs';
import { postBrowser } from './post-browser.mjs';

await postBrowser(
  'post-anamorphic',
  5362,
  () => launchBrowser({ headless: true }),
  async (page, shot) => {
    await page.evaluate(async () => {
      const { Engine, PbrMaterial, box } = await import('/packages/core/dist/index.js'),
        { PostStack } = await import('/packages/post/dist/stack.js'),
        { Anamorphic } = await import('/packages/post/dist/anamorphic.js');
      const canvas = document.querySelector('canvas'),
        engine = await Engine.create(canvas, { backend: 'webgpu', camera: { position: [0, 0, 5], target: [0, 0, 0] } });
      engine.stop();
      engine
        .createMesh()
        .setGeometry(box(0.06, 0.06, 0.06))
        .setMaterial(new PbrMaterial({ color: '#ffffff' }));
      const options = { threshold: 0.4, intensity: 4, tint: [1, 1, 1], passes: 5 },
        effect = new Anamorphic(options);
      PostStack.attach(engine, [effect]);
      window.t = {
        engine,
        effect,
        frame: () => (engine.render({ delta: 1 / 60 }), engine.gpu.queue.onSubmittedWorkDone()),
      };
    });
    const frame = async (set) => {
      await page.evaluate(`(${set})(window.t.effect.options); window.t.frame()`);
      await page.evaluate(() => window.t.engine.gpu.queue.onSubmittedWorkDone());
      return shot();
    };
    const on = await frame('() => {}');
    const off = await frame('(o) => { o.enabled = false; }');
    const high = await frame('(o) => { o.enabled = true; o.threshold = 1000; }');
    const luma = (img, x, y) => {
      const i = 4 * (y * img.width + x);
      return img.data[i] + img.data[i + 1] + img.data[i + 2];
    };
    // The box: the brightest pixels of the frame without the effect.
    let peak = 0,
      cy = 0;
    for (let y = 0; y < 240; y++)
      for (let x = 0; x < 320; x++)
        if (luma(off, x, y) > peak) {
          peak = luma(off, x, y);
          cy = y;
        }
    // Along the box's row: how far from the centre pixels are brighter with streaks (each side).
    let left = 0,
      right = 0;
    for (let d = 1; d < 160; d++) {
      if (luma(on, 160 - d, cy) > luma(off, 160 - d, cy)) left = d;
      if (luma(on, 159 + d, cy) > luma(off, 159 + d, cy)) right = d;
    }
    // Rows 24 px or more above and below the box: no change at all.
    let away = 0;
    for (let y = 0; y < 240; y++)
      if (Math.abs(y - cy) >= 24)
        for (let x = 0; x < 320; x++) away = Math.max(away, Math.abs(luma(on, x, y) - luma(off, x, y)));
    let highDiff = 0;
    for (let i = 0; i < off.data.length; i++) highDiff = Math.max(highDiff, Math.abs(high.data[i] - off.data[i]));
    console.log(JSON.stringify({ peak, cy, left, right, away, highDiff }));
    await page.evaluate(() => window.t.engine.dispose());
    assert.ok(peak >= 450, `the box is bright: ${peak}`);
    assert.ok(left >= 100 && right >= 100, `the streak reaches 100 px each side: ${left}, ${right}`);
    assert.equal(away, 0, 'rows away from the box are unchanged');
    assert.equal(highDiff, 0, 'nothing above the threshold equals the effect disabled');
  },
);
