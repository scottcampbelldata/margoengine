// GAP-FILM-DRACO-NODE: Node has no Web Worker, and every Draco decoder refused there (pool.ts requireWorkers), so a
// Draco glTF could not load in Node at all. They now decode in the calling thread with the same Wasm and the same decode
// functions the workers run; elsewhere without workers (an edge runtime) they still refuse by name.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { DracoDecoder } from '../dist/index.js';
import { DracoPointsDecoder } from '../dist/draco-points.js';
import { DracoDecoder as NativeDracoDecoder, DracoPointsDecoder as NativePointsDecoder } from '../dist/draco-native.js';
import { decodeDraco, decodeDracoPoints } from '../dist/codec.js';
import { decodeNativeDraco, decodeNativePoints } from '../dist/draco-native-codec.js';

const fixture = (name) => new Uint8Array(readFileSync(new URL(`./fixtures/${name}`, import.meta.url)));
const dist = new URL('../dist/', import.meta.url);
// The reference: Google's build evaluated as the worker's importScripts does, outside the code under test.
// Emscripten reaches for a global `require` and `__dirname` in Node; they are set only while the reference loads, so the decoders under
// test never see them.
const reference = async (folder) => {
  globalThis.require = createRequire(import.meta.url);
  globalThis.__dirname = fileURLToPath(new URL(`${folder}/`, dist));
  try {
    (0, eval)(readFileSync(new URL(`${folder}/draco_wasm_wrapper.js`, dist), 'utf8'));
    const factory = globalThis.DracoDecoderModule,
      wasmBinary = readFileSync(new URL(`${folder}/draco_decoder.wasm`, dist)).slice().buffer;
    // The Emscripten module is thenable: box it so the promise does not unwrap it.
    return (
      await new Promise((resolve, reject) => factory({ wasmBinary }).then((module) => resolve({ module }), reject))
    ).module;
  } finally {
    delete globalThis.require;
    delete globalThis.__dirname;
  }
};
/** The Draco bytes of a glTF primitive, its attribute ids and its accessors. */
const primitive = (name) => {
  const doc = JSON.parse(new TextDecoder().decode(fixture(`${name}.gltf`))),
    bin = fixture(`${name}.bin`),
    p = doc.meshes[0].primitives[0],
    ext = p.extensions.KHR_draco_mesh_compression,
    view = doc.bufferViews[ext.bufferView],
    start = view.byteOffset ?? 0;
  return { bytes: bin.slice(start, start + view.byteLength), attributeIds: ext.attributes, doc, p };
};
/** Hide Node from the decoders for one synchronous call, as an edge runtime without workers looks. */
const withoutNode = (run) => {
  const saved = Object.getOwnPropertyDescriptor(process.versions, 'node');
  Object.defineProperty(process.versions, 'node', { value: undefined, configurable: true });
  try {
    return run();
  } finally {
    Object.defineProperty(process.versions, 'node', saved);
  }
};

test('DracoDecoder decodes the Khronos Draco Box and Avocado in Node, as the worker decode does', async () => {
  assert.equal(typeof Worker, 'undefined');
  using decoder = new DracoDecoder();
  for (const name of ['Box', 'Avocado']) {
    const { bytes, attributeIds, doc, p } = primitive(name),
      request = { attributeIds, componentTypes: { TANGENT: 5126 } },
      got = await decoder.decode(bytes, request);
    assert.equal(got.vertexCount, doc.accessors[p.attributes.POSITION].count, name);
    assert.equal(got.indices.length, doc.accessors[p.indices].count, name);
    assert.deepEqual(got, decodeDraco(await reference('draco'), bytes, request), `${name} equals the worker decode`);
  }
});

test('DracoDecoder in Node honours limits, aborts and a decoderPath on disk, and refuses a web decoderPath', async () => {
  const { bytes, attributeIds } = primitive('Box');
  using local = new DracoDecoder({ decoderPath: fileURLToPath(new URL('draco/', dist)) });
  assert.equal((await local.decode(bytes, { attributeIds })).vertexCount, 24);
  using fileURL = new DracoDecoder({ decoderPath: new URL('draco', dist).href });
  assert.equal((await fileURL.decode(bytes, { attributeIds })).vertexCount, 24);
  using web = new DracoDecoder({ decoderPath: 'https://www.gstatic.com/draco/versioned/decoders/1.5.7/' });
  await assert.rejects(
    web.decode(bytes, { attributeIds }),
    (e) => e.code === 'unsupported' && /from disk/.test(e.message),
  );
  using decoder = new DracoDecoder();
  await assert.rejects(decoder.decode(bytes, { attributeIds, limits: { maxVertices: 3 } }), RangeError);
  const stop = new AbortController();
  stop.abort(new Error('stopped'));
  await assert.rejects(decoder.decode(bytes, { attributeIds, signal: stop.signal }), /stopped/);
  // A bad file is the decoder's own coded error, and the decoder still works afterwards.
  await assert.rejects(
    decoder.decode(bytes.slice(0, 40), { attributeIds }),
    (e) => typeof e.code === 'string' || e instanceof RangeError || e instanceof TypeError,
  );
  assert.equal((await decoder.decode(bytes, { attributeIds })).vertexCount, 24);
});

test('DracoPointsDecoder decodes a Draco point cloud in Node, as the worker decode does', async () => {
  const bytes = fixture('draco-points/survey.drc');
  using decoder = new DracoPointsDecoder();
  const got = await decoder.decode(bytes);
  assert.ok(got.pointCount > 0);
  assert.deepEqual(got, decodeDracoPoints(await reference('draco-full'), bytes, {}));
});

test('the clean-room draco-native decoders decode in Node, as their worker does', async () => {
  const { bytes, attributeIds } = primitive('NormalizedTriangle'),
    module = (await WebAssembly.instantiate(readFileSync(new URL('draco-native.wasm', dist)))).instance.exports;
  using mesh = new NativeDracoDecoder();
  assert.deepEqual(await mesh.decode(bytes, { attributeIds }), decodeNativeDraco(module, bytes, { attributeIds }));
  const cloud = fixture('draco-points/survey.drc');
  using points = new NativePointsDecoder();
  assert.deepEqual(await points.decode(cloud), decodeNativePoints(module, cloud, {}));
});

test('without workers outside Node every Draco decoder still refuses by name', async () => {
  const { bytes } = primitive('Box');
  for (const decoder of [
    new DracoDecoder(),
    new DracoPointsDecoder(),
    new NativeDracoDecoder(),
    new NativePointsDecoder(),
  ]) {
    const pending = withoutNode(() => decoder.decode(bytes));
    await assert.rejects(pending, (e) => e.code === 'unsupported' && /Web Workers/.test(e.message));
    decoder.dispose();
  }
});
