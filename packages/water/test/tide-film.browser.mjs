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
  const halves = [0, 0];
  for (let i = 0; i < a.data.length; i += 4) {
    const diff =
      Math.abs(a.data[i] - b.data[i]) +
      Math.abs(a.data[i + 1] - b.data[i + 1]) +
      Math.abs(a.data[i + 2] - b.data[i + 2]);
    if (diff > 15) halves[(i / 4) % a.width < a.width / 2 ? 0 : 1]++;
  }
  return halves;
}

try {
  const { cue, lunarFrame, westernFrame, turningFrame, easternFrame } = await page.evaluate(async () => {
    const { setupTideFilm } = await import('/packages/water/test/tide-film.fixture.js');
    window.tideFilm = await setupTideFilm();
    const { cue, lunarFrame, westernFrame, turningFrame, easternFrame } = window.tideFilm;
    return { cue, lunarFrame, westernFrame, turningFrame, easternFrame };
  });
  async function sample(editFrame, options = {}) {
    const { image, ...state } = await page.evaluate((input) => window.tideFilm.sample(input), {
      editFrame,
      ...options,
    });
    const png = Buffer.from(image, 'base64');
    const { volume, initialVolume, budget } = state;
    assert.deepEqual(budget, { inflow: 0, rain: 0, out: 0 });
    assert(Math.abs(volume - initialVolume) <= 2e-13 * initialVolume, 'the closed basin holds its original water');
    if (options.mode !== 'off') {
      const { head, expected, bound, sun, moon } = state.astronomy;
      assert(sun.distance > 1.4e11 && sun.distance < 1.6e11 && moon.distance > 3.4e8 && moon.distance < 4.2e8);
      assert(Math.abs(head - expected) <= bound + 2e-6, JSON.stringify({ head, expected, bound }));
    }
    return { state, png, image: await decodePNG(png) };
  }
  function same(a, b) {
    assert.deepEqual(a.state, b.state);
    assert.deepEqual(a.image.data, b.image.data);
  }

  const initial = await sample(0);
  assert.deepEqual(
    initial.state.shores.map((p) => p.surface),
    [0, 0],
  );
  assert.deepEqual(
    initial.state.sill.map((p) => p.depth),
    [0, 0],
  );
  same(await sample(cue - 1), initial);
  const lead = await sample(cue + lunarFrame, { action: 'save' });
  assert(lead.state.astronomy.moon.tide < -0.03);
  assert(Math.abs(lead.state.astronomy.moon.tide) > 7 * Math.abs(lead.state.astronomy.sun.tide));
  assert(lead.state.astronomy.head < -0.035);
  const west = await sample(cue + westernFrame, { query: true });
  const transfer = await sample(cue + turningFrame);
  const east = await sample(cue + easternFrame, { query: true });
  const off = await sample(cue + easternFrame, { mode: 'off', query: true });
  assert.deepEqual(off.state.astronomy.words, east.state.astronomy.words);
  assert.equal(off.state.astronomy.head, 0);
  assert.deepEqual(
    off.state.shores.map((p) => p.surface),
    [0, 0],
  );
  assert.deepEqual(
    off.state.sill.map((p) => p.depth),
    [0, 0],
  );
  assert.equal(off.state.current, 0);
  assert(west.state.shores[0].surface > 0.02 && west.state.shores[1].surface < -0.015);
  assert(west.state.sill[0].depth > 0 && west.state.sill[1].depth === 0);
  assert(east.state.shores[0].surface < -0.04 && east.state.shores[1].surface > 0.04);
  assert(east.state.sill[1].depth > 0);
  assert(
    west.state.current < -0.001 && transfer.state.current > 0.002,
    'water current turns from the west toward the east',
  );
  for (const { state } of [west, east, off])
    for (const point of state.shores) {
      assert(
        point.displayed !== null && Math.abs(point.displayed - point.surface) < 0.001,
        JSON.stringify({ point, message: 'GPU readback in physical metres matches the shore stage' }),
      );
    }
  const westernPixels = changed(west.image, off.image);
  const easternPixels = changed(east.image, off.image);
  assert(
    [...westernPixels, ...easternPixels].every((n) => n > 250),
    JSON.stringify({ westernPixels, easternPixels }),
  );

  same(await sample(cue + easternFrame + 20, { query: true }), east);
  same(await sample(cue + lunarFrame, { action: 'restore' }), lead);
  same(await sample(cue + westernFrame, { query: true }), west);
  same(await sample(cue + easternFrame, { query: true }), east);
  same(await sample(0), initial);
  same(await sample(cue + easternFrame, { query: true }), east);
  assert.deepEqual(await page.evaluate(() => window.tideFilm.dispose()), { errors: [], validation: null });
  assert.deepEqual(errors, []);

  if (process.env.MARGO_KEEP_TIDE_FILM_FRAMES === '1') {
    const path = 'packages/water/test-results/tide-film';
    await mkdir(path, { recursive: true });
    for (const [phase, frame] of Object.entries({ initial, lead, west, transfer, east, off })) {
      await writeFile(`${path}/${backend}-${phase}.png`, frame.png);
    }
  }
  const levels = ({ state }) => state.shores.map(({ surface }) => (surface * 1000).toFixed(2)).join('/');
  console.log(
    `${backend} live tide: west/east stage ${levels(west)} mm at ${west.state.hours} h and ${levels(east)} mm at ${east.state.hours} h, ` +
      `${westernPixels.join('/')} and ${easternPixels.join('/')} changed pixels (west/east halves), ${east.state.hash}.`,
  );
} finally {
  await close();
}
