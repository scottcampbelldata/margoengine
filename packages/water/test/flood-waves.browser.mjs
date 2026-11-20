// water/flood waves on the GPU (disaster water push 7), on WebGPU and, with MARGO_COMPAT=1, the WebGL2 layer. Each bound
// is measured on quasi-1D strips of 2 m cells (1 m for the swell) over 10 m of water (c = sqrt(g h) = 9.90 m/s):
//  - a wave maker (the source function of Wei, Kirby and Sinha 1999, made one-way) sends a train of the set amplitude
//    (within 3%) and period (within 1%) to a gauge 19 m ahead, and under 3% of it out of the back;
//  - waves crossing the maker's band pass through: the train a wall reflects has the same height (within 3%) 11 m
//    either side of the band (a band that reflected would hold some of it in front);
//  - the east sea side lets the train out: at 469 m the part running back is under 3% of the part running out
//    (Flather 1976; the ghost of the outer depth sent back a third of it, KB-FLATHER-GHOST1);
//  - the Water's swell comes in through a 'sea' side (Flather 1976): the elevation in the first cell has the swell
//    train's amplitude at that face within 5% and follows it in time; `swell: 0` keeps it out;
//  - a solitary tsunami's crest keeps its height within 1% over 500 m of flat frictionless bed (a simple wave, Stoker 1957).
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
const SWELL = { direction: [1, 0], amplitude: 0.2, wavelength: 150 };
try {
  const result = await page.evaluate(async (SWELL) => {
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
    // A strip of n x 4 cells of dx m, flat bed 10 m under the sea level 0.
    const strip = (n, dx, flood, waves = [{ direction: [1, 0], amplitude: 0, wavelength: 10 }]) => {
      const terrain = d.createTexture({ size: [n, 4], format: 'r32float', usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST });
      textures.push(terrain);
      d.queue.writeTexture({ texture: terrain }, new Float32Array(n * 4).fill(-10), { bytesPerRow: n * 4 }, [n, 4]);
      const water = Water.attach(engine, { height: 0, size: [200, 200], segments: 16, waves, terrain: { heightmap: () => terrain, origin: [0, 0], size: [n * dx, 4 * dx] } });
      const f = Flood.attach(engine, { surface: water, maxDepth: 11, maxSpeed: 2, ...flood });
      engine.render({ delta: 0 });
      return {
        water,
        flood: f,
        // Runs to flood time `until` in frames of 0.25 s, reading [t, surface, u] of row 1 at `cells` after each from `from` on.
        async gauge(until, from, cells) {
          const series = cells.map(() => []);
          while (f.time < until - 1e-9) {
            engine.render({ delta: 0.25 });
            if (f.time >= from - 1e-9) {
              const r = await f.read();
              cells.forEach((i, g) => series[g].push([f.time, r.depth[n + i] + r.bed[n + i], r.velocity[(n + i) * 2]]));
            }
          }
          return series;
        },
        dispose() {
          f.dispose();
          water.dispose();
        },
      };
    };
    const out = {};
    const maker = { position: [200, 4], direction: [1, 0], amplitude: 0.1, period: 8 };
    // 1. A maker at x = 200 m sending 0.1 m, 8 s waves east; both ends open sea. Gauges at 219 m (ahead), 79 m (behind),
    // 469 m (near the east side) and between.
    {
      const m = strip(300, 2, { boundary: { west: 'sea', east: 'sea' } });
      m.flood.waveMaker(maker);
      const [ahead, behind, far, ...along] = await m.gauge(90, 0.25, [109, 39, 234, 134, 159, 184, 209]);
      out.forward = { ahead, behind, far, along, ticks: m.flood.ticks };
      m.dispose();
    }
    // 2. The same with a wall at the east end: the reflection runs back through the band; gauges 11 m either side of it.
    {
      const m = strip(300, 2, { boundary: { west: 'sea', east: 'wall' } });
      m.flood.waveMaker(maker);
      const [behind, front] = await m.gauge(132, 100, [94, 105]);
      out.through = { behind, front };
      m.dispose();
    }
    // 3. The Water's swell (one train, 0.2 m, 150 m) through the west sea side, gauge in the first cell; then with swell 0.
    {
      const m = strip(300, 1, { boundary: { west: 'sea', east: 'sea' } }, [SWELL]);
      const start = m.water.time;
      const [first] = await m.gauge(60, 20, [0]);
      out.swell = { first, start };
      m.dispose();
      const off = strip(300, 1, { boundary: { west: 'sea', east: 'sea' }, swell: 0 }, [SWELL]);
      const [none] = await off.gauge(30, 0.25, [0]);
      out.swellOff = Math.max(...none.map((s) => Math.abs(s[1])));
      off.dispose();
    }
    // 4. A long wave over a flat frictionless bed (KB-FLOOD-DAMP1): a 0.1 m solitary tsunami of 24 s (a crest about 18 m
    // wide) through the sea sides; row 1's surface when the west one's crest is near 60 m and near 560 m.
    {
      const m = strip(350, 2, { boundary: { west: 'sea', east: 'sea' } });
      m.flood.tsunami({ shape: 'solitary', height: 0.1, period: 24, at: 0 });
      const rows = [];
      for (const until of [18, 68.5]) {
        while (m.flood.time < until - 1e-9) engine.render({ delta: 0.25 });
        const r = await m.flood.read();
        rows.push(Array.from({ length: 350 }, (_, i) => r.depth[350 + i] + r.bed[350 + i]));
      }
      out.crest = rows;
      m.dispose();
    }
    const error = await d.popErrorScope();
    for (const t of textures) t.destroy();
    engine.dispose();
    return { ...out, gpuError: error?.message ?? null, backend: engine.backend ?? null };
  }, SWELL);
  assert.equal(result.gpuError, null);
  assert.deepEqual(errors, []);
  // Least-squares amplitude of the sinusoid of angular frequency w in a series (with a constant), and its mean up-crossing period.
  const fit = (series, w) => {
    let n = 0, s = 0, c = 0, ss = 0, cc = 0, sc = 0, ys = 0, yc = 0, y0 = 0, sm = 0, cm = 0;
    for (const [t, y] of series) {
      const a = Math.sin(w * t), b = Math.cos(w * t);
      n++, (s += a), (c += b), (ss += a * a), (cc += b * b), (sc += a * b), (ys += y * a), (yc += y * b), (y0 += y), (sm += a), (cm += b);
    }
    // Remove the mean, then solve the 2 x 2 normal equations.
    const A = ss - (s * sm) / n, B = sc - (s * cm) / n, C = cc - (c * cm) / n, P = ys - (y0 * s) / n, Q = yc - (y0 * c) / n;
    const det = A * C - B * B, x = (P * C - Q * B) / det, z = (Q * A - P * B) / det;
    return Math.hypot(x, z);
  };
  const period = (series) => {
    const mean = series.reduce((a, s) => a + s[1], 0) / series.length, ups = [];
    for (let i = 1; i < series.length; i++) {
      const [t0, a] = series[i - 1], [t1, b] = series[i];
      if (a - mean < 0 && b - mean >= 0) ups.push(t0 + ((t1 - t0) * (mean - a)) / (b - a));
    }
    return (ups[ups.length - 1] - ups[0]) / (ups.length - 1);
  };
  const w = (2 * Math.PI) / 8;
  // 1. ahead: amplitude and period over the last four periods (58..90 s); behind: the largest surface over the whole run;
  // near the east side: the train split into its right- and left-running parts, (eta +/- u / sqrt(g / h)) / 2.
  {
    const late = (g) => g.filter(([t]) => t > 58);
    const ahead = late(result.forward.ahead);
    const amplitude = fit(ahead, w), T = period(ahead);
    const behind = Math.max(...result.forward.behind.map((s) => Math.abs(s[1])));
    const k = Math.sqrt(9.81 / 10), far = late(result.forward.far);
    const out = fit(far.map(([t, e, u]) => [t, (e + u / k) / 2]), w), back = fit(far.map(([t, e, u]) => [t, (e - u / k) / 2]), w);
    const along = [amplitude, ...result.forward.along.map((g) => fit(late(g), w)), fit(far, w)];
    console.log(`wave maker: amplitude ${amplitude.toFixed(5)} m (0.1), period ${T.toFixed(4)} s (8), behind ${behind.toExponential(3)} m, ${result.forward.ticks} ticks`);
    console.log(`along the strip (219 to 469 m): ${along.map((a) => a.toFixed(5)).join(' ')}; at 469 m out ${out.toFixed(5)}, back ${back.toExponential(3)} (${((100 * back) / out).toFixed(2)}%)`);
    assert.ok(Math.abs(amplitude / 0.1 - 1) < 0.03, `the train ahead has the set amplitude: ${amplitude} against 0.1 m`);
    assert.ok(Math.abs(T / 8 - 1) < 0.01, `and the set period: ${T} against 8 s`);
    assert.ok(behind < 0.003, `nothing runs out of the back: ${behind} m against 3% of 0.1 m`);
    assert.ok(back < 0.03 * out, `the east sea side lets the train out: ${back} m comes back of ${out} m`);
  }
  // 2. the reflection crossing the band (100..132 s): its west-running part just in front (211 m) and just behind (189 m).
  {
    const k = Math.sqrt(9.81 / 10),
      west = (g) => fit(g.map(([t, e, u]) => [t, (e - u / k) / 2]), w);
    const front = west(result.through.front),
      behind = west(result.through.behind);
    console.log(`through the band: west-running ${front.toFixed(5)} m in front, ${behind.toFixed(5)} m behind (ratio ${(behind / front).toFixed(4)})`);
    assert.ok(front > 0.05, `the wall's reflection reaches the band: ${front} m`);
    assert.ok(Math.abs(behind / front - 1) < 0.03, `and crosses it whole: ${behind} m behind of ${front} m in front`);
  }
  // 3. swell: the elevation at the west face (x = 0, z = 1.5) of the train, written out from the documented swell.
  {
    const { first, start } = result.swell;
    const expected = first.map(([t]) => swellElevation(SWELL, [0, 1.5], start + t, 1));
    const measured = first.map((s) => s[1]);
    const rms = (a) => Math.sqrt(a.reduce((x, y) => x + y * y, 0) / a.length);
    const ratio = rms(measured) / rms(expected);
    let dot = 0;
    for (let i = 0; i < measured.length; i++) dot += measured[i] * expected[i];
    const correlation = dot / (measured.length * rms(measured) * rms(expected));
    console.log(`swell in: rms ${rms(measured).toFixed(5)} against ${rms(expected).toFixed(5)} m (ratio ${ratio.toFixed(4)}), correlation ${correlation.toFixed(4)}; off ${result.swellOff}`);
    assert.ok(Math.abs(ratio - 1) < 0.05, `the swell comes in at its height: rms ratio ${ratio}`);
    assert.ok(correlation > 0.95, `and in time with the train outside: correlation ${correlation}`);
    assert.ok(result.swellOff < 1e-4, `swell 0 keeps it out: ${result.swellOff} m`);
  }
  // 4. The crest of a simple wave keeps its height until the front breaks (Stoker 1957, ch. 10; here after about 1,400 m):
  // within 1% from 60 m to 560 m. Minmod slopes everywhere lost about 27% over that run (the CPU bound in
  // flood-bounds.test.js, the simple wave).
  {
    // Both sea sides send the tsunami in: the west one's crest is read in the west half first, then in the east half
    // once the two have crossed (a crossing leaves each simple wave's values as they were: each Riemann invariant is
    // carried unchanged along its own characteristics, Stoker 1957, ch. 10).
    const crest = (row, from, to) => {
      let k = from;
      for (let i = from; i < to; i++) if (row[i] > row[k]) k = i;
      const [l, m, r] = [row[k - 1], row[k], row[k + 1]], offset = (0.5 * (l - r)) / (l - 2 * m + r);
      return { height: m - 0.25 * (l - r) * offset, at: (k + 0.5 + offset) * 2 };
    };
    const near = crest(result.crest[0], 1, 175), far = crest(result.crest[1], 175, 349);
    console.log(`long wave: crest ${near.height.toFixed(5)} m at ${near.at.toFixed(1)} m, ${far.height.toFixed(5)} m at ${far.at.toFixed(1)} m (${((far.height / near.height - 1) * 100).toFixed(3)}%)`);
    assert.ok(near.at > 30 && near.at < 100 && far.at > 500 && far.at < 600, `the crest travelled from ${near.at} m to ${far.at} m`);
    assert.ok(Math.abs(far.height / near.height - 1) < 0.01, `the crest keeps its height over 500 m: ${far.height} m against ${near.height} m`);
  }
  console.log('flood waves: ok');
} finally {
  await closeAll({ browser });
}

