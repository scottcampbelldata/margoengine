// What a body reads and sets after creation: damping and dominance, the velocity at a point, predicted poses, the next
// kinematic pose, energies, inverse mass and inertia, effective masses, `isMoving`, and the gyroscopic switch.
import assert from 'node:assert/strict';
import test from 'node:test';
import { Physics } from '../dist/index.js';
// Bad input to a body, collider, shape, query or mesh is a coded MargoError linking its help entry (Part 1, item 3).
const rigidCoded = (error) =>
  error?.name === 'MargoError' &&
  error.code === 'unsupported' &&
  /See https:..margoengine.com.errors#physics-(bodies|meshes)$/.test(error.message);

const near = (actual, expected, bound, message) =>
  assert.ok(Math.abs(actual - expected) <= bound, `${message}: ${actual} is not within ${bound} of ${expected}`);
const nearAll = (actual, expected, bound, message) =>
  expected.forEach((value, i) => near(actual[i], value, bound, `${message}[${i}]`));

function box(physics, options = {}) {
  return physics.addBody(null, {
    colliders: { shape: 'box', halfExtents: [0.5, 1, 1.5], mass: 6 },
    ...options,
  });
}

test('damping and dominance read and change after creation', async () => {
  await Physics.load();
  const physics = new Physics(null, { gravity: [0, 0, 0] });
  const body = box(physics, { linearDamping: 0.3, angularDamping: 0.4, dominance: 5 });
  near(body.linearDamping, 0.3, 1e-6, 'linear damping');
  near(body.angularDamping, 0.4, 1e-6, 'angular damping');
  assert.equal(body.dominance, 5);
  body.linearDamping = 2;
  body.setLinearVelocity([4, 0, 0]);
  for (let i = 0; i < 60; i++) physics.step();
  // Implicit damping: v shrinks by 1 / (1 + c dt) a step, towards exp(-c t) = 0.135 of 4 after a second.
  near(body.linearVelocity[0], 4 * Math.exp(-2), 0.1, 'the new damping acts');
  body.angularDamping = 0;
  body.setAngularVelocity([0, 3, 0]);
  for (let i = 0; i < 60; i++) physics.step();
  near(body.angularVelocity[1], 3, 1e-3, 'no angular damping keeps the spin');
  body.dominance = -20;
  assert.equal(body.dominance, -20);
  assert.throws(() => (body.linearDamping = -1), rigidCoded);
  assert.throws(() => (body.angularDamping = Number.NaN), rigidCoded);
  assert.throws(() => (body.dominance = Number.NaN), rigidCoded);
  physics.dispose();
});

test('velocity at a point is the linear velocity plus the spin crossed with the arm from the centre of mass', async () => {
  await Physics.load();
  const physics = new Physics(null, { gravity: [0, 0, 0] });
  const body = box(physics, { position: [1, 2, 3] });
  body.setLinearVelocity([1, 0, 0]);
  body.setAngularVelocity([0, 0, 2]);
  // At 1 m along +y from the centre, a spin of 2 about z gives -2 along x: v = (1, 0, 0) + (0, 0, 2) x (0, 1, 0).
  nearAll(body.velocityAtPoint([1, 3, 3]), [-1, 0, 0], 1e-6, 'a point above the centre');
  nearAll(body.velocityAtPoint(body.worldCenterOfMass), [1, 0, 0], 1e-6, 'the centre itself');
  physics.dispose();
});

test('predicted poses integrate the velocity, and with forces the velocity first', async () => {
  await Physics.load();
  const physics = new Physics(null, { gravity: [0, 0, 0] });
  const body = box(physics, { position: [0, 1, 0] });
  body.setLinearVelocity([2, 0, 0]);
  body.setAngularVelocity([0, 0, 1]);
  const now = body.predictPositionUsingVelocity(0.5);
  nearAll(now.position, [1, 1, 0], 1e-5, 'position after half a second');
  near(now.rotation[2], Math.sin(0.25), 1e-5, 'a turn of 0.5 rad about z');
  // 12 N on 6 kg is 2 m/s2: velocity 3 m/s after half a second's push, then position = 0 + 3 * 0.5.
  body.addForce([12, 0, 0]);
  nearAll(body.predictPositionUsingVelocityAndForces(0.5).position, [1.5, 1, 0], 1e-5, 'with the force');
  nearAll(body.position, [0, 1, 0], 0, 'the body has not moved');
  // A fixed body predicts where it is.
  const floor = physics.addBody(null, { type: 'fixed', position: [3, 0, 0] });
  nearAll(floor.predictPositionUsingVelocity(1).position, [3, 0, 0], 0, 'a fixed body');
  assert.throws(() => body.predictPositionUsingVelocity(Number.NaN), rigidCoded);
  physics.dispose();
});

test('a kinematic body reads the pose it was given to reach', async () => {
  await Physics.load();
  const physics = new Physics(null, { gravity: [0, 0, 0] });
  const paddle = physics.addBody(null, {
    type: 'kinematicPosition',
    colliders: { shape: 'box', halfExtents: [1, 0.1, 1] },
  });
  paddle.setNextPosition([1, 2, 3]);
  paddle.setNextRotation([0, 0, Math.SQRT1_2, Math.SQRT1_2]);
  nearAll(paddle.nextPosition, [1, 2, 3], 1e-6, 'next position');
  nearAll(paddle.nextRotation, [0, 0, Math.SQRT1_2, Math.SQRT1_2], 1e-6, 'next rotation');
  physics.step();
  nearAll(paddle.position, [1, 2, 3], 1e-5, 'it lands there');
  physics.dispose();
});

