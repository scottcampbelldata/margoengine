// 2D joints through the facade: the motor's two models, a spring joint at its static extension, and the `collide` option.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Physics2D } from '../dist/index.js';

await Physics2D.load();
const world = (options = {}) => new Physics2D(null, { pixelsPerMeter: 1, gravity: [0, 0], ...options });
const near = (actual, expected, bound, message) =>
  assert.ok(Math.abs(actual - expected) <= bound, `${message}: ${actual} is not within ${bound} of ${expected}`);

function spinAfter(mass, model) {
  const physics = world();
  const pivot = physics.addBody(null, { type: 'fixed' });
  const disc = physics.addBody(null, { colliders: { shape: 'circle', radius: 1, mass } });
  physics.addJoint(pivot, disc, { type: 'revolute', motor: { targetVelocity: 4, factor: 2, model } });
  for (let i = 0; i < 18; i++) physics.step();
  return disc.angularVelocity;
}

test('a motor in the acceleration model follows its target alike for a light and a heavy body, the force model does not', () => {
  const [lightA, heavyA] = [2, 8].map((m) => spinAfter(m, 'acceleration')),
    [lightF, heavyF] = [2, 8].map((m) => spinAfter(m, 'force'));
  near(lightA, heavyA, 0.05, 'acceleration: mass makes no difference');
  assert.ok(lightA > 1 && lightA < 4, `and it is on its way: ${lightA}`);
  assert.ok(lightF > heavyF * 1.5, `force: the heavy body lags (${lightF} against ${heavyF})`);
  const physics = world();
  const a = physics.addBody(null, { type: 'fixed' }),
    b = physics.addBody(null, { colliders: { shape: 'circle', radius: 1 } });
  assert.throws(
    () => physics.addJoint(a, b, { type: 'revolute', motor: { targetVelocity: 1, model: 'nonsense' } }),
    RangeError,
  );
});

test('a spring joint settles at its rest length plus the static extension m g / k', () => {
  const physics = world({ gravity: [0, -9.81] });
  const anchor = physics.addBody(null, { type: 'fixed' });
  const weight = physics.addBody(null, { position: [0, -1], colliders: { shape: 'circle', radius: 0.1, mass: 1 } });
  physics.addJoint(anchor, weight, { type: 'spring', restLength: 1, stiffness: 40, damping: 6 });
  for (let i = 0; i < 600; i++) physics.step();
  near(Math.hypot(weight.position[0], weight.position[1]), 1 + 9.81 / 40, 0.01, 'the hanging length');
});

test('bodies a joint holds do not collide unless `collide` says so', () => {
  const gap = (collide) => {
    const physics = world();
    const a = physics.addBody(null, { position: [0, 0], colliders: { shape: 'circle', radius: 1 } });
    const b = physics.addBody(null, { position: [0.5, 0], colliders: { shape: 'circle', radius: 1 } });
    physics.addJoint(a, b, { type: 'revolute', anchorA: [0.25, 0], anchorB: [-0.25, 0], collide });
    for (let i = 0; i < 60; i++) physics.step();
    return Math.hypot(a.position[0] - b.position[0], a.position[1] - b.position[1]);
  };
  near(gap(false), 0.5, 0.01, 'no collision: they overlap as made');
  assert.ok(gap(true) > 0.5, 'collide: the circles push apart where the joint lets them');
});
