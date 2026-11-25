// ThirdPersonControls as the follow camera for moving targets: chase, side, lock with lead room, flyby, banking, flock
// framing, FollowTarget cells with a floating origin, ground clearance and smooth hand-offs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Engine as Runtime, TransformStore } from '@margoengine/core/extension';
import { ThirdPersonControls } from '../dist/third-person.js';
import { FakeElement } from './control-fakes.js';

class Canvas extends FakeElement {
  width = 800;
  height = 600;
  getContext() {
    return null;
  }
}
async function engineAt(position = [0, 5, 20]) {
  return new Runtime(
    new Canvas(),
    await TransformStore.create(16),
    { backend: 'webgpu', add() {}, remove() {}, render() {}, dispose() {} },
    { position, target: [0, 0, 0] },
    null,
  );
}
// A FollowTarget (docs/physics-framework.md, section 4) moving at constant velocity from `start`, in cell `cell`.
const mover = (velocity, { start = [0, 0, 0], cell = [0, 0, 0], rotation = [0, 0, 0, 1], id = 'ship' } = {}) => {
  let time = 0;
  const target = () => ({
    id,
    solver: 'test',
    cell,
    position: start.map((v, i) => v + velocity[i] * time),
    rotation,
    velocity,
    acceleration: [0, 0, 0],
    angularVelocity: [0, 0, 0],
  });
  return { target, step: (dt) => (time += dt) };
};
const run = (follow, m, seconds, fps = 60) => {
  for (let i = 0; i < seconds * fps; i++) {
    m.step(1 / fps);
    follow.update(1 / fps);
  }
};
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const sub = (a, b) => a.map((v, i) => v - b[i]);

test('chase swings behind the travel and aims ahead of the subject; side tracks on the right', async () => {
  const engine = await engineAt(),
    ship = mover([10, 0, 0]),
    follow = new ThirdPersonControls(engine, ship.target, { style: 'chase', collide: false, lag: 0.2 });
  run(follow, ship, 4);
  const at = ship.target().position,
    cam = engine.camera;
  assert.ok(cam.position[0] < at[0] - 2, `camera x ${cam.position[0]} behind ${at[0]}`);
  assert.ok(Math.abs(cam.position[2] - at[2]) < 0.5, 'straight behind');
  assert.ok(cam.target[0] > at[0], 'the aim leads the subject');
  follow.style = 'side';
  run(follow, ship, 4);
  const now = ship.target().position;
  // Travel +X: the right-hand side is +Z (y up).
  assert.ok(engine.camera.position[2] > now[2] + 2, `side camera z ${engine.camera.position[2]}`);
  follow.dispose();
});

test('critically damped: a step in the travel turns the arm with no overshoot, alike at 30 and 60 fps', async () => {
  const angles = async (fps) => {
    const engine = await engineAt(),
      ship = mover([10, 0, 0]),
      follow = new ThirdPersonControls(engine, ship.target, { style: 'chase', collide: false, lag: 0, turnLag: 0.5 });
    run(follow, ship, 3, fps);
    const turned = mover([0, 0, -10]);
    follow.subject = turned.target;
    const out = [];
    for (let i = 0; i < 2 * fps; i++) {
      turned.step(1 / fps);
      follow.update(1 / fps);
      if ((i + 1) % (fps / 10) === 0) out.push(follow.yaw);
    }
    follow.dispose();
    return out;
  };
  const a = await angles(60),
    b = await angles(30);
  // Behind +X travel the yaw is -PI/2; behind -Z travel it is 0. Monotone, never past 0.
  for (let i = 1; i < a.length; i++) assert.ok(a[i] >= a[i - 1] - 1e-9 && a[i] <= 1e-9, `step ${i}: ${a[i]}`);
  a.forEach((v, i) => assert.ok(Math.abs(v - b[i]) < 1e-9, `30 fps ${b[i]} vs 60 fps ${v}`));
});

test('lock leaves lead room ahead; flyby holds its point while the subject passes, then moves on', async () => {
  const engine = await engineAt(),
    ship = mover([8, 0, 0]),
    follow = new ThirdPersonControls(engine, ship.target, {
      style: 'lock',
      collide: false,
      lag: 0,
      lookAhead: 0,
      pivotOffset: [0, 0, 0],
    });
  // Off-axis angle of the subject: lock aims ahead of it, so it sits farther from the centre than in chase.
  const off = () => {
    const c = engine.camera,
      view = sub(c.target, c.position),
      d = sub(ship.target().position, c.position);
    return Math.acos(Math.min(1, dot(d, view) / (Math.hypot(...d) * Math.hypot(...view))));
  };
  run(follow, ship, 4);
  const locked = off();
  follow.style = 'chase';
  run(follow, ship, 2);
  assert.ok(locked > 0.03 && off() < 1e-3, `lock ${locked} rad off the centre, chase ${off()}`);
  const c = engine.camera;
  follow.style = 'flyby';
  follow.update(1 / 60);
  const station = [...c.position];
  run(follow, ship, 1);
  assert.deepEqual([...c.position], station, 'the flyby point holds');
  run(follow, ship, 8);
  assert.notDeepEqual([...c.position], station, 'and moves on once the subject has passed');
  follow.dispose();
});

