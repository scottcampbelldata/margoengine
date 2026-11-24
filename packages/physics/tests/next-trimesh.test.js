// Triangle meshes on the own solver: what JS hands the kernel, and what a body on a mesh then does. The contact mechanics
// are proved in kernel/tests/mesh.rs; here the options have to reach the kernel and mean it.
import assert from 'node:assert/strict';
import test from 'node:test';
import { KernelWorld, Physics, trianglesAcross } from '../dist/index.js';

await Physics.load();

/** A flat grid of n by n squares of `size` metres on y = 0, two triangles each, counter-clockwise seen from above. */
function grid(n, size) {
  const vertices = [],
    indices = [],
    half = (n * size) / 2,
    at = (i, j) => j * (n + 1) + i;
  for (let j = 0; j <= n; j++) for (let i = 0; i <= n; i++) vertices.push(i * size - half, 0, j * size - half);
  for (let j = 0; j < n; j++)
    for (let i = 0; i < n; i++)
      indices.push(at(i, j), at(i, j + 1), at(i + 1, j), at(i + 1, j), at(i, j + 1), at(i + 1, j + 1));
  return { vertices, indices };
}

test('edges join by position, so a mesh split at its seams still joins, and an edge of three triangles is open', () => {
  // Two triangles sharing an edge whose ends are stored twice, as a texture seam stores them.
  const vertices = [0, 0, 0, 1, 0, 0, 0, 0, 1, 1, 0, 0, 0, 0, 1, 1, 0, 1];
  assert.deepEqual([...trianglesAcross(vertices, [0, 2, 1, 3, 4, 5])], [-1, 1, -1, 0, -1, -1]);
  // A third triangle on the same edge: none of them owns it.
  const fin = [...vertices, 0.5, 1, 0.5];
  assert.deepEqual([...trianglesAcross(fin, [0, 2, 1, 3, 4, 5, 1, 2, 6])], [-1, -1, -1, -1, -1, -1, -1, -1, -1]);
});

test('a ball dropped on a trimesh floor rests on it', () => {
  const physics = new Physics(null),
    { vertices, indices } = grid(8, 1),
    floor = physics.addBody(null, { type: 'fixed', colliders: { shape: 'trimesh', vertices, indices } }),
    ball = physics.addBody(null, { position: [0.3, 2, 0.2], colliders: { shape: 'sphere', radius: 0.5 } });
  for (let i = 0; i < 180; i++) physics.step();
  const [, y] = ball.position;
  assert.ok(Math.abs(y - 0.5) < 2e-3, `rests at ${y}`);
  assert.equal(physics.touching(ball, floor), true);
  assert.equal(floor.mass, 0);
  physics.dispose();
});

test('fixInternalEdges reaches the kernel: a box slides over the seams without catching', () => {
  const run = (fixInternalEdges) => {
    const physics = new Physics(null),
      { vertices, indices } = grid(20, 1);
    physics.addBody(null, {
      type: 'fixed',
      colliders: { shape: 'trimesh', vertices, indices, fixInternalEdges, friction: 0 },
    });
    const box = physics.addBody(null, {
      position: [-7, 0.25, 0.3],
      canSleep: false,
      colliders: { shape: 'box', halfExtents: [0.4, 0.25, 0.3], friction: 0 },
    });
    for (let i = 0; i < 30; i++) physics.step();
    box.setLinearVelocity([4, 0, 0]);
    let spin = 0;
    for (let i = 0; i < 120; i++) {
      physics.step();
      const [x, y, z] = box.angularVelocity;
      spin = Math.max(spin, Math.hypot(x, y, z));
    }
    physics.dispose();
    return spin;
  };
  const [smooth, rough] = [run(true), run(false)];
  assert.ok(smooth < 1e-2, `spin with the fix ${smooth}`);
  assert.ok(rough > 0.1, `the seams catch without it (spin ${rough}), which is what the option is for`);
});

