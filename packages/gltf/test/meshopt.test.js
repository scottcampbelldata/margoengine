import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { loadGLTF, parseGLTF, parseGLTFAsync } from '../dist/index.js';
import { meshopt } from '../dist/meshopt.js';
import { quantized } from '../dist/quantized.js';
import { encodeAttributes, encodeTriangles } from '../../decoders/tests/support/meshopt-encode.js';
import { documentOf, headlessEngine, vertexData } from './helpers.js';

const positions = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 1, 0]),
  normals = new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]),
  indices = new Uint32Array([0, 1, 2, 2, 1, 3]);
const raw = (array) => new Uint8Array(array.buffer, array.byteOffset, array.byteLength);
/** A mesh whose three views are compressed in buffer 0, over a fallback buffer 1. */
function file() {
  const streams = [
    { data: encodeAttributes(raw(positions), 4, 12), stride: 12, count: 4, mode: 'ATTRIBUTES', size: 48 },
    { data: encodeAttributes(raw(normals), 4, 12), stride: 12, count: 4, mode: 'ATTRIBUTES', size: 48 },
    { data: encodeTriangles(indices), stride: 4, count: 6, mode: 'TRIANGLES', size: 24 },
  ];
  const { doc, bytes } = documentOf(streams.map((s) => s.data));
  let at = 0;
  doc.buffers.push({ byteLength: 120, extensions: { EXT_meshopt_compression: { fallback: true } } });
  doc.bufferViews = doc.bufferViews.map((view, i) => {
    const s = streams[i],
      out = {
        buffer: 1,
        byteOffset: at,
        byteLength: s.size,
        extensions: {
          EXT_meshopt_compression: {
            buffer: 0,
            byteOffset: view.byteOffset,
            byteLength: view.byteLength,
            byteStride: s.stride,
            count: s.count,
            mode: s.mode,
          },
        },
      };
    at += s.size;
    return out;
  });
  Object.assign(doc, {
    extensionsRequired: ['EXT_meshopt_compression'],
    accessors: [
      { bufferView: 0, componentType: 5126, count: 4, type: 'VEC3' },
      { bufferView: 1, componentType: 5126, count: 4, type: 'VEC3' },
      { bufferView: 2, componentType: 5125, count: 6, type: 'SCALAR' },
    ],
    meshes: [{ primitives: [{ attributes: { POSITION: 0, NORMAL: 1 }, indices: 2 }] }],
    nodes: [{ mesh: 0 }],
  });
  return { doc, bytes };
}
const load = (engine, { doc, bytes }, extensions = [meshopt]) => parseGLTFAsync(engine, doc, [bytes], { extensions });
const source = (doc, view) => doc.bufferViews[view].extensions.EXT_meshopt_compression;

test('meshopt decodes vertex and index views over a fallback buffer, leaving the document as it was', async () => {
  const { engine } = await headlessEngine();
  try {
    const input = file(),
      before = JSON.stringify(input.doc),
      model = await load(engine, input),
      { geometry } = model.meshes[0];
    assert.deepEqual(vertexData(geometry).positions, [...positions]);
    assert.deepEqual(vertexData(geometry).normals, [...normals]);
    assert.deepEqual([...geometry.indices].sort(), [...indices].sort());
    assert.equal(JSON.stringify(input.doc), before);
    model.dispose();
  } finally {
    engine.dispose();
  }
});

test('KHR_meshopt_compression reads the same way', async () => {
  const { engine } = await headlessEngine();
  try {
    const input = file();
    input.doc.extensionsRequired = ['KHR_meshopt_compression'];
    input.doc.buffers[1].extensions = { KHR_meshopt_compression: { fallback: true } };
    for (const view of input.doc.bufferViews)
      view.extensions = { KHR_meshopt_compression: view.extensions.EXT_meshopt_compression };
    const model = await load(engine, input);
    assert.deepEqual(vertexData(model.meshes[0].geometry).positions, [...positions]);
    model.dispose();
  } finally {
    engine.dispose();
  }
});

test('quantized attributes inside compressed views read with both extensions', async () => {
  const { engine } = await headlessEngine();
  try {
    const packed = new Uint16Array([0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 1, 1, 0, 0]),
      input = file(),
      data = encodeAttributes(raw(packed), 4, 8),
      { doc, bytes } = documentOf([input.bytes, data]);
    input.bytes = bytes;
    input.doc.buffers[0].byteLength = bytes.length;
    Object.assign(source(input.doc, 0), {
      byteOffset: doc.bufferViews[1].byteOffset,
      byteLength: data.length,
      byteStride: 8,
    });
    input.doc.bufferViews[0].byteLength = 32;
    input.doc.bufferViews[0].byteStride = 8;
    input.doc.accessors[0].componentType = 5123;
    input.doc.extensionsRequired.push('KHR_mesh_quantization');
    const model = await load(engine, input, [meshopt, quantized]);
    assert.deepEqual(vertexData(model.meshes[0].geometry).positions, [0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 1, 0]);
    model.dispose();
  } finally {
    engine.dispose();
  }
});

