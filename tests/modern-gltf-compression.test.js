import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createServer} from 'node:http';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {Engine, TransformStore} from '../packages/core/dist/extension.js';
import {GLTFAsset, loadGLTF, parseGLTF, parseGLTFAsync} from '../packages/gltf-pro/dist/index.js';
import {decodeDraco, initDraco} from '../packages/decoders/dist/codec.js';
import {optionalGPU} from './support/optional-gpu.js';

const fixture = name => readFile(new URL(`../packages/decoders/tests/fixtures/${name}`, import.meta.url));
const routes = new Map();
const server = createServer(async (request, response) => {
  const path = new URL(request.url, 'http://localhost').pathname;
  try {
    const data = routes.get(path) ?? (path.startsWith('/draco/') ? await readFile(new URL(`../packages/decoders/dist${path}`, import.meta.url)) : undefined);
    if (!data) {response.writeHead(404); response.end(); return;}
    response.writeHead(200, {'content-type': path.endsWith('.wasm') ? 'application/wasm' : path.endsWith('.js') ? 'text/javascript' : 'application/octet-stream'});
    response.end(data);
  } catch {response.writeHead(404); response.end();}
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
test.after(() => server.close());

// The bundled Emscripten wrapper uses CommonJS helpers when it detects Node.
globalThis.require ??= createRequire(import.meta.url);
globalThis.__dirname ??= fileURLToPath(new URL('.', import.meta.url));
let dracoModule;
async function realDraco(data, options) {
  dracoModule ??= initDraco(`${base}/draco/draco_wasm_wrapper.js`, `${base}/draco/draco_decoder.wasm`);
  const {module} = await dracoModule;
  const bytes = data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  return decodeDraco(module, bytes, options);
}

async function scene() {
  const harness = optionalGPU(), store = await TransformStore.create(32);
  harness.engine.gpu.limits.maxTextureDimension2D = 8192;
  const renderer = {backend: 'webgpu', gpu: harness.engine.gpu, add() {}, remove() {}, render() {}, dispose() {}};
  const engine = new Engine({width: 128, height: 96, clientWidth: 128, clientHeight: 96}, store, renderer, {position: [0, 0, 4], target: [0, 0, 0]}, null);
  return {engine, resources: harness.resources};
}
function geometry() {
  return {vertexCount: 3, positions: new Float32Array([-1, -1, 0, 1, -1, 0, 0, 1, 0]), normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]), indices: new Uint16Array([0, 1, 2]), attributes: {}};
}
function compressedTriangle() {
  const doc = {asset: {version: '2.0'}, extensionsRequired: ['KHR_draco_mesh_compression'], buffers: [{byteLength: 4}], bufferViews: [{buffer: 0, byteLength: 4}],
    accessors: [{componentType: 5126, count: 3, type: 'VEC3'}, {componentType: 5126, count: 3, type: 'VEC3'}, {componentType: 5123, count: 3, type: 'SCALAR'}],
    meshes: [{primitives: [{attributes: {POSITION: 0, NORMAL: 1}, indices: 2, extensions: {KHR_draco_mesh_compression: {bufferView: 0, attributes: {POSITION: 5, NORMAL: 7}}}}]}], nodes: [{mesh: 0}]};
  return {doc, buffers: [new Uint8Array([1, 2, 3, 4])]};
}
function glb(doc, binary) {
  const copy = structuredClone(doc); delete copy.buffers[0].uri;
  const json = new TextEncoder().encode(JSON.stringify(copy)), jsonLength = (json.length + 3) & ~3, binLength = (binary.byteLength + 3) & ~3;
  const data = new Uint8Array(12 + 8 + jsonLength + 8 + binLength), view = new DataView(data.buffer);
  view.setUint32(0, 0x46546c67, true); view.setUint32(4, 2, true); view.setUint32(8, data.length, true);
  view.setUint32(12, jsonLength, true); view.setUint32(16, 0x4e4f534a, true); data.fill(32, 20, 20 + jsonLength); data.set(json, 20);
  view.setUint32(20 + jsonLength, binLength, true); view.setUint32(24 + jsonLength, 0x004e4942, true); data.set(binary, 28 + jsonLength);
  return data;
}
function withoutTextures(doc) {
  delete doc.images; delete doc.textures; delete doc.samplers; delete doc.materials;
  for (const mesh of doc.meshes) for (const primitive of mesh.primitives) delete primitive.material;
  return doc;
}