test("fixInternalEdges holds from the back of the surface too, as Rapier's FIX_INTERNAL_EDGES_TWO_SIDED does", () => {
  // The same slide as above, along the underside of the mesh: gravity up, the box pressed to the back faces.
  const run = (fixInternalEdges) => {
    const physics = new Physics(null, { gravity: [0, 10, 0] }),
      { vertices, indices } = grid(20, 1);
    physics.addBody(null, {
      type: 'fixed',
      colliders: { shape: 'trimesh', vertices, indices, fixInternalEdges, friction: 0 },
    });
    const box = physics.addBody(null, {
      position: [-7, -0.25, 0.3],
      canSleep: false,
      colliders: { shape: 'box', halfExtents: [0.4, 0.25, 0.3], friction: 0 },
    });
    for (let i = 0; i < 30; i++) physics.step();
    box.setLinearVelocity([4, 0, 0]);
    let spin = 0;
    for (let i = 0; i < 120; i++) {
      physics.step();
      const [x, y, z] = box.angularVelocity;
      spin = Math.max(spin, Math.hypot(x, y, z));
    }
    physics.dispose();
    return spin;
  };
  const [smooth, rough] = [run(true), run(false)];
  assert.ok(smooth < 1e-2, `spin with the fix ${smooth}`);
  assert.ok(rough > 0.1, `the seams catch from below without it (spin ${rough})`);
});

test('a mesh pair is one pair to JS: one contactforce event, one entry in pairs()', () => {
  const physics = new Physics(null),
    { vertices, indices } = grid(4, 1),
    floor = physics.addBody(null, { type: 'fixed', colliders: { shape: 'trimesh', vertices, indices } }),
    box = physics.addBody(null, {
      position: [0.1, 0.5, 0.1],
      canSleep: false,
      colliders: { shape: 'box', halfExtents: [0.6, 0.5, 0.6], mass: 3 },
    }),
    seen = [];
  const stop = physics.on('contactforce', (event) => seen.push(event));
  for (let i = 0; i < 60; i++) physics.step();
  stop();
  assert.ok(physics.kernel.contacts().length > 1, 'a box over several triangles has a manifold on each');
  assert.equal(physics.kernel.pairs().length, 1);
  const last = seen.slice(-10);
  assert.equal(seen.length, 60, 'once a step for the one pair');
  for (const event of last)
    assert.ok(Math.abs(event.force - 3 * 9.81) < 0.1, `the weight in one event, read ${event.force}`);
  assert.deepEqual(new Set([seen[0].bodyA, seen[0].bodyB]), new Set([floor, box]));
  physics.dispose();
});

test('a trimesh refuses mass, broken indices and numbers it cannot use', () => {
  const physics = new Physics(null),
    { vertices, indices } = grid(1, 1);
  const add = (colliders) => physics.addBody(null, { type: 'fixed', colliders: { shape: 'trimesh', ...colliders } });
  assert.throws(() => add({ vertices, indices, mass: 1 }), /closed surface/);
  assert.throws(() => add({ vertices, indices: [0, 1] }), /whole triangles/);
  assert.throws(() => add({ vertices: [0, 0, 0, 1, 0, NaN, 0, 0, 1], indices: [0, 1, 2] }), /finite/);
  assert.throws(() => new KernelWorld().addTrimesh([0, 0, 0, 1, 0, 0, 0, 0, 1], [0, 1, 7]), /index 2 is 7/);
  physics.dispose();
});

test('a snapshot carries a mesh: the restored world steps the same', () => {
  const { vertices, indices } = grid(6, 1),
    world = new KernelWorld(),
    floor = world.addBody('fixed'),
    mesh = world.addTrimesh(vertices, indices, { fixInternalEdges: true });
  world.addCollider(floor, 'trimesh', [mesh]);
  const ball = world.addBody('dynamic');
  world.addCollider(ball, 'ball', [0.5]);
  world.setPose(ball, [0.2, 1, 0.1], [0, 0, 0, 1]);
  for (let i = 0; i < 20; i++) world.step(1 / 60);
  const bytes = world.snapshot(),
    copy = new KernelWorld().restore(bytes);
  for (let i = 0; i < 60; i++) {
    world.step(1 / 60);
    copy.step(1 / 60);
  }
  assert.equal(copy.hash, world.hash);
  assert.ok(Math.abs(world.columns.positionY[ball] - 0.5) < 2e-3);
});

test('a restored world takes only the hull and mesh rows it holds', () => {
  // A restore once took the rows there was room for, so a collider could name a row nothing was written to.
  const world = new KernelWorld(),
    body = world.addBody('fixed');
  for (let i = 0; i < 3; i++) {
    world.addHull(
      [
        [0, 0, 0],
        [1, 0, 0],
        [0, 1, 0],
        [0, 0, 1],
      ],
      [
        [0, 2, 1],
        [0, 1, 3],
        [0, 3, 2],
        [1, 2, 3],
      ],
    );
    world.addTrimesh([0, 0, 0, 1, 0, 0, 0, 0, 1], [0, 2, 1]);
  }
  const copy = new KernelWorld().restore(world.snapshot());
  assert.ok(
    copy.columns.hullFirstVertex.length > 3 && copy.columns.meshFirstVertex.length > 3,
    'room for more rows than were written',
  );
  copy.addCollider(body, 'hull', [2]);
  copy.addCollider(body, 'trimesh', [2]);
  assert.throws(() => copy.addCollider(body, 'hull', [3]), /a row addHull returned/);
  assert.throws(() => copy.addCollider(body, 'trimesh', [3]), /a row addTrimesh returned/);
});

