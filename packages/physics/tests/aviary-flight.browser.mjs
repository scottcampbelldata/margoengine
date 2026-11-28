import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { openBrowser } from '../../../scripts/browser.js';
import { decodePNG } from '../../../tests/support/png.js';

const { page, close, hardware } = await openBrowser({ startPath: '/tools/shot/blank.html', port: 'free' });
const backend = hardware.compat ? 'WebGL2' : 'WebGPU';
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));
const output =
  process.env.MARGO_KEEP_AVIARY_FLIGHT_FRAMES === '1' ? 'packages/physics/test-results/aviary-flight' : undefined;
if (output) await mkdir(output, { recursive: true });
const capture = async (id) =>
  decodePNG(
    await page.locator('canvas').screenshot(output ? { path: output + '/' + backend + '-' + id + '.png' } : {}),
  );

function paperProfile(image) {
  let left = image.width;
  const copper = [];
  for (let y = 0; y < image.height; y++)
    for (let x = 0; x < image.width; x++) {
      const i = 4 * (y * image.width + x);
      const [r, g, b] = image.data.subarray(i, i + 3);
      if (r > 1.42 * g && g > 1.24 * b && r > 88) {
        copper.push([x, y]);
        left = Math.min(left, x);
      }
    }
  assert(copper.length > 4500, 'Copper paper needs a readable silhouette, got ' + copper.length + ' pixels');
  // The neck and beak occupy the leftmost 30 pixels in this fixed framing on both takes.
  // Measuring the whole wing would move the pixel average down with the commanded downstroke.
  const head = copper.filter(([x]) => x < left + 30);
  assert(head.length > 100, 'The crane head must be legible in the profile');
  return { y: head.reduce((sum, point) => sum + point[1], 0) / head.length, count: copper.length };
}

try {
  const setup = await page.evaluate(async () => {
    const { setupAviaryFlight } = await import('/packages/physics/tests/fixtures/aviary-flight.js');
    window.aviary = await setupAviaryFlight();
    const { cue, lastTick, paperMass, gravity } = window.aviary;
    return { cue, lastTick, paperMass, gravity };
  });
  const render = (frame, beat, action) =>
    page.evaluate(([f, b, a]) => window.aviary.render(f, b, a), [frame, beat, action]);

  const opening = await render(0, false);
  const openingImage = await capture('opening');
  assert.deepEqual(await render(setup.cue - 1, false), opening);
  assert.deepEqual((await capture('opening-hold')).data, openingImage.data);
  const common = await render(setup.cue + 13, false);
  const commonImage = await capture('shared-glide');
  assert.deepEqual(await render(setup.cue + 13, true), common);
  assert.deepEqual((await capture('held-glide-input')).data, commonImage.data);

  const comparisonFrame = setup.cue + 23;
  const fixed = await render(comparisonFrame, false);
  const fixedImage = await capture('glide');
  const accelerating = await render(setup.cue + 20, true);
  const active = await render(comparisonFrame, true, 'save');
  const activeImage = await capture('downstroke');
  const fixedPaper = paperProfile(fixedImage);
  const activePaper = paperProfile(activeImage);
  assert(common.velocity[1] < -0.35, 'Both crane takes must arrive in a descending glide');
  assert(accelerating.force[1] > 1.8 * setup.paperMass * setup.gravity, 'The active downstroke must overcome gravity');
  assert(fixed.velocity[1] < -0.23 && active.velocity[1] > 0.44, 'The commanded beat must turn descent into climb');
  assert(active.position[1] - fixed.position[1] > 0.037, 'The registered pose must rise above the comparison');
  assert(
    Math.abs(active.position[2] - fixed.position[2]) < 0.024,
    'The paired comparison must be at nearly the same physical point along the corridor',
  );
  assert(active.stroke < 0 && fixed.stroke > 0, 'The two rendered wing rigs must show the accepted stroke angle');
  const impulseDelta = active.impulse[1] - fixed.impulse[1];
  const momentumDelta = setup.paperMass * (active.velocity[1] - fixed.velocity[1]);
  assert(
    Math.abs(momentumDelta - impulseDelta) < 3e-6,
    'The recorded lift impulse must account for the added upward momentum',
  );
  assert(fixed.screen[1] - active.screen[1] > 12, 'The observed climb must move the fixed-camera projection upwards');
  assert(fixedPaper.y - activePaper.y > 6, 'The neck and beak must corroborate the upward rigid motion');
  assert.notDeepEqual(activeImage.data, fixedImage.data);

  const ending = await render(setup.cue + setup.lastTick, true);
  const endingImage = await capture('ending');
  assert.deepEqual(await render(setup.cue + setup.lastTick + 8, true), ending);
  assert.deepEqual((await capture('ending-hold')).data, endingImage.data);
  assert.deepEqual(await render(comparisonFrame, true, 'restore'), active);
  assert.deepEqual((await capture('restored')).data, activeImage.data);
  assert.deepEqual(await render(setup.cue + 13, true), common);
  assert.deepEqual((await capture('rewound-glide')).data, commonImage.data);
  assert.deepEqual(await render(comparisonFrame, true), active);
  assert.deepEqual((await capture('replayed-downstroke')).data, activeImage.data);
  assert.deepEqual(await page.evaluate(() => window.aviary.dispose()), { validation: null, gpuErrors: [] });
  assert.deepEqual(errors, []);
  console.log(
    backend,
    'Paper Aviary wingbeat and held-wing comparison',
    JSON.stringify({
      glideVerticalMPerS: fixed.velocity[1],
      wingbeatVerticalMPerS: active.velocity[1],
      heightGainM: active.position[1] - fixed.position[1],
      impulseDeltaNs: impulseDelta,
      projectedRisePx: fixed.screen[1] - active.screen[1],
      headCentroidRisePx: fixedPaper.y - activePaper.y,
      minCopperPixels: Math.min(fixedPaper.count, activePaper.count),
      downstrokeState: active.state,
    }),
  );
} finally {
  await close();
}
