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
      console.log(
        `  presets ${samples}x ${name}: ground ${show(r[name].ground)}, wall ${show(r[name].wall)}, sky ${show(r[name].sky)}`,
      );
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
  async scenes(page, samples) {
    const r = await page.evaluate(() => window.check.run());
    assert.equal(r.error, null);
    assert.deepEqual(r.errors, []);
    const names = ['noon', 'goldenHour', 'overcast', 'dawn'],
      mean = (v) => sum(v) / 3,
      // Visibility 20 km, 10 km, 2 km, 600 m (density 3.912 / visibility); the block's face is 1,403 m along the ray.
      expected = { noon: 3.912 / 20000, goldenHour: 3.912 / 10000, overcast: 3.912 / 2000, dawn: 3.912 / 600 };
    for (const name of names)
      console.log(
        `  scenes ${samples}x ${name}: ground on screen ${r[name].ground}, fog transmittance ${r[name].transmittance.toFixed(4)} (exp(-density x d) ${Math.exp(-expected[name] * 1403).toFixed(4)})`,
      );
    // On screen (8-bit, after bloom and the grade) every scene's lit ground is within a factor of two of noon's,
    // though the presets light it 0.2 to 0.7 times as much in HDR: the grade's exposure brings it back.
    for (const name of names) {
      const k = mean(r[name].ground) / mean(r.noon.ground);
      assert.ok(k > 0.5 && k < 2, `${name} ground ${k.toFixed(2)} of noon on screen`);
    }
    // The fog leaves exp(-density x distance) of the block's own light (Beer-Lambert, the 'exp' falloff from 0 m):
    // within 0.02, the reach of the block's depth across the centre texel and of half-float colour.
    for (const name of names) {
      const want = Math.exp(-expected[name] * 1403);
      assert.ok(
        Math.abs(r[name].transmittance - want) < 0.02,
        `${name} transmittance ${r[name].transmittance}, want ${want}`,
      );
    }
    // set() switches a running scene to the picture of one attached fresh, and dispose removes every plugin it added.
    r.switched.ground.forEach((x, i) =>
      assert.ok(Math.abs(x - r.dawn.ground[i]) <= 2, `switched ${r.switched.ground} against ${r.dawn.ground}`),
    );
    assert.ok(Math.abs(r.switched.transmittance - r.dawn.transmittance) < 1e-3);
    assert.equal(r.plugins.after, r.plugins.before);
    console.log(
      `ok scenes ${samples}x: ground on screen ${names.map((n) => mean(r[n].ground).toFixed(0)).join(', ')}; fog transmittance ${names.map((n) => r[n].transmittance.toFixed(3)).join(', ')}`,
    );
    return r;
  },
  async stars(page, samples) {
    const r = await page.evaluate(() => window.check.run());
    assert.equal(r.error, null);
    assert.deepEqual(r.errors, []);
    console.log(
      `  stars ${samples}x: centre elevation ${r.centreElevation.toFixed(1)}, ${r.radiance.measured} pixels within ${(100 * r.radiance.worst).toFixed(2)}% (${r.radiance.faintest.toPrecision(3)} to ${r.radiance.brightest.toPrecision(3)}), clouds mean ${r.clouds.mean.toFixed(3)} spread ${r.clouds.spread.toFixed(2)}, horizon ${r.horizon.above} above ${r.horizon.below} below, behind a mesh ${r.occluded.behind} (open ${r.occluded.open.toPrecision(3)}), by day ${r.day.drawn}`,
    );
    assert.ok(r.centreElevation > 60, 'the galactic centre stands high');
    // Each sampled pixel holds the band's radiance times its solid angle: within 1% (0.32% measured on a Radeon 680M),
    // the reach of half-float colour and of float32 rays.
    assert.ok(r.radiance.measured >= 60, `${r.radiance.measured} pixels measured`);
    assert.ok(r.radiance.worst < 0.01, `worst ${r.radiance.worst}`);
    assert.ok(r.radiance.brightest > 10 * r.radiance.faintest, 'the band stands out of the sky beside it');
    // Star clouds change the field pixel by pixel but keep its light within 15%.
    assert.ok(Math.abs(r.clouds.mean - 1) < 0.15, `clouds mean ${r.clouds.mean}`);
    assert.ok(r.clouds.spread > 0.2, `clouds spread ${r.clouds.spread}`);
    assert.ok(r.horizon.above > 1000 && r.horizon.below === 0, `horizon ${JSON.stringify(r.horizon)}`);
    assert.ok(r.occluded.behind === 0 && r.occluded.open > 0, `occluded ${JSON.stringify(r.occluded)}`);
    assert.deepEqual(r.day, { drawn: 0, night: 0 });
    console.log(
      `ok stars ${samples}x: radiance within ${(100 * r.radiance.worst).toFixed(2)}% over ${r.radiance.measured} pixels; clouds mean ${r.clouds.mean.toFixed(3)}`,
    );
    return r;
  },
  async aurora(page, samples) {
    const r = await page.evaluate(() => window.check.run());
    assert.equal(r.error, null);
    assert.deepEqual(r.errors, []);
    const redShare = (v) => v.red / v.green;
    console.log(
      `  aurora ${samples}x: blocks ${r.blocks.blocks.map((b) => (b.got / b.want).toFixed(3)).join(', ')}; red over green at 20 degrees ${redShare(r.height.low).toFixed(3)}, at 50 ${redShare(r.height.high).toFixed(3)}; same time ${r.time.same}, 20 s on ${r.time.moved.toFixed(2)}; horizon ${r.horizon.above} above ${r.horizon.below} below; behind a mesh ${r.occluded.behind} (open ${r.occluded.open.toPrecision(3)}); by day ${r.day}`,
    );
    // The 64-step march gives each bright 8 x 8 block the light of the 4,000-step column within 5%.
    assert.ok(r.blocks.total > 0 && r.blocks.blocks.length === 6);
    assert.ok(r.blocks.worst < 0.05, `worst block ${r.blocks.worst}`);
    // Green low, red high: the red share of the light at 50 degrees at least three times that at 20.
    assert.ok(
      Number.isFinite(redShare(r.height.high)) && redShare(r.height.high) > 3 * redShare(r.height.low),
      'redder higher up',
    );
    assert.ok(r.height.low.green > r.height.low.red, 'green below');
    // The same picture at the same time; 20 s on, the folds and rays have moved at least a fifth of the light.
    assert.equal(r.time.same, 0);
    assert.ok(r.time.moved > 0.2, `moved ${r.time.moved}`);
    assert.ok(r.horizon.above > 1000 && r.horizon.below === 0, `horizon ${JSON.stringify(r.horizon)}`);
    assert.ok(r.occluded.behind === 0 && r.occluded.open > 0, `occluded ${JSON.stringify(r.occluded)}`);
    assert.equal(r.day, 0);
    console.log(`ok aurora ${samples}x: blocks within ${(100 * r.blocks.worst).toFixed(2)}% of the column`);
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
      try {
        report.results[`${name} ${samples}x`] = await checks[name](page, samples);
      } finally {
        await page.evaluate(() => window.check.dispose());
      }
    }
  assert.deepEqual(pageErrors, []);
  await mkdir('test-results', { recursive: true });
  await writeFile('test-results/scenery-check.json', JSON.stringify(report, null, 1));
  console.log('scenery check passed');
} finally {
  await context.close();
}