test('banking: a bird rolls and the camera banks with it within maxBank; a ship stays level by default', async () => {
  const roll = 0.6,
    q = [0, 0, -Math.sin(roll / 2), Math.cos(roll / 2)], // rolled about the travel axis, right wing down
    engine = await engineAt(),
    bird = mover([0, 0, -12], { rotation: q }),
    follow = new ThirdPersonControls(engine, bird.target, { style: 'chase', collide: false, bank: 1, maxBank: 0.4 });
  run(follow, bird, 2);
  // The bank is up's turn toward the screen's right: sin(bank) = up . right.
  const c = engine.camera,
    f = sub(c.target, c.position),
    r = [-f[2], 0, f[0]],
    rl = Math.hypot(...r),
    bank = Math.asin(dot(c.up, r) / rl / Math.hypot(...c.up));
  assert.ok(Math.abs(bank - 0.4) < 1e-6, `banked ${bank}`);
  const ship = new ThirdPersonControls(await engineAt(), bird.target, { style: 'chase', collide: false });
  ship.update(1 / 60);
  assert.deepEqual([...ship.camera.up], [0, 1, 0]);
  follow.dispose();
  ship.dispose();
});

test('a flock: the arm frames every member; FollowTarget cells and a floating origin keep the camera local', async () => {
  const engine = await engineAt(),
    a = mover([5, 0, 0], { start: [0, 0, 0], id: 'a' }),
    b = mover([5, 0, 0], { start: [0, 0, 200], id: 'b' }),
    follow = new ThirdPersonControls(engine, [a.target, b.target], { style: 'chase', collide: false, lag: 0 });
  run(follow, { step: (dt) => (a.step(dt), b.step(dt)) }, 3);
  const c = engine.camera,
    view = sub(c.target, c.position),
    half = (c.fov * Math.PI) / 360;
  for (const m of [a, b]) {
    const d = sub(m.target().position, c.position),
      angle = Math.acos(dot(d, view) / (Math.hypot(...d) * Math.hypot(...view)));
    assert.ok(angle < half, `member ${m.target().id} is ${angle} rad off the axis`);
  }
  follow.dispose();
  // A ship 400 km out, in cell 100 of 4,096 m: world x = 409,600 + 50. Through a floating origin near it, local.
  const origin = {
      at: [409_600, 0, 0],
      toLocal: (w) => w.map((v, i) => v - origin.at[i]),
      toWorld: (l) => l.map((v, i) => v + origin.at[i]),
    },
    far = mover([6, 0, 0], { start: [50, 0, 0], cell: [100, 0, 0] }),
    e2 = await engineAt(),
    f2 = new ThirdPersonControls(e2, far.target, { style: 'chase', collide: false, origin, lag: 0 });
  run(f2, far, 1);
  assert.ok(Math.abs(e2.camera.position[0]) < 100, `local camera x ${e2.camera.position[0]}`);
  assert.ok(Math.abs(f2.target.position[0] - (409_600 + 56)) < 1e-6, 'world position from the cell');
  f2.dispose();
});

test('ground clearance, mesh-free hand-off with takeOver, and coded errors', async () => {
  const engine = await engineAt([0, 50, 50]),
    boat = mover([4, 0, 0]),
    hill = () => 30,
    follow = new ThirdPersonControls(engine, boat.target, {
      style: 'chase',
      collide: false,
      ground: hill,
      clearance: 2,
      lag: 0,
    });
  // takeOver starts at the camera's current view and eases in: the first frame barely moves.
  follow.takeOver(1);
  const start = [...engine.camera.position];
  boat.step(1 / 60);
  follow.update(1 / 60);
  assert.ok(Math.hypot(...sub(engine.camera.position, start)) < 0.5, 'takeOver starts where the camera was');
  run(follow, boat, 2);
  assert.ok(engine.camera.position[1] >= 32 - 1e-9, `camera y ${engine.camera.position[1]} over a 30 m hill`);
  assert.throws(() => new ThirdPersonControls(engine, boat.target, { style: 'drone' }), RangeError);
  assert.throws(() => new ThirdPersonControls(engine, [], {}), TypeError);
  assert.throws(() => follow.takeOver(-1), RangeError);
  follow.dispose();
});

test('hand-off: the geospatial camera takes over the follow camera pose without a jump', async () => {
  const { GeospatialControls } = await import('../dist/geospatial.js'),
    { camera } = await import('./control-fakes.js'),
    cam = camera({ position: [0, 0, 1], target: [0, 0, 0], fov: 60 }),
    geo = new GeospatialControls(cam, new FakeElement(), {
      view: { longitude: 0.1, latitude: 0.2, range: 900, pitch: 0.5 },
      clipPlanes: false,
    }),
    before = [...cam.position];
  // Another controller moves the camera a little; fromCamera keeps exactly that pose.
  cam.position = cam.position.map((v, i) => v + [30, -10, 5][i]);
  const moved = [...cam.position];
  geo.fromCamera();
  assert.ok(Math.hypot(...sub(cam.position, moved)) < 1e-6 * 6.4e6, 'the pose is kept');
  assert.ok(Math.hypot(...sub(cam.position, before)) > 1);
  geo.dispose();
});
