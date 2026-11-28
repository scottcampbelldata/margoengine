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
  for (let i = 0; i < a.data.length; i += 4) {
    const distance =
      Math.abs(a.data[i] - b.data[i]) +
      Math.abs(a.data[i + 1] - b.data[i + 1]) +
      Math.abs(a.data[i + 2] - b.data[i + 2]);
    if (distance > 18) total++;
  }
  return total;
}

try {
  const { cue, rate, pulse, checkpoint, end, frequency, dampingRatio, mass, seed } = await page.evaluate(async () => {
    const { mountSeismicFilm } = await import('/packages/physics/tests/seismic-film.fixture.js');
    window.seismicFilm = await mountSeismicFilm();
    const { cue, rate, pulse, checkpoint, end, frequency, dampingRatio, mass, seed } = window.seismicFilm;
    return { cue, rate, pulse, checkpoint, end, frequency, dampingRatio, mass, seed };
  });
  const dt = 1 / rate;
  const omega = 2 * Math.PI * frequency;
  const precision = 128 * Number.EPSILON;
  async function sample(editFrame, options = {}) {
    const { image, ...state } = await page.evaluate((input) => window.seismicFilm.sample(input), {
      editFrame,
      ...options,
    });
    const png = Buffer.from(image, 'base64');
    const { site, motion, force, inverseMass, frame } = state;
    const ground = motion.acceleration[0];
    const residual =
      site.relativeAcceleration + 2 * dampingRatio * omega * site.velocity + omega ** 2 * site.displacement + ground;
    const band = precision * Math.max(1, Math.abs(ground), Math.abs(site.relativeAcceleration));
    assert(Math.abs(residual) < band, JSON.stringify({ residual, band, ground, site }));
    assert(Math.abs(site.absoluteAcceleration - site.relativeAcceleration - ground) < band);
    assert(Math.abs(inverseMass - 1 / mass) <= 2 ** -23 / mass);
    if (frame % 2 === 0) assert(Math.abs(force * inverseMass + ground) < band);
    return { state, png, pixels: await decodePNG(png) };
  }
  function exact(a, b) {
    assert.deepEqual(a.state, b.state);
    assert.deepEqual(a.pixels.data, b.pixels.data);
  }

  const start = await sample(0);
  exact(await sample(cue - 1), start);
  const beforeRupture = await sample(cue + 13);
  assert.equal(beforeRupture.state.covered, 0);
  assert.deepEqual(beforeRupture.pixels.data, start.pixels.data);
  const underground = await sample(cue + pulse);
  assert(underground.state.covered > 25 && underground.state.peakX > 0.06 && underground.state.peakY > 0.06);
  assert.equal(underground.state.motion.peakHorizontalAcceleration, 0);
  assert.equal(underground.state.site.displacement, 0);
  assert.equal(underground.state.bodyDisplacement, 0);
  assert(changed(start.pixels, underground.pixels) > 650);
  const previous = await sample(cue + checkpoint - 1);
  const loaded = await sample(cue + checkpoint, { action: 'save' });
  assert(loaded.state.covered > 3 * underground.state.covered);
  assert(loaded.state.motion.peakHorizontalAcceleration > 0.4);
  const { site, bodyVelocity, bodyDisplacement, force } = loaded.state;
  const old = previous.state.site;
  // Newmark (1959), constant average acceleration, beta=1/4 and gamma=1/2.
  // https://doi.org/10.1061/JMCEA3.0000098
  const average = 0.5 * (old.relativeAcceleration + site.relativeAcceleration);
  assert(Math.abs(site.displacement - (old.displacement + dt * old.velocity + 0.5 * dt * dt * average)) < precision);
  assert(Math.abs(site.velocity - (old.velocity + dt * average)) < precision);
  const following = await sample(cue + checkpoint + 2);
  // The 60 Hz rigid clock holds the preceding accepted inertial force for one step.
  const change = force * loaded.state.inverseMass * 2 * dt;
  const roundoff =
    8 * 2 ** -24 * Math.max(Math.abs(change), Math.abs(bodyVelocity), Math.abs(following.state.bodyVelocity));
  assert(
    Math.abs(following.state.bodyVelocity - bodyVelocity - change) < roundoff,
    JSON.stringify({ after: following.state.bodyVelocity, bodyVelocity, change, roundoff, force }),
  );
  const control = await sample(cue + end, { rupture: false });
  const unstained = await sample(cue + end, { showWave: false });
  const stationary = await sample(cue + end, { showWave: false, showWitnesses: false });
  const last = await sample(cue + end);
  assert.equal(control.state.covered + control.state.motion.peakHorizontalAcceleration, 0);
  assert.equal(control.state.site.displacement, 0);
  assert.equal(control.state.bodyDisplacement, 0);
  assert(Math.abs(bodyDisplacement) > 0.003 && Math.abs(last.state.site.displacement) > 0.004);
  assert.equal(last.state.hash, unstained.state.hash);
  assert.equal(last.state.hash, stationary.state.hash);
  assert.deepEqual(control.pixels.data, stationary.pixels.data);
  const wavePixels = changed(last.pixels, unstained.pixels);
  const reactionPixels = changed(unstained.pixels, stationary.pixels);
  assert(wavePixels > 2500 && reactionPixels > 120, JSON.stringify({ wavePixels, reactionPixels }));

  exact(await sample(cue + end + 20), last);
  exact(await sample(cue + checkpoint, { action: 'restore' }), loaded);
  exact(await sample(cue + end), last);
  exact(await sample(0), start);
  exact(await sample(cue + end), last);
  assert.deepEqual(await page.evaluate(() => window.seismicFilm.dispose()), { errors: [], validation: null });
  assert.deepEqual(errors, []);

  if (process.env.MARGO_KEEP_SEISMIC_FRAMES === '1') {
    const path = 'packages/physics/test-results/seismic-film';
    await mkdir(path, { recursive: true });
    for (const [name, frame] of Object.entries({ start, underground, loaded, control, last }))
      await writeFile(`${path}/${backend}-${name}.png`, frame.png);
  }
  console.log(
    `${backend} seismic: ${last.state.motion.peakHorizontalAcceleration.toFixed(3)} m/s² peak horizontal acceleration, ` +
      `${(1000 * site.displacement).toFixed(3)} / ${(1000 * bodyDisplacement).toFixed(3)} mm elastic/rigid station motion at frame ${checkpoint}, ` +
      `${wavePixels}/${reactionPixels} wave/witness pixels, seed ${seed}, accepted replay ${last.state.hash}.`,
  );
} finally {
  await close();
}
