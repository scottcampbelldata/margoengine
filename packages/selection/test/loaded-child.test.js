// Real Khronos asset and loader/selection code; only the GPU and image bitmaps are test doubles.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Engine, TransformStore } from '../../core/dist/extension.js';
import { GLTFAsset, PBRModel } from '../../gltf-pro/dist/index.js';
import { Selection } from '../dist/index.js';
import { optionalGPU } from '../../../tests/support/optional-gpu.js';

function readGLB(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength),
    jsonLength = view.getUint32(12, true);
  return {
    doc: JSON.parse(new TextDecoder().decode(bytes.subarray(20, 20 + jsonLength))),
    binary: bytes.subarray(28 + jsonLength, 28 + jsonLength + view.getUint32(20 + jsonLength, true)),
  };
}

async function refrigerator() {
  const h = optionalGPU(),
    device = h.engine.gpu,
    context = h.context,
    indexed = [],
    fullscreen = [],
    coreMasks = [];
  device.queue.writeTexture = () => {};
  device.queue.copyExternalImageToTexture = () => {};
  device.queue.submit = () => {};
  context.encoder.beginRenderPass = () => ({
    pipeline: null,
    vertex: null,
    index: null,
    setPipeline(pipeline) {
      this.pipeline = pipeline;
    },
    setBindGroup() {},
    setVertexBuffer(_slot, vertex) {
      this.vertex = vertex;
    },
    setIndexBuffer(index) {
      this.index = index;
    },
    setBlendConstant() {},
    draw() {
      fullscreen.push(this.pipeline);
    },
    drawIndexed(count) {
      indexed.push({ pipeline: this.pipeline, vertex: this.vertex, index: this.index, count });
    },
    end() {},
  });
  context.draw = (options) => {
    if (options?.pipeline?.fragment?.targets?.[0]?.format === 'r8unorm') coreMasks.push(options);
  };
  const engine = new Engine(
    { width: 128, height: 96, clientWidth: 128, clientHeight: 96 },
    await TransformStore.create(256),
    { backend: 'webgpu', gpu: device, add() {}, remove() {}, render() {}, dispose() {} },
    { position: [0, 1, 6], target: [0, 1, 0], fov: 60 },
    null,
  );
  engine.camera.update(128 / 96, true);
  context.camera = engine.camera;
  const { doc, binary } = readGLB(
      readFileSync(
        new URL('../../../examples/assets/khronos/CommercialRefrigerator/CommercialRefrigerator.glb', import.meta.url),
      ),
    ),
    model = new PBRModel(
      engine,
      new GLTFAsset(doc, [], binary),
      doc.images.map(() => ({ width: 1, height: 1, close() {} })),
    );
  engine.use(model);
  const selection = Selection.attach(engine);
  const frame = () => {
    indexed.length = fullscreen.length = coreMasks.length = 0;
    engine.store.tick(false);
    engine.frameGraph.execute(context);
    return indexed.filter((draw) => draw.pipeline.fragment.targets[0].format === 'r8unorm');
  };
  const maskNodes = () =>
    frame()
      .map((draw) => {
        const primitive = model.primitives.find(
          (p) => p.buffers.vertex === draw.vertex && p.buffers.index === draw.index,
        );
        assert.ok(primitive, 'every outlined draw belongs to a primitive parsed from the loaded asset');
        assert.equal(draw.count, primitive.indices.length, 'the mask draws that complete primitive');
        return primitive.node.name;
      })
      .sort();
  return {
    engine,
    model,
    selection,
    fullscreen,
    coreMasks,
    frame,
    maskNodes,
    dispose() {
      engine.dispose();
      h.cleanup();
    },
  };
}

test('loaded CommercialRefrigerator selection follows the actual named node hierarchy', async (t) => {
  const world = await refrigerator(),
    { model, selection } = world,
    node = (name) => {
      const found = model.nodes.find((mesh) => mesh.name === name);
      assert.ok(found, `the loaded asset contains ${name}`);
      return found;
    };
  try {
    await t.test('FridgeGlass outlines only the actual leaf child', () => {
      selection.set([node('FridgeGlass')]);
      assert.deepEqual(world.maskNodes(), ['FridgeGlass']);
    });
    await t.test('FridgeDoor outlines its own primitive and both actual children', () => {
      selection.set([node('FridgeDoor')]);
      assert.deepEqual(world.maskNodes(), ['FridgeDoor', 'FridgeDoorInner', 'FridgeGlass']);
    });
    await t.test('FridgeCase outlines all eight primitives of the actual assembly root', () => {
      selection.set([node('FridgeCase')]);
      assert.deepEqual(world.maskNodes(), [
        'ChampagneBottles',
        'ChampagneBottles',
        'ChampagneBottles',
        'FridgeCase',
        'FridgeDoor',
        'FridgeDoorInner',
        'FridgeGlass',
        'FridgeInterior',
      ]);
    });
    await t.test('clearing the selection emits no selection mask or outline composite on the next frame', () => {
      selection.set([node('FridgeGlass')]);
      assert.deepEqual(world.maskNodes(), ['FridgeGlass']);
      assert.equal(world.fullscreen.length, 1, 'a selected child emits the outline composite');
      assert.equal(world.coreMasks.length, 1, 'a selected child also runs the core selection mask');
      selection.set([]);
      assert.deepEqual(world.frame(), []);
      assert.deepEqual(world.fullscreen, [], 'the next frame emits no outline composite');
      assert.deepEqual(world.coreMasks, [], 'the next frame emits no core selection mask');
    });
  } finally {
    world.dispose();
  }
});
