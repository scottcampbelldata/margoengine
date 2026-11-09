import test from 'node:test';
import assert from 'node:assert/strict';
import { Geometry } from '../../core/dist/index.js';
import { createSdfModeler } from '../dist/sdf.js';

test('island CSG input derives bounds beyond the old default cube', async () => {
  using modeler = await createSdfModeler();
  const mesh = modeler.mesh(
    {
      type: 'difference',
      a: { type: 'box', halfSize: [1.8, 2.8, 1.8] },
      b: { type: 'sphere', center: [0.6, 0.5, 0.6], radius: 1.4 },
    },
    { resolution: 24 },
  );
  assert.ok(mesh.indices.length > 0);
  for (const [axis, extent] of [
    [0, 1.8],
    [1, 2.8],
    [2, 1.8],
  ]) {
    const values = mesh.positions.filter((_, i) => i % 3 === axis);
    assert.ok(Math.abs(Math.min(...values) + extent) < 1e-8);
    assert.ok(Math.abs(Math.max(...values) - extent) < 1e-8);
  }
});

test('translated primitives, unions, intersections and empty intersections infer enclosing bounds', async () => {
  using modeler = await createSdfModeler();
  const a = { type: 'sphere', center: [20, -30, 40], radius: 2 };
  const b = { type: 'box', center: [22, -30, 40], halfSize: [2, 1, 1] };
  for (const shape of [a, b, { type: 'union', a, b }, { type: 'intersection', a, b }]) {
    const mesh = modeler.mesh(shape);
    assert.ok(mesh.indices.length > 0);
    assert.ok(mesh.positions.every(Number.isFinite));
  }
  const empty = modeler.mesh({ type: 'intersection', a, b: { type: 'sphere', radius: 1 } });
  assert.equal(empty.indices.length, 0);
  assert.throws(
    () =>
      modeler.mesh(a, {
        bounds: [
          [19, -31, 39],
          [21, -29, 41],
        ],
      }),
    (e) => e.code === 'failed' && /boundary.*https:\/\/margoengine.com\/errors#procedural/.test(e.message),
  );
});

test('SDF meshes expose owned analytic outward gradient normals consumable by Geometry', async () => {
  using modeler = await createSdfModeler();
  const sphere = modeler.mesh({ type: 'sphere', center: [4, 5, 6], radius: 2 });
  assert.equal(sphere.normals?.length, sphere.positions.length);
  for (let i = 0; i < sphere.positions.length; i += 3) {
    const p = sphere.positions.slice(i, i + 3).map((v, k) => v - [4, 5, 6][k]);
    const length = Math.hypot(...p);
    for (let k = 0; k < 3; k++) assert.ok(Math.abs(sphere.normals[i + k] - p[k] / length) < 1e-12);
  }
  const geometry = new Geometry(sphere.positions, sphere.normals, sphere.indices);
  assert.equal(geometry.indices.length, sphere.indices.length);
  const copy = sphere.normals.slice();
  const cavity = modeler.mesh(
    { type: 'difference', a: { type: 'box', halfSize: [2, 2, 2] }, b: { type: 'sphere', radius: 1 } },
    { resolution: 25 },
  );
  let inner = 0;
  for (let i = 0; i < cavity.positions.length; i += 3) {
    const p = cavity.positions.slice(i, i + 3),
      n = cavity.normals.slice(i, i + 3);
    assert.ok(Math.abs(Math.hypot(...n) - 1) < 1e-12);
    if (Math.hypot(...p) < 1.2) {
      assert.ok(p.reduce((sum, v, k) => sum + v * n[k], 0) < 0);
      inner++;
    }
  }
  assert.ok(inner > 0);
  modeler.dispose();
  assert.deepEqual(sphere.normals, copy);
});
