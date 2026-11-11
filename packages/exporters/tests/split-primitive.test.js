// A primitive gltf-pro split into parts (maxPartVertices) exports as one primitive per part of the same material:
// valid glTF, each part's own vertices and indices, the same triangles at the same positions.
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseGLTF } from '@margoengine/gltf-pro';
import { exportModel } from '../dist/model.js';
import { materialEngine as headless, readGLB, validate } from './helpers.js';

const W = 64;
function grid() {
  const positions = new Float32Array(W * W * 3),
    uvs = new Float32Array(W * W * 2),
    indices = new Uint32Array((W - 1) * (W - 1) * 6);
  for (let i = 0; i < W * W; i++) {
    positions.set([i % W, Math.floor(i / W), 0], i * 3);
    uvs.set([(i % W) / W, Math.floor(i / W) / W], i * 2);
  }
  for (let y = 0, o = 0; y < W - 1; y++)
    for (let x = 0; x < W - 1; x++, o += 6) {
      const i = y * W + x;
      indices.set([i, i + 1, i + W, i + 1, i + W + 1, i + W], o);
    }
  const bin = new Uint8Array(positions.byteLength + uvs.byteLength + indices.byteLength);
  bin.set(new Uint8Array(positions.buffer), 0);
  bin.set(new Uint8Array(uvs.buffer), positions.byteLength);
  bin.set(new Uint8Array(indices.buffer), positions.byteLength + uvs.byteLength);
  const doc = {
    asset: { version: '2.0' },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0 }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0, TEXCOORD_0: 1 }, indices: 2, material: 0 }] }],
    materials: [{ pbrMetallicRoughness: { baseColorFactor: [0.5, 0.25, 1, 1] } }],
    buffers: [{ byteLength: bin.byteLength }],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: positions.byteLength },
      { buffer: 0, byteOffset: positions.byteLength, byteLength: uvs.byteLength },
      { buffer: 0, byteOffset: positions.byteLength + uvs.byteLength, byteLength: indices.byteLength },
    ],
    accessors: [
      { bufferView: 0, componentType: 5126, type: 'VEC3', count: W * W, min: [0, 0, 0], max: [W - 1, W - 1, 0] },
      { bufferView: 1, componentType: 5126, type: 'VEC2', count: W * W },
      { bufferView: 2, componentType: 5125, type: 'SCALAR', count: indices.length },
    ],
  };
  return { doc, bin };
}
/** Triangles as sorted strings of grid cells, read from positions: independent of vertex numbering. */
function cells(model) {
  const out = [];
  for (const p of model.primitives)
    for (let i = 0; i < p.indices.length; i += 3) {
      const t = [0, 1, 2].map((k) => {
        const v = p.indices[i + k] * 20;
        return p.vertices[v + 1] * W + p.vertices[v];
      });
      const r = t.indexOf(Math.min(...t));
      out.push([t[r], t[(r + 1) % 3], t[(r + 2) % 3]].join(','));
    }
  return out.sort();
}

test('a split primitive exports as one primitive per part, same material, same triangles', async () => {
  const engine = await headless(),
    { doc, bin } = grid(),
    model = parseGLTF(engine, doc, [bin.buffer], [], {}, { maxPartVertices: 1024 });
  assert.ok(model.primitives.length >= 4, `${model.primitives.length} parts`);
  const result = readGLB(await exportModel(model, { binary: true })),
    primitives = result.json.meshes[0].primitives;
  assert.equal(primitives.length, model.primitives.length);
  assert.ok(primitives.every((p) => p.material === primitives[0].material));
  primitives.forEach((p, i) => {
    assert.equal(result.json.accessors[p.attributes.POSITION].count, model.primitives[i].vertices.length / 20);
    assert.equal(result.json.accessors[p.attributes.TEXCOORD_0].count, model.primitives[i].vertices.length / 20);
    assert.equal(result.json.accessors[p.indices].count, model.primitives[i].indices.length);
  });
  const report = await validate(new Uint8Array(await exportModel(model, { binary: true })));
  assert.equal(report.errors, 0, JSON.stringify(report.messages.slice(0, 3)));
  const again = parseGLTF(await headless(), result.json, [
    result.bin.buffer.slice(result.bin.byteOffset, result.bin.byteOffset + result.bin.byteLength),
  ]);
  assert.deepEqual(cells(again), cells(model));
  // The uvs travel with their vertices through vertexMap.
  for (const p of again.primitives)
    for (let k = 0; k < p.vertices.length; k += 20) {
      assert.equal(p.vertices[k + 12], p.vertices[k] / W);
      assert.equal(p.vertices[k + 13], p.vertices[k + 1] / W);
    }
  model.dispose();
  again.dispose();
});
