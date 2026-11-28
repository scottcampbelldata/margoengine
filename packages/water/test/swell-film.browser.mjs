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
  for (let i = 0; i < a.length; i += 4) {
    const difference = Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]);
    if (difference > 16) count++;
  }
  return count;
}

try {
  const { cue, duration, windUntil, stationDistance, frequencies, interval } = await page.evaluate(async () => {
    const { setupSwellFilm } = await import('/packages/water/test/swell-film.fixture.js');
    window.swellFilm = await setupSwellFilm();
    const { cue, duration, windUntil, stationDistance, frequencies, interval } = window.swellFilm;
    return { cue, duration, windUntil, stationDistance, frequencies, interval };
  });
  async function sample(editFrame, options = {}) {
    const { image, ...state } = await page.evaluate((input) => window.swellFilm.sample(input), {
      editFrame,
      ...options,
    });
    const png = Buffer.from(image, 'base64');
    return { state, png, pixels: (await decodePNG(png)).data };
  }
  function same(a, b) {
    assert.deepEqual(a.state, b.state);
    assert.deepEqual(a.pixels, b.pixels);
  }
  const initial = await sample(0);
  assert.deepEqual(initial.state.heights, [0, 0]);
  assert.deepEqual(initial.state.arrival, [null, null]);
  same(await sample(cue - 1), initial);
  const near = await sample(cue + 24);
  assert(near.state.heights[0] > 0.05 && near.state.heights[1] < 0.003);
  const arrived = await sample(cue + 72, { action: 'save' });
  const [upwind, downwind] = arrived.state.arrival;
  assert(upwind > 0 && downwind > upwind);
  // Deep-water group speed g/(4πf) across the prescribed bandwidth. Allow one accepted temporal bin.
  // US Army Corps of Engineers, Shore Protection Manual (1984), equation 2-36: https://luk.tsipil.ugm.ac.id/USACE/USACE-ShoreProtectionManual1.pdf
  const flight = (f) => (stationDistance * 4 * Math.PI * f) / 9.81;
  assert(downwind - upwind >= flight(frequencies.min) - interval);
  assert(downwind - upwind <= flight(frequencies.max) + interval);
  const stillBlowing = await sample(cue + windUntil - interval);
  const gustStopped = await sample(cue + windUntil + 2 * interval);
  assert(stillBlowing.state.sourceFriction > 1);
  assert.equal(gustStopped.state.sourceFriction, 0);

  const crest = await sample(cue + 224, { query: true });
  const trough = await sample(cue + duration, { query: true });
  for (const { state } of [crest, trough]) {
    assert.equal(state.sourceFriction, 0);
    assert.equal(state.buoyFriction, 0);
    assert(
      state.heights[1] > gustStopped.state.heights[1] + 0.05,
      'wave energy continues to reach the buoy after shutoff',
    );
    assert(Math.abs(state.rendered - state.eta) < 0.003, JSON.stringify({ eta: state.eta, rendered: state.rendered }));
  }
  assert(crest.state.pose[1] > 0.08 && trough.state.pose[1] < -0.08);
  assert(crest.state.eta > 0.08 && trough.state.eta < -0.08);
  assert(crest.state.period >= 1 / frequencies.max && crest.state.period <= 1 / frequencies.min);
  const still = await sample(cue + 224, { mode: 'still', query: true });
  assert.deepEqual(still.state.heights, [0, 0]);
  assert.deepEqual(still.state.arrival, [null, null]);
  assert.equal(still.state.eta, 0);
  assert(Math.abs(still.state.pose[1]) < 1e-6);
  const heldBuoy = await sample(cue + 224, { mode: 'held-buoy', query: true });
  assert.deepEqual(heldBuoy.state, crest.state);
  const seaPixels = changed(crest.pixels, still.pixels);
  const buoyPixels = changed(crest.pixels, heldBuoy.pixels);
  assert(seaPixels > 2500 && buoyPixels > 500, JSON.stringify({ seaPixels, buoyPixels }));
  assert(changed(crest.pixels, trough.pixels) > 2500);

  same(await sample(cue + duration + 24, { query: true }), trough);
  same(await sample(cue + 72, { action: 'restore' }), arrived);
  same(await sample(cue + 224, { query: true }), crest);
  same(await sample(0), initial);
  same(await sample(cue + duration, { query: true }), trough);
  assert.deepEqual(await page.evaluate(() => window.swellFilm.dispose()), { errors: [], validation: null });
  assert.deepEqual(errors, []);

  if (process.env.MARGO_KEEP_SWELL_FILM_FRAMES === '1') {
    const path = 'packages/water/test-results/swell-film';
    await mkdir(path, { recursive: true });
    for (const [phase, frame] of Object.entries({ initial, near, gustStopped, crest, trough, still })) {
      await writeFile(`${path}/${backend}-${phase}.png`, frame.png);
    }
  }
  console.log(
    `${backend} swell: ${upwind}/${downwind} s arrivals, ${gustStopped.state.heights[1].toFixed(3)} to ` +
      `${crest.state.heights[1].toFixed(3)} m significant height after shutoff, ` +
      `${crest.state.pose[1].toFixed(3)}/${trough.state.pose[1].toFixed(3)} m guided heave, ` +
      `${seaPixels} coupled pixels and ${buoyPixels} buoy pixels, ${crest.state.hash}.`,
  );
} finally {
  await close();
}
