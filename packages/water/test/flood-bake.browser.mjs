// FG-03 on the GPU, WebGPU and (MARGO_COMPAT=1) the WebGL2 layer: bakeFlood yields a frame at each time from `from` to
// `to` at `fps`, and each frame equals a live run read at the same flood time, bit for bit (a dam break on a strip of
// 64 x 4 cells of 1 m, so the depth, the current and the foam all change between frames). An aborted bake stops.
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
process.chdir(fileURLToPath(new URL('../../../', import.meta.url)));
import { openBrowser } from '../../../scripts/browser.js';
import { closeAll } from '../../../scripts/support/shutdown.mjs';

const browser = await openBrowser({ port: 'free', startPath: '/tests/modern-game.html' }),
  { page } = browser,
  errors = [];
page.on('pageerror', (error) => errors.push(error.message));
page.on('console', (message) => {
  if (message.type() === 'error') errors.push(message.text());
});
try {
  const result = await page.evaluate(async () => {
    const { EngineKernel } = await import('/packages/core/dist/index.js');
    const { Water } = await import('/packages/water/dist/index.js');
    const { Flood } = await import('/packages/water/dist/flood.js');
    const { bakeFlood, encodeFloodEXR } = await import('/packages/water/dist/flood-bake.js');
    const canvas = document.createElement('canvas');
    document.body.replaceChildren(canvas);
    const engine = await EngineKernel.create(canvas, {
      backend: 'webgpu',
      capacity: 4,
      camera: { position: [32, 40, 30], target: [32, 0, 2], near: 0.1, far: 500 },
    });
    const d = engine.gpu,
      n = 64,
      rows = 4,
      terrain = d.createTexture({
        size: [n, rows],
        format: 'r32float',
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
      });
    d.queue.writeTexture({ texture: terrain }, new Float32Array(n * rows).fill(-1), { bytesPerRow: n * 4 }, [n, rows]);
    const make = () => {
      const water = Water.attach(engine, {
        height: -1,
        size: [200, 200],
        segments: 16,
        waves: [{ direction: [1, 0], amplitude: 0, wavelength: 10 }],
        terrain: { heightmap: () => terrain, origin: [0, 0], size: [n, rows] },
        fill: (x) => (x < 16 ? 1 : 0),
      });
      const flood = Flood.attach(engine, { surface: water, maxDepth: 3, maxSpeed: 8, roughness: 0.02 });
      engine.render({ delta: 0 });
      return { water, flood };
    };
    const pick = (r) => ({
      time: r.time,
      depth: Array.from(r.depth),
      velocity: Array.from(r.velocity),
      foam: Array.from(r.foam),
      breaker: Array.from(r.breaker),
    });
    // Live: a render loop of 0.25 s frames, read after each.
    const live = [];
    {
      const { water, flood } = make();
      await flood.settle();
      live.push(pick(await flood.read()));
      for (let i = 1; i <= 12; i++) {
        engine.render({ delta: 0.25 });
        await flood.settle();
        live.push(pick(await flood.read()));
      }
      flood.dispose();
      water.dispose();
    }
    // Baked: 0 to 3 s at 4 fps.
    const baked = [];
    let exr = 0;
    {
      const { water, flood } = make();
      for await (const frame of bakeFlood(flood, { to: 3, fps: 4 })) {
        baked.push({ index: frame.index, at: frame.time, ...pick(frame.reading) });
        if (frame.index === 6) exr = (await encodeFloodEXR(frame.reading)).length;
      }
      flood.dispose();
      water.dispose();
    }
    // Aborted after two frames.
    let aborted = '',
      seen = 0;
    {
      const { water, flood } = make(),
        stop = new AbortController();
      try {
        for await (const frame of bakeFlood(flood, { to: 3, fps: 4, signal: stop.signal })) {
          seen = frame.index + 1;
          if (seen === 2) stop.abort(new Error('bake stopped'));
        }
      } catch (error) {
        aborted = error.message;
      }
      const ranges = [];
      for (const bad of [{ to: 1, fps: 0 }, { to: -1 }, { from: -1, to: 1 }])
        try {
          await bakeFlood(flood, bad).next();
        } catch (error) {
          ranges.push(error.name);
        }
      flood.dispose();
      water.dispose();
      terrain.destroy();
      return { live, baked, exr, aborted, seen, ranges };
    }
  });
  assert.deepEqual(errors, [], 'no page errors');
  const { live, baked } = result;
  assert.equal(baked.length, 13, 'frames 0 to 3 s at 4 fps');
  baked.forEach((b, i) => {
    assert.equal(b.index, i);
    assert.equal(b.at, i / 4);
    assert.equal(b.time, live[i].time, `frame ${i}: the flood time`);
    for (const key of ['depth', 'velocity', 'foam', 'breaker'])
      assert.deepEqual(b[key], live[i][key], `frame ${i}: ${key} bit for bit`);
  });
  assert.notDeepEqual(baked[12].depth, baked[0].depth, 'the dam break moved between the first and last frame');
  assert.ok(Math.max(...baked[4].foam) > 0, 'the front carries foam');
  assert.ok(result.exr > 64 * 4 * 6 * 4, `an EXR of six float channels: ${result.exr} B`);
  assert.equal(result.aborted, 'bake stopped');
  assert.equal(result.seen, 2);
  assert.deepEqual(result.ranges, ['RangeError', 'RangeError', 'RangeError']);
  console.log('flood bake: ok');
} finally {
  await closeAll({ browser });
}
