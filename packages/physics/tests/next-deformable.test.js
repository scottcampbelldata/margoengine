// A deformable trimesh follows its moved vertices by a refit: queries and contacts see the moved surface with no rebuild.
import assert from 'node:assert/strict';
import test from 'node:test';
import { RapierPhysics } from './oracle.js';
import { Physics } from '../dist/index.js';

const warn = console.warn;
console.warn = () => {};
await Promise.all([Physics.load(), RapierPhysics.load()]);
console.warn = warn;

const N = 16,
  SIZE = 0.5,
  half = (N * SIZE) / 2;
const flat = [],
  indices = [];
for (let j = 0; j <= N; j++) for (let i = 0; i <= N; i++) flat.push(i * SIZE - half, 0, j * SIZE - half);
const at = (i, j) => j * (N + 1) + i;
for (let j = 0; j < N; j++)
  for (let i = 0; i < N; i++)
    indices.push(at(i, j), at(i, j + 1), at(i + 1, j), at(i + 1, j), at(i, j + 1), at(i + 1, j + 1));
const wave = (t, amplitude = 0.4) => {
  const out = flat.slice();
  for (let v = 0; v < out.length / 3; v++)
    out[3 * v + 1] = amplitude * Math.sin(out[3 * v] * 1.3 + t) * Math.cos(out[3 * v + 2] * 0.9 - 0.5 * t);
  return out;
};
const make = (World, vertices, deformable) => {
  const physics = new World(null, { gravity: [0, -10, 0] });
  const ground = physics.addBody(null, {
    type: 'fixed',
    colliders: { shape: 'trimesh', vertices, indices, deformable },
  });
  return { physics, ground, collider: ground.colliders[0] };
};

test('a ray after setVertices hits the moved surface as a fresh build does, and as Rapier does', () => {
  const { physics, collider } = make(Physics, flat, true);
  for (const t of [0.7, 1.4, 2.1]) {
    const moved = wave(t);
    collider.setVertices(moved);
    physics.step();
    const fresh = make(Physics, moved, false).physics,
      rapier = make(RapierPhysics, moved, false).physics;
    fresh.step();
    rapier.step();
    for (let k = 0; k < 40; k++) {
      const origin = [(((k * 37) % 29) / 29) * 6 - 3, 3, (((k * 53) % 31) / 31) * 6 - 3];
      const own = physics.raycast(origin, [0, -1, 0], { maxDistance: 10 }),
        again = fresh.raycast(origin, [0, -1, 0], { maxDistance: 10 }),
        theirs = rapier.raycast(origin, [0, -1, 0], { maxDistance: 10 });
      assert.equal(!!own, !!again);
      assert.ok(Math.abs(own.distance - again.distance) < 1e-4, `${own.distance} vs ${again.distance}`);
      assert.ok(Math.abs(own.distance - theirs.distance) < 2e-3, `${own.distance} vs Rapier ${theirs.distance}`);
    }
  }
});

test("a refit touches every node once and keeps the tree: the work is the mesh's node count, whatever moved", () => {
  const { physics, collider } = make(Physics, flat, true);
  const counts = [0.5, 1.5, 2.5].map((t) => physics.kernel.refitCollider(collider.handle, 0.1 * t));
  assert.ok(counts[0] > 1);
  assert.deepEqual(counts, [counts[0], counts[0], counts[0]]);
  // A mesh of twice the triangles has about twice the nodes: the work is linear in them.
  const bigger = [];
  for (let j = 0; j <= 2 * N; j++)
    for (let i = 0; i <= 2 * N; i++) bigger.push((i * SIZE) / 2 - half, 0, (j * SIZE) / 2 - half);
  const big = [];
  const at2 = (i, j) => j * (2 * N + 1) + i;
  for (let j = 0; j < 2 * N; j++)
    for (let i = 0; i < 2 * N; i++)
      big.push(at2(i, j), at2(i, j + 1), at2(i + 1, j), at2(i + 1, j), at2(i, j + 1), at2(i + 1, j + 1));
  const world = new Physics(null);
  const body = world.addBody(null, {
    type: 'fixed',
    colliders: { shape: 'trimesh', vertices: bigger, indices: big, deformable: true },
  });
  const nodes = world.kernel.refitCollider(body.colliders[0].handle, 0);
  assert.ok(
    nodes > 3 * counts[0] && nodes < 5 * counts[0],
    `${nodes} nodes against ${counts[0]} for a quarter of the triangles`,
  );
});

