// setType, a body's own mass and inertia, extra solver passes and the generic joint, on the own solver, each held to what
// packages/physics/README.md says the root entry does.
import assert from 'node:assert/strict';
import test from 'node:test';
import { Physics } from '../dist/next.js';

await Physics.load();

const near = (got, want, within, what) => assert.ok(Math.abs(got - want) <= within, `${what}: ${got} against ${want}`);
const cube = (half = 0.5, extra = {}) => ({ shape: 'box', halfExtents: [half, half, half], ...extra });

/** A world with a wide floor whose top is at y = 0. */
function floored(options) {
  const physics = new Physics(null, options);
  physics.floor = physics.addBody(null, { type: 'fixed', position: [0, -0.5, 0], colliders: { shape: 'box', halfExtents: [50, 0.5, 50] } });
  return physics;
}

test('a fixed body made dynamic rests on the fixed floor it already touched', () => {
  const physics = floored(),
    crate = physics.addBody(null, { type: 'fixed', position: [0, 0.5, 0], colliders: cube() });
  for (let i = 0; i < 10; i++) physics.step();
  assert.deepEqual(crate.position, [0, 0.5, 0]);
  crate.setType('dynamic');
  assert.equal(crate.type, 'dynamic');
  for (let i = 0; i < 120; i++) physics.step();
  // Two fixed bodies have no pair: without one found at the switch, the crate falls through the floor.
  near(crate.position[1], 0.5, 0.01, 'crate on the floor');
  assert.ok(physics.touching(crate, physics.floor));
  physics.dispose();
});

test('a dynamic body made fixed stops, ends its touch with the fixed floor and holds what lands on it', () => {
  const physics = floored(),
    crate = physics.addBody(null, { position: [0, 0.5, 0], colliders: cube() }),
    floor = physics.floor;
  for (let i = 0; i < 30; i++) physics.step();
  assert.ok(physics.touching(crate, floor));
  const ended = [];
  physics.on('contactend', (event) => ended.push(event));
  crate.setLinearVelocity([3, 0, 0]);
  crate.setType('fixed');
  assert.deepEqual(crate.linearVelocity, [0, 0, 0]);
  const at = crate.position;
  physics.step();
  assert.equal(ended.length, 1, 'the touch with the floor ends');
  assert.equal(physics.touching(crate, floor), false);
  const ball = physics.addBody(null, { position: [0, 3, 0], colliders: { shape: 'sphere', radius: 0.25 } });
  for (let i = 0; i < 120; i++) physics.step();
  assert.deepEqual(crate.position, at, 'a fixed body does not move');
  near(ball.position[1], 1.25, 0.01, 'the ball rests on the crate');
  physics.dispose();
});

test('a body made kinematicPosition holds its pose until given a target, and a sleeper can be switched', () => {
  const physics = floored(),
    crate = physics.addBody(null, { position: [0, 0.5, 0], colliders: cube() });
  for (let i = 0; i < 120; i++) physics.step();
  assert.equal(crate.sleeping, true);
  const at = crate.position;
  crate.setType('kinematicPosition');
  assert.equal(crate.sleeping, false);
  for (let i = 0; i < 10; i++) physics.step();
  assert.deepEqual(crate.position, at);
  crate.setNextPosition([1, 2, 0]);
  physics.step();
  near(crate.position[0], 1, 1e-6, 'x');
  near(crate.position[1], 2, 1e-6, 'y');
  crate.setType('kinematicVelocity');
  crate.setLinearVelocity([0, 0, 6]);
  for (let i = 0; i < 60; i++) physics.step();
  near(crate.position[2], 6, 1e-3, 'kinematic velocity keeps its speed');
  crate.setType('dynamic');
  near(crate.linearVelocity[2], 6, 1e-4, 'a body made dynamic keeps the velocity it had');
  assert.throws(() => crate.setType('ghost'), /Unknown body type ghost; use dynamic, fixed/);
  physics.dispose();
});

