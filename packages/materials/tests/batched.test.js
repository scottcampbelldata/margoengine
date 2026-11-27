// BatchedMesh: many geometries in one materials mesh, with per-item matrix, colour and visibility uploaded to the batch
// compute pass. The GPU fake records buffer contents; the drawn result is checked on a real GPU by the visual check.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Engine, TransformStore } from '../../core/dist/extension.js';
import { Material } from '../dist/index.js';
import { BatchedMesh, batchShader, batchSortShader } from '../dist/batched.js';
import { optionalGPU } from '../../../tests/support/optional-gpu.js';
import { Raycaster } from '../../bvh/dist/index.js';
import { posedVertices } from '../../shared/pose-source.js';

async function world() {
  const h = optionalGPU(),
    device = h.engine.gpu;
  device.queue.writeTexture = () => {};
  const engine = new Engine(
    { width: 64, height: 64, clientWidth: 64, clientHeight: 64 },
    await TransformStore.create(64),
    { backend: 'webgpu', gpu: device, add() {}, remove() {}, render() {}, dispose() {} },
    { position: [0, 0, 4], target: [0, 0, 0] },
    null,
  );
  let passes = 0;
  const context = {
    backend: 'webgpu',
    device,
    encoder: {
      beginComputePass() {
        passes++;
        return { setPipeline() {}, setBindGroup() {}, dispatchWorkgroups() {}, end() {} };
      },
    },
  };
  return { engine, context, passes: () => passes };
}
const triangle = {
  positions: [0, 0, 0, 1, 0, 0, 0, 1, 0],
  normals: [0, 0, 1, 0, 0, 1, 0, 0, 1],
};
const quad = {
  positions: [0, 0, 0, 2, 0, 0, 0, 2, 0, 2, 2, 0],
  normals: [0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1],
  colors: [1, 0, 0, 1, 0, 1, 0, 1, 0, 0, 1, 1, 1, 1, 1, 1],
  indices: [0, 1, 2, 2, 1, 3],
};
const translate = (x, y, z) => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1];
const gpuData = (batch, name) => batch.gpu[name].data;

test('items of different geometries share one mesh: ranges, offset indices and owners', async () => {
  const { engine } = await world(),
    batch = BatchedMesh.attach(engine, new Material(), { maxItems: 4, maxVertices: 16, maxIndices: 24 });
  const a = batch.add(triangle),
    b = batch.add(quad, { matrix: translate(5, 0, 0), color: [0.5, 0.25, 1] });
  assert.deepEqual([a, b], [0, 1]);
  assert.equal(batch.count, 2);
  assert.deepEqual(batch.usage, { vertices: 7, indices: 9 });
  const p = batch.mesh.primitives[0];
  assert.equal(batch.mesh.primitives.length, 1, 'one primitive: one draw per pass');
  assert.deepEqual(Array.from(p.indices.subarray(0, 9)), [0, 1, 2, 3, 4, 5, 5, 4, 6]);
  assert.deepEqual(Array.from(p.indices.subarray(9)), new Array(15).fill(0), 'unused indices are degenerate');
  assert.deepEqual([batch.itemOf(0), batch.itemOf(3), batch.itemOf(6), batch.itemOf(7)], [0, 1, 1, -1]);
  assert.deepEqual(Array.from(p.vertices.subarray(3 * 20 + 16, 3 * 20 + 20)), [1, 0, 0, 1], 'vertex colours kept');
  assert.deepEqual(Array.from(batch.getColor(b)), [0.5, 0.25, 1]);
  assert.deepEqual(Array.from(batch.getMatrix(b)), translate(5, 0, 0));
  assert.equal(batch.isVisible(b), true);
  assert.ok(batch.has(a) && !batch.has(2));
});

