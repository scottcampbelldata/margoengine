import test from 'node:test';
import assert from 'node:assert/strict';
import { parseGLTF } from '../dist/index.js';
import { instancing } from '../dist/instancing.js';
import { documentOf, headlessEngine } from './helpers.js';

const NAME = 'EXT_mesh_gpu_instancing';
const close = (actual, expected) =>
  [...actual].forEach((value, i) => assert.ok(Math.abs(value - expected[i]) < 1e-5, `${i}: ${value} vs ${expected[i]}`));
function file(attributes = { TRANSLATION: 2, ROTATION: 3, SCALE: 4 }, node = {}) {
  const half = Math.SQRT1_2;
  const { doc, bytes } = documentOf(
    [
      new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
      new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
      new Float32Array([1, 0, 0, 0, 2, 0, 0, 0, 3]),
      new Float32Array([0, 0, 0, 1, 0, 0, half, half, 0, 0, 0, 1]),
      new Float32Array([1, 1, 1, 2, 2, 2, 1, 1, 1]),
      new Int16Array([0, 0, 32767, 32767, 0, 0, 0, 32767, 0, 0, 0, 32767]),
    ],
    {
      extensionsRequired: [NAME],
      accessors: [
        { bufferView: 0, componentType: 5126, count: 3, type: 'VEC3' },
        { bufferView: 1, componentType: 5126, count: 3, type: 'VEC3' },
        { bufferView: 2, componentType: 5126, count: 3, type: 'VEC3' },
        { bufferView: 3, componentType: 5126, count: 3, type: 'VEC4' },
        { bufferView: 4, componentType: 5126, count: 3, type: 'VEC3' },
        { bufferView: 5, componentType: 5122, normalized: true, count: 3, type: 'VEC4' },
      ],
      meshes: [{ primitives: [{ attributes: { POSITION: 0, NORMAL: 1 } }] }],
      nodes: [{ mesh: 0, translation: [10, 0, 0], extensions: { [NAME]: { attributes } }, ...node }],
    },
  );
  return { doc, bytes };
}
const load = (engine, { doc, bytes }, options = {}) =>
  parseGLTF(engine, doc, [bytes], { extensions: [instancing], ...options });

test('instances share one geometry and sit under the instanced node', async () => {
  const { engine, resources } = await headlessEngine();
  try {
    const input = file(),
      before = JSON.stringify(input.doc),
      model = load(engine, input);
    assert.equal(model.meshes.length, 3);
    assert.equal(new Set(model.meshes.map((mesh) => mesh.geometry)).size, 1);
    assert.equal(resources.size, 1);
    engine.render();
    const [c, a, b] = [...model.meshes].sort((x, y) => x.matrix[13] + x.matrix[12] - (y.matrix[13] + y.matrix[12]));
    close(a.matrix.subarray(12, 15), [11, 0, 0]);
    close(b.matrix.subarray(12, 15), [10, 2, 0]);
    close(c.matrix.subarray(12, 15), [10, 0, 3]);
    // The second instance is scaled by 2 and turned 90 degrees about z, so its local x axis lies along world y.
    close(b.matrix.subarray(0, 3), [0, 2, 0]);
    assert.equal(JSON.stringify(input.doc), before);
    model.dispose();
    assert.equal(engine.meshes.size, 0);
    assert.equal(resources.size, 0);
  } finally {
    engine.dispose();
  }
});

test('each attribute is optional and defaults to identity, quantized rotations are renormalized', async () => {
  const { engine } = await headlessEngine();
  try {
    const moved = load(engine, file({ TRANSLATION: 2 }));
    assert.equal(moved.meshes.length, 3);
    moved.dispose();
    const scaled = load(engine, file({ SCALE: 4 }));
    assert.equal(scaled.meshes.length, 3);
    scaled.dispose();
    const turned = load(engine, file({ ROTATION: 5 }));
    engine.render();
    for (const mesh of turned.meshes) close([Math.hypot(...mesh.matrix.subarray(0, 3))], [1]);
    turned.dispose();
  } finally {
    engine.dispose();
  }
});

test('children of an instanced node stay single, and its other nodes keep their place', async () => {
  const { engine } = await headlessEngine();
  try {
    const input = file(undefined, { children: [1], name: 'forest' });
    input.doc.nodes.push({ mesh: 0, name: 'sign', translation: [0, 9, 0] });
    const model = load(engine, input);
    assert.equal(model.meshes.length, 4);
    assert.equal(model.nodes.filter((node) => node.name === 'sign').length, 1);
    assert.equal(model.nodes.filter((node) => node.name === 'forest').length, 1);
    model.dispose();
  } finally {
    engine.dispose();
  }
});

test('every instance counts toward maxNodes, checked before the nodes are made', async () => {
  const { engine } = await headlessEngine();
  try {
    assert.throws(() => load(engine, file(), { maxNodes: 3 }), /maxNodes/);
    const model = load(engine, file(), { maxNodes: 4 });
    model.dispose();
    assert.equal(engine.meshes.size, 0);
  } finally {
    engine.dispose();
  }
});

test('a forest larger than the engine started with loads, on one geometry', async () => {
  const { engine, resources } = await headlessEngine(64);
  try {
    const count = 500,
      offsets = Float32Array.from({ length: count * 3 }, (_, i) => i),
      input = file({ TRANSLATION: 6 }),
      { doc, bytes } = documentOf([input.bytes, offsets]);
    input.bytes = bytes;
    input.doc.buffers[0].byteLength = bytes.length;
    input.doc.bufferViews.push(doc.bufferViews[1]);
    input.doc.accessors.push({ bufferView: 6, componentType: 5126, count, type: 'VEC3' });
    const model = load(engine, input);
    assert.equal(model.meshes.length, count);
    assert.equal(resources.size, 1);
    model.dispose();
    assert.equal(engine.meshes.size, 0);
  } finally {
    engine.dispose();
  }
});

test('without instancing the file stays refused; malformed instances are named errors', async () => {
  const { engine } = await headlessEngine();
  try {
    const { doc, bytes } = file();
    assert.throws(() => parseGLTF(engine, doc, [bytes]), /gltf-pro/);
    assert.throws(() => load(engine, file({})), /instance attributes/);
    const uneven = file({ TRANSLATION: 2, SCALE: 4 });
    uneven.doc.accessors[4].count = 2;
    assert.throws(() => load(engine, uneven), /instance attributes/);
    assert.throws(() => load(engine, file(undefined, { mesh: undefined })), /instanced node/);
    const wrong = file({ TRANSLATION: 3 });
    assert.throws(() => load(engine, wrong), /Unsupported glTF accessor/);
    const whole = file({ ROTATION: 5 });
    whole.doc.accessors[5].normalized = false;
    assert.throws(() => load(engine, whole), /Unsupported glTF accessor/);
    const endless = file({ TRANSLATION: 2 });
    new DataView(endless.bytes.buffer).setFloat32(endless.doc.bufferViews[2].byteOffset, NaN, true);
    assert.throws(() => load(engine, endless), /instance attributes/);
    const flat = file({ ROTATION: 5 });
    flat.bytes.fill(0, doc.bufferViews[5].byteOffset);
    assert.throws(() => load(engine, flat), /instance rotation/);
    const extra = file(undefined, { extensions: { [NAME]: { attributes: { TRANSLATION: 2 } }, VENDOR_thing: {} } });
    assert.throws(() => load(engine, extra), /gltf-pro/);
    assert.equal(engine.meshes.size, 0);
  } finally {
    engine.dispose();
  }
});
