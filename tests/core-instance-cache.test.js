import test from 'node:test';
import assert from 'node:assert/strict';
import { Engine } from '../packages/core/dist/engine.js';
import { TransformStore } from '../packages/core/dist/kernel.js';
import { box, PbrMaterial } from '../packages/core/dist/geometry.js';
import { uploadRows } from '../packages/core/dist/extension.js';

/**
 * A renderer that uploads each batch with core's `uploadRows` into a mirror of its GPU buffer, as the WebGPU renderer
 * does: everything into a buffer not yet written, then only changed rows. `frames` holds per frame the floats and the
 * writeBuffer calls; `mirrors` the buffer contents by geometry.
 */
function mirrorRenderer() {
  const frames = [],
    mirrors = new Map(),
    queue = {
      writeBuffer(buffer, byteOffset, data, start, size) {
        buffer.data.set(data.subarray(start, start + size), byteOffset / 4);
        frames.at(-1).floats += size;
        frames.at(-1).writes++;
      },
    };
  return {
    frames,
    mirrors,
    renderer: {
      backend: 'webgl2',
      add(geometry, capacity) {
        mirrors.set(geometry, { data: new Float32Array(capacity * 24), fresh: true });
      },
      remove(geometry) {
        mirrors.delete(geometry);
      },
      dispose() {},
      render(_camera, _lighting, batches) {
        frames.push({ floats: 0, writes: 0 });
        for (const batch of batches) {
          const mirror = mirrors.get(batch.geometry);
          uploadRows(queue, mirror, batch, mirror.fresh);
          mirror.fresh = false;
        }
      },
    },
  };
}
const canvas = () => ({ width: 200, height: 100, clientWidth: 200, clientHeight: 100, getContext() {} });
const drawn = (batch) => Array.from({ length: batch.count }, (_, i) => batch.instances[i * 24 + 23]);
/** The engine's batch map (its private name is shortened in the build): the Map keyed by geometries. */
const batchMap = (engine) =>
  Object.values(engine).find((value) => value instanceof Map && [...value.keys()].some((key) => key?.indices));
/** Counts calls to `get` on a Map (an own property shadows Map.prototype.get). */
function countGets(map) {
  const counter = { calls: 0 };
  map.get = (key) => {
    counter.calls++;
    return Map.prototype.get.call(map, key);
  };
  return counter;
}

test('ordinary frames reuse static instances and upload only a moved row', async () => {
  const { renderer, frames } = mirrorRenderer(),
    engine = new Engine(canvas(), await TransformStore.create(8), renderer, undefined, null);
  try {
    const mesh = engine.createMesh().setGeometry(box());
    engine.render({ culling: false });
    engine.render({ culling: false });
    mesh.position.x = 1;
    engine.render({ culling: false });
    assert.deepEqual(
      frames.map((f) => f.floats),
      [24, 0, 24],
    );
  } finally {
    engine.dispose();
  }
});

test('a visibility flip moves one row: no full collection and one row uploaded', async () => {
  const { renderer, frames, mirrors } = mirrorRenderer(),
    engine = new Engine(canvas(), await TransformStore.create(8), renderer, undefined, null);
  try {
    const geometry = box(),
      [a, b, c] = [0, 1, 2].map((i) => engine.createMesh().setGeometry(geometry).setPosition([i, 0, 0]));
    engine.render({ culling: false });
    const batch = batchMap(engine).get(geometry),
      collected = engine.collected;
    assert.deepEqual(drawn(batch), [a.id, b.id, c.id]);
    a.visible = false;
    engine.render({ culling: false });
    assert.deepEqual(drawn(batch), [c.id, b.id], 'the last row took the hidden mesh row');
    assert.deepEqual(frames.at(-1), { floats: 24, writes: 1 });
    assert.equal(engine.collected, collected, 'no full collection');
    b.visible = false;
    engine.render({ culling: false });
    assert.deepEqual(drawn(batch), [c.id]);
    assert.deepEqual(frames.at(-1), { floats: 0, writes: 0 }, 'hiding the last row moves nothing');
    a.visible = true;
    engine.render({ culling: false });
    assert.deepEqual(drawn(batch), [c.id, a.id]);
    assert.deepEqual(frames.at(-1), { floats: 24, writes: 1 }, 'a shown mesh takes the next row');
    assert.deepEqual(mirrors.get(geometry).data.subarray(0, 48), batch.instances.subarray(0, 48));
    assert.equal(engine.collected, collected);
  } finally {
    engine.dispose();
  }
});

