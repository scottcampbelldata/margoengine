// Real-GPU proof of the scenery entries (run from the repository root after building packages, one GPU job at a time):
// node packages/scenery/test/scenery-check.mjs [name...]
// Each page compiles its entry's shaders on the browser's WebGPU and reads back Bloom's HDR scene capture, at 4x and
// 1x sampling; the bounds below are what each preset or effect must do, not a picture match.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { openBrowser } from '../../../scripts/browser.js';

const show = (v) => v.map((x) => x.toPrecision(3)).join(', ');
const sum = (v) => v[0] + v[1] + v[2];
const warmth = (v) => v[0] / v[2];
const checks = {
  async presets(page, samples) {
    const r = await page.evaluate((c) => window.check.run(c), JSON.parse(process.env.PRESET_CHANGES ?? '{}'));
    assert.equal(r.error, null);
    assert.deepEqual(r.errors, []);
    for (const name of ['noon', 'goldenHour', 'overcast', 'dawn'])
      console.log(`  presets ${samples}x ${name}: ground ${show(r[name].ground)}, wall ${show(r[name].wall)}, sky ${show(r[name].sky)}`);
    // Noon: the brightest ground, under a blue sky (Rayleigh: blue over green over red).
    for (const name of ['goldenHour', 'overcast', 'dawn'])
      assert.ok(sum(r.noon.ground) > sum(r[name].ground), `noon ground brightest, not ${name}`);
    const [sr, sg, sb] = r.noon.sky;
    assert.ok(sb > sg && sg > sr, `noon sky blue: ${show(r.noon.sky)}`);
    // Golden hour and dawn: the low sun through more air lights a wall facing it warmer than noon's sun does (red
    // over blue at least twice noon's); dawn's lower sun lights it less than golden hour's.
    assert.ok(warmth(r.goldenHour.wall) > 2 * warmth(r.noon.wall), 'golden hour warmer than noon');
    assert.ok(warmth(r.dawn.wall) > 2 * warmth(r.noon.wall), 'dawn warmer than noon');
    assert.ok(sum(r.dawn.wall) < sum(r.goldenHour.wall), 'dawn dimmer than golden hour');
    // Overcast: a grey ground (no channel 25% over another), lit mostly by the sky, with 10% to 35% of noon's light
    // (daylight measurements give about 10 to 25 klux against about 100 klux).
    const spread = (v) => Math.max(...v) / Math.min(...v);
    assert.ok(spread(r.overcast.ground) < 1.25, `overcast ground grey: ${show(r.overcast.ground)}`);
    const share = sum(r.overcast.ground) / sum(r.noon.ground);
    assert.ok(share > 0.1 && share < 0.35, `overcast ground ${share.toFixed(2)} of noon`);
    // Switching a running sky with applyDayPreset gives the picture of a sky built from the preset.
    r.switched.ground.forEach((x, i) =>
      assert.ok(
        Math.abs(x - r.goldenHour.ground[i]) <= 1e-3 * Math.max(1, r.goldenHour.ground[i]),
        `switched ${show(r.switched.ground)}`,
      ),
    );
    console.log(
      `ok presets ${samples}x: noon ground ${sum(r.noon.ground).toFixed(3)}; wall red over blue golden ${warmth(r.goldenHour.wall).toFixed(2)}, dawn ${warmth(r.dawn.wall).toFixed(2)}, noon ${warmth(r.noon.wall).toFixed(2)}; overcast ground ${share.toFixed(2)} of noon`,
    );
    return r;
  },
};
const names = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(checks);
const context = await openBrowser({ startPath: `/packages/scenery/test/${names[0]}-check.html`, port: 'free' }),
  { page, hardware } = context,
  pageErrors = [],
  report = { hardware, results: {} };
page.on('pageerror', (e) => pageErrors.push(e.message));
page.on('console', (m) => {
  if (m.type() === 'error') pageErrors.push(m.text());
});
try {
  const origin = new URL(page.url()).origin;
  console.log('adapter', JSON.stringify(hardware.webgpu));
  for (const name of names)
    for (const samples of [4, 1]) {
      await page.goto(`${origin}/packages/scenery/test/${name}-check.html${samples === 1 ? '?samples=1' : ''}`);
      await page.waitForFunction(() => window.ready, null, { timeout: 60000 });
      assert.equal(await page.evaluate(() => window.check.samples()), samples);
      report.results[`${name} ${samples}x`] = await checks[name](page, samples);
    }
  assert.deepEqual(pageErrors, []);
  await mkdir('test-results', { recursive: true });
  await writeFile('test-results/scenery-check.json', JSON.stringify(report, null, 1));
  console.log('scenery check passed');
} finally {
  await context.close();
}
