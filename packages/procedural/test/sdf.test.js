import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createSdfModeler } from '../dist/sdf.js';

function topology(mesh) {
  const { positions: p, indices } = mesh;
  assert.equal(p.length % 3, 0);
  assert.equal(indices.length % 3, 0);
  assert.ok(p.every(Number.isFinite));
  const edges = new Map();
  let volume = 0;
  for (let i = 0; i < indices.length; i += 3) {
    const ids = [...indices.slice(i, i + 3)];
    assert.ok(ids.every((v) => v < p.length / 3));
    const [a, b, c] = ids.map((v) => p.slice(v * 3, v * 3 + 3).map((x, k) => x - p[k]));
    const u = b.map((v, k) => v - a[k]),
      v = c.map((v, k) => v - a[k]);
    const cross = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
    assert.ok(Math.hypot(...cross) > 1e-14, 'nonzero triangle area');
    volume +=
      (a[0] * (b[1] * c[2] - b[2] * c[1]) + a[1] * (b[2] * c[0] - b[0] * c[2]) + a[2] * (b[0] * c[1] - b[1] * c[0])) /
      6;
    for (let k = 0; k < 3; k++) {
      const x = ids[k],
        y = ids[(k + 1) % 3],
        key = `${Math.min(x, y)},${Math.max(x, y)}`;
      const e = edges.get(key) ?? [0, 0];
      e[0]++;
      e[1] += x < y ? 1 : -1;
      edges.set(key, e);
    }
  }
  for (const [count, direction] of edges.values()) {
    assert.equal(count, 2);
    assert.equal(direction, 0);
  }
  assert.equal(mesh.cellEdgeUses, mesh.edgeSolves * 4);
  assert.ok(volume > 0);
  return volume;
}

test('real Khronos Box reference: all eight corners, planar surface, closed outward mesh and volume', async () => {
  const bytes = readFileSync(new URL('./fixtures/sdf/Box.glb', import.meta.url));
  assert.equal(
    createHash('sha256').update(bytes).digest('hex'),
    'ed52f7192b8311d700ac0ce80644e3852cd01537e4d62241b9acba023da3d54e',
  );
  const jsonLength = bytes.readUInt32LE(12),
    json = JSON.parse(bytes.subarray(20, 20 + jsonLength).toString());
  const accessor = json.accessors[json.meshes[0].primitives[0].attributes.POSITION];
  const view = json.bufferViews[accessor.bufferView],
    binStart = 20 + jsonLength + 8;
  assert.equal(accessor.componentType, 5126);
  const reference = [];
  for (let i = 0; i < accessor.count; i++)
    reference.push(
      [0, 1, 2].map((k) =>
        bytes.readFloatLE(
          binStart + (view.byteOffset ?? 0) + (accessor.byteOffset ?? 0) + i * (view.byteStride ?? 12) + k * 4,
        ),
      ),
    );
  const lo = [0, 1, 2].map((k) => Math.min(...reference.map((p) => p[k]))),
    hi = [0, 1, 2].map((k) => Math.max(...reference.map((p) => p[k])));
  using modeler = await createSdfModeler();
  const mesh = modeler.mesh(
    { type: 'box', center: lo.map((v, k) => (v + hi[k]) / 2), halfSize: lo.map((v, k) => (hi[k] - v) / 2) },
    { resolution: 17 },
  );
  assert.ok(mesh.edgeSolves > 0);
  for (const ref of reference) {
    let nearest = Infinity;
    for (let i = 0; i < mesh.positions.length; i += 3)
      nearest = Math.min(nearest, Math.hypot(...ref.map((v, k) => v - mesh.positions[i + k])));
    assert.ok(nearest < 1e-9, `published corner ${ref}: ${nearest}`);
  }
  for (let i = 0; i < mesh.positions.length; i += 3) {
    let face = Infinity;
    for (let k = 0; k < 3; k++) {
      const v = mesh.positions[i + k];
      assert.ok(v >= lo[k] - 1e-9 && v <= hi[k] + 1e-9);
      face = Math.min(face, Math.abs(v - lo[k]), Math.abs(v - hi[k]));
    }
    assert.ok(face < 1e-9);
  }
  const expected = hi.reduce((v, x, k) => v * (x - lo[k]), 1);
  assert.ok(Math.abs(topology(mesh) - expected) < 1e-9);
});

