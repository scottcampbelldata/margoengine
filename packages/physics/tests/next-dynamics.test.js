// Body dynamics on the own solver, each held to a closed form and to Rapier's (`tests/oracle.js`, as a black box): impulses
// and torque impulses, forces and their reset, the next pose of a kinematic body, locked and per-axis freedom, damping,
// dominance and switching a body or a collider off.
import assert from 'node:assert/strict';
import test from 'node:test';
import { RapierPhysics } from './oracle.js';
import { Physics } from '../dist/index.js';
// Bad input to a body, collider, shape, query or mesh is a coded MargoError linking its help entry (Part 1, item 3).
const rigidCoded = (error) =>
  error?.name === 'MargoError' &&
  error.code === 'unsupported' &&
  /See https:..margoengine.com.errors#physics-(bodies|meshes)$/.test(error.message);

const warn = console.warn;
console.warn = () => {};
await Promise.all([Physics.load(), RapierPhysics.load()]);
console.warn = warn;

const DT = 1 / 60;
const near = (actual, expected, bound, message) =>
  assert.ok(
    Math.abs(actual - expected) <= bound,
    `${message ?? 'value'}: ${actual} is not within ${bound} of ${expected}`,
  );
const nearVec = (actual, expected, bound, message) => {
  assert.equal(actual.length, expected.length, message);
  actual.forEach((value, i) => near(value, expected[i], bound, `${message} [${i}]`));
};
const steps = (physics, count) => {
  for (let i = 0; i < count; i++) physics.step();
};
/** The own world and Rapier's, built by the same function with no gravity unless a test says so. */
const worlds = (build, options = { gravity: [0, 0, 0] }) =>
  [new Physics(null, options), new RapierPhysics(null, options)].map((physics) => ({ physics, ...build(physics) }));
const dispose = (list) => list.forEach(({ physics }) => physics.dispose());
// A ball of radius 1 and mass 2: its inertia is 2/5 m r^2 = 0.8 about every axis.
const ball = { shape: 'sphere', radius: 1, mass: 2 };
const INERTIA = 0.8;
const ground = (physics) =>
  physics.addBody(null, {
    type: 'fixed',
    position: [0, -0.5, 0],
    colliders: { shape: 'box', halfExtents: [20, 0.5, 20] },
  });

test('an impulse lands once: speed is J / m, and at a point it turns the body by r x J / I', () => {
  const list = worlds((physics) => ({
    centre: physics.addBody(null, { colliders: ball }),
    off: physics.addBody(null, { position: [10, 0, 0], colliders: ball }),
  }));
  for (const { physics, centre, off } of list) {
    centre.applyImpulse([4, 0, 0]);
    // (0, 1, 0) x (4, 0, 0) = (0, 0, -4)
    off.applyImpulse([4, 0, 0], [10, 1, 0]);
    steps(physics, 3);
    nearVec(centre.linearVelocity, [2, 0, 0], 1e-5, 'J / m, once');
    nearVec(centre.angularVelocity, [0, 0, 0], 1e-6, 'no arm, no spin');
    nearVec(off.linearVelocity, [2, 0, 0], 1e-5, 'the same push');
    nearVec(off.angularVelocity, [0, 0, -4 / INERTIA], 1e-4, 'r x J / I');
  }
  const [own, rapier] = list;
  nearVec(own.off.angularVelocity, rapier.off.angularVelocity, 1e-4, 'Rapier turns it the same');
  // The named forms are the point argument.
  const named = new Physics(null, { gravity: [0, 0, 0] }),
    body = named.addBody(null, { colliders: ball });
  body.applyImpulseAtPoint([4, 0, 0], [0, 1, 0]);
  named.step();
  nearVec(body.angularVelocity, [0, 0, -4 / INERTIA], 1e-4, 'applyImpulseAtPoint');
  named.dispose();
  dispose(list);
});