/**
 * The linear elevation of one Water swell train at xz and wave time t, as the package documents its three-component
 * spectrum (turn, wavenumber scale, share, phase) and crest bend, written out so the test does not call the code it checks.
 */
function swellElevation(train, xz, t, cell) {
  const spectrum = [
    [0, 1, 0.4, 0],
    [-0.64, 0.84, 0.35, 2.17],
    [0.81, 1.18, 0.25, 4.91],
  ];
  const k0 = (2 * Math.PI) / train.wavelength, omega = Math.sqrt(9.81 * k0), len = Math.hypot(...train.direction);
  const dir = [train.direction[0] / len, train.direction[1] / len];
  let eta = 0;
  for (const [turn, scale, share, phase] of spectrum) {
    const d = [dir[0] * Math.cos(turn) - dir[1] * Math.sin(turn), dir[0] * Math.sin(turn) + dir[1] * Math.cos(turn)];
    const across = [-d[1], d[0]], k = k0 * scale, speed = omega * Math.sqrt(scale);
    const bend = k * 0.35 * (across[0] * xz[0] + across[1] * xz[1]) - speed * t * 0.12 + phase;
    const filter = Math.min(1, Math.max(0, ((2 * Math.PI) / (k * 1.114) / cell - 2) * 0.5));
    const kept = filter * filter * (3 - 2 * filter);
    const inward = Math.min(1, Math.max(0, 4 * d[0]));
    eta += inward * train.amplitude * share * kept * Math.sin(k * (d[0] * xz[0] + d[1] * xz[1]) - speed * t + phase + 1.4 * Math.sin(bend));
  }
  return eta;
}
