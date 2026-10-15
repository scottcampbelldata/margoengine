// Real-GPU check of @margoengine/clustered/shadows (run on AC power, holding the GPU lock, after npm run build:packages):
//   node examples/package-benchmarks/local-shadows-gpu.mjs
// 1. For a point and a spot light, on a core-mesh floor and on a materials floor, with a core box, a materials box and an
//    instanced box as casters: castShadow off equals LocalShadows detached (the feature changes nothing until used); with
//    castShadow on, the floor where each box's top shadows it is dark; lit floor away from boxes is unchanged (no acne);
//    walking from each box's base away from the light, the shadow starts within 3 px (no peter-panning).
// 2. GPU pass time (timestamp queries, median of 40 profiled frames) at 1280x720 for 8 clustered point lights (maxLights 8)
//    with 0/1/4/8 shadowed, maps cached (static casters) and re-rendered every frame (one dynamic caster), plus 8 shadowed
//    spot lights; the unshadowed baseline first and last. 19 box casters plus the floor.
// Writes results/local-shadows-gpu.json and the frames to test-results/local-shadows-*.png.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { openBrowser } from '../../scripts/browser.js';
import { decodePNG } from '../../tests/support/png.js';

const ac = () =>
  execFileSync(
    'powershell',
    [
      '-NoProfile',
      '-Command',
      '(Get-CimInstance -Namespace root/wmi -ClassName BatteryStatus | Select-Object -First 1).PowerOnline',
    ],
    { encoding: 'utf8' },
  ).trim();
const powerBefore = ac();
assert.equal(powerBefore, 'True', 'measure on AC power only');
const context = await openBrowser({ startPath: '/examples/package-benchmarks/local-shadows.html', port: 5221 }),
  { page, hardware } = context,
  pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(e.message));
page.on('console', (m) => {
  if (m.type() === 'error') pageErrors.push(m.text());
});
const report = {
  benchmark: 'local-shadows-gpu',
  recordedAt: new Date().toISOString(),
  hardware: hardware.webgpu,
  browser: hardware.browserName + ' ' + hardware.browserVersion,
  resolution: [1280, 720],
  powerOnline: { before: powerBefore },
};
try {
  await page.waitForFunction(() => window.ready, null, { timeout: 60000 });
  const shot = async (name, options) => {
    const result = await page.evaluate((o) => window.check.render(o), options);
    assert.equal(result.error, null, name);
    assert.deepEqual(result.errors, [], name);
    return decodePNG(await page.locator('canvas').screenshot({ path: `test-results/local-shadows-${name}.png` }));
  };
  const luma = (image, [x, y]) => {
    const i = (Math.round(y) * image.width + Math.round(x)) * 4;
    return 0.2126 * image.data[i] + 0.7152 * image.data[i + 1] + 0.0722 * image.data[i + 2];
  };
  report.visual = [];
  for (const mode of ['point', 'spot'])
    for (const floor of ['core', 'materials']) {
      await page.evaluate((m) => window.check.setMode(m), mode);
      const name = `${mode}-${floor}`,
        detached = await shot(name + '-detached', { floor, shadow: 'detached' }),
        off = await shot(name + '-off', { floor, shadow: 'off' }),
        on = await shot(name + '-on', { floor, shadow: 'on' });
      const { shadowCentres, grid, walks } = await page.evaluate(() => window.check.points());
      let same = 0;
      for (let i = 0; i < off.data.length; i++)
        if (i % 4 < 3) same = Math.max(same, Math.abs(off.data[i] - detached.data[i]));
      const centres = shadowCentres.map((p) => +(luma(on, p) / luma(off, p)).toFixed(3));
      const acne = grid.map((p) => Math.abs(luma(on, p) - luma(off, p))),
        acneMax = Math.max(...acne),
        acneMean = acne.reduce((a, b) => a + b, 0) / acne.length;
      const gaps = walks.map((walk) => {
        const i = walk.findIndex((p) => luma(on, p) < 0.7 * luma(off, p));
        return i < 0 ? Infinity : +Math.hypot(walk[i][0] - walk[0][0], walk[i][1] - walk[0][1]).toFixed(2);
      });
      const row = {
        mode,
        floor,
        offEqualsDetachedMaxDiff: same,
        shadowCentreRatios: centres,
        acneGridPoints: grid.length,
        acneMaxLumaDiff: +acneMax.toFixed(2),
        acneMeanLumaDiff: +acneMean.toFixed(3),
        contactGapPx: gaps,
      };
      report.visual.push(row);
      console.log(JSON.stringify(row));
      assert.ok(same <= 1, `${name}: castShadow off must equal the detached render`);
      for (const r of centres) assert.ok(r < 0.6, `${name}: shadow missing (on/off ${r})`);
      assert.ok(grid.length > 200 && acneMax <= 3, `${name}: lit floor changed (acne) by ${acneMax}`);
      for (const g of gaps) assert.ok(g <= 3, `${name}: shadow starts ${g} px from the caster`);
    }
  report.timings = [];
  const cases = [
    { count: 0, dynamic: false, attached: false },
    ...[0, 1, 4, 8].flatMap((count) => [
      { count, dynamic: false },
      { count, dynamic: true },
    ]),
    { count: 8, dynamic: false, spot: true },
    { count: 8, dynamic: true, spot: true },
    { count: 0, dynamic: false, attached: false },
  ];
  for (const c of cases) {
    const row = await page.evaluate((o) => window.check.bench(o), c);
    assert.deepEqual(row.errors, []);
    delete row.errors;
    report.timings.push(row);
    console.log(JSON.stringify(row));
  }
  assert.deepEqual(pageErrors, []);
} finally {
  await context.close();
}
report.powerOnline.after = ac();
assert.equal(report.powerOnline.after, 'True', 'still on AC power');
await writeFile(resolve(import.meta.dirname, 'results/local-shadows-gpu.json'), JSON.stringify(report, null, 2) + '\n');
console.log('local shadows GPU check passed');
