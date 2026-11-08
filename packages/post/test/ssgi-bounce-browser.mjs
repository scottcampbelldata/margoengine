// Real-GPU check of SSGI's multi-bounce mode, built packages. A white room open toward the camera, its ceiling over the
// back half only, under the default sun. One bounce first; then `multiBounce`: each frame the rays read the light
// they hit from the previous result, so the room fills with more light, and with a still camera the frames settle.
// Switching it off gives the one-bounce frame back exactly.
import assert from 'node:assert/strict';
import { launchBrowser } from '../../../scripts/lib/browser.mjs';
import { postBrowser } from './post-browser.mjs';

await postBrowser(
  'post-ssgi-bounce',
  5366,
  () => launchBrowser({ headless: true }),
  async (page, shot) => {
    await page.evaluate(async () => {
      const { Engine, PbrMaterial, box } = await import('/packages/core/dist/index.js'),
        { PostStack } = await import('/packages/post/dist/stack.js'),
        { SSGI } = await import('/packages/post/dist/ssgi.js');
      const canvas = document.querySelector('canvas'),
        engine = await Engine.create(canvas, {
          backend: 'webgpu',
          camera: { position: [0, 1.6, 5.5], target: [0, 1.2, -1] },
        });
      engine.stop();
      const white = new PbrMaterial({ color: '#e0e0e0', roughness: 1 });
      for (const [size, position] of [
        [
          [6, 0.2, 6],
          [0, -0.1, 0],
        ], // floor
        [
          [6, 3, 0.2],
          [0, 1.5, -3.1],
        ], // back wall
        [
          [0.2, 3, 6],
          [-3.1, 1.5, 0],
        ], // left wall
        [
          [0.2, 3, 6],
          [3.1, 1.5, 0],
        ], // right wall
        [
          [6.4, 0.2, 3],
          [0, 3.1, -1.6],
        ], // ceiling over the back half
      ])
        engine
          .createMesh()
          .setGeometry(box(...size))
          .setPosition(position)
          .setMaterial(white);
      const ssgi = new SSGI({ rays: 4 });
      PostStack.attach(engine, [ssgi]);
      window.t = {
        engine,
        ssgi,
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
    const single = await frames(2),
      one = await frames(1, 'window.t.ssgi.options.multiBounce = true'),
      two = await frames(1),
      many = await frames(40),
      next = await frames(1),
      back = await frames(2, 'window.t.ssgi.options.multiBounce = false');
    await page.evaluate(() => window.t.engine.dispose());
    const luma = (d, i) => 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
    /** Mean luma change b - a, mean absolute channel change, largest channel change, pixels brighter by over 2/255. */
    const compare = (a, b) => {
      let gain = 0,
        sum = 0,
        most = 0,
        brighter = 0;
      const n = a.data.length / 4;
      for (let i = 0; i < a.data.length; i += 4) {
        const change = luma(b.data, i) - luma(a.data, i);
        gain += change;
        if (change > 2) brighter++;
        for (let c = 0; c < 3; c++) {
          const d = Math.abs(a.data[i + c] - b.data[i + c]);
          sum += d;
          most = Math.max(most, d);
        }
      }
      return { gain: gain / n, mean: sum / (n * 3), most, brighter };
    };
    const result = {
      first: compare(single, one),
      filled: compare(single, many),
      early: compare(one, two),
      settled: compare(many, next),
      back: compare(single, back),
    };
    console.log(JSON.stringify(result));
    assert.ok(
      result.first.most <= 1,
      'the first multi-bounce frame has no history: one bounce (an rgba16float step between)',
    );
    assert.ok(result.filled.gain > 1 && result.filled.brighter > 2000, 'more bounces fill the room with light');
    assert.ok(result.settled.mean < result.early.mean / 4, 'a still view settles');
    assert.equal(result.back.most, 0, 'switching multiBounce off gives the one-bounce frame back exactly');
  },
);
