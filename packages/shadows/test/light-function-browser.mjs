// Real-GPU check of `@margoengine/shadows/light-function`. Clouds: at each ground point the sky's own render along the ray to
// the sun says whether a cloud stands in front of the sun, and the ground's light must say the same, now and after the sky's
// clock has moved the clouds. Effects: every kind of receiver, on both shadow classes, must go dark under a black pattern.
// Run from the repository root after `npm run build:packages`: node packages/shadows/test/light-function-browser.mjs
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { openBrowser } from '../../../scripts/browser.js';

process.chdir(fileURLToPath(new URL('../../..', import.meta.url)));
const toLight = [-0.35, 0.8, 0.3];
const points = [];
for (let i = 0; i < 16; i++) for (let j = 0; j < 16; j++) points.push([(i - 7.5) * 450, (j - 7.5) * 450]);
const context = await openBrowser({ startPath: '/packages/shadows/test/light-function.html', port: 5275 }),
  { page } = context,
  pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(e.message));
page.on('console', (m) => m.type() === 'error' && pageErrors.push(m.text()));
const linear = (v) => {
  const c = v / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
};
// Light from a pixel: as check.mjs in outside/, through Khronos PBR Neutral's toe.
const light = (v) => {
  const y = linear(v);
  return y >= 0.04 ? y + 0.04 : 0.4 * Math.sqrt(y);
};
// 8-bit pixels: a sky within 3 steps of its clear colour shows no cloud, ground within 2 percent of its light no shadow.
const skyCloud = (r) => Math.max(...r.cloudy.map((v, i) => Math.abs(v - r.clear[i]))) > 3;
const groundLight = (r) => light(r.shaded[1]) / light(r.open[1]);
const groundCloud = (r) => groundLight(r) < 0.98;
const agreement = (sky, ground) => {
  let same = 0;
  for (let i = 0; i < sky.length; i++) same += skyCloud(sky[i]) === groundCloud(ground[i]) ? 1 : 0;
  return same / sky.length;
};
const read = async () => {
  const r = await page.evaluate(([p, l]) => window.check.read(p, l), [points, toLight]);
  assert.deepEqual(r.errors, []);
  return r.out;
};
try {
  await page.waitForFunction(() => window.ready, null, { timeout: 120000 });
  assert.deepEqual(await page.evaluate((l) => window.check.clouds(l), toLight), []);
  const before = await read(),
    drift = await page.evaluate(() => window.check.advance(300)),
    after = await read();
  assert.equal(drift, 2400);
  const cloudy = before.filter(skyCloud).length / before.length;
  assert.ok(cloudy > 0.15 && cloudy < 0.85, `clouds cover ${cloudy} of the points, so the comparison sees too little`);
  const now = agreement(before, before),
    later = agreement(after, after),
    stale = agreement(after, before),
    deep = before.filter((r) => groundLight(r) < 0.5).length;
  console.log(JSON.stringify({ cloudy, now, later, stale, deep }));
  // A point decides differently only when its cloud sits on a threshold, and the two thresholds sit near opacity 0.02.
  assert.ok(now >= 0.97, `the ground agrees with the sky at ${now} of the points`);
  assert.ok(later >= 0.97, `after 300 s the ground agrees with the sky at ${later} of the points`);
  // The control: the ground from before the clouds moved must not fit the sky after, or this check sees no motion.
  assert.ok(stale < 0.85, `the old ground fits the new sky at ${stale}`);
  assert.ok(deep > 10, 'no deep shadow under the clouds');
  await page.evaluate(() => window.check.end());
  for (const kind of ['shadows', 'virtual'])
    for (const name of ['mesh', 'material', 'gltf', 'terrain', 'voxels']) {
      const r = await page.evaluate(([n, k]) => window.check.receiver(n, k), [name, kind]);
      assert.deepEqual(r.errors, [], `${name} under ${kind}`);
      console.log(JSON.stringify({ name, kind, open: r.open, dark: r.dark }));
      assert.ok(Math.max(...r.open) > 40, `${name} under ${kind} has no light to take away`);
      assert.ok(
        Math.max(...r.dark) < Math.max(...r.open) * 0.5,
        `${name} under ${kind} ignored the pattern: ${r.open} to ${r.dark}`,
      );
    }
  // A device restore (KB-RESTORE-BORROWED1): a plain mask is dropped and reported once, the frame goes on unmasked and
  // setTexture brings it back; a function mask is made again on the new device. Restores come last: they replace the device.
  for (const kind of ['shadows', 'virtual']) {
    // Each kind restores twice; core gives up after 4 losses in a row (reload the page), so each gets a fresh page.
    if (kind === 'virtual') {
      await page.reload();
      await page.waitForFunction(() => window.ready, null, { timeout: 120000 });
    }
    const r = await page.evaluate((k) => window.check.restore(k), kind);
    console.log(JSON.stringify({ restore: kind, plain: r.plain, made: r.made, reports: r.reports }));
    assert.deepEqual(r.thrown, [], `${kind}: a frame threw after the restore`);
    assert.deepEqual(r.errors, [], `${kind}: validation errors after the restore`);
    const near = (x, y, what) =>
      assert.ok(
        x.every((v, i) => Math.abs(v - y[i]) <= 2),
        `${kind} ${what}: ${x} against ${y}`,
      );
    assert.ok(Math.max(...r.plain.dark) < Math.max(...r.plain.open) * 0.5, `${kind}: the plain mask did not darken`);
    near(r.plain.lost, r.plain.open, 'lost mask equals no mask');
    near(r.plain.back, r.plain.dark, 'setTexture brings the mask back');
    assert.equal(r.plain.reports, 1, `${kind}: one report for the lost mask`);
    assert.equal(r.reports.length, 1, `${kind}: the function form reports nothing`);
    assert.equal(r.reports[0].code, 'state');
    assert.match(r.reports[0].message, /lightPattern texture lost with the device; pass a function or call setTexture/);
    near(r.made.after, r.made.before, 'function mask after the restore');
    near(r.made.before, r.plain.dark, 'function mask darkens as the plain one');
    assert.equal(r.made.calls, 2, `${kind}: the function is called once per device`);
  }
  assert.deepEqual(pageErrors, []);
  console.log('light functions: ok');
} finally {
  await context.close?.();
}
