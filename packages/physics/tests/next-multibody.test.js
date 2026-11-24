// Multibody joints on the own solver: pendulums against their analytic periods and energy, joint limits and motors, exact
// branches, inverse kinematics, contacts and replays.
import assert from 'node:assert/strict';
import test from 'node:test';
import { Physics } from '../dist/next.js';

const G = 9.81;
const near = (actual, expected, tolerance, label) => assert.ok(Math.abs(actual - expected) <= tolerance, `${label}: ${actual} is not within ${tolerance} of ${expected}`);
const bob = (radius = 0.05, mass = 1) => ({ shape: 'sphere', radius, mass });
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

/** A chain of bobs from a fixed pivot at the origin, each `length` below the one before, hinges about Z. */
function chain(physics, count, { length = 1, radius = 0.05, mass = 1, limits, motor } = {}) {
  const pivot = physics.addBody(null, { type: 'fixed', colliders: [] });
  const bodies = [];
  const links = [];
  for (let i = 0; i < count; i++) {
    const body = physics.addBody(null, { position: [0, -length * (i + 1), 0], colliders: bob(radius, mass) });
    bodies.push(body);
    links.push({
      body,
      joint: { type: 'revolute', axis: [0, 0, 1], anchorA: i === 0 ? [0, 0, 0] : [0, 0, 0], anchorB: [0, length, 0], limits, motor },
    });
  }
  // A joint's anchor on the parent is the bob's own origin for links after the first.
  links.forEach((link, i) => (link.joint.anchorA = [0, 0, 0]));
  return { pivot, bodies, multibody: physics.addMultibody(pivot, links) };
}

/** Kinetic plus potential energy of bodies the engine knows by their columns. */
function energy(physics, bodies) {
  let total = 0;
  for (const body of bodies) {
    const m = body.mass,
      v = body.linearVelocity,
      w = body.angularVelocity,
      inertia = body.principalInertia;
    total += 0.5 * m * (v[0] * v[0] + v[1] * v[1] + v[2] * v[2]) + 0.5 * inertia[0] * (w[0] * w[0] + w[1] * w[1] + w[2] * w[2]) + m * G * body.position[1];
  }
  return total;
}

test('a single pendulum swings at its analytic period and keeps its energy', async () => {
  await Physics.load();
  const physics = new Physics(null);
  const { bodies, multibody } = chain(physics, 1);
  const body = bodies[0];
  const inertia = body.mass * 1 + body.principalInertia[0];
  const period = 2 * Math.PI * Math.sqrt(inertia / (body.mass * G * 1));
  multibody.setCoordinates([0.05]);
  let crossings = [];
  let last = multibody.coordinates()[0];
  for (let i = 0; i < 60 * 10; i++) {
    physics.step();
    const angle = multibody.coordinates()[0];
    if (last > 0 && angle <= 0) crossings.push(i / 60 + (last / (last - angle)) / 60);
    last = angle;
  }
  assert.ok(crossings.length >= 4, `${crossings.length} swings`);
  const measured = (crossings[crossings.length - 1] - crossings[0]) / (crossings.length - 1);
  near(measured, period, period * 0.01, 'period');
  physics.dispose();
});

test('a large swing loses less than half a percent of its energy over ten seconds, and the joint never opens', async () => {
  await Physics.load();
  const physics = new Physics(null);
  const { bodies, multibody } = chain(physics, 1);
  multibody.setCoordinates([1.2]);
  const start = energy(physics, bodies);
  let worst = 0;
  for (let i = 0; i < 600; i++) {
    physics.step();
    const p = bodies[0].position;
    // The bob stays 1 m from the pivot.
    worst = Math.max(worst, Math.abs(Math.hypot(p[0], p[1], p[2]) - 1));
  }
  assert.ok(worst < 1e-3, `distance from the pivot drifted by ${worst}`);
  const drift = Math.abs(energy(physics, bodies) - start) / (G * (1 - Math.cos(1.2)));
  assert.ok(drift < 0.005, `energy drift ${drift}`);
  physics.dispose();
});

