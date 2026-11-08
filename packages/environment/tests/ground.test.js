// CPU checks for @margoengine/environment/ground: settings validation and the background slot. The projection itself
// is checked on a real device by tests/ground-browser.js (npm run test:ground:browser).
import test from 'node:test';
import assert from 'node:assert/strict';
import { GroundProjectedBackground } from '../dist/ground.js';

const environment = {};

test('defaults: height 1.6, radius 50, center at the origin, in the background slot', () => {
  const ground = new GroundProjectedBackground(environment);
  assert.equal(ground.height, 1.6);
  assert.equal(ground.radius, 50);
  assert.deepEqual(ground.center, [0, 0, 0]);
  assert.equal(ground.name, 'environment:background');
});

test('height and radius are checked as a pair, in either order of the options', () => {
  for (const bad of [
    { height: 0 },
    { height: -1 },
    { height: 60 },
    { radius: 1 },
    { radius: Infinity },
    { height: Number.NaN },
  ])
    assert.throws(() => new GroundProjectedBackground(environment, bad), RangeError, JSON.stringify(bad));
  const wide = new GroundProjectedBackground(environment, { height: 80, radius: 200 });
  assert.equal(wide.height, 80);
  assert.equal(wide.radius, 200);
  assert.throws(() => (wide.radius = 70), RangeError, 'a radius below the height is refused');
  assert.equal(wide.radius, 200, 'a refused setting changes nothing');
  wide.height = 5;
  wide.radius = 6;
  assert.equal(wide.radius, 6);
});

test('center takes three finite numbers and is returned as a copy', () => {
  const ground = new GroundProjectedBackground(environment, { center: [1, 2, 3] });
  const center = ground.center;
  center[0] = 9;
  assert.deepEqual(ground.center, [1, 2, 3]);
  for (const bad of [[0, 0], [0, Number.NaN, 0], 'here', [0, 0, 0, 0]])
    assert.throws(() => (ground.center = bad), RangeError, String(bad));
  assert.deepEqual(ground.center, [1, 2, 3]);
});
