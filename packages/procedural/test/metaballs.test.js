import assert from 'node:assert/strict';
import test from 'node:test';
import { Metaballs } from '../dist/index.js';

const bounds = [
  [-2, -2, -2],
  [2, 2, 2],
];
const extent = (geometry) => {
  const v = geometry.vertices,
    lo = [Infinity, Infinity, Infinity],
    hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < v.length; i += 6)
    for (let a = 0; a < 3; a++) {
      lo[a] = Math.min(lo[a], v[i + a]);
      hi[a] = Math.max(hi[a], v[i + a]);
    }
  return { lo, hi };
};

test('a ball is a closed surface that follows the ball and merges with a neighbour', () => {
  const blobs = new Metaballs({ resolution: [48, 48, 48], bounds });
  assert.equal(blobs.geometry(), null, 'no balls, no surface');
  const a = blobs.add([-1, 0, 0], { radius: 0.8 });
  const alone = extent(blobs.geometry());
  assert.ok(alone.hi[0] < -0.2 && alone.lo[0] > -1.8, 'the surface hugs the ball');
  a.position[0] = 1;
  const moved = extent(blobs.geometry());
  assert.ok(moved.lo[0] > 0.2, 'editing the ball moves the next geometry');
  const near = blobs.add([1.5, 0, 0], { radius: 0.8 });
  const merged = extent(blobs.geometry());
  assert.ok(merged.hi[0] > alone.hi[0] + 1, 'two close balls make one wider blob');
  assert.equal(blobs.remove(near), true);
  assert.equal(blobs.remove(near), false);
});

test('pull is exactly zero past the radius, and a negative strength carves the surface', () => {
  const blobs = new Metaballs({ resolution: [32, 32, 32], bounds });
  blobs.add([0, 0, 0], { radius: 1 });
  assert.equal(blobs.sample(1, 0, 0), 0);
  assert.equal(blobs.sample(1.5, 0, 0), 0);
  assert.equal(blobs.sample(0, 0, 0), 1);
  const whole = extent(blobs.geometry());
  const hole = blobs.add([0.45, 0, 0], { strength: -1, radius: 0.5 });
  assert.ok(blobs.sample(0.45, 0, 0) < 1, 'the negative ball subtracts');
  const carved = extent(blobs.geometry());
  assert.ok(carved.hi[0] < whole.hi[0], 'the carved side is pulled in');
  blobs.remove(hole);
});

test('invalid balls and options are refused with a fix', () => {
  assert.throws(() => new Metaballs({ threshold: 0 }), /threshold/);
  const blobs = new Metaballs();
  assert.throws(() => blobs.add([0, 0], {}), /Metaball needs/);
  assert.throws(() => blobs.add([0, 0, 0], { radius: 0 }), /positive/);
  const ball = blobs.add([0, 0, 0]);
  ball.radius = Number.NaN;
  assert.throws(() => blobs.geometry(), /fix the ball you edited/);
});
