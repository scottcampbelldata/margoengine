import test from 'node:test';
import assert from 'node:assert/strict';
import { Camera } from '../../core/dist/index.js';
import { CameraProjection } from '../dist/index.js';
import { FloatingOrigin } from '../dist/origin.js';

// Every cameras error names its fix after a '; ' clause, so the message says what to do.
const fixes = (pattern) => (error) => {
  assert.match(error.message, pattern);
  assert.match(error.message, /;/, `${error.message} should name a fix after a ';'`);
  return true;
};

test('projection errors say what to pass', () => {
  const camera = new Camera({ position: [0, 0, 10], target: [0, 0, 0], fov: 60 });
  const p = new CameraProjection();
  p.attach(camera);
  assert.throws(() => p.fit([1, 0, 0, 0, 1, 1]), fixes(/Invalid fit/));
  assert.throws(() => p.fit([0, 0, 0, 0, 0, 0], { duration: 0 }), fixes(/Invalid fit/));
  assert.throws(() => p.fit([-600, 0, 0, 600, 1, 1]), fixes(/Bounds exceed far/));
  const bad = new CameraProjection({ up: [0, 1, 0] });
  const other = new Camera({ position: [0, 10, 0], target: [0, 0, 0] });
  bad.attach(other);
  assert.throws(() => other.update(1, true), fixes(/vertical up/));
  const inverted = new Camera({ position: [0, 0, 10], target: [0, 0, 0] });
  new CameraProjection({ left: 1, right: 0, top: 1, bottom: 0 }).attach(inverted);
  assert.throws(() => inverted.update(1, true), fixes(/Invalid projection/));
});

test('FloatingOrigin errors say what to do', () => {
  assert.throws(
    () => new FloatingOrigin({ ratio: 0 }),
    (e) => e instanceof RangeError && fixes(/ratio/)(e),
  );
  assert.throws(
    () => new FloatingOrigin().rebase([0, 0, 0]),
    (e) => e.name === 'MargoError' && e.code === 'state' && fixes(/not attached/)(e),
  );
});
