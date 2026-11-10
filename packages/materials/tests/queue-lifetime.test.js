// The material draw queue leaves its scene with the scene's last material mesh (docs/integration-fixtures.md).
import assert from 'node:assert/strict';
import test from 'node:test';
import { Material, createMesh } from '../dist/index.js';
import { sceneOwnerEngine } from '../../../tests/support/scene-owner-engine.js';

const quad = () => ({
  positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
  normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
  indices: new Uint32Array([0, 1, 2]),
});
const queues = (scene) => [...scene.plugins.keys()].filter((n) => /^materials:\d+$/.test(n));

test('the last material mesh disposed removes the scene draw queue and its pass; a new mesh makes a new queue', async () => {
  const { engine } = await sceneOwnerEngine('unused');
  try {
    const a = createMesh(engine, quad(), new Material({ color: [1, 0, 0] })),
      b = createMesh(engine, quad(), new Material({ color: [0, 1, 0], opacity: 0.5, transparent: true }));
    assert.equal(queues(engine.scene).length, 1, 'one queue draws every material mesh of the scene');
    a.destroy();
    assert.equal(queues(engine.scene).length, 1, 'the queue stays while a mesh uses it');
    b.destroy();
    assert.deepEqual(queues(engine.scene), [], 'the queue leaves with the last mesh');
    const c = createMesh(engine, quad(), new Material({ color: [0, 0, 1] }));
    assert.equal(queues(engine.scene).length, 1);
    c.destroy();
    assert.deepEqual(queues(engine.scene), []);
  } finally {
    engine.dispose();
  }
});
