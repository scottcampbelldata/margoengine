import test from 'node:test';
import assert from 'node:assert/strict';
import {
  OrthographicCamera,
  OrthographicFraming,
  OrthographicGroupFraming,
  orthographicOutput,
} from '../dist/ortho.js';
import { CameraBrain, copyPose, createPose, rigStage } from '../dist/brain.js';
import { Cinematic } from '../dist/index.js';

const near = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) <= eps, `${a} != ${b}`);
const pose = (height = 10) => createPose({ position: [0, 0, 10], target: [0, 0, 0], orthographicHeight: height });
const context = { aspect: 2 };
const step = (stage, dt = 0, height = 10) => {
  const p = pose(height);
  stage.update(p, dt, context);
  return p;
};

test('copying a perspective pose clears stale orthographic state', () => {
  const output = pose(4);
  copyPose(output, createPose());
  assert.equal(output.orthographicHeight, undefined);
  copyPose(output, pose(12));
  assert.equal(output.orthographicHeight, 12);
});

test('orthographic follow keeps height while a rig follows a moving subject', () => {
  const rig = new Cinematic({ offset: [0, 0, 10], damping: 4 });
  rig.follow([0, 0, 0]);
  const camera = new OrthographicCamera({ height: 8, stages: [rigStage(rig)] });
  near(camera.update(0).orthographicHeight, 8);
  rig.follow([4, 0, 0]);
  const p = camera.update(1);
  assert.ok(p.position[0] > 0 && p.position[0] < 4);
  near(p.orthographicHeight, 8);
  near(p.position[0], rig.cameraPosition[0]);
  near(p.target[0], rig.cameraTarget[0]);
  assert.ok(p.target[0] > p.position[0] && p.target[0] < 4, 'look-at and follow keep their separate spring rates');
  camera.height = 12;
  near(camera.height, 12);
  near(camera.update(0).orthographicHeight, 12);
  assert.throws(() => {
    camera.height = 0;
  }, RangeError);
});

test('framing translates parallel view to exact screen point at every depth and roll', () => {
  for (const depth of [-20, 0, 8])
    for (const roll of [0, Math.PI / 2, -0.4]) {
      const stage = new OrthographicFraming([3, 2, depth], { screen: [0.25, 0.75] });
      const p = pose();
      p.roll = roll;
      stage.update(p, 0, context);
      const dx = 3 - p.position[0],
        dy = 2 - p.position[1];
      near(0.5 + (dx * Math.cos(roll) - dy * Math.sin(roll)) / 20, 0.25);
      near(0.5 - (dx * Math.sin(roll) + dy * Math.cos(roll)) / 10, 0.75);
      near(p.position[2] - p.target[2], 10);
      near(p.position[0], p.target[0]);
      near(p.position[1], p.target[1]);
      near(stage.onScreen[0], 0.25);
      near(stage.onScreen[1], 0.75);
    }
});

test('dead and soft zones constrain the actual output, and damping is frame-rate independent', () => {
  const run = (frames) => {
    const target = [0, 0, 0],
      stage = new OrthographicFraming(() => target, { damping: [2, 3], deadZone: [0.2, 0.2], softZone: [0.8, 0.8] });
    step(stage);
    target[0] = 6;
    let p;
    for (let i = 0; i < frames; i++) p = step(stage, 0.5 / frames);
    return { p, stage, target };
  };
  const one = run(1),
    many = run(50);
  near(one.p.position[0], many.p.position[0]);
  near(one.stage.onScreen[0], 0.5 + 0.1 + 0.2 * Math.exp(-1));
  one.target[0] = 1000;
  step(one.stage, 0);
  near(one.stage.onScreen[0], 0.9);
  one.stage.reset();
  step(one.stage);
  near(one.stage.onScreen[0], 0.5);
  const dead = new OrthographicFraming([0, 0, 0]);
  step(dead);
  dead.target = [0.5, 0, 0];
  near(step(dead, 1).position[0], 0);
});

test('lookahead, vertical suppression, custom up and vertical views remain finite', () => {
  const point = [0, 0, 0],
    stage = new OrthographicFraming(() => point, { lookahead: 0.5, lookaheadSmoothing: 3, lookaheadVertical: false });
  step(stage);
  point[0] = 1;
  point[1] = 2;
  step(stage, 1);
  near(stage.aimPoint[0], 1 + 0.5 * (1 - Math.exp(-3)));
  near(stage.aimPoint[1], 2);
  const vertical = createPose({ position: [0, 10, 0], target: [0, 0, 0], up: [0, 0, -1], orthographicHeight: 10 });
  new OrthographicFraming([1, 0, -2]).update(vertical, 0, context);
  near(vertical.position[0], 1);
  near(vertical.position[2], -2);
});

