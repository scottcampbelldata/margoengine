// Joints through the names of the own entry, on the numbers tests/physics.test.js holds the root entry to. The mechanics
// are proved in kernel/tests/joints.rs; here each option has to reach the kernel and mean it.
import assert from 'node:assert/strict';
import test from 'node:test';
import { KernelWorld, Physics } from '../dist/next.js';

await Physics.load();

const near = (got, want, within, what) => assert.ok(Math.abs(got - want) <= within, `${what}: ${got} against ${want}`);
/** The turn of a quaternion [x, y, z, w] about a unit axis, in (-pi, pi]. */
function angleAbout([x, y, z, w], [ax, ay, az]) {
  const along = x * ax + y * ay + z * az;
  return 2 * Math.atan2(along, w);
}

test('revolute joints respect limits and motors drive them', () => {
  const physics = new Physics(null),
    anchor = physics.addBody(null, { type: 'fixed', position: [0, 5, 0], colliders: [] }),
    arm = physics.addBody(null, { position: [1, 5, 0], colliders: { shape: 'box', halfExtents: [0.5, 0.1, 0.1] } }),
    hinge = physics.addJoint(anchor, arm, {
      type: 'revolute',
      anchorA: [0, 0, 0],
      anchorB: [-1, 0, 0],
      axis: [0, 0, 1],
      limits: [-0.5, 0.5],
    });
  assert.deepEqual(hinge.limits, [-0.5, 0.5]);
  assert.deepEqual(hinge.anchorB, [-1, 0, 0]);
  let lowest = 0;
  for (let i = 0; i < 180; i++) {
    physics.step();
    lowest = Math.min(lowest, angleAbout(arm.rotation, [0, 0, 1]));
  }
  near(lowest, -0.5, 0.02, 'arm hangs at the lower limit');
  const [x, y] = arm.position,
    angle = angleAbout(arm.rotation, [0, 0, 1]);
  near(x, Math.cos(angle), 0.01, 'arm x');
  near(y, 5 + Math.sin(angle), 0.01, 'arm y');
  hinge.setMotor({ targetPosition: 1, stiffness: 1000, damping: 50 });
  for (let i = 0; i < 180; i++) physics.step();
  near(angleAbout(arm.rotation, [0, 0, 1]), 0.5, 0.02, 'motor pushes against the upper limit');
  hinge.clearMotor();
  for (let i = 0; i < 180; i++) physics.step();
  near(angleAbout(arm.rotation, [0, 0, 1]), -0.5, 0.02, 'with the motor off it falls back');
  physics.dispose();

  const space = new Physics(null, { gravity: [0, 0, 0] }),
    axle = space.addBody(null, { type: 'fixed', colliders: [] }),
    wheel = space.addBody(null, { colliders: { shape: 'sphere', radius: 1 } });
  space.addJoint(axle, wheel, { type: 'revolute', axis: [0, 1, 0], motor: { targetVelocity: 2, damping: 10 } });
  for (let i = 0; i < 60; i++) space.step();
  near(wheel.angularVelocity[1], 2, 0.05, 'motor speed');
  space.dispose();
});

test('a motor cap holds the torque, and a force motor does not scale with the body', () => {
  const physics = new Physics(null, { gravity: [0, 0, 0] }),
    axle = physics.addBody(null, { type: 'fixed', colliders: [] }),
    wheel = physics.addBody(null, { colliders: { shape: 'sphere', radius: 1, density: 1 } }),
    inertia = (2 / 5) * ((4 / 3) * Math.PI) * 1;
  physics.addJoint(axle, wheel, {
    type: 'revolute',
    axis: [0, 1, 0],
    motor: { targetVelocity: 1000, damping: 1e6, maxForce: 2, model: 'force' },
  });
  for (let i = 0; i < 60; i++) physics.step();
  near(wheel.angularVelocity[1], 2 / inertia, 0.01, 'two newton metres for a second');
  physics.dispose();
});

