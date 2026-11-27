import assert from 'node:assert/strict';
import test from 'node:test';
import { FiniteQuayWake } from '../../dist/loads.js';
import { bakeWakeHullMask } from '../../dist/sea.js';
import { PhysicsWorld } from '../../dist/world.js';

function box([a, b, c], [d, e, f]) {
  return {
    vertices: [a, b, c, d, b, c, d, e, c, a, e, c, a, b, f, d, b, f, d, e, f, a, e, f],
    indices: [
      0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 3, 7, 6, 3, 6, 2, 0, 4, 7, 0, 7, 3, 1, 2, 6, 1, 6, 5,
    ],
  };
}

function cylinder(sides, radius, bottom, top) {
  const vertices = [0, bottom, 0, 0, top, 0];
  const indices = [];
  for (let i = 0; i < sides; i++) {
    const angle = (i * 2 * Math.PI) / sides;
    const x = radius * Math.cos(angle),
      z = radius * Math.sin(angle);
    vertices.push(x, bottom, z, x, top, z);
  }
  for (let i = 0; i < sides; i++) {
    const a = 2 + 2 * i;
    const b = 2 + 2 * ((i + 1) % sides);
    indices.push(0, a, b, 1, b + 1, a + 1, a, a + 1, b, a + 1, b + 1, b);
  }
  return { vertices, indices };
}

const origin = [-2.05, -1.85];
const baseDepths = [0, 0.16, 0.39, 0.63, 0.92, 1.2];
function grid(refine) {
  const depths = baseDepths
    .slice(1)
    .flatMap((bottom, i) =>
      Array.from({ length: refine }, (_, j) => baseDepths[i] + ((bottom - baseDepths[i]) * (j + 1)) / refine),
    );
  return { cells: [20 * refine, 18 * refine], cellSize: 0.24 / refine, depths: [0, ...depths], origin };
}

function volume(shape, mask) {
  const [nx, nz] = shape.cells;
  const plane = nx * nz;
  return (
    shape.cellSize ** 2 *
    mask.reduce((sum, value, i) => {
      const layer = Math.floor(i / plane);
      return sum + value * (shape.depths[layer + 1] - shape.depths[layer]);
    }, 0)
  );
}

function reindexed(mesh) {
  const count = mesh.vertices.length / 3;
  const vertices = Array.from(
    { length: mesh.vertices.length },
    (_, i) => mesh.vertices[3 * (count - 1 - Math.floor(i / 3)) + (i % 3)],
  );
  const indices = [];
  for (let i = mesh.indices.length - 3; i >= 0; i -= 3) {
    for (const corner of [1, 2, 0]) indices.push(count - 1 - mesh.indices[i + corner]);
  }
  return { vertices, indices };
}

test('a translated and yawed box bakes at the real nonuniform layer centres, with analytic refinement bounds', (t) => {
  const low = [-0.73, -0.74, -0.52];
  const high = [0.71, 0.16, 0.61];
  const mesh = box(low, high);
  const [tx, ty, tz] = [0.073, 0.035, -0.13];
  const angle = 0.37;
  const c = Math.cos(angle),
    s = Math.sin(angle);
  const matrix = [c, 0, -s, 0, 0, 1, 0, 0, s, 0, c, 0, tx, ty, tz, 1];
  const exact = (high[0] - low[0]) * (high[2] - low[2]) * (-low[1] - ty);
  const results = [];
  for (const refine of [1, 2, 4]) {
    const shape = grid(refine);
    const mask = bakeWakeHullMask(mesh, shape, matrix);
    const [nx, nz] = shape.cells;
    const plane = nx * nz;
    for (let i = 0; i < mask.length; i++) {
      const layer = Math.floor(i / plane);
      const x = origin[0] + ((i % nx) + 0.5) * shape.cellSize - tx;
      const z = origin[1] + ((Math.floor(i / nx) % nz) + 0.5) * shape.cellSize - tz;
      const y = -(shape.depths[layer + 1] + shape.depths[layer]) / 2 - ty;
      const p = [c * x - s * z, y, s * x + c * z];
      assert.equal(mask[i], Number(p.every((v, axis) => low[axis] <= v && v < high[axis])));
    }
    const delta = (shape.cellSize * (Math.abs(c) + Math.abs(s))) / 2;
    const halfLayer = Math.max(...shape.depths.slice(1).map((value, i) => value - shape.depths[i])) / 2;
    const [length, beam, draft] = [high[0] - low[0], high[2] - low[2], -low[1] - ty];
    const lower = (length - 2 * delta) * (beam - 2 * delta) * (draft - halfLayer);
    const upper = (length + 2 * delta) * (beam + 2 * delta) * (draft + halfLayer);
    const actual = volume(shape, mask);
    assert.ok(lower < actual && actual < upper);
    assert.ok(lower < exact && exact < upper);
    results.push({ refine, actual, lower, upper });
    assert.deepEqual(bakeWakeHullMask(reindexed(mesh), shape, matrix), mask);
    const split = {
      vertices: mesh.indices.flatMap((i) => mesh.vertices.slice(3 * i, 3 * i + 3)),
      indices: mesh.indices.map((_, i) => i),
    };
    assert.deepEqual(bakeWakeHullMask(split, shape, matrix), mask);
  }
  assert.ok(Math.abs(results[2].actual - exact) < Math.abs(results[0].actual - exact));
  assert.ok(results[2].upper - results[2].lower < (results[0].upper - results[0].lower) / 3);
  t.diagnostic(JSON.stringify({ exact, results }));
});

