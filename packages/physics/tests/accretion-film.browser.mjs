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
    const diff =
      Math.abs(a.data[i] - b.data[i]) +
      Math.abs(a.data[i + 1] - b.data[i + 1]) +
      Math.abs(a.data[i + 2] - b.data[i + 2]);
    if (diff > 18) counts[Number((i / 4) % a.width >= a.width / 2)]++;
  }
  return counts;
}

function near(got, expected, scale = Math.abs(expected)) {
  const bound = scale * 512 * Number.EPSILON;
  assert(Math.abs(got - expected) <= bound, JSON.stringify({ got, expected, bound }));
}

function tracerPixelDelta(on, off, matrix, point) {
  const [x, y, z] = point;
  const w = matrix[3] * x + matrix[7] * y + matrix[11] * z + matrix[15];
  const u = (matrix[0] * x + matrix[4] * y + matrix[8] * z + matrix[12]) / w;
  const v = (matrix[1] * x + matrix[5] * y + matrix[9] * z + matrix[13]) / w;
  const ix = Math.floor(on.width * (0.5 + 0.5 * u));
  const iy = Math.floor(on.height * (0.5 - 0.5 * v));
  assert(ix >= 2 && iy >= 2 && ix < on.width - 2 && iy < on.height - 2);
  let delta = 0;
  for (let j = -2; j <= 2; j++)
    for (let i = -2; i <= 2; i++) {
      const at = 4 * (ix + i + (iy + j) * on.width);
      delta += Math.abs(on.data[at + 1] - off.data[at + 1]);
    }
  return delta;
}

