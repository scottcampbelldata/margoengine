import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createServer} from 'node:http';
import {GLTFAsset} from '@margoengine/gltf-pro/asset';
import {loadGLTF} from '@margoengine/gltf-pro';
import {Engine, TransformStore} from '../packages/core/dist/extension.js';
import {optionalGPU} from './support/optional-gpu.js';

const {cases: referenceVectors} = JSON.parse(await readFile(new URL('../packages/decoders/tests/fixtures/meshopt-vectors.json', import.meta.url)));
const bytes = encoded => Uint8Array.from(Buffer.from(encoded, 'base64'));

// A literal-lane meshoptimizer v0 stream for one block of at most 16 elements.
function encodeLanes(data, count, stride) {
  assert.ok(count <= 16);
  const encoded = [0xa0];
  for (let lane = 0; lane < stride; lane++) {
    encoded.push(3); let previous = 0;
    for (let vertex = 0; vertex < 16; vertex++) {
      const value = vertex < count ? data[vertex * stride + lane] : previous;
      let delta = (value - previous) & 255; if (delta > 127) delta -= 256;
      encoded.push(((delta << 1) ^ (delta >> 7)) & 255); previous = value;
    }
  }
  encoded.push(...new Uint8Array(Math.max(stride, 32)));
  return new Uint8Array(encoded);
}

function compressedView(encoded, count, stride, mode = 'ATTRIBUTES', filter = 'NONE') {
  const sourceOffset = 9, viewOffset = 4, source = new Uint8Array(sourceOffset + encoded.length);
  source.fill(0xef, 0, sourceOffset); source.set(encoded, sourceOffset);
  const byteLength = count * stride;
  const doc = {asset: {version: '2.0'}, extensionsUsed: ['EXT_meshopt_compression'], extensionsRequired: ['EXT_meshopt_compression'],
    buffers: [{byteLength: source.length}, {byteLength: viewOffset + byteLength}],
    bufferViews: [{buffer: 1, byteOffset: viewOffset, byteLength,
      extensions: {EXT_meshopt_compression: {buffer: 0, byteOffset: sourceOffset, byteLength: encoded.length, byteStride: stride, count, mode, filter}}}]};
  return {doc, source};
}

function triangle() {
  const positions = new Float32Array([-1, -1, 0, 1, -1, 0, 0, 1, 0]);
  const result = compressedView(encodeLanes(new Uint8Array(positions.buffer), 3, 12), 3, 12);
  result.doc.bufferViews[0].byteStride = 12;
  result.doc.accessors = [{bufferView: 0, componentType: 5126, count: 3, type: 'VEC3'}];
  result.doc.meshes = [{primitives: [{attributes: {POSITION: 0}}]}]; result.doc.nodes = [{mesh: 0}];
  return {...result, positions};
}

test('meshopt accepts required URI-less placeholder buffers without a fallback marker', () => {
  const {doc, source, positions} = triangle(), before = structuredClone(doc);
  const asset = new GLTFAsset(doc, [source]);
  assert.equal(asset.buffers[1].byteLength, 0);
  assert.deepEqual(asset.accessor(0), positions);
  assert.equal(asset.view(0), asset.view(0), 'each decoded buffer view is retained once');
  assert.deepEqual(doc, before, 'decoding preserves the caller document');
});

test('optional meshopt extensions use compressed data even when ordinary fallback bytes are available', () => {
  const {doc, source, positions} = triangle(); delete doc.extensionsRequired;
  const fallback = new Uint8Array(doc.buffers[1].byteLength);
  const asset = new GLTFAsset(doc, [source, fallback]);
  assert.deepEqual(asset.accessor(0), positions);
  assert.deepEqual(fallback, new Uint8Array(fallback.length), 'fallback data remains untouched');
});