test('a body that leaves the numbers stops the world and says why', () => {
  // r'' = w^2 r on a free rail: the true path grows without end, and no answer past the end of f32 is right.
  const physics = new Physics(null, { gravity: [0, 0, 0] }),
    hub = physics.addBody(null, { type: 'kinematicVelocity', angularVelocity: [0, 8, 0], colliders: [] }),
    bead = physics.addBody(null, { position: [1, 0, 0], angularVelocity: [0, 8, 0], colliders: { shape: 'sphere', radius: 0.1 } });
  physics.addJoint(hub, bead, { type: 'prismatic', axis: [1, 0, 0], contactsEnabled: false });
  let steps = 0;
  assert.throws(
    () => {
      for (; steps < 5000; steps++) physics.step();
    },
    (error) => error.code === 'failed' && /went past 1e15/.test(error.message) && /limit the joint/.test(error.message),
  );
  assert.ok(steps > 10 && steps < 5000, `stopped after ${steps} steps`);
  assert.ok(bead.position.every(Number.isFinite), 'the last state is a number');
  assert.throws(() => physics.step(), /went past 1e15/);
});

test('prismatic joints respect limits and position motors', () => {
  const physics = new Physics(null),
    rail = physics.addBody(null, { type: 'fixed', position: [0, 5, 0], colliders: [] }),
    slider = physics.addBody(null, { position: [0, 5, 0], colliders: { shape: 'box', halfExtents: [0.2, 0.2, 0.2] } }),
    joint = physics.addJoint(rail, slider, { type: 'prismatic', axis: [0, 1, 0], limits: [-1, 0.5] });
  for (let i = 0; i < 120; i++) physics.step();
  near(slider.position[1], 4, 0.02, 'slides down to the lower limit');
  near(slider.position[0], 0, 1e-3, 'stays on the axis');
  joint.setMotor({ targetPosition: 0.25, stiffness: 2000, damping: 100 });
  for (let i = 0; i < 240; i++) physics.step();
  near(slider.position[1], 5.25, 0.03, 'motor holds the target offset');
  physics.dispose();
});

test('fixed and spherical joints hold their anchors', () => {
  const physics = new Physics(null),
    base = physics.addBody(null, { type: 'fixed', position: [0, 5, 0], colliders: [] }),
    welded = physics.addBody(null, { position: [0, 4, 0], colliders: { shape: 'sphere', radius: 0.2 } }),
    bob = physics.addBody(null, { position: [2, 5, 0], colliders: { shape: 'sphere', radius: 0.2 } });
  physics.addJoint(base, welded, { type: 'fixed', anchorA: [0, -1, 0] });
  physics.addJoint(base, bob, { type: 'spherical', anchorB: [-2, 0, 0] });
  let lowest = Infinity;
  for (let i = 0; i < 120; i++) {
    physics.step();
    lowest = Math.min(lowest, bob.position[1]);
  }
  near(welded.position[1], 4, 0.01, 'welded body does not fall');
  near(Math.hypot(bob.position[0], bob.position[1] - 5, bob.position[2]), 2, 0.02, 'pendulum length');
  near(lowest, 3, 0.05, 'pendulum swung through the bottom');
  physics.dispose();
});

test('frames in place of an axis: the rest pose reads 0, whatever the frames', () => {
  const physics = new Physics(null, { gravity: [0, 0, 0] }),
    base = physics.addBody(null, { type: 'fixed', colliders: [] }),
    // Frame X runs along world Z on both bodies, though the arm stands turned half a turn about Y.
    arm = physics.addBody(null, { rotation: [0, 1, 0, 0], colliders: { shape: 'sphere', radius: 0.5 } }),
    s = Math.SQRT1_2,
    alongZ = [0, -s, 0, s],
    joint = physics.addJoint(base, arm, {
      type: 'revolute',
      frameA: alongZ,
      frameB: [0, s, 0, s],
      limits: [-0.1, 0.1],
    });
  physics.step();
  assert.ok(Math.abs(physics.kernel.columns.jointAngle[joint.row]) < 1e-5, 'rest pose reads 0');
  physics.dispose();
});

test('a joint reaches the kernel: contactsEnabled, wake, removal', () => {
  const physics = new Physics(null, { gravity: [0, 0, 0] }),
    a = physics.addBody(null, { colliders: { shape: 'box', halfExtents: [0.5, 0.5, 0.5] } }),
    b = physics.addBody(null, { position: [0.3, 0, 0], colliders: { shape: 'box', halfExtents: [0.5, 0.5, 0.5] } }),
    joint = physics.addJoint(a, b, { type: 'revolute', axis: [0, 1, 0], anchorB: [-0.3, 0, 0] });
  assert.equal(joint.contactsEnabled, false, 'joined bodies do not collide by default, as in Rapier');
  for (let i = 0; i < 10; i++) physics.step();
  near(b.position[0] - a.position[0], 0.3, 1e-4, 'the overlap stays');
  joint.contactsEnabled = true;
  assert.equal(joint.contactsEnabled, true);
  joint.remove();
  assert.equal(joint.valid, false);
  joint.remove();
  assert.throws(() => joint.setLimits(0, 1), { code: 'state', message: /Joint was removed; create/ });
  assert.equal(joint.contactsEnabled, false);

  const lower = physics.addJoint(a, b, { type: 'fixed' });
  physics.removeBody(a);
  assert.equal(lower.valid, false, 'a joint leaves with its body');
  physics.dispose();
});

