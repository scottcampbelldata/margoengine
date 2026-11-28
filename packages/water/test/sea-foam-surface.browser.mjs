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
  process.env.MARGO_KEEP_SEA_FOAM_FRAMES === '1' ? 'packages/water/test-results/sea-foam-surface' : undefined;
if (output) await mkdir(output, { recursive: true });
const capture = async (id) =>
  decodePNG(
    await page.locator('canvas').screenshot(output ? { path: output + '/' + backend + '-' + id + '.png' } : {}),
  );

function foamPixels(foam, water) {
  let bright = 0;
  let sumX = 0;
  let sumY = 0;
  for (let i = 0; i < foam.width * foam.height; i++) {
    const at = 4 * i;
    const excess =
      foam.data[at] -
      water.data[at] +
      2 * (foam.data[at + 1] - water.data[at + 1]) +
      (foam.data[at + 2] - water.data[at + 2]);
    if (excess > 100) {
      bright++;
      sumX += i % foam.width;
      sumY += Math.floor(i / foam.width);
    }
  }
  return { bright, x: sumX / bright, y: sumY / bright };
}

try {
  const { cue, duration } = await page.evaluate(async () => {
    const { setupSeaFoam } = await import('/packages/water/test/sea-foam-surface.fixture.js');
    window.coastalFoam = await setupSeaFoam();
    const { cue, duration } = window.coastalFoam;
    return { cue, duration };
  });
  const show = (frame, mode = 'active', action) =>
    page.evaluate(([f, m, a]) => window.coastalFoam.at(f, m, a), [frame, mode, action]);

  const blank = await show(0);
  const blankImage = await capture('before');
  assert.equal(blank.area, 0);
  assert.deepEqual(await show(cue - 1), blank);
  assert.deepEqual((await capture('before-held')).data, blankImage.data);
  assert.deepEqual((await show(cue, 'clear')).waveProfile, blank.waveProfile);
  assert.deepEqual((await capture('before-clear')).data, blankImage.data);

  const crestFrame = cue + 12;
  const laterFrame = cue + 96;
  const crest = await show(crestFrame, 'active', 'save');
  const crestImage = await capture('first-crest');
  const firstControl = await show(crestFrame, 'clear');
  const clearCrestImage = await capture('first-crest-clear');
  const later = await show(laterFrame);
  const laterImage = await capture('trails');
  const finalControl = await show(laterFrame, 'clear');
  const clearLaterImage = await capture('trails-clear');

  assert.deepEqual(
    crest.waveProfile,
    firstControl.waveProfile,
    'The clear take must have the identical accepted wave profile',
  );
  assert.deepEqual(later.waveProfile, finalControl.waveProfile);
  assert.equal(firstControl.area + finalControl.area, 0);
  assert(crest.activeArea > 2 && crest.residualArea > 0.2, JSON.stringify(crest));
  assert(later.residualArea > 6 && later.cellsWithFoam > crest.cellsWithFoam + 10, JSON.stringify(later));
  assert(
    later.centroid - crest.centroid > 5,
    'Moving production and advection must carry the resolved footprint along the wind',
  );
  const first = foamPixels(crestImage, clearCrestImage);
  const trail = foamPixels(laterImage, clearLaterImage);
  assert(first.bright > 60 && trail.bright > first.bright + 80, JSON.stringify({ first, trail }));
  const pixelMovement = Math.hypot(trail.x - first.x, trail.y - first.y);
  assert(pixelMovement > 12, JSON.stringify({ first, trail }));

  const ended = await show(cue + duration);
  const endImage = await capture('end');
  assert.deepEqual(await show(cue + duration + 20), ended);
  assert.deepEqual((await capture('end-held')).data, endImage.data);
  assert.deepEqual(await show(crestFrame, 'active', 'restore'), crest);
  assert.deepEqual((await capture('restored')).data, crestImage.data);
  assert.deepEqual(await show(0), blank);
  assert.deepEqual((await capture('rewound')).data, blankImage.data);
  assert.deepEqual(await show(laterFrame), later);
  assert.deepEqual((await capture('replayed')).data, laterImage.data);
  await page.evaluate(() => window.coastalFoam.resize(true));
  const cropped = foamPixels(await capture('cropped'), clearLaterImage);
  assert(cropped.bright < trail.bright / 2, JSON.stringify({ cropped, trail }));
  await page.evaluate(() => window.coastalFoam.resize(false));
  assert.deepEqual((await capture('resized-back')).data, laterImage.data);
  await page.evaluate(() => window.coastalFoam.detach());
  assert.deepEqual((await capture('detached')).data, clearLaterImage.data);
  assert.deepEqual(await page.evaluate(() => window.coastalFoam.dispose()), { validation: null, errors: [] });
  assert.deepEqual(errors, []);
  console.log(
    backend,
    'Coastal whitecap footprint',
    JSON.stringify({
      earlyAreaM2: crest.area,
      lateAreaM2: later.area,
      lateResidualM2: later.residualArea,
      centroidTravelM: later.centroid - crest.centroid,
      firstPixels: first.bright,
      latePixels: trail.bright,
      centroidTravelPixels: pixelMovement,
      state: later.hash,
    }),
  );
} finally {
  await close();
}
