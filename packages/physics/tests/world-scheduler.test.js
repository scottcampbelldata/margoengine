// Accelerated fixed-point iteration for strongly coupled groups: Aitken's relaxation and Anderson acceleration converge where
// the plain exchange diverges, with fixed counts and the same bits every run; and the added-mass test says when plain
// staggering diverges.
import assert from 'node:assert/strict';
import test from 'node:test';
import { Aitken, Anderson, staggeringStable } from '../dist/world.js';

/** The fixed-point map of a light body in a dense fluid: the interface force the fluid gives back for a guessed force. */
const addedMassMap = (ratio, load) => (force) => load - ratio * force; // fixed point load / (1 + ratio)

test('plain exchange diverges once the added mass reaches the body mass; Aitken converges in a fixed count', () => {
  const g = addedMassMap(1.5, 3),
    exact = 3 / 2.5;
  let plain = 0;
  for (let k = 0; k < 20; k++) plain = g(plain);
  assert.ok(Math.abs(plain - exact) > 1, `plain exchange diverges: ${plain}`);
  const aitken = new Aitken(1),
    x = [0];
  for (let k = 0; k < 4; k++) aitken.next(x, [g(x[0])], x);
  // A scalar linear map is solved exactly by its secant step.
  assert.ok(Math.abs(x[0] - exact) < 1e-12, `aitken ${x[0]}`);
});

test('Anderson solves a linear coupled interface of n values in n + 1 iterations', () => {
  // g(x) = M x + b with M of spectral radius above 1 (plain iteration diverges).
  const n = 4,
    M = [
      [-1.2, 0.3, 0, 0.1],
      [0.2, -0.9, 0.4, 0],
      [0, 0.1, -1.4, 0.2],
      [0.3, 0, 0.2, -1.1],
    ],
    b = [1, -2, 0.5, 3],
    g = (x) => M.map((row, i) => row.reduce((s, m, j) => s + m * x[j], b[i]));
  const solve = () => {
    const anderson = new Anderson(n, n),
      x = new Float64Array(n);
    for (let k = 0; k <= n + 1; k++) anderson.next(x, g(x), x);
    return x;
  };
  const x = solve(),
    r = g(x).map((v, i) => v - x[i]);
  assert.ok(Math.hypot(...r) < 1e-10, `residual ${Math.hypot(...r)}`);
  assert.deepEqual(solve(), x, 'the same bits every run');
});

test('a dependent history column gets no weight', () => {
  // A map that keeps returning the same value: every difference after the first is zero.
  const anderson = new Anderson(2, 3),
    x = new Float64Array(2);
  for (let k = 0; k < 5; k++) anderson.next(x, [1, 2], x);
  assert.deepEqual(Array.from(x), [1, 2]);
});

test('staggering is stable only for a body heavier than its added mass, with margin', () => {
  // A sphere: added mass 0.5 rho V. Steel in water is fine, a balloon in water is not.
  const water = 1000,
    volume = 0.001;
  assert.equal(staggeringStable(7850 * volume, 0.5 * water * volume), true);
  assert.equal(staggeringStable(1.2 * volume, 0.5 * water * volume), false);
  assert.equal(staggeringStable(1, 0.6), false, 'stable but slower than the margin allows');
  assert.equal(staggeringStable(1, 0.6, 1), true);
  assert.throws(() => staggeringStable(0, 1), RangeError);
  assert.throws(() => new Anderson(0), RangeError);
  assert.throws(() => new Aitken(1, 0), RangeError);
});