test('a joint added past the rows grows the world and keeps the views right', () => {
  const physics = new Physics(null, { gravity: [0, 0, 0] }),
    base = physics.addBody(null, { type: 'fixed', colliders: [] }),
    joints = [];
  for (let i = 0; i < 40; i++) {
    const body = physics.addBody(null, { position: [i, 0, 0], colliders: { shape: 'sphere', radius: 0.1 } });
    joints.push(physics.addJoint(base, body, { type: 'spherical', anchorA: [i, 0, 0] }));
  }
  assert.deepEqual(joints[0].anchorA, [0, 0, 0]);
  assert.deepEqual(joints[39].anchorA, [39, 0, 0]);
  for (let i = 0; i < 5; i++) physics.step();
  physics.dispose();
});

test('wrong input says what to pass', () => {
  const physics = new Physics(null),
    other = new Physics(null),
    a = physics.addBody(null, { colliders: [] }),
    b = physics.addBody(null, { colliders: [] }),
    outsider = other.addBody(null, { colliders: [] });
  assert.throws(() => physics.addJoint(a, outsider, { type: 'fixed' }), { code: 'state', message: /addBody first/ });
  assert.throws(() => physics.addJoint(a, a, { type: 'fixed' }), { code: 'state', message: /two different bodies/ });
  assert.throws(() => physics.addJoint(a, b, { type: 'twisty' }), /Unknown joint type twisty/);
  assert.throws(() => physics.addJoint(a, b, { type: 'revolute', axis: [0, 0, 0] }), /axis must be nonzero/);
  assert.throws(() => physics.addJoint(a, b, { type: 'revolute', axis: [1, 0, 0], limits: [1, 0] }), /finite min <= max/);
  assert.throws(() => physics.addJoint(a, b, { type: 'revolute', axis: [1, 0, 0], frameA: [0, 0, 0, 1] }), /one or the other/);
  assert.throws(() => physics.addJoint(a, b, { type: 'revolute', frameA: [0, 0, 0, 0], frameB: [0, 0, 0, 1] }), /not all zero/);
  assert.throws(() => physics.addJoint(a, b, { type: 'fixed', anchorA: [Number.NaN, 0, 0] }), /anchorA/);
  const joint = physics.addJoint(a, b, { type: 'spherical' });
  assert.throws(() => joint.setLimits(0, 1), /need a revolute or prismatic joint/);
  assert.throws(() => joint.setMotor({}), /need a revolute or prismatic joint/);
  const hinge = physics.addJoint(a, b, { type: 'revolute', axis: [1, 0, 0] });
  assert.throws(() => hinge.setMotor({ maxForce: -1 }), /maxForce must be 0 or more/);
  for (const call of [
    () => physics.addJoint(a, b, { type: 'generic' }),
    () => joint.setAxisLimits(),
    () => joint.setAxisMotor(),
  ])
    assert.throws(call, { code: 'unsupported', message: /not in the own solver yet/ });
  physics.dispose();
  other.dispose();
});

test('the kernel world takes joints on its own', () => {
  const world = new KernelWorld(8),
    top = world.addBody('fixed'),
    bob = world.addBody('dynamic');
  world.addCollider(bob, 'ball', [0.1]);
  world.columns.positionX[bob] = 1;
  const joint = world.addJoint(top, bob, 7);
  world.columns.jointAnchorBX[joint] = -1;
  for (let i = 0; i < 60; i++) world.step(1 / 60);
  near(Math.hypot(world.columns.positionX[bob], world.columns.positionY[bob]), 1, 1e-3, 'the rod keeps its length');
  assert.equal(world.removeJoint(joint), true);
  assert.equal(world.removeJoint(joint), false);
  assert.throws(() => world.addJoint(top, top, 7), /cannot take a joint/);
});

