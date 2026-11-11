import test from 'node:test';
import assert from 'node:assert/strict';
import { Engine, TransformStore } from '../../core/dist/extension.js';
import { optionalGPU } from '../../../tests/support/optional-gpu.js';
import { computeVertexNormals, createMeshes, splitTriangles, toGeometries, toGeometry } from '../dist/index.js';
import { createPBRMeshes } from '../dist/render.js';

// A bumpy height field of side x side vertices: 1,100 squared = 1,210,000 vertices, past the core limit of 1,000,000.
function field(side, normals = false) {
  const positions = new Float32Array(side * side * 3),
    indices = new Uint32Array((side - 1) * (side - 1) * 6);
  for (let y = 0; y < side; y++)
    for (let x = 0; x < side; x++) {
      const o = (y * side + x) * 3;
      positions[o] = x * 0.01;
      positions[o + 1] = y * 0.01;
      positions[o + 2] = Math.sin(x * 0.37) * Math.cos(y * 0.23) * 0.05;
    }
  let i = 0;
  for (let y = 0; y < side - 1; y++)
    for (let x = 0; x < side - 1; x++) {
      const a = y * side + x,
        b = a + 1,
        c = a + side,
        d = c + 1;
      indices.set([a, b, d, a, d, c], i);
      i += 6;
    }
  const loaded = { kind: 'mesh', positions, indices };
  if (normals) {
    // File normals with every 7th one zero-length, so toGeometry's smooth fallback runs for those.
    loaded.normals = computeVertexNormals(positions, indices).map((v, k) => (Math.floor(k / 3) % 7 ? v * 3 : 0));
  }
  return loaded;
}
const big = field(1100);

test('splitTriangles keeps order and puts at most limit distinct vertices in each range', () => {
  const triangles = new Uint32Array([0, 1, 2, 2, 1, 3, 3, 4, 5, 5, 5, 5, 0, 6, 7]);
  assert.deepEqual(splitTriangles(triangles, 8, false, 4), [
    { start: 0, count: 6 },
    { start: 6, count: 6 },
    { start: 12, count: 3 },
  ]);
  assert.deepEqual(splitTriangles(triangles, 8, true, 7), [
    { start: 0, count: 6 },
    { start: 6, count: 6 },
    { start: 12, count: 3 },
  ]);
  assert.throws(() => splitTriangles(triangles, 8, false, 2), (e) => e.code === 'range');
});

test('a mesh under the core limit gives one geometry equal to toGeometry', () => {
  const small = field(40, true);
  for (const normals of ['auto', 'smooth', 'flat']) {
    const split = toGeometries(small, { normals });
    assert.equal(split.length, 1);
    const one = toGeometry(small, { normals });
    assert.deepEqual(split[0].vertices, one.vertices);
    assert.deepEqual(split[0].indices, one.indices);
  }
});

test('toGeometries splits a 1,210,000-vertex mesh into core-sized parts with seam-free normals', () => {
  assert.throws(() => toGeometry(big), (e) => e.code === 'limit' && /toGeometries/.test(e.message));
  for (const mode of ['smooth', 'auto-file']) {
    const loaded = mode === 'smooth' ? big : field(1100, true),
      parts = toGeometries(loaded, { normals: mode === 'smooth' ? 'smooth' : 'auto' });
    assert.equal(parts.length, 2);
    let triangles = 0,
      wrongPosition = 0,
      seams = 0,
      seamMismatch = 0,
      worst = 0;
    // seen[v] = part number + 1 that first wrote vertex v; normals[v] = that part's normal.
    const seen = new Uint8Array(loaded.positions.length / 3),
      normals = new Float32Array(loaded.positions.length),
      reference = computeVertexNormals(loaded.positions, loaded.indices);
    for (const [p, part] of parts.entries()) {
      const vertices = part.vertices.length / 6;
      assert.ok(vertices <= 1_000_000, `${vertices} vertices in one part`);
      for (let i = 0; i < part.indices.length; i++) {
        const source = loaded.indices[triangles + i],
          v = part.indices[i] * 6;
        for (let k = 0; k < 3; k++) if (part.vertices[v + k] !== loaded.positions[source * 3 + k]) wrongPosition++;
        if (!seen[source]) {
          seen[source] = p + 1;
          normals.set(part.vertices.subarray(v + 3, v + 6), source * 3);
        } else if (seen[source] !== p + 1) {
          // A vertex on the cut is in both parts with exactly the same normal (per-part normals differ there).
          seams++;
          for (let k = 0; k < 3; k++) if (part.vertices[v + 3 + k] !== normals[source * 3 + k]) seamMismatch++;
        }
      }
      triangles += part.indices.length;
    }
    assert.equal(triangles, loaded.indices.length);
    assert.equal(wrongPosition, 0);
    assert.ok(seams > 0, 'the cut shares vertices');
    assert.equal(seamMismatch, 0);
    for (let i = 0; i < normals.length; i++) worst = Math.max(worst, Math.abs(normals[i] - reference[i]));
    assert.ok(worst < 1e-6, `normal error ${worst}`);
  }
  const flat = toGeometries(big, { normals: 'flat' });
  assert.equal(flat.length, Math.ceil(big.indices.length / 999_999));
  assert.ok(flat.every((g) => g.vertices.length / 6 <= 1_000_000));
});

test('createMeshes makes one mesh per part of a mesh past the core limit, sharing one material', () => {
  const engine = {
    createMesh: () => ({
      setGeometry(g) {
        this.geometry = g;
        return this;
      },
      setMaterial(m) {
        this.material = m;
        return this;
      },
      dispose() {},
    }),
  };
  const result = createMeshes(engine, big);
  assert.equal(result.meshes.length, 2);
  assert.equal(result.materials.length, 1);
  assert.equal(result.meshes[0].material, result.meshes[1].material);
  assert.equal(
    result.geometries.reduce((sum, g) => sum + g.indices.length, 0),
    big.indices.length,
  );
});

test('createPBRMeshes renders a mesh past the core limit as one node with several primitives', async (t) => {
  const gpu = optionalGPU(),
    store = await TransformStore.create(64);
  const engine = new Engine(
    { width: 128, height: 96, clientWidth: 128, clientHeight: 96 },
    store,
    { backend: 'webgpu', gpu: gpu.engine.gpu, add() {}, remove() {}, render() {}, dispose() {} },
    { position: [0, 0, 4], target: [0, 0, 0] },
    null,
  );
  t.after(() => {
    engine.dispose();
    gpu.cleanup();
  });
  const colored = { ...big, colors: new Float32Array(big.positions.length).fill(0.5) };
  const model = createPBRMeshes(engine, colored);
  assert.equal(model.primitives.length, 2);
  assert.equal(
    model.primitives.reduce((sum, p) => sum + p.indices.length, 0),
    big.indices.length,
  );
  assert.ok(model.primitives.every((p) => p.vertices.length / 20 <= 1_000_000));
  model.dispose();
});
