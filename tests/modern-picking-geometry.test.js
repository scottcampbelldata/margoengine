import test from 'node:test';
import assert from 'node:assert/strict';
import {Engine, TransformStore} from '../packages/core/dist/extension.js';
import {parseGLTF, textureCoordinates} from '../packages/gltf-pro/dist/index.js';
import {Animation} from '../packages/animation/dist/index.js';
import {optionalGPU} from './support/optional-gpu.js';
import {animatedTriangle} from './support/gltf-pro-fixture.js';
import {materialQuad} from './support/materials-fixture.js';

async function scene(fixture = materialQuad(), {pending = false} = {}) {
  const h = optionalGPU(), store = await TransformStore.create(32), device = h.engine.gpu;
  device.limits.maxTextureDimension2D = 8192; device.limits.maxUniformBufferBindingSize = 65536;
  device.queue.copyExternalImageToTexture = () => {};
  const engine = new Engine({width: 128, height: 96, clientWidth: 128, clientHeight: 96}, store,
    {backend: 'webgpu', gpu: device, add() {}, remove() {}, render() {}, dispose() {}}, {position: [0, 0, 4], target: [0, 0, 0]}, null);
  const events = [], readers = [], createBuffer = device.createBuffer;
  device.createBuffer = descriptor => {
    const buffer = createBuffer(descriptor);
    if (descriptor.usage & GPUBufferUsage.MAP_READ) {
      buffer.mapAsync = mode => {
        assert.equal(mode, GPUMapMode.READ); events.push('map'); buffer.mapState = 'pending';
        if (!pending) {buffer.mapState = 'mapped'; return Promise.resolve();}
        return new Promise((resolve, reject) => readers.push({buffer,
          resolve() {buffer.mapState = 'mapped'; resolve();}, reject}));
      };
    }
    return buffer;
  };
  const encoder = h.context.encoder, copy = encoder.copyBufferToBuffer;
  encoder.copyBufferToBuffer = (...args) => {events.push('copy'); copy(...args);};
  encoder.finish = () => {events.push('finish'); return {encoder};};
  device.createCommandEncoder = () => {events.push('encode'); return encoder;};
  device.queue.submit = commands => {assert.equal(commands[0].encoder, encoder); events.push('submit');};
  try {
    const model = parseGLTF(engine, fixture.doc, fixture.buffers, fixture.doc.images ? [{width: 1, height: 1, close() {}}] : []);
    engine.camera.update(128 / 96, true); store.tick(false);
    return {...h, device, store, engine, model, events, readers,
      readbacks() {return h.resources.filter(resource => resource.label === 'PBR picking snapshot');},
      output(primitive = model.primitives[0], usage = GPUBufferUsage.STORAGE | GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_SRC) {
        const buffer = device.createBuffer({size: primitive.vertices.byteLength, usage}); primitive.deformed = buffer; return buffer;
      },
      dispose() {engine.dispose(); h.cleanup();}};
  } catch (error) {engine.dispose(); h.cleanup(); throw error;}
}

test('static PBR picking snapshots copy CPU geometry and refreshed matrices with no GPU readback or allocation', async () => {
  const s = await scene(), primitive = s.model.primitives[0];
  try {
    primitive.node.setPosition([4, 2, -1]); primitive.material.settings[2] = 0.5;
    const count = s.counts.buffers, vertices = primitive.vertices.slice(), indices = primitive.indices.slice();
    const [snapshot] = await s.model.readPickingGeometry();
    assert.equal(s.counts.buffers, count); assert.deepEqual(s.events, []); assert.deepEqual(s.readbacks(), []);
    assert.equal(snapshot.node, primitive.node); assert.equal(snapshot.doubleSided, true);
    assert.deepEqual(snapshot.matrix, primitive.node.matrix); assert.equal(snapshot.matrix[12], 4); assert.equal(snapshot.matrix[13], 2); assert.equal(snapshot.matrix[14], -1);
    assert.deepEqual(snapshot.vertices, vertices); assert.deepEqual(snapshot.indices, indices);
    assert.notEqual(snapshot.vertices, primitive.vertices); assert.notEqual(snapshot.indices, primitive.indices); assert.notEqual(snapshot.matrix, primitive.node.matrix);
    snapshot.vertices[0] = 99; snapshot.indices[0] = 99; snapshot.matrix[12] = 99;
    assert.deepEqual(primitive.vertices, vertices); assert.deepEqual(primitive.indices, indices); assert.equal(primitive.node.matrix[12], 4);
    assert.equal(primitive.node.geometry, null, 'PBR picking must not attach a core Geometry');
  } finally {s.dispose();}
  assert.ok(s.resources.every(resource => resource.destroyed));
});