test('a ball resting on a mesh that heaves under it follows the surface up and down', () => {
  // The whole surface rises and falls 0.3 m about every 3 s, with a ripple of 1 cm on it so the tree has real work.
  const heave = (t) => {
    const out = flat.slice();
    for (let v = 0; v < out.length / 3; v++)
      out[3 * v + 1] = 0.3 * Math.sin(2 * t) + 0.01 * Math.sin(3 * out[3 * v] + t);
    return out;
  };
  const { physics, collider } = make(Physics, heave(0), true);
  const ball = physics.addBody(null, { position: [0.05, 0.6, 0.05], colliders: { shape: 'sphere', radius: 0.3 } });
  for (let i = 0; i < 60; i++) physics.step();
  let t = 0,
    sunk = 0,
    highest = -1,
    lowest = 1;
  for (let step = 0; step < 300; step++) {
    t += 1 / 60;
    collider.setVertices(heave(t));
    physics.step();
    const hit = physics.raycast([ball.position[0], 3, ball.position[2]], [0, -1, 0], {
      maxDistance: 10,
      exclude: ball,
    });
    const gap = ball.position[1] - 0.3 - (3 - hit.distance);
    sunk = Math.max(sunk, -gap);
    highest = Math.max(highest, ball.position[1]);
    lowest = Math.min(lowest, ball.position[1]);
  }
  assert.ok(sunk < 0.03, `the ball sank ${sunk} m into the surface`);
  assert.ok(highest - lowest > 0.4, `the ball followed the heave: ${lowest} to ${highest}`);
});

test("a surface that jumps up by less than the ball's radius in one step lifts a resting ball instead of passing through it", () => {
  const { physics, collider } = make(Physics, flat, true);
  const ball = physics.addBody(null, { position: [0, 0.5, 0], colliders: { shape: 'sphere', radius: 0.3 } });
  for (let i = 0; i < 60; i++) physics.step();
  const lifted = flat.slice();
  for (let v = 0; v < lifted.length / 3; v++) lifted[3 * v + 1] = 0.2;
  collider.setVertices(lifted);
  for (let i = 0; i < 60; i++) physics.step();
  assert.ok(ball.position[1] > 0.45, `the ball ended below the raised surface: ${ball.position[1]}`);
});

test('setVertices names what is wrong', () => {
  const { collider } = make(Physics, flat, true);
  assert.throws(() => collider.setVertices(flat.slice(3)), /vertices and setVertices got/);
  const nan = flat.slice();
  nan[4] = Number.NaN;
  assert.throws(() => collider.setVertices(nan), /not finite/);
  const fixed = make(Physics, flat, false).collider;
  assert.throws(() => fixed.setVertices(flat), /deformable: true/);
});

test('a surface rising 0.05 m a step (3 m/s) meets a ball hovering 0.6 m above it and carries the ball instead of passing through it', () => {
  const physics = new Physics(null, { gravity: [0, 0, 0] });
  const ground = physics.addBody(null, {
    type: 'fixed',
    colliders: { shape: 'trimesh', vertices: flat, indices, deformable: true },
  });
  const ball = physics.addBody(null, { position: [0.05, 0.9, 0.05], colliders: { shape: 'sphere', radius: 0.3 } });
  physics.step();
  for (let step = 1; step <= 24; step++) {
    const raised = flat.slice();
    for (let v = 0; v < raised.length / 3; v++) raised[3 * v + 1] = 0.05 * step;
    ground.colliders[0].setVertices(raised);
    physics.step();
    assert.ok(
      ball.position[1] > 0.05 * step,
      `step ${step}: the ball is at ${ball.position[1]}, under the surface at ${0.05 * step}`,
    );
  }
});

const shifted = (dx, dy = 0) => {
  const out = flat.slice();
  for (let v = 0; v < out.length / 3; v++) {
    out[3 * v] += dx;
    out[3 * v + 1] += dy;
  }
  return out;
};

