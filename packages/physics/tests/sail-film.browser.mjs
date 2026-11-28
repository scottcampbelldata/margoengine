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

function project([x, y, z], m, image) {
  const w = m[3] * x + m[7] * y + m[11] * z + m[15];
  return [
    (0.5 + (0.5 * (m[0] * x + m[4] * y + m[8] * z + m[12])) / w) * image.width,
    (0.5 - (0.5 * (m[1] * x + m[5] * y + m[9] * z + m[13])) / w) * image.height,
  ];
}

function changed(a, b, places, radius) {
  const pixels = new Set();
  for (const [cx, cy] of places) {
    for (let y = Math.max(0, Math.floor(cy) - radius); y <= Math.min(a.height - 1, Math.floor(cy) + radius); y++) {
      for (let x = Math.max(0, Math.floor(cx) - radius); x <= Math.min(a.width - 1, Math.floor(cx) + radius); x++) {
        const i = 4 * (x + y * a.width);
        if (
          Math.abs(a.data[i] - b.data[i]) +
            Math.abs(a.data[i + 1] - b.data[i + 1]) +
            Math.abs(a.data[i + 2] - b.data[i + 2]) >
          18
        )
          pixels.add(i);
      }
    }
  }
  return pixels.size;
}

try {
  const { cue, beforeWind, filled, running, end, cell, windCell, checks } = await page.evaluate(async () => {
    const { mountSailFilm } = await import('/packages/physics/tests/sail-film.fixture.js');
    const film = await mountSailFilm();
    window.sailFilm = film;
    const { sample, dispose, ...settings } = film;
    return settings;
  });
  assert.deepEqual(windCell, [cell[0] - 1, cell[1], cell[2]]);
  const mismatch = Math.hypot(...checks.momentum.map((value, i) => value - checks.impulse[i]));
  const magnitude = Math.hypot(...checks.impulse);
  assert(checks.hull > 0.9 * checks.momentum[0] && magnitude > 0);
  // Independent Newton impulse balance for the actual lashed cloth and rigid body, with all external
  // forces except accepted f64 sail impulse suppressed in the short companion take. The conservative
  // f32 accumulation allowance is 128 rounded operations per 60 Hz step in the momentum readout.
  assert(mismatch <= 128 * checks.frames * 2 ** -24 * magnitude, JSON.stringify({ mismatch, ...checks }));

  async function get(editFrame, action, hideCloth = false) {
    const { states, ...camera } = await page.evaluate((input) => window.sailFilm.sample(input), {
      editFrame,
      action,
      hideCloth,
    });
    const shots = await Promise.all(
      states.map(async ({ image, ...state }) => {
        assert.deepEqual(state.cell, cell);
        assert(state.points.length === 7 * 9 * 3 && state.points.every(Number.isFinite));
        assert(state.loads.length > 4 + 6 * 8 && state.loads.every(Number.isFinite));
        assert(
          state.tieError < 0.0285,
          'A real tied point must stay within the radius of the 57 mm mast yard or boom.',
        );
        const png = Buffer.from(image, 'base64');
        return { state, png, pixels: await decodePNG(png) };
      }),
    );
    return { ...camera, shots };
  }

  function exact(a, b) {
    assert.equal(a.frame, b.frame);
    assert.deepEqual(a.matrix, b.matrix);
    for (const [i, { state, pixels }] of a.shots.entries()) {
      assert.deepEqual(state, b.shots[i].state);
      assert.deepEqual(pixels.data, b.shots[i].pixels.data);
    }
  }

  const before = await get(0);
  exact(await get(cue), before);
  const quiet = await get(cue + beforeWind, 'save');
  assert.deepEqual(quiet.shots[0].state, quiet.shots[1].state);
  const full = await get(cue + filled, 'save');
  const [active, calm] = full.shots;
  const gustForce = active.state.loads.slice(1, 4),
    calmForce = calm.state.loads.slice(1, 4);
  assert(gustForce[0] > 0 && gustForce[0] > 20 * Math.hypot(...calmForce));
  assert(active.state.camber > calm.state.camber + 0.08);
  assert(active.state.velocity[0] > calm.state.velocity[0]);
  assert(active.state.waterForce[0] < 0);
  const empty = await get(cue + filled, undefined, true);
  const marks = full.shots.map(({ state, pixels }) =>
    [state.belly, state.head, state.boom].map((point) => project(point, full.matrix, pixels)),
  );
  const sailOnly = changed(active.pixels, empty.shots[0].pixels, marks[0], 18);
  assert.deepEqual(active.state, empty.shots[0].state);
  assert(sailOnly > 200);
  const doNotMatch = changed(active.pixels, calm.pixels, marks.flat(), 24);
  assert(doNotMatch > 80, JSON.stringify({ sailOnly, doNotMatch, marks }));

  const past = await get(cue + running);
  const terminal = await get(cue + end);
  const motion = terminal.shots[0].state.position[0] - terminal.shots[1].state.position[0];
  assert(motion > 0.3);
  assert(past.shots[0].state.velocity[0] > 0 && Math.abs(past.shots[0].state.loads[1]) < gustForce[0] / 5);
  const hullPixels = changed(
    terminal.shots[0].pixels,
    terminal.shots[1].pixels,
    terminal.shots.map(({ state, pixels }) => project(state.position, terminal.matrix, pixels)),
    28,
  );
  assert(hullPixels > 160);

  exact(await get(cue + end + 45), terminal);
  exact(await get(cue + filled, 'restore'), full);
  exact(await get(cue + running), past);
  exact(await get(cue + end), terminal);
  exact(await get(cue + beforeWind, 'restore'), quiet);
  exact(await get(cue + filled), full);
  exact(await get(cue + end), terminal);
  exact(await get(0), before);
  exact(await get(cue + end), terminal);
  assert.deepEqual(await page.evaluate(() => window.sailFilm.dispose()), { errors: [], validation: null });
  assert.deepEqual(errors, []);

  if (process.env.MARGO_KEEP_SAIL_FILM_FRAMES === '1') {
    const dir = 'packages/physics/test-results/sail-film';
    await mkdir(dir, { recursive: true });
    for (const [name, frame] of Object.entries({ before, full, past, terminal })) {
      await writeFile(`${dir}/${backend}-${name}-gust.png`, frame.shots[0].png);
      if (name === 'full') await writeFile(`${dir}/${backend}-${name}-calm.png`, frame.shots[1].png);
    }
  }
  console.log(
    `${backend} sail: ${gustForce[0].toFixed(2)} N thrust, ${(100 * (active.state.camber - calm.state.camber)).toFixed(2)} cm billow, ${motion.toFixed(3)} m more hull advance, ` +
      `${magnitude.toFixed(3)} N s impulse with ${mismatch.toExponential(2)} N s residual, ${sailOnly}/${hullPixels} cloth/hull pixels, ` +
      `exact replay ${terminal.shots.map(({ state }) => state.hash).join('/')}.`,
  );
} finally {
  await close();
}
