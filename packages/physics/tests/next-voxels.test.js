// Voxel colliders on the own solver, held to what Rapier (the root entry, as a black box) does with the same grids:
// where a box rests, how size scales the cells, edits in place, the seam between two coupled grids (and the catch at an
// uncoupled one), a grid's mass, and what a grid meets. The contact mechanics are proved in kernel/tests/voxel.rs.
import assert from 'node:assert/strict';
import test from 'node:test';
import { Physics as RapierPhysics } from '../dist/index.js';
import { Physics } from '../dist/next.js';

const warn = console.warn;
console.warn = () => {};
await Promise.all([Physics.load(), RapierPhysics.load()]);
console.warn = warn;

const near = (actual, expected, tolerance, what) =>
  assert.ok(Math.abs(actual - expected) <= tolerance, `${what}: ${actual} against ${expected}`);
const cells = (...list) => Int32Array.from(list.flat());
/** A square of cells at height y, from 0 to size in x and z. */
const slab = (size, y = 0) => {
  const out = [];
  for (let x = 0; x < size; x++) for (let z = 0; z < size; z++) out.push(x, y, z);
  return Int32Array.from(out);
};
const step = (physics, steps) => {
  for (let i = 0; i < steps; i++) physics instanceof Physics ? physics.step() : physics.update(1 / 60);
};
/** Runs `scene` on both solvers and hands back what each gives. */
const both = (scene) => [scene(new Physics(null)), scene(new RapierPhysics(null))];

test('a box rests on the top of the cells where Rapier rests it, and size scales the cells', () => {
  for (const [size, at, half, top] of [
    [[1, 1, 1], [4, 3, 4], 0.5, 1.5],
    [[0.5, 2, 0.5], [2, 4, 2], 0.25, 2.25],
  ]) {
    const [own, rapier] = both((physics) => {
      physics.addBody(null, { type: 'fixed', colliders: { shape: 'voxels', cells: slab(8), size, massless: true } });
      const crate = physics.addBody(null, { position: at, colliders: { shape: 'box', halfExtents: [half, half, half] } });
      step(physics, 240);
      return crate.position[1];
    });
    near(own, top, 0.02, 'own rest');
    near(own, rapier, 0.01, 'own against Rapier');
  }
});

test('setVoxel opens a hole under a body in place, and a cell outside the grid grows it, as on Rapier', () => {
  const [own, rapier] = both((physics) => {
    const ground = physics.addBody(null, {
        type: 'fixed',
        colliders: { shape: 'voxels', cells: cells([0, 0, 0], [1, 0, 0], [2, 0, 0]), massless: true },
      }),
      [grid] = ground.colliders,
      crate = physics.addBody(null, { position: [1.5, 2, 0.5], canSleep: false, colliders: { shape: 'box', halfExtents: [0.25, 0.25, 0.25] } });
    step(physics, 180);
    const rest = crate.position[1];
    assert.equal(grid.setVoxel(1, 0, 0, false), grid);
    step(physics, 60);
    const fell = crate.position[1];
    assert.equal(ground.colliders[0], grid, 'the same collider');
    grid.setVoxel(5, 0, 0, true);
    const other = physics.addBody(null, { position: [5.5, 2, 0.5], colliders: { shape: 'box', halfExtents: [0.25, 0.25, 0.25] } });
    step(physics, 180);
    return { rest, fell, grown: other.position[1] };
  });
  near(own.rest, 1.25, 0.02, 'own rest');
  assert.ok(own.fell < 0.5, `own fell to ${own.fell}`);
  assert.ok(rapier.fell < 0.5, `Rapier fell to ${rapier.fell}`);
  near(own.grown, rapier.grown, 0.01, 'rest on the grown cell against Rapier');
});

test('a box crosses two coupled grids at its height as on Rapier, and catches at an uncoupled border as Rapier does', () => {
  for (const coupled of [true, false]) {
    const [own, rapier] = both((physics) => {
      const fixed = (x) =>
          physics.addBody(null, { type: 'fixed', position: [x, 0, 0], colliders: { shape: 'voxels', cells: slab(4), massless: true } })
            .colliders[0],
        a = fixed(0),
        b = fixed(4);
      if (coupled) {
        assert.equal(a.combineVoxelStates(b, 4, 0, 0), a);
        a.setVoxel(3, 0, 0, false);
        assert.equal(a.propagateVoxelChange(b, 3, 0, 0, 4, 0, 0), a);
      }
      a.setFriction(0);
      b.setFriction(0);
      const crate = physics.addBody(null, {
        position: [2, 1.3, 2],
        linearVelocity: [3, 0, 0],
        canSleep: false,
        colliders: { shape: 'box', halfExtents: [0.3, 0.3, 0.3], friction: 0 },
      });
      let low = Infinity,
        high = -Infinity;
      for (let i = 0; i < 60; i++) {
        step(physics, 1);
        low = Math.min(low, crate.position[1]);
        high = Math.max(high, crate.position[1]);
      }
      return { x: crate.position[0], speed: crate.linearVelocity[0], low, high };
    });
    if (coupled) {
      for (const [name, run] of [['own', own], ['Rapier', rapier]]) {
        assert.ok(run.x > 4.5, `${name} crossed the seam to x = ${run.x}`);
        assert.ok(run.low > 1.28 && run.high < 1.32, `${name} height ${run.low} to ${run.high}`);
      }
      near(own.speed, 3, 0.01, 'own speed after the seam');
    } else {
      assert.ok(own.speed < 2.5 && rapier.speed < 2.5, `both catch: own ${own.speed}, Rapier ${rapier.speed} m/s`);
    }
  }
});

