// Articulations: joint space (positions, velocities, motors, limits), forward and inverse kinematics, and the dynamics of
// pendulums against closed forms and energy bounds. One unit of world is one metre here (pixelsPerMeter 1).
import test from 'node:test';
import assert from 'node:assert/strict';
import { Physics2D } from '../dist/index.js';

await Physics2D.load();
const G = 9.81;
const world = (options = {}) => new Physics2D(null, { pixelsPerMeter: 1, gravity: [0, G], ...options });
const run = (physics, steps) => {
  for (let i = 0; i < steps; i++) physics.step();
};
const anchorBody = (physics) => physics.addBody(null, { type: 'fixed', position: [0, 0], colliders: [] });
const bob = (physics, options = {}) =>
  physics.addBody(null, {
    position: [0, 0],
    canSleep: false,
    colliders: { shape: 'circle', radius: 0.1, collisionGroups: 0 },
    ...options,
  });

/** Total energy of a body set: kinetic, rotational and gravitational (y points down). */
function energy(bodies) {
  let e = 0;
  for (const b of bodies) {
    const m = b.mass,
      [vx, vy] = b.linearVelocity,
      r = b.rotation;
    void r;
    // Inertia of a circle of radius 0.1 about its centre.
    e += 0.5 * m * (vx * vx + vy * vy) + 0.5 * (0.5 * m * 0.01) * b.angularVelocity ** 2 - m * G * b.position[1];
  }
  return e;
}

test('a pendulum swings with the period of the physical pendulum', () => {
  const physics = world();
  const base = anchorBody(physics);
  const L = 2;
  const weight = bob(physics, { position: [L * Math.sin(0.1), L * Math.cos(0.1)], rotation: 0 });
  const arm = physics.addArticulation(base, [
    { body: weight, joint: { type: 'revolute', anchorParent: [0, 0], anchorChild: [0, -L] } },
  ]);
  // The bob's origin is L from the pivot along its own -y at rotation 0: place it so the joint starts nearly satisfied.
  arm.setPositions([-0.1]);
  const crossings = [];
  let last = arm.positions()[0];
  for (let i = 0; i < 60 * 12; i++) {
    physics.step();
    const q = arm.positions()[0];
    if (last < 0 && q >= 0) crossings.push(i * (1 / 60));
    last = q;
  }
  assert.ok(crossings.length >= 4, `swings: ${crossings.length} crossings`);
  const period = (crossings[crossings.length - 1] - crossings[0]) / (crossings.length - 1);
  const inertia = 0.5 * weight.mass * 0.01 + weight.mass * L * L;
  const expected = 2 * Math.PI * Math.sqrt(inertia / (weight.mass * G * L)) * (1 + 0.1 ** 2 / 16);
  assert.ok(Math.abs(period - expected) / expected < 0.01, `period ${period} against ${expected}`);
  physics.dispose();
});

test('a double pendulum keeps its energy within 3 percent over four seconds', () => {
  const physics = world();
  const base = anchorBody(physics);
  const a = bob(physics, { position: [0, 1] });
  const b = bob(physics, { position: [0, 2] });
  const arm = physics.addArticulation(base, [
    { body: a, joint: { type: 'revolute', anchorChild: [0, -1] } },
    { body: b, parent: 0, joint: { type: 'revolute', anchorParent: [0, 1], anchorChild: [0, -1] } },
  ]);
  arm.setPositions([-1.0, 1.4]);
  a.linearVelocity = [0, 0];
  const e0 = energy([a, b]);
  let worst = 0;
  for (let i = 0; i < 240; i++) {
    physics.step();
    worst = Math.max(worst, Math.abs(energy([a, b]) - e0) / Math.abs(e0 || 1));
  }
  assert.ok(worst < 0.03, `energy moved by ${(worst * 100).toFixed(2)} percent`);
  // The joint space agrees with the bodies: forward kinematics of the positions gives the links' poses.
  const poses = arm.forwardKinematics();
  [a, b].forEach((body, i) => {
    assert.ok(
      Math.hypot(poses[i].position[0] - body.position[0], poses[i].position[1] - body.position[1]) < 0.02,
      `link ${i} pose`,
    );
  });
  physics.dispose();
});

