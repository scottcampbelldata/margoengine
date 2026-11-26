import test from 'node:test';
import assert from 'node:assert/strict';
import { OrbitControls } from '../dist/transitions.js';
import { OrbitBehaviors } from '../dist/behaviors.js';
import { camera, FakeElement, close } from './control-fakes.js';

const rig = (distance, options) => {
  const cam = camera({ position: [0, 0, distance] }),
    control = new OrbitControls(cam, new FakeElement());
  control.minDistance = 2;
  control.maxDistance = 10;
  return { cam, control, behaviors: new OrbitBehaviors(control, options) };
};
const run = (r, seconds) => {
  for (let i = 0; i < seconds * 60; i++) {
    r.behaviors.update(1 / 60);
    r.control.update(1 / 60);
  }
};
const dist = (cam) => Math.hypot(...cam.position.map((v, i) => v - cam.target[i]));

test('bounce widens the hard limits and springs back to the soft limit after input ends', () => {
  const r = rig(11.5, { bounce: true });
  close(r.control.maxDistance, 12, 1e-9);
  close(r.control.minDistance, 1.6, 1e-9);
  r.control.dispatchEvent({ type: 'start' });
  run(r, 0.5);
  close(dist(r.cam), 11.5, 1e-9, 'held while the input is active');
  r.control.dispatchEvent({ type: 'end' });
  run(r, 2);
  close(dist(r.cam), 10, 1e-3, 'back at the soft limit');
});
test('bounce pulls an overshoot at the near limit back out', () => {
  const r = rig(1.8, { bounce: { overshoot: 0.2, damping: 1 } });
  run(r, 2);
  close(dist(r.cam), 2, 1e-3);
});
test('no bounce means the distance inside the widened limits stays put', () => {
  const r = rig(5, { bounce: true });
  run(r, 1);
  close(dist(r.cam), 5, 1e-9);
});
test('auto-rotation waits, then spins, and any input stops it and restarts the wait', () => {
  const r = rig(5, { autoRotate: { wait: 2, speed: 2 } });
  const a0 = r.cam.position.slice();
  run(r, 1.5);
  assert.equal(r.control.autoRotate, false);
  close(r.cam.position[0], a0[0], 1e-9);
  run(r, 1);
  assert.equal(r.control.autoRotate, true);
  assert.ok(Math.abs(r.cam.position[0] - a0[0]) > 1e-4, 'turned');
  r.control.dispatchEvent({ type: 'start' });
  r.behaviors.update(1 / 60);
  assert.equal(r.control.autoRotate, false);
  r.control.dispatchEvent({ type: 'end' });
  run(r, 1);
  assert.equal(r.control.autoRotate, false);
});
test('frame animates to a box or model bounds and dispose stops listening', async () => {
  const r = rig(5, {});
  const done = r.behaviors.frame({ bounds: [-1, -1, -1, 1, 1, 1] }, { duration: 0.2 });
  for (let i = 0; i < 30; i++) r.control.update(1 / 60);
  assert.equal(await done, true);
  assert.ok(Math.abs(r.cam.target[0]) < 1e-9);
  r.behaviors.dispose();
  assert.equal(r.control.hasEventListener('start', r.behaviors.start), false);
});
test('bad options and a control without transitions throw a RangeError that names the fix', async () => {
  assert.throws(() => rig(5, { bounce: { stiffness: -1 } }), (e) => e instanceof RangeError && /pass valid options/.test(e.message));
  assert.throws(() => rig(5, { autoRotate: { wait: -1 } }), RangeError);
  const cam = camera();
  const plain = new (await import('../dist/orbit.js')).OrbitControls(cam, new FakeElement());
  assert.throws(() => new OrbitBehaviors(plain).frame({ min: [0, 0, 0], max: [1, 1, 1] }), /import it from there/);
});
