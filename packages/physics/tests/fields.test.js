// An explosion and a wind on rigid bodies.
import assert from 'node:assert/strict';
import test from 'node:test';
import { explosion, Physics, WindField } from '../dist/index.js';

const near = (actual, expected, tolerance, label) =>
  assert.ok(Math.abs(actual - expected) <= tolerance, `${label}: ${actual} is not within ${tolerance} of ${expected}`);
await Physics.load();

const ball = (physics, position, mass = 1) =>
  physics.addBody(null, { position, colliders: { shape: 'sphere', radius: 0.25, mass } });

test('an explosion pushes bodies away from its centre, less with distance, and leaves what is out of reach', () => {
  const physics = new Physics(null);
  physics.gravity = [0, 0, 0];
  const near1 = ball(physics, [1, 0, 0]),
    far = ball(physics, [3, 0, 0]),
    out = ball(physics, [6, 0, 0]),
    wall = physics.addBody(null, { type: 'fixed', position: [2, 0, 1], colliders: { shape: 'sphere', radius: 0.2 } });
  const pushed = explosion(physics, [0, 0, 0], { impulse: 10, radius: 5 });
  assert.ok(pushed.includes(near1) && pushed.includes(far));
  assert.ok(!pushed.includes(out) && !pushed.includes(wall));
  physics.step();
  near(near1.linearVelocity[0], 10 * (1 - 1 / 5), 0.05, 'a metre out: four fifths of the impulse');
  near(far.linearVelocity[0], 10 * (1 - 3 / 5), 0.05, 'three metres out: two fifths');
  assert.equal(out.linearVelocity[0], 0);
  const lifted = ball(physics, [0, 0, 1.5]);
  explosion(physics, [0, 0, 0], { impulse: 10, radius: 5, falloff: 'none', lift: 0.5 });
  physics.step();
  assert.ok(lifted.linearVelocity[1] > 4, `lift adds an upward share: ${lifted.linearVelocity[1]}`);
  assert.throws(() => explosion(physics, [0, 0, 0], { impulse: 0, radius: 1 }), RangeError);
  assert.throws(() => explosion(physics, [0, 0, 0], { impulse: 1, radius: 1, falloff: 'x' }), RangeError);
});

test('a wind drags bodies toward its speed, a light one faster, and only inside its region', () => {
  const physics = new Physics(null);
  physics.gravity = [0, 0, 0];
  const light = ball(physics, [0, 0, 0], 0.2),
    heavy = ball(physics, [0, 2, 0], 20),
    outside = ball(physics, [0, 0, 30], 0.2);
  const wind = new WindField(physics, { velocity: [10, 0, 0], region: { min: [-5, -5, -5], max: [5, 5, 5] } });
  for (let i = 0; i < 180; i++) physics.step();
  assert.ok(
    light.linearVelocity[0] > 5 && light.linearVelocity[0] < 10.01,
    `the light body nears the wind: ${light.linearVelocity[0]}`,
  );
  assert.ok(
    heavy.linearVelocity[0] > 0 && heavy.linearVelocity[0] < light.linearVelocity[0],
    'the heavy one is slower',
  );
  assert.equal(outside.linearVelocity[0], 0, 'out of the region it is calm');
  wind.remove();
  const before = light.linearVelocity[0];
  for (let i = 0; i < 30; i++) physics.step();
  near(light.linearVelocity[0], before, 1e-6, 'a stopped wind blows no more');
});

test('a wind may be a function of the point and the time, and is checked', () => {
  const physics = new Physics(null);
  physics.gravity = [0, 0, 0];
  const leaf = ball(physics, [0, 0, 0], 0.1);
  new WindField(physics, { velocity: (_point, time) => [0, time < 0.5 ? 0 : 8, 0] });
  for (let i = 0; i < 20; i++) physics.step();
  assert.equal(leaf.linearVelocity[1], 0, 'calm before the gust');
  for (let i = 0; i < 120; i++) physics.step();
  assert.ok(leaf.linearVelocity[1] > 3, `the gust carries it: ${leaf.linearVelocity[1]}`);
  assert.throws(() => new WindField(physics, { velocity: [1, 0, 0], density: 0 }), RangeError);
  assert.throws(() => new WindField(physics, { velocity: [1, 0] }), RangeError);
});
