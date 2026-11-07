// Real-GPU proof (run from the repository root after building packages, one GPU job at a time):
//   node packages/weather/tests/browser-check.mjs [hail] [puddles] [snow] ...   (no name runs every check)
// hail: hail draws on a real GPU, moves with time, repeats exactly for the same time and seed, leaves no trace when
// off, lit stones turn their bright side to the sun, splash chips burst where stones land, and the WGSL surface
// functions match the JavaScript ones.
// puddles: the puddle WGSL matches its JavaScript twin, and on core meshes dry ground is untouched, wet ground darkens,
// water stands on the ground and not on walls, and rain rings it.
// snow: the snow WGSL matches its JavaScript twin; no cover changes nothing, full cover whitens the ground and not a
// wall, the snow lifts a surface by its depth on screen, and it chains with puddles.
// audio: an OfflineAudioContext renders the rain, wind and thunder layers through @margoengine/audio.
// drive: WeatherDrive puts a machine's cloud and fog into the real Sky, VolumetricClouds and environment Fog.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { openBrowser } from '../../../scripts/browser.js';

const checks = {
  hail(r) {
    assert.ok(r.hailChanged > 150, `hail changed ${r.hailChanged} of ${r.pixels} pixels`);
    assert.equal(r.sameTime, 0, 'a frame with no time passing repeats exactly');
    assert.ok(r.movesWithTime > 150, `stones moved: ${r.movesWithTime} pixels differ after 0.35 s`);
    assert.ok(r.seedChanges > 150, `another seed draws other stones: ${r.seedChanges}`);
    assert.ok(r.lowCeiling > 0, 'a low ceiling still draws stones');
    assert.equal(r.zero, 0, 'intensity 0 draws nothing');
    assert.equal(r.afterDispose, 0, 'a disposed Hail leaves no trace');
    assert.ok(
      r.surface.cases >= 200 && r.surface.worst < 2e-5,
      `WGSL surface functions differ from JavaScript by ${r.surface.worst}`,
    );
    // A ball lit from the camera's side shows its lit half; from behind, only the ambient light and a thin rim.
    assert.ok(r.litFront > 1.5 * r.litBack, `lit stones: ${r.litFront} toward the sun against ${r.litBack} away`);
    // Flat stones ignore the sun; the scene behind them changes a little with it, so their light moves only by that.
    assert.ok(Math.abs(r.flatFront / r.flatBack - 1) < 0.15, `flat stones: ${r.flatFront} and ${r.flatBack}`);
    assert.ok(r.splashChanged > 30, `splash chips: ${r.splashChanged} pixels`);
    assert.ok(r.splashLow > 0.8 * r.splashChanged, `chips stay near the ground: ${r.splashLow} of ${r.splashChanged} low`);
    return `hail lit ${(r.litFront / r.litBack).toFixed(2)}x, flat ${(r.flatFront / r.flatBack).toFixed(3)}, chips ${r.splashChanged}; ${r.hailChanged} pixels, moves ${r.movesWithTime}, surface worst ${r.surface.worst}`;
  },
  puddles(r) {
    // Float32 against double: the relief and level carry about 1e-7 of error, which the 0.02-wide shore turns into at
    // most 1e-5 of mask; colour and roughness are products of it with values under 1.
    assert.ok(r.maths.cases >= 2000 && r.maths.worst < 1e-4, `WGSL puddles differ from JavaScript by ${r.maths.worst}`);
    assert.ok(r.maths.water > 200 && r.maths.dry > 200, `cases under water ${r.maths.water}, dry ${r.maths.dry}`);
    assert.equal(r.dryChanged, 0, 'wetness 0 changes no pixel');
    assert.ok(r.wetGround > 0.9 * r.groundPixels, `wetness darkens ground: ${r.wetGround} of ${r.groundPixels}`);
    // Soaked diffuse keeps 0.75 of its light (wetColor); the smoother specular moves the total by a few hundredths.
    assert.ok(r.wetRatio < 0.8 && r.wetRatio > 0.68, `wet ground keeps ${r.wetRatio} of its light`);
    assert.ok(
      r.waterGround > 0.05 * r.groundPixels && r.waterGround < 0.7 * r.groundPixels,
      `water changes ${r.waterGround} of ${r.groundPixels} ground pixels`,
    );
    assert.equal(r.waterWall, 0, 'standing water changes no wall pixel');
    assert.ok(r.ringsMove > 20, `rain rings move the water: ${r.ringsMove} pixels`);
    assert.equal(r.ringsOutside, 0, 'rings touch nothing out of the water');
    assert.equal(r.calmStill, 0, 'without rain the water is still');
    assert.equal(r.afterDispose, 0, 'a disposed Puddles leaves no trace');
    return `puddles maths worst ${r.maths.worst}, water ${r.waterGround}/${r.groundPixels}, rings ${r.ringsMove}`;
  },
  snow(r) {
    // Float32 against double through the same smoothsteps and noise: about 1e-6 of weight and depth.
    assert.ok(r.maths.cases >= 2000 && r.maths.worst < 1e-4, `WGSL snow differs from JavaScript by ${r.maths.worst}`);
    assert.ok(r.maths.partial > 100, `cases on the snow line: ${r.maths.partial}`);
    assert.equal(r.noneChanged, 0, 'cover 0 changes no pixel');
    assert.ok(r.groundWhite > 0.95 * r.groundPixels, `full cover whitens the ground: ${r.groundWhite} of ${r.groundPixels}`);
    assert.equal(r.wallChanged, 0, 'a wall stays bare');
    assert.ok(r.withPuddles > 0, 'puddles still act on the snow-hooked shader');
    assert.equal(r.afterDispose, 0, 'disposed hooks leave no trace');
    // The far edge is found to the pixel row, so it sits within a row (and a row for coverage) of where it projects.
    assert.ok(Math.abs(r.edgeBare - r.expectedBare) <= 1.5, `bare edge ${r.edgeBare} vs ${r.expectedBare}`);
    assert.ok(Math.abs(r.edgeDeep - r.expectedDeep) <= 1.5, `snowed edge ${r.edgeDeep} vs ${r.expectedDeep}`);
    assert.ok(r.edgeBare - r.edgeDeep >= 5, `the snow lifts the edge by ${r.edgeBare - r.edgeDeep} rows`);
    return `snow maths worst ${r.maths.worst}, ground white ${r.groundWhite}/${r.groundPixels}, edge ${r.edgeBare} -> ${r.edgeDeep} (expected ${r.expectedBare.toFixed(1)} -> ${r.expectedDeep.toFixed(1)})`;
  },
  drive(r) {
    assert.equal(r.clearSettings.coverage, 0.05);
    assert.equal(r.sheet, 0.9, "the sky's cloud sheet takes the overcast cover");
    assert.equal(r.overcastCoverage, 0.9, 'the cloud layer takes it');
    assert.ok(r.overcast.sky > 0.3 * r.overcast.third, `overcast covers the sky: ${r.overcast.sky} of ${r.overcast.third}`);
    assert.equal(r.back.sky + r.back.ground, 0, 'back to clear draws the clear frame again');
    assert.ok(r.fogDensity > 10 * r.clearFog, `fog density ${r.fogDensity} against ${r.clearFog}`);
    assert.ok(r.fog.ground > 0.5 * r.fog.third, `fog over the ground: ${r.fog.ground} of ${r.fog.third}`);
    return `drive overcast ${r.overcast.sky}/${r.overcast.third} sky pixels, fog ${r.fog.ground}/${r.fog.third} ground pixels`;
  },
  audio(r) {
    assert.ok(r.finite, 'every rendered sample is a finite number');
    assert.ok(r.calm < 0.002, `calm air is near silent: ${r.calm}`);
    assert.ok(r.rain > 20 * r.calm && r.rain > 0.02, `rain is heard: ${r.rain}`);
    assert.ok(r.gale > 4 * r.breeze, `a gale is louder than a breeze: ${r.gale} against ${r.breeze}`);
    // Low-passed at 2.5 kHz, rain keeps less of its power in fast changes than with hail's 6.9 kHz cutoff; band-passed
    // wind near 1 kHz keeps least.
    assert.ok(r.hailBright > 1.3 * r.rainBright, `hail brightens the rain: ${r.hailBright} against ${r.rainBright}`);
    assert.ok(r.windBright < r.rainBright, `wind is darker than rain: ${r.windBright} against ${r.rainBright}`);
    assert.ok(r.thunderEarly > 4 * r.thunderLate, `the rumble dies away: ${r.thunderEarly} then ${r.thunderLate}`);
    assert.ok(r.thunderAfter < 0.01 * r.thunderEarly, `and ends: ${r.thunderAfter}`);
    return `audio rain ${r.rain.toFixed(4)}, gale ${r.gale.toFixed(4)} / breeze ${r.breeze.toFixed(4)}, thunder ${r.thunderEarly.toFixed(4)} -> ${r.thunderLate.toFixed(4)}`;
  },
};
const wanted = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(checks);
for (const name of wanted) assert.ok(checks[name], `unknown check ${name}; use ${Object.keys(checks).join(', ')}`);

