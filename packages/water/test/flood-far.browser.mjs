// The open sea past a flood's sea side (FG-05, FG-06), on WebGPU and, with MARGO_COMPAT=1, the WebGL2 layer. The
// Doggerland film's tsunami (a 42 m trough-first N-wave of 260 s) comes in through the west side of 128 x 4 cells of 8 m
// over 40 m of still water, east side open. Measured with WaveQuery on the drawn surface:
//  - far out (2 km past the side) the drawn sea is the wave that reaches the edge r / c seconds later (c = sqrt(g d)), plus
//    the sim's edge offset spread as 1 / sqrt(1 + r / L), within 0.2 m (FG-05: the open sea used to be one flat level);
//  - just past the side the drawn sea meets the sim's edge cell within 0.6 m all through the trough, where the side lets
//    in only 5/9 of the depth (FG-01) and the flat sea stood up to 20 m below it (FG-06; measured again with farField null).
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
    const { WaveQuery } = await import('/packages/water/dist/query.js');
    const canvas = document.createElement('canvas');
    canvas.style.cssText = 'width:64px;height:48px';
    document.body.replaceChildren(canvas);
    const engine = await EngineKernel.create(canvas, {
      backend: 'webgpu',
      capacity: 4,
      camera: { position: [-500, 300, 200], target: [0, 0, 16], near: 0.1, far: 10000 },
    });
    const d = engine.gpu;
    d.pushErrorScope('validation');
    const n = 128,
      rows = 4,
      dx = 8,
      D = 40,
      terrain = d.createTexture({
        size: [n, rows],
        format: 'r32float',
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
      });
    d.queue.writeTexture({ texture: terrain }, new Float32Array(n * rows).fill(-D), { bytesPerRow: n * 4 }, [n, rows]);
    const run = async (farField) => {
      const water = Water.attach(engine, {
        height: 0,
        size: [6000, 200],
        segments: 512,
        waves: [{ direction: [1, 0], amplitude: 0, wavelength: 10 }],
        terrain: { heightmap: () => terrain, origin: [0, 0], size: [n * dx, rows * dx] },
      });
      const flood = Flood.attach(engine, {
        surface: water,
        boundary: { west: 'sea', east: 'open' },
        maxDepth: 160,
        maxSpeed: 60,
        roughness: 0.045,
        ...(farField === undefined ? {} : { farField }),
      });
      flood.tsunami({ height: 42, period: 260, at: 2 });
      engine.render({ delta: 0 });
      const samples = [];
      for (let i = 0; i < 140; i++) {
        engine.render({ delta: 1 });
        if (i % 10 !== 9) continue;
        await flood.settle();
        const reading = await flood.read(),
          query = await WaveQuery.capture(water),
          t = flood.time,
          edge = reading.depth[n] + reading.bed[n],
          far = flood.farFieldAt(t);
        samples.push({
          t,
          sea: flood.seaLevelAt(t),
          edge,
          seam: query.heightAt(-1, 16),
          out: query.heightAt(-2000, 16),
          profile: far && Array.from(far.profile),
          range: far?.range,
        });
      }
      flood.dispose();
      const restored = water.seaLevel;
      water.dispose();
      return { samples, restored };
    };
    const out = { on: await run(), off: await run(null) };
    terrain.destroy();
    out.validation = String(await d.popErrorScope().then((e) => e?.message ?? ''));
    return out;
  });
  assert.deepEqual(errors, [], 'no page errors');
  assert.equal(result.validation, '', 'no validation errors');
  const c = Math.sqrt(9.81 * 20),
    L = 1024,
    wave = { height: 42, period: 260, at: 2 };
  let seamOn = 0,
    seamOff = 0,
    farOn = 0;
  for (const s of result.on.samples) {
    // The profile is the N-wave r / c seconds on, less the edge's now, written out here.
    for (const [i, v] of s.profile.entries()) {
      const r = (s.range * i) / 63;
      assert.ok(Math.abs(v - (nWave(s.t + r / c, wave) - nWave(s.t, wave))) < 1e-3, `profile at ${r} m, t ${s.t}`);
    }
    const r = 2000,
      expected = s.sea + interpolate(s.profile, (r / s.range) * 63) + (s.edge - s.sea) / Math.sqrt(1 + r / L);
    farOn = Math.max(farOn, Math.abs(s.out - expected));
    seamOn = Math.max(seamOn, Math.abs(s.seam - s.edge));
  }
  for (const s of result.off.samples) seamOff = Math.max(seamOff, Math.abs(s.seam - s.edge));
  console.log(JSON.stringify({ farOn, seamOn, seamOff, restored: result.on.restored }));
  assert.ok(farOn < 0.2, `the far sea 2 km out follows the travelling wave: off by ${farOn} m`);
  assert.ok(seamOn < 0.6, `the open sea meets the sim's edge: off by ${seamOn} m`);
  assert.ok(seamOff > 15, `with farField null the flat sea stands apart from the edge (${seamOff} m), as before`);
  assert.equal(result.on.restored, 0, 'dispose puts the sea level back');
} finally {
  await closeAll({ browser });
}
function interpolate(profile, s) {
  const i = Math.min(Math.floor(s), profile.length - 1),
    j = Math.min(i + 1, profile.length - 1);
  return profile[i] + (profile[j] - profile[i]) * (s - i);
}
// The N-wave in the form the package documents, written out so the test does not call the code it checks.
function nWave(t, wave) {
  const tau = (9 * (t - wave.at)) / wave.period - 4.5;
  if (tau < -4.5 || tau > 4.5) return 0;
  return (wave.height * tau) / Math.cosh(tau) ** 2 / 0.447743;
}
