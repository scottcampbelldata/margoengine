// HANDOFF 1f.j: the worker path (dist/workers/gltf.js + modelFromPrepared) builds the same model as main-thread parsing,
// compared byte for byte: document, buffers, every accessor, packed vertices/indices, materials, images and the node
// transforms/hierarchy written into the engine's transform store.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
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
