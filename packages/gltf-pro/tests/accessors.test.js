// HANDOFF 5l.p: examples/conveyor-simulator/Untitled.glb (Blender I/O 5.3) was rejected with "Unsupported glTF accessor"
// only because two uint32 index accessors held more than 1,000,000 elements (accessor 174: 1,021,494 for mesh 66
// "Mesh_16"; accessor 487: 1,480,944 for mesh 171 "Mesh_15"). The decoded-size budget bounds accessors now; vertices
// stay capped at 1M per primitive on both the main-thread and worker paths. Errors name mesh, primitive and accessor.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {parseGLTFAsync, PBRModel} from '../dist/index.js';
import {instancing} from '../dist/instancing.js';
import {instancedGLTF} from '../../../tests/support/instanced-gltf.js';
import {modelFromPrepared} from '../dist/worker.js';
import {runParseWorker, assertSameBytes} from '../../../tests/support/parse-worker.js';
import {headless, headlessModels} from '../../../tests/support/pbr-snapshot.js';

const worker = new URL('../dist/workers/gltf.js', import.meta.url), realSetup = PBRModel.prototype.setup; // before any test stubs it
/** A one-mesh GLB; each accessor is {data: TypedArray, type, componentType, ...extra accessor fields}. */
function glb(attributes, indices) {
  const chunks = [], accessors = [], bufferViews = [], width = {SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT3: 9};
  let length = 0;
  const add = ({data, type, componentType, ...extra}) => {
    chunks.push(new Uint8Array(data.buffer, data.byteOffset, data.byteLength), new Uint8Array(-data.byteLength & 3));
    bufferViews.push({buffer: 0, byteOffset: length, byteLength: data.byteLength}); length += data.byteLength + (-data.byteLength & 3);
    accessors.push({bufferView: bufferViews.length - 1, componentType, count: data.length / width[type], type, ...extra}); return accessors.length - 1;
  };
  const primitive = {attributes: Object.fromEntries(Object.entries(attributes).map(([key, value]) => [key, add(value)]))};
  if (indices) primitive.indices = add(indices);
  const doc = {asset: {version: '2.0'}, scene: 0, scenes: [{nodes: [0]}], nodes: [{mesh: 0}], meshes: [{name: 'part', primitives: [primitive]}], accessors, bufferViews, buffers: [{byteLength: length}]};
  const json = new TextEncoder().encode(JSON.stringify(doc).padEnd(Math.ceil(JSON.stringify(doc).length / 4) * 4)), out = new Uint8Array(28 + json.length + length), view = new DataView(out.buffer);
  view.setUint32(0, 0x46546c67, true); view.setUint32(4, 2, true); view.setUint32(8, out.length, true);
  view.setUint32(12, json.length, true); view.setUint32(16, 0x4e4f534a, true); out.set(json, 20);
  view.setUint32(20 + json.length, length, true); view.setUint32(24 + json.length, 0x004e4942, true);
  let at = 28 + json.length; for (const chunk of chunks) {out.set(chunk, at); at += chunk.length;}
  return out;
}
const triangle = {POSITION: {data: Float32Array.of(0, 0, 0, 1, 0, 0, 0, 1, 0), type: 'VEC3', componentType: 5126, min: [0, 0, 0], max: [1, 1, 0]}};
/** Main-thread parse and worker parse of the same bytes; asserts both packed identical geometry. */
async function both(bytes) {
  const main = await parseGLTFAsync(await headless(), bytes.slice());
  const prepared = await runParseWorker(worker, {url: 'https://example.test/', input: bytes.slice().buffer});
  assert.ok(prepared.geometry.flat().every(Boolean), 'the worker packed every primitive');
  const viaWorker = modelFromPrepared(await headless(), prepared);
  assertSameBytes(viaWorker.primitives.map(p => [p.vertices, p.indices]), main.primitives.map(p => [p.vertices, p.indices]));
  return main;
}

test('an index accessor with more than 1,000,000 uint32 elements decodes exactly (the conveyor GLB case)', () => headlessModels(async () => {
  const count = 1_000_002, indices = Uint32Array.from({length: count}, (_, i) => i % 3);
  const model = await both(glb(triangle, {data: indices, type: 'SCALAR', componentType: 5125}));
  assert.equal(model.asset.doc.accessors[1].count, count);
  assertSameBytes(model.primitives[0].indices, indices);
  assertSameBytes(model.asset.accessor(1), Float32Array.from(indices));
}));

test('more than 1,000,000 vertices in one primitive is still refused, naming the mesh and primitive, on both paths', () => headlessModels(async () => {
  const bytes = glb({POSITION: {data: new Float32Array(1_000_002 * 3).map((_, i) => i % 7), type: 'VEC3', componentType: 5126}}), error = /^RangeError: glTF mesh 0 "part" primitive 0: Expected bounded triangle geometry$/;
  await assert.rejects(parseGLTFAsync(await headless(), bytes.slice()), e => error.test(String(e)));
  const prepared = await runParseWorker(worker, {url: 'https://example.test/', input: bytes.slice().buffer});
  const engine = await headless();
  assert.throws(() => modelFromPrepared(engine, prepared), e => error.test(String(e)));
}));

test('an accessor gltf-pro cannot decode names mesh, primitive, attribute and accessor', () => headlessModels(async () => {
  const bytes = glb({...triangle, COLOR_0: {data: new Float32Array(27).fill(0.5), type: 'MAT3', componentType: 5126}});
  const message = 'glTF mesh 0 "part" primitive 0: COLOR_0 (accessor 1): Unsupported glTF accessor 1 (componentType 5126, type MAT3)';
  await assert.rejects(parseGLTFAsync(await headless(), bytes.slice()), {name: 'TypeError', message});
  const prepared = await runParseWorker(worker, {url: 'https://example.test/', input: bytes.slice().buffer});
  const engine = await headless();
  assert.throws(() => modelFromPrepared(engine, prepared), {name: 'TypeError', message});
}));

