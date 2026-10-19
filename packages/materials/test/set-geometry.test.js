// Live geometry edits on createMesh meshes: GPU buffer reuse, ranged uploads, and CPU readers (BVH, bounds) seeing them.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Engine, TransformStore } from '../../core/dist/extension.js';
import { Raycaster, worldTriangles } from '../../bvh/dist/index.js';
import { Material, createMesh, packGeometry } from '../dist/index.js';
import { optionalGPU } from '../../../tests/support/optional-gpu.js';

async function scene() {
  const h = optionalGPU(),
    device = h.engine.gpu,
    writes = [];
  // WebGPU semantics: dataOffset and size count elements of a typed array.
  device.queue.writeBuffer = (buffer, offset, data, dataOffset = 0, size = data.length - dataOffset) => {
    const bytes = new Uint8Array(
      data.buffer,
      data.byteOffset + dataOffset * data.BYTES_PER_ELEMENT,
      size * data.BYTES_PER_ELEMENT,
    );
    writes.push({ buffer, offset, bytes: bytes.byteLength });
    new Uint8Array(buffer.data).set(bytes, offset);
  };
  const engine = new Engine(
    { width: 128, height: 96, clientWidth: 128, clientHeight: 96 },
    await TransformStore.create(64),
    { backend: 'webgpu', gpu: device, add() {}, remove() {}, render() {}, dispose() {} },
    { position: [0, 0, 4], target: [0, 0, 0] },
    null,
  );
  const geometryBuffers = () =>
    h.resources.filter((r) => typeof r.size === 'number' && r.usage & (GPUBufferUsage.VERTEX | GPUBufferUsage.INDEX));
  return {
    h,
    engine,
    writes,
    geometryBuffers,
    live: () => geometryBuffers().filter((r) => !r.destroyed),
    close() {
      engine.dispose();
      h.cleanup();
    },
  };
}
// n quads side by side along x from `x`, four vertices each.
function strip(n, x = 0) {
  const g = { positions: [], normals: [], uvs: [], indices: [] };
  for (let i = 0; i < n; i++) {
    const a = x + i;
    g.positions.push(a, 0, 0, a + 1, 0, 0, a + 1, 1, 0, a, 1, 0);
    g.normals.push(0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1);
    g.uvs.push(0, 0, 1, 0, 1, 1, 0, 1);
    g.indices.push(i * 4, i * 4 + 1, i * 4 + 2, i * 4, i * 4 + 2, i * 4 + 3);
  }
  return g;
}

test('setGeometry rewrites fitting buffers in place and reallocates with headroom only when data outgrows them', async () => {
  const s = await scene();
  try {
    const mesh = createMesh(s.engine, strip(2), new Material()),
      p = mesh.primitives[0],
      { vertex, index } = p.buffers;
    assert.equal(vertex.size, 8 * 80);
    let made = s.h.counts.buffers;
    s.writes.length = 0;
    assert.equal(mesh.setGeometry(strip(1)), mesh);
    assert.equal(s.h.counts.buffers, made, 'smaller data reuses both buffers');
    assert.deepEqual(p.buffers, { vertex, index });
    assert.deepEqual(
      s.writes.map((w) => [w.buffer, w.offset, w.bytes]),
      [
        [vertex, 0, 4 * 80],
        [index, 0, 6 * 4],
      ],
    );
    assert.equal(p.vertices.length, 4 * 20, 'CPU arrays are exact even when the GPU buffer is larger');
    assert.equal(p.indices.length, 6);
    mesh.setGeometry(strip(3));
    assert.equal(s.h.counts.buffers, made + 2, 'outgrown buffers reallocate');
    assert.ok(vertex.destroyed && index.destroyed);
    assert.deepEqual([p.buffers.vertex.size, p.buffers.index.size], [2 * 8 * 80, 2 * 12 * 4], 'doubled sizes');
    mesh.setGeometry(strip(9));
    assert.deepEqual([p.buffers.vertex.size, p.buffers.index.size], [36 * 80, 54 * 4], 'data sizes past doubling');
    made = s.h.counts.buffers;
    for (let i = 0; i < 6; i++) mesh.setGeometry(strip(9 - (i % 3)));
    assert.equal(s.h.counts.buffers, made, 'repeated edits that fit allocate nothing');
    assert.equal(s.live().length, 2, 'one vertex and one index buffer stay alive');
    assert.equal(mesh.shadowPrimitives[0].dynamic, true, 'edited geometry casts as a dynamic shadow');
    mesh.dispose();
    assert.equal(s.live().length, 0, 'dispose frees every geometry buffer, including reallocated ones');
    assert.throws(
      () => mesh.setGeometry(strip(1)),
      (e) => e.name === 'MargoError' && e.code === 'disposed',
    );
  } finally {
    s.close();
  }
});

