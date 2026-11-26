import assert from 'node:assert/strict';
import test from 'node:test';
import { ThinFilmSolver } from '../dist/thin-film.js';
import { PhysicsWorld } from '../dist/world.js';

const rate = { num: 60, den: 1 };
const dt = 1 / rate.num;

async function patch(options, load = {}) {
  const film = await ThinFilmSolver.load(load);
  const world = new PhysicsWorld({ rate }).add(film, options);
  return { world, film };
}

function close(actual, wanted, tolerance) {
  assert.ok(Math.abs(actual - wanted) <= tolerance, `${actual} vs ${wanted}, bound ${tolerance}`);
}

test('ThinFilmSolver: hydrostatic plus capillary damping matches the closed-form discrete Fourier mode', async () => {
  const n = 16;
  const dx = 0.01;
  const h = 0.001;
  const epsilon = 1e-10;
  const density = 998;
  const viscosity = 0.001002;
  const sigma = 0.0728;
  const k = (3 * Math.PI) / n;
  const cosines = Array.from({ length: n }, (_, i) => Math.cos(k * (i + 0.5)));
  const { world, film } = await patch({ cells: [n, 1], spacing: dx, depth: cosines.map((v) => h + epsilon * v) });
  const eigenvalue = (4 * Math.sin(k / 2) ** 2) / (dx * dx);
  const mobility = h ** 3 / (3 * viscosity);
  const factor = 1 + dt * mobility * (density * -world.gravity[1] + sigma * eigenvalue) * eigenvalue;
  const frames = 12;
  world.advance(frames);
  const values = film.depths();
  const amplitude = (values.reduce((sum, value, i) => sum + (value - h) * cosines[i], 0) * 2) / n;
  const expected = epsilon / factor ** frames;
  const linearization = (12 * frames * epsilon * epsilon) / h;
  const rounding = 32 * frames * Number.EPSILON * h;
  close(amplitude, expected, linearization + rounding);
  close(film.budget.stored, film.budget.initial, frames * n * 8 * Number.EPSILON * film.budget.initial);
  assert.ok(amplitude > 0 && amplitude < epsilon);
  assert.equal(film.budget.substeps, 1);
});

test('ThinFilmSolver: a level puddle is a fixed point on an uneven substrate', async () => {
  const dx = 0.05;
  const base = [0.0001, 0.0002, -0.0001, -0.0001, 0.00004, -0.0002];
  const initial = base.map((v) => 0.0005 - v);
  const { world, film } = await patch({ cells: [3, 2], spacing: dx, substrate: base, depth: initial });
  world.advance(120);
  for (const [i, h] of film.depths().entries()) close(h, initial[i], 120 * 8 * Number.EPSILON * initial[i]);
  assert.equal(film.budget.dripped, 0);
});

test('ThinFilmSolver: a vertical one-cell glass patch sends the Nusselt gravity flux into its open bottom', async () => {
  const dx = 0.02;
  const h = 0.0002;
  const density = 998;
  const viscosity = 0.001002;
  const { world, film } = await patch({
    cells: [1, 1],
    spacing: dx,
    depth: h,
    u: [1, 0, 0],
    v: [0, -1, 0],
    drains: [false, false, false, true],
  });
  const expected = (density * -world.gravity[1] * h ** 3 * dx * dt) / (3 * viscosity);
  world.advance(1);
  assert.equal(film.budget.substeps, 1);
  close(film.budget.dripped, expected, 32 * Number.EPSILON * expected);
  close(film.sample(0, 0).dripRate, expected / dt, (32 * Number.EPSILON * expected) / dt);
  close(film.budget.stored + film.budget.dripped, film.budget.initial, 32 * Number.EPSILON * film.budget.initial);
});

test('ThinFilmSolver: drying is limited to available water and wet/dry flow stays positive', async () => {
  const h = 0.00003;
  const spacing = 0.006;
  const { world, film } = await patch({
    cells: [7, 1],
    spacing,
    depth: [0, 0, 0, h, 0, 0, 0],
    rainRate: 0.000003,
    evaporation: 0.00002,
  });
  world.advance(200);
  assert.ok(film.depths().every((value) => value >= 0));
  assert.equal(film.budget.stored, 0);
  const expectedRain = 7 * spacing * spacing * 0.000003 * dt * 200;
  close(film.budget.rain, expectedRain, 200 * 8 * Number.EPSILON * expectedRain);
  close(film.budget.initial + film.budget.rain, film.budget.evaporated, 200 * 8 * Number.EPSILON * expectedRain);
});

test('ThinFilmSolver: contact-line retention distinguishes a pinned bead from a driven runnel', async () => {
  const base = {
    cells: [1, 5],
    spacing: 0.003,
    u: [1, 0, 0],
    v: [0, -1, 0],
    surfaceTension: 0,
    depth: [0, 0.0001, 0, 0, 0],
  };
  const held = await patch({ ...base, pinning: 0.2 });
  const released = await patch({ ...base, pinning: 0 });
  held.world.advance(30);
  released.world.advance(30);
  assert.deepEqual(Array.from(held.film.depths()), base.depth);
  assert.ok(released.film.sample(0, 2).depth > 0);
  close(released.film.budget.stored, held.film.budget.stored, 30 * 5 * Number.EPSILON * held.film.budget.stored);
});