test('generated controls: spheres, CSG cavities, translations, empty/full fields and grid extremes', async () => {
  using modeler = await createSdfModeler();
  for (const resolution of [4, 16, 64]) {
    const mesh = modeler.mesh({ type: 'sphere', radius: 0.8 }, { resolution });
    topology(mesh);
    const h = 3 / resolution;
    for (let i = 0; i < mesh.positions.length; i += 3)
      assert.ok(Math.abs(Math.hypot(...mesh.positions.slice(i, i + 3)) - 0.8) <= (h * h) / 0.8);
  }
  const model = {
    type: 'difference',
    a: { type: 'box', halfSize: [0.8, 0.8, 0.8] },
    b: { type: 'sphere', radius: 0.5 },
  };
  const a = modeler.mesh(model, { resolution: 25 }),
    b = modeler.mesh(model, { resolution: 25 });
  assert.deepEqual(a, b);
  topology(a);
  const moved = modeler.mesh(
    { type: 'box', center: [9000, -9000, 100], halfSize: [0.7, 0.5, 0.3] },
    {
      bounds: [
        [8999, -9002, 99],
        [9002, -8999, 102],
      ],
      resolution: 19,
    },
  );
  assert.ok(Math.abs(topology(moved) - 8 * 0.7 * 0.5 * 0.3) < 1e-8);
  for (const type of ['union', 'intersection'])
    topology(
      modeler.mesh(
        {
          type,
          a: { type: 'sphere', center: [-0.2, 0, 0], radius: 0.7 },
          b: { type: 'sphere', center: [0.2, 0, 0], radius: 0.7 },
        },
        { resolution: 21 },
      ),
    );
  const empty = modeler.mesh({ type: 'sphere', center: [5, 0, 0], radius: 0.2 });
  assert.equal(empty.positions.length, 0);
  assert.equal(empty.indices.length, 0);
  assert.throws(
    () => modeler.mesh({ type: 'sphere', radius: 100 }),
    (e) => e.code === 'failed' && /boundary/.test(e.message),
  );
  assert.ok(modeler.mesh().positions.length > 0);
});

test('hostile SDF inputs, pre-abort, cycles, bounds and owned outputs after disposal', async () => {
  const modeler = await createSdfModeler();
  const shape = { type: 'box', halfSize: [0.7, 0.7, 0.7] };
  const bad = (e) => e.code === 'failed' && e.message.includes('https://margoengine.com/errors#procedural');
  for (const resolution of [0, 3, 65, 1e99, NaN, Infinity, 4.5])
    assert.throws(() => modeler.mesh(shape, { resolution }), bad);
  for (const s of [
    null,
    {},
    { type: 'sphere', radius: 0 },
    { type: 'sphere', radius: NaN },
    { type: 'sphere', radius: Infinity },
    { type: 'box', halfSize: [] },
    { type: 'box', halfSize: [-1, 1, 1] },
    { type: 'box', halfSize: [1, 1, 1], center: [NaN, 0, 0] },
  ])
    assert.throws(() => modeler.mesh(s), bad);
  for (const bounds of [
    [],
    [
      [0, 0, 0],
      [0, 1, 1],
    ],
    [
      [0, 0, 0],
      [Infinity, 1, 1],
    ],
    [
      [0, 0, 0],
      [1e-9, 1, 1],
    ],
  ])
    assert.throws(() => modeler.mesh(shape, { bounds }), bad);
  const cycle = { type: 'union', a: shape };
  cycle.b = cycle;
  assert.throws(() => modeler.mesh(cycle), bad);
  const controller = new AbortController();
  const reason = new Error('stop');
  controller.abort(reason);
  assert.throws(
    () => modeler.mesh(shape, { signal: controller.signal }),
    (e) => e === reason,
  );
  await assert.rejects(createSdfModeler({ signal: controller.signal }), (e) => e === reason);
  const first = modeler.mesh(shape),
    saved = first.positions.slice();
  modeler.mesh({ type: 'sphere', radius: 0.8 });
  assert.deepEqual(first.positions, saved);
  modeler.dispose();
  modeler[Symbol.dispose]();
  assert.deepEqual(first.positions, saved);
  assert.throws(
    () => modeler.mesh(),
    (e) => e.code === 'disposed',
  );
});
