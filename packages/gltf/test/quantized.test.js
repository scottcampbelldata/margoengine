import test from 'node:test';
import assert from 'node:assert/strict';
import { loadGLTF, parseGLTF } from '../dist/index.js';
import { quantized } from '../dist/quantized.js';
import { documentOf, headlessEngine, vertexData } from './helpers.js';

const BYTE = 5120,
  UNSIGNED_BYTE = 5121,
  SHORT = 5122,
  UNSIGNED_SHORT = 5123;
const close = (actual, expected) =>
  actual.forEach((value, i) => assert.ok(Math.abs(value - expected[i]) < 1e-6, `${i}: ${value} vs ${expected[i]}`));
const scene = {
  meshes: [{ primitives: [{ attributes: { POSITION: 0, NORMAL: 1 } }] }],
  nodes: [{ mesh: 0 }],
  extensionsRequired: ['KHR_mesh_quantization'],
};
function file(position, normal = new Int8Array([0, 0, 127, 0, 0, 127, 0, 0, 127, 0, 0, 0])) {
  const { doc, bytes } = documentOf([position.data, normal], scene);
  doc.bufferViews[0].byteStride = position.stride;
  doc.bufferViews[1].byteStride = 4;
  doc.accessors = [
    { bufferView: 0, componentType: position.type, normalized: position.normalized, count: 3, type: 'VEC3' },
    { bufferView: 1, componentType: BYTE, normalized: true, count: 3, type: 'VEC3' },
  ];
  return { doc, bytes };
}
const load = (engine, { doc, bytes }, extensions = [quantized]) => parseGLTF(engine, doc, [bytes], { extensions });

test('quantized reads every POSITION integer form, normalized or not', async () => {
  const { engine } = await headlessEngine();
  try {
    const cases = [
      [UNSIGNED_BYTE, false, Uint8Array, 4, [0, 0, 0, 0, 255, 2, 0, 0, 1, 255, 3, 0], [0, 0, 0, 255, 2, 0, 1, 255, 3]],
      [
        UNSIGNED_BYTE,
        true,
        Uint8Array,
        4,
        [0, 0, 0, 0, 255, 51, 0, 0, 0, 255, 0, 0],
        [0, 0, 0, 1, 0.2, 0, 0, 1, 0],
      ],
      [BYTE, false, Int8Array, 4, [-128, 0, 0, 0, 127, 0, 0, 0, 0, 1, 0, 0], [-128, 0, 0, 127, 0, 0, 0, 1, 0]],
      // -128 and -32768 clamp to -1: the specification's max(c / 127, -1).
      [BYTE, true, Int8Array, 4, [-128, 0, 0, 0, 127, 0, 0, 0, 0, -127, 0, 0], [-1, 0, 0, 1, 0, 0, 0, -1, 0]],
      [SHORT, false, Int16Array, 8, [-300, 0, 0, 0, 300, 0, 0, 0, 0, 7, 0, 0], [-300, 0, 0, 300, 0, 0, 0, 7, 0]],
      [SHORT, true, Int16Array, 8, [-32768, 0, 0, 0, 32767, 0, 0, 0, 0, -32767, 0, 0], [-1, 0, 0, 1, 0, 0, 0, -1, 0]],
      [UNSIGNED_SHORT, false, Uint16Array, 8, [0, 0, 0, 0, 65535, 0, 0, 0, 0, 9, 0, 0], [0, 0, 0, 65535, 0, 0, 0, 9, 0]],
      [UNSIGNED_SHORT, true, Uint16Array, 8, [0, 0, 0, 0, 65535, 0, 0, 0, 0, 65535, 0, 0], [0, 0, 0, 1, 0, 0, 0, 1, 0]],
    ];
    for (const [type, normalized, Type, stride, values, expected] of cases) {
      const model = load(engine, file({ data: new Type(values), type, normalized, stride }));
      close(vertexData(model.meshes[0].geometry).positions, expected);
      model.dispose();
    }
  } finally {
    engine.dispose();
  }
});

test('quantized reads normalized 8 and 16 bit normals', async () => {
  const { engine } = await headlessEngine();
  try {
    const data = new Uint8Array([0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0]);
    const position = { data, type: UNSIGNED_BYTE, stride: 4 };
    const bytes = load(engine, file(position, new Int8Array([127, 0, 0, 0, -128, 0, 0, 0, 0, 0, 127, 0])));
    close(vertexData(bytes.meshes[0].geometry).normals, [1, 0, 0, -1, 0, 0, 0, 0, 1]);
    bytes.dispose();
    const wide = file(position, new Int16Array([32767, 0, 0, 0, -32768, 0, 0, 0, 0, 0, 32767, 0]));
    wide.doc.bufferViews[1].byteStride = 8;
    wide.doc.accessors[1].componentType = SHORT;
    const shorts = load(engine, wide);
    close(vertexData(shorts.meshes[0].geometry).normals, [1, 0, 0, -1, 0, 0, 0, 0, 1]);
    shorts.dispose();
  } finally {
    engine.dispose();
  }
});

