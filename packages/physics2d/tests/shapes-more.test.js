// The shapes beyond the first six: triangle, rounded boxes and polygons, compound, trimesh, heightfield, halfspace,
// voxels and one-sided polylines.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Physics2D } from '../dist/index.js';

await Physics2D.load();
const world = (options = {}) => new Physics2D(null, options);
const run = (physics, steps) => {
  for (let i = 0; i < steps; i++) physics.step();
};
const fixed = (physics, colliders, position = [0, 0]) => physics.addBody(null, { type: 'fixed', position, colliders });
const drop = (physics, x, y, radius = 4) => physics.addBody(null, { position: [x, y], colliders: { shape: 'circle', radius } });

test('a triangle is a solid collider and a rounded box has round corners', () => {
  const physics = world();
  fixed(physics, { shape: 'triangle', a: [-40, 40], b: [40, 40], c: [0, -20] }, [0, 100]);
  assert.equal(physics.overlapPoint([0, 110]).length, 1, 'inside the triangle');
  assert.equal(physics.overlapPoint([-38, 70]).length, 0, 'outside it');
  const ball = drop(physics, 0, -100);
  run(physics, 300);
  assert.ok(Math.abs(ball.position[0]) < 40 && ball.position[1] < 100 + 40 + 40, 'falls onto the point and off it');
  physics.dispose();
  const round = world();
  fixed(round, { shape: 'box', width: 20, height: 20, borderRadius: 6 });
  assert.equal(round.overlapPoint([15, 0]).length, 1, 'the border grows the box by 6 on a side');
  assert.equal(round.overlapPoint([15.9, 15.9]).length, 0, 'but the corner is round');
  assert.throws(() => round.addBody(null, { colliders: { shape: 'box', width: 2, height: 2, borderRadius: -1 } }), RangeError);
  round.dispose();
});

test('a compound collider is one collider of several parts with one mass', () => {
  const physics = world({ gravity: [0, 0] });
  const body = physics.addBody(null, {
    colliders: {
      shape: 'compound',
      mass: 6,
      shapes: [
        { shape: 'box', width: 20, height: 20, offset: [-10, 0] },
        { shape: 'circle', radius: 10, offset: [20, 0] },
      ],
    },
  });
  assert.equal(body.colliders.length, 1);
  assert.equal(body.colliders[0].shapes.length, 2);
  assert.ok(Math.abs(body.mass - 6) < 1e-3, `mass ${body.mass}`);
  assert.equal(physics.overlapPoint([-15, 0]).length, 1);
  assert.equal(physics.overlapPoint([25, 0]).length, 1);
  assert.equal(physics.overlapPoint([5, 15]).length, 0);
  assert.throws(() => physics.addBody(null, { colliders: { shape: 'compound', shapes: [] } }), TypeError);
  physics.dispose();
});

test('a trimesh takes triangles by index and refuses bad ones', () => {
  const physics = world();
  fixed(physics, { shape: 'trimesh', vertices: [[-50, 0], [50, 0], [50, 20], [-50, 20]], indices: [0, 1, 2, 0, 2, 3] }, [0, 100]);
  assert.equal(physics.overlapPoint([0, 110]).length, 1);
  assert.throws(() => physics.addBody(null, { colliders: { shape: 'trimesh', vertices: [[0, 0]], indices: [0, 1, 2] } }), RangeError);
  assert.throws(() => physics.addBody(null, { colliders: { shape: 'trimesh', vertices: [[0, 0], [1, 1], [2, 2]], indices: [0, 1, 2] } }), RangeError);
  const ball = drop(physics, 0, 0);
  run(physics, 240);
  assert.ok(Math.abs(ball.position[1] - 96) < 1, `rests on the mesh at ${ball.position[1]}`);
  physics.dispose();
});

test('a heightfield is smooth terrain a ball rolls down', () => {
  const physics = world();
  // A slope from y 100 on the left to y 200 on the right across 400 units.
  fixed(physics, { shape: 'heightfield', heights: [100, 125, 150, 175, 200], width: 400 });
  const ball = physics.addBody(null, { position: [-190, 80], colliders: { shape: 'circle', radius: 6, friction: 0.2 } });
  run(physics, 240);
  assert.ok(ball.position[0] > -100, `rolled right to ${ball.position[0]}`);
  assert.ok(physics.raycast([0, 0], [0, 1]).distance > 140 && physics.raycast([0, 0], [0, 1]).distance < 160);
  assert.throws(() => physics.addBody(null, { colliders: { shape: 'heightfield', heights: [1], width: 10 } }), TypeError);
  physics.dispose();
});

test('a halfspace holds a body and tilts with its normal', () => {
  const physics = world();
  fixed(physics, { shape: 'halfspace' }, [0, 100]);
  const ball = drop(physics, 5000, 0);
  run(physics, 300);
  assert.ok(Math.abs(ball.position[1] - 96) < 0.5, `rests on the plane at ${ball.position[1]}`);
  assert.ok(Math.abs(ball.position[0] - 5000) < 1);
  // A wall: the solid is to the left of x = 300 when the normal points right.
  fixed(physics, { shape: 'halfspace', normal: [1, 0] }, [300, 0]);
  const rolling = physics.addBody(null, { position: [400, 0], linearVelocity: [-200, 0], colliders: { shape: 'circle', radius: 4 } });
  physics.update(0);
  run(physics, 120);
  assert.ok(rolling.position[0] > 300, `stopped by the wall at ${rolling.position[0]}`);
  physics.dispose();
});

