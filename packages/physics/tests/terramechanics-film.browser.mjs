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
    const d =
      Math.abs(a.data[i] - b.data[i]) +
      Math.abs(a.data[i + 1] - b.data[i + 1]) +
      Math.abs(a.data[i + 2] - b.data[i + 2]);
    if (d > 18) count++;
  }
  return count;
}

try {
  const { cue, preload, checkpoint, motorStop, end, bulkDensity, seed } = await page.evaluate(async () => {
    const { mountTerramechanicsFilm } = await import('/packages/physics/tests/terramechanics-film.fixture.js');
    window.terramechanicsFilm = await mountTerramechanicsFilm();
    const { cue, preload, checkpoint, motorStop, end, bulkDensity, seed } = window.terramechanicsFilm;
    return { cue, preload, checkpoint, motorStop, end, bulkDensity, seed };
  });
  const cueAt = (frame) => cue + frame - preload;
  async function sample(editFrame, options = {}) {
    const { image, ...state } = await page.evaluate((input) => window.terramechanicsFilm.sample(input), {
      editFrame,
      ...options,
    });
    const png = Buffer.from(image, 'base64');
    const { budget, bedVolume, refused, dustBudget, dust, response, reaction } = state;
    const { removed, compacted, suspended, deposited, exported } = budget;
    const error = 2048 * Number.EPSILON * removed;
    assert(removed > 0 && compacted > 0 && suspended > 0);
    assert(Math.abs(removed - compacted - suspended - deposited - exported) < error);
    assert(Math.abs(bedVolume + compacted + suspended + exported) < error);
    assert.equal(refused, 0);
    const { supplied, airborne, waiting, evaporated, outflow, deposited: settled } = dustBudget;
    const dustError = error * bulkDensity;
    assert(Math.abs(supplied - airborne - waiting - evaporated - outflow - settled) < dustError);
    assert(Math.abs(dust.mass - airborne) < dustError);
    assert(supplied <= suspended * bulkDensity + dustError);
    assert(response.normalForce > 0 && reaction[0] > 0);
    assert.equal(state.speed, 0);
    return { state, png, pixels: await decodePNG(png) };
  }
  function exact(a, b) {
    assert.deepEqual(a.state, b.state);
    assert.deepEqual(a.pixels.data, b.pixels.data);
  }

  const start = await sample(0);
  exact(await sample(cue - 1), start);
  exact(await sample(0, { powered: false }), start);
  const digging = await sample(cueAt(checkpoint), { action: 'save' });
  const cut = await sample(cueAt(motorStop));
  const powered = await sample(cueAt(end));
  const savedBed = await sample(cueAt(end), { dustVisible: false });
  const parked = await sample(cueAt(end), { powered: false, dustVisible: false });
  if (process.env.MARGO_KEEP_TERRAMECHANICS_FRAMES === '1') {
    const path = 'packages/physics/test-results/terramechanics-film';
    await mkdir(path, { recursive: true });
    for (const [name, frame] of Object.entries({ start, digging, powered, savedBed, parked }))
      await writeFile(`${path}/${backend}-${name}.png`, frame.png);
  }
  const { state } = powered;
  assert.equal(state.hash, savedBed.state.hash);
  assert(digging.state.spin > 0 && cut.state.spin > digging.state.spin && cut.state.phase > 2 * Math.PI);
  assert(digging.state.reaction[1] > 0 && digging.state.reaction[2] > 0, JSON.stringify(digging.state.reaction));
  assert(state.phase > cut.state.phase && state.spin === 0);
  assert.equal(parked.state.spin, 0);
  assert.equal(parked.state.phase, 0);
  const addedRut = parked.state.minimum - state.minimum;
  assert(addedRut > 0.07 && state.maximum > parked.state.maximum);
  assert(state.dustBudget.supplied > 3 * parked.state.dustBudget.supplied);
  assert(
    state.dust.altitude < digging.state.dust.altitude && state.dust.opticalArea > digging.state.dust.opticalArea,
    JSON.stringify({ early: digging.state.dust, late: state.dust }),
  );
  assert(Math.abs(state.budget.suspended * bulkDensity - state.dustBudget.supplied) < 1e-14);
  const dustPixels = changed(powered.pixels, savedBed.pixels);
  const contactPixels = changed(savedBed.pixels, parked.pixels);
  assert(contactPixels > 850 && dustPixels > 200, JSON.stringify({ contactPixels, dustPixels }));

  exact(await sample(cueAt(end) + 18), powered);
  exact(await sample(cueAt(checkpoint), { action: 'restore' }), digging);
  exact(await sample(cueAt(end)), powered);
  exact(await sample(0), start);
  exact(await sample(cueAt(end)), powered);
  assert.deepEqual(await page.evaluate(() => window.terramechanicsFilm.dispose()), { errors: [], validation: null });
  assert.deepEqual(errors, []);

  console.log(
    `${backend} terramechanics: ${(1000 * addedRut).toFixed(2)} mm deeper under drive, ` +
      `${(1000 * state.dustBudget.supplied).toFixed(3)} g actual displaced airborne material, ` +
      `${contactPixels}/${dustPixels} contact/dust pixels, seed ${seed}, replay ${state.hash}.`,
  );
} finally {
  await close();
}
