import test from 'node:test';
import assert from 'node:assert/strict';
import { Engine, TransformStore, box } from '../../core/dist/extension.js';
import { assembleWFC } from '../dist/assemble.js';
import { buildSocketTiles } from '../dist/sockets.js';
async function engine() {
  return new Engine({ width: 32, height: 32 }, await TransformStore.create(32), {
    backend: 'webgl2',
    add() {},
    remove() {},
    dispose() {},
    render() {},
  });
}
test('assembly preserves hierarchy and batches shared geometry across every cube rotation and reflection', async () => {
  using e = await engine();
  const root = e.createMesh(),
    node = e.createMesh(root).setPosition([0.2, 0.3, 0.4]).setRotation([0.1, 0.2, 0.3]),
    primitive = e.createMesh(node).setGeometry(box());
  root.visible = false;
  const variants = buildSocketTiles([{ sockets: Array(6).fill('a'), rotations: 'cube' }]);
  variants.push({ source: 0, rotation: [-1, 0, 0, 0, 1, 0, 0, 0, 1] });
  using assembly = assembleWFC(
    e,
    [25, 1, 1],
    Uint8Array.from({ length: 25 }, (_, i) => i),
    variants,
    [{ root, meshes: [primitive] }],
    { spacing: [2, 1, 1], origin: [-2, 0, 0] },
  );
  assert.equal(assembly.cells.length, 25);
  assert.equal(assembly.meshes.length, 75);
  e.render({ culling: false });
  for (let i = 0; i < 25; i++) {
    const cell = assembly.cells[i],
      r = variants[i].rotation;
    for (let c = 0; c < 3; c++)
      for (let row = 0; row < 3; row++) assert.ok(Math.abs(cell.matrix[c * 4 + row] - r[c * 3 + row]) < 1e-6);
    assert.equal(cell.position.x, i * 2 - 2);
    const p = assembly.meshes[i * 3 + 2];
    assert.equal(p.geometry, primitive.geometry);
    assert.equal(p.material, primitive.material);
    assert.equal(assembly.meshes[i * 3].visible, false);
  }
  const count = e.meshes.size;
  assembly.dispose();
  assembly.dispose();
  assert.equal(e.meshes.size, count - 101);
  primitive.check();
});
test('assembly validates before mutation, rolls back failures and preserves exact abort reason', async () => {
  using e = await engine();
  const root = e.createMesh(),
    mesh = e.createMesh(root).setGeometry(box()),
    models = [{ root, meshes: [mesh] }],
    v = [{ source: 0, rotation: [1, 0, 0, 0, 1, 0, 0, 0, 1] }],
    before = e.meshes.size;
  for (const [dims, grid, variants, options] of [
    [[2, 1, 1], [0], v, {}],
    [[1, 1, 1], [1], v, {}],
    [[1, 1, 1], [0], [{ source: 0, rotation: Array(9).fill(1) }], {}],
    [[1, 1, 1], [0], v, { origin: [NaN, 0, 0] }],
    [[2, 1, 1], [0, 0], v, { spacing: [3e38, 1, 1], origin: [3e38, 0, 0] }],
  ])
    assert.throws(() => assembleWFC(e, dims, grid, variants, models, options));
  assert.equal(e.meshes.size, before);
  const c = new AbortController();
  c.abort('stop');
  assert.throws(
    () => assembleWFC(e, [1, 1, 1], [0], v, models, { signal: c.signal }),
    (e) => e === 'stop',
  );
});
test('assembly copies each node quaternion, not its Float32 Euler lanes, so poses near pitch 90 degrees keep their bits', async () => {
  using e = await engine();
  const t = e.store.transforms,
    mul = (a, b) => [
      a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
      a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
      a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
      a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
    ];
  let worst = 0;
  // q = Rx(x) Ry(p) Rz(z) with the pitch 1e-1 to 1e-9 radians short of 90 degrees: the Euler lanes lost up to 1.4e-6.
  for (let k = 0; k < 400; k++) {
    const p = Math.PI / 2 - 10 ** (-1 - k / 50),
      x = 0.3 + k * 0.01,
      z = 0.7 - k * 0.003,
      q = mul(mul([Math.sin(x / 2), 0, 0, Math.cos(x / 2)], [0, Math.sin(p / 2), 0, Math.cos(p / 2)]), [
        0,
        0,
        Math.sin(z / 2),
        Math.cos(z / 2),
      ]),
      root = e.createMesh(),
      node = e.createMesh(root).setQuaternion(q).setGeometry(box());
    using a = assembleWFC(
      e,
      [1, 1, 1],
      [0],
      [{ source: 0, rotation: [1, 0, 0, 0, 1, 0, 0, 0, 1] }],
      [{ root, meshes: [node] }],
    );
    const copy = a.meshes[1];
    for (const lane of ['qx', 'qy', 'qz', 'qw']) worst = Math.max(worst, Math.abs(t[lane][copy.id] - t[lane][node.id]));
    node.dispose();
    root.dispose();
  }
  // Two float32 steps at 1: setQuaternion normalises again in float64.
  assert.ok(worst <= 1.2e-7, `largest quaternion lane difference ${worst}`);
});