test('asynchronous parsing decodes real required Draco Box and Avocado geometry into GPU primitives', async () => {
  for (const name of ['Box', 'Avocado']) {
    const {engine, resources} = await scene(), doc = withoutTextures(JSON.parse(await fixture(`${name}.gltf`))), bytes = await fixture(`${name}.bin`);
    const before = structuredClone(doc), requests = [];
    try {
      const model = await parseGLTFAsync(engine, doc, [bytes], [], {draco: {decode(data, options) {requests.push(options); return realDraco(data, options);}}});
      const primitive = model.primitives[0], definition = doc.meshes[0].primitives[0], position = doc.accessors[definition.attributes.POSITION];
      assert.equal(model.primitives.length, 1);
      assert.equal(primitive.vertices.length, position.count * 20);
      assert.equal(primitive.indices.length, doc.accessors[definition.indices].count);
      assert.ok(primitive.indices.every(index => index < position.count));
      assert.ok(primitive.vertices.every(Number.isFinite));
      for (let vertex = 0; vertex < position.count; vertex++) {
        for (let axis = 0; axis < 3; axis++) {
          const value = primitive.vertices[vertex * 20 + axis];
          assert.ok(value >= position.min[axis] - 1e-4 && value <= position.max[axis] + 1e-4, `${name} decoded positions match accessor bounds`);
        }
        assert.ok(Math.abs(Math.hypot(...primitive.vertices.subarray(vertex * 20 + 4, vertex * 20 + 7)) - 1) < 1e-6);
      }
      assert.equal(requests.length, 1);
      assert.deepEqual(requests[0].attributeIds, definition.extensions.KHR_draco_mesh_compression.attributes);
      if (name === 'Avocado') {
        assert.equal(requests[0].componentTypes.TANGENT, 5126);
        assert.ok(primitive.vertices.some((value, index) => index % 20 === 12 && value !== 0), 'decoded UVs reach the PBR vertex buffer');
        assert.ok(primitive.vertices.some((value, index) => index % 20 === 11 && Math.abs(value) === 1), 'decoded tangents reach the PBR vertex buffer');
      }
      assert.deepEqual(doc, before, 'decoding does not rewrite the caller document');
    } finally {engine.dispose();}
    assert.ok(resources.every(resource => resource.destroyed));
  }
});

test('real normalized Draco UVs and colors reach cached accessors and GPU vertices exactly once', async () => {
  const {engine} = await scene(), doc = JSON.parse(await fixture('NormalizedTriangle.gltf')), bytes = await fixture('NormalizedTriangle.bin');
  const uv = [0, 0, 1, 0, 0, 1], color = [255, 128, 0, 255, 0, 255, 128, 255, 128, 0, 255, 255].map(value => Math.fround(value / 255));
  try {
    const model = await parseGLTFAsync(engine, doc, [bytes], [], {draco: {decode: realDraco}}), primitive = model.primitives[0];
    assert.deepEqual([...model.asset.accessor(1)], uv);
    assert.deepEqual([...model.asset.accessor(2)], color);
    assert.equal(model.asset.accessor(1), model.asset.accessor(1), 'decoded accessors bypass repeated normalization');
    for (let vertex = 0; vertex < 3; vertex++) {
      assert.deepEqual([...primitive.vertices.subarray(vertex * 20 + 12, vertex * 20 + 14)], uv.slice(vertex * 2, vertex * 2 + 2));
      assert.deepEqual([...primitive.vertices.subarray(vertex * 20 + 16, vertex * 20 + 20)], color.slice(vertex * 4, vertex * 4 + 4));
    }
    assert.deepEqual([...primitive.indices], [0, 1, 2]);
  } finally {engine.dispose();}
});

