import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LeggedLocomotion } from '@margoengine/physics/legged';
import { PhysicsWorld, worldMemory } from '@margoengine/physics/world';

const rate = { num: 60, den: 1 };
const close = (actual, expected, tolerance = 1e-11) =>
  assert.ok(Math.abs(actual - expected) <= tolerance, actual + ' vs ' + expected);

test('bipeds walk and run while a quadruped trots and canters at the actual Froude speed', async () => {
  const limbs = await LeggedLocomotion.load();
  const bodies = [
    { kind: 'biped', target: { speed: 1.3, heading: 0 } },
    { kind: 'biped', target: { speed: 3, heading: 0 } },
    { kind: 'quadruped', target: { speed: 3.5, heading: 0 } },
    { kind: 'quadruped', target: { speed: 6, heading: 0 } },
  ];
  const world = new PhysicsWorld({ rate }).add(limbs, { bodies });
  world.advance(600);
  for (const [i, gait] of ['walk', 'run', 'trot', 'canter'].entries()) {
    const status = limbs.read(i);
    assert.equal(status.gait, gait);
    assert.equal(status.fallen, false);
    assert.ok(status.position[2] > bodies[i].target.speed * 5, 'covers over half the speed command distance');
    assert.ok(Math.abs(status.velocity[2] - bodies[i].target.speed) < 0.05);
    close(Math.hypot(...status.rotation), 1);
    assert.ok(status.rotation[3] > Math.cos(Math.PI / 12), 'trunk stays within 30 degrees upright');
    assert.ok(status.frequency > 0 && status.strideLength > 0);
  }
});

test('a trot has two synchronized diagonal groups and a period with every hoof unloaded', async () => {
  const gait = await LeggedLocomotion.load();
  const world = new PhysicsWorld({ rate }).add(gait, {
    bodies: [{ kind: 'quadruped', target: { speed: 3.5, heading: 0 } }],
  });
  let flights = 0,
    loaded = 0;
  world.advance(240);
  const duration = Math.ceil(60 / gait.read(0).frequency) * 2;
  for (let f = 1; f <= duration; f++) {
    world.advance(240 + f);
    assert.equal(gait.read(0).gait, 'trot');
    const feet = Array.from({ length: 4 }, (_, row) => gait.readContact(0, row));
    assert.equal(feet[0].stance, feet[3].stance);
    assert.equal(feet[1].stance, feet[2].stance);
    const n = feet.filter((foot) => foot.stance).length;
    assert.ok(n === 0 || n === 2);
    if (n === 0) {
      flights++;
      for (const foot of feet) assert.deepEqual(foot.force, [0, 0, 0]);
    } else {
      loaded++;
    }
  }
  assert.ok(flights >= 2);
  assert.ok(loaded > flights);
});

test('a slippery surface contributes no propulsion and a below-contact torso can report a fall', async () => {
  const solver = await LeggedLocomotion.load();
  const body = { kind: 'biped', friction: 0, target: { speed: 1.5, heading: 0 } };
  const world = new PhysicsWorld({ rate }).add(solver, { bodies: [body, { ...body, position: [0, 0.26, 0] }] });
  assert.equal(solver.readContact(1, 2).stance, true);
  world.advance(120);
  close(solver.read(0).velocity[2], 0);
  close(solver.read(0).position[2], 0);
  assert.equal(solver.read(0).gait, 'stand');
});

test('legged state and command seeking agree exactly in both memory modes', async () => {
  const a = await LeggedLocomotion.load();
  const b = await LeggedLocomotion.load();
  const make = (solver, shared) =>
    new PhysicsWorld({ rate, memory: worldMemory(shared) }).add(solver, {
      bodies: [{ kind: 'biped' }, { kind: 'quadruped' }],
    });
  const plain = make(a, false);
  const shared = make(b, true);
  for (const [solver, world] of [
    [a, plain],
    [b, shared],
  ]) {
    solver.setTarget(0, { speed: 1.8, heading: 0 });
    solver.setTarget(1, { speed: 3.5, heading: 0 });
    world.advance(90);
  }
  assert.equal(plain.hash(), shared.hash());
  const snapshot = plain.takeSnapshot();
  a.setTarget(0, { speed: 0, heading: Math.PI / 2 });
  plain.advance(120);
  plain.restoreSnapshot(snapshot.bytes);
  assert.equal(plain.hash(), snapshot.hash);
  plain.advance(120);
  shared.advance(120);
  assert.equal(plain.hash(), shared.hash());
});

test('a stance force and couple obey the available friction budget', async () => {
  const friction = 0.4;
  const leg = 0.9;
  const solver = await LeggedLocomotion.load();
  const world = new PhysicsWorld({ rate }).add(solver, {
    bodies: [{ kind: 'biped', friction, legLength: leg, target: { speed: 1.8, heading: 0 } }],
  });
  world.advance(120);
  solver.setTarget(0, { speed: 1.8, heading: Math.PI / 4 });
  world.advance(130);
  for (const row of [0, 1]) {
    const { force, couple } = solver.readContact(0, row);
    const frictionBudget = friction * force[1];
    assert.ok(Math.hypot(force[0], force[2]) + Math.hypot(...couple) / (0.5 * leg) <= frictionBudget + 1e-10);
  }
  assert.ok(solver.read(0).rotation[1] > 0, 'turn changes the body yaw through stance');
});
