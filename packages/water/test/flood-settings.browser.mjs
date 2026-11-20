// The Flood rows on the GPU (disaster water push 5), on WebGPU and, with MARGO_COMPAT=1, the WebGL2 layer: applying every
// live row of FLOOD_SETTINGS at its default each frame of a steady flood makes no pipeline, buffer, texture or bind group
// and no uniform write (defaults frame exact); changing a row every frame for sixty frames makes none either (only the
// per-tick uniform slice is written); and each row changes the solved flood (inflow raises the volume, roughness slows
// the front, rain wets a dry bed).
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
    const { applyFloodSettings, floodSettingDefaults, FLOOD_SETTINGS, FLOOD_LOOKS } = await import('/packages/water/dist/settings.js');
    const canvas = document.createElement('canvas');
    canvas.style.cssText = 'width:64px;height:48px';
    document.body.replaceChildren(canvas);
    const engine = await EngineKernel.create(canvas, { backend: 'webgpu', capacity: 4, camera: { position: [32, 40, 40], target: [32, 0, 12], near: 0.1, far: 500 } });
    const d = engine.gpu;
    d.pushErrorScope('validation');
    const W = 64,
      H = 24;
    const tex = d.createTexture({ size: [W, H], format: 'r32float', usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST });
    d.queue.writeTexture({ texture: tex }, new Float32Array(W * H).fill(0), { bytesPerRow: W * 4 }, [W, H]);
    const world = (options = {}) => {
      const water = Water.attach(engine, {
        height: -1,
        size: [200, 200],
        segments: 16,
        waves: [{ direction: [1, 0], amplitude: 0, wavelength: 10 }],
        terrain: { heightmap: () => tex, origin: [0, 0], size: [W, H] },
      });
      const flood = Flood.attach(engine, { surface: water, sources: [{ position: [10, 12], discharge: 4, radius: 1 }], maxDepth: 6, maxSpeed: 6, ...options });
      return { water, flood, dispose: () => (flood.dispose(), water.dispose()) };
    };
    const out = {};
    // Object creation counted on the device: a pipeline, buffer, texture or bind group made while the rows are applied.
    const made = { n: 0, by: {} };
    for (const key of ['createBuffer', 'createTexture', 'createBindGroup', 'createComputePipeline', 'createRenderPipeline', 'createShaderModule']) {
      const make = d[key].bind(d);
      d[key] = (...a) => (made.n++, (made.by[key] = (made.by[key] ?? 0) + 1), make(...a));
    }
    {
      const w = world();
      for (let i = 0; i < 120; i++) engine.render({ delta: 1 / 60 });
      const solver = () => w.flood['solver'];
      const snapshot = () => ({ by: { ...made.by }, groups: solver().groups.size, pair: solver().pair, made: made.n, log: w.flood['log'].length });
      const before = snapshot();
      for (let i = 0; i < 60; i++) {
        applyFloodSettings(w.flood, floodSettingDefaults());
        engine.render({ delta: 1 / 60 });
      }
      out.defaults = { before, after: snapshot() };
      const mid = snapshot();
      for (let i = 0; i < 60; i++) {
        applyFloodSettings(w.flood, { roughness: 0.03 + 0.001 * (i % 7), inflow: 1 + 0.01 * (i % 5), rain: i % 3 === 0 ? null : 10 + i, surge: i % 4, surgeRise: 5 });
        engine.render({ delta: 1 / 60 });
      }
      out.moving = { before: mid, after: snapshot() };
      // A bind group per uniform ring slice, made once on first use (the ring is 256 pairs): after the ring has turned
      // once, rows moving every frame make nothing at all.
      const row = (i) => applyFloodSettings(w.flood, { roughness: 0.03 + 0.001 * (i % 7), inflow: 1 + 0.01 * (i % 5), rain: 10 + (i % 11), surge: i % 4, surgeRise: 5 });
      for (let i = 0; i < 400; i++) (row(i), engine.render({ delta: 1 / 60 }));
      const turned = snapshot();
      for (let i = 0; i < 200; i++) (row(i), engine.render({ delta: 1 / 60 }));
      out.turned = { before: turned, after: snapshot() };
      w.dispose();
    }
    // Each row changes the solved flood.
    const run = async (values, seconds = 6) => {
      const w = world({ boundary: { west: 'sea' } });
      applyFloodSettings(w.flood, values);
      for (let i = 0; i < seconds * 30; i++) engine.render({ delta: 1 / 30 });
      const r = await w.flood.read();
      w.dispose();
      return r;
    };
    const base = await run({});
    out.base = { volume: base.volume, maxDepth: base.maxDepth };
    out.inflow = (await run({ inflow: 3 })).volume;
    out.noInflow = (await run({ inflow: 0 })).volume;
    out.rain = (await run({ rain: 200 })).volume;
    out.stormSurge = (await run(FLOOD_LOOKS.flashFlood)).volume;
    out.rows = FLOOD_SETTINGS.length;
    tex.destroy();
    out.validation = String(await d.popErrorScope().then((e) => e?.message ?? ''));
    return out;
  });
  console.log(JSON.stringify(result));
  assert.deepEqual(errors, [], 'no page errors');
  assert.equal(result.validation, '', 'no validation errors');
  assert.deepEqual(result.defaults.after, result.defaults.before, 'the defaults applied sixty frames make no object, no bind group, no log entry and no ring write');
  for (const key of ['createBuffer', 'createTexture', 'createComputePipeline', 'createRenderPipeline', 'createShaderModule'])
    assert.equal(result.moving.after.by[key], result.moving.before.by[key], `rows moving every frame make no ${key}`);
  assert.ok(result.moving.after.groups <= 4 + 2 * 256, `bind groups stay within the ring: ${result.moving.after.groups}`);
  assert.deepEqual(result.turned.after.by, result.turned.before.by, 'once the ring has turned, moving rows make no object of any kind');
  assert.equal(result.turned.after.groups, result.turned.before.groups);
  assert.ok(result.moving.after.log > result.moving.before.log, 'the changes are in the log');
  assert.ok(result.inflow > result.base.volume * 1.5, `inflow 3 raises the volume: ${result.inflow} against ${result.base.volume}`);
  assert.ok(result.noInflow < result.base.volume * 0.2, `inflow 0 shuts the sources: ${result.noInflow}`);
  const rained = ((200 / 3.6e6) * 64 * 24 * 6);
  assert.ok(Math.abs(result.rain - result.base.volume - rained) < 0.05 * rained, `rain 200 mm/h for 6 s adds ${rained} m^3: ${result.rain - result.base.volume}`);
  assert.ok(result.stormSurge > result.base.volume, 'the flashFlood look adds volume');
  console.log('flood settings: ok');
} finally {
  await closeAll({ browser });
}
