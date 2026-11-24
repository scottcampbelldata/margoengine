// What the own 2D kernel adds to the facade: filtering, sensors, force events, dominance, continuous collision,
// colliders that change after creation, forces, and removal.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Physics2D, interactionGroups } from '../dist/index.js';

await Physics2D.load();
const world = (options = {}) => new Physics2D(null, options);
const run = (physics, steps) => {
  for (let i = 0; i < steps; i++) physics.step();
};
const floor = (physics, extra = {}) =>
  physics.addBody(null, { type: 'fixed', position: [0, 100], colliders: { shape: 'box', width: 1000, height: 20, ...extra } });

test('collision groups let a body fall through a floor it does not meet', () => {
  const physics = world();
  floor(physics, { collisionGroups: interactionGroups([0], [0]) });
  const ghost = physics.addBody(null, { colliders: { shape: 'circle', radius: 5, collisionGroups: interactionGroups([1], [1]) } });
  const solid = physics.addBody(null, { position: [50, 0], colliders: { shape: 'circle', radius: 5, collisionGroups: interactionGroups([0], [0]) } });
  run(physics, 240);
  assert.ok(ghost.position[1] > 300, `fell through to ${ghost.position[1]}`);
  assert.ok(solid.position[1] < 100, `rests on the floor at ${solid.position[1]}`);
  physics.dispose();
});

test('a sensor reports entry and exit and pushes nothing; setSensor changes it later', () => {
  const physics = world();
  const zone = physics.addBody(null, { type: 'fixed', position: [0, 200], colliders: { shape: 'box', width: 100, height: 40, sensor: true } });
  const ball = physics.addBody(null, { position: [0, 0], colliders: { shape: 'circle', radius: 4 } });
  const seen = [];
  physics.on('intersectionstart', (e) => seen.push(['start', e.sensor, e.bodyA === zone || e.bodyB === zone]));
  physics.on('intersectionend', () => seen.push(['end']));
  run(physics, 240);
  assert.deepEqual(seen, [['start', true, true], ['end']]);
  assert.ok(ball.position[1] > 300, 'the ball fell straight through');
  const collider = zone.colliders[0];
  assert.equal(collider.isSensor(), true);
  collider.setSensor(false);
  assert.equal(collider.isSensor(), false);
  const second = physics.addBody(null, { position: [0, 0], colliders: { shape: 'circle', radius: 4 } });
  run(physics, 240);
  assert.ok(second.position[1] < 200, `a solid zone stops it: ${second.position[1]}`);
  physics.dispose();
});

test('contact force events fire past the threshold and carry the force and normal', () => {
  const physics = world();
  floor(physics);
  physics.addBody(null, { position: [0, 60], colliders: { shape: 'circle', radius: 6, contactForceThreshold: 5 } });
  const forces = [];
  physics.on('contactforce', (e) => forces.push(e));
  run(physics, 120);
  assert.ok(forces.length > 0, 'the landing pushed hard');
  assert.ok(forces.every((f) => f.force > 5 && Math.abs(Math.hypot(...f.normal) - 1) < 1e-3));
  physics.dispose();
});

test('solver groups that do not meet report the contact but push nothing', () => {
  const physics = world();
  floor(physics, { solverGroups: interactionGroups([0], [0]) });
  const ball = physics.addBody(null, { position: [0, 60], colliders: { shape: 'circle', radius: 6, solverGroups: interactionGroups([1], [1]) } });
  let started = 0;
  physics.on('contactstart', () => started++);
  run(physics, 240);
  assert.equal(started, 1);
  assert.ok(ball.position[1] > 200, `sank through: ${ball.position[1]}`);
  physics.dispose();
});

test('a body of higher dominance is not pushed by a lighter one', () => {
  const physics = world({ gravity: [0, 0] });
  const make = (x, vx, dominance, density) =>
    physics.addBody(null, { position: [x, 0], linearVelocity: [vx, 0], dominance, canSleep: false, colliders: { shape: 'box', width: 16, height: 16, density, friction: 0 } });
  const heavy = make(0, 0, 1, 100);
  const light = make(-60, 100, 0, 1);
  run(physics, 60);
  assert.ok(Math.abs(heavy.linearVelocity[0]) < 1e-3, `the dominant body stays: ${heavy.linearVelocity[0]}`);
  assert.ok(light.position[0] < -8, 'and stops the light one');
  assert.throws(() => physics.addBody(null, { dominance: 200 }), RangeError);
  physics.dispose();
});