test('a double pendulum keeps its energy and its joints, whatever it does', async () => {
  await Physics.load();
  const physics = new Physics(null);
  const { bodies, multibody } = chain(physics, 2);
  multibody.setCoordinates([1.0, 1.5]);
  const start = energy(physics, bodies);
  const scale = Math.abs(start) + 2 * G * 2;
  let worstEnergy = 0,
    worstJoint = 0;
  for (let i = 0; i < 60 * 8; i++) {
    physics.step();
    worstEnergy = Math.max(worstEnergy, Math.abs(energy(physics, bodies) - start) / scale);
    const [a, b] = bodies.map((body) => body.position);
    worstJoint = Math.max(worstJoint, Math.abs(Math.hypot(...a) - 1), Math.abs(dist(a, b) - 1));
  }
  assert.ok(worstJoint < 1e-3, `a joint opened by ${worstJoint}`);
  assert.ok(worstEnergy < 0.02, `energy moved by ${worstEnergy} of its scale`);
  physics.dispose();
});

test('limits hold a swinging chain, and a velocity motor holds its speed', async () => {
  await Physics.load();
  const limited = new Physics(null);
  const a = chain(limited, 3, { limits: [-0.5, 0.5] });
  a.multibody.setCoordinates([0.4, 0.4, 0.4]);
  let widest = 0;
  for (let i = 0; i < 300; i++) {
    limited.step();
    widest = Math.max(widest, ...a.multibody.coordinates().map(Math.abs));
  }
  assert.ok(widest < 0.5005, `a joint reached ${widest} past its 0.5 limit`);
  limited.dispose();
  const driven = new Physics(null, { gravity: [0, 0, 0] });
  const b = chain(driven, 2, { motor: { targetVelocity: 1, damping: 100, model: 'force' } });
  for (let i = 0; i < 120; i++) driven.step();
  for (const speed of b.multibody.velocities()) near(speed, 1, 0.1, 'motor speed');
  driven.dispose();
});

test('a branch under far heavier ends holds where joints solved one pass at a time fall apart', async () => {
  await Physics.load();
  const physics = new Physics(null);
  const root = physics.addBody(null, { type: 'fixed', colliders: [] });
  const ball = (position, mass) => physics.addBody(null, { position, colliders: bob(0.05, mass) });
  const trunk = ball([0, -1, 0], 1),
    left = ball([-1, -1, 0], 1000),
    right = ball([1, -1, 0], 0.1),
    far = ball([2, -1, 0], 1000);
  const mb = physics.addMultibody(root, [
    { body: trunk, joint: { type: 'spherical', anchorB: [0, 1, 0] } },
    { body: left, parent: trunk, joint: { type: 'spherical', anchorB: [1, 0, 0] } },
    { body: right, parent: trunk, joint: { type: 'spherical', anchorB: [-1, 0, 0] } },
    { body: far, parent: right, joint: { type: 'spherical', anchorB: [-1, 0, 0] } },
  ]);
  let worst = 0;
  for (let i = 0; i < 240; i++) {
    physics.step();
    worst = Math.max(
      worst,
      Math.abs(dist(trunk.position, left.position) - 1),
      Math.abs(dist(trunk.position, right.position) - 1),
      Math.abs(dist(right.position, far.position) - 1),
      Math.abs(Math.hypot(...trunk.position) - 1),
    );
  }
  // The same tree as plain joints is thrown 42 m apart by its 1000 kg ends.
  assert.ok(worst < 2e-3, `a joint of the branch opened by ${worst}`);
  assert.ok(mb.valid);
  physics.dispose();
});