test('a torque impulse spins a body by L / I, as Rapier does, and a sleeper wakes unless told not to', () => {
  const list = worlds((physics) => ({
    body: physics.addBody(null, { colliders: ball }),
    quiet: physics.addBody(null, { position: [10, 0, 0], colliders: ball }),
  }));
  for (const { physics, body, quiet } of list) {
    body.applyTorqueImpulse([0, 3, 0]);
    quiet.sleep();
    physics.step();
    quiet.applyTorqueImpulse([0, 0, 1], false);
    assert.equal(quiet.sleeping, true, 'wakeUp false leaves it asleep');
    quiet.applyTorqueImpulse([0, 0, 1]);
    assert.equal(quiet.sleeping, false, 'wakeUp true wakes it');
    steps(physics, 2);
    nearVec(body.angularVelocity, [0, 3 / INERTIA, 0], 1e-4, 'L / I');
    nearVec(body.linearVelocity, [0, 0, 0], 1e-6, 'a pure torque does not travel');
  }
  nearVec(list[0].body.angularVelocity, list[1].body.angularVelocity, 1e-4, 'Rapier agrees');
  dispose(list);
});

test('a force reaches every substep and stays; a torque reset keeps the force, and a force reset takes both', () => {
  const list = worlds((physics) => ({
    body: physics.addBody(null, { colliders: ball }),
  }));
  const [own, rapier] = list;
  for (const { physics, body } of list) {
    // (1, 0, 0) x (0, 0, 2) = (0, -2, 0)
    if (physics === own.physics) body.addForceAtPoint([0, 0, 2], [1, 0, 0]);
    else body.addForce([0, 0, 2], [1, 0, 0]);
    physics.step();
    nearVec(body.linearVelocity, [0, 0, (2 / 2) * DT], 1e-5, 'F / m for one step');
    nearVec(body.angularVelocity, [0, (-2 / INERTIA) * DT, 0], 1e-5, 'torque / I for one step');
    physics.step();
    nearVec(body.linearVelocity, [0, 0, DT * 2], 1e-5, 'the force stays');
  }
  nearVec(own.body.linearVelocity, rapier.body.linearVelocity, 1e-5, 'Rapier agrees on travel');
  nearVec(own.body.angularVelocity, rapier.body.angularVelocity, 1e-5, 'and on turning');
  assert.deepEqual(own.body.appliedForce, [0, 0, 2]);
  nearVec(own.body.appliedTorque, [0, -2, 0], 1e-6, 'what the point added');
  // Torque reset: the force goes on, the turning stops gaining.
  own.body.resetTorques();
  rapier.body.raw.resetTorques(true);
  const turned = own.body.angularVelocity[1];
  steps(own.physics, 2);
  steps(rapier.physics, 2);
  nearVec(own.body.appliedTorque, [0, 0, 0], 0, 'torque cleared');
  assert.deepEqual(own.body.appliedForce, [0, 0, 2], 'force kept');
  near(own.body.angularVelocity[1], turned, 1e-6, 'no more torque, no more gain');
  near(own.body.linearVelocity[2], DT * 4, 1e-5, 'the force still pushes');
  near(rapier.body.linearVelocity[2], DT * 4, 1e-5, 'on Rapier too');
  near(rapier.body.angularVelocity[1], turned, 1e-5, 'on Rapier too');
  // Force reset: both go.
  for (const { physics, body } of list) {
    body.addTorque([0, 0, 1]);
    body.resetForces();
    const before = body.linearVelocity[2];
    steps(physics, 2);
    near(body.linearVelocity[2], before, 1e-6, 'a reset force pushes no more');
    near(body.angularVelocity[2], 0, 1e-6, 'nor does the torque turn it');
  }
  assert.deepEqual(own.body.appliedForce, [0, 0, 0]);
  assert.deepEqual(own.body.appliedTorque, [0, 0, 0]);
  dispose(list);
});

