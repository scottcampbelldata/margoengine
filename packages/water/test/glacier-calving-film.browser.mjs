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

const total = (words) => words.reduce((a, b) => a + b, 0);

function changed(a, b) {
  let count = 0;
  for (let i = 0; i < a.data.length; i += 4) {
    const distance =
      Math.abs(a.data[i] - b.data[i]) +
      Math.abs(a.data[i + 1] - b.data[i + 1]) +
      Math.abs(a.data[i + 2] - b.data[i + 2]);
    if (distance > 18) count++;
  }
  return count;
}

try {
  const { cue, releaseFrame, checkpoint, end, front, dx, initialVolume, patchWords } = await page.evaluate(async () => {
    const { mountGlacierCalvingFilm } = await import('/packages/water/test/glacier-calving-film.fixture.js');
    window.glacierCalvingFilm = await mountGlacierCalvingFilm();
    const { cue, releaseFrame, checkpoint, end, front, dx, initialVolume, patchWords } = window.glacierCalvingFilm;
    return { cue, releaseFrame, checkpoint, end, front, dx, initialVolume, patchWords };
  });
  async function sample(editFrame, options = {}) {
    const { image, ...state } = await page.evaluate((input) => window.glacierCalvingFilm.sample(input), {
      editFrame,
      ...options,
    });
    const png = Buffer.from(image, 'base64');
    const { frame, glacierBudget, icebergBudget, depths, ice, waveSource, wake } = state;
    // The implicit update accumulates one row per cell and time step. Bound single-step floating arithmetic by
    // the represented initial inventory, then accumulate over the actual stepped counterfactual and active paths.
    const error = 32 * Number.EPSILON * initialVolume * depths.length * Math.max(1, frame);
    const near = (actual, expected) =>
      assert(Math.abs(actual - expected) <= error, JSON.stringify({ frame, actual, expected, error }));
    near(glacierBudget.ice, total(depths) * dx ** 2);
    near(glacierBudget.ice + glacierBudget.calved, initialVolume);
    assert.equal(glacierBudget.fallen + glacierBudget.melted + glacierBudget.accumulation, 0);
    near(glacierBudget.calved, icebergBudget.calved);
    near(icebergBudget.ice + icebergBudget.awaiting, icebergBudget.calved);
    near(icebergBudget.ice, total(ice.map(({ size }) => size.reduce((product, extent) => product * extent, 1))));
    near(wake.volume, 0);
    assert.equal(waveSource.length, 2 * patchWords * ice.length);
    for (const [i, { waveVolume }] of ice.entries()) {
      const source = i * 2 * patchWords;
      assert.equal(waveSource[source + patchWords - 1] + waveSource[source + 2 * patchWords - 1], 0);
      assert(waveSource[source + 2 * patchWords - 1] === waveVolume);
    }
    if (options.query) {
      const reference = options.mode === 'mute' ? [0, 0, 0] : wake.levels;
      for (const [i, level] of reference.entries()) {
        const draw = state.drawLevels[i];
        assert(draw !== null && Math.abs(draw - level) < 2e-5, JSON.stringify({ i, draw, level }));
      }
    }
    return { state, png, image: await decodePNG(png) };
  }
  function exact(a, b) {
    assert.deepEqual(a.state, b.state);
    assert.deepEqual(a.image.data, b.image.data);
  }

  const start = await sample(0, { query: true });
  assert(start.state.face > 4 && start.state.face + start.state.faceBed > 0);
  assert(
    start.state.face < (-start.state.faceBed * 1000) / 917,
    'the grounded ice is thinner than the flotation depth',
  );
  assert.equal(start.state.icebergBudget.ice, 0);
  assert.deepEqual(start.state.wake.levels, [0, 0, 0]);
  exact(await sample(cue - 1, { query: true }), start);
  const first = await sample(cue + releaseFrame);
  assert.equal(first.state.face, 0);
  assert(first.state.output[front] > 35 && first.state.output[front] < 37);
  assert.equal(first.state.output[front], first.state.admitted[0]);
  assert(Math.abs(total(first.state.output) - total(first.state.admitted)) < 64 * Number.EPSILON * initialVolume);
  assert(first.state.ice[0].displaced > 30 && first.state.ice[0].waveVolume > 30);
  assert(first.state.wake.min < 0 && first.state.wake.max > 0);

  const restoring = await sample(cue + checkpoint, { action: 'save' });
  const closed = await sample(cue + end, { mode: 'closed', query: true });
  const moved = await sample(cue + end, { query: true });
  const muted = await sample(cue + end, { mode: 'mute', query: true });
  assert(closed.state.face > 4 && closed.state.face + closed.state.faceBed > 0);
  assert.equal(closed.state.glacierBudget.calved + closed.state.icebergBudget.ice, 0);
  assert.deepEqual(closed.state.wake.levels, start.state.wake.levels);
  assert.equal(moved.state.face + total(moved.state.admitted), 0);
  assert.equal(moved.state.hash, muted.state.hash);
  assert.deepEqual(moved.state.ice, muted.state.ice);
  const gauge = moved.state.wake.levels[1];
  assert(gauge > 0.1 && first.state.wake.levels[1] < 0.01);
  const removedFront = changed(closed.image, muted.image);
  const radiated = changed(moved.image, muted.image);
  assert(removedFront > 850, `Calving changes only ${removedFront} stationary-ice pixels.`);
  assert(radiated > 1500, `The accepted wave changes only ${radiated} pixels with the ice held equal.`);

  exact(await sample(cue + end + 16, { query: true }), moved);
  exact(await sample(cue + checkpoint, { action: 'restore' }), restoring);
  exact(await sample(cue + end, { query: true }), moved);
  exact(await sample(0, { query: true }), start);
  exact(await sample(cue + releaseFrame), first);
  exact(await sample(cue + end, { query: true }), moved);
  assert.deepEqual(await page.evaluate(() => window.glacierCalvingFilm.dispose()), { errors: [], validation: null });
  assert.deepEqual(errors, []);

  if (process.env.MARGO_KEEP_GLACIER_CALVING_FRAMES === '1') {
    const path = 'packages/water/test-results/glacier-calving-film';
    await mkdir(path, { recursive: true });
    for (const [name, shot] of Object.entries({ start, first, restoring, closed, moved, muted }))
      await writeFile(`${path}/${backend}-${name}.png`, shot.png);
  }
  console.log(
    `${backend} glacier calving: ${first.state.output[front].toFixed(3)} m³ transferred, ${(100 * gauge).toFixed(2)} cm gauge rise after 3 s, ` +
      `${removedFront}/${radiated} detached-ice/wave pixels, replay ${moved.state.hash}.`,
  );
} finally {
  await close();
}
