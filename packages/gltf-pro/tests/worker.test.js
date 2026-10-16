// HANDOFF 1f.j: the worker path (dist/workers/gltf.js + modelFromPrepared) builds the same model as main-thread parsing,
// compared byte for byte: document, buffers, every accessor, packed vertices/indices, materials, images and the node
// transforms/hierarchy written into the engine's transform store.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { DracoDecoder, KTX2Decoder } from '../../decoders/dist/index.js';
import { parseGLTFAsync } from '../dist/index.js';
import { modelFromPrepared, parseGLTFInWorker } from '../dist/worker.js';
import { instancing } from '../dist/instancing.js';
import { runParseWorker, assertSameBytes } from '../../../tests/support/parse-worker.js';
import { headless, headlessModels, snapshot } from '../../../tests/support/pbr-snapshot.js';
import { bigGLB } from '../../../tests/support/big-glb.js';

const worker = new URL('../dist/workers/gltf.js', import.meta.url);
const asset = (name) => readFile(new URL(`../../../examples/assets/${name}`, import.meta.url));

for (const [name, load] of [
  ['DamagedHelmet (textured, tangents)', () => asset('damaged-helmet.glb')],
  ['RobotExpressive (skins, morph targets, animations)', () => asset('robot-expressive.glb')],
  ['generated 2 x 66k-vertex grids (one without normals)', async () => bigGLB({ segments: 256, meshes: 2 })],
  [
    'generated grids drawn 50 times each through EXT_mesh_gpu_instancing',
    async () => bigGLB({ segments: 16, meshes: 2, instances: 50 }),
  ],
])
  test(`worker-parsed glTF equals main-thread parse: ${name}`, () =>
    headlessModels(async () => {
      const glb = new Uint8Array(await load());
      const decoders = name.includes('instancing') ? { instancing } : {},
        main = await parseGLTFAsync(await headless(), glb.slice(), { decoders });
      const prepared = await runParseWorker(worker, { url: 'https://example.test/', input: glb.slice().buffer });
      const viaWorker = modelFromPrepared(await headless(), prepared, undefined, decoders);
      assert.ok(main.primitives.length > 0);
      if (decoders.instancing)
        for (const model of [main, viaWorker]) assert.equal(model.primitives[0].instances.count, 50);
      assertSameBytes(snapshot(viaWorker), snapshot(main));
      // The worker packed every primitive, so the main thread decoded nothing.
      assert.ok(prepared.geometry.flat().every(Boolean));
    }));

test('a primitive the worker cannot pack is packed (and fails) on the main thread as before', () =>
  headlessModels(async () => {
    const glb = bigGLB({ segments: 4, meshes: 1 }),
      length = new DataView(glb.buffer).getUint32(12, true),
      json = new TextDecoder().decode(glb.subarray(20, 20 + length));
    glb.set(new TextEncoder().encode(json.replace('"material":0', '"mode":7'.padEnd(12))), 20); // no such topology, same JSON length
    const prepared = await runParseWorker(worker, { url: 'https://example.test/', input: glb.slice().buffer }),
      engine = await headless();
    assert.deepEqual(prepared.geometry, [[null]]);
    assert.throws(() => modelFromPrepared(engine, prepared), /Invalid glTF primitive mode/);
    await assert.rejects(parseGLTFAsync(await headless(), glb), /Invalid glTF primitive mode/);
  }));

test('worker errors keep their type; without Worker the entry falls back to the main thread', () =>
  headlessModels(async () => {
    await assert.rejects(
      runParseWorker(worker, {
        url: 'https://example.test/',
        input: new Uint8Array([0x67, 0x6c, 0x54, 0x46, 2, 0, 0, 0, 9, 0, 0, 0]).buffer,
      }),
      { name: 'RangeError', message: 'Invalid GLB size' },
    );
    assert.equal(typeof Worker, 'undefined');
    const model = await parseGLTFInWorker(await headless(), bigGLB({ segments: 2, meshes: 1 }));
    assert.equal(model.primitives[0].vertices.length, 9 * 20);
  }));

