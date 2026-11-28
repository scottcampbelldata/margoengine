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
    const dist =
      Math.abs(a.data[i] - b.data[i]) +
      Math.abs(a.data[i + 1] - b.data[i + 1]) +
      Math.abs(a.data[i + 2] - b.data[i + 2]);
    if (dist > 18) counts[Number((i / 4) % a.width >= a.width / 2)]++;
  }
  return counts;
}

try {
  const setup = await page.evaluate(async () => {
    const { mountGrowthFilm } = await import('/packages/biomes/tests/growth-film.fixture.js');
    const take = await mountGrowthFilm();
    window.growthFilm = take;
    const { sample, dispose, ...parameters } = take;
    return parameters;
  });
  const {
    cue,
    before,
    seasonTime,
    checkpoint,
    end,
    seed,
    cell,
    area,
    capacity,
    saturation,
    irrigation,
    wilting,
    full,
    species,
  } = setup;
  const baseline = capacity * saturation;
  const initialVolume = (2 * baseline + irrigation) * area;
  async function sample(editFrame, options = {}) {
    const { image, ...state } = await page.evaluate((input) => window.growthFilm.sample(input), {
      editFrame,
      ...options,
    });
    const png = Buffer.from(image, 'base64');
    const [wet, control] = state.soils;
    const storedVolume = (wet.depth + wet.soilWater + control.depth + control.soilWater) * area;
    assert.equal(control.soilWater, baseline);
    assert.equal(control.depth + control.outflow, 0);
    assert.deepEqual(state.publishedWater, [wet.soilWater, control.soilWater]);
    assert.deepEqual(state.branchCell, cell);
    assert.deepEqual(state.soilCell, cell);
    assert.equal(state.season, Math.floor(state.frame / seasonTime));
    assert.equal(
      state.budget.rain +
        state.budget.melt +
        state.budget.condensation +
        state.budget.evaporation +
        state.budget.recharge,
      0,
    );
    const error = Math.abs(initialVolume - storedVolume - state.budget.outflow);
    assert(error < (100 + 10 * state.frame) * Number.EPSILON * initialVolume, `water ledger closure ${error} m³`);
    const count = state.scion[0].count + state.scion[1].count;
    assert.deepEqual(state.head, [count + 2, state.season]);
    assert.equal(state.triangles, 16 * count);
    return { state, png, pixels: await decodePNG(png) };
  }

  function exact(a, b) {
    assert.deepEqual(a.state, b.state);
    assert.deepEqual(a.pixels.data, b.pixels.data);
  }

  const held = await sample(0);
  exact(await sample(cue), held);
  assert.equal(held.state.soils[0].depth, irrigation);
  assert.equal(held.state.soils[0].soilWater, baseline);
  const wetting = await sample(cue + before, { action: 'save' });
  const wetSoil = wetting.state.soils[0];
  assert.equal(wetting.state.triangles, 0);
  assert(wetSoil.depth > 0 && wetSoil.depth < irrigation);
  assert(wetSoil.soilWater > baseline && wetSoil.soilWater < capacity);
  const firstShoots = await sample(cue + seasonTime);
  assert.deepEqual(
    firstShoots.state.scion.map((row) => row.count),
    [1, 1],
  );
  // A first vertical internode has every growth resource from the seed and no foliage shade.
  const expectedDry = ((baseline - wilting) / (full - wilting)) * species.seasonalExtension;
  assert(Math.abs(firstShoots.state.scion[1].height - expectedDry) < 64 * Number.EPSILON);
  assert(firstShoots.state.scion[0].height > firstShoots.state.scion[1].height);
  const mid = await sample(cue + checkpoint, { action: 'save' });
  const after = await sample(cue + end);
  const crownless = await sample(cue + end, { showGrowth: false });
  const neutral = await sample(cue + end, { showGrowth: false, showWater: false });
  const [irrigated, control] = after.state.scion;
  assert.equal(after.state.soils[0].soilWater, capacity);
  assert(after.state.budget.outflow > 0);
  assert(irrigated.count > 2 * control.count && control.count >= 8);
  assert(irrigated.height > 2 * control.height && control.height > 0.25);
  assert(irrigated.length > 3 * control.length);
  assert.deepEqual(after.state, crownless.state);
  assert.deepEqual(after.state, neutral.state);
  const crowns = changed(after.pixels, crownless.pixels);
  const soilChange = changed(crownless.pixels, neutral.pixels);
  assert(crowns[0] > 1500 && crowns[1] > 300 && crowns[0] > 2 * crowns[1], JSON.stringify({ crowns }));
  assert(soilChange[0] > 600 && soilChange[1] === 0, JSON.stringify({ soilChange }));

  exact(await sample(cue + end + 36), after);
  exact(await sample(cue + checkpoint, { action: 'restore' }), mid);
  exact(await sample(cue + end), after);
  exact(await sample(cue + before, { action: 'restore' }), wetting);
  exact(await sample(cue + seasonTime), firstShoots);
  exact(await sample(cue + end), after);
  exact(await sample(0), held);
  exact(await sample(cue + end), after);
  assert.deepEqual(await page.evaluate(() => window.growthFilm.dispose()), { errors: [], validation: null });
  assert.deepEqual(errors, []);

  if (process.env.MARGO_KEEP_GROWTH_FILM_FRAMES === '1') {
    const path = 'packages/biomes/test-results/growth-film';
    await mkdir(path, { recursive: true });
    for (const [name, shot] of Object.entries({ held, wetting, firstShoots, mid, after, crownless }))
      await writeFile(`${path}/${backend}-${name}.png`, shot.png);
  }
  console.log(
    `${backend} plant growth: ${irrigated.count}/${control.count} internodes, ` +
      `${irrigated.height.toFixed(3)}/${control.height.toFixed(3)} m crowns, ${(1000 * capacity).toFixed(2)}/${(1000 * baseline).toFixed(2)} mm root water, ` +
      `${crowns.join('/')} canopy pixels, ${soilChange[0]} wet-soil pixels, seed ${seed}, replay ${after.state.hash}.`,
  );
} finally {
  await close();
}