try {
  const setup = await page.evaluate(async () => {
    const { mountAccretionFilm } = await import('/packages/physics/tests/accretion-film.fixture.js');
    const take = await mountAccretionFilm();
    window.accretionFilm = take;
    const { sample, dispose, ...parameters } = take;
    return parameters;
  });
  const {
    cue,
    rate,
    firstCheckpoint,
    secondCheckpoint,
    end,
    seed,
    cell,
    G,
    centralMass,
    gravitySeconds,
    distance,
    spin,
    tracerRadius,
    azimuth,
    viscosity,
    edges,
    densities,
    centres,
  } = setup;
  const orbitFrequency = 1 / (gravitySeconds * (tracerRadius ** 1.5 + spin));
  const properFraction =
    Math.sqrt(1 - 3 / tracerRadius + (2 * spin) / tracerRadius ** 1.5) / (1 + spin / tracerRadius ** 1.5);
  const area = (i) => Math.PI * (edges[i + 1] ** 2 - edges[i] ** 2);
  const initialMass = densities.reduce((sum, sigma, i) => sum + sigma * area(i), 0);
  async function sample(editFrame, options = {}) {
    const { image, ...state } = await page.evaluate((input) => window.accretionFilm.sample(input), {
      editFrame,
      ...options,
    });
    const png = Buffer.from(image, 'base64');
    const seconds = state.frame / rate;
    for (const [side, take] of state.states.entries()) {
      assert.deepEqual(take.cells, [cell, cell, cell, cell]);
      const nu = side === 0 ? viscosity : 0;
      let sumMass = 0;
      let luminosity = 0;
      for (const [i, ring] of take.rings.entries()) {
        const radius = (edges[i] + edges[i + 1]) / 2;
        const omega = Math.sqrt((G * centralMass) / radius ** 3);
        const expectedPhase = omega * seconds;
        const angle = ring.phase - expectedPhase;
        near(ring.radius, radius);
        near(ring.angularVelocity, omega);
        near(Math.atan2(Math.sin(angle), Math.cos(angle)), 0, Math.max(1, expectedPhase));
        near(ring.heating, (9 / 8) * nu * ring.density * omega ** 2);
        near(ring.heating, 5.670374419e-8 * ring.effectiveTemperature ** 4);
        if (side === 1 || state.frame === 0) near(ring.density, densities[i]);
        sumMass += ring.density * area(i);
        luminosity += 2 * ring.heating * area(i);
      }
      const { budget } = take;
      near(budget.initialMass, initialMass);
      near(budget.remainingMass, sumMass);
      near(budget.remainingMass + budget.accretedMass, initialMass);
      near(budget.luminosity, luminosity);
      assert.equal(budget.suppliedMass + budget.escapedMass, 0);
      const [radius, polar, angle, properTime] = take.coordinates;
      near(radius / distance, tracerRadius);
      assert.equal(polar, Math.PI / 2);
      near(angle, azimuth + seconds * orbitFrequency);
      near(properTime, seconds * properFraction);
      near(take.position[0] - centres[side], tracerRadius * Math.cos(angle), tracerRadius);
      near(take.position[1], 0, tracerRadius);
      near(take.position[2], tracerRadius * Math.sin(angle), tracerRadius);
    }
    assert.deepEqual(state.states[0].coordinates, state.states[1].coordinates);
    assert.deepEqual(state.states[0].phase, state.states[1].phase);
    return { state, png, pixels: await decodePNG(png) };
  }

  function exact(a, b) {
    assert.deepEqual(a.state, b.state);
    assert.deepEqual(a.pixels.data, b.pixels.data);
  }

  const first = await sample(0);
  exact(await sample(cue), first);
  const sheared = await sample(cue + firstCheckpoint, { action: 'save' });
  const angularShear = sheared.state.states[0].phase[0] - sheared.state.states[0].phase.at(-1);
  assert(angularShear > 2.6 && angularShear < Math.PI);
  const middle = await sample(cue + secondCheckpoint, { action: 'save' });
  const after = await sample(cue + end);
  const withoutHeat = await sample(cue + end, { showHeating: false });
  const withoutPhase = await sample(cue + end, { showPhase: false });
  const withoutTracer = await sample(cue + end, { showTracer: false });
  for (const control of [withoutHeat, withoutPhase, withoutTracer]) assert.deepEqual(control.state, after.state);
  const [hot, cold] = after.state.states;
  const accreted = hot.budget.accretedMass / hot.budget.initialMass;
  assert(accreted > 0.015 && accreted < 0.03);
  assert(hot.rings[17].density < 0.65 * cold.rings[17].density);
  assert(hot.rings.at(-1).density > 1.5 * cold.rings.at(-1).density);
  assert(cold.heat.every((heat) => heat === 0));
  assert.equal(cold.budget.accretedMass + cold.budget.luminosity, 0);
  const heatPixels = changed(after.pixels, withoutHeat.pixels);
  const phasePixels = changed(after.pixels, withoutPhase.pixels);
  const tracerPixels = changed(after.pixels, withoutTracer.pixels);
  assert(heatPixels[0] > 6000 && heatPixels[1] === 0, JSON.stringify({ heatPixels }));
  assert(
    phasePixels.every((value) => value > 2000),
    JSON.stringify({ phasePixels }),
  );
  assert(
    tracerPixels.every((value) => value >= 8),
    JSON.stringify({ tracerPixels }),
  );
  for (const take of after.state.states)
    assert(tracerPixelDelta(after.pixels, withoutTracer.pixels, after.state.matrix, take.position) > 200);

  exact(await sample(cue + end + 35), after);
  exact(await sample(cue + secondCheckpoint, { action: 'restore' }), middle);
  exact(await sample(cue + end), after);
  exact(await sample(cue + firstCheckpoint, { action: 'restore' }), sheared);
  exact(await sample(cue + secondCheckpoint), middle);
  exact(await sample(cue + end), after);
  exact(await sample(0), first);
  exact(await sample(cue + end), after);
  assert.deepEqual(await page.evaluate(() => window.accretionFilm.dispose()), { errors: [], validation: null });
  assert.deepEqual(errors, []);

  if (process.env.MARGO_KEEP_ACCRETION_FILM_FRAMES === '1') {
    const path = 'packages/physics/test-results/accretion-film';
    await mkdir(path, { recursive: true });
    for (const [name, shot] of Object.entries({
      first,
      sheared,
      middle,
      after,
      withoutHeat,
      withoutPhase,
      withoutTracer,
    }))
      await writeFile(`${path}/${backend}-${name}.png`, shot.png);
  }
  console.log(
    `${backend} accretion: ${(accreted * 100).toFixed(3)}% accreted mass, ${hot.budget.luminosity.toExponential(3)} W, ` +
      `${angularShear.toFixed(3)} rad annulus winding, ${(hot.coordinates[2] - azimuth).toFixed(3)} rad Kerr advance, ` +
      `${heatPixels[0]}/${phasePixels.join('+')}/${tracerPixels.join('+')} heating/phase/tracer pixels, ` +
      `seed ${seed}, replay ${hot.hash}/${cold.hash}.`,
  );
} finally {
  await close();
}
