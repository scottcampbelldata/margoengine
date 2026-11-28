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

function near(actual, reference, tolerance) {
  assert(Math.abs(actual - reference) <= tolerance, JSON.stringify({ actual, reference, tolerance }));
}

function project([x, y, z], m, pixels) {
  const w = m[3] * x + m[7] * y + m[11] * z + m[15];
  return [
    (0.5 + (0.5 * (m[0] * x + m[4] * y + m[8] * z + m[12])) / w) * pixels.width,
    (0.5 - (0.5 * (m[1] * x + m[5] * y + m[9] * z + m[13])) / w) * pixels.height,
  ];
}

function changed(a, b, places) {
  const visited = new Set();
  for (const [cx, cy] of places) {
    for (let y = Math.max(0, Math.floor(cy) - 12); y <= Math.min(a.height - 1, Math.floor(cy) + 12); y++)
      for (let x = Math.max(0, Math.floor(cx) - 12); x <= Math.min(a.width - 1, Math.floor(cx) + 12); x++) {
        const i = 4 * (x + y * a.width);
        if (
          Math.abs(a.data[i] - b.data[i]) +
            Math.abs(a.data[i + 1] - b.data[i + 1]) +
            Math.abs(a.data[i + 2] - b.data[i + 2]) >
          22
        )
          visited.add(i);
      }
  }
  return visited.size;
}

function centroid(cells, value) {
  const total = cells.reduce((sum, c) => sum + value(c), 0);
  return cells.reduce((sum, c) => sum + c.x * value(c), 0) / total;
}