test('a box on a deformable sheet that slides under it is carried along by friction', () => {
  const physics = new Physics(null, { gravity: [0, -10, 0] });
  const sheet = physics.addBody(null, {
    type: 'fixed',
    colliders: { shape: 'trimesh', vertices: flat, indices, deformable: true, friction: 1 },
  });
  const crate = physics.addBody(null, {
    position: [0, 0.5, 0],
    colliders: { shape: 'box', halfExtents: [0.25, 0.25, 0.25], friction: 1 },
  });
  for (let i = 0; i < 60; i++) physics.step();
  const start = crate.position[0];
  // The sheet slides 1 m/s along x for 1.5 s (far less than its width), a mover that never lets go.
  let x = 0;
  for (let step = 0; step < 90; step++) {
    x += 1 / 60;
    sheet.colliders[0].setVertices(shifted(x));
    physics.step();
  }
  const carried = crate.position[0] - start;
  assert.ok(carried > 1.0 && carried < 1.7, `the crate moved ${carried} m while the sheet slid 1.5 m`);
  assert.ok(
    crate.linearVelocity[0] > 0.7 && crate.linearVelocity[0] < 1.3,
    `the crate's speed is ${crate.linearVelocity[0]}`,
  );
  // Left alone, the sheet's speed ends with its last step: the crate is no longer pulled.
  for (let step = 0; step < 120; step++) physics.step();
  assert.ok(
    Math.abs(crate.linearVelocity[0]) < 0.2,
    `the crate went on at ${crate.linearVelocity[0]} with the sheet still`,
  );
});

test('explicit velocities say how fast each vertex goes, whatever its displacement', () => {
  const physics = new Physics(null, { gravity: [0, -10, 0] });
  const sheet = physics.addBody(null, {
    type: 'fixed',
    colliders: { shape: 'trimesh', vertices: flat, indices, deformable: true, friction: 1 },
  });
  const crate = physics.addBody(null, {
    position: [0, 0.5, 0],
    colliders: { shape: 'box', halfExtents: [0.25, 0.25, 0.25], friction: 1 },
  });
  for (let i = 0; i < 60; i++) physics.step();
  const velocities = flat.map((_, i) => (i % 3 === 2 ? 2 : 0));
  // The vertices stay where they are and the surface says it moves at 2 m/s along z.
  for (let step = 0; step < 60; step++) {
    sheet.colliders[0].setVertices(flat, { velocities });
    physics.step();
  }
  assert.ok(crate.linearVelocity[2] > 1.0, `the crate's speed along z is ${crate.linearVelocity[2]}`);
});

test('a surface that rises 5 m in one step does not pass through a ball: it carries it', () => {
  const physics = new Physics(null, { gravity: [0, 0, 0] });
  const sheet = physics.addBody(null, {
    type: 'fixed',
    colliders: { shape: 'trimesh', vertices: flat, indices, deformable: true },
  });
  const ball = physics.addBody(null, { position: [0.05, 2, 0.05], colliders: { shape: 'sphere', radius: 0.3 } });
  physics.step();
  sheet.colliders[0].setVertices(shifted(0, 5));
  physics.step();
  assert.ok(ball.position[1] > 5, `the ball is at ${ball.position[1]}, under the surface at 5`);
  assert.ok(ball.position[1] < 6, `the ball was thrown to ${ball.position[1]}`);
});

test('a surface that stops moving stops pulling: the speed lasts one step', () => {
  const physics = new Physics(null, { gravity: [0, -10, 0] });
  const sheet = physics.addBody(null, {
    type: 'fixed',
    colliders: { shape: 'trimesh', vertices: flat, indices, deformable: true, friction: 1 },
  });
  const crate = physics.addBody(null, {
    position: [0, 0.5, 0],
    colliders: { shape: 'box', halfExtents: [0.25, 0.25, 0.25], friction: 1 },
  });
  for (let i = 0; i < 60; i++) physics.step();
  sheet.colliders[0].setVertices(shifted(0.2));
  physics.step();
  for (let i = 0; i < 90; i++) physics.step();
  assert.ok(Math.abs(crate.linearVelocity[0]) < 0.05, `the crate still moves at ${crate.linearVelocity[0]}`);
});

test('the same 5 m rise as a teleport (now: true) has no velocity or sweep, so it passes the ball: the swept path is the one that catches it', () => {
  const physics = new Physics(null, { gravity: [0, 0, 0] });
  const sheet = physics.addBody(null, { type: 'fixed', colliders: { shape: 'trimesh', vertices: flat, indices, deformable: true } });
  const ball = physics.addBody(null, { position: [0.05, 2, 0.05], colliders: { shape: 'sphere', radius: 0.3 } });
  physics.step();
  sheet.colliders[0].setVertices(shifted(0, 5), { now: true });
  physics.step();
  assert.ok(ball.position[1] < 3, `the ball is at ${ball.position[1]}`);
});
