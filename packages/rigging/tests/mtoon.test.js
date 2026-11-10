import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MToon } from '../dist/mtoon.js';
import { Engine, TransformStore } from '../../core/dist/extension.js';
import { parseGLTF } from '../../gltf-pro/dist/index.js';
import { animatedTriangle } from '../../../tests/support/gltf-pro-fixture.js';
import { optionalGPU } from '../../../tests/support/optional-gpu.js';
async function fixture(definitions = [{ specVersion: '1.0' }], modes = definitions.map(() => 'OPAQUE')) {
  const gpu = optionalGPU(),
    store = await TransformStore.create(32),
    engine = new Engine(
      { width: 128, height: 96, clientWidth: 128, clientHeight: 96 },
      store,
      { backend: 'webgpu', gpu: gpu.engine.gpu, add() {}, remove() {}, render() {}, dispose() {} },
      { position: [0, 0, 4], target: [0, 0, 0] },
      null,
    );
  const data = animatedTriangle(),
    primitive = data.doc.meshes[0].primitives[0];
  delete data.doc.skins;
  delete data.doc.animations;
  delete data.doc.nodes[0].skin;
  data.doc.materials = definitions.map((extension, i) => ({
    alphaMode: modes[i],
    pbrMetallicRoughness: { baseColorFactor: [0.2, 0.5, 0.8, 1] },
    extensions: { VRMC_materials_mtoon: extension },
  }));
  data.doc.meshes[0].primitives = definitions.map((_, material) => ({ ...primitive, material }));
  const model = parseGLTF(engine, data.doc, data.buffers);
  engine.camera.update(128 / 96, true);
  store.tick(false);
  const context = { ...gpu.context, camera: engine.camera };
  return {
    gpu,
    engine,
    model,
    frame() {
      model.draw(context, 'beauty', context.color, context.depth);
    },
  };
}
test('MToon belongs to the model scene and disposal restores author records without disposing the model', async () => {
  const f = await fixture(),
    original = f.model.primitives.map((p) => p.material),
    before = f.gpu.resources.length,
    effect = MToon.attach(f.model);
  try {
    assert.equal(f.engine.sceneOf(effect), f.engine.sceneOf(f.model));
    assert.equal(effect.materials.size, 1);
    assert.throws(() => {
      effect.disposed = true;
    }, TypeError);
    f.frame();
    const textures = f.gpu.resources.slice(before).filter((r) => typeof r.createView === 'function');
    assert.ok(textures.length > 0);
    effect[Symbol.dispose]();
    await Promise.resolve();
    assert.equal(effect.disposed, true);
    assert.equal(f.model.disposed, false);
    assert.deepEqual(
      f.model.primitives.map((p) => p.material),
      original,
    );
    assert.equal(f.engine.sceneOf(effect), undefined);
    assert.ok(textures.every((t) => t.destroyed));
    f.frame();
  } finally {
    effect.dispose();
    f.engine.dispose();
  }
});
test('model-first disposal takes its MToon adapter and GPU resources with it', async () => {
  const f = await fixture(),
    effect = MToon.attach(f.model);
  try {
    f.frame();
    f.model.dispose();
    assert.equal(effect.disposed, true);
    assert.equal(f.engine.sceneOf(effect), undefined);
    effect.dispose();
  } finally {
    f.engine.dispose();
  }
});

for (const [mode, outline] of [
  ['OPAQUE', false],
  ['MASK', true],
  ['BLEND', true],
])
  test(`mixed MToon and ${mode} materials each reach the beauty pass exactly once (outline ${outline})`, async () => {
    const f = await fixture(
        [
          {
            specVersion: '1.0',
            outlineWidthMode: outline ? 'worldCoordinates' : 'none',
            outlineWidthFactor: outline ? 0.01 : 0,
          },
          undefined,
        ],
        ['OPAQUE', mode],
      ),
      original = f.model.primitives.map((p) => p.material),
      effect = MToon.attach(f.model),
      selected = f.model.primitives.map((p) => p.material),
      draws = [];
    const begin = f.gpu.context.encoder.beginRenderPass;
    f.gpu.context.encoder.beginRenderPass = (...args) => {
      const pass = begin(...args);
      let pipeline;
      return {
        ...pass,
        setPipeline(value) {
          pipeline = value;
        },
        drawIndexed() {
          draws.push(pipeline.fragment.module.code);
        },
      };
    };
    try {
      f.frame();
      const visible = draws.filter((code) => !/@fragment fn fragment\([^{]*\{\s*discard;/.test(code));
      assert.equal(visible.length, outline ? 3 : 2, 'each body and enabled outline must draw once');
      assert.deepEqual(
        f.model.primitives.map((p) => p.material),
        selected,
      );
      effect.dispose();
      assert.deepEqual(
        f.model.primitives.map((p) => p.material),
        original,
      );
    } finally {
      effect.dispose();
      f.engine.dispose();
    }
  });
test('all material validation completes before earlier records or scene ownership change', async () => {
  const f = await fixture([{ specVersion: '1.0' }, { specVersion: '1.0', outlineWidthFactor: -1 }]),
    original = f.model.primitives.map((p) => p.material);
  try {
    assert.throws(() => MToon.attach(f.model), RangeError);
    assert.deepEqual(
      f.model.primitives.map((p) => p.material),
      original,
    );
  } finally {
    f.engine.dispose();
  }
});
test('authored queue offsets respect opaque, mask and both blend ranges', async () => {
  for (const [mode, writing, offset] of [
    ['OPAQUE', false, 1],
    ['MASK', false, -1],
    ['BLEND', false, 1],
    ['BLEND', true, -1],
  ]) {
    const f = await fixture(
      [{ specVersion: '1.0', transparentWithZWrite: writing, renderQueueOffsetNumber: offset }],
      [mode],
    );
    try {
      assert.throws(() => MToon.attach(f.model), RangeError);
    } finally {
      f.engine.dispose();
    }
  }
});