test('setAdditionalMass adds a point at the centre of mass, with inertia of its own when given', () => {
  const physics = floored(),
    crate = physics.addBody(null, { position: [0, 4, 0], colliders: cube(0.5, { density: 6 }) });
  // A solid cube of 6 kg and side 1: m s^2 / 6 = 1 about each axis.
  near(crate.mass, 6, 1e-5, 'mass');
  near(crate.principalInertia[0], 1, 1e-5, 'inertia');
  crate.setAdditionalMass(4);
  near(crate.mass, 10, 1e-5, 'mass with the point');
  for (let k = 0; k < 3; k++) near(crate.principalInertia[k], 1, 1e-5, 'a point at the centre turns nothing');
  crate.setAdditionalMass(4, [1, 2, 3]);
  near(crate.mass, 10, 1e-5, 'a second call replaces the first');
  assert.deepEqual(
    crate.principalInertia.map((value) => Math.round(value * 1e5) / 1e5).sort(),
    [2, 3, 4],
  );
  crate.setAdditionalMass(0);
  near(crate.mass, 6, 1e-5, '0 removes it');
  near(crate.principalInertia[1], 1, 1e-5, 'and its inertia');
  // An off-centre collider added later moves the centre; the point stays where it was put.
  crate.setAdditionalMass(6);
  crate.addCollider(cube(0.5, { mass: 12, offset: [3, 0, 0] }));
  near(crate.mass, 24, 1e-4, 'total');
  near(crate.centerOfMass[0], 1.5, 1e-5, 'centre: (6 * 0 + 6 * 0 + 12 * 3) / 24');
  const twisted = physics.addBody(null, { position: [5, 4, 0], colliders: cube(0.5, { density: 6 }), additionalMass: 6 });
  near(twisted.principalInertia[0], 2, 1e-5, 'the additionalMass option spreads as the colliders do');
  twisted.setAdditionalMass(6);
  near(twisted.principalInertia[0], 1, 1e-5, 'setAdditionalMass takes the option out');
  assert.throws(() => crate.setAdditionalMass(1, [1, -1, 1]), /at least 0; pass kilograms and kg m/);
  physics.dispose();
});

test('setMassProperties: mass alone scales the inertia, every figure given is the body exactly', () => {
  const physics = floored(),
    make = (x) => physics.addBody(null, { position: [x, 4, 0], colliders: cube(0.5, { density: 8 }) }),
    body = make(0);
  near(body.principalInertia[0], 8 / 6, 1e-5, 'a cube of 8 kg');
  body.setMassProperties({ mass: 16 });
  assert.equal(body.mass, 16);
  near(body.principalInertia[0], 16 / 6, 1e-5, 'inertia grows with the mass');
  assert.deepEqual(body.centerOfMass, [0, 0, 0]);
  const tuned = make(3),
    frame = [0, Math.SQRT1_2, 0, Math.SQRT1_2];
  tuned.setMassProperties({ mass: 2, centerOfMass: [1, 0, 0], inertia: [1, 2, 3], inertiaFrame: frame });
  assert.equal(tuned.mass, 2);
  assert.deepEqual(tuned.centerOfMass, [1, 0, 0]);
  assert.deepEqual(tuned.principalInertia, [1, 2, 3]);
  tuned.inertiaFrame.forEach((value, k) => near(value, frame[k], 1e-7, `frame ${k}`));
  assert.equal(tuned.colliders[0].density(), 0, 'the colliders no longer count');
  // A collider added afterwards adds its own mass, at its own place.
  tuned.addCollider({ shape: 'sphere', radius: 0.5, mass: 2, offset: [3, 0, 0] });
  near(tuned.mass, 4, 1e-5, 'mass');
  near(tuned.centerOfMass[0], 2, 1e-5, 'centre between the two');
  // It falls as anything does: mass does not change gravity's pull.
  for (let i = 0; i < 30; i++) physics.step();
  near(tuned.linearVelocity[1], -9.81 * 0.5, 0.02, 'half a second of free fall');
  assert.throws(() => tuned.setMassProperties({ mass: -1 }), RangeError);
  assert.throws(() => tuned.setMassProperties({ mass: Infinity }), RangeError);
  assert.throws(() => tuned.setMassProperties({ inertia: [1, -1, 1] }), /must not be negative/);
  physics.dispose();
});

/** A pile and a pendulum on one box, another pile far off, and the bodies to read. */
function scene(iterations, extra) {
  const physics = floored({ iterations }),
    pile = (x) => [0, 1, 2].map((k) => physics.addBody(null, { position: [x, 0.5 + k * 1.02, 0.1 * k], colliders: cube() }));
  const first = pile(0),
    second = pile(20),
    bob = physics.addBody(null, { position: [1.5, 2.6, 0], colliders: { shape: 'sphere', radius: 0.2 } });
  physics.addJoint(first[2], bob, { type: 'spherical', anchorA: [0.5, 0.5, 0], anchorB: [-1, 0, 0] });
  first[0].additionalSolverIterations = extra;
  for (let i = 0; i < 90; i++) physics.step();
  const read = (bodies) => bodies.flatMap((body) => [...body.position, ...body.rotation, ...body.linearVelocity, ...body.angularVelocity]);
  const out = { first: read([...first, bob]), second: read(second) };
  physics.dispose();
  return out;
}

