// Real-GPU check of Lens, built packages. Two thin white bars, left and right of the middle, in a dark frame. Barrel
// distortion moves the right bar on the middle row to where the mapping c + (p - c) (1 + k r^2) s predicts (within a
// pixel). With a dirt image white on its left half and black on its right, the bars' glow brightens the dark frame
// around the left bar, while the right half (black dirt) equals the frame without the effect to the bit. A threshold
// above everything, and distortion 0 with no dirt, equal the effect disabled exactly.
import assert from 'node:assert/strict';
import { launchBrowser } from '../../../scripts/lib/browser.mjs';
import { postBrowser } from './post-browser.mjs';

const K = 0.3;
await postBrowser(
  'post-lens',
  5364,
  () => launchBrowser({ headless: true }),
  async (page, shot) => {
    await page.evaluate(async () => {
      const { Engine, PbrMaterial, box } = await import('/packages/core/dist/index.js'),
        { PostStack } = await import('/packages/post/dist/stack.js'),
        { Lens } = await import('/packages/post/dist/lens.js');
      const canvas = document.querySelector('canvas'),
        engine = await Engine.create(canvas, { backend: 'webgpu', camera: { position: [0, 0, 5], target: [0, 0, 0] } });
      engine.stop();
      for (const x of [-1, 1])
        engine
          .createMesh()
          .setGeometry(box(0.08, 3, 0.08))
          .setPosition([x, 0, 0])
          .setMaterial(new PbrMaterial({ color: '#ffffff' }));
      // 64 by 1 texels: white on the left 32, black on the right 32.
      const dirt = engine.gpu.createTexture({ size: [64, 1], format: 'rgba8unorm', usage: 0x4 | 0x2 }),
        texels = new Uint8Array(64 * 4);
      for (let i = 0; i < 32; i++) texels.set([255, 255, 255, 255], 4 * i);
      for (let i = 32; i < 64; i++) texels.set([0, 0, 0, 255], 4 * i);
      engine.gpu.queue.writeTexture({ texture: dirt }, texels, { bytesPerRow: 256 }, [64, 1]);
      const effect = new Lens({ dirtIntensity: 0 });
      PostStack.attach(engine, [effect]);
      window.t = {
        engine,
        effect,
        dirt,
        frame: () => (engine.render({ delta: 1 / 60 }), engine.gpu.queue.onSubmittedWorkDone()),
      };
    });
    const frame = async (set) => {
      await page.evaluate(`(${set})(window.t.effect.options, window.t.dirt); window.t.frame()`);
      await page.evaluate(() => window.t.engine.gpu.queue.onSubmittedWorkDone());
      return shot();
    };
    const plain = await frame('() => {}');
    const off = await frame('(o) => { o.enabled = false; }');
    const barrel = await frame(`(o) => { o.enabled = true; o.distortion = ${K}; }`);
    const dirty = await frame('(o, d) => { o.distortion = 0; o.dirt = d; o.dirtIntensity = 4; o.threshold = 0.4; }');
    const high = await frame('(o) => { o.threshold = 1000; }');
    const smudged = await frame('(o) => { o.threshold = 0.4; o.dirt = undefined; }');
    const { width: w, height: h } = off;
    const at = (img, x, y, c) => img.data[4 * (y * img.width + x) + c];
    const luma = (img, x, y) => at(img, x, y, 0) + at(img, x, y, 1) + at(img, x, y, 2);
    const maxDiff = (a, b, x0 = 0) => {
      let m = 0;
      for (let y = 0; y < h; y++)
        for (let x = x0; x < w; x++)
          for (let c = 0; c < 4; c++) m = Math.max(m, Math.abs(at(a, x, y, c) - at(b, x, y, c)));
      return m;
    };
    // The right bar's centre on the middle row: the luma-weighted mean x of the bright pixels right of the middle.
    const bar = (img) => {
      let sum = 0,
        weight = 0;
      for (let x = w / 2 + 4; x < w; x++) {
        const l = luma(img, x, h / 2);
        if (l > 150) (sum += l * x), (weight += l);
      }
      return sum / weight;
    };
    // Where barrel output pixel x reads from: the shader's mapping on the middle row (r from the centre in view heights).
    const aspect = w / h,
      fit = 1 / (1 + (K * (aspect * aspect + 1)) / 4),
      source = (x) => {
        const u = (x + 0.5) / w,
          d = (u - 0.5) * aspect;
        return (0.5 + (u - 0.5) * (1 + K * d * d) * fit) * w - 0.5;
      };
    const before = bar(off),
      after = bar(barrel);
    let predicted = w / 2;
    while (source(predicted) < before) predicted += 0.01;
    // Glow on the dark background (luma under 100; the bars are over 600) left of the middle, where the dirt is white.
    let lit = 0;
    for (let y = 40; y < h - 40; y++)
      for (let x = 8; x < w / 2 - 8; x++) if (luma(dirty, x, y) > luma(off, x, y) + 3 && luma(off, x, y) < 100) lit++;
    let smudge = 0;
    for (let i = 0; i < smudged.data.length; i++) smudge = Math.max(smudge, smudged.data[i] - off.data[i]);
    const result = { before, after, predicted, lit, right: maxDiff(dirty, off, w / 2 + 8), high: maxDiff(high, off) };
    console.log(JSON.stringify({ ...result, plain: maxDiff(plain, off), smudge }));
    await page.evaluate(() => window.t.engine.dispose());
    assert.ok(Math.abs(after - predicted) < 1, `the bar moves where the mapping says: ${after} vs ${predicted}`);
    assert.ok(after - before > 3, `barrel pushes the bar outward from the middle: ${before} to ${after}`);
    assert.ok(lit > 500, `the dirt lights up around the bright bar: ${lit} pixels`);
    assert.equal(result.right, 0, 'black dirt adds nothing');
    assert.equal(result.high, 0, 'a threshold above everything equals disabled');
    assert.equal(maxDiff(plain, off), 0, 'no distortion and no dirt equals disabled');
    assert.ok(smudge > 5, `the built-in dirt shows around the bars: ${smudge}`);
  },
);
