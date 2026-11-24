// One generic joint with limits on two or three of its turning axes at once: each axis stops at its own edge.
import assert from 'node:assert/strict';
import test from 'node:test';
import { Physics } from '../dist/index.js';

function spin(axes, spinOf) {
  const physics = new Physics(null, { gravity: [0, 0, 0] });
  const wall = physics.addBody(null, { type: 'fixed' });
  const body = physics.addBody(null, { colliders: { shape: 'sphere', radius: 0.3, mass: 1 } });
  const limits = {};
  for (const dof of axes) limits[dof] = [-0.3, 0.3];
  physics.addJoint(wall, body, { type: 'generic', locked: ['linX', 'linY', 'linZ'], limits });
  body.setAngularVelocity(spinOf);
  for (let i = 0; i < 90; i++) physics.step();
  const q = body.rotation;
  physics.dispose();
  return q;
}
// A turn of 0.3 rad about one axis has the quaternion component sin(0.15) about it.
const EDGE = Math.sin(0.15);
const near = (actual, expected, bound, message) =>
  assert.ok(Math.abs(actual - expected) <= bound, `${message}: ${actual} is not within ${bound} of ${expected}`);

test('limits on all three turning axes stop a spin about each at 0.3 rad, alone', async () => {
  await Physics.load();
  for (const [k, axis] of [
    [0, [3, 0, 0]],
    [1, [0, 3, 0]],
    [2, [0, 0, 3]],
  ]) {
    const q = spin(['angX', 'angY', 'angZ'], axis);
    near(q[k], EDGE, 0.01, `axis ${k} stops at its edge`);
    for (const other of [0, 1, 2].filter((j) => j !== k)) near(q[other], 0, 0.01, `axis ${other} stays put`);
  }
  // The same spin in the other direction stops at the other edge.
  const back = spin(['angX', 'angY', 'angZ'], [0, -3, 0]);
  near(back[1], -EDGE, 0.01, 'the minimum edge');
});

test('limits on two axes hold both at once, and a free third turns freely', async () => {
  await Physics.load();
  const q = spin(['angX', 'angY'], [3, 3, 0]);
  near(q[0], EDGE, 0.03, 'X stops at its edge');
  near(q[1], EDGE, 0.03, 'Y stops at its edge');
  const free = spin(['angX', 'angY'], [0, 0, 3]);
  // Z has no limit: three seconds at 3 rad/s is past half a turn, so the sine of half the angle is not the edge.
  assert.ok(Math.abs(free[2]) > 0.5 || Math.abs(free[3]) < 0.9, `a free axis keeps turning: ${free}`);
});