test('joint limits hold and a position motor reaches its target', () => {
  const physics = world({ gravity: [0, 0] });
  const base = anchorBody(physics);
  const link = bob(physics, { position: [1, 0] });
  const arm = physics.addArticulation(base, [
    { body: link, joint: { type: 'revolute', anchorChild: [-1, 0], limits: [-0.5, 0.7] } },
  ]);
  link.angularVelocity = 4;
  let high = -Infinity;
  for (let i = 0; i < 120; i++) {
    physics.step();
    high = Math.max(high, arm.positions()[0]);
  }
  assert.ok(high < 0.7 + 0.06 && arm.positions()[0] < 0.75, `held at the upper limit: ${high}`);
  link.angularVelocity = -4;
  let low = Infinity;
  for (let i = 0; i < 120; i++) {
    physics.step();
    low = Math.min(low, arm.positions()[0]);
  }
  assert.ok(low > -0.5 - 0.06, `held at the lower limit: ${low}`);
  arm.driveTo([0.3], { stiffness: 400, damping: 40 });
  run(physics, 300);
  assert.ok(Math.abs(arm.positions()[0] - 0.3) < 0.03, `reached ${arm.positions()[0]}`);
  assert.ok(Math.abs(arm.velocities()[0]) < 0.05, 'and rests there');
  arm.setLimits(0, -0.1, 0.1);
  run(physics, 120);
  assert.ok(arm.positions()[0] <= 0.16, `a new limit pulls it in: ${arm.positions()[0]}`);
  physics.dispose();
});

test('a prismatic joint slides along its axis within limits and reports its position', () => {
  const physics = world({ gravity: [0, 0] });
  const base = anchorBody(physics);
  const slider = bob(physics, { position: [0, 0] });
  const arm = physics.addArticulation(base, [
    { body: slider, joint: { type: 'prismatic', axis: [1, 1], limits: [-1, 3] } },
  ]);
  slider.linearVelocity = [5, 5];
  run(physics, 120);
  const q = arm.positions()[0];
  assert.ok(q <= 3.08 && q > 2.8, `held at its limit: ${q}`);
  const poses = arm.forwardKinematics();
  assert.ok(Math.hypot(poses[0].position[0] - slider.position[0], poses[0].position[1] - slider.position[1]) < 0.02);
  assert.ok(Math.abs(slider.position[0] - slider.position[1]) < 0.02, 'on its axis');
  physics.dispose();
});

test('inverse kinematics puts the tip of a three-link arm on a target inside its reach', () => {
  const physics = world({ gravity: [0, 0] });
  const base = anchorBody(physics);
  const links = [];
  const specs = [];
  for (let i = 0; i < 3; i++) {
    const body = physics.addBody(null, {
      position: [1 + i * 2, 0],
      colliders: { shape: 'box', width: 2, height: 0.2, collisionGroups: 0 },
    });
    links.push(body);
    specs.push({
      body,
      parent: i - 1,
      joint: { type: 'revolute', anchorParent: i ? [1, 0] : [0, 0], anchorChild: [-1, 0], limits: [-2.5, 2.5] },
    });
  }
  const arm = physics.addArticulation(base, specs);
  assert.equal(arm.dof, 3);
  const tip = [1, 0];
  for (const target of [
    [3, 3],
    [-2, 4],
    [5, -1],
    [0.5, 0.5],
  ]) {
    const result = arm.solveIK(2, tip, target, { iterations: 200, tolerance: 0.005 });
    assert.ok(result.reached, `reaches ${target}: error ${result.error}`);
    assert.ok(
      result.q.every((v) => Math.abs(v) <= 2.5 + 1e-9),
      'inside the limits',
    );
    arm.setPositions(result.q);
    const at = arm.pointAt(2, tip);
    assert.ok(Math.hypot(at[0] - target[0], at[1] - target[1]) < 0.01);
    const body = links[2];
    const actual = [body.position[0] + Math.cos(body.rotation) * 1, body.position[1] + Math.sin(body.rotation) * 1];
    assert.ok(Math.hypot(actual[0] - target[0], actual[1] - target[1]) < 0.02, `the body's tip is at ${actual}`);
  }
  // Out of reach: the arm stretches toward it and says so.
  const far = arm.solveIK(2, tip, [20, 0], { iterations: 600 });
  assert.equal(far.reached, false);
  assert.ok(Math.abs(far.error - 14) < 0.1, `error ${far.error}`);
  // Driven by motors under the physics, the tip gets there too.
  arm.setPositions([0, 0, 0]);
  const goal = arm.solveIK(2, tip, [3, 3], { iterations: 200 });
  arm.driveTo(goal.q, { stiffness: 600, damping: 60 });
  run(physics, 480);
  const at = arm.pointAt(2, tip);
  assert.ok(Math.hypot(at[0] - 3, at[1] - 3) < 0.1, `the driven tip is at ${at}`);
  physics.dispose();
});

