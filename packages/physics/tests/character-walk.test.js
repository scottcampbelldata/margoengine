// walk() and jump(): a kinematic character with gravity and jumping, against the closed form, and replayed after a restore.
import assert from 'node:assert/strict';
import test from 'node:test';
import { Physics } from '../dist/index.js';

await Physics.load();
const radius = 0.3,
  halfHeight = 0.4;
function world() {
  const physics = new Physics(null);
  physics.addBody(null, {
    type: 'fixed',
    position: [0, -0.5, 0],
    colliders: { shape: 'box', halfExtents: [50, 0.5, 50] },
  });
  const body = physics.addBody(null, {
    type: 'kinematicPosition',
    position: [0, halfHeight + radius + 0.01, 0],
    colliders: { shape: 'capsule', halfHeight, radius },
  });
  return { physics, body, controller: physics.createCharacterController(body) };
}

test('a jump at v rises v^2 / 2g, sampled once a step, and lands after 2v / g with no speed left', () => {
  const { physics, body, controller } = world(),
    g = 9.81,
    v = 5,
    dt = physics.fixedTimestep;
  for (let i = 0; i < 5; i++) {
    controller.walk([0, 0, 0]);
    physics.step();
  }
  assert.equal(controller.grounded, true);
  assert.equal(controller.verticalSpeed, 0, 'standing, no speed along up');
  const y0 = body.position[1];
  assert.equal(controller.jump(v), true);
  let top = y0,
    steps = 0;
  do {
    controller.walk([1, 0, 0]);
    physics.step();
    top = Math.max(top, body.position[1]);
    steps++;
  } while (!controller.grounded && steps < 400);
  const apex = (v * v) / (2 * g);
  // Positions are the parabola sampled each step: the highest sample is within g dt^2 / 8 below the apex.
  assert.ok(top - y0 <= apex + 1e-6, `no higher than the apex (${top - y0} > ${apex})`);
  assert.ok(top - y0 >= apex - (g * dt * dt) / 8 - 1e-6, `reaches the apex (${top - y0} against ${apex})`);
  const air = (2 * v) / g;
  assert.ok(Math.abs(steps * dt - air) <= 2 * dt, `air time ${steps * dt} s against ${air} s`);
  assert.equal(controller.verticalSpeed, 0, 'landing leaves no speed along up');
  assert.ok(Math.abs(body.position[0] - steps * dt) < 1e-6, 'the walk went on at 1 m/s through the air');
  assert.equal(controller.jump(1), true, 'grounded again, it may jump again');
  physics.dispose();
});

test('in the air it cannot jump, and a ceiling stops the rise', () => {
  const { physics, body, controller } = world();
  physics.addBody(null, {
    type: 'fixed',
    position: [0, 2.2, 0],
    colliders: { shape: 'box', halfExtents: [2, 0.1, 2] },
  });
  controller.walk([0, 0, 0]);
  physics.step();
  assert.equal(controller.jump(6), true);
  controller.walk([0, 0, 0]);
  physics.step();
  assert.equal(controller.jump(6), false, 'no jump in the air');
  let hit = false;
  for (let i = 0; i < 30 && !hit; i++) {
    controller.walk([0, 0, 0]);
    physics.step();
    hit = controller.verticalSpeed === 0;
  }
  assert.ok(hit, 'the ceiling took the speed along up');
  assert.ok(body.position[1] + halfHeight + radius <= 2.1 + 1e-6, 'and the head stayed under it');
  physics.dispose();
});

test('the same walk and jumps replay bit for bit after a snapshot and the controller state are restored', () => {
  const { physics, body, controller } = world();
  const run = (from, to) => {
    for (let i = from; i < to; i++) {
      if (i % 50 === 10) controller.jump(4);
      controller.walk([Math.sin(i * 0.05) * 2, 0, 1]);
      physics.step();
    }
    return [physics.takeSnapshot().bytes.slice(), [...body.position], [...controller.takeState()]];
  };
  run(0, 60);
  const snapshot = physics.takeSnapshot(),
    state = controller.takeState();
  const first = run(60, 200);
  physics.restoreSnapshot(snapshot);
  controller.restoreState(state);
  assert.deepEqual(run(60, 200), first);
  physics.dispose();
});

test('bad input is a coded error linked to its help entry', () => {
  const { physics, controller } = world();
  assert.throws(() => controller.walk([0, Number.NaN, 0]), { name: 'MargoError', message: /errors#characters/ });
  assert.throws(() => controller.jump(0), { name: 'MargoError', message: /jump speed/ });
  assert.throws(() => controller.restoreState([1, 2]), { name: 'MargoError', message: /six numbers/ });
  const dynamic = physics.addBody(null, { colliders: { shape: 'sphere', radius: 0.2 } });
  assert.throws(() => physics.createCharacterController(dynamic), { name: 'MargoError', message: /kinematicPosition/ });
  assert.throws(() => physics.createDynamicCharacter(dynamic, { up: [0, 0, 0] }), {
    name: 'MargoError',
    message: /errors#characters/,
  });
  physics.dispose();
});
