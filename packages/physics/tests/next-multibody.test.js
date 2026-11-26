// Multibody joints on the own solver: pendulums against their analytic periods and energy, joint limits and motors, exact
// branches, inverse kinematics, contacts and replays.
import assert from 'node:assert/strict';
import test from 'node:test';
import { Physics } from '../dist/index.js';

const G = 9.81;
const near = (actual, expected, tolerance, label) =>
  assert.ok(Math.abs(actual - expected) <= tolerance, `${label}: ${actual} is not within ${tolerance} of ${expected}`);
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
      joint: {
        type: 'revolute',
        axis: [0, 0, 1],
        anchorA: i === 0 ? [0, 0, 0] : [0, 0, 0],
        anchorB: [0, length, 0],
        limits,
        motor,
      },
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
    total +=
      0.5 * m * (v[0] * v[0] + v[1] * v[1] + v[2] * v[2]) +
      0.5 * inertia[0] * (w[0] * w[0] + w[1] * w[1] + w[2] * w[2]) +
      m * G * body.position[1];
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
  const crossings = [];
  let last = multibody.coordinates()[0];
  for (let i = 0; i < 60 * 10; i++) {
    physics.step();
    const angle = multibody.coordinates()[0];
    if (last > 0 && angle <= 0) crossings.push(i / 60 + last / (last - angle) / 60);
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
  physics.addBody(null, {
    type: 'fixed',
    position: [0, -3.5, 0],
    colliders: { shape: 'box', halfExtents: [10, 0.5, 10] },
  });
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
    for (let k = 1; k < bodies.length; k++)
      worst = Math.max(worst, Math.abs(dist(bodies[k - 1].position, bodies[k].position) - 0.5));
  }
  assert.ok(worst < 1e-3, `a joint opened by ${worst}`);
  assert.ok(
    bodies.every((body) => body.position[1] > -3.1 && body.position[1] < -2.7),
    'the chain lies on the floor',
  );
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
  const again = physics.addMultibody(pivot, [
    { body: bodies[0], joint: { type: 'revolute', axis: [0, 0, 1], anchorB: [0, 1, 0] } },
  ]);
  assert.equal(again.coordinates().length, 1);
  physics.removeBody(bodies[0]);
  assert.equal(again.valid, false);
  const loose = physics.addBody(null, { colliders: bob() });
  assert.throws(
    () => physics.addMultibody(pivot, [{ body: loose, parent: bodies[1], joint: { type: 'fixed' } }]),
    /already in the tree|belong/,
  );
  assert.throws(() => physics.addMultibody(pivot, []), RangeError);
  assert.throws(() => physics.addMultibody(pivot, [{ body: loose, joint: { type: 'rope', length: 1 } }]), TypeError);
  physics.dispose();
});

