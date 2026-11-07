// What both entries must do alike while the own solver is built: each test runs on Rapier and on the kernel, on a real
// engine and transform store with a stand-in renderer. The two integrate differently (one step against substeps), so
// numbers are held to bounds from the maths, never to each other.
import assert from 'node:assert/strict';
import test from 'node:test';
import { box } from '@margoengine/core';
import { Engine, TransformStore } from '@margoengine/core/extension';
import * as root from '../dist/index.js';
import * as next from '../dist/next.js';

const warn = console.warn;
console.warn = () => {};
await root.Physics.load();
console.warn = warn;
await next.Physics.load();

const entries = { rapier: root.Physics, own: next.Physics };
const G = 9.81,
  DT = 1 / 60;

const makeEngine = async () =>
  new Engine(
    { width: 1, height: 1 },
    await TransformStore.create(64),
    { backend: 'webgl2', add() {}, remove() {}, render() {}, dispose() {} },
    undefined,
    null,
  );
const near = (actual, expected, bound, message) =>
  assert.ok(Math.abs(actual - expected) <= bound, `${message ?? 'value'}: ${actual} is not within ${bound} of ${expected}`);
const steps = (physics, count) => {
  for (let i = 0; i < count; i++) physics.step();
};
const ball = (radius = 0.5) => ({ shape: 'sphere', radius, density: 1 });

