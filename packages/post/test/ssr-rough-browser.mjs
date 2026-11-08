// Real-GPU check of SSR's stochastic rough reflections, built packages. A rough metal floor (roughness 0.8, above
// maxRoughness 0.6) with a white box standing on it under the default sun. Without `stochastic` the rough floor is
// skipped: the frame equals SSR disabled exactly. With it the box's reflection shows on the floor, and the temporal
// denoise settles: after 64 frames of a still camera one more frame changes the image far less than the second frame
// did. Switching `stochastic` off again gives the first frame back exactly.
import assert from 'node:assert/strict';
import { launchBrowser } from '../../../scripts/lib/browser.mjs';
import { postBrowser } from './post-browser.mjs';

await postBrowser(
  'post-ssr-rough',
  5365,
  () => launchBrowser({ headless: true }),
  async (page, shot) => {
    await page.evaluate(async () => {
      const { Engine, PbrMaterial, box } = await import('/packages/core/dist/index.js'),
        { PostStack } = await import('/packages/post/dist/stack.js'),
        { SSR } = await import('/packages/post/dist/ssr.js');
      const canvas = document.querySelector('canvas'),
        engine = await Engine.create(canvas, {
          backend: 'webgpu',
          camera: { position: [0, 1.2, 4], target: [0, 0.3, 0] },
        });
      engine.stop();
      engine
        .createMesh()
        .setGeometry(box(8, 0.2, 8))
        .setPosition([0, -0.1, 0])
        .setMaterial(new PbrMaterial({ color: '#c0c0c0', roughness: 0.8, metalness: 1 }));
      engine
        .createMesh()
        .setGeometry(box(1, 1, 1))
        .setPosition([0, 0.5, -0.5])
        .setMaterial(new PbrMaterial({ color: '#ffffff', roughness: 1 }));
      const ssr = new SSR({ maxRoughness: 0.6 });
      PostStack.attach(engine, [ssr]);
      window.t = {
        engine,
        ssr,
        frames: async (n) => {
          for (let i = 0; i < n; i++) engine.render({ delta: 1 / 60 });
          await engine.gpu.queue.onSubmittedWorkDone();
        },
      };
    });
    const frames = async (n, code = '') => {
      await page.evaluate(`${code}; window.t.frames(${n})`);
      return shot();
    };
    const off = await frames(2),
      disabled = await frames(2, 'window.t.ssr.enabled = false'),
      one = await frames(1, 'window.t.ssr.enabled = true; window.t.ssr.options.stochastic = true'),
      two = await frames(1),
      many = await frames(62),
      next = await frames(1),
      back = await frames(2, 'window.t.ssr.options.stochastic = false');
    await page.evaluate(() => window.t.engine.dispose());
    const luma = (d, i) => 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
    /** Mean absolute channel difference, largest channel difference and pixels brighter by more than 4/255 in luma. */
    const compare = (a, b) => {
      let sum = 0,
        most = 0,
        brighter = 0;
      for (let i = 0; i < a.data.length; i += 4) {
        for (let c = 0; c < 3; c++) {
          const change = Math.abs(a.data[i + c] - b.data[i + c]);
          sum += change;
          most = Math.max(most, change);
        }
        if (luma(a.data, i) - luma(b.data, i) > 4) brighter++;
      }
      return { mean: sum / ((a.data.length / 4) * 3), most, brighter };
    };
    const result = {
      disabled: compare(disabled, off),
      reflected: compare(many, off),
      first: compare(two, one),
      settled: compare(next, many),
      back: compare(back, off),
    };
    console.log(JSON.stringify(result));
    assert.equal(result.disabled.most, 0, 'without stochastic a rough floor is skipped: equals SSR disabled');
    assert.ok(result.reflected.brighter > 500, 'the box shows in the rough floor');
    assert.ok(result.first.mean > 4 * result.settled.mean, 'the temporal denoise settles');
    assert.equal(result.back.most, 0, 'switching stochastic off gives the deterministic frame back');
  },
);