test('loadGLTF decodes external compressed glTF buffers and a compressed GLB', async () => {
  const doc = JSON.parse(await fixture('Box.gltf')), bytes = await fixture('Box.bin');
  routes.set('/models/Box.gltf', JSON.stringify(doc)); routes.set('/models/Box.bin', bytes); routes.set('/models/Box.glb', glb(doc, bytes));
  for (const suffix of ['gltf', 'glb']) {
    const {engine} = await scene();
    try {
      const model = await loadGLTF(engine, `${base}/models/Box.${suffix}`, {draco: {decode: realDraco}});
      assert.equal(model.primitives[0].vertices.length, 24 * 20);
      assert.equal(model.primitives[0].indices.length, 36);
    } finally {engine.dispose();}
  }
});

test('Draco attribute subsets preserve ordinary POSITION accessors while decoding NORMAL', async () => {
  const {engine} = await scene(), doc = JSON.parse(await fixture('Box.gltf')), bytes = await fixture('Box.bin');
  const primitive = doc.meshes[0].primitives[0], decoded = await realDraco(bytes, {attributeIds: primitive.extensions.KHR_draco_mesh_compression.attributes});
  const view = doc.bufferViews.length;
  doc.buffers.push({byteLength: decoded.positions.byteLength});
  doc.bufferViews.push({buffer: 1, byteLength: decoded.positions.byteLength});
  doc.accessors[primitive.attributes.POSITION].bufferView = view;
  delete primitive.extensions.KHR_draco_mesh_compression.attributes.POSITION;
  try {
    const model = await parseGLTFAsync(engine, doc, [bytes, decoded.positions], [], {draco: {decode: realDraco}});
    assert.deepEqual([...model.asset.accessor(primitive.attributes.POSITION)], [...decoded.positions]);
    assert.equal(model.primitives[0].indices.length, 36);
    assert.ok(model.primitives[0].vertices.every(Number.isFinite));
  } finally {engine.dispose();}
});

test('Draco overrides fallback accessors, preserves extra normalized channels, and decodes an instanced mesh once', async () => {
  const {engine} = await scene(), {doc, buffers} = compressedTriangle(), decoded = geometry();
  const primitive = doc.meshes[0].primitives[0];
  const extras = [['TEXCOORD_1', 'VEC2', 5121, true, new Uint8Array([0, 255, 128, 64, 255, 0])], ['WEIGHTS_0', 'VEC4', 5121, true, new Uint8Array([255, 0, 0, 0, 128, 127, 0, 0, 0, 0, 255, 0])], ['JOINTS_0', 'VEC4', 5123, false, new Uint16Array([0, 1, 2, 3, 3, 2, 1, 0, 1, 1, 1, 1])]];
  for (const [semantic, type, componentType, normalized, array] of extras) {
    primitive.attributes[semantic] = doc.accessors.length;
    primitive.extensions.KHR_draco_mesh_compression.attributes[semantic] = doc.accessors.length + 20;
    doc.accessors.push({componentType, count: 3, type, normalized});
    decoded.attributes[semantic] = {array, itemSize: type === 'VEC2' ? 2 : 4, componentType};
  }
  // Deliberately invalid fallback data must never be read for a decoded attribute.
  doc.accessors[0].bufferView = 0;
  doc.nodes.push({mesh: 0});
  let calls = 0, disposed = 0;
  const draco = {async decode() {calls++; return decoded;}, dispose() {disposed++;}};
  try {
    const model = await parseGLTFAsync(engine, doc, buffers, [], {draco});
    assert.equal(calls, 1); assert.equal(disposed, 0, 'caller-owned decoders remain usable');
    assert.equal(model.primitives.length, 2);
    assert.deepEqual([...model.asset.accessor(primitive.attributes.TEXCOORD_1)], [0, 1, Math.fround(128 / 255), Math.fround(64 / 255), 1, 0]);
    assert.equal(model.asset.accessor(primitive.attributes.WEIGHTS_0)[4], Math.fround(128 / 255));
    assert.deepEqual([...model.asset.accessor(primitive.attributes.JOINTS_0)], [...decoded.attributes.JOINTS_0.array]);
    assert.deepEqual([...model.primitives[0].vertices.subarray(0, 3)], [-1, -1, 0]);
  } finally {engine.dispose();}
});