test('100 flips among 1,000 boxes: 2 map lookups, 24 floats and at most one write each', async () => {
  const { renderer, frames, mirrors } = mirrorRenderer(),
    engine = new Engine(canvas(), await TransformStore.create(1024), renderer, undefined, null);
  try {
    const geometry = box(),
      meshes = Array.from({ length: 1000 }, (_, i) =>
        engine.createMesh().setGeometry(geometry).setPosition([i % 40, Math.floor(i / 40), 0]),
      );
    engine.render({ culling: false });
    assert.equal(frames.at(-1).floats, 24_000);
    // Every tenth mesh, so no two hidden rows are neighbours before the moves. The setters look the mesh up, so the
    // counting starts after them.
    for (let i = 0; i < 100; i++) meshes[i * 10 + 5].visible = false;
    const meshGets = countGets(engine.meshes),
      batchGets = countGets(batchMap(engine));
    engine.render({ culling: false });
    assert.equal(meshGets.calls, 100, 'one mesh lookup a flip');
    assert.equal(batchGets.calls, 100, 'one batch lookup a flip');
    assert.ok(frames.at(-1).floats <= 100 * 24, `${frames.at(-1).floats} floats`);
    assert.ok(frames.at(-1).writes <= 100, `${frames.at(-1).writes} writes`);
    const batch = batchMap(engine).get(geometry);
    assert.equal(batch.count, 900);
    assert.deepEqual(mirrors.get(geometry).data.subarray(0, 900 * 24), batch.instances.subarray(0, 900 * 24));
    for (let i = 0; i < 100; i++) meshes[i * 10 + 5].visible = true;
    meshGets.calls = batchGets.calls = 0;
    engine.render({ culling: false });
    assert.equal(meshGets.calls + batchGets.calls, 200);
    assert.deepEqual(frames.at(-1), { floats: 2400, writes: 1 }, 'shown meshes take rows 900..999: one run');
    assert.deepEqual(new Set(drawn(batch)), new Set(meshes.map((m) => m.id)));
  } finally {
    engine.dispose();
  }
});

test('flips and moves in any order leave the GPU rows equal to the instances, and the drawn set exact', async () => {
  const { renderer, mirrors } = mirrorRenderer(),
    engine = new Engine(canvas(), await TransformStore.create(64), renderer, undefined, null);
  // A fixed sequence from a small linear congruential generator: the test is the same on every run.
  let seed = 7;
  const random = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  try {
    const geometries = [box(), box(2)],
      mirrored = new PbrMaterial({ doubleSided: true }),
      meshes = Array.from({ length: 60 }, (_, i) => engine.createMesh().setGeometry(geometries[i % 2]));
    meshes[3].setMaterial(mirrored);
    meshes[8].receiveShadow = false;
    for (let frame = 0; frame < 200; frame++) {
      for (let k = 0; k < 6; k++) {
        const mesh = meshes[Math.floor(random() * meshes.length)];
        if (random() < 0.5) mesh.visible = !mesh.visible;
        else mesh.setPosition([random() * 10, random() * 10, random() * 10]);
      }
      engine.render({ culling: false });
      for (const geometry of geometries) {
        const batch = batchMap(engine).get(geometry),
          expected = meshes.filter((m) => m.geometry === geometry && m.visible).map((m) => m.id);
        assert.deepEqual(new Set(drawn(batch)), new Set(expected), `frame ${frame}`);
        assert.equal(batch.count, expected.length);
        for (let row = 0; row < batch.count; row++) {
          const mesh = engine.meshes.get(batch.instances[row * 24 + 23]);
          assert.deepEqual(batch.instances.subarray(row * 24, row * 24 + 16), mesh.matrix, `frame ${frame} row ${row}`);
          assert.equal(batch.instances[row * 24 + 22], mesh.material.data[6] + (mesh.receiveShadow ? 0 : 0.25));
        }
        assert.deepEqual(
          mirrors.get(geometry).data.subarray(0, batch.count * 24),
          batch.instances.subarray(0, batch.count * 24),
          `frame ${frame}: GPU rows`,
        );
      }
    }
  } finally {
    engine.dispose();
  }
});

test('uploadRows merges neighbouring rows across words, drops duplicates and stops at count', () => {
  const writes = [],
    queue = { writeBuffer: (_buffer, byteOffset, _data, start, size) => writes.push([byteOffset / 4, start, size]) },
    batch = { instances: new Float32Array(100 * 24), rows: new Uint32Array(4), count: 70, dirty: 0 },
    // As core marks a row: nothing once every row is marked (dirty -1).
    mark = (row) => {
      if (batch.dirty >= 0 && !(batch.rows[row >> 5] & (1 << (row & 31)))) {
        batch.rows[row >> 5] |= 1 << (row & 31);
        batch.dirty++;
      }
    };
  for (const row of [31, 32, 33, 0, 5, 5, 63, 64, 65, 66, 69, 70, 90]) mark(row);
  uploadRows(queue, {}, batch);
  assert.deepEqual(
    writes.map(([offset, start, size]) => [offset / 24, (start + size) / 24]),
    [
      [0, 1],
      [5, 6],
      [31, 34],
      [63, 67],
      [69, 70],
    ],
    'rows 70 and 90 are past count',
  );
  assert.ok(writes.every(([offset, start]) => offset === start));
  assert.deepEqual([...batch.rows], [0, 0, 0, 0], 'the marks are cleared');
  assert.equal(batch.dirty, 0);
  writes.length = 0;
  for (let row = 0; row < 100; row++) mark(row);
  uploadRows(queue, {}, batch);
  assert.deepEqual(writes, [[0, 0, 70 * 24]], 'every row is one write');
  writes.length = 0;
  batch.dirty = -1;
  mark(3);
  uploadRows(queue, {}, batch);
  assert.deepEqual(writes, [[0, 0, 70 * 24]], 'dirty -1 uploads every row');
  writes.length = 0;
  uploadRows(queue, {}, batch);
  assert.deepEqual(writes, [], 'nothing left');
});