test('joints replay bit for bit through a snapshot', () => {
  const scene = () => {
    const physics = new Physics(null),
      top = physics.addBody(null, { type: 'fixed', colliders: [] }),
      one = physics.addBody(null, { position: [1, 0, 0], colliders: { shape: 'sphere', radius: 0.1 } }),
      two = physics.addBody(null, { position: [2, 0, 0], colliders: { shape: 'sphere', radius: 0.1 } });
    physics.addJoint(top, one, { type: 'revolute', axis: [0, 0, 1], anchorB: [-1, 0, 0], limits: [-1, 1] });
    physics.addJoint(one, two, { type: 'spherical', anchorA: [0.5, 0, 0], anchorB: [-0.5, 0, 0] });
    return physics;
  };
  const physics = scene();
  for (let i = 0; i < 30; i++) physics.step();
  const saved = physics.kernel.snapshot();
  for (let i = 0; i < 30; i++) physics.step();
  const end = physics.kernel.hash;
  physics.kernel.restore(saved);
  for (let i = 0; i < 30; i++) physics.step();
  assert.equal(physics.kernel.hash, end);
  physics.dispose();
});

test('a cone stops a swing at its edge and a twist at its limit', () => {
  const physics = new Physics(null);
  physics.gravity = [0, 0, 0];
  const top = physics.addBody(null, { type: 'fixed', colliders: [] }),
    rod = physics.addBody(null, { position: [0, -0.5, 0], colliders: { shape: 'box', halfExtents: [0.05, 0.5, 0.05], density: 10 } }),
    joint = physics.addJoint(top, rod, { type: 'cone', anchorB: [0, 0.5, 0], axis: [0, -1, 0], swing: 0.5, twist: [-0.4, 0.4] });
  assert.deepEqual(joint.cone.twist.map((value) => Math.round(value * 100) / 100), [-0.4, 0.4]);
  rod.setLinearVelocity([3, 0, 0]);
  rod.setAngularVelocity([0, 0, 6]);
  for (let i = 0; i < 120; i++) physics.step();
  near(2 * Math.abs(Math.atan2(rod.rotation[2], rod.rotation[3])), 0.5, 1e-3, 'swing');
  near(rod.angularVelocity[2], 0, 1e-3, 'rest on the edge');
  const spun = physics.addBody(null, { position: [3, -0.5, 0], colliders: { shape: 'box', halfExtents: [0.05, 0.5, 0.05], density: 10 } });
  physics.addJoint(top, spun, { type: 'cone', anchorA: [3, 0, 0], anchorB: [0, 0.5, 0], axis: [0, -1, 0], swing: 0.5, twist: [-0.4, 0.4] });
  spun.setAngularVelocity([0, 4, 0]);
  for (let i = 0; i < 120; i++) physics.step();
  near(2 * Math.abs(Math.atan2(spun.rotation[1], spun.rotation[3])), 0.4, 1e-3, 'twist');
  near(spun.angularVelocity[1], 0, 1e-3, 'rest on the limit');
  physics.dispose();
});

test('a cone twists freely without a twist, and refuses what it cannot be', () => {
  const physics = new Physics(null);
  physics.gravity = [0, 0, 0];
  const top = physics.addBody(null, { type: 'fixed', colliders: [] }),
    rod = physics.addBody(null, { position: [0, -0.5, 0], colliders: { shape: 'box', halfExtents: [0.05, 0.5, 0.05], density: 10 } }),
    joint = physics.addJoint(top, rod, { type: 'cone', anchorB: [0, 0.5, 0], axis: [0, -1, 0], swing: [0.3, 0.8] });
  assert.equal(joint.cone.twist, null);
  rod.setAngularVelocity([0, 1, 0]);
  for (let i = 0; i < 120; i++) physics.step();
  near(rod.angularVelocity[1], 1, 1e-3, 'free twist');
  assert.throws(() => physics.addJoint(top, rod, { type: 'cone', swing: 0 }), /swing above 0/);
  assert.throws(() => physics.addJoint(top, rod, { type: 'cone', swing: 1, axis: [0, 0, 0] }), /nonzero/);
  assert.throws(() => joint.setLimits(-1, 1), /revolute or prismatic/);
  assert.equal(physics.addJoint(top, rod, { type: 'revolute', axis: [0, 1, 0] }).cone, null);
  physics.dispose();
});