test('a filtered view decodes: octahedral normals reach the geometry through quantized', async () => {
  const { engine } = await headlessEngine();
  try {
    const packed = new Int8Array([0, 0, 127, 0, 0, 0, 127, 0, 127, 0, 127, 0, 0, 0, 127, 0]),
      input = file(),
      data = encodeAttributes(raw(packed), 4, 4),
      { doc, bytes } = documentOf([input.bytes, data]);
    input.bytes = bytes;
    input.doc.buffers[0].byteLength = bytes.length;
    Object.assign(source(input.doc, 1), {
      byteOffset: doc.bufferViews[1].byteOffset,
      byteLength: data.length,
      byteStride: 4,
      filter: 'OCTAHEDRAL',
    });
    input.doc.bufferViews[1].byteLength = 16;
    input.doc.bufferViews[1].byteStride = 4;
    Object.assign(input.doc.accessors[1], { componentType: 5120, normalized: true });
    input.doc.extensionsRequired.push('KHR_mesh_quantization');
    const model = await load(engine, input, [quantized, meshopt]);
    assert.deepEqual(vertexData(model.meshes[0].geometry).normals, [0, 0, 1, 0, 0, 1, 1, 0, 0, 0, 0, 1]);
    model.dispose();
  } finally {
    engine.dispose();
  }
});

test('loadGLTF never downloads a fallback buffer', async () => {
  const { engine } = await headlessEngine();
  try {
    const { doc, bytes } = file(),
      asked = [];
    doc.buffers[0].uri = 'data.bin';
    doc.buffers[1].uri = 'fallback.bin';
    const get = async (url) => {
      asked.push(String(url));
      return new Response(String(url).endsWith('.gltf') ? JSON.stringify(doc) : bytes);
    };
    const model = await loadGLTF(engine, 'https://example.test/m.gltf', { fetch: get, extensions: [meshopt] });
    assert.deepEqual(asked, ['https://example.test/m.gltf', 'https://example.test/data.bin']);
    model.dispose();
  } finally {
    engine.dispose();
  }
});

test('the decoder stays out of the entry, and without the extension the file stays refused', async () => {
  const code = await readFile(new URL('../dist/meshopt.js', import.meta.url), 'utf8');
  assert.match(code, /import\(["`]@margoengine\/decoders\/meshopt["`]\)/);
  assert.doesNotMatch(code, /from\s*["`]@margoengine\/decoders/);
  const { engine } = await headlessEngine();
  try {
    const { doc, bytes } = file();
    assert.throws(() => parseGLTF(engine, doc, [bytes], { extensions: [meshopt] }), /parseGLTFAsync/);
    assert.throws(() => parseGLTF(engine, doc, [bytes]), /gltf-pro/);
    delete doc.extensionsRequired;
    assert.throws(() => parseGLTF(engine, doc, [bytes]), /Truncated/);
  } finally {
    engine.dispose();
  }
});

test('hostile views are refused before decoding and roll back', async () => {
  const { engine } = await headlessEngine();
  try {
    const big = file();
    source(big.doc, 0).count = 6_000_000;
    await assert.rejects(load(engine, big), /64 MiB/);
    const spread = file();
    source(spread.doc, 0).count = 3_000_000;
    source(spread.doc, 1).count = 3_000_000;
    await assert.rejects(load(engine, spread), /64 MiB|truncated/);
    const outside = file();
    source(outside.doc, 0).byteLength = 1 << 20;
    await assert.rejects(load(engine, outside), /outside its buffer/);
    const missing = file();
    source(missing.doc, 0).buffer = 9;
    await assert.rejects(load(engine, missing), /outside its buffer/);
    const short = file();
    short.doc.bufferViews[0].byteLength = 4096;
    await assert.rejects(load(engine, short), /shorter than its bufferView/);
    const unknown = file();
    source(unknown.doc, 0).mode = 'NOPE';
    await assert.rejects(load(engine, unknown), /unknown mode/);
    const negative = file();
    source(negative.doc, 0).count = -1;
    await assert.rejects(load(engine, negative), /meshopt count/);
    const plain = file();
    delete plain.doc.bufferViews[0].extensions;
    await assert.rejects(load(engine, plain), /bounds/);
    assert.equal(engine.meshes.size, 0);
  } finally {
    engine.dispose();
  }
});

test('a file with nothing compressed passes through', async () => {
  const { engine } = await headlessEngine();
  try {
    const { doc, bytes } = documentOf([positions, normals], {
      accessors: [
        { bufferView: 0, componentType: 5126, count: 4, type: 'VEC3' },
        { bufferView: 1, componentType: 5126, count: 4, type: 'VEC3' },
      ],
      meshes: [{ primitives: [{ attributes: { POSITION: 0, NORMAL: 1 }, indices: undefined }] }],
      nodes: [{ mesh: 0 }],
    });
    doc.meshes[0].primitives[0].mode = 4;
    doc.accessors[0].count = doc.accessors[1].count = 3;
    const model = await parseGLTFAsync(engine, doc, [bytes], { extensions: [meshopt] });
    assert.equal(model.meshes.length, 1);
    model.dispose();
  } finally {
    engine.dispose();
  }
});
