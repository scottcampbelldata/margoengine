// Real-GPU proof (MARGO_COMPAT=1 for the WebGL2 layer) of @margoengine/weather/settings (run from the repository root after building packages):
//   node scripts/run-with-timeout.mjs -- node packages/weather/tests/settings-check.mjs
// Writing every live row each frame for 60 frames (applyWeatherSettings, a WeatherDrive pushing the state into the sea,
// the sky's rain and a smoke effect) makes no pipeline, buffer or texture and no GPU error, and the sea, rain and smoke
// follow the last values written. Smoke, ash and spray each change the frame from a load of 0, which draws the clean frame exact.
import assert from 'node:assert/strict';
import { openBrowser } from '../../../scripts/browser.js';
const url = 'http://127.0.0.1:5271/packages/weather/tests/settings-check.html',
  context = await openBrowser({ startPath: '/packages/weather/tests/settings-check.html', port: 5271 }),
  { page, hardware } = context,
  pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(e.message));
page.on('console', (m) => {
  if (m.type() === 'error') pageErrors.push(m.text());
});
try {
  console.log('adapter', JSON.stringify(hardware.webgpu), hardware.compat ? '(WebGL2 compatibility)' : '');
  await page.goto(url);
  await page.waitForFunction(() => window.ready, null, { timeout: 120000 });
  const r = await page.evaluate(() => window.check.run());
  assert.deepEqual(r.errors, [], 'GPU errors');
  assert.deepEqual(r.after, r.before, `60 frames of every live row made GPU objects: ${JSON.stringify(r)}`);
  assert.ok(r.same, 'writing the same values again leaves the state unchanged');
  assert.ok(Math.abs(r.sea.speed - r.wind) < 1e-3, `the sea follows the wind: ${JSON.stringify(r.sea)} vs ${r.wind}`);
  assert.ok(r.smokeWind && Math.hypot(...r.smokeWind) > 0.1, 'the smoke leans');
  const x = await page.evaluate(() => window.check.exact());
  assert.deepEqual(x.repeat, { differing: 0, max: 0 }, `two renders of one state differ, so exactness cannot be judged: ${JSON.stringify(x)}`);
  assert.ok(x.apart.differing > 1000, `clear and storm should draw differently: ${JSON.stringify(x)}`);
  assert.deepEqual(x.defaults, { differing: 0, max: 0 }, `the default rows draw the clear preset frame exact: ${JSON.stringify(x)}`);
  assert.deepEqual(x.storm, { differing: 0, max: 0 }, `WEATHER_LOOKS.storm draws the storm preset frame exact: ${JSON.stringify(x)}`);
  console.log('ok weather frame exact: defaults = clear, storm look = storm preset, 30 frames, clear vs storm differ in', x.apart.differing, 'bytes');
  const dust = await page.evaluate(() => window.dust());
  assert.equal(dust.zero, 0, `dust 0 draws the dustless frame exact: ${JSON.stringify(dust)}`);
  assert.ok(dust.hazeApart > 1000 && dust.stormApart > 1000 && dust.haboobApart > 1000, `each step of dust changes the frame: ${JSON.stringify(dust)}`);
  assert.equal(dust.colors.clear, null, 'no dust tint without dust');
  assert.ok(dust.colors.storm && dust.colors.storm[0] > dust.colors.storm[2], `the sandstorm tints the fog yellow-brown: ${JSON.stringify(dust)}`);
  const [hr, hg, hb] = dust.means.haboob;
  assert.ok(hr > hg && hg > hb, `the haboob's haze reads red over green over blue: ${JSON.stringify(dust.means)}`);
  console.log(`ok weather dust: clear ${dust.means.clear}, haze ${dust.means.haze}, sandstorm ${dust.means.storm}, haboob ${dust.means.haboob} (mean RGB of the far ground rows)`);
  const smoke = await page.evaluate(() => window.smoke());
  assert.equal(smoke.zero, 0, `smoke 0 draws the smokeless frame exact: ${JSON.stringify(smoke)}`);
  assert.ok(smoke.hazeApart > 1000 && smoke.fireApart > 1000 && smoke.blackApart > 1000, `each step of smoke changes the frame: ${JSON.stringify(smoke)}`);
  assert.equal(smoke.colors.clear, null, 'no smoke tint without smoke');
  assert.equal(smoke.suns.clear, null, 'no sun colour is written without smoke');
  const [sr, sg, sb] = smoke.suns.haze;
  assert.ok(sr > sg && sg > sb && sr < 1, `the smoke haze reddens and dims the sun: ${JSON.stringify(smoke.suns)}`);
  assert.ok(smoke.suns.fire[1] < smoke.suns.haze[1] && smoke.suns.black[1] < smoke.suns.fire[1], `more smoke, less sun: ${JSON.stringify(smoke.suns)}`);
  const lum = ([r, g, b]) => 0.2126 * r + 0.7152 * g + 0.0722 * b;
  // The lit ground and the haze in front of it darken at every step up to a black day: the haze is lit by the light that
  // reaches into the layer, not at full light (KB-AIR-HAZELIGHT1).
  for (const rows of ['near', 'means'])
    assert.ok(
      lum(smoke[rows].haze) < lum(smoke[rows].clear) && lum(smoke[rows].fire) < lum(smoke[rows].haze) && lum(smoke[rows].black) < lum(smoke[rows].fire),
      `the ${rows === 'near' ? 'lit ground' : 'far haze'} darkens with each step of smoke: ${JSON.stringify(smoke[rows])}`,
    );
  assert.ok(smoke.colors.black && smoke.colors.black[0] > smoke.colors.black[2], `a black day tints the fog grey brown: ${JSON.stringify(smoke.colors)}`);
  console.log(`ok weather smoke: lit ground clear ${smoke.near.clear}, haze ${smoke.near.haze}, wildfire ${smoke.near.fire}, black day ${smoke.near.black}; sun colour haze ${smoke.suns.haze.map((v) => v.toFixed(2))}`);
  const air = await page.evaluate(() => window.airLoad());
  assert.equal(air.zero, 0, `ash 0 and spray 0 draw the clean frame exact: ${JSON.stringify(air)}`);
  assert.ok(air.ashApart > 1000 && air.darkApart > 1000 && air.surfApart > 1000, `each step of ash and spray changes the frame: ${JSON.stringify(air)}`);
  assert.equal(air.suns.clear, null, 'no sun colour is written without a load');
  for (const k of ['ash', 'dark', 'surf']) {
    const [r, g, b] = air.suns[k];
    assert.ok(r === g && g === b && r < 1, `${k} dims the sun grey: ${JSON.stringify(air.suns)}`);
  }
  assert.ok(air.suns.dark[0] < air.suns.ash[0], `more ash, less sun: ${JSON.stringify(air.suns)}`);
  // The lit ground and the haze in front of it darken from the ash fall to the darkness (KB-AIR-HAZELIGHT1: the haze was
  // lit at full light, so the darkness read brighter than the ash fall).
  for (const rows of ['near', 'means'])
    assert.ok(lum(air[rows].ash) < lum(air[rows].clear) && lum(air[rows].dark) < lum(air[rows].ash), `the ${rows === 'near' ? 'lit ground' : 'far haze'} darkens with the ash: ${JSON.stringify(air[rows])}`);
  const spread = (c) => Math.max(...c) / Math.min(...c);
  // The ash's own colour (the fog colour over the light reaching the layer) is a neutral grey.
  assert.ok(air.colors.ash && spread(air.colors.ash.map((v, i) => v / air.lights.ash[i])) < 1.1, `the ash fog is a neutral grey: ${JSON.stringify(air)}`);
  assert.ok(air.colors.surf && Math.min(...air.colors.surf) > Math.max(...air.colors.ash), `the spray fog is whiter than the ash fog: ${JSON.stringify(air.colors)}`);
  console.log(`ok weather ash and spray: lit ground clear ${air.near.clear}, ash fall ${air.near.ash}, darkness ${air.near.dark}, surf haze ${air.near.surf}; sun ash ${air.suns.ash[0].toFixed(2)}, darkness ${air.suns.dark[0].toFixed(3)}`);
  const vol = await page.evaluate(() => window.volumeLoad());
  assert.equal(vol.zero, 0, `ash 0 and smoke 0 draw the clean fog-volume frame exact: ${JSON.stringify(vol)}`);
  assert.equal(vol.colors.clear, null, 'no colour is written into the volume without a load');
  assert.equal(vol.heldRepeat, 0, `two renders of one held state differ, so the colour cannot be judged: ${JSON.stringify(vol)}`);
  assert.ok(vol.ashApart > 1000, `the ash colour changes the fog-volume frame against the same ash held white: ${JSON.stringify(vol)}`);
  assert.deepEqual(vol.colors.held, [1, 1, 1], 'an air.color row set by hand holds against the drive');
  assert.ok(vol.colors.ash && Math.max(...vol.colors.ash) < 0.9 && spread(vol.colors.ash) < 1.1, `the ash greys the volume: ${JSON.stringify(vol.colors)}`);
  assert.ok(vol.colors.smoke && vol.colors.smoke[0] > vol.colors.smoke[2], `smoke turns the volume grey brown: ${JSON.stringify(vol.colors)}`);
  assert.ok(lum(vol.means.ash) < lum(vol.means.held), `the grey ash volume reads darker than the same volume held white: ${JSON.stringify(vol.means)}`);
  // KB-AIR-SKYLIGHT1: under the ash fall (under a tenth of the light gets through, hazeLight) the sky and the light it
  // gives the volume dim to the layer's glow: the far air in the volume and the sky above it read darker than in clear air.
  assert.equal(vol.skyLights.clear, null, 'no layer light is written into the sky without a load');
  assert.ok(vol.skyLights.ash && Math.min(...vol.skyLights.ash) > 0 && Math.max(...vol.skyLights.ash) < 0.1, `the ash fall lights the sky a dim glow, under a tenth of the zenith sun: ${JSON.stringify(vol.skyLights)}`);
  assert.ok(lum(vol.means.ash) < 0.8 * lum(vol.means.clear), `the far air in the ash-filled volume darkens: ${JSON.stringify(vol.means)}`);
  assert.ok(lum(vol.skies.ash) < 0.6 * lum(vol.skies.clear), `the sky over the ash fall darkens: ${JSON.stringify(vol.skies)}`);
  assert.ok(lum(vol.skies.smoke) < 0.6 * lum(vol.skies.clear), `the sky over the wildfire smoke darkens: ${JSON.stringify(vol.skies)}`);
  console.log(`ok weather sky under the load: sky rows clear ${vol.skies.clear}, ash ${vol.skies.ash}, smoke ${vol.skies.smoke}`);
  console.log(`ok weather fog volume: ash colour ${vol.colors.ash.map((v) => v.toFixed(3))}, smoke ${vol.colors.smoke.map((v) => v.toFixed(3))}; far rows clear ${vol.means.clear}, ash ${vol.means.ash}, ash held white ${vol.means.held}, smoke ${vol.means.smoke}`);
  assert.deepEqual(pageErrors, []);
  console.log(`ok weather settings: ${r.rows} live rows for 60 frames made no pipeline, buffer or texture (${JSON.stringify(r.after)}); sea ${r.sea.speed.toFixed(2)} m/s, rain rate ${r.rainRate}`);
} finally {
  await context.close();
}
