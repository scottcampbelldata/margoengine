import test from 'node:test';
import assert from 'node:assert/strict';
import { FramingComposer } from '../dist/composer.js';
import { VirtualCamera, createPose } from '../dist/brain.js';

const near = (a, b, limit = 1e-9) => assert.ok(Math.abs(a - b) <= limit, `${a} is not ${b} within ${limit}`);
const fixes = (pattern) => (error) => {
  assert.ok(error instanceof RangeError, `${error.name}: ${error.message}`);
  assert.match(error.message, pattern);
  assert.match(error.message, /;/);
  return true;
};
const context = { aspect: 2 };
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const unit = (a) => a.map((v) => v / Math.hypot(...a));

/** Where a point lands, from the top left, by an independent look-at projection of the pose. */
function project(pose, point, aspect = 2) {
  const f = unit([0, 1, 2].map((i) => pose.target[i] - pose.position[i])),
    r = unit(cross(f, [...pose.up])),
    u = cross(r, f),
    d = [0, 1, 2].map((i) => point[i] - pose.position[i]),
    ty = Math.tan((pose.fov * Math.PI) / 360);
  return [(dot(d, r) / dot(d, f) / (ty * aspect) + 1) / 2, (1 - dot(d, u) / dot(d, f) / ty) / 2];
}
const pose = () => createPose({ position: [0, 2, 10], target: [0, 2, 0], fov: 50 });
const step = (stage, delta) => {
  const p = pose();
  stage.update(p, delta, context);
  return p;
};

test('the first update puts the subject exactly on its screen point, anywhere and at any height', () => {
  for (const screen of [
    [0.5, 0.5],
    [1 / 3, 2 / 3],
    [0.9, 0.1],
  ])
    for (const point of [
      [0, 0, 0],
      [3, 7, -4],
      [-20, -3, 30],
      [5, 9, 9],
    ]) {
      const composer = new FramingComposer(point, { screen }),
        at = project(step(composer, 1 / 60), point);
      near(at[0], screen[0], 1e-9);
      near(at[1], screen[1], 1e-9);
    }
});

test('another world up works the same, with no roll against it', () => {
  const p = createPose({ position: [0, 0, 10], target: [0, 0, 0], up: [0, 0, 1], fov: 50 }),
    point = [4, 3, 2];
  new FramingComposer(point, { screen: [0.4, 0.6] }).update(p, 0, context);
  const at = project(p, point);
  near(at[0], 0.4);
  near(at[1], 0.6);
  const f = unit([0, 1, 2].map((i) => p.target[i] - p.position[i]));
  near(dot(cross(f, [0, 0, 1]), [0, 0, 1]), 0);
});

test('inside the dead zone the view does not move at all', () => {
  const point = [0, 2, 0],
    composer = new FramingComposer(() => point, { deadZone: [0.2, 0.2] }),
    first = step(composer, 0);
  point[0] = 0.3; // 0.3 / (10 tan(25 deg) 2) of a half screen is 0.03, within the half size of 0.2.
  const next = step(composer, 1 / 60),
    view = (p) => unit([0, 1, 2].map((i) => p.target[i] - p.position[i]));
  for (let i = 0; i < 3; i++) near(view(next)[i], view(first)[i], 1e-12);
  near(composer.onScreen[0], project(next, point)[0]);
  assert.ok(composer.onScreen[0] > 0.5);
});

test('between the zones what lies past the dead edge decays at the rate, whatever the frame rate', () => {
  const run = (frames, rate) => {
    const point = [0, 2, 0],
      composer = new FramingComposer(() => point, { deadZone: [0.1, 0.1], softZone: [1.8, 1.8], damping: rate });
    step(composer, 0);
    point[0] = 3;
    step(composer, 0);
    const start = composer.onScreen[0];
    for (let i = 0; i < frames; i++) step(composer, 0.5 / frames);
    return [start, composer.onScreen[0]];
  };
  const [start, end] = run(1, 4),
    [, fine] = run(120, 4),
    edge = 0.55;
  near(end - edge, (start - edge) * Math.exp(-2), 1e-12);
  near(fine, end, 1e-9);
});

test('settles on the dead edge, not on the screen point', () => {
  const point = [0, 2, 0],
    composer = new FramingComposer(() => point, { deadZone: [0.2, 0.1] });
  step(composer, 0);
  point[0] = 5;
  point[1] = -1;
  for (let i = 0; i < 600; i++) step(composer, 1 / 60);
  near(composer.onScreen[0], 0.6, 1e-6);
  near(composer.onScreen[1], 0.55, 1e-6);
});

test('the subject never leaves the soft zone, however fast it goes', () => {
  const point = [0, 2, 0],
    composer = new FramingComposer(() => point, { softZone: [0.5, 0.4], damping: 0.01 });
  step(composer, 0);
  for (let i = 1; i <= 200; i++) {
    point[0] = Math.sin(i) * 50;
    point[1] = Math.cos(i * 1.7) * 30;
    point[2] = -Math.abs(Math.sin(i * 0.3)) * 40;
    const at = project(step(composer, 1 / 60), point);
    assert.ok(Math.abs(at[0] - 0.5) <= 0.25 + 1e-9, `x ${at[0]} at ${i}`);
    assert.ok(Math.abs(at[1] - 0.5) <= 0.2 + 1e-9, `y ${at[1]} at ${i}`);
  }
});

