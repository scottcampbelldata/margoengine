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
  let total = 0;
  for (let i = 0; i < a.length; i += 4) {
    const diff = Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]);
    if (diff > 18) total++;
  }
  return total;
}

function shade({ image, state }, radius = 5) {
  const [x, y] = state.mark.pixel.map(Math.round);
  assert(
    x >= radius && x < image.width - radius && y >= radius && y < image.height - radius,
    'keep the traced sand in frame',
  );
  let total = 0;
  for (let j = y - radius; j <= y + radius; j++) {
    for (let i = x - radius; i <= x + radius; i++) {
      const k = 4 * (j * image.width + i);
      total += 0.2126 * image.data[k] + 0.7152 * image.data[k + 1] + 0.0722 * image.data[k + 2];
    }
  }
  return total / (2 * radius + 1) ** 2;
}

try {
  const { cue, lead, high, end } = await page.evaluate(async () => {
    const { setupSwashFilm } = await import('/packages/water/test/swash-film.fixture.js');
    window.swashFilm = await setupSwashFilm();
    const { cue, lead, high, end } = window.swashFilm;
    return { cue, lead, high, end };
  });
  async function sample(editFrame, options = {}) {
    const { image, ...state } = await page.evaluate((input) => window.swashFilm.sample(input), {
      editFrame,
      ...options,
    });
    const { budget, volume, initialVolume } = state;
    const balance = Math.abs(volume - (initialVolume + budget.inflow + budget.rain - budget.out));
    assert(balance < 2e-8, `the shared offshore boundary accounts for the ${balance} m³ volume residual`);
    const png = Buffer.from(image, 'base64');
    return { state, png, image: await decodePNG(png) };
  }
  function same(actual, expected) {
    assert.deepEqual(actual.state, expected.state);
    assert.deepEqual(actual.image.data, expected.image.data);
  }

  const initial = await sample(0);
  assert.equal(initial.state.mark.depth, 0);
  assert.equal(initial.state.mark.wet, false);
  same(await sample(cue - 1), initial);
  const incoming = await sample(cue + lead, { action: 'save' });
  assert(incoming.state.backwash > 0.1, 'the advancing swash carries water upslope');
  assert(incoming.state.incomingHeight > 0);
  const runUp = await sample(cue + high, { query: true });
  const control = await sample(cue + high, { mode: 'steady', query: true });
  assert(runUp.state.shoreline >= initial.state.shoreline + 6);
  assert(runUp.state.shoreline >= control.state.shoreline + 2);
  assert(runUp.state.mark.depth > 0.01 && control.state.mark.depth === 0);
  assert(runUp.state.waterOnSand > control.state.waterOnSand + 0.08);
  assert(
    Math.abs(runUp.state.mark.drawn - runUp.state.mark.surface) < 0.015,
    JSON.stringify({ mark: runUp.state.mark, message: 'the renderer follows the accepted run-up height' }),
  );
  assert.equal(control.state.mark.drawn, null);
  const washPixels = changed(runUp.image.data, control.image.data);
  assert(washPixels > 1500, `the grouped and steady shorelines changed only ${washPixels} pixels`);

  const receding = await sample(cue + end, { query: true });
  const dryLook = await sample(cue + end, { dryLook: true, query: true });
  assert(receding.state.backwash < -0.3, 'shallow water returns seaward');
  assert(receding.state.shoreline <= runUp.state.shoreline - 2);
  assert(receding.state.waterOnSand < runUp.state.waterOnSand);
  assert(receding.state.runUp >= runUp.state.runUp && receding.state.runUp > control.state.runUp);
  // The physical residue is below Water's existing 3 mm visible sheet threshold.
  assert(receding.state.mark.depth < 0.003 && receding.state.mark.wet);
  assert.equal(receding.state.mark.drawn, null);
  assert(receding.state.trace > initial.state.trace + 2);
  assert.deepEqual(dryLook.state, receding.state);
  const wetPixels = changed(receding.image.data, dryLook.image.data);
  const darkening = shade(dryLook) - shade(receding);
  assert(wetPixels > 600 && darkening > 16, JSON.stringify({ wetPixels, darkening, mark: receding.state.mark }));

  same(await sample(cue + end + 14, { query: true }), receding);
  same(await sample(cue + lead, { action: 'restore' }), incoming);
  same(await sample(cue + high, { query: true }), runUp);
  same(await sample(cue + end, { query: true }), receding);
  same(await sample(0), initial);
  same(await sample(cue + end, { query: true }), receding);
  assert.deepEqual(await page.evaluate(() => window.swashFilm.dispose()), { validation: null, errors: [] });
  assert.deepEqual(errors, []);

  if (process.env.MARGO_KEEP_SWASH_FILM_FRAMES === '1') {
    const path = 'packages/water/test-results/swash-film';
    await mkdir(path, { recursive: true });
    for (const [phase, frame] of Object.entries({ initial, incoming, runUp, control, receding, dryLook }))
      await writeFile(`${path}/${backend}-${phase}.png`, frame.png);
  }
  console.log(
    `${backend} swash: ${initial.state.shoreline}→${runUp.state.shoreline}→${receding.state.shoreline} m shoreline, ` +
      `${receding.state.backwash.toFixed(3)} m/s backwash, ${washPixels} grouped pixels, ` +
      `${wetPixels} wet-sand pixels and ${darkening.toFixed(1)} mark darkening, ${receding.state.hash}.`,
  );
} finally {
  await close();
}