// KB-VIS-bm: since glTF primitives split into parts of 262,144 vertices (f9410d4500), a batch above that size became
// parts of its all-degenerate placeholder (one vertex each), which threw 'Invalid prepared PBR geometry' and left the
// batched-mesh demo (398,680 vertices) without its ready signal. A batch is one primitive at any allowed capacity.
test('a batch larger than one glTF part stays one primitive (KB-VIS-bm)', async () => {
  const { engine } = await world(),
    batch = BatchedMesh.attach(engine, new Material(), { maxItems: 2, maxVertices: 400_000, maxIndices: 600_000 });
  assert.equal(batch.mesh.primitives.length, 1, 'one primitive: one draw per pass');
  assert.equal(batch.mesh.primitives[0].vertices.length, 400_000 * 20);
  const far = batch.add(triangle, { matrix: translate(1, 0, 0) });
  assert.equal(batch.itemOf(0), far);
  batch.dispose();
});

test('the compute pass gets source vertices, owners and item records, and runs only after a change', async () => {
  const { engine, context, passes } = await world(),
    batch = BatchedMesh.attach(engine, new Material(), { maxItems: 4, maxVertices: 16 }),
    output = batch.mesh.primitives[0].deformed;
  assert.ok(output && output.usage & GPUBufferUsage.VERTEX, 'the mesh draws the batch output');
  assert.equal(typeof batch.mesh.prepareDeformation, 'function');
  const a = batch.add(triangle, { matrix: translate(1, 2, 3) }),
    b = batch.add(quad, { color: '#ff0000', visible: false });
  batch.mesh.prepareDeformation(context);
  assert.equal(passes(), 1);
  const items = new Float32Array(gpuData(batch, 'items'));
  assert.deepEqual(Array.from(items.subarray(0, 20)), [...translate(1, 2, 3), 1, 1, 1, 1]);
  assert.deepEqual(Array.from(items.subarray(36, 40)), [1, 0, 0, 0], 'red, hidden');
  assert.deepEqual(Array.from(new Uint32Array(gpuData(batch, 'owner')).subarray(0, 7)), [0, 0, 0, 1, 1, 1, 1]);
  assert.deepEqual(
    Array.from(new Float32Array(gpuData(batch, 'source')).subarray(0, 7 * 20)),
    Array.from(batch.mesh.primitives[0].vertices.subarray(0, 7 * 20)),
  );
  assert.deepEqual(Array.from(new Uint32Array(gpuData(batch, 'counts'))), [7, 0, 0, 0]);
  batch.mesh.prepareDeformation(context);
  assert.equal(passes(), 1, 'an unchanged batch dispatches nothing');
  batch.setMatrix(a, translate(0, 0, 9)).setVisible(b, true);
  items[0] = 42; // only the changed item records upload
  batch.mesh.prepareDeformation(context);
  assert.equal(passes(), 2);
  assert.equal(new Float32Array(gpuData(batch, 'items'))[14], 9);
  assert.equal(new Float32Array(gpuData(batch, 'items'))[39], 1);
  const index = new Uint32Array(batch.mesh.primitives[0].buffers.index.data);
  assert.deepEqual(Array.from(index.subarray(0, 9)), [0, 1, 2, 3, 4, 5, 5, 4, 6], 'item indices reach the GPU');
});

test('remove frees an item and its space for a later item that fits', async () => {
  const { engine, context } = await world(),
    batch = BatchedMesh.attach(engine, new Material(), { maxItems: 2, maxVertices: 8, maxIndices: 9 });
  const a = batch.add(quad),
    b = batch.add(triangle);
  assert.throws(() => batch.add(triangle), { name: 'RangeError', message: /holds 2 items/ });
  batch.remove(a);
  assert.equal(batch.count, 1);
  assert.throws(() => batch.setColor(a, [1, 1, 1]), { name: 'RangeError', message: /no item 0/ });
  const p = batch.mesh.primitives[0];
  assert.deepEqual(Array.from(p.indices.subarray(0, 6)), [0, 0, 0, 0, 0, 0], 'removed triangles collapse');
  assert.equal(batch.itemOf(0), -1);
  const c = batch.add(triangle);
  assert.equal(c, a, 'the id is reused');
  assert.deepEqual(Array.from(p.indices.subarray(0, 6)), [0, 1, 2, 0, 0, 0], 'reused range, rest degenerate');
  assert.deepEqual([batch.itemOf(2), batch.itemOf(3)], [c, -1]);
  batch.mesh.prepareDeformation(context);
  assert.equal(batch.itemOf(4), b);
  assert.throws(() => batch.add(quad), { message: /holds 2 items/ });
  batch.remove(c);
  assert.throws(
    () =>
      batch.add({
        ...quad,
        positions: [...quad.positions, 3, 3, 0],
        normals: [...quad.normals, 0, 0, 1],
        colors: undefined,
        indices: [0, 1, 2, 2, 1, 3, 3, 1, 4],
      }),
    {
      message: /out of space for 5 vertices and 9 indices/,
    },
  );
});