test('a chain of 200 links holds its length, and replays bit for bit', async () => {
  await Physics.load();
  const run = () => {
    const physics = new Physics(null);
    const pivot = physics.addBody(null, { type: 'fixed', colliders: [] });
    const bodies = [];
    const links = [];
    for (let i = 0; i < 200; i++) {
      const body = physics.addBody(null, { position: [0, -0.1 * (i + 1), 0], colliders: bob(0.02, 0.5) });
      bodies.push(body);
      links.push({ body, joint: { type: 'revolute', axis: [0, 0, 1], anchorA: [0, 0, 0], anchorB: [0, 0.1, 0] } });
    }
    const mb = physics.addMultibody(pivot, links);
    assert.equal(mb.coordinates().length, 200);
    mb.setCoordinates(Array.from({ length: 200 }, (_, i) => (i % 2 ? 0.02 : -0.02)));
    let worst = 0;
    for (let i = 0; i < 120; i++) {
      physics.step();
      let previous = [0, 0, 0];
      for (const body of bodies) {
        worst = Math.max(worst, Math.abs(dist(previous, body.position) - 0.1));
        previous = body.position;
      }
    }
    const hash = physics.kernel.hash;
    const tip = bodies[199].position;
    physics.dispose();
    return { worst, hash, tip };
  };
  const first = run();
  assert.ok(first.worst < 1e-3, `a link of the chain opened by ${first.worst}`);
  assert.ok(Math.hypot(...first.tip) < 20.01, 'the chain is no longer than 200 links of 0.1 m');
  assert.equal(run().hash, first.hash);
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

test("inverse and forward dynamics hold a pendulum against the world's gravity, not the Earth's", async () => {
  await Physics.load();
  const moon = 1.62;
  const physics = new Physics(null, { gravity: [0, -moon, 0] });
  const { bodies, multibody } = chain(physics, 1);
  const m = bodies[0].mass;
  multibody.setCoordinates([Math.PI / 2]);
  // Regression: both defaulted to 9.81 down y whatever the world's gravity, so a Moon pendulum was held with six times the torque.
  near(multibody.inverseDynamics()[0], m * Math.fround(moon) * 1, 1e-3, 'm g L with the Moon g');
  near(
    multibody.forwardDynamics([0])[0],
    (-m * Math.fround(moon)) / (bodies[0].principalInertia[2] + m),
    1e-3,
    'and it falls at the Moon rate',
  );
  physics.dispose();
});

test('the mass matrix, the Jacobian and inverse dynamics of a pendulum match the closed forms', async () => {
  await Physics.load();
  const physics = new Physics(null);
  const { bodies, multibody } = chain(physics, 1);
  const [body] = bodies,
    m = body.mass,
    inertia = body.principalInertia[2];
  // Hanging a metre below the pivot, hinge about Z: H = I + m L^2, and the torque that holds it still at an angle q from hanging is m g L sin q.
  const h = multibody.massMatrix();
  near(h[0][0], inertia + m, 1e-4, 'the pendulum mass matrix is its inertia about the pivot');
  multibody.setCoordinates([Math.PI / 2]);
  near(multibody.inverseDynamics()[0], m * G * 1, 1e-3, 'it takes m g L to hold a pendulum horizontal');
  near(
    Math.abs(multibody.inverseDynamics([2])[0] - multibody.inverseDynamics([0])[0]),
    2 * (inertia + m),
    1e-3,
    'an acceleration costs H times it',
  );
  // Forward dynamics undoes inverse dynamics.
  const torque = multibody.inverseDynamics([3]);
  near(multibody.forwardDynamics(torque)[0], 3, 1e-6, 'forward dynamics gives back the acceleration');
  // The Jacobian of the bob's origin: a turn about Z at a metre moves it a metre a radian, along the tangent.
  const j = multibody.jacobian(body);
  near(Math.hypot(j[0][0], j[1][0], j[2][0]), 1, 1e-4, 'a radian carries the bob a metre');
  near(Math.abs(j[5][0]), 1, 1e-6, 'and turns it a radian');
});

test('the mass matrix of a double pendulum, its bias and its Jacobian agree with the motion the engine makes', async () => {
  await Physics.load();
  const physics = new Physics(null);
  const { bodies, multibody } = chain(physics, 2);
  multibody.setCoordinates([0.6, -0.9]);
  const h = multibody.massMatrix(),
    n = multibody.dof;
  assert.equal(n, 2);
  near(h[0][1], h[1][0], 1e-9, 'the mass matrix is symmetric');
  assert.ok(h[0][0] > 0 && h[0][0] * h[1][1] > h[0][1] * h[1][0], 'and positive definite');
  // The Jacobian against the motion a small change of the coordinates makes (forward kinematics through setCoordinates).
  const j = multibody.jacobian(bodies[1]),
    q = multibody.coordinates();
  for (let k = 0; k < n; k++) {
    // A central difference: positions are single precision, so the step is not small.
    const step = 1e-3,
      plus = [...q],
      minus = [...q];
    plus[k] += step;
    minus[k] -= step;
    multibody.setCoordinates(plus);
    const ahead = bodies[1].position;
    multibody.setCoordinates(minus);
    const behind = bodies[1].position;
    for (let r = 0; r < 3; r++)
      near((ahead[r] - behind[r]) / (2 * step), j[r][k], 2e-3, `Jacobian row ${r} column ${k}`);
    multibody.setCoordinates(q);
  }
  // Kinetic energy: half the speeds times H times the speeds is the energy of the bodies (rotation about Z and translation).
  multibody.setCoordinates([0.6, -0.9]);
  const speeds = [1.3, -0.7];
  // Give the bodies the velocities those joint speeds mean: the first turns at 1.3 about the pivot, the second adds -0.7 about its own pivot.
  const [a, b] = bodies,
    w1 = speeds[0],
    w2 = speeds[0] + speeds[1],
    pivot2 = [a.position[0], a.position[1], a.position[2]],
    r1 = [a.position[0], a.position[1], a.position[2]],
    r2 = [b.position[0] - pivot2[0], b.position[1] - pivot2[1], b.position[2] - pivot2[2]];
  a.setAngularVelocity([0, 0, w1]);
  a.setLinearVelocity([-w1 * r1[1], w1 * r1[0], 0]);
  b.setAngularVelocity([0, 0, w2]);
  b.setLinearVelocity([-w1 * r1[1] - w2 * r2[1], w1 * r1[0] + w2 * r2[0], 0]);
  const half = 0.5 * speeds.reduce((sum, s, i) => sum + s * (h[i][0] * speeds[0] + h[i][1] * speeds[1]), 0);
  let kinetic = 0;
  for (const body of bodies) {
    const v = body.linearVelocity,
      w = body.angularVelocity;
    kinetic += 0.5 * body.mass * (v[0] ** 2 + v[1] ** 2 + v[2] ** 2) + 0.5 * body.principalInertia[2] * w[2] ** 2;
  }
  near(half, kinetic, 1e-4, 'the mass matrix gives the kinetic energy');
  // Inverse dynamics under no gravity at rest is H qdd; the bias is the same at rest as with the speeds set to zero.
  const rest = multibody.inverseDynamics([1, 2], { gravity: [0, 0, 0] });
  const damped = [0, 1].map((r) => h[r][0] * 1 + h[r][1] * 2);
  // With speeds present the bias adds the Coriolis terms; check them against H qdd by removing them.
  const bias = multibody.inverseDynamics(undefined, { gravity: [0, 0, 0] });
  near(rest[0] - bias[0], damped[0], 1e-6, 'the acceleration part is H qdd, row 0');
  near(rest[1] - bias[1], damped[1], 1e-6, 'and row 1');
});

test('a tree that is given its inverse dynamics torques follows the accelerations it was asked for', async () => {
  await Physics.load();
  const physics = new Physics(null);
  const { multibody } = chain(physics, 2);
  multibody.setCoordinates([0.3, 0.4]);
  // The accelerations a free swing has now: forward dynamics at zero torque, then the torques that reproduce them.
  const free = multibody.forwardDynamics([0, 0]);
  const torques = multibody.inverseDynamics(free);
  near(torques[0], 0, 1e-6, 'the free swing needs no torque, joint 0');
  near(torques[1], 0, 1e-6, 'joint 1');
  assert.throws(() => multibody.inverseDynamics([1]), RangeError);
  assert.throws(() => multibody.forwardDynamics([1]), RangeError);
});

test('a slider has the mass matrix and the torques of its closed forms', async () => {
  await Physics.load();
  const physics = new Physics(null);
  const root = physics.addBody(null, { type: 'fixed', colliders: [] });
  const slider = physics.addBody(null, { position: [0, 0, 0], colliders: { shape: 'sphere', radius: 0.1, mass: 2 } });
  const mb = physics.addMultibody(root, [
    { body: slider, joint: { type: 'prismatic', axis: [1, 0, 0], anchorA: [0, 0, 0], anchorB: [0, 0, 0] } },
  ]);
  near(mb.massMatrix()[0][0], 2, 1e-6, 'a slider has its mass');
  near(mb.inverseDynamics([3], { gravity: [0, 0, 0] })[0], 6, 1e-6, 'a force of m a along the axis');
  near(
    mb.inverseDynamics([0], { gravity: [-9.81, 0, 0] })[0],
    -2 * -9.81,
    1e-4,
    'and m g to hold it against gravity along the axis',
  );
  const j = mb.jacobian(slider);
  near(j[0][0], 1, 1e-9, 'one metre a metre');
  near(j[3][0], 0, 1e-9, 'with no spin');
});

test('two branches under a fixed root are one island, and swing as mirror images of each other', async () => {
  // Under a root that does not move, the joints unite nothing across the root, so each branch was an island of its own and
  // each island's substeps walked the whole tree: one island projected and placed the other's links. The tree is one island
  // now. Two pendulums started as mirror images swing as mirror images (one link each: a chain of more is chaotic, and its
  // rounding is not mirrored).
  await Physics.load();
  const physics = new Physics(null);
  const root = physics.addBody(null, { type: 'fixed', colliders: [] });
  const arm = (side) => {
    const links = [];
    let parent = root;
    for (let i = 1; i <= 1; i++) {
      const body = physics.addBody(null, { position: [side * i, 0, 0], colliders: bob(0.05, 1) });
      links.push({ body, parent, joint: { type: 'revolute', axis: [0, 0, 1], anchorB: [-side, 0, 0] } });
      parent = body;
    }
    return links;
  };
  const left = arm(-1),
    right = arm(1);
  physics.addMultibody(root, [...left, ...right]);
  physics.step();
  assert.equal(physics.kernel.counts.islands, 1, 'one island for the tree');
  let worst = 0;
  for (let i = 0; i < 240; i++) {
    physics.step();
    for (let k = 0; k < 1; k++) {
      const [l, r] = [left[k].body.position, right[k].body.position];
      worst = Math.max(worst, Math.abs(l[0] + r[0]), Math.abs(l[1] - r[1]));
    }
  }
  assert.ok(worst < 1e-4, `the arms drifted ${worst} m from mirror images`);
  physics.dispose();
});
