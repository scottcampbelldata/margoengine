import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { Engine, TransformStore } from '../packages/core/dist/extension.js';
import { parseGLTFAsync } from '../packages/gltf-pro/dist/index.js';
import { decodeDraco, initDraco } from '../packages/decoders/dist/codec.js';
import { optionalGPU } from './support/optional-gpu.js';

const fixture = (name) => readFile(new URL(`../packages/decoders/tests/fixtures/${name}`, import.meta.url));
const server = createServer(async (request, response) => {
  try {
    const name = new URL(request.url, 'http://localhost').pathname;
    if (!['/draco_wasm_wrapper.js', '/draco_decoder.wasm'].includes(name)) {
      response.writeHead(404);
      response.end();
      return;
    }
    response.end(await readFile(new URL(`../packages/decoders/dist/draco${name}`, import.meta.url)));
  } catch {
    response.writeHead(404);
    response.end();
  }
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
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
  const engine = new Engine(
    { width: 128, height: 96, clientWidth: 128, clientHeight: 96 },
    await TransformStore.create(32),
    { backend: 'webgpu', gpu: h.engine.gpu, add() {}, remove() {}, render() {}, dispose() {} },
    { position: [0, 0, 4], target: [0, 0, 0] },
    null,
  );
  return { engine, resources: h.resources };
}

test('glTF declarations reject real Draco vertex/index overruns before any output malloc', async () => {
  const module = await wasm(),
    source = await fixture('Box.bin');
  for (const limit of ['vertices', 'indices', 'width']) {
    const doc = JSON.parse(await fixture('Box.gltf')),
      primitive = doc.meshes[0].primitives[0];
    if (limit === 'vertices') for (const id of Object.values(primitive.attributes)) doc.accessors[id].count = 3;
    if (limit === 'indices') doc.accessors[primitive.indices].count = 3;
    if (limit === 'width') doc.accessors[primitive.attributes.NORMAL].type = 'VEC2';
    const { engine, resources } = await scene(),
      calls = [],
      guarded = Object.create(module);
    // Only explicit output extraction goes through this JS entry. Internal Wasm decode allocations are separate.
    guarded._malloc = (bytes) => {
      calls.push(bytes);
      return module._malloc(bytes);
    };
    try {
      await assert.rejects(
        parseGLTFAsync(engine, doc, [source], [], {
          draco: {
            async decode(data, options) {
              return decodeDraco(guarded, data, options);
            },
          },
        }),
        /Draco.*(limit|count|width|size|budget)/i,
      );
      assert.deepEqual(calls, [], `${limit} is rejected before output allocation`);
      assert.equal(engine.meshes.size, 0);
      assert.equal(resources.length, 0);
    } finally {
      engine.dispose();
    }
  }
});

test('declared Draco counts and widths reach the decoder and exact boundaries remain valid', async () => {
  const module = await wasm(),
    doc = JSON.parse(await fixture('Box.gltf')),
    source = await fixture('Box.bin');
  const primitive = doc.meshes[0].primitives[0],
    { engine } = await scene();
  let calls = 0;
  try {
    const model = await parseGLTFAsync(engine, doc, [source], [], {
      draco: {
        async decode(data, options) {
          calls++;
          assert.equal(options.limits.maxVertices, 24);
          assert.equal(options.limits.maxIndices, 36);
          // The load's decoded budget, 4x the 512 MiB default (@margoengine/decoders caps a decode at 256 MiB itself).
          assert.equal(options.limits.maxDecodedBytes, 4 * 512 * 1024 * 1024);
          assert.deepEqual(options.limits.attributeWidths, { POSITION: 3, NORMAL: 3 });
          return decodeDraco(module, data, options);
        },
      },
    });
    assert.equal(calls, 1);
    assert.equal(model.primitives[0].indices.length, 36);
    assert.equal(model.primitives[0].vertices.length, 24 * 20);
    assert.equal(doc.accessors[primitive.indices].count, 36);
  } finally {
    engine.dispose();
  }
});

test('non-indexed Draco topology receives a bounded index limit', async () => {
  const module = await wasm(),
    doc = JSON.parse(await fixture('Box.gltf')),
    source = await fixture('Box.bin');
  delete doc.meshes[0].primitives[0].indices;
  const { engine } = await scene();
  try {
    const model = await parseGLTFAsync(engine, doc, [source], [], {
      draco: {
        async decode(data, options) {
          // Three indices a vertex at the 2^24-vertex primitive limit (was 1,000,000, under one part of a scan).
          assert.equal(options.limits.maxIndices, 3 * 16_777_216);
          return decodeDraco(module, data, options);
        },
      },
    });
    assert.equal(model.primitives[0].indices.length, 36);
  } finally {
    engine.dispose();
  }
});

// Bug: the per-primitive decoded-byte check used the default budget (4x 64 MiB) instead of the load's own
// `maxDownloadBytes`, so a raised budget still refused a Draco primitive declaring more than 256 MiB of attributes.
test('a Draco primitive over 256 MiB declared decodes within the default and a raised maxDownloadBytes, and is refused within 64 MiB', async () => {
  const doc = JSON.parse(await fixture('Box.gltf')),
    source = await fixture('Box.bin'),
    primitive = doc.meshes[0].primitives[0],
    ext = primitive.extensions.KHR_draco_mesh_compression;
  for (const id of Object.values(primitive.attributes)) doc.accessors[id].count = 1_000_000;
  for (let i = 0; i < 18; i++) {
    primitive.attributes[`_A${i}`] = doc.accessors.length;
    ext.attributes[`_A${i}`] = 2 + i;
    doc.accessors.push({ componentType: 5126, type: 'VEC4', count: 1_000_000 });
  }
  const reached = new Error('reached the decoder'),
    draco = {
      async decode() {
        throw reached;
      },
    };
  for (const [maxDownloadBytes, expected] of [
    // The default budget is 512 MiB (2 GiB decoded): a scan's Draco primitive decodes with no options.
    [undefined, /reached the decoder/],
    [128 * 1024 * 1024, /reached the decoder/],
    [64 * 1024 * 1024, /Decoded glTF exceeds byte budget/],
  ]) {
    const { engine } = await scene();
    try {
      await assert.rejects(parseGLTFAsync(engine, structuredClone(doc), [source], [], { draco, maxDownloadBytes }), expected);
    } finally {
      engine.dispose();
    }
  }
});

// Draco primitives were capped at 1,000,000 vertices and indices while plain ones load up to 2^24 vertices as parts:
// a compressed scan was refused where its uncompressed copy loaded.
test('a Draco primitive past 1,000,000 vertices and indices reaches the decoder; past 2^24 vertices it is unsupported', async () => {
  const reached = new Error('reached the decoder');
  for (const [vertices, expected] of [
    [1_000_001, reached],
    [16_777_216, reached],
    [16_777_217, { name: 'MargoError', code: 'unsupported', message: /more than 16777216 vertices/ }],
  ]) {
    const doc = JSON.parse(await fixture('Box.gltf')),
      source = await fixture('Box.bin'),
      primitive = doc.meshes[0].primitives[0];
    for (const id of Object.values(primitive.attributes)) doc.accessors[id].count = vertices;
    doc.accessors[primitive.indices].count = 3_000_003;
    let limits;
    const draco = {
        async decode(_data, options) {
          limits = options.limits;
          throw reached;
        },
      },
      { engine } = await scene();
    try {
      await assert.rejects(parseGLTFAsync(engine, doc, [source], [], { draco }), expected);
      if (expected === reached) assert.deepEqual([limits.maxVertices, limits.maxIndices], [vertices, 3_000_003]);
    } finally {
      engine.dispose();
    }
  }
});
