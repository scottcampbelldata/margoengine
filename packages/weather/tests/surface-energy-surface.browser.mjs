import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { openBrowser } from '../../../scripts/browser.js';
import { decodePNG } from '../../../tests/support/png.js';

const { page, close, hardware } = await openBrowser({ startPath: '/tools/shot/blank.html', port: 'free' });
const backend = hardware.compat ? 'WebGL2' : 'WebGPU';
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));
const output = process.env.MARGO_KEEP_WET_BASIN_FRAMES === '1' ? 'packages/weather/test-results/wet-basin' : undefined;
if (output) await mkdir(output, { recursive: true });

const at = (frame, displayRain = true, action) =>
  page.evaluate(([f, draw, step]) => window.wetBasin.at(f, draw, step), [frame, displayRain, action]);
const shot = async (frame, label, displayRain = true, action) => {
  const state = await at(frame, displayRain, action);
  const image = await decodePNG(
    await page
      .locator('canvas')
      .screenshot(output && label ? { path: output + '/' + backend + '-' + label + '.png' } : {}),
  );
  return { ...state, image };
};

function luminance(image, [x, y], radius = 6) {
  const samples = [];
  const cx = Math.round(x);
  const cy = Math.round(y);
  let total = 0;
  for (let j = cy - radius; j <= cy + radius; j++) {
    for (let i = cx - radius; i <= cx + radius; i++) {
      const p = 4 * (j * image.width + i);
      const r = image.data[p];
      const g = image.data[p + 1];
      const b = image.data[p + 2];
      total += 0.2126 * r + 0.7152 * g + 0.0722 * b;
      samples.push(r, g, b);
    }
  }
  return { mean: total / (2 * radius + 1) ** 2, samples };
}

function rainPixels(wet, bare) {
  let count = 0;
  let moment = 0;
  for (let p = 0; p < wet.data.length; p += 4) {
    if (wet.data[p + 2] - bare.data[p + 2] <= 12) continue;
    count++;
    moment += (p / 4) % wet.width;
  }
  return { count, center: count > 0 ? moment / count : 0 };
}

try {
  const setup = await page.evaluate(async () => {
    const { mountWetBasin } = await import('/packages/weather/tests/fixtures/wet-basin.js');
    window.wetBasin = await mountWetBasin();
    return window.wetBasin.setup;
  });
  const { start, last, probes, capacity } = setup;
  const dry = await shot(0, 'dry');
  assert.deepEqual(await shot(start - 1), dry);
  const westFrame = start + 190;
  const eastFrame = start + 430;
  const dryingFrame = start + 2400;
  const west = await shot(westFrame, 'storm-west', true, 'save');
  const westGround = await shot(westFrame, 'wet-west-ground', false);
  const east = await shot(eastFrame, 'storm-east');
  const eastGround = await shot(eastFrame, 'wet-east-ground', false);
  const drying = await shot(dryingFrame, 'drying');
  const next = await at(dryingFrame + 1);
  const settled = await shot(start + last, 'dry-again');
  assert.deepEqual(await shot(start + last + 12), settled);
  assert.deepEqual(await shot(westFrame, 'restored-storm', true, 'restore'), west);
  assert.deepEqual(await shot(eastFrame, 'replayed-storm'), east);
  assert.deepEqual(await shot(dryingFrame, 'replayed-drying'), drying);
  assert.deepEqual(await shot(start + last, 'replayed-dry'), settled);
  assert.deepEqual(await page.evaluate(() => window.wetBasin.dispose()), { validation: null, errors: [] });
  assert.deepEqual(errors, []);

  assert.equal(dry.rainCount, 0);
  assert.equal(dry.survey.west.wetness, 0);
  assert(west.survey.west.rain > 70 && west.survey.west.wetness > 0.8);
  assert.equal(west.survey.east.rain, 0);
  assert.equal(west.survey.east.wetness, 0);
  assert(east.survey.east.rain > 65 && east.survey.east.runoff > 0.01);
  assert.equal(east.survey.east.water, capacity);
  assert.equal(east.survey.east.wetness, 1);
  assert(west.rainDraws === 1 && east.rainDraws === 1);
  assert.equal(west.rainSegments, west.rainCount);
  assert.equal(east.rainSegments, east.rainCount);
  assert(east.rainCentroid - west.rainCentroid > 10);
  assert.equal(drying.rainCount, 0);
  assert(drying.survey.east.wetness > 0.1 && drying.survey.east.wetness < 0.45);
  assert.equal(drying.survey.east.rain, 0);
  const sample = next.survey.east;
  const dryLoss = drying.survey.east.water - sample.water;
  assert(sample.evaporation > 0 && sample.melt === 0 && sample.rain === 0 && sample.runoff === 0);
  assert(Math.abs(dryLoss - sample.evaporation / 60) < 1e-12);
  assert.equal(settled.survey.east.wetness, 0);
  assert.equal(settled.survey.west.wetness, 0);
  assert.equal(west.survey.dry.wetness + east.survey.dry.wetness + drying.survey.dry.wetness, 0);

  const [westProbe, eastProbe, control] = probes;
  const lightWest = luminance(dry.image, westProbe).mean;
  const lightEast = luminance(dry.image, eastProbe).mean;
  const darkWest = luminance(westGround.image, westProbe).mean;
  const darkEast = luminance(eastGround.image, eastProbe).mean;
  const restoredLight = luminance(drying.image, eastProbe).mean;
  assert(
    lightWest - darkWest > 7 && lightEast - darkEast > 7,
    JSON.stringify({ lightWest, darkWest, lightEast, darkEast }),
  );
  assert(restoredLight > darkEast + 3 && restoredLight < lightEast);
  // A tight foreground crop stays entirely inside the unrained row despite perspective foreshortening.
  assert.deepEqual(luminance(dry.image, control, 3).samples, luminance(eastGround.image, control, 3).samples);
  const seenWest = rainPixels(west.image, westGround.image);
  const seenEast = rainPixels(east.image, eastGround.image);
  assert(seenWest.count > 110 && seenEast.count > 110, JSON.stringify({ seenWest, seenEast }));
  assert(seenEast.center - seenWest.center > 110);
  console.log(
    `  ${backend} wet basin: storm moved ${(seenEast.center - seenWest.center).toFixed(1)} px, west/east darkened ${(lightWest - darkWest).toFixed(2)}/${(lightEast - darkEast).toFixed(2)} levels, east ${east.survey.east.wetness.toFixed(3)} to ${drying.survey.east.wetness.toFixed(3)} after evaporation, replay ${drying.hash}`,
  );
} finally {
  await close();
}