test('setNextRotation lands the body on the target pose and a paddle turned by it sweeps what it meets, as on Rapier', () => {
  const quarter = (angle) => [0, Math.sin(angle / 2), 0, Math.cos(angle / 2)];
  const list = worlds((physics) => ({
    paddle: physics.addBody(null, {
      type: 'kinematicPosition',
      colliders: { shape: 'box', halfExtents: [2, 0.2, 0.2] },
    }),
    ball: physics.addBody(null, {
      position: [0, 0, -1],
      colliders: { shape: 'sphere', radius: 0.3, mass: 1 },
    }),
  }));
  for (const { physics, paddle } of list) {
    paddle.setNextRotation(quarter(0.6));
    physics.step();
    nearVec(paddle.rotation, quarter(0.6), 1e-6, 'the target is where it is');
    nearVec(paddle.position, [0, 0, 0], 1e-9, 'and it did not move');
  }
  const [own, rapier] = list;
  near(own.paddle.angularVelocity[1], 0.6 / DT, 1e-2, 'the turn it made, in rad/s');
  // Keep turning: the end of the paddle (x = 2 at start) swings toward -z and carries the ball along.
  let angle = 0.6;
  for (let i = 0; i < 40; i++) {
    angle += 0.05;
    for (const { physics, paddle } of list) {
      paddle.setNextRotation(quarter(angle));
      physics.step();
    }
  }
  nearVec(own.paddle.rotation, quarter(angle), 1e-6, 'every step lands on its target');
  nearVec(rapier.paddle.rotation, quarter(angle), 1e-6, 'on Rapier too');
  assert.ok(
    own.ball.linearVelocity.some((v) => Math.abs(v) > 0.01) || own.ball.position[2] !== -1,
    'the ball was pushed',
  );
  nearVec(own.ball.position, rapier.ball.position, 0.05, 'it ends where Rapier leaves it');
  dispose(list);
});

test('locked axes hold under impulses and torques, and per-axis freedom reads back and can change', () => {
  const list = worlds((physics) => ({
    pinned: physics.addBody(null, { lockTranslations: true, colliders: ball }),
    stiff: physics.addBody(null, { position: [10, 0, 0], lockRotations: true, colliders: ball }),
    flat: physics.addBody(null, {
      position: [20, 0, 0],
      enabledTranslations: [true, false, true],
      enabledRotations: [false, true, false],
      colliders: ball,
    }),
  }));
  for (const { physics, pinned, stiff, flat } of list) {
    for (const body of [pinned, stiff, flat]) {
      body.applyImpulse([2, 2, 2]);
      body.applyTorqueImpulse([1, 1, 1]);
    }
    steps(physics, 30);
    nearVec(pinned.position, [0, 0, 0], 1e-9, 'a locked body stays');
    nearVec(pinned.linearVelocity, [0, 0, 0], 1e-9, 'with no speed');
    assert.ok(pinned.angularVelocity[0] > 0.1, 'and still turns');
    nearVec(stiff.angularVelocity, [0, 0, 0], 1e-9, 'a body that cannot turn does not');
    assert.ok(stiff.position[0] > 10.4, 'and still travels');
    near(flat.position[1], 0, 1e-9, 'a body held on y stays on y');
    assert.ok(flat.position[0] > 20.4 && flat.position[2] > 0.4, 'and travels on x and z');
    nearVec(
      flat.angularVelocity.map((v, i) => (i === 1 ? 0 : v)),
      [0, 0, 0],
      1e-9,
      'it turns about y only',
    );
    assert.ok(flat.angularVelocity[1] > 0.1);
  }
  const [own, rapier] = list;
  nearVec(own.flat.position, rapier.flat.position, 1e-3, 'Rapier travels it the same');
  nearVec(own.flat.angularVelocity, rapier.flat.angularVelocity, 1e-4, 'and turns it the same');

  // Read back and change after creation.
  const { physics, flat, pinned } = own;
  assert.deepEqual(flat.enabledTranslations, [true, false, true]);
  assert.deepEqual(flat.enabledRotations, [false, true, false]);
  assert.deepEqual(pinned.enabledTranslations, [false, false, false]);
  assert.deepEqual(pinned.enabledRotations, [true, true, true]);
  flat.enabledTranslations = [true, true, true];
  flat.enabledRotations = [true, true, true];
  assert.deepEqual(flat.enabledTranslations, [true, true, true]);
  flat.setLinearVelocity([0, 3, 0]);
  const y = flat.position[1];
  steps(physics, 6);
  assert.ok(flat.position[1] > y + 0.2, 'a freed axis moves');
  pinned.lockTranslations(false);
  pinned.setLinearVelocity([0, 0, 3]);
  steps(physics, 6);
  assert.ok(pinned.position[2] > 0.2, 'lockTranslations(false) frees the body');
  pinned.lockRotations();
  assert.deepEqual(pinned.enabledRotations, [false, false, false]);
  assert.throws(() => (flat.enabledTranslations = [true, false]), { name: 'MargoError', message: /three booleans/ });
  assert.throws(() => (flat.enabledRotations = [1, 0, 1]), { name: 'MargoError', message: /three booleans/ });
  dispose(list);
});

