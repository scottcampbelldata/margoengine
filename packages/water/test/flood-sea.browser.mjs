// water/flood at the sea on the GPU (disaster water push 4), on WebGPU and, with MARGO_COMPAT=1, the WebGL2 layer. Each
// bound is the plan's section 3, measured on quasi-1D strips of cells:
//  - a sea side holds a lake at rest at rest (Flather 1976 with the outer surface equal to the inner);
//  - a wave leaving through it is not reflected (under 5% of its height);
//  - a tsunami N-wave arrives at the shallow-water speed with its height (Tadepalli and Synolakis 1994);
//  - a trough-first N-wave bares the bed before the first crest on a beach, and the crest floods it again;
//  - a solitary wave of H / d = 0.0185 runs up a 1 : 19.85 beach to R / d = 2.831 sqrt(cot beta) (H / d)^(5/4) = 0.086
//    within 5% (Synolakis 1987; the NOAA benchmark of Synolakis et al. 2008);
//  - a steady wind tilts a closed basin by rho_air Cd U^2 L / (rho g h) within 5% (30 m/s, Resio and Westerink 2008);
//  - rain of 100 mm/h for 60 s on a flat closed basin is 1.667 mm within 1%;
//  - a surge of the sea level fills the basin to it through the sea side.
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
process.chdir(fileURLToPath(new URL('../../../', import.meta.url)));
import { openBrowser } from '../../../scripts/browser.js';
import { closeAll } from '../../../scripts/support/shutdown.mjs';
import { solitaryRunup, windStress } from './flood-analytic.js';

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
    const canvas = document.createElement('canvas');
    canvas.style.cssText = 'width:64px;height:48px';
    document.body.replaceChildren(canvas);
    const engine = await EngineKernel.create(canvas, {
      backend: 'webgpu',
      capacity: 4,
      camera: { position: [12, 40, 30], target: [12, 0, 8], near: 0.1, far: 500 },
    });
    const d = engine.gpu;
    d.pushErrorScope('validation');
    const textures = [];
    // A strip of n x rows cells (default 4) of dx metres: the bed ground(x, z), the Water at sea level 0 (or its fill), a Flood on it.
    const strip = (n, dx, ground, options = {}, fill, rows = 4) => {
      const size = [n * dx, rows * dx],
        terrain = d.createTexture({ size: [n, rows], format: 'r32float', usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST });
      textures.push(terrain);
      d.queue.writeTexture({ texture: terrain }, Float32Array.from({ length: n * rows }, (_, k) => ground(((k % n) + 0.5) * dx, (Math.floor(k / n) + 0.5) * dx)), { bytesPerRow: n * 4 }, [n, rows]);
      const water = Water.attach(engine, {
        height: options.seaLevel ?? 0,
        size: [200, 200],
        segments: 16,
        waves: [{ direction: [1, 0], amplitude: 0, wavelength: 10 }],
        terrain: { heightmap: () => terrain, origin: [0, 0], size },
        ...(fill ? { fill } : {}),
      });
      const flood = Flood.attach(engine, { surface: water, ...options.flood });
      engine.render({ delta: 0 });
      return {
        water,
        flood,
        n,
        dx,
        // Runs `seconds` of flood time in frames of `frame` seconds, calling `each(t)` after each.
        async run(seconds, frame = 0.5, each) {
          const frames = Math.round(seconds / frame);
          for (let i = 0; i < frames; i++) {
            engine.render({ delta: frame });
            if (each) await each(flood.time);
          }
          await flood.settle();
        },
        dispose() {
          flood.dispose();
          water.dispose();
        },
      };
    };
    const out = {};
    const surface = (r, i) => r.depth[i] + r.bed[i];

    // 1. A lake at rest behind a sea side stays at rest: 10 m deep over a step, 2,400 ticks.
    {
      const m = strip(100, 2, (x) => (x < 100 ? -10 : -4), { flood: { boundary: { west: 'sea', east: 'sea' }, maxDepth: 12, maxSpeed: 3 } });
      await m.run(20);
      const r = await m.flood.read();
      let level = 0;
      for (let i = 0; i < 100; i++) level = Math.max(level, Math.abs(surface(r, i)));
      out.calm = { speed: r.maxSpeed, level, ticks: r.ticks };
      m.dispose();
    }
    // 2. A hump of 0.3 m leaves through both sea sides: 400 m of 10 m of water, 120 s.
    {
      const m = strip(200, 2, () => -10, { flood: { boundary: { west: 'sea', east: 'sea' }, maxDepth: 11, maxSpeed: 3 } }, (x) => 0.3 * Math.exp(-((x - 200) ** 2) / (2 * 15 ** 2)));
      const start = await m.flood.read();
      await m.run(120, 1);
      const r = await m.flood.read();
      let left = 0;
      for (let i = 0; i < 200; i++) left = Math.max(left, Math.abs(surface(r, i)));
      let first = 0;
      for (let i = 0; i < 200; i++) first = Math.max(first, surface(start, i));
      out.leaving = { first, left };
      m.dispose();
    }
    // 3. A tsunami N-wave of 0.2 m arrives at 100 m at the speed sqrt(g d): the trough and the crest, measured at x = 101 m.
    {
      const m = strip(200, 2, () => -10, { flood: { boundary: { west: 'sea' }, maxDepth: 11, maxSpeed: 3 } }),
        wave = { height: 0.2, period: 60, at: 5 };
      m.flood.tsunami(wave);
      const probe = [];
      await m.run(100, 0.25, async (t) => {
        const r = await m.flood.read();
        probe.push([t, surface(r, 50)]);
      });
      out.arrival = { probe, x: 101, c: Math.sqrt(9.81 * 10), wave };
      m.dispose();
    }
    // 4. Drawback: a trough-first N-wave of 1 m and 10 minutes on a 1 : 20 beach (bed -10 m at the sea, level at x = 200 m): the shoreline
    // retreats before the crest and the crest floods past where it started.
    {
      const m = strip(300, 1, (x) => -10 + x / 20, { flood: { boundary: { west: 'sea' }, maxDepth: 14, maxSpeed: 10 } });
      m.flood.tsunami({ height: 1, period: 600, at: 0 });
      const wet = [];
      await m.run(800, 1, async (t) => {
        const r = await m.flood.read();
        wet.push([t, r.wetArea / 4]);
      });
      out.drawback = { wet };
      m.dispose();
    }
    // 5. Run-up of a solitary wave H / d = 0.0185 on a beach 1 : 19.85 (depth 1 m, toe 5 m from the sea side, 512 cells of 30/512 m).
    {
      const H = 0.0185,
        gamma = Math.sqrt((3 * H) / 4),
        c = Math.sqrt(9.81 * (1 + H)),
        period = 13.5 / (gamma * c),
        m = strip(512, 30 / 512, (x) => (x < 5 ? -1 : -1 + (x - 5) / 19.85), { flood: { boundary: { west: 'sea' }, maxDepth: 1.3, maxSpeed: 1, roughness: 0 } });
      m.flood.tsunami({ height: H, period, at: 0, shape: 'solitary' });
      let runup = -1;
      await m.run(45, 0.1, async (t) => {
        if (t < 12) return;
        const r = await m.flood.read();
        for (let i = 0; i < 512; i++) if (r.depth[i] > 1e-3 && i > 100) runup = Math.max(runup, surface(r, i));
      });
      out.runup = { runup, period, H };
      m.dispose();
    }
    // 6. Wind over a closed basin: 400 m x 2 m, 30 m/s along x, steady tilt measured as the time average over three seiches.
    {
      const m = strip(100, 4, () => -2, { flood: { maxDepth: 2.6, maxSpeed: 1.5, roughness: 0.03 } });
      m.flood.setWind({ speed: 30, direction: [1, 0] });
      const tilt = [];
      await m.run(540, 1, async () => {
        const r = await m.flood.read();
        tilt.push(((surface(r, 99) - surface(r, 0)) * 400) / 396);
      });
      out.wind = { mean: tilt.reduce((a, b) => a + b, 0) / tilt.length, samples: tilt.length };
      m.dispose();
    }
    // 7. Rain: 100 mm/h for 60 s on a flat closed basin.
    {
      const m = strip(40, 1, () => 0, { flood: { maxDepth: 1, maxSpeed: 1, rain: 100 } });
      await m.run(60, 1);
      const r = await m.flood.read();
      out.rain = { depth: r.volume / (40 * 4), volume: r.volume };
      m.dispose();
    }
    // 8. A surge: the sea side's level rises 0.5 m in 20 s over a closed basin 200 m long of 5 m of water; after 200 s the
    // basin stands at it, whatever sloshed in between.
    {
      const m = strip(100, 2, () => -5, { flood: { boundary: { west: 'sea' }, maxDepth: 6, maxSpeed: 2, surge: 0.5, surgeRise: 20 } });
      await m.run(200, 1);
      const r = await m.flood.read();
      let low = 9,
        high = -9;
      for (let i = 0; i < 100; i++) (low = Math.min(low, surface(r, i))), (high = Math.max(high, surface(r, i)));
      out.surge = { low, high, level: m.water.seaLevel };
      m.dispose();
    }
    // 9. A 7 m tsunami (trough first) at a sea side that is half sea and half land: a channel 10 m deep along z < 32 m and
    // land 1.7 m over the sea at the side, falling 1 : 40 inland, 64 x 32 cells of 2 m, Manning 0.03 (a harbour's shore at
    // the sea side, KB-FLATHER-DRY1: the linear Flather current sqrt(g / h) (eta - eta_out), with h the edge cell's
    // own depth, sent 57 m/s into the thin sheets the channel spread over the land edge under the crest). And a dry land
    // edge alone (60 x 4 cells, bed 1.7 m falling 1 : 50, a 6 m crest): the old dry edge was a wall the sea never crossed.
    for (const [name, n, rows, ground, wave] of [
      ['shore', 64, 32, (x, z) => (z < 32 ? -10 : 1.7 - (128 - x) / 40), { height: 7, period: 120, at: 0 }],
      ['land', 60, 4, (x) => 1.7 - (120 - x) / 50, { height: 6, period: 120, at: 0, leading: 'crest' }],
    ]) {
      const m = strip(n, 2, ground, { flood: { boundary: { east: 'sea' }, maxDepth: 30, maxSpeed: 20, roughness: 0.03 } }, undefined, rows);
      m.flood.tsunami(wave);
      let fastest = 0,
        capped = 0,
        edge = 0;
      await m.run(140, 1, async () => {
        const r = await m.flood.read();
        fastest = Math.max(fastest, r.maxSpeed);
        capped = Math.max(capped, r.capped);
        edge = Math.max(edge, r.depth[(rows - 1) * n + n - 1]);
      });
      (out.edge ??= {})[name] = { fastest, capped, edge };
      m.dispose();
    }
    for (const t of textures) t.destroy();
    out.validation = String(await d.popErrorScope().then((e) => e?.message ?? ''));
    return out;
  });
  console.log(JSON.stringify({ ...result, arrival: undefined, drawback: undefined }));
  assert.deepEqual(errors, [], 'no page errors');
  assert.equal(result.validation, '', 'no validation errors');
  // 1. rest
  assert.ok(result.calm.speed < 1e-4 && result.calm.level < 1e-5, `a sea side holds a lake at rest: ${JSON.stringify(result.calm)}`);
  // 2. no reflection
  assert.ok(result.leaving.left < 0.05 * result.leaving.first, `waves leave: ${result.leaving.left} left of ${result.leaving.first}`);
  // 3. arrival
  {
    const { probe, x, c, wave } = result.arrival,
      shape = { ...wave, leading: 'trough' };
    let lo = 0,
      hi = 0,
      tLo = 0,
      tHi = 0,
      tLoExp = 0,
      tHiExp = 0,
      eLo = 0,
      eHi = 0;
    for (const [t, e] of probe) {
      if (e < lo) ((lo = e), (tLo = t));
      if (e > hi) ((hi = e), (tHi = t));
    }
    for (let t = wave.at; t <= wave.at + wave.period; t += 0.01) {
      const e = tsunamiElevationOf(shape, t);
      if (e < eLo) ((eLo = e), (tLoExp = t + x / c));
      if (e > eHi) ((eHi = e), (tHiExp = t + x / c));
    }
    assert.ok(Math.abs(lo + wave.height) < 0.08 * wave.height && Math.abs(hi - wave.height) < 0.08 * wave.height, `N-wave height at 101 m: trough ${lo}, crest ${hi}`);
    assert.ok(Math.abs(tLo - tLoExp) < 1.5 && Math.abs(tHi - tHiExp) < 1.5, `arrival times ${tLo} (${tLoExp}) and ${tHi} (${tHiExp})`);
    assert.ok(tLo < tHi, 'the trough arrives first');
  }
  // 4. drawback
  {
    const w = result.drawback.wet;
    console.log('drawback wet length', w[0][1], Math.min(...w.map((r) => r[1])), Math.max(...w.map((r) => r[1])));
    const wet = result.drawback.wet,
      start = wet[0][1];
    let min = start,
      tMin = 0,
      max = start,
      tMax = 0;
    for (const [t, a] of wet) {
      if (a < min) ((min = a), (tMin = t));
      if (a > max) ((max = a), (tMax = t));
    }
    assert.ok(min < start - 10, `the sea draws back (the 1 m trough is 20 m of this beach): wet length ${start} to ${min} m`);
    assert.ok(tMin < tMax, `the bed is bare (t = ${tMin}) before the crest has flooded it (t = ${tMax})`);
    assert.ok(max > start + 10, `and the crest floods past the first shore: ${max} against ${start} m`);
  }
  // 5. run-up
  {
    const expected = solitaryRunup(0.0185, 19.85);
    assert.ok(Math.abs(result.runup.runup / expected - 1) < 0.05, `run-up ${result.runup.runup} against ${expected} (R/d, d = 1 m): Synolakis 1987`);
  }
  // 6. wind
  {
    const expected = ((windStress(30) / (1000 * 9.81 * 2)) * 400);
    assert.ok(Math.abs(result.wind.mean / expected - 1) < 0.05, `wind tilt ${result.wind.mean} against ${expected} m`);
  }
  // 7. rain
  assert.ok(Math.abs(result.rain.depth / 1.6667e-3 - 1) < 0.01, `rain ${result.rain.depth} against 1.667 mm`);
  // 8. surge
  assert.ok(result.surge.low > 0.46 && result.surge.high < 0.54, `the basin stands at the surge: ${result.surge.low} .. ${result.surge.high}`);
  assert.ok(Math.abs(result.surge.level - 0.5) < 1e-6, 'and so does the Water level');
  // 9. The sea comes over a land edge with no cell capped and slower than the flood's 20 m/s limit (a dam-break front
  // of the 5.3 m crest over the edge runs at 2 sqrt(g h) = 14.4 m/s, Ritter 1892, a little more down the slope), and floods it.
  for (const name of ['shore', 'land']) {
    const e = result.edge[name];
    assert.equal(e.capped, 0, `${name}: no cell capped (${JSON.stringify(e)})`);
    assert.ok(e.fastest < 20, `${name}: the fastest water ${e.fastest} m/s`);
    assert.ok(e.edge > 1, `${name}: the crest floods the land edge cell (${e.edge} m)`);
  }
  console.log('flood sea: ok');
} finally {
  await closeAll({ browser });
}

function tsunamiElevationOf(wave, t) {
  // The N-wave in the form the package documents, written out so the test does not call the code it checks.
  const tau = (9 * (t - wave.at)) / wave.period - 4.5;
  if (tau < -4.5 || tau > 4.5) return 0;
  return (wave.height * tau) / Math.cosh(tau) ** 2 / 0.447743;
}
