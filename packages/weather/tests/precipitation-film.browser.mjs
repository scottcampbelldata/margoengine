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
  let visible = 0;
  for (let i = 0; i < a.data.length; i += 4) {
    const difference =
      Math.abs(a.data[i] - b.data[i]) +
      Math.abs(a.data[i + 1] - b.data[i + 1]) +
      Math.abs(a.data[i + 2] - b.data[i + 2]);
    if (difference > 12) visible++;
  }
  return visible;
}

try {
  const { cue, flight, contact, end } = await page.evaluate(async () => {
    const { mountPrecipitationFilm } = await import('/packages/weather/tests/fixtures/precipitation-film.js');
    window.precipitationFilm = await mountPrecipitationFilm();
    const { cue, flight, contact, end } = window.precipitationFilm;
    return { cue, flight, contact, end };
  });
  async function sample(editFrame, options = {}) {
    const { image, ...state } = await page.evaluate((input) => window.precipitationFilm.sample(input), {
      editFrame,
      ...options,
    });
    for (const value of [
      ...state.pair.flatMap(({ position, velocity }) => [...position, ...velocity]),
      ...Object.values(state.phase),
    ]) {
      assert(Number.isFinite(value));
    }
    const png = Buffer.from(image, 'base64');
    return { state, png, image: await decodePNG(png) };
  }
  function exact(a, b) {
    assert.deepEqual(a.state, b.state);
    assert.deepEqual(a.image.data, b.image.data);
  }

  const before = await sample(0);
  assert.equal(before.state.visible, 0);
  assert.equal(before.state.surface.volume, 0);
  exact(await sample(cue - 1), before);
  const inFlight = await sample(cue + flight, { action: 'save' });
  const noGust = await sample(cue + flight, { mode: 'still' });
  assert(inFlight.state.visible > 20);
  const [small, large] = inFlight.state.pair;
  const [stillSmall, stillLarge] = noGust.state.pair;
  const smallGustDrift = small.position[0] - stillSmall.position[0];
  const largeGustDrift = large.position[0] - stillLarge.position[0];
  assert(smallGustDrift > 1e-3 && smallGustDrift > largeGustDrift, JSON.stringify({ smallGustDrift, largeGustDrift }));
  assert(small.position[1] > large.position[1] && large.velocity[1] < small.velocity[1]);
  assert(changed(inFlight.image, noGust.image) > 80);

  const wet = await sample(cue + contact, { query: true });
  const muted = await sample(cue + contact, { mode: 'muted', query: true });
  assert.deepEqual(wet.state.pair, muted.state.pair);
  assert.equal(wet.state.fallen, muted.state.fallen);
  assert.equal(wet.state.visible, muted.state.visible);
  assert(wet.state.fallen > 10);
  assert(wet.state.pair[0].position[1] > 0.0005 && wet.state.pair[1].position[1] < 0.0024);
  assert(wet.state.deposit > 0 && Math.abs(wet.state.surface.volume - wet.state.deposit) <= 2e-12 * wet.state.deposit);
  assert(wet.state.surface.peak > 0 && wet.state.surface.trough < 0);
  assert(
    wet.state.surface.drawn !== null &&
      wet.state.surface.sampled > 1e-5 &&
      Math.abs(wet.state.surface.drawn - wet.state.surface.sampled) < 2e-6,
    JSON.stringify(wet.state.surface),
  );
  assert.deepEqual(muted.state.surface, { peak: 0, trough: 0, volume: 0, drawn: 0, sampled: 0 });
  const ringPixels = changed(wet.image, muted.image);
  assert(ringPixels > 100, JSON.stringify({ ringPixels, surface: wet.state.surface }));

  const last = await sample(cue + end, { query: true });
  const cold = await sample(cue + end, { mode: 'snow' });
  const coldBackground = await sample(cue + end, { mode: 'snow', showParticles: false });
  assert.deepEqual(cold.state, coldBackground.state);
  const snowPixels = changed(cold.image, coldBackground.image);
  assert(snowPixels > 40, JSON.stringify({ snowPixels, flakes: cold.state.visible }));
  assert(cold.state.phase.snow > 0.99 * (cold.state.phase.rain + cold.state.phase.snow));
  assert(last.state.phase.rain > 0.99 * (last.state.phase.rain + last.state.phase.snow));
  assert(cold.state.visible > last.state.visible && cold.state.pair[1].position[1] > 0);
  assert(cold.state.pair[1].velocity[1] < 0 && cold.state.pair[1].velocity[1] > inFlight.state.pair[1].velocity[1]);
  assert(changed(cold.image, last.image) > 400);
  assert(last.state.fallen > wet.state.fallen);
  exact(await sample(cue + end + 20, { query: true }), last);
  exact(await sample(cue + flight, { action: 'restore' }), inFlight);
  exact(await sample(cue + contact, { query: true }), wet);
  exact(await sample(cue + end, { mode: 'snow' }), cold);
  exact(await sample(0), before);
  exact(await sample(cue + end, { query: true }), last);
  assert.deepEqual(await page.evaluate(() => window.precipitationFilm.dispose()), { errors: [], validation: null });
  assert.deepEqual(errors, []);

  if (process.env.MARGO_KEEP_PRECIPITATION_FRAMES === '1') {
    const path = 'packages/weather/test-results/precipitation-film';
    await mkdir(path, { recursive: true });
    for (const [name, value] of Object.entries({ inFlight, noGust, wet, muted, cold }))
      await writeFile(`${path}/${backend}-${name}.png`, value.png);
  }
  console.log(
    `${backend} ATMO-04: gust adds ${(1000 * smallGustDrift).toFixed(2)}/${(1000 * largeGustDrift).toFixed(2)} mm of small/large drop drift, ` +
      `${wet.state.fallen} impacts deposit ${(1e9 * wet.state.surface.volume).toFixed(2)} µL; ${ringPixels} ring pixels; ` +
      `cold take ${cold.state.visible} accepted aggregates and ${snowPixels} flake pixels; replay ${wet.state.hashes[3]}.`,
  );
} finally {
  await close();
}