test('bounds follow item matrices and visibility and the batch root', async () => {
  const { engine } = await world(),
    batch = BatchedMesh.attach(engine, new Material(), { maxItems: 4, maxVertices: 16 });
  const a = batch.add(triangle, { matrix: translate(10, 0, 0) }),
    b = batch.add(quad, { matrix: [2, 0, 0, 0, 0, 2, 0, 0, 0, 0, 2, 0, 0, -1, 0, 1] });
  assert.deepEqual(Array.from(batch.bounds(a)), [10, 0, 0, 11, 1, 0]);
  assert.deepEqual(Array.from(batch.bounds(b)), [0, -1, 0, 4, 3, 0]);
  assert.deepEqual(Array.from(batch.mesh.bounds), [0, -1, 0, 11, 3, 0], 'the mesh reports item bounds');
  batch.setVisible(a, false);
  assert.deepEqual(Array.from(batch.bounds()), [0, -1, 0, 4, 3, 0]);
  batch.mesh.root.setPosition([0, 0, 5]);
  engine.store.tick(false);
  assert.deepEqual(Array.from(batch.bounds(b)), [0, -1, 5, 4, 3, 5]);
});

test('argument errors name the fix; dispose frees the GPU buffers, the mesh and the plugin', async () => {
  const { engine } = await world(),
    material = new Material();
  assert.throws(() => BatchedMesh.attach(engine, {}, { maxItems: 1, maxVertices: 3 }), TypeError);
  assert.throws(() => BatchedMesh.attach(engine, material, { maxItems: 0, maxVertices: 3 }), /maxItems/);
  assert.throws(() => BatchedMesh.attach(engine, material, { maxItems: 1, maxVertices: 2 }), /maxVertices/);
  assert.throws(
    () => BatchedMesh.attach(engine, material, { maxItems: 1, maxVertices: 3, maxIndices: 4 }),
    /multiple of 3/,
  );
  const batch = BatchedMesh.attach(engine, material, { maxItems: 2, maxVertices: 8 }),
    id = batch.add(triangle);
  assert.throws(() => batch.setMatrix(id, [1, 2]), TypeError);
  assert.throws(() => batch.setMatrix(id, [...translate(0, 0, 0).slice(0, 15), Number.NaN]), RangeError);
  // 1e39 is a finite double but Infinity as float32: it was stored and drew the item from Infinity and NaN.
  assert.throws(() => batch.setMatrix(id, [...translate(0, 0, 0).slice(0, 12), 1e39, 0, 0, 1]), RangeError);
  assert.equal(batch.getMatrix(id)[12], 0, 'a refused matrix leaves the item where it was');
  assert.throws(() => batch.setVisible(id, 1), TypeError);
  assert.throws(() => batch.add(triangle, { matrix: [0] }), TypeError);
  assert.equal(batch.count, 1, 'a failed add leaves nothing behind');
  const output = batch.mesh.primitives[0].deformed,
    mesh = batch.mesh;
  assert.equal(engine.hasPlugin(batch.name), true);
  batch[Symbol.dispose]();
  assert.ok(output.destroyed);
  assert.ok(mesh.disposed);
  assert.equal(engine.hasPlugin(batch.name), false);
  assert.throws(() => batch.add(triangle), { name: 'MargoError', code: 'disposed' });
});

