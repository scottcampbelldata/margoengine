import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { MeshPathTracer, triangleMeshes } from '../dist/mesh.js';
import { ComposedVoxelPathTracer } from '../dist/compose.js';
import { fakeEngine, simpleScene } from './support.js';
const identity = () => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const scene = () => ({
  ...simpleScene(),
  meshes: [
    {
      id: 'shared',
      material: 1,
      positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
      indices: new Uint32Array([0, 0, 0, 0, 1, 2]),
      normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
      uvs: new Float32Array([0, 0, 1, 0, 0, 1]),
    },
  ],
  meshInstances: [
    { id: 'left', mesh: 'shared' },
    { id: 'right', mesh: 'shared', transform: identity() },
  ],
});
function packet(h) {
  const w = h.device.buffers.map((b) => new Uint32Array(b.data)).find((w) => w[2] > 0 && w[w[2] + 9] === 0x4d494e53);
  assert.ok(w, 'two-level geometry uploaded');
  return w.slice(w[2]);
}
function blas(w) {
  const at = w[w[5] + 24];
  return w.slice(at);
}

test('explicit instances share one immutable BLAS and transform-only updates build no triangles', async () => {
  const sharedFeature = triangleMeshes();
  for (const create of [
    (e, s) => MeshPathTracer.create(e, { scene: s }),
    (e, s) => ComposedVoxelPathTracer.create(e, { scene: s, features: [sharedFeature] }),
    (e, s) => ComposedVoxelPathTracer.create(e, { scene: s, features: [sharedFeature] }),
  ]) {
    const h = fakeEngine(),
      s = scene(),
      pending = create(h.engine, s);
    s.meshes[0].positions.fill(NaN);
    s.meshInstances[1].transform.fill(NaN);
    const t = await pending;
    try {
      await t.ready;
      h.frame();
      assert.equal(t.stats.meshTriangles, 1);
      assert.equal(t.stats.meshInstances, 2);
      assert.equal(t.stats.builtMeshBlases, 1);
      assert.equal(t.stats.reusedMeshBlases, 0);
      assert.equal(t.stats.skippedDegenerateTriangles, 1);
      let words = packet(h),
        before = blas(words);
      const a = words[5],
        b = a + 32;
      assert.equal(words[a + 24], words[b + 24], 'both placements point to the same BLAS');
      assert.deepEqual([words[a + 25], words[b + 25]], [0, 2], 'AOV bases retain skipped input faces');
      const moved = scene();
      moved.revision = 2;
      moved.meshInstances[1].transform[12] = 7;
      await t.setScene(moved);
      h.frame();
      assert.equal(t.stats.builtMeshBlases, 0);
      assert.equal(t.stats.reusedMeshBlases, 1);
      assert.deepEqual(blas(packet(h)), before, 'matrix-only update preserves exact BLAS bytes');
      const changed = scene();
      changed.revision = 2; // Geometry invalidation does not trust scene revision.
      changed.meshes[0].positions[3] = 2;
      await t.setScene(changed);
      h.frame();
      assert.equal(t.stats.builtMeshBlases, 1);
      assert.equal(t.stats.reusedMeshBlases, 0);
      words = packet(h);
      assert.notDeepEqual(blas(words), before);
      assert.equal(words[words[5] + 24], words[words[5] + 56], 'geometry invalidation replaces every reference');
      const latest = structuredClone(changed);
      for (const edit of [
        (s) => (s.meshes[0].normals[0] = 0.25),
        (s) => (s.meshes[0].uvs[0] = 0.25),
        (s) => s.meshes[0].indices.set([0, 2, 1], 3),
        (s) => {
          s.materials.push({ ...s.materials[0], id: 2 });
          s.meshes[0].material = 2;
        },
      ]) {
        edit(latest);
        await t.setScene(latest);
        assert.equal(
          t.stats.builtMeshBlases,
          1,
          'every attribute/index/palette-id mutation invalidates its shared BLAS',
        );
        assert.equal(t.stats.reusedMeshBlases, 0);
        assert.equal(t.stats.sceneRevision, 2, 'no revision hint is required');
      }
      const replacement = fakeEngine();
      h.engine.gpu = replacement.device;
      h.frame();
      await t.ready;
      replacement.frame();
      assert.equal(t.stats.meshInstances, 2);
      const bytes = t.stats.gpuBytes,
        revision = t.stats.sceneRevision;
      const bad = scene();
      bad.meshInstances[0].transform = identity();
      bad.meshInstances[0].transform[0] = 0;
      await assert.rejects(t.setScene(bad), /affine/);
      assert.equal(t.stats.gpuBytes, bytes);
      assert.equal(t.stats.sceneRevision, revision);
      const queued = scene();
      queued.revision = 4;
      const update = t.setScene(queued);
      queued.meshes[0].positions.fill(NaN);
      await update;
      assert.equal(t.stats.sceneRevision, 4);
      const pending = t.setScene(scene());
      t.dispose();
      await assert.rejects(pending, { code: 'disposed' });
    } finally {
      t.dispose();
    }
  }
});