test('parser workers defer automatic Draco and KTX2 decoding with transferable source buffers', async () => {
  const compressed = {
    asset: { version: '2.0' },
    buffers: [{ byteLength: 4 }],
    bufferViews: [{ buffer: 0, byteLength: 4 }],
    accessors: [{ componentType: 5126, count: 3, type: 'VEC3' }],
    meshes: [
      {
        primitives: [
          {
            attributes: { POSITION: 0 },
            extensions: { KHR_draco_mesh_compression: { bufferView: 0, attributes: { POSITION: 0 } } },
          },
        ],
      },
    ],
    nodes: [{ mesh: 0 }],
  };
  for (const doc of [
    compressed,
    {
      ...compressed,
      meshes: [],
      nodes: [],
      textures: [{ extensions: { KHR_texture_basisu: { source: 0 } } }],
      images: [{ uri: 'normal.ktx2', mimeType: 'image/ktx2' }],
    },
  ]) {
    const prepared = await runParseWorker(worker, {
      url: 'https://example.test/models/model.gltf',
      input: doc,
      buffers: [new Uint8Array([1, 2, 3, 4])],
    });
    assert.equal(prepared.deferred, true);
    assertSameBytes(prepared.buffers[0], new Uint8Array([1, 2, 3, 4]));
    assert.equal(prepared.baseURL, 'https://example.test/models/model.gltf');
    assert.deepEqual(prepared.images, []);
  }
});

test('worker loader completes automatic codecs on the owning thread and preserves original buffers', () =>
  headlessModels(async () => {
    const saved = { Worker: globalThis.Worker, location: globalThis.location },
      decode = DracoDecoder.prototype.decode,
      transcode = KTX2Decoder.prototype.transcode;
    let parserJobs = 0,
      dracoJobs = 0,
      ktxJobs = 0;
    globalThis.location = { href: 'https://example.test/models/model.gltf' };
    globalThis.Worker = class {
      postMessage(message) {
        parserJobs++;
        runParseWorker(worker, message).then(
          (result) => this.onmessage?.({ data: { result } }),
          (error) => this.onmessage?.({ data: { error: { name: error.name, message: error.message } } }),
        );
      }
      terminate() {}
    };
    DracoDecoder.prototype.decode = async () => {
      dracoJobs++;
      return {
        vertexCount: 3,
        positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
        indices: new Uint16Array([0, 1, 2]),
      };
    };
    KTX2Decoder.prototype.transcode = async () => {
      ktxJobs++;
      return {
        target: 'rgba8',
        format: 'rgba8unorm',
        srgb: false,
        hasAlpha: false,
        width: 4,
        height: 4,
        mipmaps: [{ width: 4, height: 4, data: new Uint8Array(64), byteLength: 64 }],
      };
    };
    try {
      const buffer = new Uint8Array(84),
        view = new DataView(buffer.buffer);
      buffer.set([171, 75, 84, 88, 32, 50, 48, 187, 13, 10, 26, 10], 4);
      for (const [at, n] of [
        [20, 4],
        [24, 4],
        [36, 1],
        [40, 1],
      ])
        view.setUint32(4 + at, n, true);
      const doc = {
        asset: { version: '2.0' },
        buffers: [{ byteLength: buffer.length }],
        bufferViews: [
          { buffer: 0, byteLength: 4 },
          { buffer: 0, byteOffset: 4, byteLength: 80 },
        ],
        accessors: [{ componentType: 5126, count: 3, type: 'VEC3' }],
        meshes: [
          {
            primitives: [
              {
                attributes: { POSITION: 0 },
                extensions: { KHR_draco_mesh_compression: { bufferView: 0, attributes: { POSITION: 0 } } },
              },
            ],
          },
        ],
        nodes: [{ mesh: 0 }],
        images: [{ bufferView: 1, mimeType: 'image/ktx2' }],
      };
      const model = await parseGLTFInWorker(await headless(), doc, { buffers: [buffer.slice()] });
      assert.equal(parserJobs, 1);
      assert.equal(dracoJobs, 1);
      assert.equal(ktxJobs, 1);
      assert.deepEqual([...model.primitives[0].indices], [0, 1, 2]);
      assert.equal(model.images[0].ktx2.width, 4);
      assertSameBytes(model.asset.buffers[0], buffer);
      const caller = await parseGLTFInWorker(await headless(), doc, {
        buffers: [buffer.slice()],
        draco: { decode: DracoDecoder.prototype.decode },
        ktx2: { transcode: KTX2Decoder.prototype.transcode },
      });
      assert.equal(parserJobs, 1, 'caller-owned codecs stay on the main thread');
      assert.deepEqual([...caller.primitives[0].indices], [0, 1, 2]);
    } finally {
      DracoDecoder.prototype.decode = decode;
      KTX2Decoder.prototype.transcode = transcode;
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete globalThis[key];
        else globalThis[key] = value;
      }
    }
  }));