/** A rod of `mass` kg and length 1 m on a spherical joint at the world origin, reaching along +x, centre at 0.5 m. */
function ballRod(physics, mass = 2) {
  const anchor = physics.addBody(null, { type: 'fixed', colliders: [] }),
    rod = physics.addBody(null, { colliders: { shape: 'box', halfExtents: [0.5, 0.05, 0.05], offset: [0.5, 0, 0], mass } });
  return { rod, joint: physics.addJoint(anchor, rod, { type: 'spherical' }), inertia: (mass * 1) / 3 };
}
const turned = (q) => 2 * Math.acos(Math.min(1, Math.abs(q[3])));
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const rotate = (q, v) => {
  const u = q.slice(0, 3),
    t = cross(u, v).map((x) => x * 2),
    s = cross(u, t);
  return v.map((x, i) => x + q[3] * t[i] + s[i]);
};
const about = (axis, angle) => [...axis.map((v) => v * Math.sin(angle / 2)), Math.cos(angle / 2)];
const between = (a, b) => 2 * Math.acos(Math.min(1, Math.abs(a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3])));

test('a rotation motor turns a spherical joint to its target, at the frequency its gains give', () => {
  const physics = new Physics(null);
  physics.gravity = [0, 0, 0];
  const { rod, joint, inertia } = ballRod(physics),
    target = about([0.6, 0, 0.8], 1),
    w = 2 * Math.PI * 2;
  joint.setRotationMotor(target, { model: 'force', stiffness: inertia * w * w, damping: 2 * inertia * w });
  for (let i = 0; i < 19; i++) physics.step();
  near(between(rod.rotation, target), 0.114, 0.03, 'a critically damped spring at 2 Hz, after 19 steps');
  for (let i = 0; i < 29; i++) physics.step();
  near(between(rod.rotation, target), 0, 0.01, 'there after 0.8 s');
  joint.clearMotor();
  rod.setAngularVelocity([0, 0, 1]);
  rod.setLinearVelocity(cross([0, 0, 1], rotate(rod.rotation, [0.5, 0, 0])));
  const before = rod.rotation;
  for (let i = 0; i < 30; i++) physics.step();
  near(between(rod.rotation, before), 0.5, 0.02, 'cleared: the joint turns freely at 1 rad/s for 0.5 s');
  physics.dispose();
});

test('a rotation motor reaches a target near half a turn, where the sine of the angle says nothing', () => {
  const physics = new Physics(null);
  physics.gravity = [0, 0, 0];
  const { rod, joint, inertia } = ballRod(physics),
    w = 2 * Math.PI * 2,
    gains = { model: 'force', stiffness: inertia * w * w, damping: 2 * inertia * w };
  rod.setRotation(about([0, 1, 0], 3));
  const target = about([0, 1, 0], 3.1);
  for (let i = 0; i < 90; i++) {
    joint.setRotationMotor(target, gains);
    physics.step();
  }
  near(between(rod.rotation, target), 0, 0.01, 'held at 3.1 rad');
  physics.dispose();
});

test('a rotation motor follows a target that spins, without lag, given its spin', () => {
  // A critically damped spring chasing 2 rad/s lags 2 v / w, 0.32 rad. Told the spin it lags nothing: the target moves in
  // jumps of a step, so what is left is at most that jump, 0.033 rad.
  const lag = (targetVelocity) => {
    const physics = new Physics(null);
    physics.gravity = [0, 0, 0];
    const { rod, joint, inertia } = ballRod(physics),
      w = 2 * Math.PI * 2,
      gains = { model: 'force', stiffness: inertia * w * w, damping: 2 * inertia * w, targetVelocity };
    for (let i = 0; i < 120; i++) {
      joint.setRotationMotor(about([0, 0, 1], (2 * i) / 60), gains);
      physics.step();
    }
    const off = between(rod.rotation, about([0, 0, 1], (2 * 120) / 60));
    physics.dispose();
    return off;
  };
  assert.ok(lag([0, 0, 2]) < 2 / 60, `told the spin: ${lag([0, 0, 2])}`);
  near(lag(undefined), (2 * 2) / (4 * Math.PI) + 1 / 60, 0.02, 'not told');
});