test('group framing fits spheres exactly with weight, aspect, depth, limits and dynamic membership', () => {
  const members = [
    { target: [-4, 0, 0], radius: 1 },
    { target: [4, 0, -100], radius: 1 },
  ];
  const stage = new OrthographicGroupFraming(members, { padding: 0.1 });
  const p = step(stage);
  near(p.orthographicHeight, 6.25);
  near(stage.center[0], 0);
  near(stage.center[2], -50);
  assert.equal(stage.fits, true);
  members[1].target[0] = 8;
  stage.members[1].weight = 3;
  stage.reset();
  const weighted = step(stage);
  near(stage.center[0], 5);
  near(weighted.orthographicHeight, 12.5);
  const limited = new OrthographicGroupFraming(members, { maxHeight: 3 });
  near(step(limited).orthographicHeight, 3);
  assert.equal(limited.fits, false);
  stage.members.splice(0, 2);
  const empty = step(stage);
  near(empty.orthographicHeight, 10);
  stage.members.push({ target: [0, 0, 0], radius: 2 });
  near(step(stage).orthographicHeight, 5);
});

test('group fitting accounts for portrait aspect, roll, and convergence with unchanged input', () => {
  for (const aspect of [0.5, 1, 2])
    for (const roll of [0, Math.PI / 2]) {
      const group = new OrthographicGroupFraming(
        [
          { target: [-4, 0, 0], radius: 1 },
          { target: [4, 0, 0], radius: 1 },
        ],
        { padding: 0 },
      );
      const p = pose();
      p.roll = roll;
      group.update(p, 0, { aspect });
      near(p.orthographicHeight, roll === 0 ? Math.max(2, 10 / aspect) : Math.max(2 / aspect, 10));
    }
  const group = new OrthographicGroupFraming([[0, 0, 0]], { minHeight: 2, damping: 2 });
  step(group);
  group.members.push({ target: [20, 0, 0] });
  const moved = step(group, 0.5);
  assert.ok(moved.orthographicHeight > 2);
  assert.equal(group.fits, false);
  const atZero = step(group, 0);
  near(atZero.orthographicHeight, moved.orthographicHeight);
});

test('brain blends full ortho height, live endpoints, interrupted blends and cuts', () => {
  const brain = new CameraBrain({ blend: { duration: 1, ease: (u) => u } });
  const output = { mode: 'perspective', height: 123, zoom: 3, left: -1, right: 1, top: 1, bottom: -1 };
  brain.stages.push(orthographicOutput(output));
  const a = brain.add(new OrthographicCamera({ name: 'a', height: 4 }));
  const b = brain.add(new OrthographicCamera({ name: 'b', height: 12, priority: -1 }));
  const c = brain.add(new OrthographicCamera({ name: 'c', height: 20, priority: -2 }));
  brain.update(0);
  near(output.height, 4);
  assert.equal(output.zoom, 1);
  assert.equal(output.left, undefined);
  b.priority = 1;
  brain.update(0);
  brain.update(0.5);
  near(output.height, 8);
  c.priority = 2;
  brain.update(0);
  near(output.height, 8);
  brain.update(0.25);
  near(output.height, 0.75 * 10 + 0.25 * 20);
  c.base.orthographicHeight = 24;
  brain.cut();
  brain.update(0);
  near(output.height, 24);
  a.priority = 3;
  brain.update(0);
  brain.update(1);
  near(output.height, 4);
  assert.equal(output.mode, 'orthographic');
});

test('projection mode switches at the end of a mixed-projection blend without inventing an ortho size', () => {
  const brain = new CameraBrain({ blend: { duration: 1, ease: (u) => u } });
  const output = { mode: 'orthographic', zoom: 1 };
  brain.stages.push(orthographicOutput(output));
  brain.add(new OrthographicCamera({ height: 4 }));
  const p = brain.add({ priority: -1 });
  brain.update(0);
  p.priority = 1;
  brain.update(0);
  brain.update(0.5);
  assert.equal(output.mode, 'orthographic');
  brain.update(0.5);
  assert.equal(output.mode, 'perspective');
});

test('bad authored height, targets, groups, aspect, delta and mutable weights reject', () => {
  for (const height of [0, -1, Infinity, NaN]) assert.throws(() => new OrthographicCamera({ height }), RangeError);
  assert.throws(() => new OrthographicFraming([0, 0, 0], { damping: Infinity }), RangeError);
  assert.throws(() => new OrthographicFraming([0, 0, 0], { screen: [2, 0] }), RangeError);
  assert.throws(() => new OrthographicGroupFraming([], { maxHeight: 0 }), RangeError);
  const f = new OrthographicFraming([0, 0, 0]);
  assert.throws(() => f.update(pose(), -1, context), RangeError);
  assert.throws(() => f.update(pose(), 0, { aspect: 0 }), RangeError);
  assert.throws(() => f.update(createPose(), 0, context), RangeError);
  f.target = [NaN, 0, 0];
  assert.throws(() => step(f), RangeError);
  const group = new OrthographicGroupFraming([{ target: [0, 0, 0], weight: Infinity }]);
  assert.throws(() => step(group), RangeError);
  const out = { mode: 'perspective', zoom: 2, height: 3 };
  const invalid = pose();
  invalid.orthographicHeight = -1;
  assert.throws(() => orthographicOutput(out)(invalid, 0, context), RangeError);
  assert.deepEqual(out, { mode: 'perspective', zoom: 2, height: 3 });
});
