// Directing soft volumes for film (P8, point 7): `body.cue({at, ...})` places an impulse, a poke, a blast, a vent or a target
// shape at a time on the soft world's clock, and `body.setTargetShape(shape)` draws the body toward a shape with no net force
// or torque (src/soft-direct.ts). Cues land on their step, replay after a snapshot, and the target keeps the body's momentum.
import assert from 'node:assert/strict';
import test from 'node:test';
import { Physics } from '../dist/index.js';
import { SoftBodies, SoftBodyDesc, targetPull } from '../dist/soft.js';

await Physics.load();

const sphere = (r, w, h) => {
  const positions = [],
    indices = [];
  for (let iy = 0; iy <= h; iy++)
    for (let ix = 0; ix <= w; ix++) {
      const phi = (2 * Math.PI * ix) / w,
        theta = (Math.PI * iy) / h;
      positions.push(-r * Math.cos(phi) * Math.sin(theta), r * Math.cos(theta), r * Math.sin(phi) * Math.sin(theta));
    }
  const at = (ix, iy) => iy * (w + 1) + ix;
  for (let iy = 0; iy < h; iy++)
    for (let ix = 0; ix < w; ix++) {
      const [a, b, c, d] = [at(ix + 1, iy), at(ix, iy), at(ix, iy + 1), at(ix + 1, iy + 1)];
      if (iy !== 0) indices.push(a, b, d);
      if (iy !== h - 1) indices.push(b, c, d);
    }
  return { positions, indices };
};

const world = async (stiffness = 20) => {
  const physics = new Physics(null, { gravity: [0, 0, 0], fixedTimestep: 1 / 60 });
  const soft = await SoftBodies.attach(physics);
  const ball = soft.create(SoftBodyDesc.volume(sphere(0.3, 12, 8), { density: 100, damping: 0, stiffness }).setAirDrag(false));
  return { physics, soft, ball };
};

const momentum = (body) => {
  const v = body.particleVelocities(),
    m = body.mass() / body.numParticles(),
    p = [0, 0, 0];
  for (let i = 0; i < v.length; i += 3) for (let a = 0; a < 3; a++) p[a] += v[i + a] * m;
  return p;
};


test('an impulse cue lands on the step its time falls on, not before, and carries J', async () => {
  const { physics, soft, ball } = await world();
  ball.cue({ at: 0.5, impulse: [0, 2, 0] });
  let fired = -1;
  for (let i = 0; i < 60; i++) {
    const before = soft.time;
    physics.step();
    if (fired < 0 && momentum(ball)[1] > 1) fired = i;
    if (fired < 0) assert.ok(before < 0.5 - 1e-9, `no push before 0.5 s (${before})`);
  }
  assert.equal(fired, 30, 'the step that starts at 0.5 s takes it');
  // The measured float32 loss of a damped body is 1e-3 of an impulse (KB-SOFT-F32MOMENTUM1); this one is undamped.
  assert.ok(Math.abs(momentum(ball)[1] - 2) <= 2e-3, `momentum ${momentum(ball)[1]} N s against 2`);
  assert.equal(ball.pendingCues().length, 0);
});

test('a poke cue pushes only the particles within its radius and a blast pushes out from its centre', async () => {
  const { physics, ball } = await world();
  // Each particle within the radius takes the impulse times (1 - d / radius): that sum, and only that, is what it gains.
  const x = ball.particlePositions();
  let share = 0,
    reached = 0;
  for (let i = 0; i < x.length; i += 3) {
    const d = Math.hypot(x[i] + 0.3, x[i + 1], x[i + 2]);
    if (d < 0.15) {
      share += 1 - d / 0.15;
      reached++;
    }
  }
  assert.ok(reached > 0 && reached < x.length / 3, 'the poke reaches some particles, not all');
  ball.cue({ at: 0, poke: { impulse: [1, 0, 0], point: [-0.3, 0, 0], radius: 0.15 } });
  physics.step();
  assert.ok(Math.abs(momentum(ball)[0] - share) <= 2e-3 * share, `momentum ${momentum(ball)[0]} against ${share}`);
  const other = await world();
  other.ball.cue({ at: 0, blast: { center: [0, 0, 0], magnitude: 0.01, radius: 0 } });
  other.physics.step();
  const p = momentum(other.ball);
  assert.ok(Math.hypot(...p) < 1e-3, `a centred blast moves no momentum (${p})`);
  assert.ok(other.ball.surfaceVolume() > 4.0 / 3.0 * Math.PI * 0.3 ** 3 * 0.9, 'it swells outward, held by its volume');
});

