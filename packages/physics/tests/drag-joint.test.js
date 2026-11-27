// A drag joint pulls a point of a body toward a target with a spring set by a frequency and a damping ratio.
import assert from 'node:assert/strict';
import test from 'node:test';
import { DragJoint, Physics } from '../dist/index.js';

const near = (actual, expected, tolerance, label) =>
  assert.ok(Math.abs(actual - expected) <= tolerance, `${label}: ${actual} is not within ${tolerance} of ${expected}`);
await Physics.load();

const grab = (mass) => {
  const physics = new Physics(null);
  const body = physics.addBody(null, {
    position: [0, 2, 0],
    colliders: { shape: 'box', halfExtents: [0.25, 0.25, 0.25], mass },
  });
  return { physics, body };
};

test('a dragged body follows its target and hangs a little below it by gravity over the stiffness, whatever its mass', () => {
  for (const mass of [0.5, 40]) {
    const { physics, body } = grab(mass);
    const drag = new DragJoint(physics, body, [0, 2, 0], { frequency: 5, damping: 1 });
    drag.setTarget([1.5, 3, -0.5]);
    for (let i = 0; i < 300; i++) physics.step();
    const hang = 9.81 / (2 * Math.PI * 5) ** 2;
    near(body.position[0], 1.5, 0.03, `x at mass ${mass}`);
    near(body.position[1], 3 - hang, 0.04, `y at mass ${mass} sags by g over omega squared`);
    near(body.position[2], -0.5, 0.03, `z at mass ${mass}`);
  }
});

test('a drag joint takes the body by a point off its centre and turns it, and lets go on remove', () => {
  const { physics, body } = grab(2);
  physics.gravity = [0, 0, 0];
  const drag = new DragJoint(physics, body, [0.25, 2, 0]);
  drag.setTarget([0.25, 2, 1]);
  for (let i = 0; i < 90; i++) physics.step();
  assert.ok(
    Math.abs(body.angularVelocity[1]) > 0.05 || Math.abs(body.rotation[1]) > 0.01,
    'the body turns about the grip',
  );
  const grip = drag.gripPoint();
  near(grip[2], 1, 0.15, 'the grabbed point reaches the target');
  drag.remove();
  drag.remove();
  const before = [...body.position];
  for (let i = 0; i < 60; i++) physics.step();
  assert.ok(Math.hypot(...body.position.map((v, k) => v - before[k])) < 3, 'it carries on freely');
});

test('a drag joint is checked', () => {
  const { physics, body } = grab(1);
  assert.throws(() => new DragJoint(physics, body, [0, 0], {}), RangeError);
  assert.throws(() => new DragJoint(physics, body, [0, 2, 0], { frequency: 0 }), { code: 'unsupported' });
  assert.throws(() => new DragJoint(physics, body, [0, 2, 0], { damping: -1 }), { code: 'unsupported' });
  const fixed = physics.addBody(null, { type: 'fixed' });
  assert.throws(() => new DragJoint(physics, fixed, [0, 0, 0]), { code: 'unsupported' });
});
