import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MToon } from '../dist/mtoon.js';
import { Engine, TransformStore } from '../../core/dist/extension.js';
import { parseGLTF } from '../../gltf-pro/dist/index.js';
import { animatedTriangle } from '../../../tests/support/gltf-pro-fixture.js';
import { optionalGPU } from '../../../tests/support/optional-gpu.js';
async function fixture(definitions = [{ specVersion: '1.0' }], modes = definitions.map(() => 'OPAQUE'), image) {
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
  if (image) {
    data.doc.images = [{}];
    data.doc.textures = [{ source: 0 }];
  }
  const model = parseGLTF(engine, data.doc, data.buffers, image ? [image] : []);
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
test('MToon uploads retained Node texture pixels without a browser image source', async () => {
  const image = { width: 2, height: 2, data: new Uint8Array(16).fill(127) };
  const f = await fixture([{ specVersion: '1.0', shadeMultiplyTexture: { index: 0 } }], ['OPAQUE'], image);
  const writes = [],
    device = f.engine.gpu;
  const write = device.queue.writeTexture;
  device.queue.writeTexture = (to, bytes, layout, size) => {
    writes.push({ bytes, layout, size });
    write(to, bytes, layout, size);
  };
  try {
    MToon.attach(f.model);
    f.frame();
    assert.ok(writes.some((w) => w.bytes === image.data && w.layout.bytesPerRow === 8));
  } finally {
    f.engine.dispose();
  }
});
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
test('blended MToon queues draw across models by renderQueueOffsetNumber, then in model order (KB5289a)', async () => {
  const gpu = optionalGPU(),
    store = await TransformStore.create(32),
    engine = new Engine(
      { width: 128, height: 96, clientWidth: 128, clientHeight: 96 },
      store,
      { backend: 'webgpu', gpu: gpu.engine.gpu, add() {}, remove() {}, render() {}, dispose() {} },
      { position: [0, 0, 4], target: [0, 0, 0] },
      null,
    );
  const load = (offsets) => {
    const data = animatedTriangle(),
      primitive = data.doc.meshes[0].primitives[0];
    delete data.doc.skins;
    delete data.doc.animations;
    delete data.doc.nodes[0].skin;
    data.doc.materials = offsets.map((renderQueueOffsetNumber) => ({
      alphaMode: renderQueueOffsetNumber === undefined ? 'OPAQUE' : 'BLEND',
      pbrMetallicRoughness: { baseColorFactor: [0.2, 0.5, 0.8, 0.5] },
      extensions: { VRMC_materials_mtoon: { specVersion: '1.0', renderQueueOffsetNumber: renderQueueOffsetNumber ?? 0 } },
    }));
    data.doc.meshes[0].primitives = offsets.map((_, material) => ({ ...primitive, material }));
    return parseGLTF(engine, data.doc, data.buffers, []);
  };
  // Scene order A, B; queues A0 2991, A1 3000, B0 2995. Unity and UniVRM draw 2991, 2995, 3000.
  const a = load([-9, 0]),
    b = load([-5]),
    still = load([undefined]);
  engine.camera.update(128 / 96, true);
  store.tick(false);
  const effects = [MToon.attach(a), MToon.attach(b), MToon.attach(still)],
    labels = new Map(),
    stack = [],
    drawn = [];
  for (const [name, model] of [
    ['A', a],
    ['B', b],
    ['S', still],
  ]) {
    model.primitives.forEach((p, i) => labels.set(p.material, name + i));
    const draw = model.draw;
    model.draw = function (...args) {
      stack.push(model);
      try {
        return draw.apply(this, args);
      } finally {
        stack.pop();
      }
    };
  }
  const context = { ...gpu.context, camera: engine.camera, draw() {} },
    begin = context.encoder.beginRenderPass;
  context.encoder.beginRenderPass = (...args) => {
    const pass = begin(...args);
    let pipeline;
    return {
      ...pass,
      setPipeline(value) {
        pipeline = value;
      },
      drawIndexed() {
        if (/@fragment fn fragment\([^{]*\{\s*discard;/.test(pipeline.fragment.module.code)) return;
        const model = stack[stack.length - 1];
        drawn.push(...model.primitives.map((p) => labels.get(p.material)).filter(Boolean));
      },
    };
  };
  try {
    // An opaque-only avatar adds no passes, so its models keep one render pass run.
    let added = 0;
    effects[2].registerPasses({ add: () => added++ });
    assert.equal(added, 0);
    engine.frameGraph.execute(context);
    // The opaque avatar draws in the models' pass; the blended queues follow in queue order across models.
    assert.deepEqual(drawn, ['S0', 'A0', 'B0', 'A1']);
    // A draw outside a scene frame (a probe, an imposter) still draws every queue of its model inline.
    drawn.length = 0;
    a.draw(context, 'beauty', context.color, context.depth);
    assert.deepEqual(drawn, ['A0', 'A1']);
    // The next frame draws the same order (nothing from the earlier frame is left behind).
    drawn.length = 0;
    engine.frameGraph.execute(context);
    assert.deepEqual(drawn, ['S0', 'A0', 'B0', 'A1']);
  } finally {
    for (const effect of effects) effect.dispose();
    engine.dispose();
  }
});
