import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { openBrowser } from '../../../scripts/browser.js';
import { decodePNG } from '../../../tests/support/png.js';

process.chdir(fileURLToPath(new URL('../../../', import.meta.url)));
const { page, close, hardware } = await openBrowser({ startPath: '/tools/shot/blank.html', port: 'free' });
const backend = hardware.compat ? 'WebGL2' : 'WebGPU';
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));

function changed(a, b) {
  let count = 0;
  for (let i = 0; i < a.data.length; i += 4) {
    const delta =
      Math.abs(a.data[i] - b.data[i]) +
      Math.abs(a.data[i + 1] - b.data[i + 1]) +
      Math.abs(a.data[i + 2] - b.data[i + 2]);
    if (delta > 18) count++;
  }
  return count;
}

try {
  const setup = await page.evaluate(async () => {
    const { mountIceThermodynamicsFilm } = await import('/packages/physics/tests/ice-thermodynamics-film.fixture.js');
    window.iceFilm = await mountIceThermodynamicsFilm();
    const { cue, rate, checkpoint, end, firstVent, shutVent, seed, thickness, area, count, iceDensity, waterDensity } =
      window.iceFilm;
    return { cue, rate, checkpoint, end, firstVent, shutVent, seed, thickness, area, count, iceDensity, waterDensity };
  });
  const { cue, rate, checkpoint, end, firstVent, shutVent, seed, thickness, area, count, iceDensity, waterDensity } =
    setup;
  const frozenMass = thickness * area * count * iceDensity;
  async function sample(editFrame, options = {}) {
    const { image, ...state } = await page.evaluate((input) => window.iceFilm.sample(input), { editFrame, ...options });
    const png = Buffer.from(image, 'base64');
    const { frame, sites, lava, water, pool } = state;
    const solid = sites.reduce((sum, site) => sum + site.thickness * area * iceDensity, 0);
    const liquid = sites.reduce((sum, site) => sum + site.meltwater / rate, 0);
    const vapour = sites.reduce((sum, site) => sum + site.steam / rate, 0);
    const error = 64 * Number.EPSILON * Math.max(1, frame);
    // The staggered lava producer books the ice response on its next tick. The pool sees the current liquid.
    assert(
      Math.abs(water * waterDensity - lava.meltwater - liquid) < error * frozenMass,
      JSON.stringify({ frame, water, lavaMeltwater: lava.meltwater, liquid }),
    );
    assert(Math.abs(frozenMass - solid - water * waterDensity - lava.steam - vapour) < error * frozenMass);
    assert(Math.abs(pool.inflow - water) < (error * frozenMass) / waterDensity && pool.rain + pool.out === 0);
    assert(Math.abs(lava.initialVolume + lava.suppliedVolume - lava.storedVolume) <= error * lava.suppliedVolume);
    const supplied = lava.initialEnthalpy + lava.suppliedEnthalpy;
    assert(
      Math.abs(supplied - lava.storedEnthalpy - lava.iceHeat - lava.environmentalHeat) <= error * supplied,
      JSON.stringify({ frame, supplied, lava }),
    );
    return { state, png, pixels: await decodePNG(png) };
  }
  function exact(a, b) {
    assert.deepEqual(a.state, b.state);
    assert.deepEqual(a.pixels.data, b.pixels.data);
  }

  const frozen = await sample(0);
  exact(await sample(cue - 1), frozen);
  const preVent = await sample(cue + Math.floor(firstVent * rate));
  assert.equal(preVent.state.lava.suppliedVolume, 0);
  assert.deepEqual(preVent.pixels.data, frozen.pixels.data);
  const equalFooting = await sample(0, { exchange: false });
  assert.deepEqual(equalFooting.state.sites, frozen.state.sites);
  assert.deepEqual(equalFooting.pixels.data, frozen.pixels.data);

  const prior = await sample(cue + checkpoint - 1);
  const warm = await sample(cue + checkpoint, { action: 'save' });
  for (const [i, site] of warm.state.sites.entries()) {
    const offer = prior.state.heat[i] * area;
    assert(site.thickness > 0 && site.thickness < thickness && site.heatAbsorbed > 0);
    assert(site.heatAbsorbed <= offer + 32 * Number.EPSILON * offer);
  }
  assert(warm.state.heat.every((power) => power > 1e5 && power < 9e5));
  assert(warm.state.water > 0.001 && warm.state.lava.iceHeat > 3e5);
  const warmFootage = changed(warm.pixels, frozen.pixels);
  assert(warmFootage > 1800);

  const cold = await sample(cue + end, { exchange: false });
  assert(cold.state.sites.every((site) => site.thickness === thickness));
  assert.equal(cold.state.water, 0);
  assert.equal(cold.state.lava.iceHeat + cold.state.lava.meltwater + cold.state.lava.steam, 0);
  const noMagmaCold = await sample(cue + end, { exchange: false, showMagma: false, showPool: false });
  const noMagmaWarm = await sample(cue + end, { showMagma: false, showPool: false });
  const noPool = await sample(cue + end, { showPool: false });
  const after = await sample(cue + end, { query: true });
  const { state } = after;
  assert(state.lava.suppliedVolume === warm.state.lava.suppliedVolume && end / rate > shutVent);
  const melted = state.sites.filter((site) => site.thickness === 0).length;
  assert(melted >= 4 && state.lava.iceHeat > 1e6 && state.lava.steam > 0 && state.water > 0.003);
  assert(state.basin.depth > 0.04);
  assert(
    Number.isFinite(state.poolHeight) && Math.abs(state.poolHeight - state.basin.surface) < 2e-5,
    JSON.stringify({ basin: state.basin, rendered: state.poolHeight }),
  );
  const icePixels = changed(noMagmaWarm.pixels, noMagmaCold.pixels);
  const waterPixels = changed(after.pixels, noPool.pixels);
  assert(icePixels > 350 && waterPixels > 200, JSON.stringify({ icePixels, waterPixels }));
  exact(await sample(cue + end + 30, { query: true }), after);
  exact(await sample(cue + checkpoint, { action: 'restore' }), warm);
  exact(await sample(cue + end, { query: true }), after);
  exact(await sample(0), frozen);
  exact(await sample(cue + end, { query: true }), after);
  assert.deepEqual(await page.evaluate(() => window.iceFilm.dispose()), { errors: [], validation: null });
  assert.deepEqual(errors, []);

  if (process.env.MARGO_KEEP_THERMAL_ICE_FRAMES === '1') {
    const path = 'packages/physics/test-results/ice-thermodynamics-film';
    await mkdir(path, { recursive: true });
    for (const [name, frame] of Object.entries({ frozen, warm, cold, after, noMagmaWarm, noMagmaCold }))
      await writeFile(`${path}/${backend}-${name}.png`, frame.png);
  }
  console.log(
    `${backend} thermal ice: ${melted}/${count} sites melted, ${(state.lava.iceHeat / 1e6).toFixed(4)} MJ accepted, ` +
      `${(state.water * waterDensity).toFixed(6)} kg water and ${(1000 * state.lava.steam).toFixed(4)} g steam, ` +
      `${(100 * state.basin.depth).toFixed(3)} cm basin depth, ${icePixels}/${waterPixels} ice/water pixels, seed ${seed}, replay ${state.hash}.`,
  );
} finally {
  await close();
}