test('ranged setGeometry repacks and uploads only the changed vertices', async () => {
  const s = await scene();
  try {
    const g = strip(4),
      other = createMesh(s.engine, g, new Material()),
      mesh = createMesh(s.engine, g, new Material()),
      p = mesh.primitives[0],
      cached = p.vertices,
      { vertex } = p.buffers;
    assert.equal(other.primitives[0].vertices, cached, 'both meshes start on the shared packed arrays');
    const made = s.h.counts.buffers;
    s.writes.length = 0;
    for (let k = 0; k < 8; k++) g.uvs[8 + k] = 0.5; // UVs of vertices 4-7 (the second quad)
    mesh.setGeometry(g, { start: 4, count: 4 });
    assert.deepEqual(
      s.writes.map((w) => [w.buffer, w.offset, w.bytes]),
      [[vertex, 4 * 80, 4 * 80]],
      'only the four vertices upload; indices are untouched',
    );
    assert.equal(s.h.counts.buffers, made);
    assert.notEqual(p.vertices, cached, 'the first ranged edit copies the shared array once');
    assert.equal(other.primitives[0].vertices[4 * 20 + 12], 0, 'the other mesh keeps its data');
    assert.equal(p.vertices[4 * 20 + 12], 0.5);
    assert.equal(new Float32Array(vertex.data)[4 * 20 + 12], 0.5, 'the GPU copy matches');
    assert.notEqual(packGeometry(g), other.primitives[0].vertices, 'the stale packGeometry cache entry is dropped');
    const owned = p.vertices,
      indices = p.indices;
    s.writes.length = 0;
    g.uvs[0] = 0.25;
    mesh.setGeometry(g, { start: 0, count: 1 });
    assert.equal(p.vertices, owned, 'later UV-only edits write in place');
    assert.equal(p.indices, indices);
    assert.deepEqual(
      s.writes.map((w) => [w.offset, w.bytes]),
      [[0, 80]],
    );
    assert.throws(() => mesh.setGeometry(g, { start: 15, count: 2 }), RangeError);
    assert.throws(() => mesh.setGeometry(strip(3), { start: 0, count: 1 }), RangeError, 'vertex count must stay');
    assert.throws(
      () => mesh.setGeometry({ ...g, normals: g.normals.map(() => 0) }, { start: 0, count: 1 }),
      /non-zero/,
    );
    assert.deepEqual([p.vertices === owned, p.vertices[12]], [true, 0.25], 'a rejected edit changes nothing');
  } finally {
    s.close();
  }
});

test('raycasts, worldTriangles and bounds follow full and ranged position edits', async () => {
  const s = await scene();
  try {
    const g = strip(1),
      mesh = createMesh(s.engine, g, new Material()),
      ray = new Raycaster([3.3, 0.7, 5], [0, 0, -1]),
      hits = () => ray.intersectEngine(s.engine).filter((h) => h.model === mesh).length;
    assert.equal(hits(), 0);
    mesh.setGeometry(strip(1, 3));
    assert.equal(hits(), 1, 'a full update moves the hit');
    assert.deepEqual([...mesh.bounds].map(Math.round), [3, 0, 0, 4, 1, 0]);
    for (let i = 0; i < 4; i++) g.positions[i * 3] += 6; // the original quad, now at x 6-7, same vertex count
    mesh.setGeometry(g, { start: 0, count: 4 });
    assert.equal(hits(), 0, 'a ranged position edit refreshes the BVH');
    ray.set([6.3, 0.7, 5], [0, 0, -1]);
    assert.equal(hits(), 1);
    assert.equal(ray.intersectObjects(s.engine, [mesh]).length, 1, 'the per-object path agrees');
    assert.deepEqual([...worldTriangles(s.engine, [mesh]).vertices.slice(0, 3)], [6, 0, 0]);
  } finally {
    s.close();
  }
});

test('grouped meshes keep their materials while group ranges move, and static batches retire', async () => {
  const s = await scene();
  try {
    const m = new Material(),
      g = {
        ...strip(2),
        groups: [
          { start: 0, count: 6, materialIndex: 0 },
          { start: 6, count: 6, materialIndex: 0 },
        ],
      },
      mesh = createMesh(s.engine, g, [m]);
    s.engine.store.tick(false);
    assert.equal(mesh.shadowPrimitives.length, 1, 'two groups of one material draw as one static batch');
    const materials = mesh.primitives.map((p) => p.material);
    mesh.setGeometry({
      ...strip(3),
      groups: [
        { start: 0, count: 12, materialIndex: 0 },
        { start: 12, count: 6, materialIndex: 0 },
      ],
    });
    assert.deepEqual(
      mesh.primitives.map((p) => p.indices.length),
      [12, 6],
    );
    assert.deepEqual(
      mesh.primitives.map((p) => p.material),
      materials,
    );
    assert.equal(mesh.primitives[0].vertices, mesh.primitives[1].vertices, 'groups still share one vertex array');
    assert.equal(mesh.primitives[0].buffers.vertex, mesh.primitives[1].buffers.vertex);
    assert.equal(mesh.shadowPrimitives.length, 2, 'the stale batch is gone; parts draw from their own buffers');
    assert.equal(s.live().length, 3, 'one shared vertex buffer and two index buffers');
    assert.throws(
      () => mesh.setGeometry({ ...strip(3), groups: [{ start: 0, count: 18, materialIndex: 0 }] }),
      RangeError,
    );
    mesh.dispose();
    assert.equal(s.live().length, 0);
  } finally {
    s.close();
  }
});