// Small valid meshoptimizer v0 ATTRIBUTES stream, using literal byte lanes.
function encodeLanes(bytes, count, stride) {
  const output = [0xa0];
  for (let lane = 0; lane < stride; lane++) {
    output.push(3); let previous = 0;
    for (let vertex = 0; vertex < 16; vertex++) {
      const value = vertex < count ? bytes[vertex * stride + lane] : previous;
      let delta = (value - previous) & 255; if (delta > 127) delta -= 256;
      output.push(((delta << 1) ^ (delta >> 7)) & 255); previous = value;
    }
  }
  output.push(...new Uint8Array(32)); return new Uint8Array(output);
}
function meshoptTriangle() {
  const positions = geometry().positions, encoded = encodeLanes(new Uint8Array(positions.buffer), 3, 12), indices = new Uint8Array([0xe1, 0xf0, ...new Uint8Array(16)]);
  const packed = new Uint8Array(encoded.length + indices.length); packed.set(encoded); packed.set(indices, encoded.length);
  const doc = {asset: {version: '2.0'}, extensionsRequired: ['EXT_meshopt_compression'],
    buffers: [{byteLength: packed.length}, {byteLength: 42, extensions: {EXT_meshopt_compression: {fallback: true}}}],
    bufferViews: [{buffer: 1, byteLength: 36, byteStride: 12, extensions: {EXT_meshopt_compression: {buffer: 0, byteLength: encoded.length, byteStride: 12, count: 3, mode: 'ATTRIBUTES'}}},
      {buffer: 1, byteOffset: 36, byteLength: 6, extensions: {EXT_meshopt_compression: {buffer: 0, byteOffset: encoded.length, byteLength: indices.length, byteStride: 2, count: 3, mode: 'TRIANGLES'}}}],
    accessors: [{bufferView: 0, componentType: 5126, count: 3, type: 'VEC3'}, {bufferView: 1, componentType: 5123, count: 3, type: 'SCALAR'}],
    meshes: [{primitives: [{attributes: {POSITION: 0}, indices: 1}]}], nodes: [{mesh: 0}]};
  return {doc, buffers: [packed]};
}

test('meshopt attributes and triangle indices decode synchronously without fallback bytes or workers', async () => {
  const {engine} = await scene(), {doc, buffers} = meshoptTriangle();
  try {
    const model = parseGLTF(engine, doc, buffers);
    assert.deepEqual([...model.primitives[0].indices], [0, 1, 2]);
    assert.deepEqual([...model.asset.accessor(0)], [...geometry().positions]);
    assert.equal(model.asset.view(0), model.asset.view(0), 'decoded views are cached');
    assert.equal(model.asset.view(0).byteLength, 36);
    assert.deepEqual([...model.primitives[0].vertices.subarray(4, 7)], [0, 0, 1]);
  } finally {engine.dispose();}
  routes.set('/meshopt/triangle.gltf', JSON.stringify({...doc, buffers: [{...doc.buffers[0], uri: 'triangle.bin'}, doc.buffers[1]]}));
  routes.set('/meshopt/triangle.bin', buffers[0]);
  const loaded = await scene();
  try {assert.deepEqual([...(await loadGLTF(loaded.engine, `${base}/meshopt/triangle.gltf`)).primitives[0].indices], [0, 1, 2]);}
  finally {loaded.engine.dispose();}
});