test('the target pull adds to no force and no torque about the centre of mass', () => {
  // Scattered particles of unequal mass and a target squashed, stretched and turned against them.
  let seed = 7;
  const r = () => (seed = (seed * 16807) % 2147483647) / 2147483647 - 0.5,
    n = 60,
    x = [],
    t = [],
    m = [];
  for (let i = 0; i < n; i++) {
    const p = [r(), r(), r()];
    x.push(...p);
    t.push(-p[2] * 1.3 + 0.1 * p[0], p[1] / 2, p[0] * 1.5);
    m.push(0.5 + r() + 0.5);
  }
  const { accel } = targetPull(x, m, () => true, t, 10, [0, 0, 0, 1]);
  const c = [0, 0, 0],
    total = m.reduce((a, b) => a + b, 0);
  for (let i = 0; i < n; i++) for (let k = 0; k < 3; k++) c[k] += (m[i] * x[3 * i + k]) / total;
  const f = [0, 0, 0],
    torque = [0, 0, 0];
  let scale = 0;
  for (let i = 0; i < n; i++) {
    const p = [0, 1, 2].map((k) => x[3 * i + k] - c[k]),
      a = [0, 1, 2].map((k) => m[i] * accel[3 * i + k]);
    for (let k = 0; k < 3; k++) f[k] += a[k];
    torque[0] += p[1] * a[2] - p[2] * a[1];
    torque[1] += p[2] * a[0] - p[0] * a[2];
    torque[2] += p[0] * a[1] - p[1] * a[0];
    scale += Math.hypot(...a) * Math.hypot(...p);
  }
  // Exact in reals; double rounding and the rotation search's stop (a turn under 1e-12 rad) leave far below 1e-9 of the pulls.
  assert.ok(Math.hypot(...f) <= 1e-9 * scale, `force ${f}`);
  assert.ok(Math.hypot(...torque) <= 1e-9 * scale, `torque ${torque}`);
});

test('a target shape squashes a moving body toward it, turned to fit, and it keeps moving', async () => {
  // A soft body (3 Hz springs) under a stronger pull (6 Hz): the pull wins most of the way, as (6 / 3)^2 says.
  const { physics, ball } = await world(3);
  ball.applyImpulse([0.5, 0, 0]);
  const x = ball.particlePositions();
  // A squashed ellipsoid: half as tall, wider to keep the volume, turned a quarter turn about y.
  const shape = [];
  for (let i = 0; i < x.length; i += 3) shape.push(-x[i + 2] * Math.SQRT2, x[i + 1] / 2, x[i] * Math.SQRT2);
  ball.setTargetShape(shape, { frequency: 6 });
  for (let i = 0; i < 180; i++) physics.step();
  assert.ok(ball.particlePositions().every(Number.isFinite));
  // Its momentum stays 0.5 N s along x to the soft kernel's float32 loss under a large deformation, about 1% here
  // (KB-SOFT-F32MOMENTUM1, docs/known-bugs.md), which the pull itself does not add to (the test above).
  assert.ok(Math.abs(momentum(ball)[0] - 0.5) <= 0.01 * 0.5, `momentum ${momentum(ball)}`);
  const ys = ball.particlePositions().filter((_, k) => k % 3 === 1),
    tall = Math.max(...ys) - Math.min(...ys);
  assert.ok(tall < 0.45, `it squashed most of the way to the target's 0.3 m (height ${tall} m from 0.6)`);
});

test('pending cues replay bit for bit after a snapshot and restore', async () => {
  const { physics, soft, ball } = await world();
  ball.cue({ at: 0.2, impulse: [0, 1, 0] });
  ball.cue({ at: 0.4, poke: { impulse: [0.5, 0, 0], point: [0.3, 0, 0], radius: 0.2 } });
  for (let i = 0; i < 6; i++) physics.step();
  const saved = soft.takeSnapshot();
  for (let i = 0; i < 40; i++) physics.step();
  const expected = soft.hash();
  soft.restoreSnapshot(saved);
  assert.equal(ball.pendingCues().length, 2, 'both cues are pending again');
  for (let i = 0; i < 40; i++) physics.step();
  assert.equal(soft.hash(), expected);
});

test('cues and targets it cannot use are refused with coded errors', async () => {
  const { physics, ball } = await world();
  physics.step();
  const refused = (fn, pattern) =>
    assert.throws(fn, (e) => e.code === 'unsupported' && pattern.test(e.message) && /errors#soft-volumes/.test(e.message));
  refused(() => ball.cue({ at: 0, impulse: [0, 1, 0] }), /or later/);
  refused(() => ball.cue({ at: Number.NaN, impulse: [0, 1, 0] }), /seconds/);
  refused(() => ball.cue({ at: 1 }), /one action/);
  refused(() => ball.cue({ at: 1, impulse: [0, 1, 0], closeVents: true }), /one action/);
  refused(() => ball.cue({ at: 1, impulse: [0, Number.NaN, 0] }), /three finite/);
  refused(() => ball.cue({ at: 1, vent: { particle: 0, area: 1e-4 } }), /gas shell/);
  refused(() => ball.setTargetShape([0, 0, 0]), /finite numbers/);
  refused(() => ball.setTargetShape(ball.particlePositions(), { frequency: 20 }), /frequency/);
});
