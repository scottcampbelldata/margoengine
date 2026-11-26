// The PID controller of the own solver: it drives position and rotation to a target, holds a load with its integral,
// honours axes, checks its input, and replays bit for bit.
import assert from 'node:assert/strict';
import test from 'node:test';
import { PdController, PidController, Physics, pdErrors } from '../dist/index.js';

const ball = (physics, extra = {}) =>
  physics.addBody(null, { colliders: { shape: 'sphere', radius: 0.25, density: 1000 }, ...extra });

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
  for (const colliders of [
    { shape: 'sphere', radius: 0.5, density: 100 },
    { shape: 'box', halfExtents: [1, 0.2, 0.5], density: 800 },
  ]) {
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

test('an underdamped controller overshoots and peaks as the second-order step response says', async () => {
  // Landed as mass times acceleration, the loop of any body is x'' + kd x' + kp x = kp x_t: with kp 100 and kd 4,
  // wn 10 rad/s and zeta 0.2, a step overshoots by exp(-pi zeta / sqrt(1 - zeta^2)) and peaks at pi / (wn sqrt(1 -
  // zeta^2)) (Astrom and Murray 2008, sec. 5.3). At 1,000 steps a second measured 0.07 percent short on the overshoot and
  // 0.2 percent early on the peak (one step): bounds of 0.5 percent.
  await Physics.load();
  const hz = 1000,
    physics = new Physics(null, { gravity: [0, 0, 0], fixedTimestep: 1 / hz }),
    body = ball(physics, { linearDamping: 0 }),
    pd = new PdController({ kp: 100, kd: 4 }),
    zeta = 0.2,
    wd = 10 * Math.sqrt(1 - zeta * zeta),
    overshoot = Math.exp((-Math.PI * zeta) / Math.sqrt(1 - zeta * zeta));
  let peak = -Infinity,
    at = 0;
  for (let i = 1; i <= 2 * hz; i++) {
    pd.applyLinear(1 / hz, body, [1, 0, 0]);
    physics.step();
    if (body.position[0] > peak) [peak, at] = [body.position[0], i / hz];
  }
  assert.ok(Math.abs((peak - 1) / overshoot - 1) < 0.005, `overshoot ${peak - 1} against ${overshoot}`);
  assert.ok(Math.abs((at * wd) / Math.PI - 1) < 0.005, `peak at ${at} s against ${Math.PI / wd}`);
  physics.dispose();
});

test('a target velocity lets the controller follow a moving target with no lag; without it the lag is kd v / kp', async () => {
  // A target moving at v: at steady speed the command kp e + kd (v_t - v) is 0, so with v_t = v the error is 0 and
  // with v_t = 0 it is kd v / kp, 0.5 m here. Measured 1e-5 m and 0.499994 m (single-precision positions): bounds 1e-4.
  await Physics.load();
  const lag = (feedForward) => {
    const physics = new Physics(null, { gravity: [0, 0, 0] }),
      body = ball(physics, { linearDamping: 0 }),
      pid = new PidController({ kp: 16, kd: 8 });
    for (let i = 0; i < 600; i++) {
      pid.applyLinear(1 / 60, body, [i / 60, 0, 0], feedForward ? [1, 0, 0] : [0, 0, 0]);
      physics.step();
    }
    const behind = 10 - body.position[0];
    physics.dispose();
    return behind;
  };
  assert.ok(Math.abs(lag(true)) < 1e-4, `with the target velocity ${lag(true)} m behind`);
  assert.ok(Math.abs(lag(false) - 0.5) < 1e-4, `without it ${lag(false)} m behind`);
});

test('the linear and angular parts take their own axes and gains', async () => {
  await Physics.load();
  const physics = new Physics(null, { gravity: [0, 0, 0] }),
    body = ball(physics),
    pid = new PidController({
      kp: 10,
      angular: { kp: 3 },
      axes: { linear: [true, false, false], angular: [false, false, true] },
    }),
    s = Math.sin(0.05),
    c = Math.cos(0.05),
    target = [s, 0, s, c].map((v, i) => (i === 3 ? v : v / Math.SQRT2)),
    a = pid.linearCorrection(1 / 60, body, [1, 1, 1]),
    w = pid.angularCorrection(1 / 60, body, target);
  assert.deepEqual(a, [10, 0, 0]);
  assert.equal(w[0], 0);
  assert.equal(w[1], 0);
  assert.ok(Math.abs(w[2] - 3 * 2 * (s / Math.SQRT2)) < 1e-6, `angular z ${w[2]}`);
  assert.deepEqual(pid.axes, { linear: [true, false, false], angular: [false, false, true] });
  // One mask for both, set later, and the angular gains default to the linear ones.
  pid.setAxes([false, true, false]);
  assert.deepEqual(pid.axes.angular, [false, true, false]);
  assert.equal(new PidController({ kp: 7, kd: 2 }).angularKp, 7);
  physics.dispose();
});

test('the PD controller reads its errors and gives the PID correction with no integral', async () => {
  await Physics.load();
  const physics = new Physics(null, { gravity: [0, 0, 0] }),
    body = ball(physics, { position: [1, 2, 3] });
  body.setLinearVelocity([0.5, 0, 0]);
  const angle = 0.3,
    target = { position: [2, 2, 2], rotation: [0, 0, Math.sin(angle / 2), Math.cos(angle / 2)] },
    velocity = { linear: [0, 1, 0], angular: [0, 0, 2] },
    errors = pdErrors(body, target, velocity);
  assert.deepEqual(errors.linear, [1, 0, -1]);
  assert.deepEqual(errors.linearVelocity, [-0.5, 1, 0]);
  assert.ok(Math.abs(errors.angular[2] - 2 * Math.sin(angle / 2)) < 1e-7);
  assert.deepEqual(errors.angularVelocity, [0, 0, 2]);
  // A pose with no rotation leaves the angular part out, its speed error too.
  assert.deepEqual(pdErrors(body, { position: [0, 0, 0] }, velocity).angularVelocity, [0, 0, 0]);
  const pd = new PdController({ kp: 12, kd: 3, angular: { kp: 5, kd: 1 } }),
    pid = new PidController({ kp: 12, kd: 3, angular: { kp: 5, kd: 1 } });
  assert.deepEqual(pd.correction(errors), pid.correction(1 / 60, errors));
  assert.deepEqual(pd.linearCorrection(body, target.position, velocity.linear), pd.correction(errors).linear);
  // apply drives the whole pose: the same impulses as applyLinear and applyAngular.
  const twin = ball(physics, { position: [1, 2, 3] });
  twin.setLinearVelocity([0.5, 0, 0]);
  pd.apply(1 / 60, body, target, velocity);
  pd.applyLinear(1 / 60, twin, target.position, velocity.linear).applyAngular(
    1 / 60,
    twin,
    target.rotation,
    velocity.angular,
  );
  assert.deepEqual(body.linearVelocity, twin.linearVelocity);
  assert.deepEqual(body.angularVelocity, twin.angularVelocity);
  physics.dispose();
});

test('a capped controller holds its integral while at the cap, so it does not wind up', async () => {
  // A 10 m move with the acceleration capped at 1 m/s^2. With the cap inside the controller the integral holds while the
  // command is at the cap (conditional integration), and the move overshoots by about what the capped PD alone does
  // (3.3 m against 2.9 m). Capping the same PID outside it lets the integral wind up for the whole run to the target:
  // it overshoots by 24 m and falls into a limit cycle. Bounds: within 1.25 times the PD's overshoot, a fifth of the
  // wound-up one's, and back on the target to 1 mm at 30 s.
  await Physics.load();
  const run = (ki, inside) => {
    const physics = new Physics(null, { gravity: [0, 0, 0] }),
      body = ball(physics, { linearDamping: 0 }),
      pid = new PidController({ kp: 4, ki, kd: 4, maxLinear: inside ? 1 : Infinity });
    let peak = -Infinity,
      first;
    for (let i = 0; i < 60 * 30; i++) {
      let a = pid.linearCorrection(1 / 60, body, [10, 0, 0]);
      if (i === 0) first = { a, integral: pid.linearIntegral };
      const n = Math.hypot(...a);
      if (n > 1) a = a.map((v) => v / n);
      body.applyImpulse(a.map((v) => (v * body.mass) / 60));
      physics.step();
      peak = Math.max(peak, body.position[0]);
    }
    const end = body.position[0];
    physics.dispose();
    return { overshoot: peak - 10, end, first };
  };
  const pd = run(0, true),
    held = run(2, true),
    wound = run(2, false);
  assert.ok(Math.abs(Math.hypot(...held.first.a) - 1) < 1e-12, 'the command is held at the cap');
  assert.deepEqual(held.first.integral, [0, 0, 0], 'and the integral does not move there');
  assert.ok(held.overshoot < 1.25 * pd.overshoot, `overshoot ${held.overshoot} m against the PD's ${pd.overshoot} m`);
  assert.ok(held.overshoot < wound.overshoot / 5, `against ${wound.overshoot} m wound up`);
  assert.ok(Math.abs(held.end - 10) < 1e-3, `ends at ${held.end}`);
  assert.throws(() => new PidController({ maxLinear: 0 }), /maxLinear/);
});