test('meshopt EXPONENTIAL filtering matches reference bytes and rejects malformed streams and allocations', async () => {
  const {cases} = JSON.parse(await fixture('meshopt-vectors.json')), vector = cases.find(value => value.name === 'exponential');
  const data = Uint8Array.from(Buffer.from(vector.encoded, 'base64'));
  const doc = {asset: {version: '2.0'}, extensionsRequired: ['EXT_meshopt_compression'], buffers: [{byteLength: data.length}, {byteLength: vector.count * vector.stride, extensions: {EXT_meshopt_compression: {fallback: true}}}], bufferViews: [{buffer: 1, byteLength: vector.count * vector.stride,
    extensions: {EXT_meshopt_compression: {buffer: 0, byteLength: data.length, count: vector.count, byteStride: vector.stride, mode: vector.mode, filter: vector.filter}}}]};
  assert.deepEqual(new GLTFAsset(doc, [data]).view(0), Uint8Array.from(Buffer.from(vector.expected, 'base64')));
  for (const change of [ext => {ext.count++;}, ext => {ext.byteStride = 0;}, ext => {ext.filter = 'UNKNOWN';}, ext => {ext.mode = 'UNKNOWN';}, ext => {ext.byteLength = data.length + 1;}, ext => {ext.count = 1_000_000_000;}]) {
    const invalid = structuredClone(doc); change(invalid.bufferViews[0].extensions.EXT_meshopt_compression);
    assert.throws(() => new GLTFAsset(invalid, [data]).view(0), /meshopt|glTF|budget|limit|stride|length|bounds/i);
  }
  const oversized = structuredClone(doc), length = 300 * 1024 * 1024;
  oversized.buffers[1].byteLength = oversized.bufferViews[0].byteLength = length;
  Object.assign(oversized.bufferViews[0].extensions.EXT_meshopt_compression, {count: length / 4, byteStride: 4, filter: 'NONE'});
  assert.throws(() => new GLTFAsset(oversized, [data]).view(0), /byte budget/, 'reject a valid declared decoded layout before allocation');
});

test('Draco topology is retained when the primitive omits an index accessor', async () => {
  const {engine} = await scene(), {doc, buffers} = compressedTriangle(), decoded = geometry();
  delete doc.meshes[0].primitives[0].indices;
  decoded.indices = new Uint16Array([0, 2, 1, 2, 0, 1]);
  try {
    const model = await parseGLTFAsync(engine, doc, buffers, [], {draco: {async decode() {return decoded;}}});
    assert.deepEqual([...model.primitives[0].indices], [...decoded.indices]);
    assert.equal(model.primitives[0].vertices.length, 60);
  } finally {engine.dispose();}
});

test('Draco validates decoded counts, widths, indices and finite attributes before creating GPU resources', async () => {
  const mutations = [
    [doc => {doc.accessors[0].count = 4;}, () => {}],
    [() => {}, decoded => {decoded.vertexCount = 4;}],
    [() => {}, decoded => {decoded.positions = new Float32Array(8);}],
    [() => {}, decoded => {decoded.normals = new Float32Array(8);}],
    [() => {}, decoded => {decoded.indices = new Uint16Array([0, 1, 3]);}],
    [() => {}, decoded => {decoded.indices = undefined;}],
    [() => {}, decoded => {decoded.indices = new Uint16Array([0, 1]);}],
    [doc => {doc.accessors[2].componentType = 5121;}, decoded => {decoded.vertexCount = 257; decoded.indices = new Uint16Array([0, 1, 256]);}],
    [() => {}, decoded => {decoded.positions[0] = NaN;}],
    [doc => {doc.accessors[0].count = 1_000_001;}, () => {}],
    [doc => {doc.meshes[0].primitives[0].extensions.KHR_draco_mesh_compression.attributes.POSITION = -1;}, () => {}],
  ];
  for (const [mutateDoc, mutateDecoded] of mutations) {
    const {engine, resources} = await scene(), {doc, buffers} = compressedTriangle(), decoded = geometry();
    mutateDoc(doc); mutateDecoded(decoded);
    try {
      await assert.rejects(parseGLTFAsync(engine, doc, buffers, [], {draco: {async decode() {return decoded;}}}), /Draco|glTF|accessor|attribute|indices|triangle|vertex|count|finite|budget|bounded/i);
      assert.equal(engine.meshes.size, 0);
      assert.equal(resources.length, 0);
    } finally {engine.dispose();}
  }
});

