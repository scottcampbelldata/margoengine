import assert from 'node:assert/strict';
import test from 'node:test';
import { BoundaryLayerWind } from '../dist/boundary-layer.js';
import { travellingGust } from '../dist/turbulence.js';

const density = 1.15;
const temperature = 284;
const steady = (initial = [0, 0, 0], velocity = [2, 0, -1]) => ({
  medium: 'air',
  cell: initial,
  sample(_x, _y, _z, _t, out = { velocity: [0, 0, 0] }) {
    for (let axis = 0; axis < 3; axis++) out.velocity[axis] = velocity[axis];
    out.density = density;
    out.temperature = temperature;
    return out;
  },
});

test('a one-cosine gust arrives progressively, preserves base thermodynamics and has a smooth height envelope', () => {
  const gust = travellingGust(steady(), {
    origin: [0, 1, 0],
    start: 1,
    speed: 2,
    length: 4,
    amplitude: [8, 2, -4],
    height: [0, 8],
  });
  for (const t of [1, 3, 5, 6]) assert.deepEqual(gust.sample(4, 5, 0, t).velocity, [2, 0, -1]);
  assert.deepEqual(gust.sample(4, 5, 0, 4), { velocity: [10, 2, -5], density, temperature });
  assert.deepEqual(gust.sample(0, 5, 0, 2), gust.sample(4, 5, 0, 4));
  for (const [y, t, expected] of [
    [5, 3.5, 6],
    [5, 4.5, 6],
    [3, 4, 6],
    [1, 4, 2],
    [9, 4, 2],
  ])
    assert.ok(Math.abs(gust.sample(4, y, 0, t).velocity[0] - expected) <= 16 * Number.EPSILON * expected);
  const tiny = travellingGust(steady(undefined, [0, 0, 0]), { speed: 1, length: 1, amplitude: [1, 0, 0] });
  const fraction = 2 ** -35;
  const analytic = Math.PI ** 2 * fraction ** 2;
  assert.ok(Math.abs(tiny.sample(0, 0, 0, fraction).velocity[0] / analytic - 1) < 16 * Number.EPSILON);
});

test('the front stays at the same signed-cell world point through a rebase and out-of-order time queries', () => {
  const base = steady([-524_287, 400_000, 524_280]);
  const gust = travellingGust(base, {
    cellSize: 512,
    origin: [4, -2, 6],
    direction: Math.PI / 2,
    speed: 4,
    length: 8,
    amplitude: [0, 3, 0],
    height: [-1, 1],
  });
  const accepted = gust.sample(4, -2, 10, 2);
  assert.deepEqual(accepted.velocity, [2, 3, -1]);
  base.cell = [-524_288, 399_999, 524_282];
  assert.equal(gust.cell, base.cell);
  assert.deepEqual(gust.sample(4 + 512, -2 + 512, 10 - 1024, 2), accepted);
  assert.deepEqual(gust.sample(4 + 512, -2 + 512, 10 - 1024, -8).velocity, [2, 0, -1]);
  const out = { velocity: [0, 0, 0], density: 0, temperature: 0 };
  assert.equal(gust.sample(4 + 512, -2 + 512, 10 - 1024, 2, out), out);
  assert.deepEqual(out, accepted);
});

test('bad gust settings and overflowing velocity give coded errors without changing the caller output', () => {
  const base = steady(undefined, [Number.MAX_VALUE, 0, 0]);
  const settings = { speed: 2, length: 4, amplitude: [Number.MAX_VALUE, 0, 0] };
  assert.throws(() => travellingGust(base, { ...settings, speed: 0 }), {
    code: 'state',
    message: /Use finite positive/,
  });
  assert.throws(() => travellingGust(base, { ...settings, amplitude: Array(3) }), {
    code: 'state',
    message: /Use finite metres/,
  });
  assert.throws(() => travellingGust(base, { ...settings, height: [-Number.MAX_VALUE, Number.MAX_VALUE] }), {
    code: 'state',
    message: /Use finite bottom/,
  });
  const gust = travellingGust(base, settings);
  const out = { velocity: [1, 2, 3], density: 4, temperature: 5 };
  assert.throws(() => gust.sample(0, 0, 0, 1, out), { code: 'state', message: /Reduce the peak gust/ });
  assert.deepEqual(out, { velocity: [1, 2, 3], density: 4, temperature: 5 });
  assert.throws(() => gust.sample(Number.NaN, 0, 0, 0, out), { code: 'state', message: /Use finite local/ });
});

test('calm boundary-layer wind accepts a gust and explicit turbulence still works at zero mean', () => {
  const calm = new BoundaryLayerWind({ speed: 0 });
  assert.equal(calm.turbulence, undefined);
  assert.deepEqual(calm.sample(0, 10, 0, 1).velocity, [0, 0, 0]);
  const gust = travellingGust(calm, { speed: 2, length: 4, amplitude: [3, 1, 0] });
  assert.deepEqual(gust.sample(0, 10, 0, 1).velocity, [3, 1, 0]);
  const box = new BoundaryLayerWind({ speed: 0, turbulence: { sigma: 0.25, cells: [8, 6, 5] } });
  assert.equal(box.turbulence.sigma, 0.25);
  assert.ok(box.sample(0, 10, 0, 1).velocity.some((v) => v !== 0));
});