test('pickingPrimitives borrows current deformed buffers and current UV1, transform, side and alpha-mask data', async () => {
  const f = materialQuad(); f.doc.images = [{uri: 'alpha.png'}]; f.doc.textures = [{source: 0}];
  f.doc.materials[0].alphaMode = 'MASK'; f.doc.materials[0].alphaCutoff = 0.35;
  f.doc.materials[0].pbrMetallicRoughness.baseColorTexture = {index: 0, extensions: {KHR_texture_transform: {texCoord: 1, offset: [0.25, 0.5], scale: [2, 3], rotation: 0.4}}};
  const s = await scene(f), primitive = s.model.primitives[0];
  try {
    const original = s.model.pickingPrimitives[0], output = s.output();
    assert.equal(original.node, primitive.node); assert.equal(original.stride, 80); assert.equal(original.count, 6);
    assert.equal(original.texCoord, 1); assert.deepEqual(original.alphaTransform, textureCoordinates(primitive.material.maps[0]).transform);
    assert.equal(original.alphaTexture, s.model.shadowPrimitives[0].alphaTexture); assert.equal(original.alphaSampler, s.model.shadowPrimitives[0].alphaSampler);
    primitive.material.base[3] = 0.25; primitive.material.settings[1] = 0.6; primitive.material.settings[2] = 0.5;
    const current = s.model.pickingPrimitives[0];
    assert.equal(current.vertex, output); assert.notEqual(current.vertex, original.vertex); assert.equal(current.index, original.index);
    assert.equal(current.alpha, 0.25); assert.equal(current.cutoff, 0.6); assert.equal(current.doubleSided, true);
    primitive.material.settings[0] = 2; assert.equal(s.model.pickingPrimitives[0].cutoff, 0.001);
    primitive.material.settings[0] = 0; assert.equal(s.model.pickingPrimitives[0].cutoff, 0);
    assert.equal(output.destroyed, false, 'getter never owns borrowed output');
    s.model.dispose(); assert.deepEqual(s.model.pickingPrimitives, []); assert.equal(output.destroyed, false);
  } finally {s.dispose();}
});

test('PBR CPU queries prepare deformation before copying actual GPU output and keep all snapshots coherent during readback', async () => {
  const f = materialQuad(); f.doc.meshes[0].primitives.push({...f.doc.meshes[0].primitives[0]});
  const s = await scene(f, {pending: true}), [deformed, plain] = s.model.primitives, output = s.output(deformed);
  const bind = deformed.vertices.slice(), expected = bind.slice(), expectedPlain = plain.vertices.slice(), indices = plain.indices.slice();
  for (let i = 0; i < expected.length; i += 20) {expected[i] += 13; expected[i + 2] = 2.5; expected[i + 4] = 0; expected[i + 5] = 1; expected[i + 6] = 0;}
  try {
    deformed.node.setPosition([3, 4, 5]); plain.material.settings[2] = 0.5;
    s.model.prepareDeformation = context => {
      assert.equal(context.device, s.device); assert.equal(context.encoder, s.context.encoder); assert.equal(context.backend, 'webgpu');
      s.events.push('prepare'); new Float32Array(output.data).set(expected);
    };
    const pending = s.model.readPickingGeometry();
    assert.deepEqual(s.events, ['encode', 'prepare', 'copy', 'finish', 'submit', 'map']);
    assert.equal(s.readers.length, 1); const readback = s.readers[0].buffer;
    assert.equal(readback.usage, GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ); assert.equal(readback.destroyed, false);
    // A later pose/material edit cannot change this query's already encoded result or CPU snapshots.
    new Float32Array(output.data).fill(-99); deformed.vertices[0] = 88; plain.vertices[0] = 77; plain.indices[0] = 3;
    plain.material.settings[2] = 0; deformed.node.setPosition([20, 30, 40]); s.store.tick(false);
    s.readers[0].resolve(); const snapshots = await pending;
    assert.deepEqual(snapshots[0].vertices, expected); assert.notDeepEqual(snapshots[0].vertices, deformed.vertices);
    assert.deepEqual(snapshots[1].vertices, expectedPlain); assert.deepEqual(snapshots[1].indices, indices); assert.equal(snapshots[1].doubleSided, true);
    for (const snapshot of snapshots) assert.deepEqual([...snapshot.matrix.slice(12, 15)], [3, 4, 5]);
    assert.equal(readback.destroyed, true); assert.equal(readback.mapState, 'unmapped'); assert.equal(output.destroyed, false);
    assert.equal(deformed.node.geometry, null);
  } finally {s.dispose();}
});