// A closed mesh wound outwards has the mass of the volume it encloses (Rapier's trimesh mass), about its own centre of mass.
const cube = (lo, hi) => {
  const v = [];
  for (let i = 0; i < 8; i++) v.push(i & 1 ? hi[0] : lo[0], i & 2 ? hi[1] : lo[1], i & 4 ? hi[2] : lo[2]);
  const f = [
    0, 2, 1, 1, 2, 3, 4, 5, 6, 5, 7, 6, 0, 1, 4, 1, 5, 4, 2, 6, 3, 3, 6, 7, 0, 4, 2, 2, 4, 6, 1, 3, 5, 3, 7, 5,
  ];
  return { vertices: v, indices: f };
};

test('a closed trimesh has the mass, centre and inertia of the box it encloses, as a box collider does', () => {
  const lo = [1, 2, 3],
    hi = [3, 3, 7],
    { vertices, indices } = cube(lo, hi);
  const physics = new Physics(null, { gravity: [0, 0, 0] });
  const mesh = physics.addBody(null, { colliders: { shape: 'trimesh', vertices, indices, density: 500 } });
  const reference = physics.addBody(null, {
    position: [2, 2.5, 5],
    colliders: { shape: 'box', halfExtents: [1, 0.5, 2], density: 500 },
  });
  physics.step();
  const volume = 2 * 1 * 4;
  assert.ok(Math.abs(mesh.colliders[0].volume() - volume) < 1e-4, `volume ${mesh.colliders[0].volume()}`);
  assert.ok(Math.abs(mesh.mass - 500 * volume) < 0.5, `mass ${mesh.mass}`);
  // The centre of mass is the middle of the box, in the body's frame; the inertia is the box's.
  for (let k = 0; k < 3; k++)
    assert.ok(Math.abs(mesh.centerOfMass[k] - (lo[k] + hi[k]) / 2) < 1e-4, `centre ${mesh.centerOfMass}`);
  for (let k = 0; k < 3; k++)
    assert.ok(
      Math.abs(mesh.principalInertia[k] / reference.principalInertia[k] - 1) < 2e-3,
      `inertia ${mesh.principalInertia} against ${reference.principalInertia}`,
    );
  // A mass given sets the density from the volume.
  const heavy = physics.addBody(null, { colliders: { shape: 'trimesh', vertices, indices, mass: 80 } });
  assert.ok(Math.abs(heavy.mass - 80) < 0.05, `mass ${heavy.mass}`);
  // And it falls and rests as a solid body does.
  physics.dispose();
  const world = new Physics(null);
  world.addBody(null, {
    type: 'fixed',
    position: [0, -0.5, 0],
    colliders: { shape: 'box', halfExtents: [20, 0.5, 20] },
  });
  const fall = world.addBody(null, {
    position: [0, 2, 0],
    colliders: { shape: 'trimesh', ...cube([-0.5, -0.5, -0.5], [0.5, 0.5, 0.5]), density: 100 },
  });
  for (let i = 0; i < 240; i++) world.step();
  assert.ok(Math.abs(fall.position[1] - 0.5) < 0.02, `rests on its bottom face: ${fall.position[1]}`);
  world.dispose();
});

test('a trimesh with a mass or density must be closed and wound outwards, and says how to fix it', () => {
  const physics = new Physics(null);
  const { vertices, indices } = cube([0, 0, 0], [1, 1, 1]);
  assert.throws(
    () => physics.addBody(null, { colliders: { shape: 'trimesh', vertices, indices: indices.slice(3), density: 1 } }),
    /closed surface/,
  );
  const inside = indices.slice();
  for (let t = 0; t < inside.length; t += 3) [inside[t + 1], inside[t + 2]] = [inside[t + 2], inside[t + 1]];
  assert.throws(
    () => physics.addBody(null, { colliders: { shape: 'trimesh', vertices, indices: inside, density: 1 } }),
    /wound outwards/,
  );
  physics.dispose();
});
