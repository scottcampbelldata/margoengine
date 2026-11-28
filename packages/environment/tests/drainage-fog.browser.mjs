import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { openBrowser } from '../../../scripts/browser.js';
import { decodePNG } from '../../../tests/support/png.js';

const { page, hardware, close } = await openBrowser({
  startPath: '/packages/environment/tests/drainage-fog.html',
  port: 'free',
});
const uncaught = [];
const backend = hardware.compat ? 'WebGL2' : 'WebGPU';
page.on('pageerror', (error) => uncaught.push(error.message));
const output =
  process.env.MARGO_KEEP_DRAINAGE_FOG_FRAMES === '1' ? 'packages/environment/test-results/drainage-fog' : undefined;
if (output) await mkdir(output, { recursive: true });
const capture = async (name) =>
  decodePNG(
    await page.locator('canvas').screenshot(output ? { path: output + '/' + backend + '-' + name + '.png' } : {}),
  );

function fogPixels(clear, fog, region = [0, 0, clear.width, clear.height]) {
  const [left, top, right, bottom] = region;
  let weight = 0;
  let count = 0;
  let sum = 0;
  for (let y = top; y < bottom; y++) {
    for (let x = left; x < right; x++) {
      const i = 4 * (y * clear.width + x);
      let delta = 0;
      for (let k = 0; k < 3; k++) delta += Math.abs(fog.data[i + k] - clear.data[i + k]);
      if (delta < 6) continue;
      weight += delta;
      count++;
      sum += delta * x;
    }
  }
  return { count, center: weight > 0 ? sum / weight : null };
}

const water = (b) => b.water + b.exportedWater + b.deposited - b.entrainedWater - b.surfaceWater;

try {
  await page.waitForFunction(() => window.ready, null, { timeout: 25000 });
  const setup = await page.evaluate(() => window.ready);
  const sample = (frame, show = true, action) =>
    page.evaluate(([t, visible, step]) => window.shot.at(t, visible, step), [frame, show, action]);
  const clear = await sample(0, false);
  const clearImage = await capture('clear');
  const dry = await sample(0);
  assert.deepEqual(dry, clear);
  assert.deepEqual((await capture('uncondensed')).data, clearImage.data);
  assert.deepEqual(await sample(setup.cue - 1), dry);
  assert.deepEqual((await capture('held-start')).data, clearImage.data);
  const first = await sample(setup.cue + 1);
  const ridgeFrame = setup.cue + 36;
  const poolFrame = setup.cue + setup.end;
  const ridge = await sample(ridgeFrame, true, 'save');
  const ridgeImage = await capture('condensing-slope');
  const pool = await sample(poolFrame);
  const poolImage = await capture('valley-pool');
  assert.deepEqual(await sample(poolFrame + 30), pool);
  assert.deepEqual((await capture('held-pool')).data, poolImage.data);
  assert.deepEqual(await sample(ridgeFrame, true, 'restore'), ridge);
  assert.deepEqual((await capture('restored-slope')).data, ridgeImage.data);
  assert.deepEqual(await sample(poolFrame), pool);
  assert.deepEqual((await capture('replayed-pool')).data, poolImage.data);
  await sample(poolFrame, false);
  assert.deepEqual((await capture('detached')).data, clearImage.data);
  assert.deepEqual(await page.evaluate(() => window.shot.dispose()), { validation: null, errors: [] });
  assert.deepEqual(uncaught, []);

  assert.equal(dry.mass, 0);
  assert.equal(dry.upper.extinction, 0);
  assert.deepEqual(dry.upper.velocity, [0, 0]);
  assert(first.upper.ground > first.valley.ground && first.upper.temperature < dry.upper.temperature);
  // Downslope component of buoyancy using moist ideal-gas densities. Compare its scale with the
  // actual first-tick mean velocity rather than reproducing the solver's shallow-water closure.
  // Manins and Sawford (1979), A Model of Katabatic Winds. For the ambient density use the Tetens vapour pressure.
  const { ambientTemperature, ambientHumidity, slope } = setup;
  const celsius = ambientTemperature - 273.15;
  const partialPressure = 610.78 * Math.exp((17.27 * celsius) / (237.3 + celsius)) * ambientHumidity;
  const ambientMix = (0.622 * partialPressure) / (101325 - partialPressure);
  const relativeDensity = (temp, mixing) => (1 + mixing) / (temp * (1 + mixing / 0.622));
  const rhoAmbient = relativeDensity(ambientTemperature, ambientMix);
  const rhoCold = relativeDensity(dry.upper.temperature, dry.upper.vapour);
  const slopeBuoyancy = 9.81 * (1 - rhoAmbient / rhoCold) * Math.sin(Math.atan(slope));
  const acceptedAcceleration = first.upper.velocity[0] / first.seconds;
  assert(
    Math.abs(acceptedAcceleration / slopeBuoyancy - 1) < 0.12,
    JSON.stringify({ acceptedAcceleration, slopeBuoyancy }),
  );
  assert.equal(first.upper.velocity[1], 0);

  assert(ridge.upper.temperature < dry.upper.temperature && ridge.upper.vapour < dry.upper.vapour);
  assert(ridge.mass > 0.005 && ridge.upper.liquid > 0 && ridge.upper.extinction > 0.01);
  assert.equal(ridge.poolMass, 0);
  assert(pool.poolMass > 0.005 && pool.valley.extinction > 0.01 && pool.valley.depth > 2);
  // Cooling changes phase but cannot raise local total mixing ratio. Net vapour plus liquid arrived with the cold air.
  assert(pool.valley.vapour + pool.valley.liquid > dry.valley.vapour + dry.valley.liquid + 1e-4);
  assert(pool.center - ridge.center > 3, JSON.stringify({ ridge, pool }));
  for (const shot of [dry, first, ridge, pool]) {
    assert.equal(shot.budget.exportedWater, 0);
    assert(Math.abs(water(shot.budget) - water(dry.budget)) < 1024 * Number.EPSILON * dry.budget.water);
  }

  const uphill = fogPixels(clearImage, ridgeImage);
  const valley = fogPixels(clearImage, poolImage);
  const [x, y] = setup.basin.map(Math.round);
  const basin = [x - 22, y - 17, x + 22, y + 12];
  const earlyBasin = fogPixels(clearImage, ridgeImage, basin);
  const lateBasin = fogPixels(clearImage, poolImage, basin);
  assert(
    uphill.count > 250 && valley.count > 250 && lateBasin.count > 100,
    JSON.stringify({ uphill, valley, earlyBasin, lateBasin }),
  );
  assert(
    lateBasin.count > 4 * earlyBasin.count && valley.center - uphill.center > 25,
    JSON.stringify({ uphill, valley, earlyBasin, lateBasin }),
  );
  console.log(
    `  ${backend} valley fog: ${acceptedAcceleration.toFixed(4)} m/s² downslope, ${(pool.center - ridge.center).toFixed(2)} m / ${(valley.center - uphill.center).toFixed(1)} px downhill displacement, ${(1000 * pool.poolMass).toFixed(2)} g condensate in basin, replay ${pool.hash}`,
  );
} finally {
  await close();
}
