// Real-GPU check of Blur, built packages. A light box and a dark box meet in a vertical edge facing the camera. A box
// blur of radius r changes exactly the pixels whose window crosses the edge: 2 r on each middle row (one more if the
// edge pixel itself is a mix), all within r + 1 of the edge, and flat faces keep their colour. The rows are read within
// 3 r of that edge: the boxes' outer edges against the background blur too, 85 px away. With `region` the top
// half of the view, the bottom half equals the frame without the blur to the bit. Radius 0 equals disabled exactly.
import assert from 'node:assert/strict';
import { launchBrowser } from '../../../scripts/lib/browser.mjs';
import { postBrowser } from './post-browser.mjs';

const R = 6;
await postBrowser(
  'post-blur',
  5363,
  () => launchBrowser({ headless: true }),
  async (page, shot) => {
    await page.evaluate(async (radius) => {
      const { Engine, PbrMaterial, box } = await import('/packages/core/dist/index.js'),
        { PostStack } = await import('/packages/post/dist/stack.js'),
        { Blur } = await import('/packages/post/dist/blur.js');
      const canvas = document.querySelector('canvas'),
        engine = await Engine.create(canvas, { backend: 'webgpu', camera: { position: [0, 0, 5], target: [0, 0, 0] } });
      engine.stop();
      for (const [x, color] of [
        [-1, '#d0d0d0'],
        [1, '#303030'],
      ])
        engine
          .createMesh()
          .setGeometry(box(2, 2, 0.2))
          .setPosition([x, 0, 0])
          .setMaterial(new PbrMaterial({ color, roughness: 1 }));
      const effect = new Blur({ kind: 'box', radius });
      PostStack.attach(engine, [effect]);
      window.t = {
        engine,
        effect,
        frame: () => (engine.render({ delta: 1 / 60 }), engine.gpu.queue.onSubmittedWorkDone()),
      };
    }, R);
    const frame = async (set) => {
      await page.evaluate(`(${set})(window.t.effect.options); window.t.frame()`);
      await page.evaluate(() => window.t.engine.gpu.queue.onSubmittedWorkDone());
      return shot();
    };
    const on = await frame('() => {}');
    const off = await frame('(o) => { o.enabled = false; }');
    const zero = await frame('(o) => { o.enabled = true; o.radius = 0; }');
    const top = await frame(`(o) => { o.radius = ${R}; o.region = [0, 0, 1, 0.5]; }`);
    const at = (img, x, y, c) => img.data[4 * (y * img.width + x) + c];
    const changed = (a, b, x, y) => [0, 1, 2].some((c) => Math.abs(at(a, x, y, c) - at(b, x, y, c)) > 2);
    // The edge: the largest step between neighbours on row 120 without the blur.
    let edge = 0,
      step = 0;
    for (let x = 100; x < 220; x++) {
      const d = Math.abs(at(off, x + 1, 120, 0) - at(off, x, 120, 0));
      if (d > step) {
        step = d;
        edge = x + 1;
      }
    }
    const spans = [110, 120, 130].map((y) => {
      const xs = [];
      for (let x = edge - 3 * R; x < edge + 3 * R; x++) if (changed(on, off, x, y)) xs.push(x);
      return xs;
    });
    let bottom = 0,
      zeroDiff = 0;
    for (let y = 120; y < 240; y++)
      for (let x = 0; x < 320; x++)
        for (let c = 0; c < 4; c++) bottom = Math.max(bottom, Math.abs(at(top, x, y, c) - at(off, x, y, c)));
    for (let i = 0; i < off.data.length; i++) zeroDiff = Math.max(zeroDiff, Math.abs(zero.data[i] - off.data[i]));
    const topSpan = [];
    for (let x = edge - 3 * R; x < edge + 3 * R; x++) if (changed(top, off, x, 100)) topSpan.push(x);
    console.log(
      JSON.stringify({
        edge,
        step,
        spans: spans.map((s) => [s.length, s[0], s.at(-1)]),
        bottom,
        zeroDiff,
        top: topSpan.length,
      }),
    );
    await page.evaluate(() => window.t.engine.dispose());
    assert.ok(step > 100, `a sharp edge without the blur: ${step}`);
    for (const s of spans) {
      assert.ok(s.length >= 2 * R && s.length <= 2 * R + 1, `2r (+1) pixels change on a middle row: ${s.length}`);
      assert.ok(s[0] >= edge - R - 1 && s.at(-1) <= edge + R, `all within r + 1 of the edge: ${s[0]}..${s.at(-1)}`);
    }
    assert.ok(topSpan.length >= 2 * R, `inside the region the edge blurs: ${topSpan.length}`);
    assert.equal(bottom, 0, 'outside the region the frame is untouched');
    assert.equal(zeroDiff, 0, 'radius 0 equals disabled');
  },
);
