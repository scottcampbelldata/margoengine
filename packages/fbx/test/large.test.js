import test from 'node:test';
import assert from 'node:assert/strict';
import { headless, headlessModels } from '../../../tests/support/pbr-snapshot.js';
import { runParseWorker } from '../../../tests/support/parse-worker.js';
import { modelFromPrepared } from '../../gltf-pro/dist/worker.js';
import { convertFBX, parseFBX } from '../dist/index.js';
import { largeFBX } from '../dist/large.js';
import { rigFixture, readGLB } from './native-scene-helper.js';
import { binary, A, L } from './fixtures.js';
const small = new TextEncoder().encode(rigFixture({ skin: false, morph: false, animation: false }));
test('large import defaults are explicit, immutable, independent and validated', () => {
  const ext = largeFBX();
  assert.equal(ext.limits.inputBytes, 512 * 1024 * 1024);
  assert.equal(ext.limits.vertices, 8_000_000);
  assert.ok(Object.isFrozen(ext) && Object.isFrozen(ext.limits));
  for (const value of [0, -1, NaN, Infinity, 1.5, Number.MAX_SAFE_INTEGER + 1])
    assert.throws(() => largeFBX({ vertices: value }), /positive safe integer/);
  assert.throws(() => largeFBX({ typo: 1 }), /limit typo/);
  assert.equal(largeFBX({ vertices: 3 }).limits.vertices, 3);
  assert.equal(ext.limits.vertices, 8_000_000);
});
test('every cumulative cap still rejects through the optional entry', async () => {
  for (const [key, value, pattern] of [
    ['inputBytes', 32, /byte budget/],
    ['decodedBytes', 1, /decoded byte/],
    ['arrayBytes', 1, /array byte/],
    ['nodes', 1, /node budget/],
    ['properties', 1, /property budget/],
    ['parseWork', 1, /work budget/],
    ['sceneBytes', 1, /allocation budget/],
    ['sceneWork', 1, /work budget/],
    ['vertices', 2, /geometry budget/],
    ['corners', 2, /geometry budget/],
    ['geometryWork', 1, /geometry budget/],
    ['outputBytes', 1, /conversion budget/],
  ])
    await assert.rejects(convertFBX(small, { extensions: [largeFBX({ [key]: value })] }), pattern, key);
  await assert.rejects(convertFBX(small, { extensions: [largeFBX(), largeFBX()] }), /Multiple FBX limit/);
  const abort = new AbortController();
  abort.abort(new Error('cancel large import'));
  await assert.rejects(convertFBX(small, { extensions: [largeFBX()], signal: abort.signal }), /cancel large import/);
  assert.deepEqual(
    new Uint8Array(await convertFBX(small, { extensions: [largeFBX()] })),
    new Uint8Array(await convertFBX(small)),
  );
});
test('a 200 MiB ASCII input imports with an explicit cap and unchanged output', { timeout: 120000 }, async () => {
  const bytes = new Uint8Array(200 * 1024 * 1024);
  bytes.fill(32);
  bytes.set(small);
  bytes[small.length] = 59;
  await assert.rejects(convertFBX(bytes), /byte budget/);
  const glb = await convertFBX(bytes, { extensions: [largeFBX({ inputBytes: bytes.length })] });
  assert.deepEqual(new Uint8Array(glb), new Uint8Array(await convertFBX(small)));
});
test('binary with 2,500,002 distinct expanded vertices retains every index and position', {
  timeout: 240000,
}, async () => {
  const count = 2_500_002,
    positions = new Float32Array(count * 3),
    indices = new Int32Array(count);
  for (let i = 0; i < count; i++) {
    const corner = i % 3;
    positions[i * 3] = Math.floor(i / 3) * 2 + (corner === 1 ? 1 : 0);
    positions[i * 3 + 1] = corner === 2 ? 1 : 0;
    indices[i] = corner === 2 ? ~i : i;
  }
  const bytes = binary([
    [
      'Objects',
      [],
      [
        [
          'Geometry',
          [L(1), 'Geometry::Large', 'Mesh'],
          [
            ['Vertices', [A('f', positions)]],
            ['PolygonVertexIndex', [A('i', indices)]],
          ],
        ],
        ['Model', [L(2), 'Model::Large', 'Mesh']],
      ],
    ],
    [
      'Connections',
      [],
      [
        ['C', ['OO', L(1), L(2)]],
        ['C', ['OO', L(2), L(0)]],
      ],
    ],
  ]);
  await assert.rejects(convertFBX(bytes), /geometry budget/);
  const { doc, accessor } = readGLB(await convertFBX(bytes, { extensions: [largeFBX()] }));
  const primitives = doc.meshes.flatMap((mesh) => mesh.primitives);
  assert.equal(primitives.length, 3);
  let offset = 0;
  for (const primitive of primitives) {
    const n = doc.accessors[primitive.attributes.POSITION].count;
    assert.ok(n <= 1_000_000);
    assert.equal(doc.accessors[primitive.indices].count, n);
    assert.deepEqual(accessor(primitive.attributes.POSITION), positions.subarray(offset * 3, (offset + n) * 3));
    const out = accessor(primitive.indices);
    for (let i = 0; i < n; i++) assert.equal(out[i], i);
    offset += n;
  }
  assert.equal(offset, count);
  await headlessModels(async () => {
    using engine = await headless();
    using model = await parseFBX(engine, bytes, { extensions: [largeFBX()] });
    assert.ok(model.asset.buffers[0].byteLength > 64 * 1024 * 1024);
    assert.equal(model.asset.maxBytes, 512 * 1024 * 1024);
    assert.equal(
      model.primitives.reduce((n, p) => n + p.vertices.length / 20, 0),
      count,
    );
  });
  const prepared = await runParseWorker(new URL('../dist/workers/fbx.js', import.meta.url), {
    input: bytes.slice().buffer,
    extensions: ['large'],
    limits: largeFBX().limits,
  });
  await headlessModels(async () => {
    using engine = await headless();
    using model = modelFromPrepared(engine, prepared);
    assert.equal(model.asset.maxBytes, 512 * 1024 * 1024);
    assert.equal(
      model.primitives.reduce((n, p) => n + p.vertices.length, 0),
      count * 20,
    );
  });
});
test('the default limits hold 996,004 vertices: every corner its own vertex, with normals, a UV set and tangents', {
  timeout: 120000,
}, async () => {
  const { defaultScaleMesh } = await import('./default-scale.js');
  const { bytes, positions, index, corners } = defaultScaleMesh();
  // Before the lean geometry build, 640,000 corners already passed the 128 MiB scene cap (about 267 B a corner).
  const { doc, accessor } = readGLB(await convertFBX(bytes));
  const primitives = doc.meshes.flatMap((mesh) => mesh.primitives);
  assert.equal(primitives.length, 1);
  const [primitive] = primitives,
    out = accessor(primitive.attributes.POSITION),
    indices = accessor(primitive.indices);
  assert.equal(doc.accessors[primitive.attributes.POSITION].count, corners);
  assert.equal(indices.length, (corners / 4) * 6);
  // Corner k of the file is vertex k: its control point's position, in the file's order.
  for (const k of [0, 1, 2, 3, 4, 123_457, corners - 1]) {
    const control = index[k] < 0 ? ~index[k] : index[k];
    for (let axis = 0; axis < 3; axis++)
      assert.equal(out[k * 3 + axis], Math.fround(positions[control * 3 + axis]), `corner ${k}`);
  }
  assert.deepEqual([...indices.subarray(0, 6)], [0, 1, 2, 0, 2, 3]);
  assert.ok(doc.accessors[primitive.attributes.TANGENT].count === corners);
});
