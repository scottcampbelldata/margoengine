// Real-GPU check of TrailTexture, built packages (WebGPU, or the WebGL2 layer with --compat). The trail is read back
// texel by texel: a fast move leaves an unbroken line, stamps combine by their blend, the trail fades by `decay` per
// 1/60 s and reaches exactly 0, and nothing is painted off the stroke.
import assert from 'node:assert/strict';
import { launchBrowser } from '../../../scripts/lib/browser.mjs';
import { postBrowser } from './post-browser.mjs';
import { compatRun } from '../../../scripts/support/compat-shim.js';

const N = 64;
await postBrowser(
  'post-trail' + (compatRun() ? '-compat' : ''),
  compatRun() ? 5419 : 5418,
  () => launchBrowser({ headless: true }),
  async (page) => {
    await page.evaluate(async () => {
      const { Engine } = await import('/packages/core/dist/index.js');
      const { TrailTexture } = await import('/packages/post/dist/trail.js');
      const engine = await Engine.create(document.querySelector('canvas'), { backend: 'webgpu' });
      engine.stop();
      const half = (h) => {
        const e = (h >> 10) & 31,
          m = h & 1023,
          v = e === 0 ? m * 2 ** -24 : (1 + m / 1024) * 2 ** (e - 15);
        return h & 0x8000 ? -v : v;
      };
      const read = async (trail) => {
        const device = engine.gpu,
          n = trail.width,
          buffer = device.createBuffer({ size: n * n * 8, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ }),
          encoder = device.createCommandEncoder();
        encoder.copyTextureToBuffer({ texture: trail.texture }, { buffer, bytesPerRow: n * 8 }, [n, n]);
        device.queue.submit([encoder.finish()]);
        await buffer.mapAsync(GPUMapMode.READ);
        const bits = new Uint16Array(buffer.getMappedRange().slice(0));
        buffer.destroy();
        return Array.from({ length: n * n }, (_, i) => half(bits[i * 4]));
      };
      const frame = async (delta = 1 / 60) => {
        engine.render({ delta });
        await engine.gpu.queue.onSubmittedWorkDone();
      };
      window.t = { engine, TrailTexture, read, frame };
    });
    const run = (body, arg) => page.evaluate(body, arg);

    // A move across the texture in one frame: an unbroken line along its row, black away from it.
    const line = await run(async (n) => {
      const { engine, TrailTexture, read, frame } = window.t;
      const trail = TrailTexture.attach(engine, { size: n, radius: 0.08, speed: 0, blend: 'max' });
      trail.move(0.1, 0.5);
      trail.move(0.9, 0.5);
      await frame();
      const first = await read(trail);
      // fixed-wait: the decay clock: 60 frames of 1/60 s are the second the assert measures
      for (let i = 0; i < 60; i++) await frame();
      const second = await read(trail);
      // fixed-wait: the decay clock: four more seconds, long enough for the trail to reach black
      for (let i = 0; i < 240; i++) await frame();
      const third = await read(trail);
      trail.dispose();
      return { first, second, third };
    }, N);
    const at = (image, x, y) => image[y * N + x];
    const row = N / 2;
    const ridge = [];
    for (let x = Math.ceil(0.1 * N); x < 0.9 * N; x++)
      ridge.push(Math.max(at(line.first, x, row - 1), at(line.first, x, row)));
    const low = Math.min(...ridge);
    assert.ok(low > 0.8, `the line has no gaps: its faintest texel is ${low}`);
    assert.equal(at(line.first, N / 2, 4), 0, 'nothing painted away from the stroke');
    assert.ok(Math.max(...line.first) <= 1, "'max' never goes past one stamp");
    // 60 frames of 1/60 s at decay 0.95 keep 0.95^60 of each texel, within float16 rounding of 60 multiplications.
    const peak = Math.max(...line.first),
      kept = Math.max(...line.second) / peak;
    assert.ok(Math.abs(kept / 0.95 ** 60 - 1) < 0.05, `one second keeps ${kept}, expected ${0.95 ** 60}`);
    assert.equal(Math.max(...line.third), 0, 'the trail reaches black');

    // Two half stamps at one place: 'screen' gives 1 - 0.5 x 0.5, 'add' gives their sum.
    const blends = await run(async (n) => {
      const { engine, TrailTexture, read, frame } = window.t,
        out = {};
      for (const blend of ['screen', 'add']) {
        const trail = TrailTexture.attach(engine, { size: n, radius: 0.1, blend, decay: 1 });
        // A texel centre: the falloff is 1 there.
        const c = (n / 2 + 0.5) / n;
        trail.stamp(c, c, 0.5);
        trail.stamp(c, c, 0.5);
        await frame();
        out[blend] = (await read(trail))[(n / 2) * n + n / 2];
        trail.dispose();
      }
      return out;
    }, N);
    assert.ok(Math.abs(blends.screen - 0.75) < 2e-3, `screen ${blends.screen}`);
    assert.ok(Math.abs(blends.add - 1) < 2e-3, `add ${blends.add}`);
    await run(() => window.t.engine.dispose());
  },
);
console.log('post trail: ok');
