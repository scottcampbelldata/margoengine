// The `optimize` load option: triangle order for the GPU, same triangles, and the file's order where it matters.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { analyzeVertexCache } from '@margoengine/geometry/optimize';
import { prepareGLTF } from '../dist/prepare.js';

// A grid of n x n quads, its rows of triangles shuffled so the file's order is poor for a cache.
function grid(n) {
  const positions = new Float32Array((n + 1) * (n + 1) * 3),
    quads = [];
  for (let y = 0; y <= n; y++)
    for (let x = 0; x <= n; x++) positions.set([x, y, 0], (y * (n + 1) + x) * 3);
  for (let y = 0; y < n; y++)
    for (let x = 0; x < n; x++) {
      const a = y * (n + 1) + x;
      quads.push([a, a + 1, a + n + 2], [a, a + n + 2, a + n + 1]);
    }
  let seed = 3;
  for (let i = quads.length - 1; i > 0; i--) {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    const j = seed % (i + 1);
    [quads[i], quads[j]] = [quads[j], quads[i]];
  }
  return { positions, indices: Uint32Array.from(quads.flat()) };
}

function document({ positions, indices }, primitive = {}, materials) {
  const bytes = new Uint8Array(positions.byteLength + indices.byteLength);
  bytes.set(new Uint8Array(positions.buffer), 0);
  bytes.set(new Uint8Array(indices.buffer), positions.byteLength);
  const doc = {
    asset: { version: '2.0' },
    buffers: [{ byteLength: bytes.length }],
    bufferViews: [
      { buffer: 0, byteLength: positions.byteLength },
      { buffer: 0, byteOffset: positions.byteLength, byteLength: indices.byteLength },
    ],
    accessors: [
      {
        bufferView: 0,
        componentType: 5126,
        count: positions.length / 3,
        type: 'VEC3',
        min: [0, 0, 0],
        max: [99, 99, 0],
      },
      { bufferView: 1, componentType: 5125, count: indices.length, type: 'SCALAR' },
    ],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 }, indices: 1, ...primitive }] }],
    ...(materials ? { materials } : {}),
  };
  return { doc, buffers: [bytes] };
}

const triangles = (indices) => {
  const out = [];
  for (let i = 0; i < indices.length; i += 3) {
    // Rotated to start at the smallest corner: winding stays part of the key.
    const t = [indices[i], indices[i + 1], indices[i + 2]],
      k = t.indexOf(Math.min(...t));
    out.push(`${t[k]},${t[(k + 1) % 3]},${t[(k + 2) % 3]}`);
  }
  return out.sort();
};

const load = async (doc, buffers, optimize) =>
  (await prepareGLTF(undefined, doc, buffers, undefined, undefined, undefined, optimize)).geometry[0][0];
const packed = (source, primitive, materials, on = true) => {
  const { doc, buffers } = document(source, primitive, materials);
  return load(doc, buffers, on);
};

test('optimize keeps every triangle and its winding, and cuts the cache misses', async () => {
  const source = grid(40),
    plain = await packed(source, {}, undefined, false),
    fast = await packed(source);
  assert.deepEqual(Array.from(plain.indices), Array.from(source.indices), 'off leaves the file order alone');
  assert.deepEqual(triangles(fast.indices), triangles(source.indices));
  assert.deepEqual(fast.vertices, plain.vertices, 'the vertex data is not touched, so skins and morphs still line up');
  const before = analyzeVertexCache(plain.indices, 1681).acmr,
    after = analyzeVertexCache(fast.indices, 1681).acmr;
  assert.ok(after < 0.5 * before, `ACMR ${before} to ${after}`);
});

test('a BLEND primitive keeps the order of the file, an opaque one in the same file does not', async () => {
  const source = grid(8),
    materials = [{ alphaMode: 'BLEND' }, { alphaMode: 'MASK' }];
  assert.deepEqual(Array.from((await packed(source, { material: 0 }, materials)).indices), Array.from(source.indices));
  assert.notDeepEqual(Array.from((await packed(source, { material: 1 }, materials)).indices), Array.from(source.indices));
});

test('points and lines are left alone; strips are ordered as the lists they unroll to', async () => {
  const source = grid(4),
    points = await packed(source, { mode: 0 }),
    lines = await packed(source, { mode: 1 });
  assert.deepEqual(Array.from(points.indices), Array.from(source.indices));
  assert.deepEqual(Array.from(lines.indices), Array.from(source.indices));
  const strip = { positions: source.positions, indices: Uint32Array.from([0, 1, 5, 6, 10, 11, 15, 16]) },
    plain = await packed(strip, { mode: 5 }, undefined, false),
    fast = await packed(strip, { mode: 5 });
  assert.deepEqual(triangles(fast.indices), triangles(plain.indices));
});

test('the summed normals of a file with none do not change with the order', async () => {
  const source = grid(6),
    a = await packed(source, {}, undefined, false),
    b = await packed(source);
  assert.deepEqual(a.vertices, b.vertices);
});

// The JSON and the binary chunk of a GLB, without images: Node has no image decoder here.
function geometryOf(path) {
  const file = readFileSync(new URL(path, import.meta.url)),
    length = file.readUInt32LE(12),
    doc = JSON.parse(file.toString('utf8', 20, 20 + length)),
    binary = file.subarray(20 + length + 8);
  for (const key of ['images', 'textures', 'samplers', 'materials', 'animations', 'skins']) delete doc[key];
  for (const node of doc.nodes) delete node.skin;
  for (const mesh of doc.meshes) for (const p of mesh.primitives) delete p.material;
  return { doc, buffers: [binary] };
}

test('a real exported model: Fox keeps its triangles and its cache ratio does not get worse', async () => {
  const { doc, buffers } = geometryOf('../../../examples/assets/khronos/Fox/Fox.glb'),
    plain = await load(doc, buffers, false),
    fast = await load(doc, buffers, true),
    count = plain.vertices.length / 20;
  assert.deepEqual(triangles(fast.indices), triangles(plain.indices));
  assert.deepEqual(fast.vertices, plain.vertices);
  const before = analyzeVertexCache(plain.indices, count).acmr,
    after = analyzeVertexCache(fast.indices, count).acmr;
  assert.ok(after <= before * 1.0001, `ACMR ${before} to ${after}`);
});