test('energies: kinetic is half m v squared plus half I w squared, potential is minus m g dot the centre', async () => {
  await Physics.load();
  const physics = new Physics(null);
  const body = box(physics, { position: [0, 2, 0] });
  body.setLinearVelocity([3, 0, 4]);
  body.setAngularVelocity([0, 2, 0]);
  const [, iy] = body.principalInertia;
  // The principal axes of an axis-aligned box are the world axes: I about y of a 1 x 2 x 3 box of 6 kg is 6 (1 + 9) / 12 = 5.
  near(iy, 5, 1e-4, 'inertia about y');
  near(body.kineticEnergy, 0.5 * 6 * 25 + 0.5 * 5 * 4, 1e-3, 'kinetic energy');
  near(body.gravitationalPotentialEnergy(), 6 * 9.81 * 2, 1e-3, 'potential energy at the world gravity');
  near(body.gravitationalPotentialEnergy([0, -1, 0]), 6 * 2, 1e-4, 'at a gravity given');
  physics.dispose();
});

test('inverse mass, inverse inertia, the world centre of mass and the effective masses', async () => {
  await Physics.load();
  const physics = new Physics(null);
  const body = box(physics, { position: [1, 2, 3] });
  near(body.inverseMass, 1 / 6, 1e-6, 'inverse mass');
  nearAll(
    body.inversePrincipalInertia,
    body.principalInertia.map((i) => 1 / i),
    1e-5,
    'inverse inertia',
  );
  nearAll(body.worldCenterOfMass, [1, 2, 3], 1e-6, 'centre of mass');
  nearAll(body.effectiveInverseMass, [1 / 6, 1 / 6, 1 / 6], 1e-6, 'free body');
  const inertia = body.effectiveAngularInertia;
  near(inertia[0], (6 * (4 + 9)) / 12, 1e-3, 'x of a 1 x 2 x 3 box: 6.5');
  near(inertia[4], 5, 1e-3, 'y');
  near(inertia[8], (6 * (1 + 4)) / 12, 1e-3, 'z: 2.5');
  near(body.effectiveWorldInverseInertia[0], 1 / 6.5, 1e-4, 'inverse inertia in the world');
  // Locked axes take their freedom away: a body locked in x and in turning about y.
  body.enabledTranslations = [false, true, true];
  body.enabledRotations = [true, false, true];
  nearAll(body.effectiveInverseMass, [0, 1 / 6, 1 / 6], 1e-6, 'x locked');
  near(body.effectiveWorldInverseInertia[4], 0, 0, 'y turn locked');
  near(body.effectiveWorldInverseInertia[0], 1 / 6.5, 1e-4, 'x turn kept');
  assert.equal(body.effectiveAngularInertia[4], Infinity);
  physics.dispose();
});

test('isMoving, copyFrom and the gyroscopic switch', async () => {
  await Physics.load();
  const physics = new Physics(null, { gravity: [0, 0, 0] });
  const body = box(physics);
  assert.equal(body.isMoving, false);
  body.setAngularVelocity([0, 1e-3, 0]);
  assert.equal(body.isMoving, true);
  body.setAngularVelocity([0, 0, 0]);
  body.setLinearVelocity([0, 0, 0.01]);
  assert.equal(body.isMoving, true);
  // copyFrom takes another body's settings, not its pose, colliders or joints.
  const source = box(physics, {
    position: [5, 0, 0],
    linearDamping: 0.7,
    angularDamping: 0.2,
    gravityScale: 0.5,
    dominance: 3,
    ccd: true,
  });
  const target = physics.addBody(null, { position: [0, 9, 0] });
  target.copyFrom(source);
  near(target.linearDamping, 0.7, 1e-6, 'damping');
  near(target.angularDamping, 0.2, 1e-6, 'angular damping');
  near(target.gravityScale, 0.5, 1e-6, 'gravity scale');
  assert.equal(target.dominance, 3);
  assert.equal(target.ccd, true);
  assert.deepEqual(target.position, [0, 9, 0]);
  assert.throws(() => target.copyFrom(target), rigidCoded);
  // Gyroscopic forces: a body spun off a principal axis has a spin that changes in the world's frame as Euler's equations say; without
  // the term the spin stays as it was.
  const spin = (gyro) => {
    const world = new Physics(null, { gravity: [0, 0, 0] });
    const top = world.addBody(null, { colliders: { shape: 'box', halfExtents: [0.5, 1, 1.5], mass: 6 } });
    top.gyroscopicForces = gyro;
    top.setAngularVelocity([1, 2, 1]);
    for (let i = 0; i < 60; i++) world.step();
    const w = top.angularVelocity;
    world.dispose();
    return w;
  };
  assert.equal(new Physics(null).addBody(null, {}).gyroscopicForces, true);
  nearAll(spin(false), [1, 2, 1], 1e-5, 'no gyroscopic term: the spin is what it was');
  const turned = spin(true);
  assert.ok(Math.hypot(turned[0] - 1, turned[1] - 2, turned[2] - 1) > 0.2, `with it the spin moves: ${turned}`);
  physics.dispose();
});
