import assert from 'node:assert/strict';
import { openBrowser } from '../../../scripts/browser.js';
const name = process.argv.find((a) => ['gltf', 'cover', 'lens'].includes(a)) ?? 'gltf';
const browser = await openBrowser({ startPath: `/packages/weather/tests/${name}-check.html`, port: 'free' });
const errors = [];
browser.page.on('pageerror', (e) => errors.push(e.message));
try {
  await browser.page.waitForFunction(() => window.ready, null, { timeout: 60000 });
  const result = await browser.page.evaluate(() => window.run());
  console.log(name, JSON.stringify(result));
  assert.deepEqual(errors, []);
  assert.deepEqual(result.errors, []);
  assert.equal(result.validation, null);
  if (name === 'gltf') {
    // Zero weather inside the weather program: every other input moved, the picture bit-identical and nothing recompiled.
    // The plain-to-weather comparison crosses programs (WGSL 15.7.5, 12.10) and is only printed.
    assert.ok(
      result.weatherProgram.pipelines > 0,
      `the weather program was not counted: ${JSON.stringify(result.weatherProgram)}`,
    );
    assert.ok(Object.keys(result.zeroWeather).length >= 13, JSON.stringify(result.zeroWeather));
    for (const [key, changed] of Object.entries(result.zeroWeather))
      assert.equal(changed, 0, `zero weather, ${key} moved: ${changed} values changed`);
    assert.deepEqual(result.recompiled, { modules: 0, pipelines: 0 });
    assert.equal(result.restored, 0);
    for (const key of ['wet', 'puddles', 'rings', 'snow']) assert.ok(result[key] > 20, `${key}: ${result[key]}`);
  }
  if (name === 'lens') {
    assert.ok(
      result.math.cases >= 2000 && result.math.worst < 1e-4 && result.math.wet > 100,
      JSON.stringify(result.math),
    );
    assert.ok(
      result.longTime.cases >= 2000 && result.longTime.worst < 1e-4 && result.longTime.wet > 100,
      JSON.stringify(result.longTime),
    );
    assert.equal(result.repeat, 0);
    assert.equal(result.disabled, 0);
    for (const key of ['wet', 'moved', 'streaks', 'seeded']) assert.ok(result[key] > 100, `${key}: ${result[key]}`);
  }
  if (name === 'cover') {
    // Flat probes; a 30 degree roof's own surface at 24 points across its texels is exposed (no self-shelter
    // stripes); a sloped receiver under the flat roof stays sheltered.
    assert.deepEqual(result.exposed, [0, 1, 1, 1, 0, 0, 0, ...Array(24).fill(1), 0]);
    assert.ok(result.protectedPixels > 1000);
    assert.equal(result.protectedChanged, 0);
    assert.ok(result.exposedChanged > 1000);
    assert.ok(result.rain > 20);
    assert.ok(result.wet > 1000);
  }
} finally {
  await browser.close();
}