test('angular damping decays the spin by the implicit factor, towards exp(-c t), as Rapier does', () => {
  const c = 2,
    spin = 4,
    list = worlds((physics) => ({
      damped: physics.addBody(null, { angularDamping: c, angularVelocity: [0, spin, 0], colliders: ball }),
      free: physics.addBody(null, { position: [10, 0, 0], angularVelocity: [0, spin, 0], colliders: ball }),
      moving: physics.addBody(null, {
        position: [20, 0, 0],
        angularDamping: c,
        linearVelocity: [3, 0, 0],
        colliders: ball,
      }),
    }));
  for (const { physics } of list) steps(physics, 60);
  const [own, rapier] = list;
  // Rapier takes one implicit step of dt; the own solver takes eight substeps of dt / 8, each the same form.
  const rapierFactor = (1 + c * DT) ** -60,
    ownFactor = (1 + (c * DT) / 8) ** -480;
  near(rapier.damped.angularVelocity[1], spin * rapierFactor, 1e-3, 'Rapier follows its own factor');
  near(
    own.damped.angularVelocity[1],
    spin * ownFactor,
    1e-3,
    'the own solver follows the implicit factor of its substeps',
  );
  near(own.damped.angularVelocity[1], spin * Math.exp(-c), spin * 0.03, 'and sits near exp(-c t)');
  near(own.damped.angularVelocity[1], rapier.damped.angularVelocity[1], spin * 0.03, 'within a few per cent of Rapier');
  near(own.free.angularVelocity[1], spin, 1e-6, 'no damping, no loss');
  near(own.moving.linearVelocity[0], 3, 1e-6, 'angular damping leaves the travel alone');
  dispose(list);
});

