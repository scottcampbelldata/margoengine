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