test('a subject that passes behind the camera comes back to the soft edge on its side', () => {
  const point = [1, 2, 0],
    composer = new FramingComposer(() => point, { softZone: [0.6, 0.6] });
  step(composer, 0);
  point[2] = 20; // Behind the camera at z = 10, to its right.
  const p = step(composer, 1 / 60),
    at = project(p, point);
  near(at[0], 0.8, 1e-9);
  assert.ok(dot(unit([0, 1, 2].map((i) => p.target[i] - p.position[i])), unit([1, 0, 10])) > 0.5);
});

test('lookahead aims along the velocity by its time, and off for vertical leaves height alone', () => {
  const run = (vertical) => {
    const point = [0, 2, 0],
      composer = new FramingComposer(() => point, {
        lookahead: 0.5,
        lookaheadSmoothing: 8,
        lookaheadVertical: vertical,
      });
    for (let i = 0; i < 600; i++) {
      point[0] = i * 0.05; // 3 units a second at 1/60 s.
      point[1] = 2 + i * 0.01; // 0.6 units a second.
      step(composer, 1 / 60);
    }
    return [composer.aimPoint[0] - point[0], composer.aimPoint[1] - point[1]];
  };
  const [x, y] = run(true);
  near(x, 1.5, 1e-6);
  near(y, 0.3, 1e-6);
  const [x2, y2] = run(false);
  near(x2, 1.5, 1e-6);
  near(y2, 0, 1e-12);
});

test('a still subject has no lookahead, and a delta of 0 measures no velocity', () => {
  const point = [1, 2, 3],
    composer = new FramingComposer(() => point, { lookahead: 2 });
  step(composer, 0);
  point[0] = 9;
  step(composer, 0);
  near(composer.aimPoint[0], 9);
});

test('reset snaps back to the screen point and forgets the velocity', () => {
  const point = [0, 2, 0],
    composer = new FramingComposer(() => point, { lookahead: 1 });
  step(composer, 1 / 60);
  point[0] = 2;
  step(composer, 1 / 60);
  point[0] = 8;
  composer.reset();
  const at = project(step(composer, 1 / 60), point);
  near(at[0], 0.5);
  near(composer.aimPoint[0], 8);
});

test('a camera standing on its subject keeps its view', () => {
  const point = [0, 2, 0],
    composer = new FramingComposer(() => point);
  step(composer, 0);
  point[2] = 10;
  const p = step(composer, 0);
  near(p.target[0], 0);
  assert.ok(p.target[2] < 10, 'still looking the same way');
  const first = new FramingComposer([0, 2, 10]);
  assert.deepEqual([...step(first, 0).target], [0, 2, 0], 'with no view yet the authored one stands');
});

test('a subject straight overhead stops short of the pole and stays finite', () => {
  const p = createPose({ position: [0, 0, 0], target: [0, 0, -1] }),
    composer = new FramingComposer([0, 10, 0]);
  composer.update(p, 0, context);
  assert.ok(p.target.every(Number.isFinite));
  const f = unit([...p.target]);
  assert.ok(f[1] < 1 && f[1] > 0.999);
});

test('works as a stage of a virtual camera, and the camera reset reaches it', () => {
  const point = [0, 2, 0],
    composer = new FramingComposer(() => point),
    camera = new VirtualCamera({ position: [0, 2, 10], target: [0, 2, 0], stages: [composer] });
  camera.update(0, 2);
  point[0] = 4;
  camera.update(0, 2);
  assert.ok(composer.onScreen[0] > 0.6);
  camera.reset();
  camera.update(0, 2);
  near(composer.onScreen[0], 0.5);
  near(project(camera.pose, point)[0], 0.5);
});

test('errors say what to pass', () => {
  const point = [0, 0, 0];
  assert.throws(() => new FramingComposer(point, { screen: [2, 0] }), fixes(/screen/));
  assert.throws(() => new FramingComposer(point, { screen: [0.5] }), fixes(/screen/));
  assert.throws(() => new FramingComposer(point, { deadZone: [-1, 0] }), fixes(/zones/));
  assert.throws(() => new FramingComposer(point, { deadZone: [0.5, 0.5], softZone: [0.4, 0.8] }), fixes(/zones/));
  assert.throws(() => new FramingComposer(point, { damping: 0 }), fixes(/damping/));
  assert.throws(() => new FramingComposer(point, { damping: [1, NaN] }), fixes(/damping/));
  assert.throws(() => new FramingComposer(point, { lookahead: -1 }), fixes(/lookahead/));
  assert.throws(() => new FramingComposer(point, { lookaheadSmoothing: 0 }), fixes(/lookahead/));
  assert.throws(() => step(new FramingComposer([NaN, 0, 0]), 0), fixes(/target/));
  assert.throws(() => step(new FramingComposer(() => [0, 0]), 0), fixes(/target/));
  const flat = createPose();
  flat.up.fill(0);
  assert.throws(() => new FramingComposer(point).update(flat, 0, context), fixes(/up/));
});
