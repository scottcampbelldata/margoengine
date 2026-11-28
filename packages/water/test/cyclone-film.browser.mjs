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
    const difference =
      Math.abs(a.data[i] - b.data[i]) +
      Math.abs(a.data[i + 1] - b.data[i + 1]) +
      Math.abs(a.data[i + 2] - b.data[i + 2]);
    if (difference > 18) count++;
  }
  return count;
}

try {
  const { cue, rate, checkpoint, end, timeScale, verticalScale, stormTrack, probes } = await page.evaluate(async () => {
    const { mountCycloneFilm } = await import('/packages/water/test/cyclone-film.fixture.js');
    window.cycloneFilm = await mountCycloneFilm();
    const { cue, rate, checkpoint, end, timeScale, verticalScale, stormTrack, probes } = window.cycloneFilm;
    return { cue, rate, checkpoint, end, timeScale, verticalScale, stormTrack, probes };
  });
  let initialVolume;
  async function sample(editFrame, options = {}) {
    const { image, ...state } = await page.evaluate((input) => window.cycloneFilm.sample(input), {
      editFrame,
      ...options,
    });
    const png = Buffer.from(image, 'base64');
    initialVolume ??= state.volume;
    const relativeRoundoff = 128 * Number.EPSILON * initialVolume;
    assert(Math.abs(state.volume + state.budget.out - initialVolume) <= relativeRoundoff);
    assert.equal(state.budget.inflow + state.budget.rain, 0);

    if (state.frame > 0) {
      // Independent closed form from Holland (1980), Eq. (1), with a physical-time translating centre.
      // https://impacts.ucar.edu/en/publications/an-analytic-model-of-the-wind-and-pressure-profiles-in-hurricanes/
      const seconds = (state.frame * timeScale) / rate;
      const [cx, cz] = stormTrack.center.map((v, i) => v + seconds * stormTrack.translation[i]);
      for (const [i, [x, , z]] of probes.entries()) {
        const distance = Math.hypot(x - cx, z - cz);
        const exponent = -((stormTrack.radius / distance) ** stormTrack.shape);
        const expected = stormTrack.ambientPressure + stormTrack.pressureDrop * Math.expm1(exponent);
        const tolerance = 128 * Number.EPSILON * stormTrack.ambientPressure;
        assert(
          Math.abs(state.air[i][5] - expected) < tolerance,
          JSON.stringify({ position: [x, z], expected, reported: state.air[i][5] }),
        );
      }
    }
    return { state, png, pixels: await decodePNG(png) };
  }
  function exact(a, b) {
    assert.deepEqual(a.state, b.state);
    assert.deepEqual(a.pixels.data, b.pixels.data);
  }

  const opening = await sample(0);
  exact(await sample(cue - 1), opening);
  const quietOpening = await sample(0, { mode: 'unforced' });
  assert.deepEqual(quietOpening.state.levels, opening.state.levels);
  assert.deepEqual(quietOpening.pixels.data, opening.pixels.data);
  const approach = await sample(cue + checkpoint, { action: 'save' });
  const pressure = await sample(cue + end, { mode: 'pressure' });
  const calm = await sample(cue + end, { mode: 'unforced' });
  const storm = await sample(cue + end, { query: true });

  const [shallows, marsh, inland, headland] = storm.state.levels;
  const headPressure = pressure.state.levels[0].surface - calm.state.levels[0].surface;
  const windSetup = shallows.surface - pressure.state.levels[0].surface;
  assert(headPressure > 0.3 && windSetup > 1, JSON.stringify({ headPressure, windSetup }));
  assert.deepEqual(storm.state.air, pressure.state.air);
  assert.deepEqual(pressure.state.air, calm.state.air);
  assert(storm.state.air[0][0] > 40 && storm.state.air[0][5] < 97000);
  assert(approach.state.air[0][5] > storm.state.air[0][5]);
  assert(storm.state.footprint > pressure.state.footprint && pressure.state.footprint >= calm.state.footprint);
  for (const state of [opening, calm, pressure]) assert.equal(state.state.levels[2].depth, 0);
  assert(marsh.depth > 1 && inland.depth > 0.8 && headland.depth > 0.5);
  assert(inland.velocity[0] > 0.5 && inland.depth > approach.state.levels[2].depth);
  assert(
    Number.isFinite(storm.state.waterline) && Math.abs(storm.state.waterline - inland.surface * verticalScale) < 2e-5,
    JSON.stringify({ rendered: storm.state.waterline, accepted: inland.surface * verticalScale }),
  );
  const pressurePixels = changed(calm.pixels, pressure.pixels);
  const windPixels = changed(pressure.pixels, storm.pixels);
  assert(pressurePixels > 350 && windPixels > 1800, JSON.stringify({ pressurePixels, windPixels }));

  exact(await sample(cue + end + 20, { query: true }), storm);
  exact(await sample(cue + checkpoint, { action: 'restore' }), approach);
  exact(await sample(cue + end, { query: true }), storm);
  exact(await sample(0), opening);
  exact(await sample(cue + end, { query: true }), storm);
  assert.deepEqual(await page.evaluate(() => window.cycloneFilm.dispose()), { errors: [], validation: null });
  assert.deepEqual(errors, []);

  if (process.env.MARGO_KEEP_CYCLONE_FRAMES === '1') {
    const path = 'packages/water/test-results/cyclone-film';
    await mkdir(path, { recursive: true });
    for (const [name, frame] of Object.entries({ opening, approach, calm, pressure, storm }))
      await writeFile(`${path}/${backend}-${name}.png`, frame.png);
  }
  console.log(
    `${backend} cyclone: ${headPressure.toFixed(3)} m pressure rise, ${windSetup.toFixed(3)} m additional wind setup, ` +
      `${inland.depth.toFixed(3)} m inland depth and ${inland.velocity[0].toFixed(3)} m/s landward flow, ` +
      `${pressurePixels}/${windPixels} changed pixels, replay ${storm.state.hash}.`,
  );
} finally {
  await close();
}