test('a higher dominance is a wall to a lower one in contacts only, as on Rapier', () => {
  const head = (dominance) =>
    worlds((physics) => {
      const bodies = (y, left, right) => ({
        left: physics.addBody(null, {
          position: [-2, y, 0],
          linearVelocity: [2, 0, 0],
          dominance: left,
          colliders: { shape: 'box', halfExtents: [0.5, 0.5, 0.5] },
        }),
        right: physics.addBody(null, {
          position: [2, y, 0],
          linearVelocity: [-2, 0, 0],
          dominance: right,
          colliders: { shape: 'box', halfExtents: [0.5, 0.5, 0.5] },
        }),
      });
      return bodies(0, ...dominance);
    });
  for (const [label, dominance, speeds] of [
    ['equal groups stop each other', [0, 0], [0, 0]],
    ['the higher keeps its speed and the lower leaves with it', [1, 0], [2, 2]],
    ['and the other way round', [0, 1], [-2, -2]],
    ['any gap counts, not just one', [30, -5], [2, 2]],
    ['equal groups above zero stop each other as well', [7, 7], [0, 0]],
  ]) {
    const list = head(dominance);
    for (const { physics } of list) steps(physics, 90);
    // Rapier leaves a recoil of about 0.1 m/s after a head-on stop, and sends a body that meets a ruling one away at
    // 0.6 m/s where the own solver, with the wall as heavy as the world, sends it at the wall's own 2 m/s. The sign,
    // and the ruling body's speed, are the same.
    const [own, rapier] = list;
    near(own.left.linearVelocity[0], speeds[0], 0.03, `${label}: left`);
    near(own.right.linearVelocity[0], speeds[1], 0.03, `${label}: right`);
    const ruler = dominance[0] === dominance[1] ? null : dominance[0] > dominance[1] ? 'left' : 'right';
    if (!ruler) {
      near(rapier.left.linearVelocity[0], 0, 0.15, `${label}: Rapier left`);
      near(rapier.right.linearVelocity[0], 0, 0.15, `${label}: Rapier right`);
    } else {
      const other = ruler === 'left' ? 'right' : 'left',
        wall = speeds[ruler === 'left' ? 0 : 1];
      near(rapier[ruler].linearVelocity[0], wall, 0.03, `${label}: Rapier's ruling body keeps its speed`);
      assert.ok(
        rapier[other].linearVelocity[0] * wall > 0.3,
        `${label}: Rapier's lower body leaves the way the wall goes`,
      );
    }
    dispose(list);
  }
  // A floor still holds a body of any dominance.
  const list = worlds(
    (physics) => {
      ground(physics);
      return {
        body: physics.addBody(null, {
          position: [0, 0.5, 0],
          dominance: 5,
          colliders: { shape: 'box', halfExtents: [0.5, 0.5, 0.5] },
        }),
      };
    },
    { gravity: [0, -9.81, 0] },
  );
  for (const { physics, body } of list) {
    steps(physics, 60);
    near(body.position[1], 0.5, 0.02, 'the floor holds it');
  }
  dispose(list);
});

test('switching a body or a collider off takes it out of the world, and on puts it back, as on Rapier', () => {
  const list = worlds(
    (physics) => {
      ground(physics);
      const lower = physics.addBody(null, {
          position: [0, 0.5, 0],
          colliders: { shape: 'box', halfExtents: [0.5, 0.5, 0.5] },
        }),
        upper = physics.addBody(null, {
          position: [0, 1.5, 0],
          colliders: { shape: 'box', halfExtents: [0.5, 0.5, 0.5] },
        });
      return { lower, upper };
    },
    { gravity: [0, -9.81, 0] },
  );
  for (const { physics, lower, upper } of list) {
    steps(physics, 60);
    near(upper.position[1], 1.5, 0.03, 'the pair stands');
    assert.equal(lower.enabled, true);
    lower.enabled = false;
    assert.equal(lower.enabled, false);
    const held = lower.position;
    steps(physics, 90);
    assert.deepEqual(lower.position, held, 'a disabled body keeps its pose');
    near(upper.position[1], 0.5, 0.03, 'what stood on it came down to the floor');
    upper.setPosition([0, 3, 0]);
    lower.enabled = true;
    steps(physics, 150);
    near(upper.position[1], 1.5, 0.05, 'and it holds again');
    const collider = lower.colliders[0];
    collider.setEnabled(false);
    assert.equal(collider.isEnabled(), false);
    steps(physics, 90);
    near(upper.position[1], 0.5, 0.05, 'what it held comes down');
    // Rapier works the mass out again without the collider, so a body left with none is massless and gravity leaves it be;
    // the own solver keeps the mass (the README says so), so the body falls through the floor.
    if (physics === list[0].physics) assert.ok(lower.position[1] < -1, 'with no collider it falls through the floor');
  }
  const [own, rapier] = list;
  near(own.upper.position[1], rapier.upper.position[1], 0.05, 'both leave the upper box on the floor');
  dispose(list);
});
