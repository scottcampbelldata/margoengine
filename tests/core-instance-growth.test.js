import test from 'node:test';
import assert from 'node:assert/strict';
import { Engine } from '../packages/core/dist/engine.js';
import { TransformStore } from '../packages/core/dist/kernel.js';
import { box } from '../packages/core/dist/index.js';

test('instance storage grows with the meshes using a geometry, not with engine capacity', async () => {
  const calls = [],
    renderer = {
      backend: 'webgpu',
      add(geometry, capacity) {
        calls.push(['add', capacity]);
      },
      remove() {
        calls.push(['remove']);
      },
      render() {},
      dispose() {},
    };
  const canvas = { width: 1, height: 1, clientWidth: 4, clientHeight: 4 },
    engine = new Engine(canvas, await TransformStore.create(100000), renderer, undefined, null);
  try {
    const geometry = box(1, 1, 1),
      meshes = [];
    for (let i = 0; i < 5; i++) meshes.push(engine.createMesh().setGeometry(geometry));
    // 1 mesh -> room for 2, 3 -> 6: two allocations instead of one 100,000-instance buffer.
    assert.deepEqual(calls, [['remove'], ['add', 2], ['remove'], ['add', 6]]);
    engine.render();
    assert.equal(engine.stats.visible, 5);
    for (const mesh of meshes) mesh.dispose();
    assert.deepEqual(calls.at(-1), ['remove'], 'the last release frees the geometry');
  } finally {
    engine.dispose();
  }
});