test('invalid instance scenes fail before allocation and material cache hits are revalidated', async () => {
  for (const edit of [
    (s) => s.meshInstances.push(s.meshInstances[0]),
    (s) => (s.meshInstances[0].id = ''),
    (s) => (s.meshInstances[0].mesh = 'missing'),
    (s) => (s.meshInstances[0].transform = []),
    ...[NaN, Infinity, 1e9].map((v) => (s) => {
      s.meshInstances[0].transform = identity();
      s.meshInstances[0].transform[12] = v;
    }),
    ...[
      [0, 0],
      [3, 0.1],
      [15, 0],
      [0, 1e-20],
      [12, 1e8],
    ].map(([at, v]) => (s) => {
      s.meshInstances[0].transform = identity();
      s.meshInstances[0].transform[at] = v;
    }),
  ]) {
    const h = fakeEngine(),
      s = scene();
    edit(s);
    await assert.rejects(MeshPathTracer.create(h.engine, { scene: s }));
    assert.equal(h.device.buffers.length, 0);
  }
  const h = fakeEngine(),
    t = await MeshPathTracer.create(h.engine, { scene: scene() });
  try {
    const s = scene();
    s.materials[0].type = 'media';
    await assert.rejects(t.setScene(s), /surface materials/);
    assert.equal(t.stats.sceneRevision, 1);
    const empty = scene();
    empty.revision = 2;
    empty.meshInstances = [];
    await t.setScene(empty);
    assert.equal(t.stats.meshInstances, 0);
    assert.equal(t.stats.reusedMeshBlases, 1);
  } finally {
    t.dispose();
  }
});

// Exercise the actual SIMD build, including non-vector tail words.
test('exact SIMD cache comparisons reject every changed lane and tail', async () => {
  const {
    instance: { exports: k },
  } = await WebAssembly.instantiate(await readFile(new URL('../src/mesh.wasm', import.meta.url)));
  for (let n = 0; n < 19; n++) {
    const a = Uint32Array.from({ length: n * 2 }, (_, i) => i % n),
      p = k.allocate(a.length);
    try {
      new Uint32Array(k.memory.buffer, p, a.length).set(a);
      assert.equal(k.equal_words(p, a.length), 1);
      for (let i = 0; i < n; i++) {
        const w = new Uint32Array(k.memory.buffer, p, a.length);
        w[n + i] ^= 0x80000000;
        assert.equal(k.equal_words(p, a.length), 0, `length ${n}, word ${i}`);
        w[n + i] ^= 0x80000000;
      }
    } finally {
      k.release(p, a.length);
    }
  }
});

test('empty and fully degenerate definitions still reject invalid placement transforms', async () => {
  for (const indices of [new Uint32Array(), new Uint32Array([0, 0, 0])])
    for (const at of [0, 3, 15]) {
      const h = fakeEngine(),
        s = scene();
      s.meshes[0].indices = indices;
      s.meshInstances[0].transform = identity();
      s.meshInstances[0].transform[at] = at === 3 ? 1e-100 : 0;
      await assert.rejects(MeshPathTracer.create(h.engine, { scene: s }));
      assert.equal(h.device.buffers.length, 0);
    }
});