test('unsupported required extensions and synchronous Draco parsing fail clearly while ordinary parsing remains synchronous', async () => {
  const {engine} = await scene(), {doc, buffers} = compressedTriangle();
  try {
    assert.throws(() => parseGLTF(engine, doc, buffers), {message: 'Draco geometry requires parseGLTFAsync or loadGLTF'});
    doc.extensionsRequired.push('VENDOR_unknown');
    await assert.rejects(parseGLTFAsync(engine, doc, buffers, [], {draco: {async decode() {throw new Error('must not decode');}}}), /Required.*VENDOR_unknown|VENDOR_unknown.*unsupported/i);
    const plain = meshoptTriangle();
    const positions = geometry().positions; plain.doc.extensionsRequired = []; plain.doc.buffers = [{byteLength: positions.byteLength}];
    plain.doc.bufferViews = [{buffer: 0, byteLength: positions.byteLength}]; plain.doc.accessors.length = 1; delete plain.doc.meshes[0].primitives[0].indices;
    const model = parseGLTF(engine, plain.doc, [positions]);
    assert.equal(typeof model.then, 'undefined'); assert.deepEqual([...model.primitives[0].indices], [0, 1, 2]);
  } finally {engine.dispose();}
});

test('automatic browser Draco owns its workers on success, failure, and abort', async () => {
  const globals = ['window', 'Worker'].map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]), workers = [];
  let behavior = 'success', posted;
  globalThis.window = {};
  globalThis.Worker = class {
    constructor(url, options) {this.url = url; this.options = options; this.terminated = false; workers.push(this);}
    postMessage(message) {
      posted?.();
      queueMicrotask(() => {if (this.terminated || behavior === 'hang') return; this.onmessage?.({data: behavior === 'failure' ? {id: message.id, error: 'Draco: invalid fixture'} : {id: message.id, result: geometry()}});});
    }
    terminate() {this.terminated = true;}
  };
  try {
    for (behavior of ['success', 'failure', 'hang']) {
      const {engine} = await scene(), {doc, buffers} = compressedTriangle(), controller = new AbortController();
      try {
        let started; const start = new Promise(resolve => {started = resolve;}); posted = started;
        const pending = parseGLTFAsync(engine, doc, buffers, [], {signal: controller.signal});
        if (behavior === 'success') assert.equal((await pending).primitives.length, 1);
        else if (behavior === 'failure') await assert.rejects(pending, /invalid fixture/);
        else {await start; const reason = new Error('cancelled during decode'); controller.abort(reason); await assert.rejects(pending, error => error === reason);}
        assert.ok(workers.at(-1).terminated, `${behavior} releases the temporary decoder worker`);
        if (behavior !== 'success') assert.equal(engine.meshes.size, 0);
      } finally {engine.dispose();}
    }
    const controller = new AbortController(), reason = new Error('cancelled before decode'); controller.abort(reason);
    const {engine} = await scene(), {doc, buffers} = compressedTriangle(), count = workers.length;
    try {await assert.rejects(parseGLTFAsync(engine, doc, buffers, [], {signal: controller.signal}), error => error === reason); assert.equal(workers.length, count);}
    finally {engine.dispose();}
  } finally {
    for (const [name, descriptor] of globals) {if (descriptor) Object.defineProperty(globalThis, name, descriptor); else delete globalThis[name];}
  }
});
