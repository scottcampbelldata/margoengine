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
  const counts = [0, 0];
  for (let i = 0; i < a.data.length; i += 4) {
    const diff =
      Math.abs(a.data[i] - b.data[i]) +
      Math.abs(a.data[i + 1] - b.data[i + 1]) +
      Math.abs(a.data[i + 2] - b.data[i + 2]);
    if (diff > 18) counts[Number((i / 4) % a.width >= a.width / 2)]++;
  }
  return counts;
}

function near(got, expected, bound) {
  assert(Math.abs(got - expected) <= bound, JSON.stringify({ got, expected, bound }));
}

try {
  const setup = await page.evaluate(async () => {
    const { mountAgeingFilm } = await import('/packages/physics/tests/ageing-film.fixture.js');
    const take = await mountAgeingFilm();
    window.ageingFilm = take;
    const { sample, dispose, ...parameters } = take;
    return parameters;
  });
  const {
    cue,
    rate,
    firstCheckpoint,
    wetCheckpoint,
    drainCheckpoint,
    end,
    scale,
    current,
    couponBottom,
    couponThickness,
    bandHeight,
    bands,
    retention,
    couponStation,
    cell,
    seed,
  } = setup;
  // Faraday charge balance for ideal Fe(II) loss, ASTM G102 §3.1, https://store.astm.org/standards/g102.
  // Use the independently accumulated duration as the charge meter; this is an analytic, not a measured, witness.
  const faraday = 96485.33212331002;
  const iron = { density: 7870, molarMass: 0.055845 };
  const oxide = { density: 5240, molarMass: 0.159687 };
  const rustRatio = (retention * (oxide.molarMass * iron.density)) / (2 * iron.molarMass * oxide.density);
  async function sample(editFrame, options = {}) {
    const { image, ...state } = await page.evaluate((input) => window.ageingFilm.sample(input), {
      editFrame,
      ...options,
    });
    const png = Buffer.from(image, 'base64');
    for (const take of state.states) {
      assert.deepEqual(take.fields, [cell, cell, cell]);
      assert.equal(take.budget.rain, 0);
      near(take.stored + take.budget.out, take.budget.inflow, 512 * Number.EPSILON * take.budget.inflow);
      assert.equal(take.depths[couponStation], Math.fround(take.acceptedDepth));
      for (let i = 0; i < bands; i++) {
        const patch = take.state[i];
        const loss = (current * take.dose[i] * iron.molarMass) / (2 * faraday * iron.density);
        const wet = Math.max(
          0,
          Math.min(1, (Math.fround(take.acceptedDepth) - (couponBottom + i * bandHeight)) / bandHeight),
        );
        assert.equal(take.wet[i], wet);
        near(patch.consumedThickness, loss, 256 * Number.EPSILON * loss);
        near(patch.remainingThickness + patch.consumedThickness, couponThickness, Number.EPSILON * couponThickness);
        near(patch.coatingThickness, loss * rustRatio, 256 * Number.EPSILON * loss * rustRatio);
        assert.equal(patch.coatingThickness, patch.innerCoatingThickness);
        assert.equal(patch.exposureSeconds, (state.frame * scale) / rate);
        assert.equal(patch.rotActivity, 0);
        assert.equal(patch.fouledFraction, 0);
      }
    }
    return { state, png, pixels: await decodePNG(png) };
  }

  function exact(a, b) {
    assert.deepEqual(a.state, b.state);
    assert.deepEqual(a.pixels.data, b.pixels.data);
  }

  const initial = await sample(0);
  exact(await sample(cue), initial);
  const prefill = await sample(cue + firstCheckpoint, { action: 'save' });
  assert.deepEqual(initial.pixels.data, prefill.pixels.data);
  const wet = await sample(cue + wetCheckpoint, { action: 'save' });
  assert(wet.state.states[0].acceptedDepth > 0.105);
  assert.equal(wet.state.states[0].wet[0], 1);
  assert.equal(wet.state.states[0].wet.at(-1), 0);
  const drained = await sample(cue + drainCheckpoint);
  const after = await sample(cue + end);
  const dryView = await sample(cue + end, { showWater: false });
  const cleanView = await sample(cue + end, { showWater: false, showWeathering: false });
  assert.deepEqual(after.state, dryView.state);
  assert.deepEqual(after.state, cleanView.state);
  const [exposed, control] = after.state.states;
  assert(exposed.acceptedDepth < couponBottom);
  assert(exposed.budget.inflow > 0.075 && exposed.budget.out > 0.072);
  assert.deepEqual(
    exposed.state.map((patch) => patch.consumedThickness),
    drained.state.states[0].state.map((patch) => patch.consumedThickness),
  );
  assert(exposed.state[0].consumedThickness > 14e-6);
  assert(exposed.state[0].consumedThickness > exposed.state[4].consumedThickness);
  assert(exposed.state[4].consumedThickness > 0);
  assert.equal(exposed.state.at(-1).consumedThickness, 0);
  assert.equal(control.stored + control.budget.inflow + control.budget.out, 0);
  assert(control.state.every((patch) => patch.consumedThickness === 0));
  assert(exposed.appearance[0].roughness > control.appearance[0].roughness + 0.4);
  assert.deepEqual(control.appearance, initial.state.states[1].appearance);
  assert.deepEqual(cleanView.pixels.data, initial.pixels.data);
  const [rustPixels, rightPixels] = changed(dryView.pixels, cleanView.pixels);
  const [waterPixels] = changed(wet.pixels, (await sample(cue + wetCheckpoint, { showWater: false })).pixels);
  assert(rustPixels > 1500 && rightPixels === 0, JSON.stringify({ rustPixels, rightPixels }));
  assert(waterPixels > 4000, JSON.stringify({ waterPixels }));

  exact(await sample(cue + end + 36), after);
  exact(await sample(cue + wetCheckpoint, { action: 'restore' }), wet);
  exact(await sample(cue + drainCheckpoint), drained);
  exact(await sample(cue + end), after);
  exact(await sample(cue + firstCheckpoint, { action: 'restore' }), prefill);
  exact(await sample(cue + wetCheckpoint), wet);
  exact(await sample(cue + end), after);
  exact(await sample(0), initial);
  exact(await sample(cue + end), after);
  assert.deepEqual(await page.evaluate(() => window.ageingFilm.dispose()), { errors: [], validation: null });
  assert.deepEqual(errors, []);

  if (process.env.MARGO_KEEP_AGEING_FILM_FRAMES === '1') {
    const path = 'packages/physics/test-results/ageing-film';
    await mkdir(path, { recursive: true });
    for (const [name, shot] of Object.entries({ initial, wet, drained, after, dryView, cleanView }))
      await writeFile(`${path}/${backend}-${name}.png`, shot.png);
  }
  const microns = (m) => (1e6 * m).toFixed(2);
  console.log(
    `${backend} ageing: wet line ${(1000 * wet.state.states[0].acceptedDepth).toFixed(2)} mm, ` +
      `${microns(exposed.state[0].consumedThickness)} µm consumed, ${microns(exposed.state[0].coatingThickness)} µm retained oxide, ` +
      `${rustPixels}/${waterPixels} coating/water pixels, seed ${seed}, replay ${exposed.hash}/${control.hash}.`,
  );
} finally {
  await close();
}