test('a cylinder volume converges and its baked mask drives the production finite wake', (t) => {
  const radius = 0.81;
  const sides = 64;
  const draft = 0.737;
  const mesh = cylinder(sides, radius, -draft, 0.2);
  const exact = (draft * sides * radius ** 2 * Math.sin((2 * Math.PI) / sides)) / 2;
  const actual = [1, 2, 4].map((refine) => {
    const shape = grid(refine);
    const mask = bakeWakeHullMask(mesh, shape);
    const delta = shape.cellSize / Math.SQRT2;
    const halfLayer = Math.max(...shape.depths.slice(1).map((value, i) => value - shape.depths[i])) / 2;
    const measured = volume(shape, mask);
    assert.ok(measured > Math.PI * (radius * Math.cos(Math.PI / sides) - delta) ** 2 * (draft - halfLayer));
    assert.ok(measured < Math.PI * (radius + delta) ** 2 * (draft + halfLayer));
    return measured;
  });
  assert.ok(Math.abs(actual[2] - exact) < Math.abs(actual[0] - exact));
  const shape = grid(1);
  const mask = bakeWakeHullMask(mesh, shape);
  assert.deepEqual(bakeWakeHullMask(reindexed(mesh), shape), mask);
  const wake = new FiniteQuayWake();
  const world = new PhysicsWorld({ rate: { num: 60, den: 1 } }).add(wake, {
    ...shape,
    initial: (x, z) => [0.01 * Math.exp(-((x + 1) ** 2 + z ** 2)), 0],
    hull: { mask, centre: [0, -draft / 2, 0] },
  });
  assert.equal(wake.wet(0, 0), false);
  assert.equal(wake.wet(1.1, 0), true);
  const checkpoint = world.takeSnapshot();
  world.advance(3);
  assert.ok(Math.abs(wake.hullExchange().impulse[0]) > 1e-5);
  const accepted = world.takeSnapshot();
  world.restoreSnapshot(checkpoint.bytes);
  world.advance(3);
  assert.deepEqual(world.takeSnapshot().bytes, accepted.bytes);
  t.diagnostic(JSON.stringify({ exact, actual }));
});

test('rays on shared face diagonals still classify the full closed box exactly', () => {
  const shape = { cells: [4, 2], cellSize: 1, origin: [-2, 0], depths: [0, 1, 2] };
  const mesh = box([-1, -2, 0], [1, 0, 2]);
  const mask = bakeWakeHullMask(mesh, shape);
  assert.deepEqual(
    mask,
    Uint8Array.from({ length: 16 }, (_, i) => Number(i % 4 === 1 || i % 4 === 2)),
  );
  assert.deepEqual(bakeWakeHullMask(reindexed(mesh), shape), mask);
});

test('baking clips existing dry cells and rejects malformed closed meshes and transforms', () => {
  const shape = { cells: [4, 4], cellSize: 1, origin: [0, 0], depths: [0, 0.7, 2] };
  const mesh = box([-3, -0.85, 0.1], [1.3, 0.1, 2.6]);
  const wet = new Uint8Array(32).fill(1);
  wet[4] = 0;
  const mask = bakeWakeHullMask(mesh, { ...shape, wet });
  assert.deepEqual(
    Array.from(mask.keys()).filter((i) => mask[i]),
    [0, 8],
  );
  assert.throws(() => bakeWakeHullMask({ ...mesh, indices: mesh.indices.slice(3) }, shape), { code: 'state' });
  assert.throws(() => bakeWakeHullMask(mesh, shape, new Float64Array(16)), { code: 'state' });
  assert.throws(() => bakeWakeHullMask(mesh, { ...shape, depths: [0, 2, 1] }), { code: 'state' });
});