test('maxForce caps a motor at the torque it names, on a ball joint and on a hinge', () => {
  // A rod of 2 kg straight out: the torque of its weight about the joint is m g d = 2 * 9.81 * 0.5, 9.81 N m.
  for (const hinge of [false, true]) {
    const held = (cap) => {
      const physics = new Physics(null, { gravity: [0, -9.81, 0] }),
        anchor = physics.addBody(null, { type: 'fixed', colliders: [] }),
        rod = physics.addBody(null, { colliders: { shape: 'box', halfExtents: [0.5, 0.05, 0.05], offset: [0.5, 0, 0], mass: 2 } }),
        gains = { model: 'force', stiffness: 4000, damping: 400, maxForce: cap },
        joint = hinge
          ? physics.addJoint(anchor, rod, { type: 'revolute', axis: [0, 0, 1], motor: { targetPosition: 0, ...gains } })
          : physics.addJoint(anchor, rod, { type: 'spherical' });
      if (!hinge) joint.setRotationMotor([0, 0, 0, 1], gains);
      let angle = 0;
      for (let i = 0; i < 120; i++) {
        physics.step();
        angle = Math.max(angle, turned(rod.rotation));
      }
      physics.dispose();
      return angle;
    };
    assert.ok(held(12) < 0.05, `${hinge ? 'hinge' : 'ball'}: 12 N m holds 9.81 N m (${held(12)})`);
    assert.ok(held(7) > 0.5, `${hinge ? 'hinge' : 'ball'}: 7 N m does not (${held(7)})`);
  }
  const physics = new Physics(null),
    { joint } = ballRod(physics);
  assert.throws(() => joint.setRotationMotor([0, 0, 0, 2]), { name: 'RangeError', message: /unit quaternion/ });
  assert.throws(() => joint.setRotationMotor([0, 0, 0, 1], { maxForce: -1 }), { name: 'RangeError' });
  const hinge = physics.addJoint(physics.addBody(null, { colliders: [] }), physics.addBody(null, { colliders: [] }), {
    type: 'revolute',
    axis: [0, 0, 1],
  });
  assert.throws(() => hinge.setRotationMotor([0, 0, 0, 1]), { name: 'TypeError', message: /spherical joint/ });
  physics.dispose();
});

const distance = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

test('rope joints cap the anchor distance and let the bodies come closer', () => {
  const physics = new Physics(null),
    hook = physics.addBody(null, { type: 'fixed', position: [0, 10, 0], colliders: [] }),
    weight = physics.addBody(null, { position: [0.5, 10, 0], colliders: { shape: 'sphere', radius: 0.1 } });
  physics.addJoint(hook, weight, { type: 'rope', length: 2 });
  let farthest = 0;
  for (let i = 0; i < 240; i++) {
    physics.step();
    farthest = Math.max(farthest, distance(weight.position, [0, 10, 0]));
  }
  assert.ok(farthest < 2.02, `never stretches past its length (${farthest})`);
  near(distance(weight.position, [0, 10, 0]), 2, 0.02, 'hangs taut at its length');
  near(weight.position[1], 8, 0.05, 'hangs below the hook');
  physics.dispose();
});

test('spring joints settle at the rest length plus the static extension', () => {
  const physics = new Physics(null),
    hook = physics.addBody(null, { type: 'fixed', position: [0, 10, 0], colliders: [] }),
    weight = physics.addBody(null, { position: [0, 9, 0], colliders: { shape: 'sphere', radius: 0.1, mass: 2 } }),
    stiffness = 50;
  physics.addJoint(hook, weight, { type: 'spring', restLength: 1, stiffness, damping: 5 });
  for (let i = 0; i < 600; i++) physics.step();
  // A force spring (Hooke's law): the stretch under a 2 kg load is m g / k.
  near(10 - weight.position[1], 1 + (2 * 9.81) / stiffness, 0.01, 'equilibrium length');
  near(weight.linearVelocity[1], 0, 0.01, 'damped to rest');
  physics.gravity = [0, 0, 0];
  for (let i = 0; i < 600; i++) physics.step();
  near(10 - weight.position[1], 1, 0.01, 'rest length without load');
  physics.dispose();
});

test('rope and spring joints refuse what they cannot be', () => {
  const physics = new Physics(null),
    a = physics.addBody(null, { colliders: [] }),
    b = physics.addBody(null, { colliders: [] });
  assert.throws(() => physics.addJoint(a, b, { type: 'rope', length: 0 }), /positive finite number/);
  assert.throws(() => physics.addJoint(a, b, { type: 'spring', restLength: -1, stiffness: 1 }), /restLength/);
  assert.throws(() => physics.addJoint(a, b, { type: 'spring', restLength: 1, stiffness: -1 }), /stiffness and damping/);
  assert.throws(() => physics.addJoint(a, b, { type: 'rope', length: 1 }).setLimits(0, 1), /need a revolute or prismatic joint/);
  physics.dispose();
});