const path = (name) => `/packages/weather/tests/${name === 'hail' ? 'browser-check' : `${name}-check`}.html`;
const context = await openBrowser({ startPath: path(wanted[0]), port: 5262 }),
  { page, hardware } = context,
  results = {},
  pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(e.message));
page.on('console', (m) => {
  if (m.type() === 'error') pageErrors.push(m.text());
});
try {
  console.log('adapter', JSON.stringify(hardware.webgpu));
  for (const run of wanted.flatMap((name) =>
    name === 'hail' || name === 'audio'
      ? [[name, '']]
      : [
          [name, '?samples=4'],
          [name, '?samples=1'],
        ],
  )) {
    const [name, query] = run;
    await page.goto(`http://127.0.0.1:5262${path(name)}${query}`);
    await page.waitForFunction(() => window.ready, null, { timeout: 60000 });
    const r = await page.evaluate(() => window.check.run());
    assert.equal(r.validation, null);
    assert.deepEqual(r.errors, []);
    assert.deepEqual(pageErrors, []);
    if (query) assert.equal(await page.evaluate(() => window.check.samples()), Number(query.at(-1)));
    results[name + query] = r;
    console.log('ok weather', query, checks[name](r));
  }
  await mkdir('test-results', { recursive: true });
  await writeFile('test-results/weather-browser-check.json', JSON.stringify({ hardware, results }, null, 1));
} finally {
  await context.close();
}