// The real file is a Git LFS object: skipped where only the pointer is checked out.
const conveyor = await readFile(new URL('../../../examples/conveyor-simulator/Untitled.glb', import.meta.url)).catch(() => null);
const real = conveyor?.length > 12 && conveyor.readUInt32LE(0) === 0x46546c67;
test('the 62 MB conveyor GLB parses on the main thread and in the worker, with identical geometry', {skip: !real && 'Untitled.glb is not checked out (git lfs pull)'}, () => headlessModels(async () => {
  const model = await both(new Uint8Array(conveyor.buffer, conveyor.byteOffset, conveyor.byteLength));
  assert.equal(model.primitives.length, 570); // 242 meshes drawn by 570 nodes
  // HANDOFF 5l.r: each mesh is packed once and shared by its nodes (was 570 packs, ~231 MB; now ~174 MB).
  assert.equal(new Set(model.primitives.map(p => p.vertices)).size, 242);
  assert.equal(new Set(model.primitives.map(p => p.indices)).size, 242);
  assert.equal(model.primitives.reduce((sum, p) => sum + p.indices.length / 3, 0), 2_445_355);
  assert.equal(model.asset.accessor(487).length, 1_480_944);
}));

// HANDOFF 5l.r: the main-thread path packs a mesh once and its nodes share the arrays, so PBRModel.setup (whose upload
// cache is keyed by array) creates one vertex and one index buffer per mesh primitive, like the worker path.
test('nodes sharing a mesh share its packed arrays and GPU buffers; uploads equal the worker-packed bytes', () => headlessModels(async () => {
  const {doc, buffers} = instancedGLTF([{t: [0, 0, 0]}, {t: [2, 0, 0]}]);
  doc.nodes.push({mesh: 0, translation: [0, 3, 0]}, {mesh: 0, scale: [2, 2, 2]});
  const engine = await headless(), model = await parseGLTFAsync(engine, doc, {buffers, decoders: {instancing}}), [a, b, c] = model.primitives;
  assert.equal(model.primitives.length, 3);
  assert.ok(b.vertices === a.vertices && c.vertices === a.vertices && b.indices === a.indices && c.indices === a.indices);
  assert.equal(a.instances.count, 2); assert.equal(b.instances, undefined); assert.notEqual(b.node, c.node);
  const created = [], dummy = () => ({});
  globalThis.GPUBufferUsage ??= {MAP_READ: 1, COPY_SRC: 4, COPY_DST: 8, INDEX: 16, VERTEX: 32, UNIFORM: 64, STORAGE: 128, INDIRECT: 256};
  globalThis.GPUTextureUsage ??= {COPY_SRC: 1, COPY_DST: 2, TEXTURE_BINDING: 4, STORAGE_BINDING: 8, RENDER_ATTACHMENT: 16};
  Object.defineProperty(model['engine'], 'gpu', {configurable: true, value: {limits: {maxBufferSize: 2 ** 28, maxTextureDimension2D: 8192},
    createBuffer: d => {const buffer = {...d, data: new Uint8Array(d.size)}; created.push(buffer); return buffer;},
    queue: {writeBuffer: (buffer, at, data) => buffer.data.set(new Uint8Array(data.buffer, data.byteOffset, data.byteLength), at), writeTexture() {}},
    createTexture: () => ({createView: dummy}), createSampler: dummy}});
  realSetup.call(model, model['engine']);
  const resources = model['resources'], geometry = created.filter(buffer => buffer.usage & (GPUBufferUsage.VERTEX | GPUBufferUsage.INDEX));
  assert.equal(geometry.length, 2);
  assert.ok(resources.every(r => r.vertex === resources[0].vertex && r.index === resources[0].index));
  const prepared = await runParseWorker(worker, {url: 'https://example.test/', input: doc, buffers});
  assertSameBytes([resources[0].vertex.data, resources[0].index.data], [prepared.geometry[0][0].vertices, prepared.geometry[0][0].indices].map(v => new Uint8Array(v.buffer, v.byteOffset, v.byteLength)));
}));

test('maxDownloadBytes bounds main-thread and worker loads, and the error names the option', () => headlessModels(async () => {
  const bytes = glb(triangle), url = 'https://example.test/', message = `glTF exceeds download budget (${bytes.length - 1} bytes; raise the maxDownloadBytes option)`;
  await assert.rejects(parseGLTFAsync(await headless(), bytes.slice(), {maxDownloadBytes: bytes.length - 1}), {name: 'RangeError', message});
  await assert.rejects(runParseWorker(worker, {url, input: bytes.slice().buffer, maxDownloadBytes: bytes.length - 1}), {name: 'RangeError', message});
  assert.equal((await parseGLTFAsync(await headless(), bytes.slice(), {maxDownloadBytes: bytes.length})).asset.maxBytes, bytes.length);
  const prepared = await runParseWorker(worker, {url, input: bytes.slice().buffer, maxDownloadBytes: bytes.length});
  assert.equal(modelFromPrepared(await headless(), prepared).asset.maxBytes, bytes.length);
  for (const maxDownloadBytes of [0, -1, 1.5, Infinity]) await assert.rejects(parseGLTFAsync(await headless(), bytes.slice(), {maxDownloadBytes}), {name: 'RangeError', message: 'maxDownloadBytes must be a positive integer'});
}));
