// Real-GPU check for fog on water, VFX particles, Gaussian splats, points/sprites and lines (setFog), and for lines'
// SkeletonHelper. Run under the GPU lock:
//   node scripts/gpu-lock.mjs run --owner=fog-all -- node scripts/fog-all-gpu-check.js [--baseline]
// --baseline records the unfogged images of the current dist (run it on the dist from before fog existed); a later run
// requires its unfogged images to equal them bit for bit. Each fogged image G is checked against U + a (F - U): U the
// same scene unfogged, F at full fog (a = 1) and a environment Fog's analytic amount at that pixel's surface point.
// That relation is linear in the colour, so it holds through alpha blending, additive blending and MSAA resolve.
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { openBrowser } from './browser.js';
import { decodePNG } from '../tests/support/png.js';
import { acquire } from './gpu-lock.mjs';

const release = await acquire({ owner: 'fog-all-gpu-check' }),
  baseline = process.argv.includes('--baseline'),
  only = process.argv
    .find((arg) => arg.startsWith('--kinds='))
    ?.slice(8)
    .split(','),
  folder = 'test-results/fog-all',
  port = 5304;
let browser;
try {
  await mkdir(folder, { recursive: true });
  browser = await openBrowser({ startPath: '/tests/fog-all.html', port });
  const page = browser.page,
    errors = [],
    checks = [],
    failures = [];
  page.on('pageerror', (error) => errors.push(error.message));
  assert.equal(browser.hardware.webgpu?.fallback, false, 'Physical WebGPU adapter required');
  const call = (name, ...args) => page.evaluate(([name, args]) => window.fogFixture[name](...args), [name, args]);
  let samples = 4;
  const record = (name, ok, detail) => {
    checks.push({ name: `${samples}x ${name}`, ok, ...detail });
    if (!ok) failures.push(`${samples}x ${name}: ${JSON.stringify(detail)}`);
  };
  const equal = async (name, a, b) => {
    const d = await call('diff', a, b);
    record(name, d.max === 0, d);
  };
  const LIN = { color: '#8090a0', near: 5, far: 12, heightFalloff: 0.35, height: 0.5 },
    EXP = { color: '#8090a0', density: 0.09 },
    FULL = { color: '#8090a0', near: 0, far: 0 };
  // Tolerances: half-float storage of U, F and G; splats are fogged at their centres, so their soft edges see a
  // slightly different distance than the plane point the analytic amount uses.
  const tolerance = { water: 0.003, vfx: 0.003, points: 0.003, sprites: 0.003, splats: 0.01, lines: 0.003 };
  const fixtureErrors = [];
  for (samples of [4, 1]) {
    await checkSamples();
    // WebGPU validation and engine errors are kept per page load, so collect them before the next one.
    for (const error of await page.evaluate(() => window.fogFixture.errors)) fixtureErrors.push(`${samples}x ${error}`);
  }
  async function checkSamples() {
    await page.goto(`http://127.0.0.1:${port}/tests/fog-all.html${samples === 1 ? '?samples=1' : ''}`);
    await page.waitForFunction(() => window.fogFixture);
    const { sampleCount } = await call('mode', 'hdr');
    record('scene raster sample count', sampleCount === samples, { sampleCount });
    const hasFog = await page.evaluate(() => window.fogFixture.hasFog);
    for (const kind of ['water', 'vfx', 'points', 'sprites', 'splats', 'lines'].filter(
      (k) => !only || only.includes(k),
    )) {
      const u = kind + '-U',
        file = `${folder}/baseline-${samples}x-${kind}.json`;
      await call('render', u, kind);
      if (baseline) {
        await writeFile(file, JSON.stringify({ data: await call('export', u) }));
        continue;
      }
      const old = await readFile(file, 'utf8').catch(() => null);
      if (old) {
        await call('import', kind + '-baseline', JSON.parse(old).data);
        await equal(`${kind} without fog equals the pre-fog dist bit for bit`, u, kind + '-baseline');
      } else record(`${kind} pre-fog baseline present`, false, { file });
      if (!hasFog) continue;
      for (const [label, fog] of [
        ['linear+height', LIN],
        ['exp2', EXP],
      ]) {
        await call('render', `${kind}-${label}`, kind, fog);
        await call('render', kind + '-full', kind, FULL);
        const r = await call('analytic', `${kind}-${label}`, u, kind + '-full', kind, fog);
        record(
          `${kind} ${label} fog matches U + a (F - U)`,
          r.max <= tolerance[kind] && r.effect > 0.05 && r.pixels > 50,
          {
            ...r,
            tolerance: tolerance[kind],
          },
        );
      }
      await call('render', kind + '-disabled', kind, { ...LIN, enabled: false });
      await equal(`${kind} fog.enabled = false equals no fog`, kind + '-disabled', u);
      if (kind === 'water') {
        await call('render', 'water-environment', kind, { ...LIN, env: true });
        await equal(
          'environment Fog object fogs water as the plain object does',
          'water-environment',
          'water-linear+height',
        );
      }
      if (kind === 'points' || kind === 'lines') {
        await call('render', kind + '-material-off', kind, LIN, false);
        await equal(`${kind} material.fog = false ignores the plugin fog`, kind + '-material-off', u);
        await call('render', kind + '-material-on', kind, undefined, true);
      }
      await call('render', kind + '-null', kind, null);
      await equal(`${kind} setFog(null) returns to the unfogged image`, kind + '-null', u);
    }
    if (baseline || !hasFog) return;
    // Water with terrain-coupled flow and spray: the fogged spray shader compiles and draws.
    await call('render', 'spray-fogged', 'spray', LIN);
    await call('render', 'spray-null', 'spray', null);
    // SkeletonHelper over a posed rig: lines at each parent-to-child midpoint, following a new pose, gone when removed.
    await call('render', 'skeleton-none', 'skeleton');
    const before = await call('skeleton', true);
    await call('render', 'skeleton-drawn', 'skeleton');
    for (const [x, y] of before) {
      const drawn = await call('pixel', 'skeleton-drawn', x, y),
        none = await call('pixel', 'skeleton-none', x, y);
      record(`skeleton bone line at (${x}, ${y})`, drawn[0] > 0.5 && drawn[0] - none[0] > 0.3, { drawn, none });
    }
    const after = await call('skeleton', true, 1.1);
    await call('render', 'skeleton-posed', 'skeleton');
    for (let i = 0; i < after.length; i++) {
      const [x, y] = after[i],
        drawn = await call('pixel', 'skeleton-posed', x, y);
      record(`skeleton follows the new pose at (${x}, ${y})`, drawn[0] > 0.5, { drawn });
      const [ox, oy] = before[i];
      if (Math.hypot(ox - x, oy - y) > 12) {
        const left = await call('pixel', 'skeleton-posed', ox, oy),
          none = await call('pixel', 'skeleton-none', ox, oy);
        record(`skeleton line left its old pose at (${ox}, ${oy})`, Math.abs(left[0] - none[0]) < 0.01, { left, none });
      }
    }
    await call('skeleton', false);
    await call('render', 'skeleton-removed', 'skeleton');
    await equal('skeleton helper removed restores the image', 'skeleton-removed', 'skeleton-none');
    // The canvas path (bgra8unorm, no post): water mixes after its tone mapping and before sRGB encoding, points before
    // their encoding, and VFX (which writes raw values) toward the sRGB-encoded fog colour.
    await call('mode', 'canvas');
    const shot = async (label, kind, fog) => {
      await call('render', label, kind, fog);
      const png = await decodePNG(new Uint8Array(await page.locator('canvas').screenshot()));
      const stride = png.data.length / (png.width * png.height);
      return Float32Array.from(
        { length: png.width * png.height * 3 },
        (_, i) => png.data[Math.floor(i / 3) * stride + (i % 3)] / 255,
      );
    };
    const decode = (v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4),
      encode = (v) => (v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055);
    for (const kind of ['water', 'points', 'vfx']) {
      const U = await shot(kind + '-canvas-U', kind),
        G = await shot(kind + '-canvas-G', kind, LIN),
        F = await shot(kind + '-canvas-F', kind, FULL),
        D = await shot(kind + '-canvas-D', kind, { ...LIN, enabled: false }),
        A = await call('amounts', kind, LIN),
        raw = kind === 'vfx';
      let max = 0,
        pixels = 0,
        effect = 0,
        same = true;
      for (let p = 0; p < A.length; p++) {
        for (let c = 0; c < 3; c++) same &&= D[p * 3 + c] === U[p * 3 + c];
        if (!Number.isFinite(A[p])) continue;
        let span = 0;
        for (let c = 0; c < 3; c++) span = Math.max(span, Math.abs(F[p * 3 + c] - U[p * 3 + c]));
        if (span < 4 / 255) continue;
        pixels++;
        for (let c = 0; c < 3; c++) {
          const i = p * 3 + c,
            expected = raw ? U[i] + A[p] * (F[i] - U[i]) : encode(decode(U[i]) + A[p] * (decode(F[i]) - decode(U[i])));
          max = Math.max(max, Math.abs(G[i] - expected));
          effect = Math.max(effect, Math.abs(G[i] - U[i]));
        }
      }
      record(
        `${kind} canvas fog matches U + a (F - U) ${raw ? 'in written values' : 'in linear'}`,
        max <= 3.5 / 255 && effect > 0.05 && pixels > 50,
        {
          max: max * 255,
          effect,
          pixels,
          unit: '1/255',
        },
      );
      record(`${kind} canvas fog.enabled = false equals no fog`, same, {});
    }
  }
  record(
    'no page, engine or WebGPU validation errors at either sample count',
    !errors.length && !fixtureErrors.length,
    {
      errors: [...errors, ...fixtureErrors],
    },
  );
  await writeFile(
    `${folder}/gpu.json`,
    JSON.stringify({ hardware: browser.hardware, baseline, checks, failures }, null, 2) + '\n',
  );
  console.log(
    JSON.stringify(
      { hardware: browser.hardware.webgpu, baseline, checks: checks.length, failures, report: `${folder}/gpu.json` },
      null,
      2,
    ),
  );
  assert.deepEqual(failures, [], 'Fog GPU checks failed');
} finally {
  await browser?.page.evaluate(() => window.fogFixture?.dispose()).catch(() => {});
  await browser?.close();
  release();
}
