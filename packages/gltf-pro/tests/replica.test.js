import test from 'node:test';
import assert from 'node:assert/strict';
import { mockGPU, context } from '../../../examples/package-benchmarks/proofs/gpu-recorder.js';
import { Engine, TransformStore } from '../../core/dist/extension.js';
import { parseGLTF } from '../dist/index.js';
import { PBRInstances, instancing } from '../dist/instancing.js';
import { instancedGLTF } from '../../../tests/support/instanced-gltf.js';

async function scene({ mode = 4, variants = false } = {}) {
  const gpu = mockGPU(),
    store = await TransformStore.create(16);
  const engine = new Engine(
    { width: 128, height: 96, clientWidth: 128, clientHeight: 96 },
    store,
    { backend: 'webgpu', gpu: gpu.device, add() {}, remove() {}, render() {}, dispose() {} },
    { position: [0, 0, 4], target: [0, 0, 0] },
    null,
  );
  const { doc, buffers } = instancedGLTF([{ t: [-1, 0, 0] }, { t: [1, 0, 0] }]);
  const primitive = doc.meshes[0].primitives[0];
  primitive.mode = mode;
  const images = variants
    ? [
        { width: 1, height: 1, name: 'first', close() {} },
        { width: 1, height: 1, name: 'second', close() {} },
      ]
    : [];
  if (variants) {
    doc.images = [{}, {}];
    doc.textures = [{ source: 0 }, { source: 1 }];
    doc.materials = images.map((_, index) => ({ pbrMetallicRoughness: { baseColorTexture: { index } } }));
    doc.extensions = { KHR_materials_variants: { variants: [{ name: 'other' }] } };
    primitive.extensions = { KHR_materials_variants: { mappings: [{ material: 1, variants: [0] }] } };
  } else doc.meshes[0].primitives.push({ ...primitive });
  const model = parseGLTF(engine, doc, buffers, images, { instancing });
  engine.camera.update(4 / 3, true);
  store.tick(false);
  return { gpu, engine, model, images, primitives: mode < 4 ? model.pointsAndLines : model.primitives };
}

function eye(model) {
  const gpu = mockGPU(),
    view = context(gpu, { samples: 1, format: 'rgba16float', depthFormat: 'depth32float' });
  const renderer = model.createRenderer(gpu.device),
    draws = [];
  let instances, pipeline, groups;
  const pass = {
    setPipeline(value) {
      pipeline = value;
      groups = new Map();
      instances = undefined;
    },
    setBindGroup(index, group) {
      groups.set(index, group);
    },
    setVertexBuffer(slot, buffer) {
      if (slot === 1) instances = buffer;
    },
    setIndexBuffer() {},
    drawIndexed(count, instanceCount) {
      draws.push({ instances, pipeline, groups, count, instanceCount });
    },
    end() {
      assert.fail('The eye pass belongs to its caller');
    },
  };
  return {
    gpu,
    renderer,
    draws,
    draw() {
      draws.length = 0;
      return gpu.record(() => {
        view.begin(0);
        renderer.prepare(view.c);
        renderer.draw(view.c, pass, view.camera.matrix);
      });
    },
  };
}

test('disposing an unused or drawn eye renderer never destroys the main instance buffer', async () => {
  const { gpu, engine, model, primitives } = await scene(),
    source = primitives[0].instances;
  const main = source.upload(gpu.device),
    unused = eye(model),
    active = eye(model);
  try {
    unused.renderer.dispose();
    assert.notEqual(main.destroyed, true, 'Unused replicas must not dispose borrowed instances');
    active.draw();
    const owned = active.draws[0].instances;
    assert.notEqual(owned, main);
    assert.notEqual(main.destroyed, true, 'Uploading on another device must leave the main buffer intact');
    active.renderer.dispose();
    assert.equal(owned.destroyed, true);
    assert.notEqual(main.destroyed, true);
    assert.equal(source.upload(gpu.device), main);
  } finally {
    unused.renderer.dispose();
    active.renderer.dispose();
    engine.dispose();
  }
});

