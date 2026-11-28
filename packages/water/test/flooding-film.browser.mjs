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
  process.env.MARGO_KEEP_FLOODING_FILM_FRAMES === '1' ? 'packages/water/test-results/flooding-film' : undefined;
if (output) await mkdir(output, { recursive: true });
const capture = async (id) =>
  decodePNG(
    await page.locator('canvas').screenshot(output ? { path: output + '/' + backend + '-' + id + '.png' } : {}),
  );
const total = (reading) => reading.volumes[0] + reading.volumes[1];
const tiltedRail = (reading) => reading.marks[2][1] - reading.marks[3][1];

function screenChange(a, b) {
  let sections = 0;
  let hull = 0;
  for (let y = 74; y < 417; y++)
    for (let x = 110; x < 671; x++) {
      const i = 4 * (y * a.width + x);
      const change =
        Math.abs(a.data[i] - b.data[i]) +
        Math.abs(a.data[i + 1] - b.data[i + 1]) +
        Math.abs(a.data[i + 2] - b.data[i + 2]);
      if (change <= 30) continue;
      if (y < 206) sections++;
      if (y > 213 && y < 385) hull++;
    }
  return { sections, hull };
}

function checkMeasure(reading) {
  assert(Math.abs(total(reading) - reading.ledger.water) < 2e-9, JSON.stringify(reading));
  for (let i = 0; i < reading.volumes.length; i++) {
    assert(Math.abs(reading.clipped[i].volume - reading.volumes[i]) < 1e-10 * Math.max(1, reading.volumes[i]));
    assert(reading.clipped[i].flatness < 2e-6, 'The plane remains horizontal as the vessel lists');
  }
}

try {
  const config = await page.evaluate(async () => {
    const { setupFloodingFilm } = await import('/packages/water/test/flooding-film.fixture.js');
    window.floodingFilm = await setupFloodingFilm();
    const { cue, duration, rate, closeAt, controlClose, breachOpens, mass } = window.floodingFilm;
    return { cue, duration, rate, closeAt, controlClose, breachOpens, mass };
  });
  const { cue, duration, rate, closeAt, controlClose, breachOpens, mass } = config;
  const show = (frame, mode = 'active', action) =>
    page.evaluate(([f, m, a]) => window.floodingFilm.at(f, m, a), [frame, mode, action]);
  const ports = () => page.evaluate(() => window.floodingFilm.ports());
  assert.equal(mass, 24624, 'Use the geometrical freshwater displacement at 0.76 m draft');

  const initial = await show(0);
  const initialImage = await capture('before');
  assert.deepEqual(await show(cue - 1), initial);
  assert.deepEqual((await capture('before-held')).data, initialImage.data);
  assert.equal(total(initial) + initial.foamArea, 0);
  const sameFrame = cue + 30;
  const common = await show(sameFrame);
  const commonImage = await capture('common-opening');
  const open = await ports();
  assert(common.time > breachOpens && common.time < controlClose);
  assert(open[0][8] > 0.4 && open[0][9] < -0.5);
  assert(open[1][14] > 0 && open[1][10] > 0 && common.ledger.vented > 0.02);
  assert(common.foamArea > 1, 'Breach air must feed the accepted SEA-13 foam field');
  assert.deepEqual(await show(sameFrame, 'isolated'), common);
  assert.deepEqual((await capture('common-control')).data, commonImage.data);

  const firstFloodFrame = cue + 185;
  const inclinedFrame = cue + 300;
  const flooded = await show(firstFloodFrame, 'active', 'save');
  const floodedImage = await capture('before-cross-flow');
  assert(flooded.volumes[0] > 1.55 && flooded.volumes[1] === 0);
  checkMeasure(flooded);
  const inclined = await show(inclinedFrame);
  const inclinedImage = await capture('flooded');
  assert(inclined.volumes[0] > 2 && inclined.volumes[1] > 0.04, JSON.stringify(inclined.volumes));
  checkMeasure(inclined);
  const afterSealFrame = cue + 329;
  const closed = await show(afterSealFrame);
  const seal = await ports();
  assert(closed.time > closeAt && closeAt * rate < afterSealFrame - cue);
  assert.deepEqual(
    seal.slice(0, 2).map((row) => row.slice(8, 12)),
    [
      [0, 0, 0, 0],
      [0, 0, 0, 0],
    ],
  );
  checkMeasure(closed);
  const ending = await show(cue + duration);
  const endingImage = await capture('transferred');
  checkMeasure(ending);
  assert(Math.abs(total(ending) - total(closed)) < 2e-9);
  assert(ending.volumes[1] > closed.volumes[1] + 0.04 && ending.volumes[0] < closed.volumes[0] - 0.04);
  assert.deepEqual(await show(cue + duration + 12), ending);
  assert.deepEqual((await capture('end-held')).data, endingImage.data);

  const early = await show(inclinedFrame, 'isolated');
  const earlyImage = await capture('early-isolation');
  checkMeasure(early);
  assert(total(early) < 0.28 && total(inclined) > 2.4);
  assert(inclined.position[1] < early.position[1] - 0.06);
  assert(inclined.roll < early.roll - 4.5 && inclined.pitch < early.pitch - 1.1);
  const rollPixels = Math.abs(tiltedRail(inclined) - tiltedRail(early));
  const image = screenChange(inclinedImage, earlyImage);
  assert(rollPixels > 7 && image.sections > 375 && image.hull > 1000, JSON.stringify({ rollPixels, image }));

  assert.deepEqual(await show(firstFloodFrame, 'active', 'restore'), flooded);
  assert.deepEqual((await capture('restored')).data, floodedImage.data);
  assert.deepEqual(await show(inclinedFrame), inclined);
  assert.deepEqual((await capture('replayed-flooded')).data, inclinedImage.data);
  assert.deepEqual(await show(0), initial);
  assert.deepEqual((await capture('rewound')).data, initialImage.data);
  assert.deepEqual(await show(cue + duration), ending);
  assert.deepEqual((await capture('rewound-transferred')).data, endingImage.data);
  assert.deepEqual(await page.evaluate(() => window.floodingFilm.dispose()), { validation: null, faults: [] });
  assert.deepEqual(errors, []);
  console.log(
    backend,
    'Barge flooding and isolation',
    JSON.stringify({
      lateWaterM3: total(inclined),
      isolatedWaterM3: total(early),
      closedTotalM3: total(closed),
      crossFlowM3: ending.volumes[1] - closed.volumes[1],
      listDeg: inclined.roll,
      trimDeg: inclined.pitch,
      sinkageDifferenceM: early.position[1] - inclined.position[1],
      ventedAirKg: inclined.ledger.vented,
      acceptedFoamM2: inclined.foamArea,
      projectedListPixels: rollPixels,
      cutawayPixels: image.sections,
      hullPixels: image.hull,
      state: ending.hash,
    }),
  );
} finally {
  await close();
}