test('extra passes give an island what a world of that many passes would, and leave the others alone', () => {
  for (const [iterations, extra] of [
    [2, 3],
    [1, 1],
    [1, 2],
  ]) {
    const asked = scene(iterations, extra),
      more = scene(iterations + extra, 0),
      plain = scene(iterations, 0);
    assert.deepEqual(asked.first, more.first, `${iterations} passes and ${extra} extra are ${iterations + extra} passes`);
    assert.deepEqual(asked.second, plain.second, `the other island keeps ${iterations} passes`);
    assert.notDeepEqual(asked.first, plain.first, 'the extra passes did something');
  }
  const physics = new Physics(null),
    body = physics.addBody(null);
  assert.equal(body.additionalSolverIterations, 0);
  body.additionalSolverIterations = 4;
  assert.equal(body.additionalSolverIterations, 4);
  assert.throws(() => (body.additionalSolverIterations = -1), /whole number from 0 to 1000/);
  assert.throws(() => (body.additionalSolverIterations = 1.5), RangeError);
  physics.dispose();
});

test('a generic joint is the joint its locks make: all six a fixed joint, the linear three a ball joint', () => {
  const run = (options) => {
    const physics = new Physics(null),
      anchor = physics.addBody(null, { type: 'fixed', position: [0, 5, 0], colliders: [] }),
      arm = physics.addBody(null, { position: [1, 5, 0.2], colliders: cube(0.3) });
    physics.addJoint(anchor, arm, { anchorB: [-1, 0, -0.2], ...options });
    arm.setAngularVelocity([0.5, 1, 2]);
    for (let i = 0; i < 60; i++) physics.step();
    const out = [...arm.position, ...arm.rotation];
    physics.dispose();
    return out;
  };
  const all = ['linX', 'linY', 'linZ', 'angX', 'angY', 'angZ'];
  assert.deepEqual(run({ type: 'generic', locked: all }), run({ type: 'fixed' }));
  assert.deepEqual(run({ type: 'generic', locked: all.slice(0, 3) }), run({ type: 'spherical' }));
});

test('a generic joint holds its limits and drives its motors: the README door, and a slider to its stop', () => {
  const physics = new Physics(null),
    wall = physics.addBody(null, { type: 'fixed', colliders: [] }),
    // A door left to sleep would stop as its approach slows under the sleep threshold, a few thousandths short.
    door = physics.addBody(null, { position: [1, 0, 0], colliders: { shape: 'box', halfExtents: [1, 1, 0.05] }, canSleep: false }),
    hinge = physics.addJoint(wall, door, {
      type: 'generic',
      anchorB: [-1, 0, 0],
      locked: ['linX', 'linY', 'linZ', 'angX', 'angZ'],
      limits: { angY: [-1.5, 1.5] },
      motors: { angY: { targetPosition: 0.6, stiffness: 40, damping: 8 } },
    });
  for (let i = 0; i < 900; i++) physics.step();
  const [, y, , w] = door.rotation;
  near(2 * Math.atan2(y, w), 0.6, 1e-3, 'the door opens to the motor target');
  near(door.position[0], Math.cos(0.6), 1e-3, 'about the hinge');
  hinge.setAxisMotor('angY', { targetVelocity: -3, damping: 1000 });
  for (let i = 0; i < 180; i++) physics.step();
  const [, y2, , w2] = door.rotation;
  near(2 * Math.atan2(y2, w2), -1.5, 0.02, 'driven against the lower limit, it stops there');
  hinge.clearMotor();
  hinge.setAxisLimits('angY', 0, 0.1);
  for (let i = 0; i < 120; i++) physics.step();
  const [, y3, , w3] = door.rotation;
  assert.ok(2 * Math.atan2(y3, w3) > -0.02, 'a new limit takes the door back inside');

  const rail = physics.addBody(null, { type: 'fixed', position: [10, 5, 0], colliders: [] }),
    car = physics.addBody(null, { position: [10, 5, 0], colliders: cube(0.2) });
  // Frame A turned so its X runs down: the car slides along it and stops at 0.5.
  physics.addJoint(rail, car, {
    type: 'generic',
    frameA: [0, 0, -Math.SQRT1_2, Math.SQRT1_2],
    frameB: [0, 0, -Math.SQRT1_2, Math.SQRT1_2],
    locked: ['linY', 'linZ', 'angX', 'angY', 'angZ'],
    limits: { linX: [0, 0.5] },
  });
  for (let i = 0; i < 120; i++) physics.step();
  near(car.position[1], 4.5, 0.01, 'the car hangs at the end of its travel');
  near(car.position[0], 10, 1e-4, 'and stays on the rail');
  physics.dispose();
});