test('inverse kinematics reaches a target and stops toward one out of reach', async () => {
  await Physics.load();
  const physics = new Physics(null, { gravity: [0, 0, 0] });
  const { bodies, multibody } = chain(physics, 3, { length: 1 });
  const tip = bodies[2];
  const target = [1.2, -1.4, 0];
  const found = multibody.inverseKinematics(tip, { position: target });
  assert.equal(found.converged, true);
  assert.ok(found.positionError < 1e-3, `${found.positionError}`);
  assert.ok(dist(tip.position, target) < 1e-3);
  // Links keep their lengths and the root does not move.
  assert.ok(Math.abs(Math.hypot(...bodies[0].position) - 1) < 1e-4);
  const far = multibody.inverseKinematics(tip, { position: [10, 0, 0] });
  assert.equal(far.converged, false);
  assert.ok(tip.position[0] > 2.9, `reaches out to ${tip.position[0]}`);
  physics.dispose();
});

test('a chain dropped on a floor stays closed and comes to rest', async () => {
  await Physics.load();
  const physics = new Physics(null);
  physics.addBody(null, { type: 'fixed', position: [0, -3.5, 0], colliders: { shape: 'box', halfExtents: [10, 0.5, 10] } });
  const root = physics.addBody(null, { type: 'dynamic', position: [0, 0, 0], colliders: bob(0.1, 1) });
  const links = [];
  const bodies = [root];
  for (let i = 1; i <= 3; i++) {
    const body = physics.addBody(null, { position: [i * 0.5, 0, 0], colliders: bob(0.1, 1) });
    bodies.push(body);
    links.push({ body, joint: { type: 'spherical', anchorA: [0, 0, 0], anchorB: [-0.5, 0, 0] } });
  }
  const mb = physics.addMultibody(root, links);
  let worst = 0;
  for (let i = 0; i < 60 * 6; i++) {
    physics.step();
    for (let k = 1; k < bodies.length; k++) worst = Math.max(worst, Math.abs(dist(bodies[k - 1].position, bodies[k].position) - 0.5));
  }
  assert.ok(worst < 1e-3, `a joint opened by ${worst}`);
  assert.ok(bodies.every((body) => body.position[1] > -3.1 && body.position[1] < -2.7), 'the chain lies on the floor');
  assert.ok(mb.valid);
  physics.dispose();
});

test('removing a multibody or a body of one frees the others, and bad trees throw', async () => {
  await Physics.load();
  const physics = new Physics(null);
  const { pivot, bodies, multibody } = chain(physics, 2);
  assert.throws(() => physics.addMultibody(pivot, [{ body: bodies[0], joint: { type: 'fixed' } }]), { code: 'state' });
  multibody.remove();
  assert.equal(multibody.valid, false);
  assert.throws(() => multibody.coordinates(), { code: 'state' });
  const again = physics.addMultibody(pivot, [{ body: bodies[0], joint: { type: 'revolute', axis: [0, 0, 1], anchorB: [0, 1, 0] } }]);
  assert.equal(again.coordinates().length, 1);
  physics.removeBody(bodies[0]);
  assert.equal(again.valid, false);
  const loose = physics.addBody(null, { colliders: bob() });
  assert.throws(() => physics.addMultibody(pivot, [{ body: loose, parent: bodies[1], joint: { type: 'fixed' } }]), /already in the tree|belong/);
  assert.throws(() => physics.addMultibody(pivot, []), RangeError);
  assert.throws(() => physics.addMultibody(pivot, [{ body: loose, joint: { type: 'rope', length: 1 } }]), TypeError);
  physics.dispose();
});

test('a multibody replays bit for bit', async () => {
  await Physics.load();
  const hash = () => {
    const physics = new Physics(null);
    const { multibody } = chain(physics, 4);
    multibody.setCoordinates([1, 0.5, -0.5, 0.2]);
    for (let i = 0; i < 300; i++) physics.step();
    const h = physics.kernel.hash;
    physics.dispose();
    return h;
  };
  assert.equal(hash(), hash());
});
