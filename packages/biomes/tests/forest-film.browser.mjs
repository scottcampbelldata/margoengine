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
    const difference =
      Math.abs(a.data[i] - b.data[i]) +
      Math.abs(a.data[i + 1] - b.data[i + 1]) +
      Math.abs(a.data[i + 2] - b.data[i + 2]);
    if (difference > 18) counts[Number((i / 4) % a.width >= a.width / 2)]++;
  }
  return counts;
}

const closeTo = (actual, expected, scale = 1) =>
  assert(
    Math.abs(actual - expected) <= 256 * Number.EPSILON * Math.max(scale, Math.abs(expected)),
    JSON.stringify({ actual, expected }),
  );

try {
  const setup = await page.evaluate(async () => {
    const { mountForestFilm } = await import('/packages/biomes/tests/forest-film.fixture.js');
    const take = await mountForestFilm();
    window.forestFilm = take;
    const { sample, dispose, ...parameters } = take;
    return parameters;
  });
  const {
    cue,
    yearTicks,
    windStop,
    windYears,
    end,
    halfCount,
    seed,
    cell,
    groupOffset,
    windSpeed,
    windReferenceSpeed,
    maxGrowthLean,
    surfaceArea,
    rootCohesion,
    canopyFuel,
  } = setup;
  const equilibrium = (maxGrowthLean * windSpeed ** 2) / (windReferenceSpeed ** 2 + windSpeed ** 2);
  async function sample(editFrame, options = {}) {
    const { image, ...state } = await page.evaluate((input) => window.forestFilm.sample(input), {
      editFrame,
      ...options,
    });
    const png = Buffer.from(image, 'base64');
    const { trees, ports, winds, annual, frame } = state;
    assert.deepEqual(winds, [
      [frame < windStop ? windSpeed : 0, 0, 0],
      [0, 0, 0],
    ]);
    assert.deepEqual(annual, {
      year: Math.floor(frame / yearTicks),
      alive: 2 * halfCount,
      born: 0,
      died: 0,
      crowded: 0,
    });
    for (const port of ports) assert.deepEqual(port.cell, cell);
    for (let i = 0; i < halfCount; i++) {
      const exposed = trees[i];
      const sheltered = trees[i + halfCount];
      assert.equal(exposed.age, sheltered.age);
      assert.equal(exposed.radius, sheltered.radius);
      closeTo(sheltered.x - exposed.x, groupOffset);
      assert.equal(exposed.z, sheltered.z);
      assert.deepEqual(sheltered.lean, [0, 0]);
      assert.deepEqual(sheltered.axis, [0, 1, 0]);
      closeTo(exposed.crownRadius, exposed.radius);
      closeTo(sheltered.crownRadius, sheltered.radius);
      closeTo(exposed.axis[0], exposed.lean[0] * exposed.axis[1]);
      closeTo(exposed.axis[2], exposed.lean[1] * exposed.axis[1]);
      closeTo(Math.hypot(...exposed.axis), 1);
    }
    for (let plot = 0; plot < 2; plot++) {
      const crowns = trees.slice(plot * halfCount, (plot + 1) * halfCount);
      const area = (Math.PI * crowns.reduce((sum, tree) => sum + tree.radius ** 2, 0)) / surfaceArea;
      closeTo(ports[0].data[plot], area);
      closeTo(ports[1].data[plot], rootCohesion * area);
      closeTo(ports[2].data[plot], canopyFuel * area);
    }
    return { state, png, pixels: await decodePNG(png) };
  }

  function exact(a, b) {
    assert.deepEqual(a.state, b.state);
    assert.deepEqual(a.pixels.data, b.pixels.data);
  }

  const held = await sample(0);
  exact(await sample(cue), held);
  const developing = await sample(cue + Math.floor(yearTicks / 2), { action: 'save' });
  assert.deepEqual(developing.pixels.data, held.pixels.data);
  assert.notEqual(developing.state.hash, held.state.hash);
  const firstYear = await sample(cue + yearTicks);
  const windOff = await sample(cue + windStop, { action: 'save' });
  assert.equal(windOff.state.annual.year, windYears);
  const coast = await sample(cue + windStop + Math.floor(yearTicks / 2));
  assert.deepEqual(coast.pixels.data, windOff.pixels.data);
  assert.deepEqual(coast.state.trees, windOff.state.trees);
  const calm = await sample(cue + end);
  const upright = await sample(cue + end, { renderUpright: true });
  assert.deepEqual(calm.state, upright.state);
  const leaningPixels = changed(calm.pixels, upright.pixels);
  assert(leaningPixels[0] > 2500 && leaningPixels[1] < leaningPixels[0] / 6, JSON.stringify({ leaningPixels }));
  for (let i = 0; i < halfCount; i++) {
    const initial = held.state.trees[i];
    const radius0 = initial.radius;
    const grown = firstYear.state.trees[i];
    const atStop = windOff.state.trees[i];
    const after = calm.state.trees[i];
    // Same load over three full years telescopes the retained projected-area weights. A calm year's
    // additional upright area dilutes the previous grown tilt while preserving its direction.
    closeTo(grown.lean[0], (1 - (radius0 / grown.radius) ** 2) * equilibrium);
    closeTo(atStop.lean[0], (1 - (radius0 / atStop.radius) ** 2) * equilibrium);
    closeTo(after.lean[0], atStop.lean[0] * (atStop.radius / after.radius) ** 2);
    assert.equal(after.age, initial.age + windYears + 1);
    assert(after.radius > atStop.radius && atStop.radius > grown.radius && grown.radius > radius0);
    assert(after.height > initial.height);
    assert(after.lean[0] > 0.18 && after.lean[0] < atStop.lean[0]);
    assert(after.tip[0] > 1.25 && after.tip[0] < 2.25);
  }

  exact(await sample(cue + end + 36), calm);
  exact(await sample(cue + windStop, { action: 'restore' }), windOff);
  exact(await sample(cue + end), calm);
  exact(await sample(cue + developing.state.frame, { action: 'restore' }), developing);
  exact(await sample(cue + yearTicks), firstYear);
  exact(await sample(cue + end), calm);
  exact(await sample(0), held);
  exact(await sample(cue + end), calm);
  assert.deepEqual(await page.evaluate(() => window.forestFilm.dispose()), { errors: [], validation: null });
  assert.deepEqual(errors, []);

  if (process.env.MARGO_KEEP_FOREST_FILM_FRAMES === '1') {
    const path = 'packages/biomes/test-results/forest-film';
    await mkdir(path, { recursive: true });
    for (const [name, shot] of Object.entries({ held, firstYear, windOff, calm, upright }))
      await writeFile(`${path}/${backend}-${name}.png`, shot.png);
  }
  const offsets = calm.state.trees.slice(0, halfCount).map(({ tip }) => tip[0].toFixed(3));
  const angles = calm.state.trees
    .slice(0, halfCount)
    .map(({ lean }) => ((Math.atan(lean[0]) * 180) / Math.PI).toFixed(2));
  console.log(
    `${backend} forest growth: ${angles.join('/')}° lean and ${offsets.join('/')} m tip offsets after a calm year, ` +
      `${leaningPixels.join('/')} exposed/control pixels, seed ${seed}, replay ${calm.state.hash}.`,
  );
} finally {
  await close();
}