test('a long chain under a heavy end does not stretch, and the Jacobian matches finite motion', () => {
  const physics = world();
  const base = anchorBody(physics);
  const specs = [];
  const bodies = [];
  const n = 20;
  for (let i = 0; i < n; i++) {
    const heavy = i === n - 1;
    const body = physics.addBody(null, {
      position: [0, i + 0.5],
      canSleep: false,
      colliders: { shape: 'circle', radius: 0.08, density: heavy ? 3000 : 1, collisionGroups: 0 },
    });
    bodies.push(body);
    specs.push({
      body,
      parent: i - 1,
      joint: { type: 'revolute', anchorParent: i ? [0, 0.5] : [0, 0], anchorChild: [0, -0.5] },
    });
  }
  const arm = physics.addArticulation(base, specs);
  run(physics, 300);
  const length = Math.hypot(bodies[n - 1].position[0], bodies[n - 1].position[1] + 0.5 - 0);
  void length;
  const tip = arm.pointAt(n - 1, [0, 0.5]);
  const reach = Math.hypot(tip[0], tip[1]);
  assert.ok(reach < n * 1.01, `the chain is ${reach} long against ${n}`);
  // Jacobian: a small change of one joint moves the point as the Jacobian says.
  const q = arm.positions();
  const [jx, jy] = arm.jacobian(n - 1, [0, 0.5], q);
  const p0 = arm.pointAt(n - 1, [0, 0.5], q);
  const dq = q.slice();
  dq[3] += 1e-3;
  const p1 = arm.pointAt(n - 1, [0, 0.5], dq);
  assert.ok(
    Math.abs((p1[0] - p0[0]) / 1e-3 - jx[3]) < 0.02 * (1 + Math.abs(jx[3])) &&
      Math.abs((p1[1] - p0[1]) / 1e-3 - jy[3]) < 0.02 * (1 + Math.abs(jy[3])),
  );
  physics.dispose();
});

test('articulation arguments are checked', () => {
  const physics = world();
  const base = anchorBody(physics);
  const a = bob(physics);
  assert.throws(() => physics.addArticulation(base, []), TypeError);
  assert.throws(() => physics.addArticulation(base, [{ body: a, parent: 3, joint: { type: 'revolute' } }]), RangeError);
  assert.throws(() => physics.addArticulation(base, [{ body: a, joint: { type: 'weld' } }]), TypeError);
  const arm = physics.addArticulation(base, [{ body: a, joint: { type: 'revolute' } }]);
  assert.throws(() => arm.setPositions([0, 0]), RangeError);
  assert.throws(() => arm.pointAt(4, [0, 0]), RangeError);
  arm.remove();
  assert.throws(() => arm.positions(), { name: 'MargoError', code: 'state' });
  physics.dispose();
});

/** A humanoid-shaped tree hanging by the head from a fixed hook (y points down, so everything is below it): head, torso, two arms of two links, two legs of three. */
function humanoid(physics, torsoDensity) {
  const hook = physics.addBody(null, { type: 'fixed', position: [0, -6], colliders: [] });
  const body = (x, y, hx, hy, density) =>
    physics.addBody(null, {
      position: [x, -y],
      canSleep: false,
      colliders: { shape: 'box', width: 2 * hx, height: 2 * hy, density, collisionGroups: 0 },
    });
  const specs = [];
  const bodies = [];
  const add = (b, parent, anchorParent, anchorChild) => {
    bodies.push(b);
    specs.push({ body: b, parent, joint: { type: 'revolute', anchorParent, anchorChild } });
    return bodies.length - 1;
  };
  const head = add(body(0, 5.7, 0.15, 0.15, 1), -1, [0, 0], [0, -0.3]);
  const torso = add(body(0, 5, 0.25, 0.5, torsoDensity), head, [0, 0.15], [0, -0.5]);
  const limb = (from, anchor, x, y, links, hx, hy) => {
    let parent = from,
      a = anchor;
    for (let i = 0; i < links; i++) {
      parent = add(body(x, y - i * 2 * hy - hy, hx, hy, 1), parent, a, [0, -hy]);
      a = [0, hy];
    }
  };
  limb(torso, [-0.25, -0.4], -0.25, 5.4, 2, 0.07, 0.25);
  limb(torso, [0.25, -0.4], 0.25, 5.4, 2, 0.07, 0.25);
  limb(torso, [-0.12, 0.5], -0.12, 4.5, 3, 0.08, 0.3);
  limb(torso, [0.12, 0.5], 0.12, 4.5, 3, 0.08, 0.3);
  return { arm: physics.addArticulation(hook, specs), bodies };
}

