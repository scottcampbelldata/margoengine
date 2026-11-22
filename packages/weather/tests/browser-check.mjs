// Real-GPU proof (run from the repository root after building packages, one GPU job at a time):
//   node packages/weather/tests/browser-check.mjs [hail] [puddles] [snow] ...   (no name runs every check)
// hail: hail draws on a real GPU, moves with time, repeats exactly for the same time and seed, leaves no trace when
// off, lit stones turn their bright side to the sun, splash chips burst where stones land, and the WGSL surface
// functions match the JavaScript ones.
// puddles: the puddle WGSL matches its JavaScript twin, and on core meshes dry ground is untouched, wet ground darkens,
// water stands on the ground and not on walls, and rain rings it.
// snow: the snow WGSL matches its JavaScript twin; no cover changes nothing, full cover whitens the ground and not a
// wall, the snow lifts a surface by its depth on screen, a flat-shaded box's sides rise with its top (no gap seen side
// on), and it chains with puddles.
// audio: an OfflineAudioContext renders the rain, wind and thunder layers through @margoengine/audio.
// snow-drift: Snow draws a SnowDrift field: the field WGSL matches its JavaScript twins, an empty field changes nothing,
// the drifted ridge's skyline rises by the snow depth in the lee and not on the scoured crest, a later time re-uploads it,
// and the cornice mesh draws.
// eruption: drawPlume puts the rising column and the umbrella into vfx Clouds; a seek back and clearPlume restore the picture.
// lava: a LavaFlow's lavaEvent glows on a GroundChange and grows down the slope, clots and bombs draw as glowing
// instances, the glow lights brighten the ground through Clustered, and a seek back or clearing restores the picture.
// avalanche: Snow draws an Avalanche as its field (cover, scar, moving core), AvalancheScatter's plant maps match the
// avalanche to the byte, and the powder cloud draws as vfx Clouds puffs.
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
    assert.ok(
      r.splashLow > 0.8 * r.splashChanged,
      `chips stay near the ground: ${r.splashLow} of ${r.splashChanged} low`,
    );
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
    assert.ok(
      r.groundWhite > 0.95 * r.groundPixels,
      `full cover whitens the ground: ${r.groundWhite} of ${r.groundPixels}`,
    );
    assert.equal(r.wallChanged, 0, 'a wall stays bare');
    assert.ok(r.withPuddles > 0, 'puddles still act on the snow-hooked shader');
    assert.equal(r.afterDispose, 0, 'disposed hooks leave no trace');
    // The far edge is found to the pixel row, so it sits within a row (and a row for coverage) of where it projects.
    assert.ok(Math.abs(r.edgeBare - r.expectedBare) <= 1.5, `bare edge ${r.edgeBare} vs ${r.expectedBare}`);
    assert.ok(Math.abs(r.edgeDeep - r.expectedDeep) <= 1.5, `snowed edge ${r.edgeDeep} vs ${r.expectedDeep}`);
    assert.ok(r.edgeBare - r.edgeDeep >= 5, `the snow lifts the edge by ${r.edgeBare - r.edgeDeep} rows`);
    assert.ok(r.seamRows > 20, `rows checked down the box: ${r.seamRows}`);
    assert.equal(r.seamGap, 0, `background shows in ${r.seamGap} rows between the box's lifted top and its sides`);
    assert.ok(Math.abs(r.seamTop - r.expectedSeamTop) <= 1.5, `box top edge ${r.seamTop} vs ${r.expectedSeamTop}`);
    return `snow maths worst ${r.maths.worst}, ground white ${r.groundWhite}/${r.groundPixels}, edge ${r.edgeBare} -> ${r.edgeDeep} (expected ${r.expectedBare.toFixed(1)} -> ${r.expectedDeep.toFixed(1)})`;
  },
  'snow-drift'(r) {
    // Float32 against double through the same bilinear blend: about 1e-6 of depth on a metre of snow.
    for (const m of [r.maths0, r.maths]) {
      assert.ok(m.cases >= 2000 && m.worst < 1e-4, `WGSL field differs from JavaScript by ${m.worst}`);
      assert.ok(m.onField > 500 && m.off > 500, `cases on the field ${m.onField}, off it ${m.off}`);
    }
    assert.equal(r.emptyChanged, 0, 'an empty field changes no pixel');
    assert.equal(r.sameTwice, 0, 'the same frame twice is the same');
    for (const c of r.columns) {
      // The skyline is found to the pixel row, within a row and a row of coverage of where the camera puts it.
      assert.ok(Math.abs(c.before - c.expectedBefore) <= 1.5, `x ${c.x} bare ${c.before} vs ${c.expectedBefore}`);
      assert.ok(
        Math.abs(c.after - c.expectedAfter) <= 1.5,
        `x ${c.x} snowed ${c.after} vs ${c.expectedAfter} (depth ${c.depth})`,
      );
    }
    const crest = r.columns.find((c) => c.x === 40),
      lee = r.columns.reduce((a, c) => (c.depth > a.depth ? c : a));
    assert.ok(
      crest.depth < 0.05 && Math.abs(crest.after - crest.before) <= 1,
      `the scoured crest stays: ${crest.before} -> ${crest.after}`,
    );
    assert.ok(
      lee.x > 40 && lee.before - lee.after >= 4,
      `the lee drift lifts the skyline ${lee.before - lee.after} rows at x ${lee.x}`,
    );
    assert.ok(r.versionMoved && r.later > 50, `a later time draws new snow: ${r.later} pixels`);
    assert.ok(r.cornices > 0 && r.corniceChanged > 20, `cornices ${r.cornices}, ${r.corniceChanged} pixels`);
    return `snow-drift maths worst ${r.maths.worst}, lee lift ${lee.before - lee.after} rows (depth ${lee.depth.toFixed(2)} m), cornice ${r.corniceChanged} px`;
  },
  eruption(r) {
    assert.ok(
      r.rising > 1000 && r.columnChanged > 100,
      `the rising column draws: ${r.rising} m, ${r.columnChanged} pixels`,
    );
    assert.equal(r.sameTwice, 0, 'the same frame twice is the same');
    assert.ok(
      r.umbrella > 2000 && r.umbrellaChanged > 200,
      `the umbrella draws: ${r.umbrella} m, ${r.umbrellaChanged} pixels`,
    );
    assert.equal(r.seekBack, 0, 'a seek back draws the earlier column again');
    assert.equal(r.cleared, 0, 'clearPlume leaves the picture as it was');
    return `eruption column ${r.columnChanged} px, umbrella ${Math.round(r.umbrella)} m ${r.umbrellaChanged} px`;
  },
  lava(r) {
    assert.equal(r.validation, null);
    assert.deepEqual(r.errors, []);
    assert.ok(
      r.flowChanged > 200 && r.glowEarly > 100,
      `the flow draws and glows: ${r.flowChanged} px, ${r.glowEarly} glowing`,
    );
    assert.equal(r.sameTwice, 0, 'the same frame twice is the same');
    assert.ok(
      r.grew > 100 && r.glowLater > 50,
      `the flow grows down the slope: ${r.grew} px, ${r.glowLater} glowing, front ${r.front} m`,
    );
    assert.equal(r.seekBack, 0, 'a seek back draws the earlier lava again');
    assert.ok(
      r.clots > 100 && r.bombs > 20 && r.blobsChanged > 50 && r.glowBlobs > 20,
      `clots ${r.clots} and bombs ${r.bombs} draw: ${r.blobsChanged} px, ${r.glowBlobs} more glowing`,
    );
    assert.equal(r.blobsCleared, 0, 'no instances, no change');
    assert.equal(r.lightsError, undefined, `glow lights: ${r.lightsError}`);
    assert.ok(
      r.lights > 1 && r.litGain > 1 && r.lit20 > 200 && r.litChanged > 500 && r.brighter,
      `the glow lights the ground: ${r.lights} lights ${r.lightList}, x${r.litGain}, ${r.lit20} px a fifth brighter, ${r.litChanged} px`,
    );
    assert.equal(r.lightsCleared, 0, 'dispose clears the lights');
    assert.equal(r.cleared, 0, 'removing the ground change leaves the picture as it was');
    assert.ok(
      r.runOn[1] > 2 * r.runOn[0] && r.runOn[2] > 0,
      `a tube feeds the front on: ${r.runOn[1]} m against ${r.runOn[0]} m open`,
    );
    assert.ok(
      r.glowFed > 100 && r.glowOpen === 0 && r.runDiff > 100,
      `the run-on glows past the open stop: ${r.glowFed} px against ${r.glowOpen} px, ${r.runDiff} px differ`,
    );
    assert.ok(
      r.joins.includes('joined') && !r.apartStops.includes('joined'),
      `the island's arms meet with joins and not without: ${r.joins} / ${r.apartStops}`,
    );
    assert.ok(
      r.glowMerged > 500 && r.glowMerged > r.glowApart * 1.2 && r.joinDiff > 500,
      `the joined channel below the island glows wider than the arms apart: ${r.glowMerged} against ${r.glowApart}, ${r.joinDiff} px differ`,
    );
    assert.ok(
      r.breakout && r.glowBurst > 300 && r.glowBurst > 3 * r.glowStill && r.burstDiff > 300,
      `a breakout lobe glows beside the stalled flow: ${r.glowBurst} against ${r.glowStill} (${JSON.stringify(r.breakout)})`,
    );
    assert.ok(
      r.roofBurst &&
        r.roofBurst[1] < r.roofBurst[2] - 1 &&
        r.roofBurst[3] &&
        r.glowRoof > 300 &&
        r.glowRoof > 3 * r.glowShut &&
        r.roofDiff > 300,
      `a blocked tube bursts a roof behind the front and its lobe glows: ${r.glowRoof} against ${r.glowShut} (${JSON.stringify(r.roofBurst)})`,
    );
    assert.ok(
      !r.braids.includes('joined') &&
        r.bareStops.includes('joined') &&
        r.glowBraid > 300 &&
        r.glowBraid > 1.2 * r.glowBare &&
        r.braidDiff > 300,
      `braided arms glow as two channels side by side: ${r.glowBraid} against ${r.glowBare} joined (${r.braids} / ${r.bareStops})`,
    );
    return `lava flow ${r.flowChanged} px (${r.glowEarly} -> ${r.glowLater} glowing), clots ${r.clots} bombs ${r.bombs} ${r.blobsChanged} px, ${r.lights} lights brighten ${r.lit20} ground px by a fifth, run-on ${r.glowFed} px glowing (open ${r.glowOpen}), joined ${r.glowMerged} px (apart ${r.glowApart}), breakout ${r.glowBurst} px (stalled ${r.glowStill}), roof burst ${r.glowRoof} px (shut ${r.glowShut}), braided ${r.glowBraid} px (joined ${r.glowBare})`;
  },
  avalanche(r) {
    assert.ok(r.coverChanged > 500, `the cover whitens the gully: ${r.coverChanged} pixels`);
    assert.ok(r.released && r.flowChanged > 200, `the scar and the moving core: ${r.flowChanged} pixels`);
    assert.equal(r.sameTwice, 0, 'the same frame twice is the same');
    assert.ok(r.versionMoved && r.later > 50, `a later time draws the new flow: ${r.later} pixels`);
    assert.ok(r.heightWorst < 1e-3, `plant heightmap against the snow surface: ${r.heightWorst} m`);
    assert.ok(
      r.densityWorst < 1e-6 && r.broken > 20,
      `plant density against plantsKept: ${r.densityWorst}, ${r.broken} broken`,
    );
    assert.ok(
      r.parcels > 0 && r.cloudChanged > 100,
      `the powder cloud draws: ${r.parcels} parcels, ${r.cloudChanged} pixels`,
    );
    return `avalanche cover ${r.coverChanged} px, flow ${r.flowChanged} px, ${r.broken} broken, cloud ${r.parcels} parcels ${r.cloudChanged} px`;
  },
  drive(r) {
    assert.equal(r.clearSettings.coverage, 0.05);
    assert.equal(r.sheet, 0.9, "the sky's cloud sheet takes the overcast cover");
    assert.equal(r.overcastCoverage, 0.9, 'the cloud layer takes it');
    assert.ok(
      r.overcast.sky > 0.3 * r.overcast.third,
      `overcast covers the sky: ${r.overcast.sky} of ${r.overcast.third}`,
    );
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