// KB-BVH-SYNCPOSE-BATCHED1: the compute pass places the items, so the primitive is `deformed` and a synchronous raycast
// threw MargoError 'unsupported'. The batch now gives its CPU pose (packages/shared/pose-source.js), the pass's
// arithmetic term for term, so the raycast tests each item where its matrix draws it.
test('a synchronous raycast hits batch items where their matrices draw them (KB-BVH-SYNCPOSE-BATCHED1)', async () => {
  const { engine } = await world();
  engine.store.tick(false);
  const batch = BatchedMesh.attach(engine, new Material(), { maxItems: 4, maxVertices: 16, maxIndices: 24 }),
    hits = (x, y) => {
      const ray = new Raycaster([x, y, 5], [0, 0, -1]);
      ray.side = 'double';
      return ray.intersectObjects(engine, [batch.mesh]);
    };
  const a = batch.add(quad),
    b = batch.add(quad, { matrix: translate(5, 0, 0) });
  assert.ok(batch.mesh.primitives[0].deformed, 'the compute pass writes the primitive');
  assert.equal(hits(0.5, 0.5).length, 1);
  const [hit] = hits(5.5, 0.5);
  assert.ok(hit && Math.abs(hit.distance - 5) < 1e-6, 'item b is hit at its matrix');
  assert.deepEqual(hits(3.5, 0.5), [], 'nothing between the items');
  batch.setMatrix(b, translate(-4, 0, 0));
  assert.deepEqual(hits(5.5, 0.5), [], 'a moved item is not hit where it was');
  assert.equal(hits(-3.5, 0.5).length, 1, 'and is hit where it went');
  batch.setVisible(a, false);
  assert.deepEqual(hits(0.5, 0.5), [], 'a hidden item is collapsed, as the pass draws it');
  batch.setVisible(a, true);
  batch.remove(a);
  assert.deepEqual(hits(0.5, 0.5), [], 'a removed item is gone');
  batch.dispose();
});

test('the batch pose is the compute pass term for term: mirror, normal, tangent sign and tint', async () => {
  const { engine } = await world(),
    batch = BatchedMesh.attach(engine, new Material(), { maxItems: 2, maxVertices: 8 }),
    // Mirrored in x, stretched 2 in y, moved (1, 2, 3): handedness -1.
    id = batch.add(quad, { matrix: [-1, 0, 0, 0, 0, 2, 0, 0, 0, 0, 1, 0, 1, 2, 3, 1], color: [0.5, 1, 0.25] }),
    primitive = batch.mesh.primitives[0],
    source = primitive.vertices,
    pose = posedVertices(primitive);
  assert.ok(pose, 'the batch registers a pose source');
  // + 0: a zero term of the matrix gives -0, which the pass writes too.
  const at = (i, from, n) => Array.from(pose.vertices.subarray(i * 20 + from, i * 20 + from + n), (v) => v + 0);
  // Vertex 3 of the quad is (2, 2, 0): mirrored x, doubled y, then moved.
  assert.deepEqual(at(3, 0, 4), [-1, 6, 3, 1]);
  // The normal matrix is the cofactor matrix times the handedness: +z stays +z for this matrix.
  assert.deepEqual(at(3, 4, 4), [0, 0, 1, 0]);
  const tangent = Array.from(source.subarray(3 * 20 + 8, 3 * 20 + 12));
  assert.deepEqual(at(3, 8, 4), [-tangent[0] + 0, 2 * tangent[1] + 0, tangent[2] + 0, -tangent[3] + 0], 'tangent w flips');
  assert.deepEqual(at(3, 12, 4), Array.from(source.subarray(3 * 20 + 12, 3 * 20 + 16)), 'uv kept');
  assert.deepEqual(at(0, 16, 4), [0.5, 0, 0, 1], 'vertex colour times the tint, alpha kept');
  assert.equal(posedVertices(primitive), pose, 'unchanged: the same pose');
  const revision = pose.revision;
  batch.setColor(id, [1, 1, 1]);
  assert.notEqual(posedVertices(primitive).revision, revision, 'a change gives a new revision');
  batch.setVisible(id, false);
  assert.equal(posedVertices(primitive), pose, 'evaluated on demand, into the same array');
  assert.deepEqual(at(3, 0, 12), [0, 0, 0, 1, 0, 0, 1, 0, 1, 0, 0, 1], 'hidden: the pass collapses it');
  batch.dispose();
  assert.equal(posedVertices(primitive), undefined, 'a disposed batch gives no pose');
});