test('quantized leaves float attributes and indices to the loader, and the document as it was', async () => {
  const { engine } = await headlessEngine();
  try {
    const { doc, bytes } = documentOf(
      [
        new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
        new Int8Array([0, 0, 127, 0, 0, 0, 127, 0, 0, 0, 127, 0]),
        new Uint16Array([0, 1, 2]),
      ],
      {
        ...scene,
        meshes: [{ primitives: [{ attributes: { POSITION: 0, NORMAL: 1 }, indices: 2 }] }],
      },
    );
    doc.bufferViews[1].byteStride = 4;
    doc.accessors = [
      { bufferView: 0, componentType: 5126, count: 3, type: 'VEC3' },
      { bufferView: 1, componentType: BYTE, normalized: true, count: 3, type: 'VEC3' },
      { bufferView: 2, componentType: UNSIGNED_SHORT, count: 3, type: 'SCALAR' },
    ];
    const before = JSON.stringify(doc),
      model = parseGLTF(engine, doc, [bytes], { extensions: [quantized] });
    assert.deepEqual(vertexData(model.meshes[0].geometry).positions, [0, 0, 0, 1, 0, 0, 0, 1, 0]);
    assert.deepEqual([...model.meshes[0].geometry.indices], [0, 1, 2]);
    assert.equal(JSON.stringify(doc), before);
    model.dispose();
  } finally {
    engine.dispose();
  }
});

test('without quantized the file stays refused, with a way forward', async () => {
  const { engine } = await headlessEngine();
  try {
    const packed = file({ data: new Uint8Array(12), type: UNSIGNED_BYTE, stride: 4 });
    assert.throws(() => load(engine, packed, []), /gltf-pro/);
    delete packed.doc.extensionsRequired;
    assert.throws(() => load(engine, packed, []), /gltf\/quantized/);
    assert.equal(engine.meshes.size, 0);
  } finally {
    engine.dispose();
  }
});

test('quantized refuses forms the extension does not allow', async () => {
  const { engine } = await headlessEngine();
  try {
    const position = { data: new Uint8Array(12), type: UNSIGNED_BYTE, stride: 4 };
    const plain = file(position);
    plain.doc.accessors[1].normalized = false;
    assert.throws(() => load(engine, plain), /Unsupported glTF accessor/);
    const unsigned = file(position);
    unsigned.doc.accessors[1].componentType = UNSIGNED_BYTE;
    assert.throws(() => load(engine, unsigned), /Unsupported glTF accessor/);
    const flat = file(position);
    flat.doc.accessors[0].type = 'VEC2';
    assert.throws(() => load(engine, flat), /Unsupported glTF accessor/);
    const sparse = file(position);
    sparse.doc.accessors[0].sparse = { count: 1 };
    assert.throws(() => load(engine, sparse), /Unsupported glTF accessor/);
    const unknown = file(position);
    unknown.doc.accessors[0].componentType = 5125;
    assert.throws(() => load(engine, unknown), /Unsupported glTF accessor/);
    assert.equal(engine.meshes.size, 0);
  } finally {
    engine.dispose();
  }
});

test('quantized keeps the bounds checks: a stride or count past the view is a RangeError', async () => {
  const { engine } = await headlessEngine();
  try {
    const position = { data: new Uint8Array(12), type: UNSIGNED_BYTE, stride: 4 };
    const long = file(position);
    long.doc.accessors[0].count = 4;
    assert.throws(() => load(engine, long), /bounds/);
    const wide = file(position);
    wide.doc.bufferViews[0].byteStride = 8;
    assert.throws(() => load(engine, wide), /bounds/);
    const odd = file({ data: new Uint16Array(12), type: UNSIGNED_SHORT, stride: 8 });
    odd.doc.accessors[0].byteOffset = 1;
    assert.throws(() => load(engine, odd), /bounds/);
    assert.equal(engine.meshes.size, 0);
  } finally {
    engine.dispose();
  }
});

test('loadGLTF takes extensions, for its early check and for the parse', async () => {
  const { engine } = await headlessEngine();
  try {
    const { doc, bytes } = file({ data: new Uint8Array([0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0]), type: UNSIGNED_BYTE, stride: 4 });
    doc.buffers[0].uri = 'model.bin';
    const get = async (url) =>
      new Response(String(url).endsWith('.bin') ? bytes : JSON.stringify(doc), { status: 200 });
    await assert.rejects(loadGLTF(engine, 'https://example.test/model.gltf', { fetch: get }), /gltf-pro/);
    const model = await loadGLTF(engine, 'https://example.test/model.gltf', { fetch: get, extensions: [quantized] });
    assert.deepEqual(vertexData(model.meshes[0].geometry).positions, [0, 0, 0, 1, 0, 0, 0, 1, 0]);
    model.dispose();
  } finally {
    engine.dispose();
  }
});
