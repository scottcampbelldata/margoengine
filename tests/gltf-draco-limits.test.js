import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createServer} from 'node:http';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {Engine, TransformStore} from '../packages/core/dist/extension.js';
import {parseGLTFAsync} from '../packages/gltf-pro/dist/index.js';
import {decodeDraco, initDraco} from '../packages/decoders/dist/codec.js';
import {optionalGPU} from './support/optional-gpu.js';

const fixture = name => readFile(new URL(`../packages/decoders/tests/fixtures/${name}`, import.meta.url));
const server = createServer(async (request, response) => {
  try {
    const name = new URL(request.url, 'http://localhost').pathname;
    if (!['/draco_wasm_wrapper.js', '/draco_decoder.wasm'].includes(name)) {response.writeHead(404); response.end(); return;}
    response.end(await readFile(new URL(`../packages/decoders/dist/draco${name}`, import.meta.url)));
  } catch {response.writeHead(404); response.end();}
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
test.after(() => server.close());
globalThis.require ??= createRequire(import.meta.url);
globalThis.__dirname ??= fileURLToPath(new URL('.', import.meta.url));
const base = `http://127.0.0.1:${server.address().port}`;
let modulePromise;
async function wasm() {
  modulePromise ??= initDraco(`${base}/draco_wasm_wrapper.js`, `${base}/draco_decoder.wasm`);
  return (await modulePromise).module;
}
async function scene() {
  const h = optionalGPU();
  const engine = new Engine({width: 128, height: 96, clientWidth: 128, clientHeight: 96}, await TransformStore.create(32),
    {backend: 'webgpu', gpu: h.engine.gpu, add() {}, remove() {}, render() {}, dispose() {}},
    {position: [0, 0, 4], target: [0, 0, 0]}, null);
  return {engine, resources: h.resources};
}

test('glTF declarations reject real Draco vertex/index overruns before any output malloc', async () => {
  const module = await wasm(), source = await fixture('Box.bin');
  for (const limit of ['vertices', 'indices', 'width']) {
    const doc = JSON.parse(await fixture('Box.gltf')), primitive = doc.meshes[0].primitives[0];
    if (limit === 'vertices') for (const id of Object.values(primitive.attributes)) doc.accessors[id].count = 3;
    if (limit === 'indices') doc.accessors[primitive.indices].count = 3;
    if (limit === 'width') doc.accessors[primitive.attributes.NORMAL].type = 'VEC2';
    const {engine, resources} = await scene(), calls = [], guarded = Object.create(module);
    // Only explicit output extraction goes through this JS entry. Internal Wasm decode allocations are separate.
    guarded._malloc = bytes => {calls.push(bytes); return module._malloc(bytes);};
    try {
      await assert.rejects(parseGLTFAsync(engine, doc, [source], [], {
        draco: {async decode(data, options) {return decodeDraco(guarded, data, options);}},
      }), /Draco.*(limit|count|width|size|budget)/i);
      assert.deepEqual(calls, [], `${limit} is rejected before output allocation`);
      assert.equal(engine.meshes.size, 0);
      assert.equal(resources.length, 0);
    } finally {engine.dispose();}
  }
});

test('declared Draco counts and widths reach the decoder and exact boundaries remain valid', async () => {
  const module = await wasm(), doc = JSON.parse(await fixture('Box.gltf')), source = await fixture('Box.bin');
  const primitive = doc.meshes[0].primitives[0], {engine} = await scene();
  let calls = 0;
  try {
    const model = await parseGLTFAsync(engine, doc, [source], [], {draco: {async decode(data, options) {
      calls++;
      assert.equal(options.limits.maxVertices, 24);
      assert.equal(options.limits.maxIndices, 36);
      assert.equal(options.limits.maxDecodedBytes, 256 * 1024 * 1024);
      assert.deepEqual(options.limits.attributeWidths, {POSITION: 3, NORMAL: 3});
      return decodeDraco(module, data, options);
    }}});
    assert.equal(calls, 1);
    assert.equal(model.primitives[0].indices.length, 36);
    assert.equal(model.primitives[0].vertices.length, 24 * 20);
    assert.equal(doc.accessors[primitive.indices].count, 36);
  } finally {engine.dispose();}
});

test('non-indexed Draco topology receives a bounded index limit', async () => {
  const module = await wasm(), doc = JSON.parse(await fixture('Box.gltf')), source = await fixture('Box.bin');
  delete doc.meshes[0].primitives[0].indices;
  const {engine} = await scene();
  try {
    const model = await parseGLTFAsync(engine, doc, [source], [], {draco: {async decode(data, options) {
      assert.equal(options.limits.maxIndices, 1_000_000);
      return decodeDraco(module, data, options);
    }}});
    assert.equal(model.primitives[0].indices.length, 36);
  } finally {engine.dispose();}
});
