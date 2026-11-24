import test from 'node:test';
import assert from 'node:assert/strict';
import { PhysicalCamera } from '@margoengine/cameras/physical';
import { FocusTracker, focusOutput } from '../dist/lens.js';
import { CameraBrain, VirtualCamera, createPose } from '../dist/brain.js';

const near = (a, b, limit = 1e-9) => assert.ok(Math.abs(a - b) <= limit, `${a} is not ${b} within ${limit}`);
const fixes = (pattern) => (error) => {
  assert.ok(error instanceof RangeError, `${error.name}: ${error.message}`);
  assert.match(error.message, pattern);
  assert.match(error.message, /;/);
  return true;
};
const pose = () => createPose({ position: [0, 0, 10], target: [0, 0, 0], fov: 50 });
const step = (stage, delta) => {
  const p = pose();
  stage.update(p, delta);
  return p;
};

test('focus is the depth along the view, not the straight distance', () => {
  const lens = new FocusTracker([3, 4, 2]);
  near(step(lens, 0).focusDistance, 8);
  assert.equal(step(lens, 0).fov, 50, 'without a size the field of view stays');
});

test('the focus racks at its rate at any frame rate, and reset is sharp at once', () => {
  const run = (frames) => {
    const point = [0, 0, 8],
      lens = new FocusTracker(() => point, { focusDamping: 3 });
    step(lens, 0);
    point[2] = -10;
    for (let i = 0; i < frames; i++) step(lens, 0.5 / frames);
    return { lens, focus: lens.focus };
  };
  const one = run(1);
  near(one.focus, 20 + (2 - 20) * Math.exp(-1.5));
  near(run(50).focus, one.focus);
  one.lens.reset();
  near(step(one.lens, 1 / 60).focusDistance, 20);
});

test('offset shifts the focus, and it never comes nearer than minFocus', () => {
  near(step(new FocusTracker([0, 0, 0], { focusOffset: -0.5 }), 0).focusDistance, 9.5);
  assert.equal(step(new FocusTracker([0, 0, 20], { minFocus: 0.3 }), 0).focusDistance, 0.3);
});

test('size holds the subject at its share of the screen by closed form, as it moves', () => {
  const point = [0, 0, 0],
    lens = new FocusTracker(() => point, { size: 2, screenHeight: 0.25, minFov: 1, maxFov: 170 });
  for (const z of [0, -10, 6, 8]) {
    point[2] = z;
    lens.reset();
    const p = step(lens, 0),
      depth = 10 - z;
    // Screen height at the subject's depth is 2 depth tan(fov / 2).
    near(2 / (2 * depth * Math.tan((p.fov * Math.PI) / 360)), 0.25);
  }
});

test('the field of view stays in its limits and eases at its rate', () => {
  const point = [0, 0, 9.9],
    lens = new FocusTracker(() => point, { size: 2, maxFov: 80, minFov: 20, fovDamping: 2 });
  assert.equal(step(lens, 0).fov, 80);
  point[2] = -1000;
  assert.ok(step(lens, 0).fov === 80, 'a delta of 0 holds it');
  const p = step(lens, 0.5);
  near(p.fov, 20 + 60 * Math.exp(-1));
  point[2] = 50;
  lens.reset();
  assert.equal(step(lens, 0).fov, 80, 'a subject behind the camera asks for the widest');
});

test('focusOutput hands the focus to a real PhysicalCamera and on to a DOF, through a blend', () => {
  const physical = new PhysicalCamera({ focusDistance: 5 }),
    dof = { options: {} },
    brain = new CameraBrain({ blend: { duration: 1, ease: (u) => u } });
  brain.stages.push(focusOutput({ physical, dof }));
  brain.add({ position: [0, 0, 10], target: [0, 0, 0], stages: [new FocusTracker([0, 0, 8])] });
  const b = brain.add({ priority: -1, position: [0, 0, 10], target: [0, 0, 0], stages: [new FocusTracker([0, 0, -2])] });
  brain.update(0);
  near(physical.focusDistance, 2);
  near(dof.options.focalDistance, 2);
  b.priority = 1;
  brain.update(0);
  brain.update(0.5);
  near(physical.focusDistance, 7, 1e-9);
  near(dof.options.focalDistance, 7, 1e-9);
  const lens = {};
  physical.apply({ dof: { options: lens } });
  near(lens.focalDistance, 7);
});

test('with no focus on the pose the lens is left alone', () => {
  const physical = { focusDistance: 5 };
  focusOutput({ physical })(pose(), 0, { aspect: 1 });
  assert.equal(physical.focusDistance, 5);
});

test('works as a stage, and the camera reset reaches it', () => {
  const point = [0, 0, 0],
    camera = new VirtualCamera({ position: [0, 0, 10], stages: [new FocusTracker(() => point)] });
  near(camera.update(0).focusDistance, 10);
  point[2] = 5;
  camera.reset();
  assert.ok(camera.update(0).focusDistance < 6);
});

test('a view of no length leaves the pose as it is', () => {
  const p = createPose({ position: [1, 1, 1], target: [1, 1, 1] });
  new FocusTracker([0, 0, 0]).update(p, 0);
  assert.equal(p.focusDistance, 0);
});

test('errors say what to pass', () => {
  const point = [0, 0, 0];
  assert.throws(() => new FocusTracker(point, { focusDamping: 0 }), fixes(/damping/));
  assert.throws(() => new FocusTracker(point, { fovDamping: NaN }), fixes(/damping/));
  assert.throws(() => new FocusTracker(point, { focusOffset: NaN }), fixes(/focus/));
  assert.throws(() => new FocusTracker(point, { minFocus: 0 }), fixes(/focus/));
  assert.throws(() => new FocusTracker(point, { size: 0 }), fixes(/size/));
  assert.throws(() => new FocusTracker(point, { screenHeight: 2 }), fixes(/screenHeight/));
  assert.throws(() => new FocusTracker(point, { minFov: 50, maxFov: 40 }), fixes(/fov/));
  assert.throws(() => step(new FocusTracker([NaN, 0, 0]), 0), fixes(/target/));
});
