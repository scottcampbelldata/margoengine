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
    const d =
      Math.abs(a.data[i] - b.data[i]) +
      Math.abs(a.data[i + 1] - b.data[i + 1]) +
      Math.abs(a.data[i + 2] - b.data[i + 2]);
    if (d > 18) count++;
  }
  return count;
}

try {
  const setup = await page.evaluate(async () => {
    const { mountSpringFilm } = await import('/packages/water/test/spring-film.fixture.js');
    window.springFilm = await mountSpringFilm();
    const { cue, rate, checkpoint, end, secondsPerSecond, conductance, springElevation, flowError } = window.springFilm;
    return { cue, rate, checkpoint, end, secondsPerSecond, conductance, springElevation, flowError };
  });
  const { cue, rate, checkpoint, end, secondsPerSecond, conductance, springElevation, flowError } = setup;
  let initialStorage;
  async function sample(editFrame, options = {}) {
    const { image, ...state } = await page.evaluate((input) => window.springFilm.sample(input), {
      editFrame,
      ...options,
    });
    const png = Buffer.from(image, 'base64');
    const { ground, runoff, water, integratedVolume, sourceHead, sourceFlow, totalSpring, frame } = state;
    initialStorage ??= ground.storage;
    const roundoff = 512 * Number.EPSILON * initialStorage;
    const release = ground.spring + ground.seepage;
    assert(Math.abs(initialStorage - ground.storage - release) < roundoff);
    assert(Math.abs(release - runoff.inflow) < roundoff);
    assert(Math.abs(water - runoff.inflow) < roundoff && Math.abs(water - integratedVolume) < roundoff);
    assert.equal(ground.boundaryIn + ground.boundaryOut + ground.recharge + runoff.rain + runoff.out, 0);
    assert.equal(state.springHours, (frame * secondsPerSecond) / (3600 * rate));
    assert.equal(totalSpring, sourceFlow);
    if (frame > 0 && options.open !== false) {
      // Harbaugh (2005), MODFLOW-2005 DRN. One-way head-dependent discharge from the accepted implicit head.
      // https://water.usgs.gov/ogw/modflow/MODFLOW-2005-Guide/drn.html
      const flow = conductance * Math.max(0, sourceHead - springElevation) * secondsPerSecond;
      assert(flow > 0 && Math.abs(flow - sourceFlow) <= flowError, JSON.stringify({ sourceHead, flow, sourceFlow }));
    } else {
      assert.equal(sourceFlow, 0);
    }
    return { state, png, image: await decodePNG(png) };
  }
  function exact(a, b) {
    assert.deepEqual(a.state, b.state);
    assert.deepEqual(a.image.data, b.image.data);
  }

  const dry = await sample(0);
  exact(await sample(cue - 1), dry);
  assert.equal(dry.state.water, 0);
  const controlInitial = await sample(0, { open: false });
  assert.deepEqual(controlInitial.state.front, dry.state.front);
  assert.deepEqual(controlInitial.image.data, dry.image.data);
  const moving = await sample(cue + checkpoint, { action: 'save' });
  const control = await sample(cue + end, { open: false });
  const groundwaterOnly = await sample(cue + end, { waterVisible: false });
  const spring = await sample(cue + end, { query: true });
  const { state } = spring;
  assert.equal(state.hash, groundwaterOnly.state.hash);
  assert.equal(state.ground.seepage, 0);
  assert.equal(control.state.water, 0);
  assert.equal(control.state.ground.spring, 0);
  assert(state.water > moving.state.water && moving.state.water > 0);
  const drawdown = control.state.sourceHead - state.sourceHead;
  assert(drawdown > 0.3 && state.sourceHead < dry.state.sourceHead);
  const [mouth, basin, slope] = state.sites;
  assert(mouth.depth > 0.08 && basin.depth > 0.007 && slope.depth === 0, JSON.stringify(state.sites));
  assert(
    state.renderedPond !== null && Math.abs(state.renderedPond - basin.surface) < 2e-5,
    JSON.stringify({ basin, rendered: state.renderedPond }),
  );

  const aquiferPixels = changed(control.image, groundwaterOnly.image);
  const poolPixels = changed(groundwaterOnly.image, spring.image);
  assert(aquiferPixels > 900, `The accepted water table changed only ${aquiferPixels} pixels.`);
  assert(poolPixels > 300, `The actual spring water changed only ${poolPixels} pixels.`);
  exact(await sample(cue + end + 24, { query: true }), spring);
  exact(await sample(cue + checkpoint, { action: 'restore' }), moving);
  exact(await sample(cue + end, { query: true }), spring);
  exact(await sample(0), dry);
  exact(await sample(cue + end, { query: true }), spring);
  assert.deepEqual(await page.evaluate(() => window.springFilm.dispose()), { errors: [], validation: null });
  assert.deepEqual(errors, []);

  if (process.env.MARGO_KEEP_SPRING_FRAMES === '1') {
    const path = 'packages/water/test-results/spring-film';
    await mkdir(path, { recursive: true });
    for (const [name, frame] of Object.entries({ dry, moving, control, spring }))
      await writeFile(`${path}/${backend}-${name}.png`, frame.png);
  }
  console.log(
    `${backend} spring: ${state.water.toFixed(6)} m³ delivered, ` +
      `${drawdown.toFixed(4)} m spring drawdown vs sealed control, ${basin.depth.toFixed(4)} m pool depth, ` +
      `${aquiferPixels}/${poolPixels} aquifer/pool pixels changed, replay ${state.hash}.`,
  );
} finally {
  await close();
}
