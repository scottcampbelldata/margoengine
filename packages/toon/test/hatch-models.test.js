import test from 'node:test';
import assert from 'node:assert/strict';
import { ModelHatching } from '../dist/hatch-models.js';
import { Engine, TransformStore } from '../../core/dist/extension.js';
import { parseGLTF } from '../../gltf-pro/dist/index.js';
import { Material, createMesh } from '../../materials/dist/index.js';
import { boxGeometry } from '../../geometry/dist/index.js';
import { animatedTriangle } from '../../../tests/support/gltf-pro-fixture.js';
import { optionalGPU } from '../../../tests/support/optional-gpu.js';

async function fixture(materials = false) {
  const gpu = optionalGPU(),
    store = await TransformStore.create(32),
    engine = new Engine(
      { width: 128, height: 96, clientWidth: 128, clientHeight: 96 },
      store,
      { backend: 'webgpu', gpu: gpu.engine.gpu, add() {}, remove() {}, render() {}, dispose() {} },
      { position: [0, 0, 4], target: [0, 0, 0] },
      null,
    );
  const data = animatedTriangle();
  delete data.doc.skins;
  delete data.doc.animations;
  delete data.doc.nodes[0].skin;
  const material = new Material({ color: '#ffffff' });
  const model = materials ? createMesh(engine, boxGeometry(), material) : parseGLTF(engine, data.doc, data.buffers);
  engine.camera.update(128 / 96, true);
  store.tick(false);
  const context = { ...gpu.context, camera: engine.camera };
  return {
    gpu,
    engine,
    model,
    material,
    frame(mode = 'beauty') {
      model.draw(context, mode, context.color, context.depth);
    },
  };
}

for (const materials of [false, true])
  test(`hatching ${materials ? 'materials mesh' : 'glTF'} owns its uniform, restores exact records and keeps live edits`, async () => {
    const f = await fixture(materials),
      original = f.model.primitives[0].material,
      effect = ModelHatching.attach(f.model, { spacing: 16, width: 4, angle: 10 });
    try {
      f.frame();
      assert.equal(f.model.primitives[0].material, original);
      const uniform = f.gpu.bufferWrites.find((w) => w.bytes === 48);
      assert.ok(uniform);
      assert.deepEqual([...new Float32Array(uniform.buffer.data)].slice(0, 4), [0, 16, 4, 3]);
      effect.style = 'halftone';
      effect.spacing = 12;
      f.material.color.set('#ff0000');
      f.frame();
      assert.deepEqual([...new Float32Array(uniform.buffer.data)].slice(0, 4), [1, 12, 4, 3]);
      if (materials) assert.equal(original.base[0], 1);
      assert.throws(() => effect.set({ layers: 0 }), RangeError);
      assert.equal(effect.layers, 3);
      assert.throws(() => ModelHatching.attach(f.model), /adapter/);
      effect.dispose();
      assert.ok(uniform.buffer.destroyed);
      assert.equal(f.model.disposed, false);
      assert.equal(f.model.primitives[0].material, original);
      f.frame();
      const next = ModelHatching.attach(f.model);
      f.frame();
      f.model.dispose();
      assert.equal(next.disposed, true);
    } finally {
      effect.dispose();
      f.engine.dispose();
    }
  });

test('a failed model draw restores every borrowed record', async () => {
  const f = await fixture(),
    original = f.model.primitives[0].material,
    effect = ModelHatching.attach(f.model);
  f.gpu.engine.gpu.createShaderModule = () => {
    throw new Error('injected compiler failure');
  };
  try {
    assert.throws(() => f.frame(), /injected compiler/);
    assert.equal(f.model.primitives[0].material, original);
  } finally {
    effect.dispose();
    f.engine.dispose();
  }
});