test('the batch shader reads each vertex owner and item record', () => {
  for (const name of ['source', 'output', 'items', 'owner', 'counts']) assert.match(batchShader, new RegExp(name));
  assert.match(batchShader, /tint\.w<0\.5/, 'hidden items collapse');
});

// e01ffe38e: the message named other tools; a message names the rule and the fix, and nothing else.
test('an invalid shininess names the rule and the fix', () => {
  assert.throws(
    () => new Material({ shading: 'phong', shininess: -1 }),
    (error) =>
      error instanceof RangeError &&
      error.message === 'Material shininess must be finite as float32 and >= 0; set a number in that range.',
  );
});

test('a stored geometry is kept once and read by every instance (addGeometry, addInstance)', async () => {
  const { engine, context } = await world(),
    batch = BatchedMesh.attach(engine, new Material(), { maxItems: 4, maxVertices: 16, maxGeometryVertices: 4 });
  const shape = batch.addGeometry(quad),
    a = batch.addInstance(shape, { matrix: translate(1, 0, 0) }),
    b = batch.addInstance(shape, { color: '#00ff00' });
  assert.deepEqual(batch.geometryUsage, { geometries: 1, vertices: 4 }, 'one stored copy for two items');
  assert.deepEqual(batch.usage, { vertices: 8, indices: 12 });
  assert.equal(batch.getGeometryId(b), shape);
  batch.mesh.prepareDeformation(context);
  // Both items read store vertices 0 to 3; the store holds the geometry once.
  assert.deepEqual(Array.from(new Uint32Array(gpuData(batch, 'sourceOf')).subarray(0, 8)), [0, 1, 2, 3, 0, 1, 2, 3]);
  assert.equal(gpuData(batch, 'source').byteLength, 4 * 80);
  assert.deepEqual(Array.from(batch.mesh.primitives[0].indices.subarray(0, 12)), [0, 1, 2, 2, 1, 3, 4, 5, 6, 6, 5, 7]);
  assert.throws(() => batch.addGeometry(triangle), /no room to store 3 more geometry vertices/);
  batch.remove(a);
  assert.ok(batch.hasGeometry(shape), 'a stored geometry outlives its items');
  batch.removeGeometry(shape);
  assert.equal(batch.count, 0, 'and takes its remaining items with it');
  assert.equal(batch.has(b), false);
  assert.deepEqual(batch.geometryUsage, { geometries: 0, vertices: 0 }, 'freed space merges back into the tail');
  assert.throws(() => batch.addInstance(shape), /no geometry/);
  const own = batch.add(triangle);
  assert.deepEqual(batch.geometryUsage, { geometries: 1, vertices: 3 });
  batch.remove(own);
  assert.deepEqual(batch.geometryUsage, { geometries: 0, vertices: 0 }, 'add frees its own geometry with the item');
});

test('sort follows the engine material sort modes, is live and refuses unknown orders', async () => {
  const { engine } = await world(),
    { setMaterialSortModes } = await import('../dist/index.js'),
    opaque = BatchedMesh.attach(engine, new Material(), { maxItems: 2, maxVertices: 8 }),
    clear = BatchedMesh.attach(engine, new Material({ transparent: true }), { maxItems: 2, maxVertices: 8 });
  assert.equal(opaque.sort, 'auto');
  assert.deepEqual([opaque.order, clear.order], ['manual', 'back-to-front']);
  setMaterialSortModes(engine, { opaque: 'front-to-back' });
  assert.equal(opaque.order, 'front-to-back');
  clear.sort = 'manual';
  assert.equal(clear.order, 'manual');
  assert.throws(() => (clear.sort = 'nearest'), /pass 'auto', 'manual', 'front-to-back' or 'back-to-front'/);
  assert.throws(() => BatchedMesh.attach(engine, new Material(), { maxItems: 1, maxVertices: 3, sort: 'x' }), TypeError);
  assert.throws(
    () => BatchedMesh.attach(engine, new Material(), { maxItems: 1, maxVertices: 3, maxGeometryVertices: 2 }),
    /maxGeometryVertices/,
  );
  assert.match(batchSortShader, /fn network/);
  assert.match(batchSortShader, /fn scatter/);
});
