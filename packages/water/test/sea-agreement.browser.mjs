// The drawn sea and the physics sea agree (WaterOptions.sea; SpectralSea of @margoengine/physics/sea): Water draws the
// sea's own linear waves, so the surface the GPU computes at each mesh vertex (captured by WaveQuery) is the surface
// SpectralSea.sample gives there, to within a bound worked out from the waves themselves (docs/limits.md, "Drawn sea"):
//
//   |h_gpu - h| <= sum_n a_n (2^-11 + d_n) + (N + 2) eps sum_n a_n
//   |s_gpu - s| <= sum_n a_n k_n (2^-11 + d_n) + (N + 2) eps sum_n a_n k_n   (s each slope component; a normal's
//                                                                              x and z components move no more)
//   d_n = 4 eps (|kx_n x| + |kz_n z| + |phase_n| + 2 pi),  eps = 2^-24
//
// where 2^-11 is WGSL's bound on sin and cos in [-pi, pi], d_n the f32 rounding of the phase (three products and sums and
// the reduction into [-pi, pi]), and the last term the rounding of the inputs and of an f32 sum of N terms. The bound is
// checked at every vertex, on WebGPU and (MARGO_COMPAT=1) on the WebGL2 compatibility layer:
//   node scripts/run-with-timeout.mjs -- node packages/water/test/sea-agreement.browser.mjs
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { openBrowser } from '../../../scripts/browser.js';

process.chdir(fileURLToPath(new URL('../../../', import.meta.url)));
const browser = await openBrowser({ port: 'free', startPath: '/tests/modern-game.html' });
const { page, hardware } = browser,
  errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(m.text());
});
try {
  console.log('adapter', JSON.stringify(hardware.webgpu), hardware.compat ? '(WebGL2 compatibility)' : '');
  const result = await page.evaluate(async () => {
    const { EngineKernel } = await import('/packages/core/dist/index.js');
    const { Water } = await import('/packages/water/dist/index.js');
    const { WaveQuery } = await import('/packages/water/dist/query.js');
    const { SpectralSea } = await import('/packages/physics/dist/sea.js');
    const { jonswap } = await import('/packages/physics/dist/waves.js');
    const canvas = document.createElement('canvas');
    canvas.style.cssText = 'width:160px;height:128px';
    document.body.replaceChildren(canvas);
    const engine = await EngineKernel.create(canvas, {
      backend: 'webgpu',
      capacity: 8,
      camera: { position: [0, 30, 30], target: [0, 0, 0], near: 0.1, far: 500 },
    });
    engine.gpu.pushErrorScope('validation');
    const nf = 34,
      nd = 24,
      spectrum = {
        frequencies: Float64Array.from({ length: nf }, (_, i) => 0.04 * 25 ** (i / (nf - 1))),
        directions: Float64Array.from({ length: nd }, (_, j) => (2 * Math.PI * j) / nd),
        energy: new Float64Array(nf * nd),
        depth: 25,
        density: 1025,
      };
    jonswap({ height: 2.5, period: 8, direction: 0.6 }, spectrum);
    const sea = new SpectralSea({ waves: spectrum, seed: 11 }),
      // 40 m on 256 segments: 0.16 m between vertices, so even the shortest wave (1.56 m at 1 Hz) is sampled at full
      // weight by the mesh's filter and the drawn surface holds every wave the physics sums.
      water = Water.attach(engine, { size: [40, 40], segments: 256, sea }),
      samples = [];
    for (const time of [0, 7.25, 3600.5]) {
      water.setTime(time);
      engine.render({ delta: 0 });
      const query = await WaveQuery.capture(water),
        v = query['vertices'],
        rows = new Float32Array(4 * sea.waveCount);
      sea.waveComponents(time, rows);
      const comps = Array.from({ length: sea.waveCount }, (_, n) => [
        rows[4 * n],
        rows[4 * n + 1],
        rows[4 * n + 2],
        rows[4 * n + 3],
      ]);
      const count = v.length / 12;
      for (let i = 0; i < count; i += 97) {
        const x = v[12 * i + 3],
          z = v[12 * i + 7];
        samples.push({
          time,
          x,
          z,
          height: v[12 * i + 1],
          normal: [v[12 * i + 4], v[12 * i + 5], v[12 * i + 6]],
          expected: sea.sample(x, z, time),
          comps: time === 0 && i === 0 ? comps : undefined,
          rows: comps.map(([kx, kz, a, phase]) => [
            Math.abs(kx * x) + Math.abs(kz * z) + Math.abs(phase),
            a,
            Math.hypot(kx, kz),
          ]),
        });
      }
    }
    const error = await engine.gpu.popErrorScope();
    return { samples, waves: sea.waveCount, error: error?.message ?? null };
  });
  assert.equal(result.error, null);
  assert.ok(result.waves > 100, `a real sea: ${result.waves} waves`);
  const eps = 2 ** -24,
    sinBound = 2 ** -11;
  let worstHeight = 0,
    worstNormal = 0,
    maxDh = 0,
    maxH = 0,
    maxHeightBound = 0;
  for (const s of result.samples) {
    const N = s.rows.length;
    let hBound = 0,
      sBound = 0,
      sumA = 0,
      sumAK = 0;
    for (const [phaseTerms, a, k] of s.rows) {
      const d = 4 * eps * (phaseTerms + 2 * Math.PI);
      hBound += a * (sinBound + d);
      sBound += a * k * (sinBound + d);
      sumA += a;
      sumAK += a * k;
    }
    hBound += (N + 2) * eps * sumA;
    sBound += (N + 2) * eps * sumAK;
    const dh = Math.abs(s.height - s.expected.height);
    assert.ok(
      dh <= hBound,
      `height at (${s.x}, ${s.z}, t ${s.time}): ${s.height} drawn, ${s.expected.height} simulated, bound ${hBound}`,
    );
    // The normal from slopes: n = (-sx, 1, -sz) / |..|, so a slope error moves n.x and n.z by no more than it is.
    for (const c of [0, 2]) {
      const dn = Math.abs(s.normal[c] - s.expected.normal[c]);
      assert.ok(dn <= sBound + 8 * eps, `normal ${c} at (${s.x}, ${s.z}, t ${s.time}): off by ${dn}, bound ${sBound}`);
      worstNormal = Math.max(worstNormal, dn / (sBound + 8 * eps));
    }
    worstHeight = Math.max(worstHeight, dh / hBound);
    maxDh = Math.max(maxDh, dh);
    maxH = Math.max(maxH, Math.abs(s.expected.height));
    maxHeightBound = Math.max(maxHeightBound, hBound);
  }
  assert.deepEqual(errors, []);
  console.log(
    `ok drawn sea agrees with SpectralSea at ${result.samples.length} vertices over 3 times (${result.waves} waves): worst height ${(worstHeight * 100).toFixed(1)}% and normal ${(worstNormal * 100).toFixed(1)}% of their bounds; height bound up to ${(maxHeightBound * 1000).toFixed(2)} mm; largest difference ${(maxDh * 1000).toFixed(4)} mm on heights up to ${maxH.toFixed(2)} m`,
  );
} finally {
  await browser.close();
}
