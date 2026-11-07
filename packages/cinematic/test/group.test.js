import test from 'node:test';
import assert from 'node:assert/strict';
import { GroupFraming } from '../dist/group.js';
import { createPose, VirtualCamera } from '../dist/brain.js';
import { createRandom } from '@margoengine/math/mathutils';

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

/** The largest reach of a sphere on either screen axis, as a share of the half screen, by the planes of the view. */
function reach(pose, spheres, aspect = 2) {
  const f = unit([0, 1, 2].map((i) => pose.target[i] - pose.position[i])),
    r = unit(cross(f, [...pose.up])),
    u = cross(r, f),
    ty = Math.tan((pose.fov * Math.PI) / 360);
  let most = 0;
  for (const { center, radius = 0 } of spheres) {
    const d = [0, 1, 2].map((i) => center[i] - pose.position[i]);
    for (const [axis, tan] of [
      [r, ty * aspect],
      [u, ty],
    ]) {
      const side = Math.abs(dot(d, axis)),
        depth = dot(d, f),
        angle = Math.atan2(side, depth) + Math.asin(radius / Math.hypot(side, depth));
      most = Math.max(most, Math.tan(angle) / tan);
    }
  }
  return most;
}
const pose = (fov = 50) => createPose({ position: [0, 6, 20], target: [0, 1, 0], fov });

test('dolly fits points exactly to the padded frame, from any angle', () => {
  const random = createRandom(7);
  for (let trial = 0; trial < 50; trial++) {
    const points = Array.from({ length: 2 + Math.floor(random() * 5) }, () => [
        random() * 40 - 20,
        random() * 10,
        random() * 40 - 20,
      ]),
      group = new GroupFraming(points, { padding: 0.1, minDistance: 0.001 }),
      p = createPose({ position: [random() * 20 - 10, 10 + random() * 5, 20], target: [0, 0, 0], fov: 30 + random() * 40 });
    group.update(p, 0, context);
    near(reach(p, points.map((center) => ({ center }))), 0.8, 1e-9);
  }
});

test('radii count: a sphere touches the padded frame and does not cross it', () => {
  const spheres = [
      { center: [-8, 1, 0], radius: 2 },
      { center: [9, 3, -4], radius: 0.5 },
      { center: [0, 7, 3], radius: 3 },
    ],
    group = new GroupFraming(
      spheres.map((s) => ({ target: s.center, radius: s.radius })),
      { padding: 0.05 },
    ),
    p = pose();
  group.update(p, 0, context);
  near(reach(p, spheres), 0.9, 1e-9);
});

test('the view keeps the angle the pose gave it, and the target is the weighted centre', () => {
  const group = new GroupFraming([
      { target: [0, 0, 0], weight: 3 },
      { target: [8, 0, 0], weight: 1 },
    ]),
    p = pose(),
    before = unit([0, 1, 2].map((i) => p.position[i] - p.target[i]));
  group.update(p, 0, context);
  assert.deepEqual([...p.target], [2, 0, 0]);
  const after = unit([0, 1, 2].map((i) => p.position[i] - p.target[i]));
  for (let i = 0; i < 3; i++) near(after[i], before[i]);
  near(group.center[0], 2);
});

test('zoom holds the camera still and finds the field of view that fits', () => {
  const points = [
      [-6, 0, 0],
      [6, 2, -3],
      [0, 5, 1],
    ],
    group = new GroupFraming(points, { mode: 'zoom', padding: 0.1 }),
    p = pose();
  group.update(p, 0, context);
  assert.deepEqual([...p.position], [0, 6, 20]);
  near(reach(p, points.map((center) => ({ center }))), 0.8, 1e-9);
  assert.equal(group.fits, true);
});

test('zoom stops at its limits and says so', () => {
  const wide = new GroupFraming([[-100, 0, 0], [100, 0, 0]], { mode: 'zoom', maxFov: 40 }),
    p = pose();
  wide.update(p, 0, context);
  assert.equal(p.fov, 40);
  assert.equal(wide.fits, false);
  const tight = new GroupFraming([[0, 0, 0], [0.01, 0, 0]], { mode: 'zoom', minFov: 20 }),
    q = pose();
  tight.update(q, 0, context);
  assert.equal(q.fov, 20);
  assert.equal(tight.fits, true);
  const behind = new GroupFraming([[0, 0, 0], [0, 0, 100]], { mode: 'zoom' }),
    r = pose();
  behind.update(r, 0, context);
  assert.equal(r.fov, 100, 'a member behind the camera needs all the lens there is');
  assert.equal(behind.fits, false);
});

