// Lossless GLB augmentation: split/join keep every chunk, and appended meshes (collision proxies) leave the existing
// JSON, BIN bytes, extras and unknown chunks as they were.
import test from 'node:test';
import assert from 'node:assert/strict';
import { appendGLBMeshes, exportGLB, joinGLB, splitGLB } from '../dist/index.js';
import { accessor, readGLB, validate, validator } from './helpers.js';

const needsValidator = validator ? {} : { skip: 'gltf-validator not installed' };
const cube = (size) => ({
  positions: [
    0,
    0,
    0,
    size,
    0,
    0,
    size,
    size,
    0,
    0,
    size,
    0,
    0,
    0,
    size,
    size,
    0,
    size,
    size,
    size,
    size,
    0,
    size,
    size,
  ],
  indices: [
    [0, 3, 2, 1],
    [4, 5, 6, 7],
    [0, 4, 7, 3],
    [1, 2, 6, 5],
    [0, 1, 5, 4],
    [3, 7, 6, 2],
  ].flatMap(([a, b, c, d]) => [a, b, c, a, c, d]),
});
const NOTE = 0x45544f4e; // 'NOTE', a chunk type glTF 2.0 does not define

function visual() {
  const glb = exportGLB({
    nodes: [
      {
        name: 'Body',
        geometry: { ...cube(2), normals: new Array(24).fill(0).map((_, i) => (i % 3 === 2 ? 1 : 0)) },
        extras: { margo: { role: 'model', modelId: 'body' } },
      },
    ],
    extras: { margo: { stats: { quads: 6 } } },
  });
  const parts = splitGLB(glb);
  parts.json.extras.vendor = { kept: [1, 'two', null] };
  parts.chunks.push({ type: NOTE, data: new TextEncoder().encode('note') });
  return joinGLB(parts);
}

test('splitGLB and joinGLB round-trip JSON, BIN and unknown chunks', () => {
  const bytes = visual(),
    parts = splitGLB(bytes);
  assert.deepEqual(parts.json.extras.vendor, { kept: [1, 'two', null] });
  assert.equal(parts.chunks.length, 1);
  assert.equal(parts.chunks[0].type, NOTE);
  assert.equal(new TextDecoder().decode(parts.chunks[0].data), 'note');
  assert.deepEqual(joinGLB(parts), bytes, 'byte-identical after a round trip');
  assert.throws(() => splitGLB(new Uint8Array(12)), TypeError);
  const bad = bytes.slice();
  bad[20] = 0xff; // the JSON's first byte: invalid UTF-8
  assert.throws(() => splitGLB(bad), /UTF-8 JSON/);
  assert.throws(() => joinGLB({ ...parts, chunks: [{ type: NOTE, data: new Uint8Array(3) }] }), /aligned/);
});

test('appendGLBMeshes adds named proxies and keeps every existing byte', needsValidator, async () => {
  const before = visual(),
    original = splitGLB(before),
    after = appendGLBMeshes(before, [
      {
        name: 'Body-colonly',
        ...cube(2),
        volume: true,
        extras: { margo: { role: 'collision-proxy', mode: 'colonly', name: 'Body' } },
        meshExtras: { margo: { role: 'collision-proxy' } },
      },
      { name: 'Marker', positions: [0, 0, 0, 1, 0, 0, 0, 1, 0], indices: [0, 1, 2] },
    ]),
    report = await validate(after);
  assert.equal(report.errors, 0, JSON.stringify(report.messages));
  assert.deepEqual(
    report.messages.map((m) => m.code),
    ['GLB_UNKNOWN_CHUNK_TYPE'],
    'the kept NOTE chunk is the only notice',
  );
  const parts = splitGLB(after),
    { json } = parts;
  // Existing JSON members are unchanged, with the new nodes, meshes and accessors after them.
  for (const key of ['asset', 'materials']) assert.deepEqual(json[key], original.json[key], `${key} unchanged`);
  assert.deepEqual(json.nodes.slice(0, 1), original.json.nodes);
  assert.deepEqual(json.meshes.slice(0, 1), original.json.meshes);
  assert.deepEqual(json.accessors.slice(0, original.json.accessors.length), original.json.accessors);
  assert.deepEqual(json.extras, original.json.extras);
  assert.deepEqual(parts.bin.subarray(0, original.bin.length), original.bin, 'BIN prefix byte-identical');
  assert.deepEqual(parts.chunks, original.chunks, 'unknown chunk kept');
  assert.deepEqual(
    json.nodes.slice(1).map((n) => n.name),
    ['Body-colonly', 'Marker'],
  );
  assert.deepEqual(json.scenes[0].nodes, [0, 1, 2]);
  assert.deepEqual(json.nodes[1].extras, { margo: { role: 'collision-proxy', mode: 'colonly', name: 'Body' } });
  assert.deepEqual(json.meshes[1].extras, { margo: { role: 'collision-proxy' } });
  assert.equal(json.nodes[2].extras, undefined);
  const { bin } = readGLB(after),
    position = json.meshes[1].primitives[0].attributes.POSITION;
  assert.deepEqual([...accessor(json, bin, position)], cube(2).positions);
  assert.deepEqual(json.accessors[position].min, [0, 0, 0]);
  assert.deepEqual(json.accessors[position].max, [2, 2, 2]);
  assert.deepEqual(appendGLBMeshes(before, []), before);
});

test('appendGLBMeshes gives a scene-less file a scene with its existing roots', needsValidator, async () => {
  const parts = splitGLB(
    exportGLB({ nodes: [{ name: 'A', geometry: { ...cube(1), normals: new Array(24).fill(1) } }] }),
  );
  delete parts.json.scenes;
  delete parts.json.scene;
  const after = splitGLB(appendGLBMeshes(joinGLB(parts), [{ name: 'B', ...cube(1) }]));
  assert.deepEqual(after.json.scenes, [{ nodes: [0, 1] }]);
  assert.equal(after.json.scene, 0);
});

test('appendGLBMeshes refuses clashing names, flat hulls, degenerate triangles and external buffers', () => {
  const bytes = visual();
  assert.throws(() => appendGLBMeshes(bytes, [{ name: 'Body', ...cube(1) }]), /already exists/);
  assert.throws(
    () =>
      appendGLBMeshes(bytes, [
        { name: 'X', ...cube(1) },
        { name: 'X', ...cube(1) },
      ]),
    /already exists/,
  );
  assert.throws(
    () =>
      appendGLBMeshes(bytes, [
        { name: 'Flat', positions: [0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 1, 0], indices: [0, 1, 2, 1, 3, 2], volume: true },
      ]),
    /one plane/,
  );
  assert.throws(
    () => appendGLBMeshes(bytes, [{ name: 'Line', positions: [0, 0, 0, 1, 0, 0, 2, 0, 0], indices: [0, 1, 2] }]),
    /without area/,
  );
  assert.throws(
    () => appendGLBMeshes(bytes, [{ name: 'Bad', positions: [0, 0, 0, 1, 0, 0, 0, 1, 0], indices: [0, 1, 5] }]),
    /exceeds/,
  );
  assert.throws(() => appendGLBMeshes(bytes, [{ name: '', ...cube(1) }]), /nonempty name/);
  const external = splitGLB(bytes);
  external.json.buffers[0].uri = 'scene.bin';
  external.bin = null;
  assert.throws(() => appendGLBMeshes(joinGLB(external), [{ name: 'X', ...cube(1) }]), /external/);
});