test('continuous collision stops a fast body at a thin wall', () => {
  for (const ccd of [false, true]) {
    const physics = world({ gravity: [0, 0] });
    physics.addBody(null, { type: 'fixed', position: [320, 0], colliders: { shape: 'box', width: 2, height: 400 } });
    const bullet = physics.addBody(null, { linearVelocity: [9600, 0], ccd, canSleep: false, colliders: { shape: 'circle', radius: 4, restitution: 0 } });
    run(physics, 20);
    if (ccd) assert.ok(bullet.position[0] < 320, `held at ${bullet.position[0]}`);
    else assert.ok(bullet.position[0] > 330, `control tunnels: ${bullet.position[0]}`);
    physics.dispose();
  }
});

test('forces act every step until reset; impulses at a point spin; sleep and wake', () => {
  const physics = world({ gravity: [0, 0] });
  const body = physics.addBody(null, { colliders: { shape: 'box', width: 32, height: 32 } });
  body.applyForce([10, 0]);
  run(physics, 60);
  const v = body.linearVelocity[0];
  assert.ok(Math.abs(v - (10 / body.mass) * 32) < 1, `v ${v} for mass ${body.mass}`);
  body.resetForces();
  run(physics, 30);
  assert.ok(Math.abs(body.linearVelocity[0] - v) < 0.5);
  const other = physics.addBody(null, { position: [200, 0], colliders: { shape: 'box', width: 32, height: 32 } });
  other.applyImpulseAtPoint([0, 1], [216, 0]);
  assert.ok(other.angularVelocity !== 0);
  other.sleep();
  assert.equal(other.sleeping, true);
  other.wakeUp();
  assert.equal(other.sleeping, false);
  physics.dispose();
});

test('colliders and bodies can be removed, and what they touched wakes', () => {
  const physics = world();
  const ground = floor(physics);
  const ball = physics.addBody(null, { position: [0, 60], colliders: { shape: 'circle', radius: 6 } });
  run(physics, 300);
  assert.equal(ball.sleeping, true);
  ground.colliders[0].remove();
  assert.equal(ground.colliders.length, 0);
  run(physics, 60);
  assert.equal(ball.sleeping, false);
  assert.ok(ball.position[1] > 120);
  ball.remove();
  assert.equal(physics.bodyCount, 1);
  const again = physics.addBody(null, { colliders: { shape: 'circle', radius: 3 } });
  assert.ok(again.handle === ball.handle, 'the freed slot is reused');
  physics.dispose();
});

test('a disabled collider meets nothing and is skipped by queries', () => {
  const physics = world();
  const ground = floor(physics);
  const collider = ground.colliders[0];
  assert.ok(physics.raycast([0, 0], [0, 1]));
  collider.setEnabled(false);
  assert.equal(collider.isEnabled, false);
  assert.equal(physics.raycast([0, 0], [0, 1]), null);
  collider.setEnabled(true);
  assert.ok(physics.raycast([0, 0], [0, 1]));
  physics.dispose();
});

test('joint limits and motors can be cleared', () => {
  const physics = world({ gravity: [0, 0] });
  const pole = physics.addBody(null, { type: 'fixed', colliders: [] });
  const arm = physics.addBody(null, { position: [20, 0], canSleep: false, colliders: { shape: 'box', width: 40, height: 4 } });
  const joint = physics.addJoint(pole, arm, { type: 'revolute', anchorB: [-20, 0], limits: [-0.2, 0.2], motor: { targetVelocity: 5 } });
  run(physics, 120);
  assert.ok(Math.abs(arm.rotation) <= 0.25, `held by the limit at ${arm.rotation}`);
  joint.clearLimits().clearMotor();
  arm.angularVelocity = 3;
  run(physics, 120);
  assert.ok(Math.abs(arm.rotation) > 1, `free to turn: ${arm.rotation}`);
  assert.throws(() => physics.addJoint(pole, arm, { type: 'rope', length: 5 }).setLimits(0, 1), TypeError);
  physics.dispose();
});

test('queries reject shapes the kernel cannot cast, and a stale handle is a state error', () => {
  const physics = world();
  const body = physics.addBody(null, { colliders: { shape: 'circle', radius: 3 } });
  const concave = [[0, 0], [10, 0], [10, 10], [5, 3], [0, 10]];
  assert.throws(() => physics.overlapShape({ shape: 'polygon', points: concave }, [0, 0]), RangeError);
  body.remove();
  assert.throws(() => body.applyImpulse([1, 1]), { name: 'MargoError', code: 'state' });
  physics.dispose();
});

