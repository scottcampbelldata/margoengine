import test from 'node:test';
import assert from 'node:assert/strict';
import { Engine } from '../packages/core/dist/engine.js';
import { TransformStore } from '../packages/core/dist/kernel.js';
import { box } from '../packages/core/dist/geometry.js';

test('ordinary frames reuse static instances and upload only a moved matrix', async () => {
  const uploads = [],
    canvas = { width: 200, height: 100, clientWidth: 200, clientHeight: 100, getContext() {} };
  const renderer = {
    backend: 'webgl2',
    add() {},
    remove() {},
    dispose() {},
    render(_camera, _lighting, batches) {
      let floats = 0;
      for (const batch of batches) {
        floats += Math.max(0, batch.end - batch.start);
        batch.start = Infinity;
        batch.end = 0;
      }
      uploads.push(floats);
    },
  };
  const engine = new Engine(canvas, await TransformStore.create(8), renderer, undefined, null);
  try {
    const mesh = engine.createMesh().setGeometry(box());
    engine.render({ culling: false });
    engine.render({ culling: false });
    mesh.position.x = 1;
    engine.render({ culling: false });
    assert.deepEqual(uploads, [24, 0, 16]);
  } finally {
    engine.dispose();
  }
});
