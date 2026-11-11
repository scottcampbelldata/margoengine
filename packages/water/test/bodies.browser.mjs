import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { openBrowser } from '../../../scripts/browser.js';
import { decodePNG } from '../../../tests/support/png.js';

// Water bodies on the GPU: drawn only inside their outlines and splines, at their own levels, tinted, with WaveQuery
// heights and velocities that match the CPU body map, and a clean detach, restore and re-rasterize.
process.chdir(fileURLToPath(new URL('../../../', import.meta.url)));
await mkdir('test-results', { recursive: true });
const browser = await openBrowser({ port: 'free', startPath: '/tests/modern-game.html' }),
  { page, hardware } = browser,
  mode = hardware?.compat ? 'compat' : 'webgpu',
  errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(m.text());
});
const shot = (name) =>
  page.locator('canvas').screenshot(name ? { path: `test-results/water-bodies-${name}-${mode}.png` } : {});
try {
  const points = await page.evaluate(async () => {
    const { EngineKernel } = await import('/packages/core/dist/index.js');
    const { Water } = await import('/packages/water/dist/index.js');
    const canvas = document.createElement('canvas');
    canvas.style.cssText = 'width:256px;height:192px';
    document.body.replaceChildren(canvas);
    const engine = await EngineKernel.create(canvas, {
      backend: 'webgpu',
      capacity: 8,
      camera: { position: [0, 45, 30], target: [0, 0, 0], near: 0.1, far: 200 },
    });
    engine.gpu.pushErrorScope('validation');
    engine.render({ delta: 0 });
    const m = engine.camera.matrix;
    const project = (p) => {
      const c = [0, 1, 2, 3].map((r) => m[r] * p[0] + m[4 + r] * p[1] + m[8 + r] * p[2] + m[12 + r]);
      return [(c[0] / c[3]) * 0.5 + 0.5, 0.5 - (c[1] / c[3]) * 0.5];
    };
    window.bodiesTest = { engine, Water };
    return { lake: project([-12, 1, 0]), river: project([9, 0, 0]), dry: project([22, 0, -18]) };
  });
  for (const p of Object.values(points))
    assert.ok(
      p.every((v) => v > 0.05 && v < 0.95),
      'probe on screen',
    );
  const background = await shot();
  await page.evaluate(() => {
    const t = window.bodiesTest;
    t.water = t.Water.attach(t.engine, {
      size: [64, 64],
      segments: 128,
      waves: [{ direction: [1, 0.3], amplitude: 0.25, wavelength: 9 }],
    });
    t.engine.render({ delta: 0 });
  });
  const open = await shot();
  const result = await page.evaluate(async () => {
    const t = window.bodiesTest;
    const { WaterBodies } = await import('/packages/water/dist/bodies.js');
    const { WaveQuery } = await import('/packages/water/dist/query.js');
    const square = (cx, cz, half) => [
      [cx - half, cz - half],
      [cx + half, cz - half],
      [cx + half, cz + half],
      [cx - half, cz + half],
    ];
    t.bodies = WaterBodies.attach(t.engine, {
      surface: t.water,
      resolution: 256,
      bodies: [
        { outline: square(-12, 0, 7), level: 1, waves: 0, color: [1, 0, 0] },
        {
          path: [
            [6, 0.6, -22],
            [10, 0.2, 0],
            [6, -0.4, 22],
          ],
          width: 6,
          waves: 0,
        },
        { outline: square(-12, -20, 5), level: 0 },
      ],
    });
    t.engine.render({ delta: 0 });
    const query = await WaveQuery.capture(t.water);
    let flat = 0,
      river = 0,
      still = 0,
      wavy = 0;
    for (let x = -16; x <= -8; x += 0.5)
      for (let z = -4; z <= 4; z += 0.5) {
        flat = Math.max(flat, Math.abs(query.heightAt(x, z) - 1));
        still = Math.max(still, Math.hypot(...query.velocityAt(x, z)));
      }
    for (let z = -16; z <= 16; z += 1) {
      const centre = t.bodies.sample(10, z).distance > 2 ? 10 : 7;
      river = Math.max(river, Math.abs(query.heightAt(centre, z) - t.bodies.sample(centre, z).level));
    }
    for (let x = -15; x <= -9; x += 0.5) wavy = Math.max(wavy, Math.abs(query.heightAt(x, -20)));
    return { flat, river, still, wavy };
  });
  assert.ok(result.flat < 1e-4, `still lake height error ${result.flat}`);
  assert.ok(result.still < 1e-4, `still lake velocity ${result.still}`);
  assert.ok(result.river < 2e-3, `river level error ${result.river}`);
  assert.ok(result.wavy > 0.05, `a waves:1 body keeps Water's waves (${result.wavy})`);
  const drawn = await shot('drawn');
  const [bg, op, dr] = await Promise.all([background, open, drawn].map((b) => decodePNG(b)));
  const at = (image, [u, v]) => {
    const i = (Math.round(v * image.height) * image.width + Math.round(u * image.width)) * 4;
    return [image.data[i], image.data[i + 1], image.data[i + 2]];
  };
  const differ = (a, b) => Math.max(...a.map((v, k) => Math.abs(v - b[k])));
  assert.ok(differ(at(op, points.dry), at(bg, points.dry)) > 8, 'open water covers the dry probe first');
  assert.ok(differ(at(dr, points.dry), at(bg, points.dry)) <= 2, 'outside every body the background shows');
  assert.ok(differ(at(dr, points.river), at(bg, points.river)) > 8, 'the river is drawn');
  const lake = at(dr, points.lake),
    plain = at(op, points.lake);
  assert.ok(lake[0] - lake[2] > plain[0] - plain[2] + 10, `lake takes its own colour: ${lake} vs ${plain}`);
  const after = await page.evaluate(async () => {
    const t = window.bodiesTest;
    t.bodies.onDeviceRestored(t.engine);
    t.engine.render({ delta: 0 });
    t.bodies.setBodies([
      {
        outline: [
          [-30, -30],
          [30, -30],
          [0, 30],
        ],
        level: 0.5,
        waves: 0,
      },
    ]);
    t.engine.render({ delta: 0 });
    const { WaveQuery } = await import('/packages/water/dist/query.js');
    const height = (await WaveQuery.capture(t.water)).heightAt(0, 0);
    t.bodies.dispose();
    t.engine.render({ delta: 0 });
    return { height, validation: (await t.engine.gpu.popErrorScope())?.message };
  });
  assert.ok(Math.abs(after.height - 0.5) < 1e-4, `re-rasterized level ${after.height}`);
  assert.equal(after.validation, undefined);
  const detached = await shot();
  assert.ok(detached.equals(open), 'disposing the bodies restores open water exactly');
  await page.evaluate(() => window.bodiesTest.engine.dispose());
  assert.deepEqual(errors, []);
  const report = { hardware, ...result, reheight: after.height };
  console.log(JSON.stringify(report));
  await writeFile(`test-results/water-bodies-${mode}.json`, JSON.stringify(report, null, 2));
} finally {
  await browser.close();
}