test('a branched tree with a 1000:1 mass ratio across its branch stays closed: every joint within 1 percent of a link', () => {
  const physics = world();
  const { arm, bodies } = humanoid(physics, 1000);
  assert.equal(arm.dof, 12);
  let worst = 0;
  for (let i = 0; i < 360; i++) {
    physics.step();
    if (i < 60) continue;
    // Forward kinematics of the joint positions, from the root, against where the bodies are: the tree is closed when they agree.
    const poses = arm.forwardKinematics();
    bodies.forEach(
      (b, k) =>
        (worst = Math.max(
          worst,
          Math.hypot(poses[k].position[0] - b.position[0], poses[k].position[1] - b.position[1]),
        )),
    );
  }
  assert.ok(worst < 0.005, `the tree's joints opened by ${worst} m against links of 0.5 m or more`);
  physics.dispose();
});

test('an articulation closed by a joint between its last link and the ground holds a parallelogram linkage: coupler parallel, rocker with the crank', () => {
  const physics = world();
  const ground = anchorBody(physics);
  const pin = physics.addBody(null, { type: 'fixed', position: [4, 0], colliders: [] });
  // Crank AB (1 m) from A = (0, 0), coupler BC (4 m) parallel to the ground, rocker DC (1 m) from D = (4, 0): the crank's turn is the rocker's.
  const turn = 0.8,
    [c, s] = [Math.cos(turn), Math.sin(turn)];
  const crank = bob(physics, { position: [0, 0], rotation: turn });
  const coupler = bob(physics, { position: [c, s], rotation: 0 });
  const rocker = bob(physics, { position: [4, 0], rotation: turn });
  physics.addArticulation(ground, [
    { body: crank, joint: { type: 'revolute' } },
    { body: coupler, parent: 0, joint: { type: 'revolute', anchorParent: [1, 0] } },
    { body: rocker, parent: 1, joint: { type: 'revolute', anchorParent: [4, 0], anchorChild: [1, 0] } },
  ]);
  // The loop: the rocker's foot is pinned to the ground at D by an ordinary joint, closing the ring the articulation left open.
  physics.addJoint(rocker, pin, { type: 'revolute' });
  const worst = { parallel: 0, equal: 0, foot: 0, closed: 0 };
  let swung = 0;
  for (let i = 0; i < 360; i++) {
    physics.step();
    const [a, b, r] = [crank.rotation, coupler.rotation, rocker.rotation];
    worst.parallel = Math.max(worst.parallel, Math.abs(b));
    worst.equal = Math.max(worst.equal, Math.abs(r - a));
    worst.foot = Math.max(worst.foot, Math.hypot(rocker.position[0] - 4, rocker.position[1]));
    // The coupler's far end (4 m along it) is the rocker's far end (1 m along it).
    const end = [coupler.position[0] + 4 * Math.cos(b), coupler.position[1] + 4 * Math.sin(b)];
    const top = [rocker.position[0] + Math.cos(r), rocker.position[1] + Math.sin(r)];
    worst.closed = Math.max(worst.closed, Math.hypot(end[0] - top[0], end[1] - top[1]));
    swung = Math.max(swung, Math.abs(a - turn));
  }
  assert.ok(swung > 0.3, `gravity swings the linkage: ${swung}`);
  assert.ok(worst.parallel < 0.02, `the coupler stays parallel to the ground: ${worst.parallel} rad`);
  assert.ok(worst.equal < 0.02, `the rocker turns with the crank: ${worst.equal} rad`);
  assert.ok(worst.foot < 0.02, `the rocker's foot stays on its pin: ${worst.foot} m`);
  assert.ok(worst.closed < 0.02, `the coupler and the rocker stay joined: ${worst.closed} m`);
  physics.dispose();
});
