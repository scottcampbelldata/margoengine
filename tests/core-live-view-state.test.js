import test from 'node:test';
import assert from 'node:assert/strict';
import { Engine } from '../packages/core/dist/engine.js';
import { TransformStore } from '../packages/core/dist/kernel.js';
import { box } from '../packages/core/dist/geometry.js';
import { gpuDrawHarness } from './support/core-draw-gpu.js';

test('a layer mask change, or a mask source, re-collects static draws without a transform edit', async (t) => {
  const key = Symbol.for('margoengine.layers'),
    saved = globalThis[key],
    masks = new WeakMap();
  const registry = { cameras: new WeakMap(), source: null, maskOf: (mesh) => masks.get(mesh) ?? 1 };
  globalThis[key] = registry;
  t.after(() => {
    globalThis[key] = saved;
  });
  const counts = [],
    canvas = { width: 100, height: 100, clientWidth: 100, clientHeight: 100 };
  const renderer = {
    backend: 'webgl2',
    add() {},
    remove() {},
    dispose() {},
    render(_camera, _lighting, batches) {
      counts.push([...batches].reduce((sum, batch) => sum + batch.count, 0));
    },
  };
  const engine = new Engine(canvas, await TransformStore.create(4), renderer, undefined, null);
  try {
    const mesh = engine.createMesh().setGeometry(box());
    registry.cameras.set(engine.camera, 1);
    engine.render({ culling: false });
    registry.cameras.set(engine.camera, 2);
    engine.render({ culling: false });
    // A source can change its answer at any time, so masked draws re-collect every frame while one is installed.
    registry.source = () => 2;
    masks.set(mesh, 2);
    engine.render({ culling: false });
    masks.set(mesh, 1);
    engine.render({ culling: false });
    assert.deepEqual(counts, [1, 0, 1, 0]);
  } finally {
    engine.dispose();
  }
});

test('view clear rejects partial hexadecimal parses and accepts the complete documented color', (t) => {
  const h = gpuDrawHarness(t);
  for (const color of [
    '#12zzzz',
    'x123456',
    '#12345g',
    '#12 456',
    '#12345',
    '#1234567',
    '#123456\n',
    '#123456\r',
    '#123456\r\n',
  ]) {
    assert.throws(
      () =>
        h.frame((draw, c) => {
          c.view = {
            id: '0',
            camera: c.camera,
            viewport: [0, 0, c.width, c.height],
            index: 0,
            count: 1,
            clear: { color },
          };
          draw();
        }),
      /color/i,
      color,
    );
  }
  h.frame((draw, c) => {
    c.view = { id: '0', camera: c.camera, viewport: [0, 0, c.width, c.height], index: 0, count: 1 };
    c.view.clear = { color: '#12AbEf' };
    draw();
  });
  assert.deepEqual(h.passes.at(-1).descriptor.colorAttachments[0].clearValue, [18 / 255, 171 / 255, 239 / 255, 1]);
});