test('a snapshot restores the world and it steps exactly as the original did', () => {
  const physics = world();
  const ground = floor(physics);
  const bodies = [];
  for (let i = 0; i < 8; i++)
    bodies.push(physics.addBody(null, { position: [(i % 4) * 14, i * 15], colliders: i % 2 ? { shape: 'box', width: 12, height: 10 } : { shape: 'circle', radius: 6 } }));
  const pole = physics.addBody(null, { type: 'fixed', position: [-100, 0], colliders: [] });
  const swing = physics.addBody(null, { position: [-80, 0], colliders: { shape: 'box', width: 30, height: 4 } });
  physics.addJoint(pole, swing, { type: 'revolute', anchorB: [-15, 0] });
  const trace = () => [ground, ...bodies, swing].flatMap((b) => [...b.position, b.rotation]);
  run(physics, 90);
  const bytes = physics.snapshot();
  const original = [];
  for (let i = 0; i < 120; i++) {
    physics.step();
    original.push(trace());
  }
  physics.restore(bytes);
  const again = [];
  for (let i = 0; i < 120; i++) {
    physics.step();
    again.push(trace());
  }
  assert.deepEqual(again, original, 'bit for bit');
  // Adding a body since the snapshot makes it unrestorable, and bytes that are not a snapshot are refused.
  physics.addBody(null, { colliders: { shape: 'circle', radius: 2 } });
  assert.throws(() => physics.restore(bytes), { name: 'MargoError', code: 'state' });
  assert.throws(() => physics.restore(new Uint8Array(12)), RangeError);
  physics.dispose();
});

test('debugRender gives lines with colour codes; additionalMass adds to the mass', () => {
  const physics = world();
  floor(physics);
  const ball = physics.addBody(null, { position: [0, 60], colliders: { shape: 'circle', radius: 6 }, additionalMass: 2 });
  const plain = physics.addBody(null, { position: [60, 60], colliders: { shape: 'circle', radius: 6 } });
  assert.ok(Math.abs(ball.mass - plain.mass - 2) < 1e-4, `${ball.mass} against ${plain.mass}`);
  assert.equal(ball.additionalMass, 2);
  ball.additionalMass = 0;
  assert.ok(Math.abs(ball.mass - plain.mass) < 1e-5);
  assert.throws(() => (ball.additionalMass = -1), RangeError);
  run(physics, 60);
  const all = physics.debugRender();
  assert.equal(all.vertices.length, 4 * all.colors.length);
  assert.ok(all.colors.includes(0) && (all.colors.includes(1) || all.colors.includes(2)) && all.colors.includes(8));
  const shapes = physics.debugRender({ shapes: true });
  assert.ok(shapes.colors.every((c) => c <= 4) && shapes.colors.length < all.colors.length);
  // Lines are in world units: the floor's top edge is at y 90.
  let top = false;
  for (let i = 0; i < shapes.colors.length; i++) if (shapes.colors[i] === 0 && Math.abs(shapes.vertices[4 * i + 1] - 90) < 0.01 && Math.abs(shapes.vertices[4 * i + 3] - 90) < 0.01) top = true;
  assert.ok(top, 'the floor outline is drawn in pixels');
  physics.dispose();
});

test('a PID controller steers a body to a point and an angle', async () => {
  const { PidController2D } = await import('../dist/index.js');
  const physics = world({ gravity: [0, 0] });
  const body = physics.addBody(null, { canSleep: false, linearDamping: 0, colliders: { shape: 'circle', radius: 4 } });
  const pid = new PidController2D({ kp: 12, ki: 0.5, kd: 4 });
  physics.on('beforestep', (dt) => {
    pid.applyLinear(dt, body, [100, -40]);
  });
  run(physics, 600);
  assert.ok(Math.hypot(body.position[0] - 100, body.position[1] + 40) < 2, `at ${body.position}`);
  const turner = physics.addBody(null, { position: [0, 300], canSleep: false, colliders: { shape: 'box', width: 20, height: 6 } });
  const spin = new PidController2D({ kp: 20, kd: 8 });
  physics.on('beforestep', (dt) => spin.applyAngular(dt, turner, Math.PI * 0.75));
  run(physics, 600);
  assert.ok(Math.abs(turner.rotation - Math.PI * 0.75) < 0.05, `turned to ${turner.rotation}`);
  assert.throws(() => pid.linearCorrection(0, body, [0, 0]), RangeError);
  assert.throws(() => new PidController2D({ kp: NaN }), RangeError);
  physics.dispose();
});
