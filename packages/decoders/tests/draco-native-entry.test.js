import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { gzipSync } from 'node:zlib';
import { bundleBytes } from '../../../scripts/measure-size.js';
import { fileURLToPath } from 'node:url';
import { readBaseline } from '../../../scripts/quality/ratchet.js';
import { decodeNativeDraco, decodeNativePoints } from '../dist/draco-native-codec.js';
import { DracoDecoder, DracoPointsDecoder } from '@margoengine/decoders/draco-native';

const fixture = (name) => new Uint8Array(readFileSync(new URL(`./fixtures/${name}`, import.meta.url)));
const {
  instance: { exports: module },
} = await WebAssembly.instantiate(readFileSync(new URL('../dist/draco-native.wasm', import.meta.url)));

test('optional Draco metadata strings preserve opaque conversion and require the exact raw name key', () => {
  const rows = JSON.parse(new TextDecoder().decode(fixture('draco-metadata-strings.json')));
  assert.equal(rows.length, 1445);
  for (const { id, bytes, expected } of rows) {
    const result = decodeNativePoints(module, Uint8Array.from(bytes));
    assert.equal(result.attributes[0].name, expected, id);
    assert.deepEqual([...result.attributes[0].array], [2.5, -7.25, 11.125], id);
  }
});

test('optional Draco metadata strings never read past the value: missing group bytes are zero (E25)', () => {
  // The opaque binding's result for these 22 streams changes with the value's length while every stream byte after
  // the value stays the same, so the bytes it reads past the terminator come from its own memory, not the bitstream.
  // Margo reads them as zero: the opaque decoder's own result for the same value carrying explicit zero bytes.
  const rows = JSON.parse(new TextDecoder().decode(fixture('draco-metadata-past-value.json')));
  assert.equal(rows.length, 22);
  for (const { id, bytes, opaqueOriginal, opaqueZeroPadded } of rows) {
    assert.notEqual(opaqueOriginal, opaqueZeroPadded, id);
    assert.equal(decodeNativePoints(module, Uint8Array.from(bytes)).attributes[0].name, opaqueZeroPadded, id);
  }
});

test('optional Draco entry has a registered transfer budget, a smaller Wasm, and no default-entry import', {
  timeout: 60_000,
}, async () => {
  const root = fileURLToPath(new URL('../../../', import.meta.url));
  const bytes = await bundleBytes(fileURLToPath(new URL('../dist/draco-native.js', import.meta.url)));
  const budget = readBaseline(root, 'sizes').items['@margoengine/decoders/draco-native'];
  assert.ok(Number.isSafeInteger(budget), 'register the new optional entry in the size ratchet');
  assert.ok(gzipSync(bytes).length <= budget, 'optional entry stays in its registered transfer budget');
  const wasm = readFileSync(new URL('../dist/draco-native.wasm', import.meta.url));
  assert.ok(wasm.length <= 192420, 'no larger than the smaller opaque prebuilt target');
  assert.ok(gzipSync(wasm, { level: 9 }).length <= 63395, 'same compressor as the recorded prebuilt target');
  const defaults = await bundleBytes(fileURLToPath(new URL('../dist/index.js', import.meta.url)));
  assert.ok(!defaults.includes(Buffer.from('draco-native')), 'default entry does not reference the optional decoder');
});

test('optional Draco entry: real point-cloud bytes, types, names and indices match frozen opaque records', () => {
  const records = JSON.parse(new TextDecoder().decode(fixture('draco-points/records.json')));
  for (const [name, record] of Object.entries(records)) {
    const cloud = decodeNativePoints(module, fixture(`draco-points/${name}`));
    assert.equal(cloud.pointCount, record.pointCount, name);
    assert.deepEqual(
      [...cloud.indices],
      Array.from({ length: cloud.pointCount }, (_, i) => i),
    );
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

test('optional Draco entry: normalized accessors, explicit IDs, subsets and output budgets', () => {
  const doc = JSON.parse(new TextDecoder().decode(fixture('NormalizedTriangle.gltf'))),
    bytes = fixture('NormalizedTriangle.bin');
  const primitive = doc.meshes[0].primitives[0],
    attributeIds = primitive.extensions.KHR_draco_mesh_compression.attributes;
  const componentTypes = Object.fromEntries(
    Object.keys(attributeIds).map((name) => [name, doc.accessors[primitive.attributes[name]].componentType]),
  );
  const result = decodeNativeDraco(module, bytes, { attributeIds, componentTypes });
  assert.deepEqual([...result.uvs], [0, 0, 255, 0, 0, 255]);
  const colors = [255, 128, 0, 255, 0, 255, 128, 255, 128, 0, 255, 255].map((v) => Math.fround(v / 255));
  assert.deepEqual([...result.colors], colors);
  const defaults = decodeNativeDraco(module, bytes, { attributeIds });
  assert.deepEqual([...defaults.uvs], [0, 0, 1, 0, 0, 1]);
  assert.deepEqual([...defaults.colors], colors);
  const onlyUV = decodeNativeDraco(module, bytes, { attributeIds: { TEXCOORD_0: attributeIds.TEXCOORD_0 } });
  assert.equal(onlyUV.positions.length, 0);
  assert.deepEqual(onlyUV.uvs, defaults.uvs);
  const outputBytes = onlyUV.indices.byteLength + onlyUV.uvs.byteLength;
  assert.deepEqual(
    decodeNativeDraco(module, bytes, {
      attributeIds: { TEXCOORD_0: attributeIds.TEXCOORD_0 },
      limits: { maxDecodedBytes: outputBytes },
    }),
    onlyUV,
  );
  assert.throws(() => decodeNativeDraco(module, bytes, { limits: { maxDecodedBytes: 1 } }), /byte limit/);
  assert.throws(() => decodeNativeDraco(module, bytes, { limits: { maxVertices: 1 } }), /limit/);
  assert.throws(() => decodeNativeDraco(module, bytes, { attributeIds: { POSITION: 9999 } }), /missing attribute/);
  assert.throws(
    () => decodeNativeDraco(module, bytes, { attributeIds, limits: { attributeWidths: { POSITION: 4 } } }),
    /width/,
  );
});

test('optional Draco entry: corrupt data returns coded errors, frees allocations and leaves valid decodes usable', () => {
  const valid = fixture('NormalizedTriangle.bin');
  const expected = decodeNativeDraco(module, valid);
  for (let end = 1; end < valid.length; end++)
    assert.throws(
      () => decodeNativeDraco(module, valid.subarray(0, end)),
      (e) => typeof e.code === 'string',
    );
  const settled = module.memory.buffer.byteLength;
  for (let i = 0; i < 100; i++) assert.deepEqual(decodeNativeDraco(module, valid), expected);
  assert.equal(module.memory.buffer.byteLength, settled);
});

test('optional Draco constructors are lazy and SSR safe; invalid options fail before input transfer', async () => {
  const mesh = new DracoDecoder(),
    points = new DracoPointsDecoder();
  try {
    await assert.rejects(mesh.decode(fixture('NormalizedTriangle.bin')), (e) => e.code === 'unsupported');
    await assert.rejects(points.decode(fixture('draco-points/survey.drc')), (e) => e.code === 'unsupported');
    assert.throws(() => new DracoDecoder({ workerLimit: 0 }), RangeError);
    assert.throws(() => new DracoPointsDecoder({ timeout: 0 }), RangeError);
  } finally {
    mesh[Symbol.dispose]();
    points[Symbol.dispose]();
  }
});
