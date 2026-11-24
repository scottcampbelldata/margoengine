// Particle probes for soft bodies (`KernelWorld.probeParticles`): a particle of radius r moving over a step meets every kind of
// collider where the shape is: resting a little inside the radius it gets the nearest surface point, the outward normal and the
// depth; a fast one is swept, so it stops at the first surface instead of passing it; groups and filters are honoured.
import assert from 'node:assert/strict';
import test from 'node:test';
import { Physics, collisionGroups } from '../dist/index.js';

await Physics.load();
const R = 0.1;
const near = (a, b, tolerance, message) =>
  assert.ok(Math.abs(a - b) <= tolerance, `${message}: ${a} is not within ${tolerance} of ${b}`);

const world = (colliders, extra = {}) => {
  const physics = new Physics(null, { gravity: [0, 0, 0] });
  const body = physics.addBody(null, { type: 'fixed', colliders, ...extra });
  physics.step();
  return { physics, body, kernel: physics.kernel };
};
const probe = (kernel, from, to, radius = R, options) => kernel.probeParticles(from, to, radius, options)[0];

// One particle for each shape, resting 0.1 R inside its radius above (or beside) the top surface it meets: the surface point,
// the normal out of the shape and a depth of 0.1 R.
const shapes = [
  ['ball', { shape: 'sphere', radius: 1 }, [0, 1 + 0.9 * R, 0], [0, 1, 0]],
  ['box', { shape: 'box', halfExtents: [1, 1, 1] }, [0.3, 1 + 0.9 * R, 0.2], [0, 1, 0]],
  ['capsule', { shape: 'capsule', halfHeight: 1, radius: 0.5 }, [0, 1.5 + 0.9 * R, 0], [0, 1, 0]],
  ['cylinder', { shape: 'cylinder', halfHeight: 1, radius: 1 }, [0.2, 1 + 0.9 * R, 0.1], [0, 1, 0]],
  ['cone', { shape: 'cone', halfHeight: 1, radius: 1 }, [0.3, -1 - 0.9 * R, 0.1], [0, -1, 0]],
  [
    'convex hull',
    {
      shape: 'convexHull',
      points: [-1, -1, -1, 1, -1, -1, 1, -1, 1, -1, -1, 1, -1, 1, -1, 1, 1, -1, 1, 1, 1, -1, 1, 1],
    },
    [0.2, 1 + 0.9 * R, -0.3],
    [0, 1, 0],
  ],
  [
    'triangle mesh',
    { shape: 'trimesh', vertices: [-5, 0, -5, 5, 0, -5, 5, 0, 5, -5, 0, 5], indices: [0, 2, 1, 0, 3, 2] },
    [0.4, 0.9 * R, 0.4],
    [0, 1, 0],
    0,
  ],
  [
    'compound',
    {
      shape: 'compound',
      parts: [
        { shape: 'box', halfExtents: [1, 1, 1], offset: [0, 0, 0] },
        { shape: 'sphere', radius: 0.5, offset: [3, 0, 0] },
      ],
    },
    [3, 0.5 + 0.9 * R, 0],
    [0, 1, 0],
    0.5,
  ],
  ['half space', { shape: 'halfSpace', normal: [0, 1, 0] }, [1, 0.9 * R, 2], [0, 1, 0], 0],
  [
    'height field',
    { shape: 'heightfield', rows: 2, columns: 2, heights: [0, 0, 0, 0, 0, 0, 0, 0, 0], scale: [10, 1, 10] },
    [1, 0.9 * R, 1],
    [0, 1, 0],
    0,
  ],
  [
    'voxels',
    { shape: 'voxels', cells: Int32Array.from([0, 0, 0, 1, 0, 0]), size: [1, 1, 1] },
    [0.5, 1 + 0.9 * R, 0.5],
    [0, 1, 0],
    1,
  ],
];
for (const [name, collider, at, up] of shapes)
  test(`a particle resting inside its radius of a ${name} gets the surface point, the outward normal and the depth`, () => {
    const { physics, kernel } = world(collider);
    // It rests: it ends where it began, so there is nothing to sweep and the depth is read from the nearest point.
    const contact = probe(kernel, at, at);
    assert.ok(contact, `${name}: a contact`);
    near(contact.depth, 0.1 * R, 0.01 * R + 2e-3, `${name}: depth`);
    near(contact.normal[0] * up[0] + contact.normal[1] * up[1] + contact.normal[2] * up[2], 1, 0.02, `${name}: normal`);
    // The point is on the surface: the particle's centre is a radius less its depth from it, along the normal.
    const gap = [0, 1, 2].reduce((sum, k) => sum + (at[k] - contact.point[k]) * contact.normal[k], 0);
    near(gap, R - contact.depth, 2e-3, `${name}: the point on the surface`);
    // A particle a radius and a half away touches nothing.
    const away = at.map((v, k) => v + up[k] * 0.15);
    assert.equal(probe(kernel, away, away), null, `${name}: clear`);
    physics.dispose();
  });

