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
  process.env.MARGO_KEEP_BREACH_ORE_FRAMES === '1' ? 'packages/environment/test-results/breach-ore' : undefined;
if (output) await mkdir(output, { recursive: true });
const capture = async (id) =>
  decodePNG(
    await page.locator('canvas').screenshot(output ? { path: output + '/' + backend + '-' + id + '.png' } : {}),
  );

function difference(image, control) {
  let pixels = 0;
  let sumX = 0;
  let sumY = 0;
  for (let y = 69; y < image.height - 35; y++)
    for (let x = 11; x < image.width - 11; x++) {
      const k = 4 * (y * image.width + x);
      const colourDelta =
        Math.abs(image.data[k] - control.data[k]) +
        Math.abs(image.data[k + 1] - control.data[k + 1]) +
        Math.abs(image.data[k + 2] - control.data[k + 2]);
      if (colourDelta < 22) continue;
      pixels++;
      sumX += x;
      sumY += y;
    }
  return { pixels, x: sumX / pixels, y: sumY / pixels };
}

function massLedger(read, config) {
  assert(Math.abs(config.openedMass - read.retained - read.lost) < 1e-7, JSON.stringify(read));
  const [fine, pellet] = read.regions;
  const fractions = [config.fineShare, 1 - config.fineShare];
  for (const [i, lane] of read.regions.entries()) {
    const remainder = read.lost * fractions[i] - lane.mass;
    assert(remainder >= -1e-8 && remainder < config.parcelMass + 1e-8);
  }
  assert(Math.abs(fine.mass + pellet.mass - read.budget.released) < 1e-8);
  assert(Math.abs(read.budget.released - read.budget.water - read.budget.bed) < 1e-8);
  assert.equal(read.budget.surface, 0);
  if (read.opt.mass > 0) {
    const want = config.fineColour.map(
      (component, i) => (fine.water * component + pellet.water * config.pelletColour[i]) / (fine.water + pellet.water),
    );
    assert(
      read.opt.colour.every((value, i) => Math.abs(value - want[i]) < 2e-6),
      JSON.stringify({ want, got: read.opt }),
    );
  }
}

try {
  const config = await page.evaluate(async () => {
    const { setupBreachOre } = await import('/packages/environment/tests/breach-ore.fixture.js');
    const scene = await setupBreachOre();
    window.breachOre = scene;
    const { cue, lasts, opens, closes, rate, fineShare, parcelMass, floor, openedMass, fineColour, pelletColour } =
      scene;
    return { cue, lasts, opens, closes, rate, fineShare, parcelMass, floor, openedMass, fineColour, pelletColour };
  });
  const { cue, lasts, opens, closes, floor } = config;
  const show = (frame, mode = 'active', action, visibility) =>
    page.evaluate(([f, m, a, v]) => window.breachOre.render(f, m, a, v), [frame, mode, action, visibility]);
  const ports = () => page.evaluate(() => window.breachOre.source());

  const start = await show(0);
  const startImage = await capture('before-release');
  assert.deepEqual(await show(cue - 1), start);
  assert.deepEqual((await capture('before-held')).data, startImage.data);
  assert.equal(start.budget.released, 0);
  assert.equal(start.ot, true);

  const emittingFrame = cue + 30;
  const active = await show(emittingFrame, 'active', 'save');
  const activeImage = await capture('breach-opening');
  assert(active.time > opens && active.time < closes && !active.ot);
  const live = await ports();
  assert(live[8] > 0.28 && live[12] > 300 && live[14] > 0);
  assert(active.budget.water > 70 && active.budget.bed === 0 && active.regions.every((lane) => lane.mass > 10));
  massLedger(active, config);

  const separation = await show(cue + 132);
  const separationImage = await capture('separating');
  assert(separation.time > closes && separation.ot);
  assert.deepEqual((await ports()).slice(8, 13), [0, 0, 0, 0, 0]);
  assert(separation.centroid[1][1] < separation.centroid[0][1] - 0.8);
  massLedger(separation, config);
  assert.notDeepEqual(separationImage.data, activeImage.data);

  const bedFrame = cue + 252;
  const settled = await show(bedFrame);
  const settledImage = await capture('on-bed');
  assert.equal(settled.regions[0].bed, 0);
  assert.equal(settled.regions[1].water, 0);
  assert(settled.regions[1].bed > 89 && settled.regions[0].water > 20);
  assert(Math.abs(settled.centroid[1][1] - floor) < 1e-10);
  assert(settled.centroid[0][0] > active.centroid[0][0] + 1.9);
  assert(Math.abs(settled.visual.opticalMass - settled.regions[0].water) < 1e-8);
  assert.equal(settled.visual.shown, settled.regions[1].count);
  massLedger(settled, config);
  const noFines = await show(bedFrame, 'active', undefined, 'no-fines');
  const noFinesImage = await capture('on-bed-no-fines');
  const noPellets = await show(bedFrame, 'active', undefined, 'no-pellets');
  const noPelletsImage = await capture('on-bed-no-pellets');
  assert.equal(settled.hash, noFines.hash);
  assert.equal(settled.hash, noPellets.hash);
  const plume = difference(settledImage, noFinesImage);
  const deposit = difference(settledImage, noPelletsImage);
  assert(plume.pixels > 400 && deposit.pixels > 200 && deposit.y - plume.y > 31, JSON.stringify({ plume, deposit }));

  const sealed = await show(bedFrame, 'sealed');
  const sealedImage = await capture('sealed-control');
  assert.equal(sealed.budget.released + sealed.lost, 0);
  assert.equal(sealed.retained, config.openedMass);
  assert.notDeepEqual(settledImage.data, sealedImage.data);
  const ending = await show(cue + lasts);
  const endingImage = await capture('ending');
  massLedger(ending, config);
  assert.equal(ending.budget.released, settled.budget.released);
  assert.equal(ending.budget.bed, settled.budget.bed);
  assert.deepEqual(await show(cue + lasts + 12), ending);
  assert.deepEqual((await capture('held-ending')).data, endingImage.data);
  assert.deepEqual(await show(emittingFrame, 'active', 'restore'), active);
  assert.deepEqual((await capture('restored')).data, activeImage.data);
  assert.deepEqual(await show(bedFrame), settled);
  assert.deepEqual((await capture('replayed-bed')).data, settledImage.data);
  assert.deepEqual(await show(0), start);
  assert.deepEqual((await capture('rewound')).data, startImage.data);
  assert.deepEqual(await show(cue + lasts), ending);
  assert.deepEqual((await capture('rewound-ending')).data, endingImage.data);
  assert.deepEqual(await page.evaluate(() => window.breachOre.dispose()), { validation: null, errors: [] });
  assert.deepEqual(errors, []);
  console.log(
    backend,
    'Taconite from live hold breach',
    JSON.stringify({
      lostKg: settled.lost,
      fineSuspendedKg: settled.regions[0].water,
      pelletsOnBedKg: settled.regions[1].bed,
      fineDownstreamM: settled.centroid[0][0] - active.centroid[0][0],
      colourInWater: settled.opt.colour,
      plumePixels: plume.pixels,
      depositPixels: deposit.pixels,
      depositBelowPlumePixels: deposit.y - plume.y,
      state: ending.hash,
    }),
  );
} finally {
  await close();
}
