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
  const setup = await page.evaluate(async () => {
    const { mountThermalFilm } = await import('/packages/physics/tests/thermal-film.fixture.js');
    window.thermalFilm = await mountThermalFilm();
    const { cue, rate, checkpoint, end, seed, ambient, reference, emissivity, stefan, radiatingArea } =
      window.thermalFilm;
    return { cue, rate, checkpoint, end, seed, ambient, reference, emissivity, stefan, radiatingArea };
  });
  const { cue, rate, checkpoint, end, seed, ambient, reference, emissivity, stefan, radiatingArea } = setup;
  const radiativeLimit = emissivity * stefan * (reference ** 4 - ambient ** 4) * radiatingArea;
  let initialEnthalpy;
  async function sample(editFrame, options = {}) {
    const { image, ...state } = await page.evaluate((input) => window.thermalFilm.sample(input), {
      editFrame,
      ...options,
    });
    const png = Buffer.from(image, 'base64');
    const [exposed, insulated] = state.states;
    initialEnthalpy ??= insulated.enthalpy;
    const loss = initialEnthalpy - exposed.enthalpy;
    const elapsed = state.frame / rate;
    assert.equal(insulated.minimum, reference);
    assert.equal(insulated.maximum, reference);
    assert.equal(insulated.skin, reference);
    assert.equal(insulated.enthalpy, initialEnthalpy);
    assert.equal(insulated.stress + Math.hypot(...insulated.tip), 0);
    assert(
      loss >= exposed.power * elapsed && loss <= radiativeLimit * elapsed,
      JSON.stringify({ loss, lower: exposed.power * elapsed, upper: radiativeLimit * elapsed }),
    );
    return { state, png, pixels: await decodePNG(png) };
  }

  function exact(a, b) {
    assert.deepEqual(a.state, b.state);
    assert.deepEqual(a.pixels.data, b.pixels.data);
  }

  const initial = await sample(0);
  exact(await sample(cue - 1), initial);
  const first = await sample(cue + 1);
  const firstExposure = first.state.states[0];
  const firstLoss = initialEnthalpy - firstExposure.enthalpy;
  assert(Math.abs(firstLoss - firstExposure.power / rate) < 4096 * Number.EPSILON * initialEnthalpy);
  const cooling = await sample(cue + checkpoint, { action: 'save' });
  const flat = await sample(cue + end, { showDeformation: false });
  const uncoloured = await sample(cue + end, { showDeformation: false, showCooling: false });
  const after = await sample(cue + end);
  const early = cooling.state.states[0];
  const [state] = after.state.states;
  assert(state.skin < early.skin && early.skin < firstExposure.skin);
  assert(state.minimum < 1260 && state.maximum > 1340 && state.skin < state.minimum);
  // Hotter layers retain their expansion. A freely projected tip bows toward the colder upper face.
  assert(state.tip[1] > early.tip[1] && early.tip[1] > 0 && state.tip[1] > 0.00035);
  assert(Math.abs(state.tip[0]) < state.tip[1] && state.stress > 4e7);
  assert.equal(state.hash, flat.state.states[0].hash);
  assert.equal(state.hash, uncoloured.state.states[0].hash);
  assert.deepEqual(initial.pixels.data, uncoloured.pixels.data);
  const optical = changed(flat.pixels, uncoloured.pixels);
  const bow = changed(after.pixels, flat.pixels);
  assert(optical > 1800 && bow > 275, JSON.stringify({ optical, bow }));

  exact(await sample(cue + end + 36), after);
  exact(await sample(cue + checkpoint, { action: 'restore' }), cooling);
  exact(await sample(cue + end), after);
  exact(await sample(0), initial);
  exact(await sample(cue + end), after);
  assert.deepEqual(await page.evaluate(() => window.thermalFilm.dispose()), { errors: [], validation: null });
  assert.deepEqual(errors, []);

  if (process.env.MARGO_KEEP_THERMAL_FILM_FRAMES === '1') {
    const path = 'packages/physics/test-results/thermal-film';
    await mkdir(path, { recursive: true });
    for (const [name, frame] of Object.entries({ initial, first, cooling, after, flat }))
      await writeFile(`${path}/${backend}-${name}.png`, frame.png);
  }
  console.log(
    `${backend} thermal: ${(initialEnthalpy - state.enthalpy).toFixed(2)} J radiated, ${state.skin.toFixed(2)} K tip skin, ` +
      `${(state.tip[1] * 1000).toFixed(3)} mm bow, ${optical}/${bow} glow/shape pixels, ` +
      `seed ${seed}, replay ${state.hash}/${after.state.states[1].hash}.`,
  );
} finally {
  await close();
}