test('PBR readback discards disposed/restored/removed sources and cleans buffers after map or COPY_SRC failures', async () => {
  for (const action of ['dispose', 'restore', 'node-reuse', 'output-replace', 'output-replace-map-failure', 'map-failure', 'missing-copy-src']) {
    const s = await scene(materialQuad(), {pending: true}), primitive = s.model.primitives[0], output = s.output(primitive,
      GPUBufferUsage.STORAGE | GPUBufferUsage.VERTEX | (action === 'missing-copy-src' ? 0 : GPUBufferUsage.COPY_SRC));
    try {
      const pending = s.model.readPickingGeometry();
      if (action === 'missing-copy-src') {
        await assert.rejects(pending, /COPY_SRC/); assert.equal(s.readbacks().length, 0); continue;
      }
      assert.equal(s.readers.length, 1);
      if (action === 'dispose') s.model.dispose();
      if (action === 'restore') s.model.onDeviceRestored(s.engine);
      if (action === 'node-reuse') s.engine.meshes.set(primitive.node.id, {...primitive.node});
      if (action === 'output-replace' || action === 'output-replace-map-failure') s.output(primitive);
      if (action === 'output-replace-map-failure') {
        // Animation disposal/replacement can invalidate an in-flight copy without changing the device or model revision.
        output.destroy(); s.readers[0].reject(new Error('old deformation buffer destroyed'));
        assert.deepEqual(await pending, [], action);
      }
      else if (action === 'map-failure') {s.readers[0].reject(new Error('map failure')); await assert.rejects(pending, /map failure/);}
      else {s.readers[0].resolve(); assert.deepEqual(await pending, [], action);}
      assert.ok(s.readbacks().every(resource => resource.destroyed));
      assert.equal(output.destroyed, action === 'output-replace-map-failure', 'readback never owns the caller output');
      if (action === 'node-reuse') s.engine.meshes.set(primitive.node.id, primitive.node);
    } finally {s.dispose();}
  }
});

test('Animation owns one stable immediate-deformation hook through restoration and only clears its own hook on disposal', async () => {
  const s = await scene(animatedTriangle());
  try {
    const animation = Animation.attach(s.model), first = s.model.prepareDeformation, output = s.model.primitives[0].deformed;
    assert.equal(typeof first, 'function'); assert.ok(output.usage & GPUBufferUsage.COPY_SRC);
    const compute = s.counts.compute; first({backend: 'webgpu', device: s.device, encoder: s.context.encoder});
    assert.equal(s.counts.compute, compute + 1); assert.equal(s.model.prepareDeformation, first);
    s.model.onDeviceRestored(s.engine); animation.onDeviceRestored(s.engine);
    assert.equal(s.model.prepareDeformation, first, 'hook identity remains stable after restoration'); assert.equal(output.destroyed, true);
    const restored = s.model.primitives[0].deformed; assert.notEqual(restored, output); assert.ok(restored.usage & GPUBufferUsage.COPY_SRC);
    animation.dispose(); assert.equal(s.model.prepareDeformation, undefined); assert.equal(s.model.primitives[0].deformed, undefined); assert.equal(restored.destroyed, true);
    const second = Animation.attach(s.model), replacement = () => {};
    s.model.prepareDeformation = replacement; second.dispose(); assert.equal(s.model.prepareDeformation, replacement, 'caller replacement must survive animation disposal');
  } finally {s.dispose();}
  assert.ok(s.resources.every(resource => resource.destroyed));
});
