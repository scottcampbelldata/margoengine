import test from 'node:test';
import assert from 'node:assert/strict';
import { Geometry, box, Engine, TransformStore } from '../dist/extension.js';

test('empty Geometry has finite zero bounds and rejects every partial empty input', () => {
  const g = new Geometry([], [], []);
  assert.deepEqual([...g.bounds], [0, 0, 0, 0]);
  assert.equal(g.vertices.length, 0);
  assert.equal(g.indices.length, 0);
  for (const [p, n, i] of [
    [[], [1], []],
    [[], [], [0, 0, 0]],
    [[0, 0, 0], [0, 0, 0], []],
    [[0, 0, 0, 1, 0, 0, 0, 1, 0], Array(9).fill(0), []],
  ])
    assert.throws(() => new Geometry(p, n, i));
});

test('empty meshes never allocate renderer storage or draw, across culling, motion, instancing and replacement', async () => {
  const calls = { add: 0, remove: 0, drawn: 0, batches: 0 };
  using e = new Engine({ width: 32, height: 32 }, await TransformStore.create(16), {
    backend: 'webgl2',
    add() {
      calls.add++;
    },
    remove() {
      calls.remove++;
    },
    dispose() {},
    render(_camera, _lighting, batches) {
      for (const b of batches) {
        calls.batches++;
        calls.drawn += b.count;
      }
    },
  });
  const empty = new Geometry([], [], []),
    a = e.createMesh().setGeometry(empty),
    b = e.createMesh().setGeometry(empty);
  assert.equal(calls.add, 0);
  assert.equal(e.geometryBuffers(empty), null);
  for (const culling of [true, false, true, false]) {
    a.position.z = -5;
    a.visible = !a.visible;
    e.render({ culling });
    b.position.x += 1;
  }
  assert.equal(calls.drawn, 0);
  assert.equal(calls.batches, 0);
  a.setGeometry(box());
  assert.equal(calls.add, 1);
  a.setGeometry(empty);
  assert.equal(calls.remove, 1);
  e.render({ culling: false });
  assert.equal(calls.batches, 0);
  a.dispose();
  b.dispose();
  assert.equal(calls.remove, 1);
});
