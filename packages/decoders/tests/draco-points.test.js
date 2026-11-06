// Draco point clouds (@margoengine/decoders/draco-points): real files from the Draco repository and a cloud written by Draco's own
// encoder, on the full decoder build; and the glTF build's refusal, which must point here. The worker runs in decoders-browser.js.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { decodeDraco, decodeDracoPoints, dracoPointsTransferables } from '../dist/codec.js';
import { DracoPointsDecoder } from '../dist/draco-points.js';

// Emscripten's wrappers take their Node path from these two globals.
globalThis.require ??= createRequire(import.meta.url);
globalThis.__dirname ??= fileURLToPath(new URL('.', import.meta.url));

const fixture = (name) => new Uint8Array(readFileSync(new URL(`./fixtures/draco-points/${name}`, import.meta.url))),
  records = JSON.parse(readFileSync(new URL('./fixtures/draco-points/records.json', import.meta.url), 'utf8')),
  build = async (folder) => {
    (0, eval)(readFileSync(new URL(`../dist/${folder}/draco_wasm_wrapper.js`, import.meta.url), 'utf8'));
    return new Promise((resolve, reject) => {
      globalThis
        .DracoDecoderModule({ wasmBinary: readFileSync(new URL(`../dist/${folder}/draco_decoder.wasm`, import.meta.url)) })
        .then((module) => resolve({ module }), reject);
    });
  },
  { module: full } = await build('draco-full'),
  { module: gltf } = await build('draco');

test('real point clouds decode whole, with indices and every attribute', () => {
  for (const [name, record] of Object.entries(records)) {
    const cloud = decodeDracoPoints(full, fixture(name));
    assert.equal(cloud.pointCount, record.pointCount, name);
    assert.ok(cloud.indices instanceof Uint16Array, name);
    assert.deepEqual([...cloud.indices], Array.from({ length: cloud.pointCount }, (_, i) => i), name);
    assert.deepEqual(
      cloud.attributes.map(({ name, semantic, uniqueId, itemSize, normalized, array }) => [
        name,
        semantic,
        uniqueId,
        itemSize,
        normalized,
        array.constructor.name,
        array.length / itemSize,
        createHash('sha256').update(new Uint8Array(array.buffer)).digest('hex'),
      ]),
      record.attributes,
      name,
    );
  }
});

test('generic attributes keep their types, names and values', () => {
  const cloud = decodeDracoPoints(full, fixture('survey.drc')),
    count = 1000,
    byName = Object.fromEntries(cloud.attributes.map((attribute) => [attribute.name, attribute])),
    values = (make) => Array.from({ length: count }, (_, i) => make(i));
  assert.equal(cloud.pointCount, count);
  assert.deepEqual(Object.keys(byName), ['POSITION', 'intensity', 'classification', 'GENERIC_2', 'GENERIC_3', 'COLOR_0']);
  assert.deepEqual(
    [...byName.POSITION.array],
    values((i) => [i % 10, Math.floor(i / 10) % 10, Math.floor(i / 100)]).flat(),
  );
  assert.ok(byName.intensity.array instanceof Float32Array);
  assert.deepEqual([...byName.intensity.array], values((i) => i / 4));
  assert.ok(byName.classification.array instanceof Uint8Array);
  assert.deepEqual([...byName.classification.array], values((i) => i % 7));
  assert.ok(byName.GENERIC_2.array instanceof Uint16Array);
  assert.deepEqual([...byName.GENERIC_2.array], values((i) => 40000 + i));
  assert.ok(byName.GENERIC_3.array instanceof Int32Array);
  assert.deepEqual([...byName.GENERIC_3.array], values((i) => i - 500));
  assert.equal(byName.intensity.semantic, 'GENERIC');
  assert.equal(byName.COLOR_0.semantic, 'COLOR');
  assert.equal(byName.COLOR_0.itemSize, 3);
  assert.equal(byName.COLOR_0.normalized, true);
  assert.equal(new Set(cloud.attributes.map((attribute) => attribute.uniqueId)).size, 6);
  assert.equal(new Set(dracoPointsTransferables(cloud)).size, 7);
});

test('65,536 points or more get 32-bit indices', () => {
  const cloud = decodeDracoPoints(full, fixture('wide.drc'));
  assert.equal(cloud.pointCount, 70000);
  assert.ok(cloud.indices instanceof Uint32Array);
  assert.equal(cloud.indices[69999], 69999);
  assert.deepEqual([...cloud.attributes[0].array.subarray(69998)], [69998, 69999]);
});

test('limits apply before any output, and a mesh or a damaged file is refused', () => {
  const bytes = fixture('survey.drc');
  assert.throws(() => decodeDracoPoints(full, bytes, { limits: { maxVertices: 999 } }), /raise maxVertices/);
  assert.throws(() => decodeDracoPoints(full, bytes, { limits: { maxDecodedBytes: 2000 } }), /raise maxDecodedBytes/);
  assert.throws(() => decodeDracoPoints(full, bytes.subarray(0, 5)), TypeError);
  assert.throws(() => decodeDracoPoints(full, bytes.subarray(0, 40)), (error) => error.code === 'failed' && /re-export/.test(error.message));
  const mesh = new Uint8Array(readFileSync(new URL('./fixtures/Box.bin', import.meta.url)));
  assert.throws(() => decodeDracoPoints(full, mesh.subarray(mesh.indexOf(0x44))), /a mesh, not a point cloud; decode it with DracoDecoder/);
});

test('regression: the glTF build says where point clouds go, and no longer calls a good file damaged', () => {
  assert.throws(
    () => decodeDraco(gltf, fixture('pc_color.drc')),
    (error) =>
      error.code === 'unsupported' &&
      /decode point clouds with DracoPointsDecoder from @margoengine\/decoders\/draco-points/.test(error.message) &&
      !/damaged/.test(error.message),
  );
});

test('DracoPointsDecoder is free to build and names what it needs where there are no workers', async () => {
  const decoder = new DracoPointsDecoder({ workerLimit: 1 });
  await assert.rejects(decoder.decode(fixture('survey.drc')), (error) => error.code === 'unsupported');
  decoder.dispose();
});
