// The motor joint (`type: 'motor'`, Box2D's motor joint): body B driven toward a pose relative to body A by a spring per
// kilogram, its pull capped as a force vector and a torque vector. It holds against gravity with the sag its frequency gives
// whatever the mass, its caps are the same on a slant as along an axis, and it follows a moving anchor.
import assert from 'node:assert/strict';
import test from 'node:test';
import { Physics } from '../dist/index.js';

await Physics.load();

/** B's position and rotation in A's frame. */
function relative(a, b) {
  const [x, y, z, w] = a.rotation,
    d = [b.position[0] - a.position[0], b.position[1] - a.position[1], b.position[2] - a.position[2]],
    // Rotate d by the conjugate of A's rotation.
    t = [2 * (-y * d[2] + z * d[1]), 2 * (-z * d[0] + x * d[2]), 2 * (-x * d[1] + y * d[0])],
    p = [
      d[0] + w * t[0] + (-y * t[2] + z * t[1]),
      d[1] + w * t[1] + (-z * t[0] + x * t[2]),
      d[2] + w * t[2] + (-x * t[1] + y * t[0]),
    ],
    [bx, by, bz, bw] = b.rotation,
    q = [
      w * bx - x * bw - y * bz + z * by,
      w * by - y * bw - z * bx + x * bz,
      w * bz - z * bw - x * by + y * bx,
      w * bw + x * bx + y * by + z * bz,
    ];
  return { p, q };
}

test('a motor joint holds a body at its offset against gravity, sagging g / omega^2 whatever its mass', () => {
  // A critically damped spring of 5 hz per kilogram under gravity rests g / (2 pi 5)^2 = 9.9 mm below its target. Measured
  // 9.938 mm for 1 kg and for 100 kg, against 9.940: a bound of 0.5 percent.
  const turn = [0, Math.sin(0.25), 0, Math.cos(0.25)];
  for (const mass of [1, 100]) {
    const physics = new Physics(null),
      a = physics.addBody(null, { type: 'fixed', position: [0, 5, 0] }),
      b = physics.addBody(null, {
        position: [0.3, 4, 0.2],
        colliders: { shape: 'box', halfExtents: [0.2, 0.2, 0.2], mass },
      }),
      joint = physics.addJoint(a, b, { type: 'motor', linearOffset: [1, -1, 0], angularOffset: turn });
    for (let i = 0; i < 180; i++) physics.step();
    const { p, q } = relative(a, b),
      sag = 9.81 / (2 * Math.PI * 5) ** 2;
    assert.ok(Math.abs(p[0] - 1) < 1e-3 && Math.abs(p[2]) < 1e-3, `mass ${mass}: offset ${p}`);
    assert.ok(Math.abs((-1 - p[1]) / sag - 1) < 0.005, `mass ${mass}: sags ${-1 - p[1]} m against ${sag}`);
    assert.ok(
      Math.abs(Math.abs(q[0] * turn[0] + q[1] * turn[1] + q[2] * turn[2] + q[3] * turn[3]) - 1) < 1e-5,
      `turn ${q}`,
    );
    assert.deepEqual(joint.motorTarget[0], [1, -1, 0]);
    physics.dispose();
  }
});

test("a motor joint's caps are vectors: a pull on a slant is no stronger than one along an axis", () => {
  // A 2 kg body 10 m from its target on the diagonal, the force capped at 4 N: it starts at 2 m/s^2 along the diagonal, not
  // the 2.83 m/s^2 two axes capped alone would give. The turn the same way, its torque capped at 0.5 N m. Measured within 1e-6 of both.
  const physics = new Physics(null, { gravity: [0, 0, 0] }),
    a = physics.addBody(null, { type: 'fixed' }),
    b = physics.addBody(null, { colliders: { shape: 'sphere', radius: 0.5, mass: 2 } }),
    inertia = 0.4 * 2 * 0.25,
    tilt = [Math.sin(1.4) / Math.SQRT2, Math.sin(1.4) / Math.SQRT2, 0, Math.cos(1.4)];
  physics.addJoint(a, b, {
    type: 'motor',
    linearOffset: [10, 10, 0],
    angularOffset: tilt,
    maxForce: 4,
    maxTorque: 0.5,
  });
  for (let i = 0; i < 12; i++) physics.step();
  const t = 12 / 60,
    v = b.linearVelocity,
    w = b.angularVelocity;
  assert.ok(Math.abs(Math.hypot(...v) / ((4 / 2) * t) - 1) < 1e-4, `speed ${Math.hypot(...v)} against ${(4 / 2) * t}`);
  assert.ok(Math.abs(v[0] - v[1]) < 1e-5 && Math.abs(v[2]) < 1e-6, `along the diagonal: ${v}`);
  assert.ok(
    Math.abs(Math.hypot(...w) / ((0.5 / inertia) * t) - 1) < 1e-4,
    `spin ${Math.hypot(...w)} against ${(0.5 / inertia) * t}`,
  );
  physics.dispose();
});

test('a motor joint keeps a body at its offset from an anchor that moves, and its target and caps change on the fly', () => {
  // A kinematic anchor at 2 m/s: the spring drives the speed between them to 0 too, so the body rides at its offset with no
  // lag once it has caught up. Measured within 1e-4 m after 2 s.
  const physics = new Physics(null, { gravity: [0, 0, 0] }),
    a = physics.addBody(null, { type: 'kinematicPosition' }),
    b = physics.addBody(null, { position: [0, 1, 0], colliders: { shape: 'sphere', radius: 0.2, mass: 3 } }),
    joint = physics.addJoint(a, b, { type: 'motor', linearOffset: [0, 1, 0] });
  for (let i = 1; i <= 120; i++) {
    a.setNextPosition([(2 * i) / 60, 0, 0]);
    physics.step();
  }
  assert.ok(
    Math.abs(relative(a, b).p[1] - 1) < 1e-4 && Math.abs(relative(a, b).p[0]) < 1e-4,
    `offset ${relative(a, b).p}`,
  );
  // A new target and a softer spring take over at once. (Capped low, the spring would overshoot and swing: a capped pull
  // cannot brake as hard as it was asked.)
  joint.setMotorTarget([0, 2, 0]).setMotorSpring(2);
  for (let i = 121; i <= 360; i++) {
    a.setNextPosition([(2 * i) / 60, 0, 0]);
    physics.step();
  }
  assert.ok(Math.abs(relative(a, b).p[1] - 2) < 1e-3, `new offset ${relative(a, b).p}`);
  joint.setMotorCaps(1, 1);
  assert.throws(() => joint.setMotorTarget([0, Number.NaN, 0]));
  assert.throws(() => joint.setMotorTarget([0, 0, 0], [0, 0, 0, 2]), { code: 'unsupported' });
  assert.throws(() => joint.setMotorCaps(-1, 1), { code: 'unsupported' });
  assert.throws(() => physics.addJoint(a, b, { type: 'spherical' }).setMotorTarget([0, 0, 0]), { code: 'unsupported' });
  physics.dispose();
});