test('a particle moving fast through a thin box is stopped at its first face, not carried through it', () => {
  const { physics, kernel } = world({ shape: 'box', halfExtents: [5, 0.01, 5] });
  // 20 m in one step, from far above to far below the 2 cm slab.
  const contact = probe(kernel, [1, 10, 1], [1, -10, 1]);
  assert.ok(contact, 'a contact');
  near(contact.t, (10 - (0.01 + R)) / 20, 1e-3, 'the touch is where the ball meets the top face');
  assert.deepEqual(
    contact.normal.map((v) => Math.round(v) + 0),
    [0, 1, 0],
  );
  assert.ok(contact.depth > 9, `the end of the move is deep inside: ${contact.depth}`);
  assert.equal(contact.started, false);
  physics.dispose();
});

test('a particle moving fast through a one-triangle-thick mesh, a compound and a height field is stopped by each', () => {
  for (const collider of [
    { shape: 'trimesh', vertices: [-5, 0, -5, 5, 0, -5, 5, 0, 5, -5, 0, 5], indices: [0, 2, 1, 0, 3, 2] },
    { shape: 'compound', parts: [{ shape: 'box', halfExtents: [5, 0.005, 5], offset: [0, 0, 0] }] },
    { shape: 'heightfield', rows: 2, columns: 2, heights: [0, 0, 0, 0, 0, 0, 0, 0, 0], scale: [10, 1, 10] },
  ]) {
    const { physics, kernel } = world(collider);
    const contact = probe(kernel, [0.5, 50, 0.5], [0.5, -50, 0.5]);
    assert.ok(contact, `${collider.shape}: stopped`);
    near(contact.t, (50 - R) / 100, 2e-3, `${collider.shape}: at the surface`);
    near(contact.normal[1], 1, 0.01, `${collider.shape}: normal`);
    physics.dispose();
  }
});

test('a particle that starts in contact says so, and one inside a solid is pushed out through the nearest face', () => {
  const { physics, kernel } = world({ shape: 'box', halfExtents: [1, 1, 1] });
  const started = probe(kernel, [0.2, 1 + 0.5 * R, 0], [0.2, 1 + 0.9 * R, 0]);
  assert.ok(started?.started, 'it started touching');
  const inside = probe(kernel, [0.1, 0, 0.2], [0.1, 0.5, 0.2]);
  assert.ok(inside, 'inside a solid');
  assert.deepEqual(
    inside.normal.map((v) => Math.round(v) + 0),
    [0, 1, 0],
    'out through the top face',
  );
  near(inside.depth, R + 0.5, 1e-3, 'depth: the way out plus the radius');
  physics.dispose();
});

test('groups and filters are honoured: a query with groups sees only what meets them, flags leave kinds out, a body is skipped', () => {
  const physics = new Physics(null, { gravity: [0, 0, 0] });
  const a = physics.addBody(null, {
    type: 'fixed',
    position: [0, 0, 0],
    colliders: { shape: 'box', halfExtents: [1, 1, 1], collisionGroups: collisionGroups([1], [1]) },
  });
  physics.addBody(null, {
    type: 'fixed',
    position: [10, 0, 0],
    colliders: { shape: 'box', halfExtents: [1, 1, 1], collisionGroups: collisionGroups([2], [2]) },
  });
  physics.step();
  const kernel = physics.kernel,
    near1 = [0, 1.05, 0],
    near2 = [10, 1.05, 0];
  assert.ok(probe(kernel, near1, near1) && probe(kernel, near2, near2), 'no groups, no test: both seen');
  const g1 = { groups: collisionGroups([1], [1]) };
  assert.ok(probe(kernel, near1, near1, R, g1), 'a particle of group 1 meets the group 1 box');
  assert.equal(probe(kernel, near2, near2, R, g1), null, 'and not the group 2 one');
  assert.equal(probe(kernel, near1, near1, R, { excludeBody: a.row }), null, 'a body can be left out');
  assert.equal(probe(kernel, near1, near1, R, { flags: 1 }), null, 'excludeFixed leaves fixed colliders out');
  physics.dispose();
});

test('a batch is answered one for one, in chunks past the capacity, and bad input is refused', () => {
  const { physics, kernel } = world({ shape: 'box', halfExtents: [100, 1, 100] });
  const count = kernel.probeCapacity + 10,
    from = new Float32Array(3 * count),
    to = new Float32Array(3 * count);
  for (let i = 0; i < count; i++) {
    from.set([i % 50, i % 2 ? 1.05 : 3, i % 7], 3 * i);
    to.set([i % 50, i % 2 ? 1.05 : 3, i % 7], 3 * i);
  }
  const answers = kernel.probeParticles(from, to, R);
  assert.equal(answers.length, count);
  answers.forEach((a, i) => assert.equal(a !== null, i % 2 === 1, `particle ${i}`));
  assert.throws(() => kernel.probeParticles([0, 0, 0], [0, 0], R), /same number/);
  assert.throws(() => kernel.probeParticles([0, 0, 0], [0, 0, 0], [1, 2]), /radii/);
  assert.throws(() => kernel.probeParticles([0, Number.NaN, 0], [0, 0, 0], R), /finite/);
  physics.dispose();
});