for (const [name, Physics] of Object.entries(entries)) {
  const both = (title, body) => test(`${name}: ${title}`, body);

  both('a body falls as t^2 g / 2, within what a first-order step can differ by', () => {
    const physics = new Physics(null),
      body = physics.addBody(null, { position: [0, 100, 0], colliders: ball() });
    steps(physics, 120);
    const t = 2;
    near(body.position[1], 100 - (G * t * t) / 2, (G * DT * t) / 2 + 1e-3, 'height');
    near(body.linearVelocity[1], -G * t, 1e-3, 'speed');
    physics.dispose();
  });

  both('update runs whole steps, keeps what is left, and stops a slow frame from snowballing', () => {
    const physics = new Physics(null, { maxSubsteps: 3 });
    assert.equal(physics.update(DT * 2.5), 2);
    near(physics.pendingTime, DT / 2, 1e-9);
    near(physics.alpha, 0.5, 1e-9);
    assert.equal(physics.update(10), 3);
    assert.ok(physics.pendingTime < DT);
    assert.equal(physics.stepCount, 5);
    physics.paused = true;
    assert.equal(physics.update(1), 0);
    physics.paused = false;
    physics.timeScale = 0.5;
    const before = physics.stepCount;
    physics.update(DT * 4);
    assert.equal(physics.stepCount, before + 2);
    assert.throws(() => physics.update(-1), RangeError);
    assert.throws(() => physics.update(Number.NaN), RangeError);
    physics.dispose();
  });

  both('a mesh shows the pose between the last two steps', async () => {
    const engine = await makeEngine(),
      physics = new Physics(engine, { gravity: [0, 0, 0], interpolate: true }),
      mesh = engine.createMesh().setGeometry(box(1)),
      body = physics.addBody(mesh, { linearVelocity: [6, 0, 0], colliders: ball() });
    physics.update(DT);
    const first = body.position[0];
    physics.update(DT * 1.5);
    const second = body.position[0];
    near(mesh.position.x, first + (second - first) * 0.5, 1e-5, 'interpolated x');
    near(second, 0.2, 1e-5, 'two steps at 6 m/s');
    physics.dispose();
    engine.dispose();
  });

  both('a teleport does not streak, and a body keeps the pose it was given', async () => {
    const engine = await makeEngine(),
      physics = new Physics(engine, { gravity: [0, 0, 0] }),
      mesh = engine.createMesh().setGeometry(box(1)),
      body = physics.addBody(mesh, { colliders: ball() });
    physics.update(DT * 1.5);
    body.setPosition([5, 0, 0]);
    physics.sync(0.5);
    assert.equal(mesh.position.x, 5);
    const half = Math.SQRT1_2;
    body.setRotation([0, half, 0, half]);
    near(body.rotation[1], half, 1e-6);
    assert.throws(() => body.setPosition([Number.NaN, 0, 0]), RangeError);
    physics.dispose();
    engine.dispose();
  });

  both('a body on a child mesh keeps its world pose when the parent moves', async () => {
    const engine = await makeEngine(),
      physics = new Physics(engine, { gravity: [0, 0, 0] }),
      parent = engine.createMesh().setGeometry(box(1)),
      child = engine.createMesh().setGeometry(box(1));
    parent.setPosition([10, 0, 0]);
    child.setParent(parent);
    child.setPosition([1, 0, 0]);
    const body = physics.addBody(child, { colliders: ball() });
    near(body.position[0], 11, 1e-5, 'the body starts at the world pose');
    parent.setPosition([20, 0, 0]);
    physics.update(DT);
    near(child.position.x, -9, 1e-4, 'local x puts the child back at 11 in the world');
    physics.dispose();
    engine.dispose();
  });

  both('events come in order, with the step length', () => {
    const physics = new Physics(null),
      seen = [];
    const off = physics.on('beforestep', (dt) => seen.push(['before', dt]));
    physics.on('afterstep', (dt) => seen.push(['after', dt]));
    physics.step();
    assert.deepEqual(seen, [
      ['before', DT],
      ['after', DT],
    ]);
    off();
    physics.step();
    assert.equal(seen.length, 3);
    physics.dispose();
  });

  both('mass, centre and inertia come from the colliders', () => {
    const physics = new Physics(null),
      body = physics.addBody(null, { colliders: { shape: 'box', halfExtents: [0.5, 1, 1.5], density: 2 } });
    near(body.mass, 12, 12e-6, 'mass');
    near(body.principalInertia[0] + body.principalInertia[1] + body.principalInertia[2], 13 + 10 + 5, 28e-5, 'moments');
    body.addCollider({ shape: 'sphere', radius: 1, offset: [0, 3, 0], mass: 12 });
    near(body.mass, 24, 24e-6, 'mass of both');
    near(body.centerOfMass[1], 1.5, 1.5e-5, 'equal masses meet half way');
    physics.dispose();
  });

  both('a force reaches every part of a step and stays; an impulse lands once', () => {
    const physics = new Physics(null, { gravity: [0, 0, 0] }),
      body = physics.addBody(null, { colliders: { ...ball(1), mass: 2 } });
    body.addForce([4, 0, 0]);
    physics.step();
    near(body.linearVelocity[0], (4 / 2) * DT, 1e-5, 'one step of force');
    physics.step();
    near(body.linearVelocity[0], (4 / 2) * DT * 2, 1e-5, 'forces stay');
    assert.deepEqual(body.appliedForce, [4, 0, 0]);
    body.resetForces();
    body.applyImpulse([0, 6, 0]);
    physics.step();
    physics.step();
    near(body.linearVelocity[1], 3, 1e-5, 'an impulse lands once');
    near(body.linearVelocity[0], (4 / 2) * DT * 2, 1e-5, 'reset took the force off');
    physics.dispose();
  });

  both('a push off centre turns a body as r x F says', () => {
    const physics = new Physics(null, { gravity: [0, 0, 0] }),
      body = physics.addBody(null, { colliders: { ...ball(1), mass: 2.5 } });
    // A ball's I is 2/5 m r^2 = 1. A push of 1 along x at (0, 1, 0) gives a torque of -1 about z.
    body.applyImpulse([1, 0, 0], [0, 1, 0]);
    physics.step();
    near(body.angularVelocity[2], -1, 1e-5, 'spin');
    near(body.linearVelocity[0], 0.4, 1e-5, 'travel');
    physics.dispose();
  });

  both('kinematic bodies follow their target or their velocity, and gravity leaves them alone', () => {
    const physics = new Physics(null),
      target = physics.addBody(null, { type: 'kinematicPosition', position: [1, 0, 0], colliders: ball() }),
      rolling = physics.addBody(null, { type: 'kinematicVelocity', linearVelocity: [3, 0, 0], colliders: ball() });
    physics.step();
    near(target.position[0], 1, 1e-6, 'a target left alone is where the body is');
    target.setNextPosition([2, 3, 4]);
    physics.step();
    assert.deepEqual(target.position, [2, 3, 4]);
    near(rolling.position[0], 3 * DT * 2, 1e-5, 'velocity');
    near(rolling.position[1], 0, 1e-9, 'no gravity');
    physics.dispose();
  });

  both('a fixed body stays, and locked axes hold', () => {
    const physics = new Physics(null),
      wall = physics.addBody(null, { type: 'fixed', position: [1, 2, 3], colliders: ball() }),
      locked = physics.addBody(null, { lockTranslations: true, angularVelocity: [0, 1, 0], colliders: ball() }),
      flat = physics.addBody(null, { enabledTranslations: [true, false, true], colliders: ball() });
    steps(physics, 10);
    assert.deepEqual(wall.position, [1, 2, 3]);
    assert.deepEqual(locked.position, [0, 0, 0]);
    assert.equal(flat.position[1], 0);
    physics.dispose();
  });

  both('a still body sleeps, and a wake or a push brings it back', () => {
    const physics = new Physics(null, { gravity: [0, 0, 0] }),
      body = physics.addBody(null, { colliders: ball() });
    let count = 0;
    while (!body.sleeping && count < 600) {
      physics.step();
      count++;
    }
    assert.ok(body.sleeping, 'asleep within 10 s');
    body.wakeUp();
    assert.equal(body.sleeping, false);
    body.sleep();
    physics.step();
    assert.equal(body.sleeping, true);
    body.applyImpulse([1, 0, 0]);
    assert.equal(body.sleeping, false);
    physics.dispose();
  });

  both('bodies and colliders come and go, and a removed one says so', async () => {
    const engine = await makeEngine(),
      physics = new Physics(engine),
      mesh = engine.createMesh().setGeometry(box(1)),
      body = physics.addBody(mesh, { colliders: [ball(), ball(0.25)] });
    assert.equal(physics.bodyCount, 1);
    assert.equal(physics.colliderCount, 2);
    assert.equal(physics.bodyOf(mesh), body);
    assert.equal(physics.owns(body), true);
    assert.deepEqual(physics.getBodies(), [body]);
    const [first, second] = body.colliders;
    assert.equal(physics.bodyOfCollider(first), body);
    body.removeCollider(second);
    assert.equal(second.valid, false);
    assert.equal(physics.colliderCount, 1);
    body.remove();
    assert.equal(body.valid, false);
    assert.equal(first.valid, false);
    assert.equal(physics.bodyCount, 0);
    assert.equal(physics.colliderCount, 0);
    assert.throws(() => body.position, /removed/);
    assert.equal(physics.bodyOf(mesh), undefined);
    physics.dispose();
    engine.dispose();
  });

  both('a body is refused what it cannot be', () => {
    const physics = new Physics(null);
    assert.throws(() => physics.addBody(null, { type: 'liquid' }), TypeError);
    assert.throws(() => physics.addBody(null, { position: [0, 0] }), RangeError);
    assert.throws(() => physics.addBody(null, { colliders: { shape: 'box' } }), TypeError);
    assert.throws(() => new Physics(null, { fixedTimestep: 0 }), RangeError);
    assert.throws(() => new Physics(null, { maxSubsteps: 0.5 }), RangeError);
    physics.dispose();
    assert.equal(physics.isDisposed, true);
    assert.equal(physics.update(1), 0);
    assert.throws(() => physics.addBody(null), { code: 'disposed' });
  });

  both('a default collider is a box fitted to the mesh', async () => {
    const engine = await makeEngine(),
      physics = new Physics(engine),
      mesh = engine.createMesh().setGeometry(box(2, 4, 6)),
      body = physics.addBody(mesh);
    assert.equal(body.colliders[0].shape, 'box');
    const { x, y, z } = body.colliders[0].halfExtents();
    assert.deepEqual([x, y, z], [1, 2, 3]);
    physics.dispose();
    engine.dispose();
  });
}
