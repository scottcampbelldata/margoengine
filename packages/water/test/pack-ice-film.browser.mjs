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

function changed(one, other) {
  let count = 0;
  for (let i = 0; i < one.data.length; i += 4) {
    const distance =
      Math.abs(one.data[i] - other.data[i]) +
      Math.abs(one.data[i + 1] - other.data[i + 1]) +
      Math.abs(one.data[i + 2] - other.data[i + 2]);
    if (distance > 18) count++;
  }
  return count;
}

try {
  const { cue, checkpointFrame, end, density, waterDensity, mass, speed } = await page.evaluate(async () => {
    const { mountPackIceFilm } = await import('/packages/water/test/pack-ice-film.fixture.js');
    window.packIceFilm = await mountPackIceFilm();
    const { cue, checkpointFrame, end, density, waterDensity, mass, speed } = window.packIceFilm;
    return { cue, checkpointFrame, end, density, waterDensity, mass, speed };
  });
  async function sample(editFrame, options = {}) {
    const { image, ...state } = await page.evaluate((input) => window.packIceFilm.sample(input), {
      editFrame,
      ...options,
    });
    const png = Buffer.from(image, 'base64');
    assert(state.drew === state.floes.length && state.drew > 40);
    for (const [i, floe] of state.floes.entries()) {
      const {
        position: [x, z],
        radius,
        equivalentThickness,
        heading,
      } = floe;
      const matrix = state.matrices.slice(16 * i, 16 * i + 16);
      assert.equal(matrix[0], Math.fround(2 * radius * Math.cos(heading)));
      assert(matrix[2] === Math.fround(-2 * radius * Math.sin(heading)));
      assert.equal(matrix[5], Math.fround(equivalentThickness));
      assert.equal(matrix[12], Math.fround(x));
      assert.equal(matrix[13], Math.fround(equivalentThickness * (1 - density / waterDensity - 0.5)));
      assert.equal(matrix[14], Math.fround(z));
    }
    return { state, png, image: await decodePNG(png) };
  }
  function exact(first, second) {
    assert.deepEqual(first.state, second.state);
    assert.deepEqual(first.image.data, second.image.data);
  }

  const start = await sample(0);
  exact(await sample(cue - 1), start);
  const before = await sample(cue + 20);
  assert.deepEqual(before.state.floes, start.state.floes);
  assert.deepEqual(before.state.impulse, [0, 0, 0]);
  const impact = await sample(cue + checkpointFrame, { action: 'save' });
  const control = await sample(cue + end, { linked: false });
  const final = await sample(cue + end);
  assert.deepEqual(control.state.floes, start.state.floes);
  assert.deepEqual(control.state.velocity, start.state.velocity);
  assert.equal(control.state.spin, 0);
  assert.deepEqual(control.state.impulse, [0, 0, 0]);
  assert(impact.state.impulse[1] < 0 && impact.state.impulse[2] < 0 && impact.state.spin < 0);
  assert(impact.state.floes[0].velocity[0] > 0 && impact.state.floes[0].velocity[1] > 0);
  const lostSpeed = control.state.velocity[2] - final.state.velocity[2];
  assert(lostSpeed > 0.25 && final.state.position[2] < control.state.position[2] - 1);
  assert(final.state.rotation[1] < 0 && Math.abs(final.state.spin) > 0.01);

  let rafted = 0;
  let ridged = 0;
  for (const [i, floe] of final.state.floes.entries()) {
    assert.equal(floe.volume, start.state.floes[i].volume);
    const piles = floe.raftedVolume + floe.ridgedVolume;
    const flat = Math.PI * floe.radius ** 2 * floe.thickness;
    assert(Math.abs(flat + piles - floe.volume) < 128 * Number.EPSILON * floe.volume);
    if (piles > 0) assert(floe.equivalentThickness > floe.thickness && floe.radius < start.state.floes[i].radius);
    rafted += floe.raftedVolume;
    ridged += floe.ridgedVolume;
  }
  assert(rafted > 0.02 && ridged > 0.02);

  for (const [i, axis] of [0, 2].entries()) {
    const iceMomentum = final.state.floes.reduce((sum, floe) => sum + floe.volume * density * floe.velocity[i], 0);
    const impulse = final.state.impulse[i];
    assert(Math.abs(iceMomentum + impulse) <= 256 * Number.EPSILON * final.state.frame * mass * speed);
    const boatMomentum = mass * (final.state.velocity[axis] - control.state.velocity[axis]);
    // The coupling writes f32 rigid mobility and velocity, with impulse conversion and application at each 60 Hz tick.
    const f32Bound = 4 * 2 ** -24 * final.state.frame * mass * speed;
    assert(
      Math.abs(boatMomentum - impulse) <= f32Bound,
      JSON.stringify({ iceMomentum, boatMomentum, impulse, f32Bound }),
    );
  }

  const interactionPixels = changed(control.image, final.image);
  assert(interactionPixels > 2500, `Vessel coupling changed only ${interactionPixels} pixels.`);
  exact(await sample(cue + end + 9), final);
  exact(await sample(cue + checkpointFrame, { action: 'restore' }), impact);
  exact(await sample(cue + end), final);
  exact(await sample(0), start);
  exact(await sample(cue + end), final);
  assert.deepEqual(await page.evaluate(() => window.packIceFilm.dispose()), { errors: [], validation: null });
  assert.deepEqual(errors, []);

  if (process.env.MARGO_KEEP_PACK_ICE_FRAMES === '1') {
    const path = 'packages/water/test-results/pack-ice-film';
    await mkdir(path, { recursive: true });
    for (const [name, frame] of Object.entries({ start, impact, control, final }))
      await writeFile(`${path}/${backend}-${name}.png`, frame.png);
  }
  console.log(
    `${backend} pack ice: ${final.state.drew} accepted floes, launch loses ${lostSpeed.toFixed(3)} m/s, ` +
      `rafts ${(1000 * rafted).toFixed(2)} L and ridges ${(1000 * ridged).toFixed(2)} L, ` +
      `${interactionPixels} coupled pixels, replay ${final.state.hash}.`,
  );
} finally {
  await close();
}