try {
  const { cue, first, ridge, end, meteorStep, dx, east, backgroundMoisture, lapse, cell, nx, nz } = await page.evaluate(
    async () => {
      const { mountSynopticFilm } = await import('/packages/physics/tests/synoptic-film.fixture.js');
      const film = await mountSynopticFilm();
      window.synopticFilm = film;
      const { sample, scan, dispose, ...settings } = film;
      return settings;
    },
  );

  async function get(editFrame, action, hideRunoff = false) {
    const { states, ...camera } = await page.evaluate((input) => window.synopticFilm.sample(input), {
      editFrame,
      action,
      hideRunoff,
    });
    const shots = await Promise.all(
      states.map(async ({ image, ...state }) => {
        assert.deepEqual(state.ports, [cell, cell]);
        assert.equal(state.cells.length, nx * nz);
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
  assert(
    before.shots.every(
      ({ state }) => state.runoff.rain === 0 && state.cells.every(({ rain, depth }) => rain === 0 && depth === 0),
    ),
  );
  const moved = await get(cue + first, 'save');
  const passage = await get(cue + ridge, 'save');
  const after = await get(cue + end);
  assert.deepEqual(before.matrix, after.matrix);
  const [mountain, control] = passage.shots;
  assert(mountain.state.cells.some(({ lift }) => lift > 0));
  assert(mountain.state.cells.some(({ lift }) => lift < 0));
  assert(control.state.cells.every(({ lift }) => lift === 0));
  const peak = mountain.state.cells.reduce((best, c) => (c.precipitation > best.precipitation ? c : best));
  assert(peak.rain > peak.snow && mountain.state.cold.snow > mountain.state.cold.rain);
  assert(mountain.state.runoff.rain > control.state.runoff.rain);
  assert(mountain.state.runoff.outflow > 0);
  const strongest = mountain.state.cells.filter(
    (c, i) => c.precipitation > control.state.cells[i].precipitation && c.rain > 0.25,
  );
  assert(strongest.length > 0);
  const mapped = strongest.map(({ x, z, elevation }) =>
    project([x / dx, (14 * elevation) / dx, z / dx], passage.matrix, mountain.pixels),
  );
  const wetPixels = changed(mountain.pixels, before.shots[0].pixels, mapped);
  const upliftPixels = changed(mountain.pixels, control.pixels, mapped);
  assert(wetPixels > 300 && upliftPixels > 300, JSON.stringify({ wetPixels, upliftPixels }));
  const [draining] = after.shots;
  const {
    shots: [noRunoff],
  } = await get(cue + end, undefined, true);
  assert.deepEqual(noRunoff.state, draining.state);
  const storagePixels = draining.state.cells
    .filter(({ depth }) => depth > 0.001)
    .map(({ x, z, elevation }) => project([x / dx, (14 * elevation) / dx, z / dx], after.matrix, draining.pixels));
  assert(storagePixels.length > 0);
  const runoffPixels = changed(draining.pixels, noRunoff.pixels, storagePixels);
  assert(runoffPixels > 300, JSON.stringify({ runoffPixels }));

  const history = await page.evaluate(() => window.synopticFilm.scan());
  for (const historyForTake of history) {
    let rain = 0,
      snow = 0;
    for (const [frame, { cells, weather, runoff }] of historyForTake.entries()) {
      // Discrete column conservation and the independent unit/clock check. Integrate accepted per-column
      // kg m⁻² s⁻¹ over 180 physical seconds and dx², then divide by 1000 kg m⁻³ in the drainage volume.
      // The liquid/snow split uses the independently evaluated warm-ground logistic from the authored T.
      const roundoff = (64 + 16 * (frame + 1) * cells.length) * Number.EPSILON;
      const storage = cells.reduce((sum, c) => sum + c.depth * dx * dx, 0);
      if (frame > 0)
        for (const c of cells) {
          const water = (c.precipitation * meteorStep * dx * dx) / 1000;
          const liquid = 1 / (1 + Math.exp(-1.4 * (c.air - lapse * c.elevation - 274.15)));
          rain += water * liquid;
          snow += water * (1 - liquid);
        }
      near(weather.airborne + weather.precipitation, weather.initial + weather.evaporation, roundoff * weather.initial);
      near(weather.precipitation / 1000, rain + snow, roundoff * Math.max(1, rain + snow));
      near(runoff.rain, rain, roundoff * Math.max(1, rain));
      near(storage + runoff.outflow, rain, roundoff * Math.max(1, rain));
    }
  }
  // Smith & Barstad (2004), https://journals.ametsoc.org/doi/full/10.1175/1520-0469%282004%29061%3C1377%3AALTOOP%3E2.0.CO%3B2
  // explains the terrain-induced lift/downslope evaporation in the matched comparison. For the flat response,
  // constant wind translates total excess airborne water by UΔt. Resolve the centre to the 16 km grid.
  const moisture = (c) => c.vapour - backgroundMoisture + c.cloud + c.drops;
  const x0 = centroid(before.shots[1].state.cells, moisture);
  const x1 = centroid(after.shots[1].state.cells, moisture);
  near(x1 - x0, east * meteorStep * end, dx);
  const rainfall = (c) => c.precipitation;
  const translation = centroid(after.shots[0].state.cells, rainfall) - centroid(moved.shots[0].state.cells, rainfall);
  assert(translation > 2 * dx);

  exact(await get(cue + end + 30), after);
  exact(await get(cue + ridge, 'restore'), passage);
  exact(await get(cue + end), after);
  exact(await get(cue + first, 'restore'), moved);
  exact(await get(cue + ridge), passage);
  exact(await get(cue + end), after);
  exact(await get(0), before);
  exact(await get(cue + end), after);
  assert.deepEqual(await page.evaluate(() => window.synopticFilm.dispose()), { errors: [], validation: null });
  assert.deepEqual(errors, []);

  if (process.env.MARGO_KEEP_SYNOPTIC_FILM_FRAMES === '1') {
    const dir = 'packages/physics/test-results/synoptic-film';
    await mkdir(dir, { recursive: true });
    for (const [name, frame] of Object.entries({ before, moved, passage, after })) {
      await writeFile(`${dir}/${backend}-${name}-terrain.png`, frame.shots[0].png);
      if (name === 'passage') await writeFile(`${dir}/${backend}-${name}-control.png`, frame.shots[1].png);
    }
  }
  const [activeEnd, flatEnd] = after.shots;
  console.log(
    `${backend} synoptic: ${(translation / 1000).toFixed(1)} km rain-band motion, ${(1000 * peak.precipitation * 3.6).toFixed(3)} mm/h ridge peak, ` +
      `${[activeEnd, flatEnd].map(({ state }) => (state.runoff.rain / 1e6).toFixed(3)).join('/')} million m³ accepted liquid rain, ` +
      `${upliftPixels} uplift and ${runoffPixels} runoff pixels, exact replay ${after.shots.map(({ state }) => state.hash).join('/')}.`,
  );
} finally {
  await close();
}