test('loadGLTF skips a marked fallback URI while decoding the compressed buffer', async () => {
  const {doc, source, positions} = triangle(), requests = [];
  doc.buffers[0].uri = 'compressed.bin';
  doc.buffers[1].uri = 'fallback-must-not-load.bin';
  doc.buffers[1].extensions = {EXT_meshopt_compression: {fallback: true}};
  delete doc.extensionsRequired;
  const server = createServer((request, response) => {
    requests.push(request.url);
    if (request.url === '/model.gltf') {response.setHeader('content-type', 'model/gltf+json'); response.end(JSON.stringify(doc));}
    else if (request.url === '/compressed.bin') response.end(source);
    else {response.writeHead(404); response.end();}
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const harness = optionalGPU(), store = await TransformStore.create(16);
  const renderer = {backend: 'webgpu', gpu: harness.engine.gpu, add() {}, remove() {}, render() {}, dispose() {}};
  const engine = new Engine({width: 128, height: 96, clientWidth: 128, clientHeight: 96}, store, renderer, {position: [0, 0, 4], target: [0, 0, 0]}, null);
  try {
    const model = await loadGLTF(engine, `http://127.0.0.1:${server.address().port}/model.gltf`);
    assert.deepEqual(model.asset.accessor(0), positions);
    assert.deepEqual([...model.primitives[0].indices], [0, 1, 2]);
    assert.deepEqual(requests, ['/model.gltf', '/compressed.bin']);
  } finally {engine.dispose(); await new Promise(resolve => server.close(resolve));}
  assert.ok(harness.resources.every(resource => resource.destroyed));
});

test('meshopt preserves interleaved normalized attributes and accessor offsets independently of source offsets', () => {
  const stride = 24, count = 3, decoded = new Uint8Array(count * stride), view = new DataView(decoded.buffer);
  const positions = [[-1, -1, 0], [1, -1, 0], [0, 1, 0]], uvs = [[0, 65535], [32768, 16384], [65535, 0]], colors = [[255, 0, 128, 255], [1, 64, 254, 128], [0, 255, 32, 0]];
  for (let i = 0; i < count; i++) {
    positions[i].forEach((value, axis) => view.setFloat32(i * stride + axis * 4, value, true));
    uvs[i].forEach((value, axis) => view.setUint16(i * stride + 12 + axis * 2, value, true));
    decoded.set(colors[i], i * stride + 16); decoded.fill(0xa5, i * stride + 20, (i + 1) * stride);
  }
  const {doc, source} = compressedView(encodeLanes(decoded, count, stride), count, stride);
  doc.bufferViews[0].byteStride = stride;
  doc.accessors = [{bufferView: 0, componentType: 5126, count, type: 'VEC3'},
    {bufferView: 0, byteOffset: 12, componentType: 5123, normalized: true, count, type: 'VEC2'},
    {bufferView: 0, byteOffset: 16, componentType: 5121, normalized: true, count, type: 'VEC4'}];
  const asset = new GLTFAsset(doc, [source]);
  assert.deepEqual(asset.view(0), decoded);
  assert.deepEqual([...asset.accessor(0)], positions.flat());
  assert.deepEqual([...asset.accessor(1)], uvs.flat().map(value => Math.fround(value / 65535)));
  assert.deepEqual([...asset.accessor(2)], colors.flat().map(value => Math.fround(value / 255)));
});

test('GLTFAsset decodes every checked-in meshopt mode and filter reference with an offset compressed source', () => {
  for (const vector of referenceVectors) {
    const {doc, source} = compressedView(bytes(vector.encoded), vector.count, vector.stride, vector.mode, vector.filter);
    assert.deepEqual(new GLTFAsset(doc, [source]).view(0), bytes(vector.expected), vector.name);
  }
});

test('meshopt filters feed ordinary signed-normalized and floating-point accessors', () => {
  for (const name of ['octahedral4', 'octahedral8', 'quaternion', 'exponential']) {
    const vector = referenceVectors.find(vector => vector.name === name), expected = bytes(vector.expected);
    const {doc, source} = compressedView(bytes(vector.encoded), vector.count, vector.stride, vector.mode, vector.filter);
    const floating = name === 'exponential', size = name === 'octahedral4' ? 1 : floating ? 4 : 2, width = floating ? 3 : 4;
    doc.accessors = [{bufferView: 0, componentType: floating ? 5126 : size === 1 ? 5120 : 5122, count: vector.count, type: floating ? 'VEC3' : 'VEC4', normalized: !floating}];
    const reference = new DataView(expected.buffer, expected.byteOffset, expected.byteLength);
    const values = Array.from({length: vector.count * width}, (_, i) => floating ? reference.getFloat32(i * size, true) : Math.fround(Math.max(-1, (size === 1 ? reference.getInt8(i) : reference.getInt16(i * size, true)) / (size === 1 ? 127 : 32767))));
    assert.deepEqual([...new GLTFAsset(doc, [source]).accessor(0)], values, name);
  }
});

test('meshopt rejects invalid fallback references, parent layouts, and source ranges', () => {
  const mutations = [
    doc => {doc.buffers[1].byteLength--;},
    doc => {doc.bufferViews[0].byteStride = 16;},
    doc => {doc.bufferViews[0].extensions.EXT_meshopt_compression.byteOffset++;},
    doc => {doc.buffers[0].extensions = {EXT_meshopt_compression: {fallback: true}};},
    doc => {doc.buffers[1].extensions = {EXT_meshopt_compression: {fallback: true}}; doc.bufferViews.push({buffer: 1, byteLength: 4});},
    doc => {doc.bufferViews[0].extensions.EXT_meshopt_compression.filter = 'OCTAHEDRAL';},
    doc => {doc.bufferViews[0].extensions.EXT_meshopt_compression.mode = 'TRIANGLES';},
  ];
  for (const mutate of mutations) {
    const {doc, source} = triangle(); mutate(doc);
    assert.throws(() => new GLTFAsset(doc, [source]).view(0), /glTF|meshopt/i);
  }
});
