// The PID controller of the own solver: it drives position and rotation to a target, holds a load with its integral,
// honours axes, checks its input, and replays bit for bit.
import assert from 'node:assert/strict';
import test from 'node:test';
import { PidController, Physics } from '../dist/next.js';

const ball = (physics, extra = {}) => physics.addBody(null, { colliders: { shape: 'sphere', radius: 0.25, density: 1000 }, ...extra });

test('a damped controller brings a body to its target and stops it there, whatever its mass', async () => {
  await Physics.load();
  for (const density of [10, 5000]) {
    const physics = new Physics(null, { gravity: [0, 0, 0] });
    const body = physics.addBody(null, { colliders: { shape: 'sphere', radius: 0.25, density } });
    const pid = new PidController({ kp: 100, kd: 20 });
    for (let i = 0; i < 300; i++) {
      pid.applyLinear(1 / 60, body, [2, 1, -3]);
      physics.step();
    }
    const p = body.position;
    assert.ok(Math.hypot(p[0] - 2, p[1] - 1, p[2] + 3) < 1e-3, `density ${density}: ${p}`);
    assert.ok(Math.hypot(...body.linearVelocity) < 1e-2);
    physics.dispose();
  }
});

test('the integral takes up a steady load that the proportional term leaves as an offset', async () => {
  await Physics.load();
  const run = (ki) => {
    const physics = new Physics(null, { gravity: [0, -9.81, 0] });
    const body = ball(physics);
    const pid = new PidController({ kp: 60, ki, kd: 16 });
    for (let i = 0; i < 600; i++) {
      pid.applyLinear(1 / 60, body, [0, 0, 0]);
      physics.step();
    }
    const y = body.position[1];
    physics.dispose();
    return y;
  };
  assert.ok(Math.abs(run(0)) > 0.1, 'sags without the integral');
  assert.ok(Math.abs(run(400)) < 0.005, 'holds with it');
});

test('axes leave the others alone and reset clears the integral', async () => {
  await Physics.load();
  const physics = new Physics(null, { gravity: [0, 0, 0] });
  const body = ball(physics);
  const pid = new PidController({ kp: 10, ki: 5, axes: [true, false, false] });
  const a = pid.linearCorrection(1 / 60, body, [1, 1, 1]);
  assert.ok(a[0] > 0 && a[1] === 0 && a[2] === 0);
  const again = pid.linearCorrection(1 / 60, body, [1, 1, 1]);
  assert.ok(again[0] > a[0], 'the integral grows');
  pid.reset();
  assert.equal(pid.linearCorrection(1 / 60, body, [1, 1, 1])[0], a[0]);
  physics.dispose();
});

test('the angular controller turns a body to the target the short way, with inertia accounted', async () => {
  await Physics.load();
  const s = Math.sin(0.6),
    c = Math.cos(0.6);
  for (const colliders of [{ shape: 'sphere', radius: 0.5, density: 100 }, { shape: 'box', halfExtents: [1, 0.2, 0.5], density: 800 }]) {
    const physics = new Physics(null, { gravity: [0, 0, 0] });
    const body = physics.addBody(null, { colliders });
    const pid = new PidController({ kp: 80, kd: 16 });
    // 1.2 rad about a tilted axis, written the long way round: -q is the same turn.
    const axis = [0.6, 0, 0.8];
    const target = [-axis[0] * s, -axis[1] * s, -axis[2] * s, -c];
    for (let i = 0; i < 360; i++) {
      pid.applyAngular(1 / 60, body, target);
      physics.step();
    }
    const q = body.rotation;
    const dot = Math.abs(q[0] * target[0] + q[1] * target[1] + q[2] * target[2] + q[3] * target[3]);
    assert.ok(dot > 0.999999, `aligned ${dot}`);
    assert.ok(Math.hypot(...body.angularVelocity) < 1e-2);
    physics.dispose();
  }
});

test('bad gains, steps and targets throw, and a replay is bit for bit', async () => {
  await Physics.load();
  assert.throws(() => new PidController({ kp: -1 }), RangeError);
  assert.throws(() => new PidController({ kd: NaN }), RangeError);
  const physics = new Physics(null);
  const body = ball(physics);
  const pid = new PidController();
  assert.throws(() => pid.linearCorrection(0, body, [0, 0, 0]), RangeError);
  assert.throws(() => pid.linearCorrection(1 / 60, body, [0, NaN, 0]));
  assert.throws(() => pid.angularCorrection(1 / 60, body, [0, 0, 0, 0]));
  physics.dispose();
  const run = () => {
    const w = new Physics(null);
    const b = ball(w);
    const p = new PidController({ kp: 30, ki: 5, kd: 8 });
    for (let i = 0; i < 200; i++) {
      p.applyLinear(1 / 60, b, [1, 2, 3]);
      p.applyAngular(1 / 60, b, [0.2, 0.3, 0.1, 0.9273618]);
      w.step();
    }
    const hash = w.kernel.hash;
    w.dispose();
    return hash;
  };
  assert.equal(run(), run());
});