test('a dynamic grid weighs what Rapier says, its centre and moments where Rapier puts them, and follows an edit', () => {
  const options = {
      position: [0, 3, 0],
      colliders: { shape: 'voxels', cells: cells([0, 0, 0], [1, 0, 0], [0, 1, 0], [0, 0, 2], [0, 0, 2]), size: [0.5, 0.4, 0.3], density: 3 },
    },
    own = new Physics(null),
    rapier = new RapierPhysics(null),
    a = own.addBody(null, options),
    b = rapier.addBody(null, options),
    compare = (what) => {
      near(a.mass, b.mass, 1e-5 * b.mass, `${what} mass`);
      for (let k = 0; k < 3; k++) near(a.centerOfMass[k], b.centerOfMass[k], 1e-5, `${what} centre ${k}`);
      const sorted = (body) => [...body.principalInertia].sort((x, y) => x - y),
        [ia, ib] = [sorted(a), sorted(b)];
      for (let k = 0; k < 3; k++) near(ia[k], ib[k], 1e-4 * ib[2], `${what} moment ${k}`);
    };
  near(a.mass, 4 * 0.5 * 0.4 * 0.3 * 3, 1e-6, 'a cell named twice counts once');
  compare('new');
  a.colliders[0].setVoxel(1, 0, 0, false);
  b.colliders[0].setVoxel(1, 0, 0, false);
  rapier.update(1 / 60);
  compare('after an edit');
  near(own.addBody(null, { colliders: { shape: 'voxels', cells: slab(2), mass: 8 } }).mass, 8, 1e-6, 'mass option');
});

test('a grid meets boxes, balls, capsules, hulls, compounds and grids, and falls through meshes, as on Rapier', () => {
  const grounds = {
    voxels: { shape: 'voxels', cells: slab(4, -1) },
    compound: { shape: 'compound', parts: [{ shape: 'box', halfExtents: [5, 0.5, 5], offset: [0, -0.5, 0] }] },
    trimesh: { shape: 'trimesh', vertices: [-10, 0, -10, 10, 0, -10, 10, 0, 10, -10, 0, 10], indices: [0, 2, 1, 0, 3, 2] },
  };
  for (const [name, ground] of Object.entries(grounds)) {
    const [own, rapier] = both((physics) => {
      physics.addBody(null, { type: 'fixed', colliders: { ...ground, massless: true } });
      const body = physics.addBody(null, { position: [1, 2, 1], colliders: { shape: 'voxels', cells: cells([0, 0, 0]) } });
      step(physics, 180);
      return body.position[1];
    });
    if (name === 'trimesh') assert.ok(own < -5 && rapier < -5, `both fall through a mesh: ${own}, ${rapier}`);
    else near(own, rapier, 0.01, `a grid on a ${name}`);
  }
  const shapes = {
    ball: { shape: 'sphere', radius: 0.5 },
    capsule: { shape: 'capsule', radius: 0.3, halfHeight: 0.3 },
    hull: { shape: 'convexHull', points: [0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1] },
  };
  for (const [name, colliders] of Object.entries(shapes)) {
    const [own, rapier] = both((physics) => {
      physics.addBody(null, { type: 'fixed', colliders: { shape: 'voxels', cells: slab(4), massless: true } });
      const body = physics.addBody(null, { position: [1.5, 3, 1.5], colliders });
      step(physics, 240);
      return body.position[1];
    });
    near(own, rapier, 0.01, `a ${name} on a grid`);
  }
});

test('voxels options are checked as on the root entry', () => {
  const physics = new Physics(null),
    add = (colliders) => physics.addBody(null, { type: 'fixed', colliders });
  assert.equal(physics.supportsShape('voxels'), true);
  assert.equal(add({ shape: 'voxels', cells: cells([0, 0, 0]) }).colliders[0].boundingRadius, null);
  assert.equal(add({ shape: 'voxels', cells: new Int32Array(0) }).colliders.length, 1, 'an empty grid, as Rapier takes one');
  assert.throws(() => add({ shape: 'voxels', cells: [0, 0, 0] }), TypeError);
  assert.throws(() => add({ shape: 'voxels', cells: Int32Array.of(0, 0) }), TypeError);
  assert.throws(() => add({ shape: 'voxels', cells: slab(1), size: [1, 0, 1] }), RangeError);
  assert.throws(() => add({ shape: 'voxels', cells: slab(1), size: [1, 1] }), RangeError);
  const [grid] = add({ shape: 'voxels', cells: slab(1) }).colliders,
    [ball] = add({ shape: 'sphere', radius: 1 }).colliders;
  assert.throws(() => grid.setVoxel(0.5, 0, 0, true), RangeError);
  assert.throws(() => ball.setVoxel(0, 0, 0, true), RangeError);
  assert.throws(() => grid.combineVoxelStates(ball), RangeError);
});
