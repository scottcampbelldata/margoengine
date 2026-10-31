// Real-GPU proof (run from the repository root after building packages, one GPU job at a time):
//   node packages/sky/test/browser-check.mjs
// Every demo sky configuration rendered with the full Sky and with `@margoengine/sky/base` plus only the features it
// uses must produce bit-identical HDR scene pixels (and reflection maps) on every frame, at 4x and at 1x MSAA. The
// default sky's horizon must match the CPU Preetham reference (preetham-reference.js) and not be pink.
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { openBrowser } from '../../../scripts/browser.js';
import { configs } from './configs.js';
import { preethamRGB } from './preetham-reference.js';
const context = await openBrowser({ startPath: '/packages/sky/test/browser-check.html', port: 5211 }),
  { page, hardware } = context,
  pageErrors = [],
  report = { hardware, results: {} };
page.on('pageerror', (e) => pageErrors.push(e.message));
page.on('console', (m) => {
  if (m.type() === 'error') pageErrors.push(m.text());
});
try {
  console.log('adapter', JSON.stringify(hardware.webgpu));
  for (const samples of [4, 1]) {
    await page.goto(`http://127.0.0.1:5211/packages/sky/test/browser-check.html${samples === 1 ? '?samples=1' : ''}`);
    await page.waitForFunction(() => window.ready, null, { timeout: 60000 });
    for (const name of Object.keys(configs)) {
      // `control` repeats the full Sky: it shows the comparison is deterministic, so a match with `narrow` means something.
      for (const variant of ['full', 'control', 'narrow']) {
        const r = await page.evaluate(([n, v]) => window.check.run(n, v), [name, variant]);
        assert.equal(r.error, null, `${name} ${variant}`);
        assert.deepEqual(r.errors, [], `${name} ${variant}`);
      }
      assert.equal(await page.evaluate(() => window.check.samples()), samples);
      for (const against of ['control', 'narrow']) {
        const frames = await page.evaluate((y) => window.check.compare('full', y), against);
        report.results[`${name} ${samples}x full vs ${against}`] = frames;
        for (const [i, frame] of frames.entries())
          for (const [image, result] of Object.entries(frame)) {
            assert.ok(
              result.lit > result.pixels / 2,
              `${name} ${samples}x frame ${i} ${image} rendered too little: ${JSON.stringify(result)}`,
            );
            assert.equal(
              result.differing,
              0,
              `${name} ${samples}x frame ${i} ${image} vs ${against}: ${JSON.stringify(result)}`,
            );
          }
      }
      const frames = report.results[`${name} ${samples}x full vs narrow`];
      console.log(`ok ${name} ${samples}x: ${frames.length} frames identical`);
    }
  }
  // Weather: rain, snow and lightning draw on a real GPU and leave no trace once off.
  await page.goto('http://127.0.0.1:5211/packages/sky/test/weather-check.html');
  await page.waitForFunction(() => window.ready, null, { timeout: 60000 });
  const weather = await page.evaluate(() => window.check.run());
  report.results.weather = weather;
  assert.equal(weather.validation, null);
  assert.deepEqual(weather.errors, []);
  assert.ok(weather.rainChanged > 200, `rain changed ${weather.rainChanged} of ${weather.pixels} pixels`);
  assert.ok(weather.snowChanged > 200, `snow changed ${weather.snowChanged} of ${weather.pixels} pixels`);
  assert.equal(weather.afterNone, 0, 'precipitation none draws nothing');
  assert.equal(weather.dry, 0, 'intensity 0 draws nothing');
  assert.ok(weather.flashGain > 0, `the flash lit the frame: ${JSON.stringify(weather)}`);
  assert.equal(weather.afterFlash, 0, 'the frame returns to dry after the flash');
  console.log('ok weather: rain', weather.rainChanged, 'snow', weather.snowChanged, 'flash gain', weather.flashGain);
  // Fog while the view turns: a frame that has just moved equals the still frame of the same camera, at 4x and 1x. Fog
  // reading a stale depth leaves a band of unfogged scene along every silhouette (Plaza, 2026-10-31).
  for (const samples of [4, 1]) {
    await page.goto(
      `http://127.0.0.1:5211/packages/sky/test/fog-motion-check.html${samples === 1 ? '?samples=1' : ''}`,
    );
    await page.waitForFunction(() => window.ready, null, { timeout: 60000 });
    const r = await page.evaluate(() => window.check.run());
    report.results[`fog motion ${samples}x`] = r;
    assert.equal(r.samples, samples);
    assert.equal(r.error, null);
    assert.deepEqual(r.errors, []);
    assert.ok(r.fogged > 1000, `fog drew too little: ${JSON.stringify(r)}`);
    assert.ok(r.moved > 100, `the turn moved too little: ${JSON.stringify(r)}`);
    assert.equal(r.differing, 0, `${samples}x fog lags a turning view: ${JSON.stringify(r)}`);
    console.log(`ok ${samples}x fog while turning: 0 of ${r.pixels} pixels differ from the still frame`);
  }
  // Horizon colour: the default sky at noon (and a hazier one) matches the CPU reference just below the horizon,
  // and is not pink there (red never above green, green never above blue), as on the CIE daylight locus. Turbidity 1
  // draws as 2 (below about 1.65 the Preetham fit drew a black sky).
  await page.goto('http://127.0.0.1:5211/packages/sky/test/horizon-check.html');
  await page.waitForFunction(() => window.ready, null, { timeout: 60000 });
  for (const options of [{}, { turbidity: 5 }, { turbidity: 1 }]) {
    const r = await page.evaluate((o) => window.check.run(o), options),
      label = `horizon ${JSON.stringify(options)}`;
    assert.equal(r.error, null, label);
    assert.deepEqual(r.errors, [], label);
    assert.ok(Math.abs(r.hours - 12) < 1e-3, `${label}: default clock at noon, got ${r.hours}`);
    const expected = preethamRGB(
      [0, 0.01 / Math.hypot(1, 0.01), -1 / Math.hypot(1, 0.01)],
      r.sun,
      options.turbidity ?? 2,
    );
    assert.ok(r.pixels.length > 100, `${label}: ${r.pixels.length} pixels`);
    for (const [i, p] of r.pixels.entries()) {
      for (let c = 0; c < 3; c++)
        assert.ok(
          Math.abs(p[c] - expected[c]) <= 0.01 * expected[c],
          `${label} pixel ${i} channel ${c}: ${p[c]} vs CPU ${expected[c]} (rgb ${p}, CPU ${expected})`,
        );
      assert.ok(p[0] <= p[1] && p[1] <= p[2], `${label} pixel ${i} is tinted, not daylight: rgb ${p}`);
    }
    report.results[label] = { pixel: r.pixels[0], expected };
    console.log(`ok ${label}: rgb ${r.pixels[0].map((v) => v.toFixed(4))}, CPU ${expected.map((v) => v.toFixed(4))}`);
  }
  assert.deepEqual(pageErrors, []);
  await writeFile('test-results/sky-entries-browser-check.json', JSON.stringify(report, null, 1));
  console.log('sky entries browser check passed');
} finally {
  await context.close();
}
