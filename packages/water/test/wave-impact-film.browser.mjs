import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { openBrowser } from '../../../scripts/browser.js';
import { decodePNG } from '../../../tests/support/png.js';

process.chdir(fileURLToPath(new URL('../../../', import.meta.url)));
const { page, close, hardware } = await openBrowser({ startPath: '/tools/shot/blank.html', port: 'free' });
const backend = hardware.compat ? 'WebGL2' : 'WebGPU';
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));
const output =
  process.env.MARGO_KEEP_WAVE_IMPACT_FRAMES === '1' ? 'packages/water/test-results/wave-impact-film' : undefined;
if (output) await mkdir(output, { recursive: true });
const capture = async (id) =>
  decodePNG(
    await page.locator('canvas').screenshot(output ? { path: output + '/' + backend + '-' + id + '.png' } : {}),
  );

function paintDifference(wet, control, around = [wet.width / 2, wet.height / 2], extent = [220, 135]) {
  let changed = 0;
  let inside = 0;
  for (let i = 0; i < wet.width * wet.height; i++) {
    const at = 4 * i;
    const difference =
      Math.abs(wet.data[at] - control.data[at]) +
      Math.abs(wet.data[at + 1] - control.data[at + 1]) +
      Math.abs(wet.data[at + 2] - control.data[at + 2]);
    if (difference < 17) continue;
    changed++;
    const x = i % wet.width;
    const y = Math.floor(i / wet.width);
    if (Math.abs(x - around[0]) <= extent[0] && Math.abs(y - around[1]) <= extent[1]) inside++;
  }
  return { changed, inside };
}

// Ports used as per-step receipts deliberately live outside snapshots. Compare them after the
// same step has run again. Frames at a direct restore read the complete accepted persistent state.
function persistent({ force, inflow, bowInflow, ...state }) {
  return state;
}

try {
  const config = await page.evaluate(async () => {
    const { setupWaveImpactFilm } = await import('/packages/water/test/wave-impact-film.fixture.js');
    window.waveImpactFilm = await setupWaveImpactFilm();
    const { cue, duration, waveHeight, wavePeriod, mass } = window.waveImpactFilm;
    return { cue, duration, waveHeight, wavePeriod, mass };
  });
  const { cue, duration, waveHeight, wavePeriod, mass } = config;
  const show = (frame, mode = 'active', action) =>
    page.evaluate(([f, m, a]) => window.waveImpactFilm.at(f, m, a), [frame, mode, action]);
  const control = (frame) => page.evaluate((f) => window.waveImpactFilm.control(f), frame);
  assert(mass > 3500 && mass < 3800, 'The open workboat has a physical displacement of roughly 3.64 tonnes');

  const before = await show(0);
  const beforeImage = await capture('before');
  assert.deepEqual(await show(cue - 1), before);
  assert.deepEqual((await capture('before-held')).data, beforeImage.data);
  assert.equal(before.wet, 0);
  const descending = await show(cue + 15, 'active', 'save');
  const descendingImage = await capture('pre-slam');
  assert.deepEqual(descending.position, (await control(15)).position);
  assert.deepEqual(descending.force, (await control(15)).force);
  const firstSlam = await show(cue + 16);
  const initialImpulse = firstSlam.force[1] - (await control(16)).force[1];
  assert(initialImpulse > 600, 'Upward slamming must change the accepted signed force at first contact');
  assert.equal(firstSlam.inflow + firstSlam.volume, 0, 'The first impulse precedes green water on deck');

  const impactFrame = cue + 32;
  const slam = await show(impactFrame);
  const slamImage = await capture('slam');
  const slamControl = await control(32);
  const expectedForce = slam.force[1] - slamControl.force[1];
  assert(expectedForce > 42000 && slam.velocity[1] > slamControl.velocity[1] + 0.65);
  assert(slam.position[1] > slamControl.position[1] + 0.025);
  assert(slam.force[5] > 8000, 'The forebody produces a signed pitching moment about its supported centre');
  const controlSurface = await show(impactFrame, 'feature-off');
  const slamControlImage = await capture('slam-control');
  assert.deepEqual(slam.surface, controlSurface.surface);
  const slamPixels = paintDifference(slamImage, slamControlImage);
  assert(slamPixels.inside > 1500, JSON.stringify(slamPixels));

  const entryFrame = cue + 130;
  const crossFrame = cue + 285;
  const early = await show(entryFrame);
  const earlyImage = await capture('edge-wetting');
  const flooded = await show(cue + 180);
  await capture('bow-flooded');
  assert(flooded.peak > 0.1 && flooded.inflow > 0.015);
  const wet = await show(crossFrame);
  const wetImage = await capture('across-deck');
  assert(early.bowInflow > 0.05 && early.bowInflow < early.inflow);
  assert(wet.volume > early.volume * 8 && wet.peak > 0.075 && wet.wet > early.wet * 4);
  assert(early.centroid - wet.centroid > 0.48, 'The volume-weighted sheet must spread inland along the resolved deck');
  assert(early.faces > 10 && wet.faces > early.faces * 3, 'The actual mesh covers the still-wet resolved deck');
  const dry = await show(crossFrame, 'no-sheet');
  const dryImage = await capture('deck-control');
  assert.equal(dry.hash, wet.hash);
  assert.deepEqual(dry.surface, wet.surface);
  assert.deepEqual(dry.position, wet.position);
  assert.equal(dry.faces, 0);
  const deckPixels = paintDifference(wetImage, dryImage, wet.onScreen, [170, 105]);
  assert(deckPixels.inside > 300 && deckPixels.inside > 0.75 * deckPixels.changed, JSON.stringify(deckPixels));
  assert.notDeepEqual(earlyImage.data, wetImage.data);

  const finish = await show(cue + duration);
  assert.equal(wet.inflow + finish.inflow, 0);
  assert(wet.volume - finish.volume > 0.013, 'Residual green water must drain after the ambient crest recedes.');
  const finishImage = await capture('end');
  assert.deepEqual(await show(cue + duration + 12), finish);
  assert.deepEqual((await capture('end-held')).data, finishImage.data);
  assert.deepEqual(persistent(await show(cue + 15, 'active', 'restore')), persistent(descending));
  assert.deepEqual((await capture('restored')).data, descendingImage.data);
  assert.deepEqual(await show(impactFrame), slam);
  assert.deepEqual((await capture('replayed-slam')).data, slamImage.data);
  assert.deepEqual(await show(crossFrame), wet);
  assert.deepEqual((await capture('replayed-deck')).data, wetImage.data);
  assert.deepEqual(persistent(await show(0)), persistent(before));
  assert.deepEqual((await capture('rewound')).data, beforeImage.data);
  assert.deepEqual(await page.evaluate(() => window.waveImpactFilm.dispose()), { validation: null, problems: [] });
  assert.deepEqual(errors, []);

  console.log(
    backend,
    'Workboat slam and green water',
    JSON.stringify({
      waveHeightM: waveHeight,
      wavePeriodS: wavePeriod,
      displacementKg: mass,
      upwardFirstN: initialImpulse,
      impactLoadDeltaN: expectedForce,
      impactVelocityDeltaMPerS: slam.velocity[1] - slamControl.velocity[1],
      impactPixels: slamPixels.inside,
      initialBowInflowM3PerS: early.bowInflow,
      sheetVolumeM3: [early.volume, wet.volume],
      inwardCentroidM: early.centroid - wet.centroid,
      peakDeckDepthM: wet.peak,
      wetCells: [early.wet, wet.wet],
      deckPixels: deckPixels.inside,
      state: wet.hash,
    }),
  );
} finally {
  await close();
}
