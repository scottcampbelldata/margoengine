import test from 'node:test';
import assert from 'node:assert/strict';
import { Engine, TransformStore } from '../../core/dist/extension.js';
import { PBRDrawRun, parseGLTF } from '../dist/index.js';
import { setMaterialDraw } from '../dist/material-draw.js';
import { animatedTriangle } from '../../../tests/support/gltf-pro-fixture.js';
import { optionalGPU } from '../../../tests/support/optional-gpu.js';

test('each material adapter draw encodes its deferred batch before temporary records are restored', async () => {
  const h = optionalGPU(),
    store = await TransformStore.create(16),
    engine = new Engine(
      { width: 128, height: 96, clientWidth: 128, clientHeight: 96 },
      store,
      { backend: 'webgpu', gpu: h.engine.gpu, add() {}, remove() {}, render() {}, dispose() {} },
      { position: [0, 0, 4], target: [0, 0, 0] },
      null,
    ),
    data = animatedTriangle();
  delete data.doc.skins;
  delete data.doc.animations;
  delete data.doc.nodes[0].skin;
  const model = parseGLTF(engine, data.doc, data.buffers),
    original = model.primitives[0].material,
    seen = [],
    run = new PBRDrawRun();
  engine.camera.update(4 / 3, true);
  store.tick(false);
  const remove = setMaterialDraw(model, (call) => {
    try {
      for (const layer of ['body', 'outline']) {
        model.primitives[0].material = {
          ...original,
          shading: {
            shader: (code) => code,
            bindings() {
              seen.push(layer);
              return [];
            },
          },
        };
        call.draw();
        assert.equal(seen.at(-1), layer, 'bindings read within their synchronous adapter draw');
      }
    } finally {
      model.primitives[0].material = original;
    }
  });
  try {
    const c = { ...h.context, camera: engine.camera };
    model.draw(c, 'beauty', c.color, c.depth, 'all', undefined, run);
    run.end();
    assert.deepEqual(seen, ['body', 'outline']);
    assert.equal(model.primitives[0].material, original);
  } finally {
    run.end();
    remove();
    engine.dispose();
  }
});
