import assert from 'node:assert/strict';
import { launchBrowser } from '../../../scripts/lib/browser.mjs';
import { postBrowser } from './post-browser.mjs';
await postBrowser(
  'post-stylize',
  5385,
  () => launchBrowser({ headless: true }),
  async (page, shot) => {
    await page.evaluate(async () => {
      const { Engine, PbrMaterial, box } = await import('/packages/core/dist/index.js');
      const { Stylize } = await import('/packages/post/dist/stylize.js');
      const engine = await Engine.create(document.querySelector('canvas'), {
        backend: 'webgpu',
        camera: { position: [0, 0, 5], target: [0, 0, 0] },
      });
      engine.stop();
      engine
        .createMesh()
        .setGeometry(box(8, 8, 0.1))
        .setMaterial(new PbrMaterial({ color: '#707070' }));
      for (const x of [-1.5, -1, -0.5, 0, 0.5, 1, 1.5])
        engine
          .createMesh()
          .setGeometry(box(0.08, 8, 0.1))
          .setPosition([x, 0, 0.1])
          .setMaterial(new PbrMaterial({ color: '#ffffff' }));
      const effect = Stylize.attach(engine, { scanlines: 0, noise: 0, time: 0, shockWave: false });
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
    const plain = await frame({}),
      scan = await frame({ scanlines: 0.5 }),
      noise = await frame({ scanlines: 0, noise: 0.2 }),
      repeat = await frame({}),
      next = await frame({ time: 1 });
    assert.deepEqual(noise.data, repeat.data);
    assert.notDeepEqual(noise.data, next.data);
    const quantized = await frame({ noise: 0, colorDepth: 2 });
    for (let i = 0; i < quantized.data.length; i++)
      if (i % 4 !== 3) assert.ok([0, 85, 170, 255].includes(quantized.data[i]));
    const wave = await frame({ colorDepth: 8, shockWave: { radius: 0.3, waveSize: 0.15, amplitude: 0.1 } });
    let scanRows = 0,
      inside = 0,
      outside = 0,
      noisy = 0;
    for (let y = 0; y < 240; y++)
      for (let x = 0; x < 320; x++) {
        const i = 4 * (y * 320 + x);
        if (x === 10 && scan.data[i] !== scan.data[i + 4 * 320] && y < 239) scanRows++;
        if (noise.data[i] !== plain.data[i]) noisy++;
        if (wave.data[i] !== plain.data[i]) {
          const d = Math.hypot((x + 0.5 - 160) / 240, (y + 0.5 - 120) / 240);
          if (d > 0.15 && d < 0.45) inside++;
          else outside++;
        }
      }
    const off = await frame({ enabled: false });
    assert.deepEqual(off.data, plain.data);
    console.log({ scanRows, noisy, inside, outside });
    assert.ok(scanRows > 200);
    assert.ok(noisy > 50000);
    assert.ok(inside > 1000);
    assert.equal(outside, 0);
    await page.evaluate(() => window.t.engine.dispose());
  },
);