test('main and two eyes retain independent instance buffers and observe all live changes', async () => {
  const { gpu, engine, model, primitives } = await scene(),
    source = primitives[0].instances;
  const main = source.upload(gpu.device),
    left = eye(model),
    right = eye(model);
  try {
    left.draw();
    right.draw();
    const a = left.draws[0].instances,
      b = right.draws[0].instances;
    assert.notEqual(a, b);
    for (const target of [left, right]) {
      assert.equal(target.draws[0].instances, target.draws[1].instances, 'Shared primitives use one projection');
      const log = target.draw();
      assert.equal(log.filter((event) => event[0] === 'buffer').length, 0);
      assert.equal(
        log.filter((event) => event[0] === 'writeBuffer' && event[1] === target.gpu.snap(target.draws[0].instances))
          .length,
        0,
      );
    }
    assert.equal(source.upload(gpu.device), main, 'Alternating devices must not recreate the main buffer');
    source.setColorAt(0, [0.2, 0.4, 0.6]).setUVTransformAt(1, { offset: [0.1, 0.2] });
    source.setMatrixAt(0, [-1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
    source.count = 1;
    source.upload(gpu.device);
    assert.equal(source.needsUpdate, false, 'The main upload consumes only its own dirty range');
    for (const [target, owned] of [
      [left, a],
      [right, b],
    ]) {
      const log = target.draw(),
        write = log.find((event) => event[0] === 'writeBuffer' && event[1] === target.gpu.snap(owned));
      assert.ok(write, 'Every eye sees edits even after another device uploaded them');
      assert.deepEqual(new Float32Array(Uint8Array.from(Buffer.from(write[3], 'hex')).buffer), source.data);
      assert.ok(target.draws.every((draw) => draw.instances === owned && draw.instanceCount === 1));
      assert.ok(
        log.some((event) => event[0] === 'renderPipeline' && event[2].primitive.cullMode === 'none'),
        'Mirrored state follows source data',
      );
    }
    source.data[12] = 7;
    source.needsUpdate = true;
    left.draw();
    source.upload(gpu.device);
    const write = right.draw().find((event) => event[0] === 'writeBuffer' && event[1] === right.gpu.snap(b));
    assert.equal(new Float32Array(Uint8Array.from(Buffer.from(write[3], 'hex')).buffer)[12], 7);
    assert.notEqual(main.destroyed, true);
    assert.notEqual(a.destroyed, true);
    assert.notEqual(b.destroyed, true);
  } finally {
    left.renderer.dispose();
    right.renderer.dispose();
    engine.dispose();
  }
});

test('instance replacement and removal release only unreferenced eye projections', async () => {
  const { gpu, engine, model, primitives } = await scene(),
    source = primitives[0].instances;
  const original = source.upload(gpu.device),
    replacement = new PBRInstances(2),
    main = replacement.upload(gpu.device);
  const target = eye(model);
  try {
    target.draw();
    const previous = target.draws[0].instances;
    primitives[0].instances = replacement;
    target.draw();
    const next = target.draws[0].instances;
    assert.notEqual(next, previous);
    assert.equal(target.draws[1].instances, previous);
    assert.notEqual(previous.destroyed, true, 'The second primitive still uses the old projection');
    primitives[1].instances = replacement;
    target.draw();
    assert.equal(previous.destroyed, true);
    assert.ok(target.draws.every((draw) => draw.instances === next));
    for (const primitive of primitives) primitive.instances = undefined;
    target.draw();
    assert.equal(next.destroyed, true);
    assert.ok(target.draws.every((draw) => !draw.instances));
    assert.notEqual(main.destroyed, true);
    assert.notEqual(original.destroyed, true);
  } finally {
    target.renderer.dispose();
    source.dispose();
    replacement.dispose();
    engine.dispose();
  }
});

for (const mode of [4, 1])
  test(`isolated mode ${mode} renderer rebinds same-layout textured material variants`, async () => {
    const { engine, model, images } = await scene({ mode, variants: true }),
      target = eye(model);
    try {
      target.draw();
      const first = target.draws[0].groups.get(1);
      model.selectVariant('other');
      const log = target.draw(),
        uploads = log.filter((event) => event[0] === 'copyExternalImageToTexture');
      assert.equal(uploads.length, 1);
      assert.equal(uploads[0][1].source.name, images[1].name);
      assert.notEqual(target.draws[0].groups.get(1), first);
      const repeated = target.draw();
      assert.equal(repeated.filter((event) => event[0] === 'copyExternalImageToTexture').length, 0);
      model.selectVariant();
      const restored = target.draw();
      assert.equal(
        restored.filter((event) => event[0] === 'copyExternalImageToTexture').length,
        0,
        'Original texture remains cached',
      );
    } finally {
      target.renderer.dispose();
      engine.dispose();
    }
  });
