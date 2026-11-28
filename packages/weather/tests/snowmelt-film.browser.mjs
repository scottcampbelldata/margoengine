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
    const distance =
      Math.abs(a.data[i] - b.data[i]) +
      Math.abs(a.data[i + 1] - b.data[i + 1]) +
      Math.abs(a.data[i + 2] - b.data[i + 2]);
    if (distance > 18) count++;
  }
  return count;
}

try {
  const { cue, checkpoint, end, inheritedMass, waterDensity } = await page.evaluate(async () => {
    const { mountSnowmeltFilm } = await import('/packages/weather/tests/fixtures/snowmelt-film.js');
    window.snowmeltFilm = await mountSnowmeltFilm();
    const { cue, checkpoint, end, inheritedMass, waterDensity } = window.snowmeltFilm;
    return { cue, checkpoint, end, inheritedMass, waterDensity };
  });
  async function sample(editFrame, options = {}) {
    const { image, ...state } = await page.evaluate((input) => window.snowmeltFilm.sample(input), {
      editFrame,
      ...options,
    });
    const png = Buffer.from(image, 'base64');
    const { mass, water, budget } = state;
    const roundoff = 1024 * Number.EPSILON * inheritedMass;
    assert(
      Math.abs(mass + water * waterDensity - inheritedMass) <= roundoff,
      JSON.stringify({ mass, water, inheritedMass, roundoff }),
    );
    assert(Math.abs(water - budget.inflow) <= roundoff / waterDensity);
    assert.equal(budget.out, 0);
    assert.equal(budget.rain, 0);
    return { state, png, image: await decodePNG(png) };
  }
  function exact(a, b) {
    assert.deepEqual(a.state, b.state);
    assert.deepEqual(a.image.data, b.image.data);
  }

  const white = await sample(0);
  assert(white.state.area > 200 && white.state.depths > 0);
  assert.equal(white.state.water, 0);
  assert.equal(white.state.runoff, 0);
  exact(await sample(cue - 1), white);
  const warm = await sample(cue + checkpoint, { action: 'save' });
  assert(warm.state.mass < white.state.mass && warm.state.mass > 0);
  assert(warm.state.area < white.state.area && warm.state.depths < white.state.depths);
  assert(warm.state.water > 0 && warm.state.runoff > 0 && warm.state.heat > 200);
  const shade = await sample(cue + end, { mode: 'shade' });
  const thaw = await sample(cue + end, { query: true });
  const snowOnly = await sample(cue + end, { mode: 'snow-only' });
  const { state } = thaw;
  assert.equal(shade.state.mass, white.state.mass);
  assert.equal(shade.state.water, 0);
  assert.equal(shade.state.runoff, 0);
  assert.equal(shade.state.area, white.state.area);
  assert.equal(state.hash, snowOnly.state.hash);
  assert.equal(state.area, snowOnly.state.area);
  assert(state.mass < warm.state.mass && state.area < warm.state.area && state.water > warm.state.water);
  assert.equal(state.simulatedHours, (4 * end) / 60);
  const [outlet, pond, down, high] = state.surveys;
  assert(outlet.depth > 0 && pond.depth > 0.01 && down.depth > 0 && high.depth === 0, JSON.stringify(state.surveys));
  assert(
    state.pondElevation !== null && Math.abs(state.pondElevation - pond.surface) < 2e-5,
    JSON.stringify({ pond, rendered: state.pondElevation }),
  );
  const snowPixels = changed(shade.image, snowOnly.image);
  const waterPixels = changed(thaw.image, snowOnly.image);
  assert(snowPixels > 1800, `Accepted snow retreat changed only ${snowPixels} pixels.`);
  assert(waterPixels > 300, `Accepted routed meltwater changed only ${waterPixels} pixels.`);
  exact(await sample(cue + end + 12, { query: true }), thaw);
  exact(await sample(cue + checkpoint, { action: 'restore' }), warm);
  exact(await sample(cue + end, { query: true }), thaw);
  exact(await sample(0), white);
  exact(await sample(cue + end, { query: true }), thaw);
  assert.deepEqual(await page.evaluate(() => window.snowmeltFilm.dispose()), { errors: [], validation: null });
  assert.deepEqual(errors, []);

  if (process.env.MARGO_KEEP_SNOWMELT_FRAMES === '1') {
    const path = 'packages/weather/test-results/snowmelt-film';
    await mkdir(path, { recursive: true });
    for (const [name, value] of Object.entries({ white, warm, shade, thaw, snowOnly }))
      await writeFile(`${path}/${backend}-${name}.png`, value.png);
  }
  console.log(
    `${backend} snowmelt: ${white.state.area} → ${state.area} m² of snow after ${state.simulatedHours.toFixed(2)} simulated hours, ` +
      `${state.water.toFixed(3)} m³ verified pond water, ${(100 * pond.depth).toFixed(2)} cm at gauge, ` +
      `${snowPixels}/${waterPixels} snow/pond pixels, replay ${state.hash}.`,
  );
} finally {
  await close();
}