test('voxels merge into outlines: a cup of cells holds a ball', () => {
  const physics = world();
  // 5 columns by 3 rows: a U.
  const solid = [1, 0, 0, 0, 1, 1, 0, 0, 0, 1, 1, 1, 1, 1, 1];
  fixed(physics, { shape: 'voxels', cellWidth: 16, cellHeight: 16, columns: 5, rows: 3, solid }, [0, 100]);
  // The cells answer queries as solids: points inside a filled cell are found, the cup is empty.
  assert.equal(physics.overlapPoint([40, 140]).length, 1, 'inside the floor row');
  assert.equal(physics.overlapPoint([8, 120]).length, 1, 'inside the left wall');
  assert.equal(physics.overlapPoint([40, 110]).length, 0, 'in the cup');
  assert.equal(physics.overlapShape({ shape: 'circle', radius: 3 }, [40, 130]).length, 1, 'a circle reaching the floor row');
  assert.equal(physics.projectPoint([8, 120]).inside, true);
  // Contact is by the merged outlines: a ray down the cup meets the top of the floor row, and one through a wall its edge.
  assert.ok(Math.abs(physics.raycast([40, 0], [0, 1]).distance - 132) < 0.01, 'the cup is open and its floor is at 132');
  assert.ok(Math.abs(physics.raycast([-10, 120], [1, 0]).distance - 10) < 0.01, 'the left wall starts at x = 0');
  const ball = drop(physics, 40, 0, 5);
  run(physics, 300);
  assert.ok(ball.position[0] > 20 && ball.position[0] < 60 && ball.position[1] > 120 && ball.position[1] < 132, `in the cup at ${ball.position}`);
  assert.throws(() => physics.addBody(null, { colliders: { shape: 'voxels', cellWidth: 1, cellHeight: 1, columns: 2, rows: 2, solid: [1] } }), RangeError);
  physics.dispose();
});

test('a one-sided polyline is a platform: up through it, then standing on it', () => {
  const physics = world();
  // Left to right, the solid side is up on screen.
  fixed(physics, { shape: 'polyline', points: [[-100, 100], [0, 100], [100, 100]], oneSided: true });
  const ball = physics.addBody(null, { position: [0, 160], linearVelocity: [0, -420], colliders: { shape: 'circle', radius: 5, friction: 0 } });
  let top = Infinity;
  for (let i = 0; i < 300; i++) {
    physics.step();
    top = Math.min(top, ball.position[1]);
  }
  assert.ok(top < 60, `went up through it to ${top}`);
  assert.ok(Math.abs(ball.position[1] - 95) < 1, `stands on it at ${ball.position[1]}`);
  physics.dispose();
});

test('generic and slot joints hold only what they lock', () => {
  const physics = world({ gravity: [0, 320] });
  const pole = physics.addBody(null, { type: 'fixed', position: [0, 100], colliders: [] });
  const on = (type) => {
    const body = physics.addBody(null, { position: [0, 100], linearVelocity: [60, 0], angularVelocity: 3, canSleep: false, colliders: { shape: 'box', width: 16, height: 8, collisionGroups: 0 } });
    physics.addJoint(pole, body, type);
    return body;
  };
  const slot = on({ type: 'slot', axis: [1, 0] });
  const pin = on({ type: 'generic', lockX: true, lockY: true });
  const weld = on({ type: 'generic', lockX: true, lockY: true, lockAngle: true });
  const hang = on({ type: 'generic', lockAngle: true });
  run(physics, 120);
  assert.ok(Math.abs(slot.position[1] - 100) < 0.5 && slot.position[0] > 60, `slot slides: ${slot.position}`);
  assert.ok(Math.hypot(pin.position[0], pin.position[1] - 100) < 0.5 && Math.abs(pin.angularVelocity) > 1, 'pin spins in place');
  assert.ok(Math.abs(weld.rotation) < 0.01 && Math.hypot(weld.position[0], weld.position[1] - 100) < 0.5, 'weld holds both');
  assert.ok(Math.abs(hang.rotation) < 0.01 && hang.position[1] > 200, 'angle lock falls and holds its turn');
  assert.throws(() => physics.addJoint(pole, slot, { type: 'wobble' }), TypeError);
  physics.dispose();
});

test('lockTranslation holds an axis, follows a teleport and can be freed', () => {
  const physics = world();
  const bead = physics.addBody(null, { position: [50, 0], lockTranslation: [true, false], colliders: { shape: 'circle', radius: 4 } });
  bead.linearVelocity = [40, 0];
  run(physics, 120);
  assert.ok(Math.abs(bead.position[0] - 50) < 0.5, `x held at ${bead.position[0]}`);
  assert.ok(bead.position[1] > 100, 'y is free');
  bead.teleport([200, 0]);
  run(physics, 60);
  assert.ok(Math.abs(bead.position[0] - 200) < 0.5, `the lock moved with the teleport: ${bead.position[0]}`);
  assert.deepEqual(bead.translationLocked, [true, false]);
  bead.lockTranslation(false);
  bead.linearVelocity = [60, 0];
  run(physics, 60);
  assert.ok(bead.position[0] > 230, 'free again');
  const both = physics.addBody(null, { position: [0, 0], lockTranslation: true, colliders: { shape: 'box', width: 10, height: 10 } });
  both.angularVelocity = 2;
  run(physics, 60);
  assert.ok(Math.hypot(...both.position) < 0.5 && Math.abs(both.rotation) > 0.5, 'a fully locked body still turns');
  assert.throws(() => physics.addBody(null, { type: 'fixed', lockTranslation: true }), TypeError);
  physics.dispose();
});