test('dolly stops at its limits and says so', () => {
  const far = new GroupFraming([[-100, 0, 0], [100, 0, 0]], { maxDistance: 30 }),
    p = pose();
  far.update(p, 0, context);
  near(Math.hypot(...[0, 1, 2].map((i) => p.position[i] - p.target[i])), 30);
  assert.equal(far.fits, false);
  const close = new GroupFraming([[0, 0, 0]], { minDistance: 6 }),
    q = pose();
  close.update(q, 0, context);
  near(Math.hypot(...[0, 1, 2].map((i) => q.position[i] - q.target[i])), 6);
  assert.equal(close.fits, true);
});

test('both moves first and zooms only for what the limit left', () => {
  const points = [
      [-30, 0, 0],
      [30, 0, 0],
    ],
    free = new GroupFraming(points, { mode: 'both' }),
    a = pose();
  free.update(a, 0, context);
  assert.equal(a.fov, 50, 'room to move: the lens stays');
  const held = new GroupFraming(points, { mode: 'both', maxDistance: 25 }),
    b = pose();
  held.update(b, 0, context);
  assert.ok(b.fov > 50);
  near(Math.hypot(...[0, 1, 2].map((i) => b.position[i] - b.target[i])), 25);
  near(reach(b, points.map((center) => ({ center }))), 0.8, 1e-9);
  assert.equal(held.fits, true);
});

test('the shot follows at its rate at any frame rate, and reset snaps', () => {
  const simulate = (frames) => {
    const a = [0, 0, 0],
      group = new GroupFraming([() => a, [4, 0, 0]], { damping: 3 });
    group.update(pose(), 0, context);
    a[0] = 20;
    let p;
    for (let i = 0; i < frames; i++) {
      p = pose();
      group.update(p, 0.5 / frames, context);
    }
    return { x: group.center[0], d: Math.hypot(...[0, 1, 2].map((i) => p.position[i] - p.target[i])), group, a };
  };
  const one = simulate(1),
    fine = simulate(60);
  near(one.x, 12 + (2 - 12) * Math.exp(-1.5));
  near(fine.x, one.x, 1e-9);
  one.group.reset();
  one.group.update(pose(), 1 / 60, context);
  near(one.group.center[0], 12);
});

test('a member of weight 0 leaves the shot, and with nobody left the pose stands', () => {
  const group = new GroupFraming([
      { target: [0, 0, 0] },
      { target: [1000, 0, 0], weight: 0 },
    ]),
    p = pose();
  group.update(p, 0, context);
  assert.deepEqual([...p.target], [0, 0, 0]);
  near(Math.hypot(...p.position), 1, 1e-9);
  group.members.length = 0;
  const q = pose();
  group.update(q, 0, context);
  assert.deepEqual([...q.position], [0, 6, 20]);
});

test('a view along up and a camera on its target still work', () => {
  const group = new GroupFraming([[-5, 0, 0], [5, 0, 0]]),
    p = createPose({ position: [0, 20, 0], target: [0, 0, 0], fov: 50 });
  group.update(p, 0, context);
  assert.ok(p.position.every(Number.isFinite));
  assert.ok(p.position[1] > 0);
  const flat = new GroupFraming([[-5, 0, 0], [5, 0, 0]]),
    q = createPose({ position: [0, 0, 0], target: [0, 0, 0], fov: 50 });
  flat.update(q, 0, context);
  assert.ok(q.position[2] > 0, 'it backs off along +z');
});

test('works as a stage, and members can be added later', () => {
  const group = new GroupFraming([[0, 0, 0]], { minDistance: 0.001 }),
    camera = new VirtualCamera({ position: [0, 0, 10], target: [0, 0, 0], stages: [group] });
  camera.update(0, 2);
  group.members.push({ target: [10, 0, 0] });
  camera.reset();
  const out = camera.update(0, 2);
  assert.equal(out.target[0], 5);
});

test('errors say what to pass', () => {
  const list = [[0, 0, 0]];
  assert.throws(() => new GroupFraming(list, { mode: 'x' }), fixes(/mode/));
  assert.throws(() => new GroupFraming(list, { padding: 0.5 }), fixes(/padding/));
  assert.throws(() => new GroupFraming(list, { minDistance: 0 }), fixes(/distance/));
  assert.throws(() => new GroupFraming(list, { minDistance: 5, maxDistance: 2 }), fixes(/distance/));
  assert.throws(() => new GroupFraming(list, { minFov: 50, maxFov: 40 }), fixes(/fov/));
  assert.throws(() => new GroupFraming(list, { maxFov: 180 }), fixes(/fov/));
  assert.throws(() => new GroupFraming(list, { damping: 0 }), fixes(/damping/));
  assert.throws(() => new GroupFraming([{ target: [0, 0, 0], radius: -1 }]), fixes(/member/));
  assert.throws(() => new GroupFraming([{ target: [0, 0, 0], weight: -1 }]), fixes(/member/));
  assert.throws(() => new GroupFraming([[NaN, 0, 0]]).update(pose(), 0, context), fixes(/target/));
});
